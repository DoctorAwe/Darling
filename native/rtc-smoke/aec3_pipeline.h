#pragma once
#include "api/audio/builtin_audio_processing_builder.h"
#include "rnnoise_processing.h"

namespace darling {
struct Aec3PipelineMetrics {
  std::atomic<uint64_t> post_frames{0}, output_protection{0};
};

// This hook runs AFTER APM's built-in AEC3 and band recombination. It never
// feeds a second echo canceller or replaces APM's own render-reference path.
class Aec3PostProcessing final : public webrtc::CustomProcessing {
 public:
  Aec3PostProcessing(std::shared_ptr<Aec3PipelineMetrics> metrics,
                     std::shared_ptr<RnnoiseMetrics> noise)
      : metrics_(std::move(metrics)) {
    if (noise) noise_ = std::make_unique<RnnoiseProcessing>(std::move(noise));
  }
  void Initialize(int rate, int channels) override {
    RTC_CHECK_EQ(channels, 1);
    if (noise_) noise_->Initialize(rate, channels);
  }
  void Process(webrtc::AudioBuffer* audio) override {
    RTC_CHECK_EQ(audio->num_channels(), 1u);
    // Do not pass invalid AEC output into the recurrent denoiser.
    Protect(audio);
    if (noise_) noise_->Process(audio);
    Protect(audio);
    metrics_->post_frames.fetch_add(1, std::memory_order_relaxed);
  }
  std::string ToString() const override { return "AEC3 post: optional RNNoise + output guard"; }
 private:
  void Protect(webrtc::AudioBuffer* audio) {
    auto* samples = audio->channels()[0];
    float peak = 0.f;
    for (size_t i = 0; i < audio->num_frames(); ++i) {
      if (!std::isfinite(samples[i])) {
        std::fill(samples, samples + audio->num_frames(), 0.f);
        metrics_->output_protection.fetch_add(1, std::memory_order_relaxed);
        return;
      }
      peak = std::max(peak, std::abs(samples[i]));
    }
    if (peak > 32767.f) {
      for (size_t i = 0; i < audio->num_frames(); ++i) samples[i] *= 32767.f / peak;
      metrics_->output_protection.fetch_add(1, std::memory_order_relaxed);
    }
  }
  std::shared_ptr<Aec3PipelineMetrics> metrics_;
  std::unique_ptr<RnnoiseProcessing> noise_;
};

// Retain the actual APM for configuration verification, not a second APM.
// The owner outlives factory creation and releases its reference on the worker.
class Aec3PipelineBuilder final : public webrtc::BuiltinAudioProcessingBuilder {
 public:
  explicit Aec3PipelineBuilder(webrtc::scoped_refptr<webrtc::AudioProcessing>& apm)
      : apm_(apm) {}
  webrtc::scoped_refptr<webrtc::AudioProcessing> Build(const webrtc::Environment& env) override {
    apm_ = webrtc::BuiltinAudioProcessingBuilder::Build(env);
    return apm_;
  }
 private:
  webrtc::scoped_refptr<webrtc::AudioProcessing>& apm_;
};
}  // namespace darling
