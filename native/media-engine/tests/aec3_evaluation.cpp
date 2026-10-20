#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>
#include <string_view>
#include "aec3_processor.h"

// Offline deterministic signals only. Never opens a device or records audio.
int evaluate(Aec3Processor& aec, bool echoEnabled, bool headphone = false) {
  constexpr int rate = 48000, block = 480, frames = 2000, delay = 4800;
  aec.reset(); // Control-thread operation; no active audio worker in this test.
  AudioFrame render, capture;
  std::vector<float> source(frames * block * 2);
  std::vector<float> output(frames * block);
  uint32_t seed = 1234567;
  float low = 0;
  for (auto& sample : source) {
    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
    low = 0.7f * low + 0.3f * (static_cast<float>(seed) / 4294967295.f * 2.f - 1.f);
    sample = low * 0.3f;
  }
  double inEnergy = 0, outEnergy = 0;
  std::vector<double> times;
  for (int f = 0; f < frames; ++f) {
    auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < block; ++i) {
      const int index = f * block + i;
      render.samples[i] = (echoEnabled || headphone) ? source[index] : 0.f;
      float echo = echoEnabled ? (index >= delay ? source[index - delay] * 0.6f : 0.f) : source[index + frames * block];
      if (echoEnabled && index >= delay + 720) echo += source[index - delay - 720] * 0.15f;
      capture.samples[i] = echo;
      if (f >= frames / 2) inEnergy += echo * echo;
    }
    aec.render(render);
    aec.capture(capture);
    for (int i = 0; i < block; ++i) {
      const float sample = capture.samples[i];
      output[f * block + i] = sample;
      if (!std::isfinite(sample) || std::abs(sample) > 1.01f) return 2;
      if (f >= frames / 2) outEnergy += sample * sample;
    }
    times.push_back(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count());
  }
  std::sort(times.begin(), times.end());
  const double erle = 10 * std::log10(inEnergy / std::max(outEnergy, 1e-20));
  double correlation = 0;
  if (!echoEnabled) {
    // Compare against independent near-end samples; compensate fixed algorithm
    // delay (up to 20 ms), but do not mistake energy preservation for fidelity.
    for (int lag = 0; lag <= 960; ++lag) {
      double xy = 0, xx = 0, yy = 0;
      for (int i = frames * block / 2; i < frames * block; i += 8) {
        const double x = source[frames * block + i - lag], y = output[i];
        xy += x*y; xx += x*x; yy += y*y;
      }
      correlation = std::max(correlation, xy / std::sqrt(std::max(xx*yy, 1e-30)));
    }
  }
  std::cout << (echoEnabled ? "synthetic_echo_attenuation_db=" : headphone ? "headphone_near_attenuation_db=" : "near_only_attenuation_db=") << erle
            << " near_correlation=" << correlation
            << " processing_p50_us=" << times[times.size()/2]
            << " processing_p95_us=" << times[times.size()*95/100] << '\n';
  // This is an algorithm smoke gate, not proof of double-talk or real-room quality.
  return (echoEnabled ? erle >= 15 : std::abs(erle) < 3 && correlation > 0.9) ? 0 : 3;
}

int evaluate_scenarios(bool diagnostic = false, bool modulated = false, bool linear = false, bool stable = false, bool bounded = false, bool trace = false, bool nearendMask = false, uint32_t seed = 3456789, float nearScale = 1.f, bool nonlinear = false, bool batch = false, bool weakNearend = false, const std::vector<float>* speechFar = nullptr, const std::vector<float>* speechNear = nullptr, int pathMode = 0, bool lowExcitation = false);
int evaluate_speech(const char* farPath, const char* nearPath, bool comparePaths, int gainDb = 0, bool lowExcitation = false);
int evaluate_batch(bool weakNearend = false);
int main(int argc, char** argv) {
  if (argc == 4 && (std::string_view(argv[1]) == "--speech-negative" || std::string_view(argv[1]) == "--speech-negative-mask")) {
    extern int evaluate_negative(const char*, const char*, bool);
    return evaluate_negative(argv[2], argv[3], std::string_view(argv[1]) == "--speech-negative-mask");
  }
  if (argc == 4 && std::string_view(argv[1]) == "--speech-low-excitation") return evaluate_speech(argv[2], argv[3], true, 0, true);
  if (argc == 4 && std::string_view(argv[1]) == "--speech-wav") return evaluate_speech(argv[2], argv[3], false);
  if (argc == 4 && std::string_view(argv[1]) == "--speech-paths") return evaluate_speech(argv[2], argv[3], true);
  if (argc == 4 && std::string_view(argv[1]) == "--speech-gain-12") return evaluate_speech(argv[2], argv[3], true, 12);
  if (argc == 4 && std::string_view(argv[1]) == "--speech-gain-24") return evaluate_speech(argv[2], argv[3], true, 24);
  if (argc == 2 && std::string_view(argv[1]) == "--batch") return evaluate_batch();
  if (argc == 2 && std::string_view(argv[1]) == "--batch-weak-nearend") return evaluate_batch(true);
  if (argc == 2 && std::string_view(argv[1]) == "--diagnose-nearend-snr") return evaluate_scenarios(true);
  if (argc == 2 && std::string_view(argv[1]) == "--diagnose-modulated-nearend") return evaluate_scenarios(false, true);
  if (argc == 2 && std::string_view(argv[1]) == "--diagnose-linear-output") return evaluate_scenarios(false, false, true);
  if (argc == 2 && std::string_view(argv[1]) == "--diagnose-stable-linear-path") return evaluate_scenarios(false, false, false, true);
  if (argc == 2 && std::string_view(argv[1]) == "--diagnose-bounded-residual") return evaluate_scenarios(false, false, false, false, true);
  if (argc == 2 && std::string_view(argv[1]) == "--diagnose-trace") return evaluate_scenarios(false, false, false, false, false, true);
  if (argc == 2 && std::string_view(argv[1]) == "--diagnose-nearend-mask") return evaluate_scenarios(false, false, false, false, false, true, true);
  if (argc != 1) return 64;
  Aec3Processor aec;
  if (const int error = evaluate(aec, true)) return error;
  if (const int error = evaluate(aec, false)) return error;
  if (const int error = evaluate(aec, false, true)) return error;
  // A new session must behave exactly as a newly constructed processor, not
  // inherit the old reference history, splitting filters or echo model.
  aec.reset(); Aec3Processor fresh;
  AudioFrame render, reused, cold;
  for (unsigned block = 0; block < 100; ++block) {
    for (unsigned i = 0; i < audio_block; ++i) {
      render.samples[i] = 0.1f * std::sin((block * audio_block + i) * 0.02f);
      reused.samples[i] = render.samples[i] * .5f;
    }
    reused.epoch = 42; reused.qpc100ns = 123456; reused.paddingFrames = 64; reused.timestampValid = true;
    cold = reused;
    aec.render(render); fresh.render(render); aec.capture(reused); fresh.capture(cold);
    if (reused.epoch != 42 || reused.qpc100ns != 123456 || reused.paddingFrames != 64 || !reused.timestampValid) return 4;
    for (unsigned i = 0; i < audio_block; ++i)
      if (std::abs(reused.samples[i] - cold.samples[i]) > 1e-7f) return 5;
  }
  std::cout << "reset_matches_fresh=true metadata_preserved=true\n";
  return evaluate_scenarios();
}
