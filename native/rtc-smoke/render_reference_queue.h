#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>

namespace darling {
// Bounded SPSC queue. Only the consumer advances read_; the producer never
// overwrites an occupied slot. An overflow invalidates alignment, not memory.
class RenderReferenceQueue {
 public:
  static constexpr int kBlock = 480;
  static constexpr uint32_t kBlocks = 16;
  bool Push(const float* input) {
    const auto sequence = produced_++;
    const auto write = write_.load(std::memory_order_relaxed);
    if (write - read_.load(std::memory_order_acquire) == kBlocks) {
      Invalidate();
      return false;
    }
    std::memcpy(ring_[write % kBlocks].data(), input, kBlock * sizeof(float));
    sequence_[write % kBlocks] = sequence;
    write_.store(write + 1, std::memory_order_release);
    return true;
  }
  bool Pop(float* output) {
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == write_.load(std::memory_order_acquire)) return false;
    std::memcpy(output, ring_[read % kBlocks].data(), kBlock * sizeof(float));
    read_.store(read + 1, std::memory_order_release);
    return true;
  }
  // One call per capture interval. Late render blocks must not shift every
  // subsequent reference backward after an underrun.
  bool PopAligned(float* output) {
    for (;;) {
      const auto read = read_.load(std::memory_order_relaxed);
      if (read == write_.load(std::memory_order_acquire)) {
        if (aligned_) ++expected_;
        return false;
      }
      const auto sequence = sequence_[read % kBlocks];
      if (!aligned_) { expected_ = sequence; aligned_ = true; }
      if (sequence < expected_) {
        read_.store(read + 1, std::memory_order_release);
        continue;
      }
      if (sequence > expected_) { ++expected_; return false; }
      ++expected_;
      return Pop(output);
    }
  }
  // Consumer only. Producer may continue publishing into newly freed slots.
  void Discard() {
    read_.store(write_.load(std::memory_order_acquire), std::memory_order_release);
    aligned_ = false;
  }
  void Invalidate() { discontinuities_.fetch_add(1, std::memory_order_relaxed); }
  uint64_t discontinuities() const { return discontinuities_.load(std::memory_order_relaxed); }
 private:
  std::array<std::array<float, kBlock>, kBlocks> ring_{};
  std::atomic<uint32_t> write_{0}, read_{0};
  std::atomic<uint64_t> discontinuities_{0};
  std::array<uint64_t, kBlocks> sequence_{};
  uint64_t produced_ = 0;  // producer only
  uint64_t expected_ = 0;  // consumer only
  bool aligned_ = false;  // consumer only
};
}  // namespace darling
