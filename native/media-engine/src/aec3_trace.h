#pragma once
#include <cstdint>
namespace darling_aec_trace {
struct Stats {
  uint64_t blocks = 0, usable = 0, dominant = 0, saturated = 0;
  double nearPower = 0, residualPower = 0, amplitudeGain = 0;
  uint64_t delayKnown = 0, delayRefined = 0;
  uint64_t delaySum = 0, delayMin = UINT64_MAX, delayMax = 0;
  int filterDelayLast = 0, filterLengthLast = 0;
  uint64_t matchSamples = 0, lowEnergy = 0, matchSaturated = 0, eligible = 0;
  uint64_t filtersChecked = 0, filtersUpdated = 0, reliableUpdated = 0, winners = 0;
};
// Offline opt-in only; no PCM, file IO, allocations or cross-thread aggregation.
inline thread_local bool enabled = false;
inline thread_local Stats stats{};
}
