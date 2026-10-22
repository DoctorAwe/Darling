#pragma once

#include "fft.h"

#include <memory>
#include <vector>

namespace darling::aec {

struct DelayEstimatorConfig {
  int sample_rate = 48000;
  int block = 480;
  int window_ms = 250;
  int update_ms = 100;
  int max_delay_ms = 300;
  int confirmations = 2;
  float tolerance_ms = 2.f;
  float min_correlation = 0.15f;
};

// GCC-PHAT delay estimator with a confirmation counter.
//
// The reference is what the peer plays; the microphone contains that signal
// delayed by the acoustic round trip plus device latencies. The estimator
// returns the microphone lag in samples (positive = microphone lags reference).
class DelayEstimator {
 public:
  explicit DelayEstimator(const DelayEstimatorConfig& config = {});

  void Reset();

  // Feed one block. Returns true when a new stable delay has been committed
  // (including the first commit), so the caller can realign the filter.
  bool Push(const float* render, const float* capture, int block);

  int delay_samples() const { return committed_; }
  int candidate_samples() const { return candidate_; }
  float confidence() const { return confidence_; }

 private:
  bool Update();

  DelayEstimatorConfig config_;
  int window_;
  int max_delay_;
  int mic_size_;
  int fft_size_;
  int update_blocks_;
  int tolerance_;
  std::unique_ptr<ComplexFft> fft_;

  std::vector<float> ref_;
  std::vector<float> mic_;
  std::vector<std::complex<float>> ref_fft_;
  std::vector<std::complex<float>> mic_fft_;
  std::vector<std::complex<float>> cross_;

  int filled_ = 0;
  int since_update_ = 0;
  int candidate_ = 0;
  int committed_ = 0;
  int stable_ = 0;
  float confidence_ = 0.f;
};

}  // namespace darling::aec
