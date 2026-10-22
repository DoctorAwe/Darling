#pragma once

#include "aec_fail.h"

#include <cmath>
#include <complex>
#include <cstddef>
#include <stdexcept>
#include <utility>
#include <vector>

namespace darling::aec {

// Iterative radix-2 complex FFT with precomputed twiddles.
// Unnormalized forward, 1/N-scaled inverse. Sizes must be a power of two.
class ComplexFft {
 public:
  explicit ComplexFft(std::size_t size) : size_(size) {
    if (size < 2 || (size & (size - 1)) != 0)
      darling::aec::Fail("FFT size must be a power of two");
    std::size_t bits = 0;
    while ((std::size_t{1} << bits) < size) ++bits;
    bitrev_.resize(size);
    for (std::size_t i = 0; i < size; ++i) {
      std::size_t reversed = 0;
      for (std::size_t b = 0; b < bits; ++b)
        if (i & (std::size_t{1} << b)) reversed |= std::size_t{1} << (bits - 1 - b);
      bitrev_[i] = reversed;
    }
    constexpr double kTwoPi = 6.283185307179586476925286766559;
    twiddle_.resize(size / 2);
    for (std::size_t k = 0; k < size / 2; ++k) {
      const double angle = -kTwoPi * static_cast<double>(k) / static_cast<double>(size);
      twiddle_[k] = std::complex<float>(static_cast<float>(std::cos(angle)),
                                        static_cast<float>(std::sin(angle)));
    }
  }

  std::size_t size() const { return size_; }

  void Forward(std::complex<float>* data) const { Transform(data, false); }
  void Inverse(std::complex<float>* data) const { Transform(data, true); }

 private:
  void Transform(std::complex<float>* data, bool inverse) const {
    for (std::size_t i = 0; i < size_; ++i)
      if (i < bitrev_[i]) std::swap(data[i], data[bitrev_[i]]);
    for (std::size_t len = 2; len <= size_; len <<= 1) {
      const std::size_t half = len / 2;
      const std::size_t step = size_ / len;
      for (std::size_t i = 0; i < size_; i += len) {
        for (std::size_t j = 0; j < half; ++j) {
          const std::complex<float> w =
              inverse ? std::conj(twiddle_[j * step]) : twiddle_[j * step];
          const std::complex<float> u = data[i + j];
          const std::complex<float> v = data[i + j + half] * w;
          data[i + j] = u + v;
          data[i + j + half] = u - v;
        }
      }
    }
    if (inverse) {
      const float scale = 1.f / static_cast<float>(size_);
      for (std::size_t i = 0; i < size_; ++i) data[i] *= scale;
    }
  }

  std::size_t size_;
  std::vector<std::size_t> bitrev_;
  std::vector<std::complex<float>> twiddle_;
};

}  // namespace darling::aec
