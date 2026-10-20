#pragma once
#include "audio_pipeline.h"
#include <memory>

// Experimental adapter. Owned and called by a single audio-processing thread.
// Construction/reset allocates: call only BEFORE starting, or AFTER joining,
// the audio worker. Never reset concurrently with render/capture.
class Aec3Processor final : public AudioProcessor {
public:
  enum class Profile { Default, DiagnosticLowNearendSnr, DiagnosticLinearOutput, DiagnosticStableLinearPath, DiagnosticBoundedResidual, DiagnosticTrace, DiagnosticNearendMask, DiagnosticWeakNearend, DiagnosticLowExcitation };
private:
  struct State;
  std::unique_ptr<State> state_;
  Profile profile_;
public:
  explicit Aec3Processor(Profile profile = Profile::Default);
  ~Aec3Processor() override;
  Aec3Processor(const Aec3Processor&) = delete;
  Aec3Processor& operator=(const Aec3Processor&) = delete;
  void reset();
  // Diagnostic lower-band (16 kHz) output before nonlinear suppression.
  // Returns zeros unless DiagnosticLinearOutput was explicitly selected.
  std::array<float, 160> linear_output() const noexcept;
  void render(const AudioFrame& frame) noexcept override;
  void capture(AudioFrame& frame) noexcept override;
};
