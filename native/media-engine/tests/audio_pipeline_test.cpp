#include "audio_pipeline.h"
#include "render_timeline.h"
#include <iostream>
#include <stdexcept>
#include <thread>
void expect(bool condition) { if (!condition) throw std::runtime_error("Audio pipeline test failed"); }
struct CountingProcessor : AudioProcessor {
  unsigned renders = 0, captures = 0;
  void render(const AudioFrame&) noexcept override { ++renders; }
  void capture(AudioFrame& frame) noexcept override { ++captures; for (auto& sample : frame.samples) sample *= 0.5f; }
};
int main() {
  try {
    FrameAssembler assembler; unsigned blocks = 0;
    for (unsigned i = 0; i < 1000; ++i) assembler.push(static_cast<float>(i), i * 10000000ull / 48000, true, 1, 0,
      [&](AudioFrame& frame) { expect(frame.samples[0] == blocks * 480.f); expect(frame.samples[479] == blocks * 480.f + 479); ++blocks; });
    expect(blocks == 2); assembler.reset();
    for (unsigned i = 0; i < 480; ++i) assembler.push(0.5f, 0, true, 2, 0, [&](const AudioFrame& frame) { expect(frame.samples[0] == .5f && frame.epoch == 2); ++blocks; });
    expect(blocks == 3);
    CountingProcessor switchProcessor;
    AudioPipeline switchable;
    AudioFrame unchanged; unchanged.samples.fill(.75f);
    switchable.select_processor(&switchProcessor, "aec3-experimental");
    auto processed=unchanged; switchable.capture(processed);
    expect(processed.samples[0]==.375f && switchProcessor.captures==1);
    switchable.render(unchanged);
    switchable.select_processor(nullptr, "ignored");
    expect(std::string(switchable.mode())=="bypass" && switchable.capturedBlocks==0 && switchable.renderedBlocks==0);
    processed=unchanged; switchable.capture(processed);
    expect(processed.samples==unchanged.samples && switchProcessor.captures==1 && switchable.consumedReferences==0);
    ReferenceQueue bounded; AudioFrame source; source.samples.fill(.25f);
    for (unsigned i = 0; i < 64; ++i) { source.epoch = i; expect(bounded.push(source)); }
    expect(!bounded.push(source));
    AudioFrame result;
    for (unsigned i = 0; i < 64; ++i) { expect(bounded.pop(result)); expect(result.epoch == i && result.samples[479] == .25f); }
    expect(!bounded.pop(result));
    AudioPipeline pipeline; source.epoch = pipeline.new_render_epoch(); source.qpc100ns = 100; source.timestampValid = true;
    pipeline.render(source); AudioFrame capture; capture.qpc100ns = 100; capture.timestampValid = true; capture.samples.fill(.75f);
    pipeline.capture(capture); expect(pipeline.consumedReferences == 1 && capture.samples[0] == .75f);
    pipeline.render(source); pipeline.new_render_epoch(); pipeline.capture(capture); expect(pipeline.staleReferences == 1);
    source.epoch = pipeline.epoch; pipeline.render(source); capture.qpc100ns = 6000000; pipeline.capture(capture); expect(pipeline.staleReferences == 2);
    // Startup/partial playback cannot publish even if PCM was submitted earlier.
    RenderTimeline timeline; unsigned emitted = 0; AudioFrame staged; staged.epoch = 7;
    expect(timeline.submit(staged)); staged.streamFrame = 480; expect(timeline.submit(staged));
    auto receive = [&](const AudioFrame& frame) {
      expect(frame.timestampValid && frame.epoch == 7);
      expect(frame.qpc100ns == 1000000 + emitted * 100000);
      ++emitted;
    };
    expect(!timeline.advance(0, 48000, 1000000, receive)); expect(emitted == 0);
    expect(!timeline.advance(1, 0, 1000000, receive));
    expect(timeline.advance(240, 48000, 1050000, receive)); expect(emitted == 0);
    expect(timeline.advance(480, 48000, 1100000, receive)); expect(emitted == 1);
    expect(!timeline.advance(479, 48000, 1100001, receive));
    expect(!timeline.advance(960, 48000, 1099999, receive));
    // Frequency need not equal client sample rate (e.g. byte-based clock units).
    expect(timeline.advance(3840, 192000, 1200000, receive)); expect(emitted == 2 && timeline.empty());
    RenderTimeline backlog;
    for (unsigned i = 0; i < 64; ++i) { staged.streamFrame = i * audio_block; expect(backlog.submit(staged)); }
    expect(!backlog.submit(staged));
    AudioPipeline paced; AudioFrame timed; timed.timestampValid = true; timed.epoch = paced.new_render_epoch();
    timed.qpc100ns = 1000000;
    for (unsigned i = 0; i < 4; ++i) { timed.qpc100ns += 100000; paced.render(timed); }
    AudioFrame mic; mic.timestampValid = true; mic.qpc100ns = 1000000;
    paced.capture(mic); expect(paced.consumedReferences == 0); // all future
    mic.qpc100ns = 1400000; mic.timestampValid = false;
    paced.capture(mic); expect(paced.consumedReferences == 0); // invalid capture clock
    mic.timestampValid = true; paced.capture(mic); expect(paced.consumedReferences == 2);
    paced.capture(mic); expect(paced.consumedReferences == 4);
    timed.qpc100ns = 9999999; paced.render(timed); paced.new_render_epoch();
    paced.capture(mic); expect(paced.staleReferences == 1); // discard old future head
    CountingProcessor custom; AudioPipeline injected(&custom, "test");
    timed.epoch = injected.new_render_epoch(); timed.qpc100ns = 100;
    injected.render(timed); mic.qpc100ns = 100; mic.samples.fill(.5f);
    injected.capture(mic);
    expect(custom.renders == 1 && custom.captures == 1 && mic.samples[0] == .25f && injected.processedRms == .25);
    injected.render(timed); injected.begin_session();
    expect(injected.capturedBlocks == 0 && injected.consumedReferences == 0 && injected.processedRms == 0);
    injected.capture(mic); expect(custom.renders == 1); // old queued data flushed while workers stopped
    // Concurrent producer/consumer checks sample integrity and ordering across index wraps.
    ReferenceQueue concurrent; std::atomic<bool> valid{true};
    std::thread producer([&] { for (unsigned i = 0; i < 10000; ++i) { AudioFrame frame; frame.epoch = i; frame.samples.fill(static_cast<float>(i)); while (!concurrent.push(frame)) std::this_thread::yield(); } });
    for (unsigned i = 0; i < 10000; ++i) { AudioFrame frame; while (!concurrent.pop(frame)) std::this_thread::yield(); if (frame.epoch != i || frame.samples[479] != i) valid = false; }
    producer.join(); expect(valid);
    std::cout << "PASS: framing, bypass, SPSC, clock anchoring, startup staging, bounded catch-up, future/invalid/stale gating\n";
  } catch (const std::exception& error) { std::cerr << error.what(); return 1; }
}
