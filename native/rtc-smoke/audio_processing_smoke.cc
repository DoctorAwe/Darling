// No audio devices or network: link and exercise the full libwebrtc APM.
#include <array>
#include <cmath>
#include <cstdio>

#include "api/audio/builtin_audio_processing_builder.h"
#include "api/environment/environment_factory.h"

int main() {
  webrtc::AudioProcessing::Config config;
  config.echo_canceller.enabled = true;
  config.noise_suppression.enabled = true;
  config.gain_controller1.enabled = false;
  config.gain_controller2.enabled = false;
  auto apm = webrtc::BuiltinAudioProcessingBuilder()
                 .SetConfig(config)
                 .Build(webrtc::CreateEnvironment());
  if (!apm) return 1;
  const webrtc::StreamConfig format(48000, 1);
  std::array<float, 480> render{}, capture{}, output{}, reverse_output{};
  const float* render_channels[] = {render.data()};
  const float* capture_channels[] = {capture.data()};
  float* output_channels[] = {output.data()};
  float* reverse_channels[] = {reverse_output.data()};
  for (int frame = 0; frame < 100; ++frame) {
    for (int sample = 0; sample < 480; ++sample) {
      const double t = (frame * 480 + sample) / 48000.0;
      render[sample] = static_cast<float>(0.05 * std::sin(2 * 3.141592653589793 * 440 * t));
      capture[sample] = static_cast<float>(0.02 * std::sin(2 * 3.141592653589793 * 220 * t));
    }
    if (apm->ProcessReverseStream(render_channels, format, format, reverse_channels) != 0)
      return 2;
    if (apm->set_stream_delay_ms(0) != 0) return 3;
    if (apm->ProcessStream(capture_channels, format, format, output_channels) != 0)
      return 4;
    for (float value : output)
      if (!std::isfinite(value) || std::abs(value) > 1.0f) return 5;
  }
  std::puts("PASS: libwebrtc APM, 100 x 10 ms, 48 kHz mono, AEC+NS; no devices/network.");
  return 0;
}
