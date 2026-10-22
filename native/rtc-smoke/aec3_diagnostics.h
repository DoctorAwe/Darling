#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include "modules/audio_processing/aec3/aec3_common.h"

namespace webrtc::darling_aec3_diagnostics {
struct Stats {
  uint64_t blocks=0, dominant=0, usable_linear=0;
  double nearend_power_sum=0, residual_power_sum=0, unbounded_power_sum=0, gain_sum=0;
  double dominant_gain_sum=0, normal_gain_sum=0;
  uint64_t dominant_gain_count=0, normal_gain_count=0;
  std::array<uint64_t,101> gain_histogram{};
};
inline bool enabled=false;
inline Stats stats{};
inline void Reset() { stats=Stats{}; }
inline void Enable(bool value) { enabled=value; }
inline void Record(bool dominant, bool usable,
    const std::array<float,kFftLengthBy2Plus1>& nearend,
    const std::array<float,kFftLengthBy2Plus1>& residual,
    const std::array<float,kFftLengthBy2Plus1>& unbounded,
    const std::array<float,kFftLengthBy2Plus1>& gain) {
  if(!enabled) return;
  double n=0,r=0,u=0,g=0;
  for(size_t k=1;k<16;++k){n+=nearend[k];r+=residual[k];u+=unbounded[k];g+=gain[k];}
  g/=15.;
  ++stats.blocks; stats.dominant+=dominant; stats.usable_linear+=usable;
  stats.nearend_power_sum+=n; stats.residual_power_sum+=r; stats.unbounded_power_sum+=u;
  stats.gain_sum+=g;
  if(dominant){stats.dominant_gain_sum+=g;++stats.dominant_gain_count;}
  else {stats.normal_gain_sum+=g;++stats.normal_gain_count;}
  ++stats.gain_histogram[std::clamp(static_cast<int>(std::lround(g*100)),0,100)];
}
inline double GainPercentile(double q) {
  if(!stats.blocks) return 0;
  const uint64_t target=static_cast<uint64_t>(std::ceil(q*stats.blocks));
  uint64_t n=0;for(size_t i=0;i<stats.gain_histogram.size();++i){n+=stats.gain_histogram[i];if(n>=target)return i/100.;}
  return 1;
}
}  // namespace webrtc::darling_aec3_diagnostics
