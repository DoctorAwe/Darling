#pragma once
#include "aec3_pipeline.h"

// Deterministic smoke scenarios, not a speech-quality or double-talk benchmark.
inline int RunOfficialAec3Offline() {
  bool all_passed = true;
  for (bool noise : {false, true}) for (bool echo : {false, true}) {
    auto metrics = std::make_shared<darling::Aec3PipelineMetrics>();
    auto ns = noise ? std::make_shared<RnnoiseMetrics>() : nullptr;
    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = true;
    config.echo_canceller.mobile_mode = false;
    config.echo_canceller.enforce_high_pass_filtering = false;
    config.noise_suppression.enabled = false;
    config.high_pass_filter.enabled = false;
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    webrtc::BuiltinAudioProcessingBuilder builder(config);
    builder.SetCapturePostProcessing(std::make_unique<darling::Aec3PostProcessing>(metrics, ns));
    auto apm = builder.Build(webrtc::CreateEnvironment());
    const webrtc::StreamConfig mono(48000, 1);
    constexpr int length = 48000 * 20;
    std::vector<float> far(length), mic(length), out(length);
    std::array<float, 480> rendered{};
    std::mt19937 rng(72103);
    std::uniform_real_distribution<float> random(-.15f, .15f);
    float smooth = 0.f;
    for (int i=0;i<length;++i) {
      smooth = .8f * smooth + .2f * random(rng);
      far[i] = smooth;
      mic[i] = echo ? (i>=4800 ? .6f*far[i-4800] : 0.f) : random(rng);
    }
    double input_energy=0, output_energy=0;
    float peak=0;
    std::vector<double> times;
    for (int p=0;p<length;p+=480) {
      const float* r[]={far.data()+p}; float* ro[]={rendered.data()};
      const float* c[]={mic.data()+p}; float* co[]={out.data()+p};
      const auto start=std::chrono::steady_clock::now();
      if(apm->ProcessReverseStream(r,mono,mono,ro) || apm->ProcessStream(c,mono,mono,co)) return 40;
      times.push_back(std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now()-start).count());
      for(int i=p;i<p+480;++i) {
        if(!std::isfinite(out[i]) || std::abs(out[i])>1.f) return 41;
        peak=std::max(peak,std::abs(out[i]));
        if(i>=length/2) {input_energy+=double(mic[i])*mic[i];output_energy+=double(out[i])*out[i];}
      }
    }
    const double attenuation=10*std::log10(input_energy/std::max(output_energy,1e-30));
    std::sort(times.begin(),times.end());
    const bool passed=metrics->output_protection.load()==0 && metrics->post_frames.load()==2000 &&
        (!noise || ns->frames.load()==2000) && (echo ? attenuation>=15 : noise || std::abs(attenuation)<=3);
    std::printf("OFFICIAL_AEC3 noise=%d echo=%d attenuationDb=%.3f peak=%.6f p95Us=%.1f protection=%llu passed=%d\n",
        noise,echo,attenuation,peak,times[times.size()*95/100],
        static_cast<unsigned long long>(metrics->output_protection.load()),passed);
    all_passed = all_passed && passed;
  }
  return all_passed ? 0 : 42;
}
