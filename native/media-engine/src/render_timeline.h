#pragma once
#include "audio_pipeline.h"
#include <limits>

// Playback-thread-only staging. No reference is released until the output clock
// confirms its entire 10 ms block has advanced through the endpoint.
class RenderTimeline {
  ReferenceQueue pending_;
  uint64_t lastPosition_ = 0, lastQpc_ = 0;
public:
  bool submit(const AudioFrame& frame) { return pending_.push(frame); }
  bool empty() const { AudioFrame frame; return !pending_.peek(frame); }
  template<class Sink>
  bool advance(uint64_t position, uint64_t frequency, uint64_t qpc, Sink&& sink) {
    if (!frequency || !position || !qpc) return false; // Startup position zero is not an anchor.
    if (position < lastPosition_ || qpc < lastQpc_) return false;
    lastPosition_ = position; lastQpc_ = qpc;
    const long double played = static_cast<long double>(position) * audio_rate / frequency;
    AudioFrame frame;
    for (unsigned i = 0; i < 64 && pending_.peek(frame); ++i) {
      if (static_cast<long double>(frame.streamFrame) + audio_block > played) break;
      const long double timestamp = static_cast<long double>(qpc) +
        (static_cast<long double>(frame.streamFrame) - played) * 10000000.0L / audio_rate;
      if (timestamp < 0 || timestamp > static_cast<long double>(std::numeric_limits<uint64_t>::max())) return false;
      pending_.pop(frame);
      frame.qpc100ns = static_cast<uint64_t>(timestamp);
      frame.timestampValid = true;
      sink(frame);
    }
    return true;
  }
};
