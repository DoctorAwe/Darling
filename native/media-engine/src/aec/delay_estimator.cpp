#include "delay_estimator.h"

#include "aec_fail.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace darling::aec {

namespace {
int NextPowerOfTwo(int value) {
  int result = 1;
  while (result < value) result <<= 1;
  return result;
}
}  // namespace

DelayEstimator::DelayEstimator(const DelayEstimatorConfig& config) : config_(config) {
  if (config_.sample_rate <= 0 || config_.block <= 0 || config_.max_delay_ms <= 0)
    darling::aec::Fail("DelayEstimator: invalid configuration");
  window_ = config_.sample_rate * config_.window_ms / 1000;
  max_delay_ = config_.sample_rate * config_.max_delay_ms / 1000;
  mic_size_ = window_ + max_delay_;
  fft_size_ = NextPowerOfTwo(mic_size_);
  update_blocks_ = std::max(1, config_.sample_rate * config_.update_ms / 1000 / config_.block);
  tolerance_ = std::max(1, config_.sample_rate * static_cast<int>(config_.tolerance_ms) / 1000);

  fft_ = std::make_unique<ComplexFft>(static_cast<std::size_t>(fft_size_));
  // Both histories must start at the same absolute time; otherwise a delay
  // shows up as a constant offset of (mic_size - window).
  ref_.assign(mic_size_, 0.f);
  mic_.assign(mic_size_, 0.f);
  ref_fft_.assign(fft_size_, {});
  mic_fft_.assign(fft_size_, {});
  cross_.assign(fft_size_, {});
  Reset();
}

void DelayEstimator::Reset() {
  std::fill(ref_.begin(), ref_.end(), 0.f);
  std::fill(mic_.begin(), mic_.end(), 0.f);
  filled_ = 0;
  since_update_ = 0;
  candidate_ = 0;
  committed_ = 0;
  stable_ = 0;
  confidence_ = 0.f;
}

bool DelayEstimator::Push(const float* render, const float* capture, int block) {
  if (block <= 0 || block > window_) return false;

  std::memmove(ref_.data(), ref_.data() + block,
               static_cast<std::size_t>(mic_size_ - block) * sizeof(float));
  std::memcpy(ref_.data() + (mic_size_ - block), render,
              static_cast<std::size_t>(block) * sizeof(float));

  std::memmove(mic_.data(), mic_.data() + block,
               static_cast<std::size_t>(mic_size_ - block) * sizeof(float));
  std::memcpy(mic_.data() + (mic_size_ - block), capture,
              static_cast<std::size_t>(block) * sizeof(float));

  if (filled_ < mic_size_) filled_ = std::min(mic_size_, filled_ + block);
  if (++since_update_ < update_blocks_) return false;
  since_update_ = 0;
  if (filled_ < mic_size_) return false;
  return Update();
}

bool DelayEstimator::Update() {
  for (int i = 0; i < fft_size_; ++i) {
    ref_fft_[i] = std::complex<float>(i < mic_size_ ? ref_[i] : 0.f, 0.f);
    mic_fft_[i] = std::complex<float>(i < mic_size_ ? mic_[i] : 0.f, 0.f);
  }
  fft_->Forward(ref_fft_.data());
  fft_->Forward(mic_fft_.data());

  for (int i = 0; i < fft_size_; ++i) {
    cross_[i] = mic_fft_[i] * std::conj(ref_fft_[i]);
    const float magnitude = std::abs(cross_[i]);
    if (magnitude > 1e-12f) cross_[i] /= magnitude;  // PHAT weighting
  }
  fft_->Inverse(cross_.data());

  // The FFT convention can put a positive microphone lag at either `lag` or
  // `N - lag`. Evaluate both candidate peaks with a true normalized
  // correlation so the result does not depend on that convention.
  const auto correlation_at = [&](int lag) {
    double numerator = 0;
    double reference_energy = 0;
    double microphone_energy = 0;
    for (int n = 0; n < window_; ++n) {
      const double a = ref_[n];
      const double b = mic_[n + lag];
      numerator += a * b;
      reference_energy += a * a;
      microphone_energy += b * b;
    }
    return static_cast<float>(
        numerator / std::sqrt(std::max(reference_energy * microphone_energy, 1e-30)));
  };

  int candidate_a = 0;
  float peak_a = -1e30f;
  for (int lag = 0; lag <= max_delay_; ++lag) {
    if (cross_[lag].real() > peak_a) {
      peak_a = cross_[lag].real();
      candidate_a = lag;
    }
  }
  int candidate_b = 0;
  float peak_b = -1e30f;
  for (int lag = 1; lag <= max_delay_; ++lag) {
    const int index = (fft_size_ - lag) % fft_size_;
    if (cross_[index].real() > peak_b) {
      peak_b = cross_[index].real();
      candidate_b = lag;
    }
  }
  const float correlation_a = correlation_at(candidate_a);
  const float correlation_b = correlation_at(candidate_b);
  const int best = correlation_b > correlation_a ? candidate_b : candidate_a;
  const float correlation = std::max(correlation_a, correlation_b);

  if (correlation >= config_.min_correlation) {
    if (std::abs(best - candidate_) <= tolerance_) {
      ++stable_;
    } else {
      candidate_ = best;
      stable_ = 1;
    }
    confidence_ = correlation;
    if (stable_ >= config_.confirmations) {
      const bool changed = candidate_ != committed_;
      committed_ = candidate_;
      return changed;
    }
  } else {
    stable_ = 0;
    confidence_ = correlation;
  }
  return false;
}

}  // namespace darling::aec
