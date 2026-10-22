#include "linear_aec.h"

#include "aec_fail.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstring>
#include <stdexcept>

namespace darling::aec {

namespace {
constexpr int kErleWindowBlocks = 20;  // 200 ms at 10 ms blocks
constexpr float kMinReferencePower = 1e-3f;
}  // namespace

LinearAec::LinearAec(const LinearAecConfig& config)
    : config_(config),
      block_(config.block),
      fft_size_(config.fft),
      partitions_(config.partitions),
      max_delay_(std::max(0, config.max_delay_samples)),
      history_capacity_(std::max(0, config.max_delay_samples) + config.block + config.block),
      fft_(static_cast<std::size_t>(config.fft)) {
  if (block_ <= 0 || partitions_ <= 0 || fft_size_ < 2 * block_ - 1)
    darling::aec::Fail("LinearAec: require fft >= 2*block-1 and positive sizes");

  x_ring_.assign(static_cast<std::size_t>(partitions_) * fft_size_, {});
  h_bg_.assign(static_cast<std::size_t>(partitions_) * fft_size_, {});
  h_fg_.assign(static_cast<std::size_t>(partitions_) * fft_size_, {});
  y_bg_.assign(fft_size_, {});
  y_fg_.assign(fft_size_, {});
  ifft_bg_.assign(fft_size_, {});
  ifft_fg_.assign(fft_size_, {});
  e_bg_.assign(fft_size_, {});
  e_fg_.assign(fft_size_, {});
  ifft_out_.assign(fft_size_, {});
  scratch_.assign(fft_size_, {});
  power_.assign(fft_size_, 0.f);
  block_buffer_.assign(fft_size_, 0.f);
  error_block_.assign(fft_size_, 0.f);
  delayed_.assign(block_, 0.f);
  render_history_.assign(history_capacity_, 0.f);

  ResidualSuppressorConfig res_config;
  res_config.fft = fft_size_;
  res_ = std::make_unique<ResidualSuppressor>(res_config);
  Reset();
}

void LinearAec::Reset() {
  ResetFilters();
  std::fill(render_history_.begin(), render_history_.end(), 0.f);
  history_write_ = 0;
  bulk_delay_ = 0;
}

void LinearAec::ResetFilters() {
  std::fill(x_ring_.begin(), x_ring_.end(), std::complex<float>{});
  std::fill(h_bg_.begin(), h_bg_.end(), std::complex<float>{});
  std::fill(h_fg_.begin(), h_fg_.end(), std::complex<float>{});
  std::fill(block_buffer_.begin(), block_buffer_.end(), 0.f);
  if (res_) res_->Reset();
  ring_pos_ = 0;
  primed_ = false;
  acc_capture_ = acc_bg_ = acc_fg_ = 0;
  erle_blocks_ = 0;
  copy_hits_ = 0;
  harmful_foreground_windows_ = 0;
  foreground_valid_ = false;
  erle_db_ = 0.f;
  dtd_ratio_ = 0.f;
  near_probability_ = 0.f;
  near_hold_ = 0;
  blocks_since_reset_ = 0;
}

void LinearAec::SetBulkDelay(int samples) {
  const int clamped = std::clamp(samples, 0, max_delay_);
  if (clamped == bulk_delay_) return;
  bulk_delay_ = clamped;
  ResetFilters();
}

void LinearAec::Process(const float* render, const float* capture, float* output, bool reference_valid) {
  const int b = block_;
  const int n = fft_size_;
  const int k = partitions_;
  const int capacity = history_capacity_;
  double render_energy = 0;
  float capture_peak = 0.f;
  for (int i = 0; i < b; ++i) {
    if (!std::isfinite(render[i]) || !std::isfinite(capture[i])) {
      Reset();
      ++safety_events_;
      for (int j = 0; j < b; ++j)
        output[j] = std::isfinite(capture[j]) ? std::clamp(capture[j], -1.f, 1.f) : 0.f;
      return;
    }
    render_energy += static_cast<double>(render[i]) * render[i];
    capture_peak = std::max(capture_peak, std::abs(capture[i]));
  }

  for (int i = 0; i < b; ++i) {
    render_history_[history_write_] = render[i];
    history_write_ = (history_write_ + 1) % capacity;
  }
  const int start = (history_write_ - b - bulk_delay_ + 2 * capacity) % capacity;
  for (int i = 0; i < b; ++i) delayed_[i] = render_history_[(start + i) % capacity];

  if (!primed_) {
    std::fill(block_buffer_.begin(), block_buffer_.end(), 0.f);
    primed_ = true;
  } else {
    std::memmove(block_buffer_.data(), block_buffer_.data() + b,
                 static_cast<std::size_t>(n - b) * sizeof(float));
  }
  std::memcpy(block_buffer_.data() + (n - b), delayed_.data(),
              static_cast<std::size_t>(b) * sizeof(float));

  std::complex<float>* x = x_ring_.data() + static_cast<std::size_t>(ring_pos_) * n;
  for (int i = 0; i < n; ++i) x[i] = std::complex<float>(block_buffer_[i], 0.f);
  fft_.Forward(x);
  if (!reference_valid) {
    // Advance the reference history, but preserve the learned acoustic path.
    // A missing callback is not evidence that the room changed.
    acc_capture_ = acc_bg_ = acc_fg_ = 0;
    erle_blocks_ = copy_hits_ = 0;
    ring_pos_ = (ring_pos_ + 1) % k;
    std::copy(capture, capture + b, output);
    return;
  }

  std::fill(y_bg_.begin(), y_bg_.end(), std::complex<float>{});
  if (config_.double_path) std::fill(y_fg_.begin(), y_fg_.end(), std::complex<float>{});
  for (int j = 0; j < k; ++j) {
    const int index = (ring_pos_ - j + k) % k;
    const std::complex<float>* xj = x_ring_.data() + static_cast<std::size_t>(index) * n;
    const std::complex<float>* bg = h_bg_.data() + static_cast<std::size_t>(j) * n;
    const std::complex<float>* fg = h_fg_.data() + static_cast<std::size_t>(j) * n;
    for (int i = 0; i < n; ++i) {
      y_bg_[i] += bg[i] * xj[i];
      if (config_.double_path) y_fg_[i] += fg[i] * xj[i];
    }
  }

  std::copy(y_bg_.begin(), y_bg_.end(), ifft_bg_.begin());
  fft_.Inverse(ifft_bg_.data());
  if (config_.double_path) {
    std::copy(y_fg_.begin(), y_fg_.end(), ifft_fg_.begin());
    fft_.Inverse(ifft_fg_.data());
  }

  std::fill(error_block_.begin(), error_block_.end(), 0.f);
  double capture_energy = 0;
  double bg_energy = 0;
  double fg_energy = 0;
  double estimated_energy = 0;
  for (int i = 0; i < b; ++i) {
    const float estimated_bg = ifft_bg_[n - b + i].real();
    const float residual_bg = capture[i] - estimated_bg;
    float estimated_fg = estimated_bg;
    float residual_fg = residual_bg;
    if (config_.double_path) {
      estimated_fg = ifft_fg_[n - b + i].real();
      residual_fg = capture[i] - estimated_fg;
    }
    error_block_[n - b + i] = residual_bg;
    output[i] = residual_fg;
    capture_energy += static_cast<double>(capture[i]) * capture[i];
    estimated_energy += static_cast<double>(estimated_fg) * estimated_fg;
    bg_energy += static_cast<double>(residual_bg) * residual_bg;
    fg_energy += static_cast<double>(residual_fg) * residual_fg;
  }
  // Reject a corrupt estimate before RES, RNNoise and encoding. A block
  // bypass/reset, not hard clipping used as normal audio processing.
  bool bad_output = !std::isfinite(fg_energy) || fg_energy > std::max(capture_energy * 4.0, b * 1e-4);
  for (int i = 0; i < b; ++i)
    bad_output = bad_output || !std::isfinite(output[i]) ||
        std::abs(output[i]) > std::min(1.f, std::max(.02f, capture_peak * 2.f));
  if (bad_output) {
    ResetFilters();
    ++safety_events_;
    std::copy(capture, capture + b, output);
    return;
  }
  // A divergent shadow must not remain available for later promotion.
  if (!std::isfinite(bg_energy)) {
    std::copy(h_fg_.begin(), h_fg_.end(), h_bg_.begin());
    acc_capture_ = acc_bg_ = acc_fg_ = 0;
    erle_blocks_ = copy_hits_ = 0;
    ++safety_events_;
    ring_pos_ = (ring_pos_ + 1) % k;
    if (!reference_valid) std::copy(capture, capture + b, output);
    return;
  }
  for (int i = 0; i < n; ++i) e_bg_[i] = std::complex<float>(error_block_[i], 0.f);
  fft_.Forward(e_bg_.data());

  if (config_.residual_suppression && config_.double_path) {
    std::fill(e_fg_.begin(), e_fg_.end(), std::complex<float>{});
    for (int i = 0; i < b; ++i) e_fg_[n - b + i] = std::complex<float>(output[i], 0.f);
    fft_.Forward(e_fg_.data());
  }

  // Per-bin NLMS normalization.
  std::fill(power_.begin(), power_.end(), 0.f);
  for (int j = 0; j < k; ++j) {
    const int index = (ring_pos_ - j + k) % k;
    const std::complex<float>* xj = x_ring_.data() + static_cast<std::size_t>(index) * n;
    for (int i = 0; i < n; ++i) power_[i] += std::norm(xj[i]);
  }
  float reference_power = 0;
  for (int i = 0; i < n; ++i) reference_power += power_[i];
  // Freeze below -60 dBFS time-domain excitation. Regularize each bin
  // relative to broadband reference energy to avoid enormous weak-bin steps.
  const bool adapt = reference_valid && render_energy / b >= 1e-6;
  const float regularization = std::max(1e-3f, reference_power / n * .01f);

  // Soft double-talk detection from excess capture energy over the estimated
  // echo. Residual/capture is NOT a double-talk detector when the AEC is good:
  // it stays small even while the near-end is speaking. Excess energy is.
  float near_probability = 0.f;
  float instant_near = 0.f;
  if (reference_power > kMinReferencePower && capture_energy > 1e-6) {
    const double excess = capture_energy - estimated_energy;
    instant_near = excess > 0 ? static_cast<float>(std::sqrt(excess / capture_energy)) : 0.f;
    dtd_ratio_ = 0.7f * dtd_ratio_ + 0.3f * instant_near;
    near_probability =
        std::clamp((std::max(dtd_ratio_, instant_near) - 0.15f) / 0.35f, 0.f, 1.f);
  }
  // 300 ms hangover: near-end speech has syllable pauses. Without it the
  // suppressor closes during every pause and clips the next onset.
  if (instant_near > 0.35f) near_hold_ = 30;
  else if (near_hold_ > 0) --near_hold_;
  if (near_hold_ > 0) near_probability = 1.f;
  // After a filter reset the echo estimate is wrong for a while; that looks
  // exactly like near-end to the excess-energy detector. Let the linear filter
  // converge at full speed for 1 s before trusting double-talk detection.
  if (blocks_since_reset_ < 100) {
    near_probability = 0.f;
    dtd_ratio_ = 0.f;
    near_hold_ = 0;
  }
  const float mu_scale = (erle_db_ > 6.f && near_probability > 0.5f) ? 0.2f : 1.f;
  near_probability_ = near_probability;
  ++blocks_since_reset_;

  const float leak = 1.f - config_.leakage;
  for (int j = 0; adapt && j < k; ++j) {
    const int index = (ring_pos_ - j + k) % k;
    const std::complex<float>* xj = x_ring_.data() + static_cast<std::size_t>(index) * n;
    std::complex<float>* hj = h_bg_.data() + static_cast<std::size_t>(j) * n;
    for (int i = 0; i < n; ++i) {
      const float step = (config_.mu * mu_scale) / (power_[i] + regularization);
      hj[i] = (hj[i] + (std::conj(xj[i]) * e_bg_[i]) * step) * leak;
    }
  }

  if (adapt && config_.constrain) {
    for (int j = 0; j < k; ++j) {
      std::complex<float>* hj = h_bg_.data() + static_cast<std::size_t>(j) * n;
      std::copy(hj, hj + n, scratch_.begin());
      fft_.Inverse(scratch_.data());
      for (int i = 0; i < n; ++i)
        scratch_[i] = std::complex<float>(i < b ? scratch_[i].real() : 0.f, 0.f);
      fft_.Forward(scratch_.data());
      std::copy(scratch_.begin(), scratch_.end(), hj);
    }
  }
  // Bound shadow-path energy, not its instantaneous residual/capture ratio:
  // the latter explodes during normal speech pauses before convergence.
  double coefficient_energy = 0;
  for (const auto& coefficient : h_bg_) coefficient_energy += std::norm(coefficient) / n;
  if (!std::isfinite(coefficient_energy) || coefficient_energy > 64.0) {
    std::copy(h_fg_.begin(), h_fg_.end(), h_bg_.begin());
    acc_capture_ = acc_bg_ = acc_fg_ = 0;
    erle_blocks_ = copy_hits_ = 0;
    ++safety_events_;
    ring_pos_ = (ring_pos_ + 1) % k;
    return;
  }

  if (reference_valid && foreground_valid_ && config_.residual_suppression && config_.double_path) {
    const bool far_active = reference_power > kMinReferencePower;
    const bool learn_gamma = erle_db_ > 6.f && near_probability < 0.3f;
    res_->Process(e_fg_.data(), y_fg_.data(), far_active, learn_gamma, near_probability);
    std::copy(e_fg_.begin(), e_fg_.end(), ifft_out_.begin());
    fft_.Inverse(ifft_out_.data());
    for (int i = 0; i < b; ++i) output[i] = ifft_out_[n - b + i].real();
  }

  // Two-path promotion: only when the background filter clearly beats the
  // foreground and has actually cancelled something.
  if (config_.double_path && adapt && reference_power > kMinReferencePower && capture_energy > 1e-9) {
    acc_capture_ += capture_energy;
    acc_bg_ += bg_energy;
    acc_fg_ += fg_energy;
    ++erle_blocks_;
    if (erle_blocks_ >= kErleWindowBlocks) {
      const double erle_bg = 10 * std::log10(acc_capture_ / std::max(acc_bg_, 1e-20));
      const double erle_fg = 10 * std::log10(acc_capture_ / std::max(acc_fg_, 1e-20));
      erle_db_ = static_cast<float>(erle_fg);
      // A learned path may disappear (headphones, volume/route change). Do not
      // keep subtracting that old path forever just because a zero-echo shadow
      // cannot meet the positive-ERLE promotion threshold.
      if (foreground_valid_ && erle_fg < -.5) ++harmful_foreground_windows_;
      else harmful_foreground_windows_ = 0;
      if (harmful_foreground_windows_ >= 2) {
        ResetFilters();
        ++safety_events_;
        std::copy(capture, capture + b, output);
        return;
      }
      if (erle_bg > erle_fg + 1.0 && erle_bg > 6.0) ++copy_hits_;
      else copy_hits_ = 0;
      // Validate startup too; two consecutive good windows before promotion.
      if (copy_hits_ >= 2) {
        std::copy(h_bg_.begin(), h_bg_.end(), h_fg_.begin());
        foreground_valid_ = true;
        copy_hits_ = 0;
      }
      acc_capture_ = acc_bg_ = acc_fg_ = 0;
      erle_blocks_ = 0;
    }
  }

  if (!reference_valid) std::copy(capture, capture + b, output);
  double output_energy = 0;
  bool unsafe = false;
  for (int i = 0; i < b; ++i) {
    output_energy += static_cast<double>(output[i]) * output[i];
    unsafe = unsafe || !std::isfinite(output[i]) ||
        std::abs(output[i]) > std::min(1.f, std::max(.02f, capture_peak * 2.f));
  }
  if (unsafe || output_energy > std::max(capture_energy * 4.0, b * 1e-4)) {
    ResetFilters();
    ++safety_events_;
    std::copy(capture, capture + b, output);
    return;
  }
  ring_pos_ = (ring_pos_ + 1) % k;
}

}  // namespace darling::aec
