#include "level_meter.h"
#include <array>
#include <iostream>
#include <limits>
#include <stdexcept>
void expect(bool condition) { if (!condition) throw std::runtime_error("Level meter assertion failed"); }
int main() {
  try {
    const std::array<float, 4> floats{0.5f, -0.5f, 0.5f, -0.5f};
    auto value = measure_levels(reinterpret_cast<const unsigned char*>(floats.data()), floats.size(), 32, true, false);
    expect(std::abs(value.peak - 0.5) < 1e-6 && std::abs(value.rms - 0.5) < 1e-6 && value.clipped == 0);
    const std::array<int16_t, 2> pcm16{-32768, 16384};
    value = measure_levels(reinterpret_cast<const unsigned char*>(pcm16.data()), pcm16.size(), 16, false, false);
    expect(value.peak == 1 && value.clipped == 1 && std::abs(value.rms - std::sqrt(0.625)) < 1e-6);
    const std::array<unsigned char, 6> pcm24{0, 0, 0x80, 0, 0, 0x40};
    value = measure_levels(pcm24.data(), 2, 24, false, false);
    expect(value.peak == 1 && std::abs(value.rms - std::sqrt(0.625)) < 1e-6);
    const std::array<int32_t, 2> pcm32{INT32_MIN, 1073741824};
    value = measure_levels(reinterpret_cast<const unsigned char*>(pcm32.data()), 2, 32, false, false);
    expect(value.peak == 1 && std::abs(value.rms - std::sqrt(0.625)) < 1e-6);
    value = measure_levels(nullptr, 1024, 32, true, true); expect(value.peak == 0 && value.rms == 0);
    const float invalid = std::numeric_limits<float>::quiet_NaN();
    value = measure_levels(reinterpret_cast<const unsigned char*>(&invalid), 1, 32, true, false);
    expect(value.peak == 0 && value.rms == 0);
    std::cout << "PASS: float, PCM16/24/32, clipping, silent packet, nonfinite sample\n";
  } catch (const std::exception& error) { std::cerr << error.what(); return 1; }
}
