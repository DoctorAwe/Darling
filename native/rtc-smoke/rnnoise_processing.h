#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <memory>
#include <string>
#include "api/audio/audio_processing.h"
#include "modules/audio_processing/audio_buffer.h"
#include "rtc_base/checks.h"
#include "common_audio/resampler/include/push_resampler.h"
#include "../../.local/rnnoise/include/rnnoise.h"

struct RnnoiseMetrics {
  std::atomic<uint64_t> frames{0}, total_us{0}, maximum_us{0};
};

// AudioBuffer's full-band samples and RNNoise both use float S16 scale.
// No normalized-float multiplication, AGC, gate, or second denoiser.
class RnnoiseProcessing final : public webrtc::CustomProcessing {
 public:
  explicit RnnoiseProcessing(std::shared_ptr<RnnoiseMetrics> metrics)
      : metrics_(std::move(metrics)) {}
  ~RnnoiseProcessing() override { Reset(); }
  void Initialize(int sample_rate_hz, int num_channels) override {
    Reset();
    // APM construction starts at 16 kHz; Bluetooth may also deliver narrowband.
    sample_rate_ = sample_rate_hz;
    channels_ = num_channels;
    RTC_CHECK(sample_rate_hz == 16000 || sample_rate_hz == 32000 || sample_rate_hz == 48000);
    up_ = std::make_unique<webrtc::PushResampler<float>>(sample_rate_hz/100, 480, 1);
    down_ = std::make_unique<webrtc::PushResampler<float>>(480, sample_rate_hz/100, 1);
    RTC_CHECK_EQ(rnnoise_get_frame_size(), 480);
    state_ = rnnoise_create(nullptr);
    RTC_CHECK(state_);
  }
  void Process(webrtc::AudioBuffer* audio) override {
    RTC_CHECK(state_);
    RTC_CHECK_EQ(channels_, 1);
    RTC_CHECK_EQ(audio->num_channels(), 1u);
    RTC_CHECK_EQ(audio->num_frames(), static_cast<size_t>(sample_rate_/100));
    auto start = std::chrono::steady_clock::now();
    auto* samples = audio->channels()[0];
    const float* input = samples;
    if (sample_rate_ != 48000) {
      up_->Resample(webrtc::MonoView<const float>(samples, audio->num_frames()), webrtc::MonoView<float>(input_.data(), 480));
      input = input_.data();
    }
    rnnoise_process_frame(state_, output_.data(), input);
    for (size_t i = 0; i < output_.size(); ++i) {
      RTC_CHECK(std::isfinite(output_[i]));
    }
    if (sample_rate_ != 48000) down_->Resample(webrtc::MonoView<const float>(output_.data(),480), webrtc::MonoView<float>(samples,audio->num_frames()));
    else std::copy(output_.begin(), output_.end(), samples);
    const uint64_t elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - start).count();
    metrics_->frames.fetch_add(1, std::memory_order_relaxed);
    metrics_->total_us.fetch_add(elapsed, std::memory_order_relaxed);
    auto maximum = metrics_->maximum_us.load(std::memory_order_relaxed);
    while (elapsed > maximum && !metrics_->maximum_us.compare_exchange_weak(maximum, elapsed)) {}
  }
  std::string ToString() const override { return "RNNoise v0.2 official model 0b50c45"; }
 private:
  void Reset() { if (state_) rnnoise_destroy(state_); state_ = nullptr; }
  DenoiseState* state_ = nullptr;
  int sample_rate_ = 0, channels_ = 0;
  std::array<float, 480> input_{}, output_{};
  std::unique_ptr<webrtc::PushResampler<float>> up_, down_;
  std::shared_ptr<RnnoiseMetrics> metrics_;
};
