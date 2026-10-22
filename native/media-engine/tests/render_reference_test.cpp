#include "../../rtc-smoke/render_reference_queue.h"
#include <array>
#include <atomic>
#include <cstdio>
#include <thread>

int main() {
  darling::RenderReferenceQueue queue;
  std::array<float, 480> input{}, output{};
  if (queue.Pop(output.data())) return 1;
  for (int block = 0; block < 16; ++block) {
    input.fill(static_cast<float>(block));
    if (!queue.Push(input.data())) return 2;
  }
  input.fill(999.f);
  if (queue.Push(input.data()) || queue.discontinuities() != 1) return 3;
  for (int block = 0; block < 16; ++block) {
    if (!queue.Pop(output.data())) return 4;
    for (auto v : output) if (v != block) return 5;
  }
  queue.Push(input.data());
  queue.Discard();
  if (queue.Pop(output.data())) return 6;
  std::atomic<bool> done{false};
  std::thread producer([&] {
    std::array<float, 480> frame{};
    for (int block = 1; block <= 50000; ++block) {
      frame.fill(static_cast<float>(block));
      while (!queue.Push(frame.data())) std::this_thread::yield();
    }
    done.store(true);
  });
  int received = 0, error = 0;
  for (;;) {
    if (queue.Pop(output.data())) {
      ++received;
      for (auto value : output) if (value != received) error = 7;
    } else if (done.load()) {
      // A producer may have published after the first empty check.
      if (!queue.Pop(output.data())) break;
      ++received;
      for (auto value : output) if (value != received) error = 8;
    } else std::this_thread::yield();
  }
  producer.join();
  if (received != 50000 || error) return 9;
  queue.Discard();
  input.fill(1); queue.Push(input.data());
  if (!queue.PopAligned(output.data()) || output[0] != 1) return 10;
  if (queue.PopAligned(output.data())) return 11;
  input.fill(2); queue.Push(input.data());
  input.fill(3); queue.Push(input.data());
  if (!queue.PopAligned(output.data()) || output[0] != 3) return 12;
  input.fill(4); queue.Push(input.data());
  if (!queue.PopAligned(output.data()) || output[0] != 4) return 13;
  std::puts("RENDER_REFERENCE_OK: full queue, discard, 50000 concurrent frames");
  return 0;
}
