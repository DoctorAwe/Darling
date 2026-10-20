#include "aec3_processor.h"
#include "aec3_trace.h"
#include <algorithm>
#include <stdexcept>
#include "api/echo_canceller3_factory.h"
#include "api/environment.h"
#include "audio_processing/audio_buffer.h"

namespace {
float normalized(float sample) noexcept {
  return std::isfinite(sample) ? std::clamp(sample, -1.f, 1.f) : 0.f;
}
void copy_in(const AudioFrame& frame, webrtc::AudioBuffer& buffer) noexcept {
  for (unsigned i = 0; i < audio_block; ++i)
    buffer.channels()[0][i] = normalized(frame.samples[i]) * 32768.f;
}
}
struct Aec3Processor::State {
  webrtc::Environment environment;
  std::unique_ptr<webrtc::EchoControl> echo;
  webrtc::AudioBuffer render{audio_rate, 1, audio_rate, 1, audio_rate, 1};
  webrtc::AudioBuffer capture{audio_rate, 1, audio_rate, 1, audio_rate, 1};
  webrtc::AudioBuffer linear{16000, 1, 16000, 1, 16000, 1};
  explicit State(Profile profile) {
    webrtc::EchoCanceller3Config config;
    if (profile == Profile::DiagnosticLowExcitation)
      config.render_levels.poor_excitation_render_limit = 150.f / std::pow(10.f, 12.f/20.f);
    // Diagnostic-only single-variable experiment; production retains upstream defaults.
    if (profile == Profile::DiagnosticLowNearendSnr)
      config.suppressor.dominant_nearend_detection.snr_threshold = 1.f;
    config.filter.export_linear_aec_output = profile == Profile::DiagnosticLinearOutput;
    if (profile == Profile::DiagnosticStableLinearPath)
      config.echo_removal_control.linear_and_stable_echo_path = true;
    if (profile == Profile::DiagnosticBoundedResidual)
      config.suppressor.dominant_nearend_detection.use_unbounded_echo_spectrum = false;
    if (profile == Profile::DiagnosticNearendMask || profile == Profile::DiagnosticWeakNearend)
      config.suppressor.nearend_tuning.mask_hf = {3.f, 4.f, .3f};
    if (profile == Profile::DiagnosticWeakNearend)
      config.suppressor.dominant_nearend_detection.enr_threshold = 2.f;
    webrtc::EchoCanceller3Factory factory{config};
    echo = factory.Create(environment, audio_rate, 1, 1);
    if (!echo) throw std::runtime_error("AEC3 initialization failed");
  }
};
Aec3Processor::Aec3Processor(Profile profile) : profile_(profile) { reset(); }
Aec3Processor::~Aec3Processor() = default;
void Aec3Processor::reset() {
  // Replace the entire state, including filter banks and delay estimator.
  // Strong exception guarantee: a failed allocation leaves the old state intact.
  auto fresh = std::make_unique<State>(profile_);
  state_.swap(fresh);
}
void Aec3Processor::render(const AudioFrame& frame) noexcept {
  copy_in(frame, state_->render);
  state_->render.SplitIntoFrequencyBands();
  state_->echo->AnalyzeRender(&state_->render);
}
void Aec3Processor::capture(AudioFrame& frame) noexcept {
  darling_aec_trace::enabled = profile_ == Profile::DiagnosticTrace || profile_ == Profile::DiagnosticNearendMask || profile_ == Profile::DiagnosticWeakNearend || profile_ == Profile::DiagnosticLowExcitation;
  copy_in(frame, state_->capture);
  state_->echo->AnalyzeCapture(&state_->capture);
  state_->capture.SplitIntoFrequencyBands();
  if (profile_ == Profile::DiagnosticLinearOutput)
    state_->echo->ProcessCapture(&state_->capture, &state_->linear, false);
  else state_->echo->ProcessCapture(&state_->capture, false);
  state_->capture.MergeFrequencyBands();
  for (unsigned i = 0; i < audio_block; ++i)
    frame.samples[i] = normalized(state_->capture.channels()[0][i] / 32768.f);
  // Metadata remains unchanged. No guessed external delay is injected:
  // submission QPC/padding is not a measured acoustic delay.
  darling_aec_trace::enabled = false;
}
std::array<float, 160> Aec3Processor::linear_output() const noexcept {
  std::array<float, 160> result{};
  if (profile_ == Profile::DiagnosticLinearOutput)
    for (unsigned i = 0; i < result.size(); ++i) result[i] = state_->linear.channels()[0][i] / 32768.f;
  return result;
}
