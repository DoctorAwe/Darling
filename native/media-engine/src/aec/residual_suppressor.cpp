#include "residual_suppressor.h"

#include "aec_fail.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace darling::aec {

namespace {
float DbToLinear(float db) { return std::pow(10.f, db / 20.f); }
}  // namespace

ResidualSuppressor::ResidualSuppressor(const ResidualSuppressorConfig& config)
    : config_(config) {
  if (config_.fft < 8 || (config_.fft & (config_.fft - 1)) != 0)
    darling::aec::Fail("ResidualSuppressor: fft must be a power of two");
  bins_ = config_.fft / 2 + 1;
  hf_bin_ = config_.fft * 8000 / 48000;
  gamma_.assign(bins_, config_.initial_gamma);
  gain_.assign(bins_, 1.f);
  previous_.assign(bins_, 1.f);
  smoothed_.assign(bins_, 1.f);
}

void ResidualSuppressor::Reset() {
  std::fill(gamma_.begin(), gamma_.end(), config_.initial_gamma);
  std::fill(gain_.begin(), gain_.end(), 1.f);
  std::fill(previous_.begin(), previous_.end(), 1.f);
  std::fill(smoothed_.begin(), smoothed_.end(), 1.f);
  mean_gain_ = 1.f;
}

float ResidualSuppressor::mean_gamma() const {
  double sum = 0;
  for (float value : gamma_) sum += value;
  return static_cast<float>(sum / std::max<std::size_t>(gamma_.size(), 1));
}

void ResidualSuppressor::Process(std::complex<float>* residual,
                                 const std::complex<float>* echo, bool far_active,
                                 bool learn_gamma, float near_probability) {
  const float floor_low = DbToLinear(config_.gain_floor_db);
  const float floor_high = DbToLinear(config_.gain_floor_hf_db);
  const float gamma_alpha = config_.gamma_smoothing;

  for (int k = 0; k < bins_; ++k) {
    const float echo_power = std::norm(echo[k]);
    const float residual_power = std::norm(residual[k]);

    if (far_active && learn_gamma && echo_power > 1e-12f) {
      const float raw = residual_power / echo_power;
      const float clamped = std::clamp(raw, config_.gamma_min, config_.gamma_max);
      gamma_[k] = (1.f - gamma_alpha) * gamma_[k] + gamma_alpha * clamped;
    }

    float target = 1.f;
    if (far_active) {
      const float interference = gamma_[k] * echo_power;
      if (residual_power <= config_.near_protection * interference) {
        target = std::sqrt(std::max(0.f, 1.f - interference / (residual_power + 1e-12f)));
      }
    }
    // Double-talk: blend toward unity instead of guessing which part of the
    // residual is echo. Near-end fidelity wins over residual suppression.
    target = near_probability + (1.f - near_probability) * target;
    target = std::clamp(target, k <= hf_bin_ ? floor_low : floor_high, 1.f);

    const float coefficient = target < previous_[k] ? config_.attack : config_.release;
    previous_[k] = coefficient * target + (1.f - coefficient) * previous_[k];
    gain_[k] = previous_[k];
  }

  // Three-bin smoothing reduces musical noise without smearing speech onsets.
  for (int k = 0; k < bins_; ++k) {
    const int left = std::max(0, k - 1);
    const int right = std::min(bins_ - 1, k + 1);
    smoothed_[k] = (gain_[left] + gain_[k] + gain_[right]) / 3.f;
  }

  double sum = 0;
  for (int k = 0; k < bins_; ++k) {
    residual[k] *= smoothed_[k];
    sum += smoothed_[k];
  }
  mean_gain_ = static_cast<float>(sum / bins_);

  // Keep the spectrum Hermitian so the inverse FFT stays real.
  for (int k = 1; k < bins_ - 1; ++k) residual[config_.fft - k] = std::conj(residual[k]);
}

}  // namespace darling::aec
