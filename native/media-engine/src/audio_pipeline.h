#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <cmath>

constexpr unsigned audio_rate = 48000;
constexpr unsigned audio_block = 480;
struct AudioFrame {
  std::array<float, audio_block> samples{};
  uint64_t qpc100ns = 0; // Capture timestamp, or render first-sample time estimated from IAudioClock.
  uint64_t streamFrame = 0; // Render first-sample offset in the 48 kHz client stream.
  uint64_t epoch = 0;
  unsigned paddingFrames = 0;
  bool timestampValid = false;
};
class FrameAssembler {
  AudioFrame frame_{};
  unsigned used_ = 0;
public:
  void reset() { used_ = 0; }
  template<class Sink>
  void push(float value, uint64_t timestamp, bool valid, uint64_t epoch, unsigned padding, Sink&& sink) {
    if (used_ == 0) { frame_.qpc100ns = timestamp; frame_.timestampValid = valid; frame_.epoch = epoch; frame_.paddingFrames = padding; }
    frame_.samples[used_++] = std::isfinite(value) ? value : 0.f;
    if (used_ == audio_block) { sink(frame_); used_ = 0; }
  }
};
// Exactly one render producer and one capture consumer. Never reset indices while active.
class ReferenceQueue {
  std::array<AudioFrame, 65> frames_{};
  std::atomic<unsigned> write_{0}, read_{0};
public:
  // Consumer-only peek. Producer cannot overwrite this slot until pop releases it.
  bool peek(AudioFrame& frame) const {
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == write_.load(std::memory_order_acquire)) return false;
    frame = frames_[read]; return true;
  }
  bool push(const AudioFrame& frame) {
    const auto write = write_.load(std::memory_order_relaxed);
    const auto next = (write + 1) % frames_.size();
    if (next == read_.load(std::memory_order_acquire)) return false;
    frames_[write] = frame; write_.store(static_cast<unsigned>(next), std::memory_order_release); return true;
  }
  bool pop(AudioFrame& frame) {
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == write_.load(std::memory_order_acquire)) return false;
    frame = frames_[read]; read_.store((read + 1) % frames_.size(), std::memory_order_release); return true;
  }
};
class AudioProcessor {
public:
  virtual ~AudioProcessor() = default;
  virtual void render(const AudioFrame&) noexcept = 0;
  virtual void capture(AudioFrame&) noexcept = 0;
};
// Explicit bypass until a verified AEC/NS implementation is linked.
class BypassProcessor final : public AudioProcessor {
public:
  void render(const AudioFrame&) noexcept override {}
  void capture(AudioFrame&) noexcept override {}
};
class AudioPipeline {
  ReferenceQueue references_;
  BypassProcessor bypass_;
  AudioProcessor* processor_;
  const char* mode_;
public:
  explicit AudioPipeline(AudioProcessor* processor = nullptr, const char* mode = "bypass")
    : processor_(processor ? processor : &bypass_), mode_(mode) {}
  const char* mode() const { return mode_; }
  // Control thread only, after BOTH audio workers have stopped and joined.
  void select_processor(AudioProcessor* processor, const char* mode) {
    processor_ = processor ? processor : &bypass_;
    mode_ = processor ? mode : "bypass";
    begin_session();
  }
  std::atomic<double> processedRms{0};
  // Both producer and consumer MUST be stopped/joined before this call.
  void begin_session() {
    AudioFrame discarded; while (references_.pop(discarded)) {}
    ++epoch; capturedBlocks = 0; renderedBlocks = 0; consumedReferences = 0;
    droppedReferences = 0; staleReferences = 0; processedRms = 0;
  }
  std::atomic<uint64_t> epoch{0}, capturedBlocks{0}, renderedBlocks{0}, consumedReferences{0}, droppedReferences{0}, staleReferences{0};
  uint64_t new_render_epoch() { return ++epoch; }
  void render(const AudioFrame& frame) {
    ++renderedBlocks;
    if (!references_.push(frame)) ++droppedReferences;
  }
  void capture(AudioFrame& frame) {
    AudioFrame reference;
    // Do not consume future references or references against an invalid capture clock.
    // At most two valid render blocks per capture block (bounded catch-up).
    unsigned delivered = 0;
    if (frame.timestampValid) {
    for (unsigned i = 0; i < 64 && references_.peek(reference); ++i) {
      if (reference.epoch != epoch.load() || !reference.timestampValid ||
          (frame.qpc100ns > reference.qpc100ns && frame.qpc100ns - reference.qpc100ns > 5000000)) {
        references_.pop(reference); ++staleReferences; continue;
      }
      if (reference.qpc100ns > frame.qpc100ns || delivered == 2) break;
      references_.pop(reference); processor_->render(reference); ++consumedReferences; ++delivered;
    }
    }
    processor_->capture(frame); ++capturedBlocks;
    double energy = 0;
    for (const float sample : frame.samples) energy += static_cast<double>(sample) * sample;
    processedRms = std::sqrt(energy / audio_block);
  }
};
