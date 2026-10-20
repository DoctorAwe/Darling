// Offline 48 kHz mono float32 files only. Never opens audio devices or network.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <vector>
#include "api/audio/builtin_audio_processing_builder.h"
#include "api/environment/environment_factory.h"
#include "rnnoise_processing.h"

int main(int argc, char** argv) {
  if (argc != 4 && argc != 5) return 2;
  const int rate = argc == 5 ? std::atoi(argv[4]) : 48000;
  if (rate != 16000 && rate != 32000 && rate != 48000) return 2;
  const std::string mode = argv[1];
  if (mode != "rnnoise" && mode != "webrtc") return 2;
  std::ifstream input(argv[2], std::ios::binary);
  std::ofstream output(argv[3], std::ios::binary | std::ios::trunc);
  if (!input || !output) return 3;
  webrtc::AudioProcessing::Config config;
  config.echo_canceller.enabled = false;
  config.noise_suppression.enabled = mode == "webrtc";
  config.high_pass_filter.enabled = false;
  config.gain_controller1.enabled = false;
  config.gain_controller2.enabled = false;
  auto metrics = std::make_shared<RnnoiseMetrics>();
  webrtc::BuiltinAudioProcessingBuilder builder(config);
  if (mode == "rnnoise") builder.SetCapturePostProcessing(std::make_unique<RnnoiseProcessing>(metrics));
  auto apm = builder.Build(webrtc::CreateEnvironment());
  if (!apm) return 4;
  const webrtc::StreamConfig format(rate, 1);
  std::vector<float> in(rate/100), out(rate/100);
  const auto block_bytes = in.size()*sizeof(float);
  const float* inputs[] = {in.data()};
  float* outputs[] = {out.data()};
  std::vector<double> timings;
  while (input.read(reinterpret_cast<char*>(in.data()), block_bytes)) {
    for (float v : in) if (!std::isfinite(v) || std::abs(v) > 1) return 5;
    auto start = std::chrono::steady_clock::now();
    if (apm->ProcessStream(inputs, format, format, outputs) != 0) return 6;
    timings.push_back(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now()-start).count());
    for (float v : out) if (!std::isfinite(v) || std::abs(v) > 1) return 7;
    output.write(reinterpret_cast<const char*>(out.data()), block_bytes);
  }
  if (input.gcount() != 0 || timings.empty() || !output) return 8;
  if (mode == "rnnoise" && metrics->frames != timings.size()) return 9;
  double total = 0; for (double value : timings) total += value;
  std::sort(timings.begin(), timings.end());
  std::printf("{\"algorithm\":\"%s\",\"frames\":%zu,\"p50Us\":%.2f,\"p95Us\":%.2f,\"maxUs\":%.2f,\"wallTimeRatioPercent\":%.3f}\n",
      mode.c_str(), timings.size(), timings[timings.size()/2], timings[(timings.size()-1)*95/100],
      timings.back(), total / (timings.size() * 100.0));
}
