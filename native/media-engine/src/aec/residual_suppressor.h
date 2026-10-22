#pragma once

#include <complex>
#include <vector>

namespace darling::aec {

struct ResidualSuppressorConfig {
  int fft = 1024;
  float initial_gamma = 0.5f;      // conservative before the first learning window
  float gamma_min = 1e-4f;
  float gamma_max = 1.f;
  float gamma_smoothing = 0.01f;   // per block, ~1 s at 10 ms blocks
  float gain_floor_db = -18.f;
  float gain_floor_hf_db = -30.f;
  float attack = 0.6f;             // gain decreasing (suppress fast)
  float release = 0.1f;            // gain increasing (open slowly)
  float near_protection = 4.f;     // |E|^2 > 4*I means near-end dominates
};

// Spectral residual echo suppressor.
//
// The linear AEC provides the residual spectrum E and the echo estimate Y.
// During single-talk (far-end active, foreground ERLE already good) the
// leakage factor gamma[k] = |E|^2 / |Y|^2 is learned per bin. During any
// period the residual echo PSD is modelled as gamma[k] * |Y|^2, and a Wiener
// gain removes it while leaving near-end speech untouched.
class ResidualSuppressor {
 public:
  explicit ResidualSuppressor(const ResidualSuppressorConfig& config = {});

  void Reset();

  // Modifies `residual` in place. `echo` is the foreground echo estimate.
  // `far_active` gates all suppression; `learn_gamma` allows updating gamma.
  // `near_probability` in [0,1] blends the gain back to unity during
  // double-talk, protecting near-end speech at the cost of some residual echo.
  void Process(std::complex<float>* residual, const std::complex<float>* echo,
               bool far_active, bool learn_gamma, float near_probability);

  float mean_gain() const { return mean_gain_; }
  float mean_gamma() const;

 private:
  ResidualSuppressorConfig config_;
  int bins_;
  int hf_bin_;
  std::vector<float> gamma_;
  std::vector<float> gain_;
  std::vector<float> previous_;
  std::vector<float> smoothed_;
  float mean_gain_ = 1.f;
};

}  // namespace darling::aec
