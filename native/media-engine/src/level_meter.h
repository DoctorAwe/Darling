#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

struct Levels { double peak = 0; double rms = 0; uint64_t clipped = 0; };
// Packed little-endian PCM (valid bits left aligned) or IEEE float32.
// No heap allocation; input remains owned by WASAPI.
inline Levels measure_levels(const unsigned char* data, size_t samples, unsigned bits, bool floating, bool silent) {
  Levels result;
  if (silent || !data || !samples) return result;
  double sum = 0;
  for (size_t i = 0; i < samples; ++i) {
    const auto* p = data + i * (bits / 8);
    double value = 0;
    if (floating) { float sample; std::memcpy(&sample, p, 4); value = std::isfinite(sample) ? sample : 0; }
    else if (bits == 16) { int16_t sample; std::memcpy(&sample, p, 2); value = sample / 32768.0; }
    else if (bits == 24) {
      int32_t sample = p[0] | (p[1] << 8) | (p[2] << 16);
      if (sample & 0x800000) sample -= 0x1000000;
      value = sample / 8388608.0;
    } else if (bits == 32) { int32_t sample; std::memcpy(&sample, p, 4); value = sample / 2147483648.0; }
    const auto magnitude = std::abs(value);
    if (magnitude >= 0.999) ++result.clipped;
    result.peak = std::max(result.peak, magnitude); sum += value * value;
  }
  result.rms = std::sqrt(sum / samples); return result;
}
