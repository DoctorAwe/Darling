#pragma once

#include "fft.h"
#include "residual_suppressor.h"

#include <memory>
#include <cstdint>
#include <vector>

namespace darling::aec {

struct LinearAecConfig {
  int block = 480;            // 10 ms at 48 kHz
  int fft = 1024;             // >= 2*block - 1
  int partitions = 8;         // 80 ms residual path after bulk-delay alignment
  float mu = 0.8f;            // NLMS step size
  float leakage = 1e-5f;      // per-block coefficient leakage
  bool constrain = true;      // per-partition impulse-response constraint
  bool double_path = true;    // foreground/background filters
  bool residual_suppression = true;
  int max_delay_samples = 14400;  // 300 ms bulk-delay range
};

// Partitioned block frequency-domain adaptive filter (PBFDAF) with an optional
// bulk delay, a two-path (foreground/background) structure, and a spectral
// residual echo suppressor.
class LinearAec {
 public:
  explicit LinearAec(const LinearAecConfig& config = {});

  void Reset();
  void SetBulkDelay(int samples);
  int bulk_delay() const { return bulk_delay_; }
  float erle_db() const { return erle_db_; }
  float mean_res_gain() const { return res_ ? res_->mean_gain() : 1.f; }
  float mean_gamma() const { return res_ ? res_->mean_gamma() : 0.f; }
  float dtd_ratio() const { return dtd_ratio_; }
  float near_probability() const { return near_probability_; }
  uint64_t safety_events() const { return safety_events_; }

  void Process(const float* render, const float* capture, float* output, bool reference_valid = true);

  const LinearAecConfig& config() const { return config_; }

 private:
  void ResetFilters();

  LinearAecConfig config_;
  int block_;
  int fft_size_;
  int partitions_;
  int max_delay_;
  int history_capacity_;
  ComplexFft fft_;

  std::vector<std::complex<float>> x_ring_;   // partitions * fft
  std::vector<std::complex<float>> h_bg_;     // partitions * fft
  std::vector<std::complex<float>> h_fg_;     // partitions * fft
  std::vector<std::complex<float>> y_bg_;     // fft
  std::vector<std::complex<float>> y_fg_;     // fft
  std::vector<std::complex<float>> ifft_bg_;  // fft
  std::vector<std::complex<float>> ifft_fg_;  // fft
  std::vector<std::complex<float>> e_bg_;     // fft
  std::vector<std::complex<float>> e_fg_;     // fft
  std::vector<std::complex<float>> ifft_out_; // fft
  std::vector<std::complex<float>> scratch_;  // fft
  std::vector<float> power_;                  // fft, per-bin reference power
  std::vector<float> block_buffer_;           // fft
  std::vector<float> error_block_;            // fft
  std::vector<float> delayed_;                // block
  std::vector<float> render_history_;         // ring

  std::unique_ptr<ResidualSuppressor> res_;

  int ring_pos_ = 0;
  int history_write_ = 0;
  int bulk_delay_ = 0;
  bool primed_ = false;

  double acc_capture_ = 0;
  double acc_bg_ = 0;
  double acc_fg_ = 0;
  int erle_blocks_ = 0;
  int copy_hits_ = 0;
  int harmful_foreground_windows_ = 0;
  bool foreground_valid_ = false;
  float erle_db_ = 0.f;
  float dtd_ratio_ = 0.f;
  float near_probability_ = 0.f;
  int near_hold_ = 0;
  int blocks_since_reset_ = 0;
  uint64_t safety_events_ = 0;
};

}  // namespace darling::aec
