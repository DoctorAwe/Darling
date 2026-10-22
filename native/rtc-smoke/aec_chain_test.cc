// Actual APM hooks, no physical devices and no network.
#include <array>
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>
#include "api/audio/builtin_audio_processing_builder.h"
#include "api/environment/environment_factory.h"
#include "capture_chain.h"
#include "aec3_offline_test.h"
#include "aec_compare.h"

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "--compare") return CompareAec(argc, argv);
  if (argc == 2 && std::string(argv[1]) == "--official-aec3") return RunOfficialAec3Offline();
  if (argc != 1) return 2;
  // Regression through real APM hooks, with and without RNNoise. The old
  // implementation emitted >58 normalized peak on this no-echo step.
  for (bool jitter : {false, true}) {
    auto reference = std::make_shared<darling::RenderReferenceQueue>();
    auto metrics = std::make_shared<darling::AecMetrics>();
    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = false;
    config.noise_suppression.enabled = false;
    config.high_pass_filter.enabled = false;
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    webrtc::BuiltinAudioProcessingBuilder builder(config);
    builder.SetRenderPreProcessing(std::make_unique<darling::RenderReferenceTap>(reference));
    builder.SetCapturePostProcessing(std::make_unique<darling::CaptureChain>(reference, false, metrics, nullptr));
    auto apm = builder.Build(webrtc::CreateEnvironment());
    const webrtc::StreamConfig mono(48000,1);
    constexpr int frames = 48000 * 8;
    std::vector<float> far(frames), mic(frames), output(frames);
    std::array<float,480> rendered{};
    std::mt19937 random(287);
    std::uniform_real_distribution<float> noise(-.15f,.15f);
    for(int i=0;i<frames;++i) {
      far[i]=noise(random);
      mic[i]=i>=4800?far[i-4800]*.5f:0.f;
    }
    bool late=false;
    double in_energy=0,out_energy=0;
    for(int p=0;p<frames;p+=480) {
      float* ro[]={rendered.data()};
      if(late) {
        const float* old[]={far.data()+p-480};
        if(apm->ProcessReverseStream(old,mono,mono,ro)) return 20;
      }
      late=jitter && p>=48000*2 && (p/480)%50==0;
      if(!late) {
        const float* r[]={far.data()+p};
        if(apm->ProcessReverseStream(r,mono,mono,ro)) return 21;
      }
      const float* c[]={mic.data()+p}; float* o[]={output.data()+p};
      if(apm->ProcessStream(c,mono,mono,o)) return 22;
      for(int i=p;i<p+480;++i) {
        if(!std::isfinite(output[i]) || std::abs(output[i])>1.f) return 23;
        if(i>=48000*4) {in_energy+=double(mic[i])*mic[i];out_energy+=double(output[i])*output[i];}
      }
    }
    const double erle=10*std::log10(in_energy/std::max(out_energy,1e-30));
    std::printf("APM_ECHO_OK jitter=%d erleDb=%.3f resets=%llu missing=%llu\n",jitter,erle,
        static_cast<unsigned long long>(metrics->resets.load()),
        static_cast<unsigned long long>(metrics->missing_reference.load()));
    if(erle < (jitter?10:25) || metrics->output_protection.load()!=0) return 24;
  }
  for (bool denoise : {false, true}) {
    auto reference = std::make_shared<darling::RenderReferenceQueue>();
    auto aec = std::make_shared<darling::AecMetrics>();
    auto ns = std::make_shared<RnnoiseMetrics>();
    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = false;
    config.noise_suppression.enabled = false;
    config.high_pass_filter.enabled = false;
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    webrtc::BuiltinAudioProcessingBuilder builder(config);
    builder.SetRenderPreProcessing(std::make_unique<darling::RenderReferenceTap>(reference));
    builder.SetCapturePostProcessing(std::make_unique<darling::CaptureChain>(reference, denoise, aec, ns));
    auto apm = builder.Build(webrtc::CreateEnvironment());
    const webrtc::StreamConfig mono(48000, 1);
    std::array<float, 480> render{}, mic{}, out{}, rendered{};
    const float* r[] = {render.data()}; float* ro[] = {rendered.data()};
    const float* c[] = {mic.data()}; float* co[] = {out.data()};
    std::mt19937 random(9301);
    std::uniform_real_distribution<float> noise(-1, 1);
    float peak = 0;
    for (int block=0; block<800; ++block) {
      for (int i=0;i<480;++i) {
        render[i]=noise(random)*(block<100?.0001f:.15f);
        mic[i]=noise(random)*.15f;
      }
      if (apm->ProcessReverseStream(r,mono,mono,ro) ||
          apm->ProcessStream(c,mono,mono,co)) return 10;
      for (float value:out) {
        if (!std::isfinite(value) || std::abs(value)>1.f) return 11;
        peak=std::max(peak,std::abs(value));
      }
    }
    if (!denoise && peak>.16f) return 12;
    if (aec->output_protection.load()!=0) return 13; // not merely hidden by a limiter
    // One late reference after a missed interval is skipped; no filter reset.
    const auto resets=aec->resets.load();
    if (apm->ProcessStream(c,mono,mono,co)) return 14;
    if (apm->ProcessReverseStream(r,mono,mono,ro) ||
        apm->ProcessReverseStream(r,mono,mono,ro) ||
        apm->ProcessStream(c,mono,mono,co)) return 15;
    if (aec->resets.load()!=resets) return 16;
    std::printf("APM_STEP_OK rnnoise=%d peak=%.6f outputProtection=0 shortGapResets=0\n",denoise,peak);
  }
  for (bool denoise : {false, true}) {
    auto reference = std::make_shared<darling::RenderReferenceQueue>();
    auto aec = std::make_shared<darling::AecMetrics>();
    auto ns = std::make_shared<RnnoiseMetrics>();
    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = false;
    config.noise_suppression.enabled = false;
    config.high_pass_filter.enabled = false;
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    webrtc::BuiltinAudioProcessingBuilder builder(config);
    builder.SetRenderPreProcessing(std::make_unique<darling::RenderReferenceTap>(reference));
    builder.SetCapturePostProcessing(std::make_unique<darling::CaptureChain>(reference, denoise, aec, ns));
    auto apm = builder.Build(webrtc::CreateEnvironment());
    if (!apm) return 1;
    // Rate changes on the same instance exercise reinitialization too.
    for (int rate : {48000, 16000, 32000, 48000}) {
      const webrtc::StreamConfig mono(rate, 1), stereo(rate, 2);
      std::array<float, 480> left{}, right{}, capture{}, output{}, render_left{}, render_right{};
      const float* renders[] = {left.data(), right.data()};
      float* render_outputs[] = {render_left.data(), render_right.data()};
      const float* inputs[] = {capture.data()};
      float* outputs[] = {output.data()};
      const auto frames_before = aec->frames.load();
      for (int block = 0; block < 200; ++block) {
        for (int i = 0; i < rate / 100; ++i) {
          // Right-only reference catches accidental left-channel-only taps.
          right[i] = .1f * std::sin((block * (rate / 100) + i) * 900.0 / rate);
          capture[i] = .05f * std::sin((block * (rate / 100) + i) * 1700.0 / rate);
        }
        if (apm->ProcessReverseStream(renders, stereo, stereo, render_outputs)) return 2;
        if (apm->ProcessStream(inputs, mono, mono, outputs)) return 3;
        for (int i = 0; i < rate / 100; ++i) if (!std::isfinite(output[i])) return 4;
      }
      if (aec->frames.load() - frames_before < 190) return 5;
      const auto missing = aec->missing_reference.load();
      // Empty reference bypasses AEC rather than using stale echo estimates.
      for (int block = 0; block < 20; ++block) {
        if (apm->ProcessStream(inputs, mono, mono, outputs)) return 6;
        if (!denoise) for (int i = 0; i < rate / 100; ++i)
          if (std::abs(output[i] - capture[i]) > 1e-5f) return 7;
      }
      if (aec->missing_reference.load() - missing != 20) return 8;
      std::printf("APM_CHAIN_OK rate=%d rnnoise=%d frames=%llu\n", rate, denoise,
                  static_cast<unsigned long long>(aec->frames.load()));
    }
    if (denoise && ns->frames.load() < 800) return 9;
  }
  return 0;
}
