#pragma once

#include <atomic>
#include <cstdint>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>

#include "api/audio/audio_processing.h"
#include "modules/audio_processing/audio_buffer.h"

#include "../media-engine/src/aec/delay_estimator.h"
#include "../media-engine/src/aec/linear_aec.h"
#include "render_tap.h"
#include "rnnoise_processing.h"

namespace darling {

struct AecMetrics {
  std::atomic<uint64_t> frames{0};
  std::atomic<int> delay_samples{0};
  std::atomic<float> erle_db{0.f};
  std::atomic<float> gamma{0.f};
  std::atomic<float> gain{1.f};
  std::atomic<uint64_t> missing_reference{0}, resets{0}, total_us{0}, maximum_us{0}, safety_events{0};
  std::atomic<uint64_t> output_protection{0};
};

// Capture post-processing chain: linear AEC -> residual suppressor -> RNNoise.
// APM buffers use float-S16 scale; the AEC core uses normalized [-1, 1], so the
// conversion happens only at this boundary.
class CaptureChain final : public webrtc::CustomProcessing {
 public:
  CaptureChain(std::shared_ptr<RenderReferenceQueue> tap, bool rnnoise_enabled,
               std::shared_ptr<AecMetrics> aec_metrics,
               std::shared_ptr<RnnoiseMetrics> rnnoise_metrics)
      : tap_(std::move(tap)), aec_metrics_(std::move(aec_metrics)) {
    if (rnnoise_enabled) rnnoise_ = std::make_unique<RnnoiseProcessing>(std::move(rnnoise_metrics));
  }

  void Initialize(int sample_rate_hz, int num_channels) override {
    sample_rate_ = sample_rate_hz;
    channels_ = num_channels;
    RTC_CHECK_EQ(num_channels, 1);
    RTC_CHECK(sample_rate_hz == 16000 || sample_rate_hz == 32000 || sample_rate_hz == 48000);
    if (rnnoise_) rnnoise_->Initialize(sample_rate_hz, num_channels);
    up_ = std::make_unique<webrtc::PushResampler<float>>(sample_rate_hz / 100, 480, 1);
    down_ = std::make_unique<webrtc::PushResampler<float>>(480, sample_rate_hz / 100, 1);
    aec_ = std::make_unique<darling::aec::LinearAec>();
    estimator_ = std::make_unique<darling::aec::DelayEstimator>();
    tap_->Discard();
    discontinuities_ = tap_->discontinuities();
    missing_blocks_ = 0;
  }

  void Process(webrtc::AudioBuffer* audio) override {
    RTC_CHECK(aec_ && estimator_);
    RTC_CHECK_EQ(audio->num_channels(), 1u);
    RTC_CHECK_EQ(audio->num_frames(), static_cast<size_t>(sample_rate_ / 100));
    {
      const auto start = std::chrono::steady_clock::now();
      float* channel = audio->channels()[0];
      float capture[480];
      float reference[480];
      float output[480];
      const auto discontinuities = tap_->discontinuities();
      if (discontinuities != discontinuities_) {
        tap_->Discard();
        aec_->Reset();
        estimator_->Reset();
        discontinuities_ = discontinuities;
        aec_metrics_->resets.fetch_add(1, std::memory_order_relaxed);
      }
      if (sample_rate_ != 48000) {
        up_->Resample(webrtc::MonoView<const float>(channel, audio->num_frames()),
                      webrtc::MonoView<float>(capture, 480));
        for (auto& value : capture) value /= 32768.f;
      } else for (int i = 0; i < 480; ++i) capture[i] = channel[i] / 32768.f;

      const bool has_reference = tap_->PopAligned(reference);
      if (!has_reference) {
        // Preserve coefficients across callback jitter; insert a timed gap.
        // The queue drops a reference arriving after its capture interval.
        std::fill(reference, reference + 480, 0.f);
        estimator_->Push(reference, capture, 480);
        aec_->Process(reference, capture, output, false);
        aec_metrics_->missing_reference.fetch_add(1, std::memory_order_relaxed);
        // A persistent clock/phase slip needs a new timeline anchor. Do not
        // let all future reference frames be classified late indefinitely.
        if (++missing_blocks_ == 3) {
          tap_->Discard();
          estimator_->Reset();
          aec_->Reset();
          aec_metrics_->resets.fetch_add(1, std::memory_order_relaxed);
        }
      } else {
        missing_blocks_ = 0;
        if (estimator_->Push(reference, capture, 480)) aec_->SetBulkDelay(estimator_->delay_samples());
        aec_->Process(reference, capture, output);
        for (auto& value : output) { RTC_CHECK(std::isfinite(value)); value *= 32768.f; }
        if (sample_rate_ == 48000) std::copy(output, output + 480, channel);
        else down_->Resample(webrtc::MonoView<const float>(output, 480),
                             webrtc::MonoView<float>(channel, audio->num_frames()));
      }
      if (aec_metrics_) {
        if (has_reference) aec_metrics_->frames.fetch_add(1, std::memory_order_relaxed);
        aec_metrics_->delay_samples.store(estimator_->delay_samples(), std::memory_order_relaxed);
        aec_metrics_->erle_db.store(aec_->erle_db(), std::memory_order_relaxed);
        aec_metrics_->gamma.store(aec_->mean_gamma(), std::memory_order_relaxed);
        aec_metrics_->gain.store(aec_->mean_res_gain(), std::memory_order_relaxed);
        aec_metrics_->safety_events.store(aec_->safety_events(), std::memory_order_relaxed);
        const uint64_t elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - start).count();
        aec_metrics_->total_us.fetch_add(elapsed, std::memory_order_relaxed);
        auto maximum = aec_metrics_->maximum_us.load(std::memory_order_relaxed);
        while (elapsed > maximum && !aec_metrics_->maximum_us.compare_exchange_weak(maximum, elapsed)) {}
      }
    }
    if (rnnoise_ && audio->num_channels() == 1) rnnoise_->Process(audio);
    // Final emergency headroom guard, including RNNoise/resampling. Normal
    // blocks remain bit-for-bit unchanged; this is not loudness normalization.
    float peak = 0.f;
    auto* samples = audio->channels()[0];
    for (size_t i = 0; i < audio->num_frames(); ++i) {
      if (!std::isfinite(samples[i])) {
        std::fill(samples, samples + audio->num_frames(), 0.f);
        aec_metrics_->output_protection.fetch_add(1);
        return;
      }
      peak = std::max(peak, std::abs(samples[i]));
    }
    if (peak > 32767.f) {
      const float gain = 32767.f / peak;
      for (size_t i = 0; i < audio->num_frames(); ++i) samples[i] *= gain;
      aec_metrics_->output_protection.fetch_add(1);
    }
  }

  std::string ToString() const override { return "Darling AEC -> RES -> RNNoise"; }

 private:
  std::shared_ptr<RenderReferenceQueue> tap_;
  std::shared_ptr<AecMetrics> aec_metrics_;
  std::unique_ptr<RnnoiseProcessing> rnnoise_;
  std::unique_ptr<darling::aec::LinearAec> aec_;
  std::unique_ptr<darling::aec::DelayEstimator> estimator_;
  int sample_rate_ = 0;
  int channels_ = 0;
  uint64_t discontinuities_ = 0;
  int missing_blocks_ = 0;
  std::unique_ptr<webrtc::PushResampler<float>> up_, down_;
};

}  // namespace darling
