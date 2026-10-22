#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include "api/audio/audio_processing.h"
#include "modules/audio_processing/audio_buffer.h"
#include "common_audio/resampler/include/push_resampler.h"
#include "rtc_base/checks.h"
#include "render_reference_queue.h"

namespace darling {

// Captures the playout reference at the APM render pre-processing hook and
// hands 10 ms normalized blocks to the capture-side AEC on another thread.
// Single producer (render) / single consumer (capture); no locks, no allocation.
class RenderReferenceTap final : public webrtc::CustomProcessing {
 public:
  static constexpr int kBlock = 480;   // 10 ms at 48 kHz
  static constexpr int kBlocks = 16;   // 160 ms of slack

  explicit RenderReferenceTap(std::shared_ptr<RenderReferenceQueue> queue)
      : queue_(std::move(queue)) {}

  void Initialize(int sample_rate_hz, int num_channels) override {
    sample_rate_ = sample_rate_hz;
    channels_ = num_channels;
    RTC_CHECK(sample_rate_hz == 8000 || sample_rate_hz == 16000 ||
              sample_rate_hz == 32000 || sample_rate_hz == 44100 || sample_rate_hz == 48000);
    resampler_ = std::make_unique<webrtc::PushResampler<float>>(sample_rate_hz / 100, kBlock, 1);
    queue_->Invalidate();
  }

  void Process(webrtc::AudioBuffer* audio) override {
    RTC_CHECK_GT(channels_, 0);
    RTC_CHECK_GT(audio->num_channels(), 0u);
    RTC_CHECK_EQ(audio->num_frames(), static_cast<size_t>(sample_rate_ / 100));
    // Downmix every rendered channel, not just the left speaker.
    for (size_t i = 0; i < audio->num_frames(); ++i) {
      float sum = 0.f;
      for (size_t ch = 0; ch < audio->num_channels(); ++ch) sum += audio->channels()[ch][i];
      mono_[i] = sum / (32768.f * audio->num_channels());
    }
    if (sample_rate_ == 48000) queue_->Push(mono_.data());
    else {
      resampler_->Resample(webrtc::MonoView<const float>(mono_.data(), audio->num_frames()),
                           webrtc::MonoView<float>(resampled_.data(), kBlock));
      queue_->Push(resampled_.data());
    }
  }

  std::string ToString() const override { return "Darling render reference tap"; }

 private:
  int sample_rate_ = 0;
  int channels_ = 0;
  std::shared_ptr<RenderReferenceQueue> queue_;
  std::unique_ptr<webrtc::PushResampler<float>> resampler_;
  std::array<float, kBlock> mono_{}, resampled_{};
};

}  // namespace darling
