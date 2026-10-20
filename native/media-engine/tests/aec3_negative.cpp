#include "aec3_processor.h"
#include "aec3_trace.h"
#include "speech_wav.h"
#include <algorithm>
#include <cmath>
#include <iostream>

// No acoustic echo is added. These controls test false suppression, not ERLE.
int evaluate_negative(const char* farPath, const char* nearPath, bool nearendMask) {
  try {
    auto far = read_speech_wav(std::filesystem::u8path(farPath));
    auto near = read_speech_wav(std::filesystem::u8path(nearPath));
    constexpr unsigned rate = audio_rate, count = 40*rate;
    if (far.size()<count || near.size()<count) throw std::runtime_error("Need 40 seconds per input");
    far.resize(count); near.resize(count);
    if (far == near) throw std::runtime_error("Use independent recordings");
    double energy=0, farEnergy=0;
    for (unsigned i=12*rate; i<19*rate; ++i) { energy += double(near[i])*near[i]; farEnergy += double(far[i])*far[i]; }
    if (energy/(7*rate)<1e-6 || farEnergy/(7*rate)<1e-6) throw std::runtime_error("Insufficient input energy");
    for (unsigned i=0; i<count; ++i) if (i<10*rate || i>=20*rate) near[i]=0;
    std::vector<float> baseline(count);
    Aec3Processor control;
    AudioFrame zero, clean;
    for (unsigned offset=0; offset<count; offset+=audio_block) {
      std::copy_n(near.begin()+offset,audio_block,clean.samples.begin());
      control.render(zero); control.capture(clean);
      std::copy(clean.samples.begin(),clean.samples.end(),baseline.begin()+offset);
    }
    unsigned passed[2]{};
    const char* names[]{"near-only", "headphone-no-echo", "low-noise-reference", "silent-mic"};
    for (unsigned candidate=0; candidate<2; ++candidate) for (unsigned kind=0; kind<4; ++kind) {
      Aec3Processor processor(candidate ? (nearendMask ? Aec3Processor::Profile::DiagnosticNearendMask : Aec3Processor::Profile::DiagnosticLowExcitation) : Aec3Processor::Profile::DiagnosticTrace);
      darling_aec_trace::stats = {};
      darling_aec_trace::Stats windowStart{}, windowEnd{};
      uint32_t seed=20261018;
      double xx=0,yy=0,xy=0,error=0,silentEnergy=0;
      uint64_t silentSamples=0;
      AudioFrame render,capture;
      for (unsigned offset=0; offset<count; offset+=audio_block) {
        if (offset==12*rate) windowStart=darling_aec_trace::stats;
        if (offset==19*rate) windowEnd=darling_aec_trace::stats;
        for (unsigned j=0;j<audio_block;++j) {
          const unsigned i=offset+j;
          seed ^= seed<<13; seed ^= seed>>17; seed ^= seed<<5;
          // Uniform noise with expected RMS -60 dBFS; independent of capture.
          const float noise=(float(seed)/4294967295.f*2.f-1.f)*.0017320508f;
          render.samples[j]=kind==0 ? 0.f : kind==2 ? noise : far[i];
          capture.samples[j]=kind==3 ? 0.f : near[i];
        }
        processor.render(render); processor.capture(capture);
        for (unsigned j=0;j<audio_block;++j) {
          const unsigned i=offset+j;
          const double y=capture.samples[j],x=baseline[i];
          if (!std::isfinite(y) || std::abs(y)>1) throw std::runtime_error("Invalid output");
          if (kind!=3 && i>=12*rate && i<19*rate) { xx+=x*x; yy+=y*y; xy+=x*y; error+=(x-y)*(x-y); }
          if ((kind==3 && i>=5*rate) || (kind!=3 && i>=25*rate)) {silentEnergy+=y*y; ++silentSamples;}
        }
      }
      const double corr=xy/std::sqrt(std::max(xx*yy,1e-30));
      const double gain=20*std::log10(std::max(xy/std::max(xx,1e-30),1e-30));
      const double snr=10*std::log10(std::max(xx,1e-30)/std::max(error,1e-30));
      const double silentDb=10*std::log10(std::max(silentEnergy/silentSamples,1e-30));
      // Predeclared: original fidelity limits plus an absolute silent-output bound.
      const bool ok=(kind==3 || (corr>=.85 && std::abs(gain)<=3 && snr>=8)) && silentDb<=-70;
      passed[candidate]+=ok;
      const auto& t=darling_aec_trace::stats;
      std::cout << "NEGATIVE_RESULT profile=" << (candidate ? (nearendMask ? "diagnostic-nearend-mask" : "diagnostic-low-excitation") : "default")
        << " case=" << names[kind] << " passed=" << ok << " fidelity_applicable=" << (kind!=3);
      if (kind!=3) std::cout << " correlation=" << corr << " gain_db=" << gain << " snr_db=" << snr;
      std::cout << " silent_output_dbfs=" << silentDb << " winners=" << t.winners << " delay_known_blocks=" << t.delayKnown << '\n';
      const auto blocks=windowEnd.blocks-windowStart.blocks;
      std::cout << "NEGATIVE_STATE candidate=" << candidate << " case=" << names[kind]
        << " window=12-19 blocks=" << blocks << " usable=" << windowEnd.usable-windowStart.usable
        << " dominant=" << windowEnd.dominant-windowStart.dominant
        << " mean_gain=" << (windowEnd.amplitudeGain-windowStart.amplitudeGain)/std::max<uint64_t>(blocks,1) << '\n';
    }
    std::cout << "NEGATIVE_SUMMARY default_passed=" << passed[0] << "/4 candidate_passed=" << passed[1] << "/4\n";
    return passed[0]==4 && passed[1]==4 ? 0 : 11;
  } catch (const std::exception& e) { std::cerr << "Negative input/execution error: " << e.what() << '\n'; return 65; }
}
