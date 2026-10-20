#include "aec3_processor.h"
#include "aec3_trace.h"
#include "speech_wav.h"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <vector>

namespace {
float noise(uint32_t& seed, float& low) {
  seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
  low = .7f * low + .3f * (static_cast<float>(seed) / 4294967295.f * 2.f - 1.f);
  return low * .3f;
}
}

// Independent near/far signals; all metrics are synthetic, not speech MOS.
int evaluate_scenarios(bool diagnostic = false, bool modulated = false, bool linear = false, bool stable = false, bool bounded = false, bool trace = false, bool nearendMask = false, uint32_t seed = 3456789, float nearScale = 1.f, bool nonlinear = false, bool batch = false, bool weakNearend = false, const std::vector<float>* speechFar = nullptr, const std::vector<float>* speechNear = nullptr, int pathMode = 0, bool lowExcitation = false) {
  constexpr unsigned rate = audio_rate, count = 40 * rate;
  if (speechFar) trace = true; // Observation only, Default algorithm configuration.
  std::vector<float> far(count), near(count), input(count), output(count), baseline(count);
  uint32_t farSeed = seed, nearSeed = seed == 3456789 ? 9876543 : seed ^ 0x9e3779b9u;
  float farLow = 0, nearLow = 0;
  for (unsigned i = 0; i < count; ++i) {
    far[i] = speechFar ? (*speechFar)[i] : noise(farSeed, farLow);
    const float value = speechNear ? (*speechNear)[i] : noise(nearSeed, nearLow);
    const double phase = static_cast<double>(i) / rate;
    const float envelope = modulated ? static_cast<float>((.05 + .95 * std::pow(std::sin(phase * 3.141592653589793 * 4), 2)) * ((i / (rate / 2)) % 4 == 3 ? 0 : 1)) : 1.f;
    near[i] = i >= 10 * rate && i < 20 * rate ? value * envelope * nearScale : 0.f;
    // Change delay/gain/secondary reflection WITHOUT resetting the algorithm.
    const bool earlyPath = pathMode == 1 || (pathMode == 0 && i < 25 * rate);
    const unsigned delay = earlyPath ? 1920 : 7680; // 40 -> 160 ms
    const float gain = earlyPath ? .6f : .35f;
    const float echo = (i >= delay ? far[i-delay] * gain : 0.f)
      + (i >= delay + 720 ? far[i-delay-720] * .12f : 0.f);
    input[i] = near[i] + (nonlinear ? std::tanh(8.f * echo) / 8.f : echo);
    if (speechFar && std::abs(input[i]) >= 1.f) {
      std::cerr << "Invalid fixture: mixed input would clip\n"; return 65;
    }
  }
  Aec3Processor mixed(lowExcitation ? Aec3Processor::Profile::DiagnosticLowExcitation : weakNearend ? Aec3Processor::Profile::DiagnosticWeakNearend : nearendMask ? Aec3Processor::Profile::DiagnosticNearendMask : trace ? Aec3Processor::Profile::DiagnosticTrace : stable ? Aec3Processor::Profile::DiagnosticStableLinearPath : bounded ? Aec3Processor::Profile::DiagnosticBoundedResidual : linear ? Aec3Processor::Profile::DiagnosticLinearOutput : diagnostic ? Aec3Processor::Profile::DiagnosticLowNearendSnr : Aec3Processor::Profile::Default);
  Aec3Processor nearOnly(linear ? Aec3Processor::Profile::DiagnosticLinearOutput : Aec3Processor::Profile::Default);
  double linearXX = 0, linearYY = 0, linearXY = 0;
  if (nearendMask) { trace = true; std::cout << "diagnostic_nearend_mask=hf_3_4_0.3\n"; }
  if (weakNearend) { trace = true; std::cout << "diagnostic_weak_nearend_enr_threshold=2\n"; }
  std::cout << "scenario_profile=" << (lowExcitation ? "diagnostic-low-excitation" : stable ? "diagnostic-stable-linear-path" : bounded ? "diagnostic-bounded-residual" : diagnostic ? "diagnostic-low-nearend-snr" : linear ? "diagnostic-linear-output" : "default") << '\n';
  std::cout << "near_signal=" << (speechFar ? "external-wav-content-not-verified" : modulated ? "amplitude-modulated-noise-not-speech" : "stationary-noise") << '\n';
  AudioFrame render, capture, silence, clean;
  for (unsigned offset = 0; offset < count; offset += audio_block) {
    if (speechFar && offset % rate == 0) darling_aec_trace::stats = {};
    if (trace && !speechFar && offset == 12 * rate) darling_aec_trace::stats = {};
    if (trace && !speechFar && offset == 19 * rate) {
      const auto& t = darling_aec_trace::stats;
      std::cout << "trace_blocks=" << t.blocks << " usable=" << t.usable << " dominant=" << t.dominant
        << " saturated=" << t.saturated << " residual_to_near=" << t.residualPower/std::max(t.nearPower,1e-30)
        << " mean_amplitude_gain=" << t.amplitudeGain/std::max<uint64_t>(t.blocks,1) << '\n';
    }
    for (unsigned i = 0; i < audio_block; ++i) {
      render.samples[i] = far[offset+i]; capture.samples[i] = input[offset+i];
      clean.samples[i] = near[offset+i];
    }
    mixed.render(render); mixed.capture(capture);
    if (speechFar && (offset + audio_block) % rate == 0) {
      const auto& t = darling_aec_trace::stats;
      std::cout << "WAV_STATE path_mode=" << pathMode << " second=" << offset/rate
        << " blocks=" << t.blocks << " usable=" << t.usable << " dominant=" << t.dominant
        << " saturated=" << t.saturated << " delay_known=" << t.delayKnown << " delay_refined=" << t.delayRefined
        << " delay_min_blocks=" << (t.delayKnown ? double(t.delayMin) : -1)
        << " delay_max_blocks=" << (t.delayKnown ? double(t.delayMax) : -1)
        << " delay_mean_blocks=" << (t.delayKnown ? double(t.delaySum)/t.delayKnown : -1)
        << " filter_delay_last_blocks=" << t.filterDelayLast << " filter_length_last_blocks=" << t.filterLengthLast
        << " mean_gain=" << t.amplitudeGain/std::max<uint64_t>(t.blocks,1)
        << " match_samples=" << t.matchSamples << " low_energy=" << t.lowEnergy
        << " match_saturated=" << t.matchSaturated << " eligible=" << t.eligible
        << " filters_checked=" << t.filtersChecked << " filters_updated=" << t.filtersUpdated
        << " reliable_updated=" << t.reliableUpdated << " winners=" << t.winners << '\n';
    }
    nearOnly.render(silence); nearOnly.capture(clean);
    if (linear && offset >= 12 * rate && offset < 19 * rate) {
      const auto x = nearOnly.linear_output(), y = mixed.linear_output();
      for (unsigned i = 0; i < x.size(); ++i) {
        if (!std::isfinite(x[i]) || !std::isfinite(y[i])) return 13;
        linearXX += x[i]*x[i]; linearYY += y[i]*y[i]; linearXY += x[i]*y[i];
      }
    }
    for (unsigned i = 0; i < audio_block; ++i) {
      if (!std::isfinite(capture.samples[i]) || std::abs(capture.samples[i]) > 1.f) return 10;
      output[offset+i] = capture.samples[i]; baseline[offset+i] = clean.samples[i];
    }
  }
  auto attenuation = [&](unsigned begin, unsigned end) {
    double in = 0, out = 0;
    for (unsigned i = begin * rate; i < end * rate; ++i) { in += input[i]*input[i]; out += output[i]*output[i]; }
    return 10 * std::log10(in / std::max(out, 1e-30));
  };
  double xy = 0, xx = 0, yy = 0, error = 0;
  // Compare with independently processed near-only baseline to account for
  // fixed filter-bank latency. No fitted gain or arbitrary time shift hides loss.
  for (unsigned i = 12 * rate; i < 19 * rate; ++i) {
    const double x = baseline[i], y = output[i];
    xy += x*y; xx += x*x; yy += y*y; error += (x-y)*(x-y);
  }
  const double correlation = xy / std::sqrt(std::max(xx*yy, 1e-30));
  const double gainDb = 20 * std::log10(std::max(xy / std::max(xx, 1e-30), 1e-30));
  const double snr = 10 * std::log10(xx / std::max(error, 1e-30));
  const double before = attenuation(5, 9), after = attenuation(35, 39);
  double bestCorrelation = -1, alignedGain = 0; int bestLag = 0;
  for (int lag = -240; lag <= 240; ++lag) {
    double ax = 0, ay = 0, cross = 0;
    for (int i = 12 * rate; i < 19 * rate; i += 8) {
      const double x = baseline[i-lag], y = output[i];
      ax += x*x; ay += y*y; cross += x*y;
    }
    const double corr = cross / std::sqrt(std::max(ax*ay, 1e-30));
    if (corr > bestCorrelation) { bestCorrelation = corr; bestLag = lag; alignedGain = 20*std::log10(std::max(cross/std::max(ax,1e-30),1e-30)); }
  }
  std::cout << "double_talk_correlation=" << correlation << " near_gain_db=" << gainDb
    << " baseline_snr_db=" << snr << " before_path_change_db=" << before
    << " after_path_change_db=" << after << '\n';
  std::cout << "diagnostic_best_lag_samples=" << bestLag << " diagnostic_aligned_correlation=" << bestCorrelation
    << " diagnostic_aligned_gain_db=" << alignedGain << '\n';
  if (linear) std::cout << "linear_lower_band_correlation=" << linearXY / std::sqrt(std::max(linearXX*linearYY,1e-30))
    << " linear_lower_band_gain_db=" << 20*std::log10(std::max(linearXY/std::max(linearXX,1e-30),1e-30)) << '\n';
  // Gates chosen before execution. Do not relax them to conceal a regression.
  const bool qualityPassed = correlation >= .85 && std::abs(gainDb) <= 3 && snr >= 8 && before >= 15 && after >= 15;
  if (speechFar) {
    // Separate total residual output energy from a near-only control's floor.
    // The latter has different adaptation history: it is NOT subtracted from output.
    for (unsigned begin : {5u, 25u, 30u, 35u}) {
      const unsigned end = begin + 4;
      double in = 0, out = 0, control = 0;
      for (unsigned i = begin*rate; i < end*rate; ++i) {
        in += double(input[i])*input[i]; out += double(output[i])*output[i];
        control += double(baseline[i])*baseline[i];
      }
      const double samples = (end-begin)*rate;
      auto db = [&](double energy) { return 10*std::log10(std::max(energy/samples,1e-30)); };
      std::cout << "WAV_WINDOW path_mode=" << pathMode << " begin=" << begin << " end=" << end
        << " input_dbfs=" << db(in) << " output_dbfs=" << db(out)
        << " near_only_control_dbfs=" << db(control) << " attenuation_db=" << db(in)-db(out) << '\n';
    }
    std::cout << "WAV_RESULT passed=" << qualityPassed << " raw_alignment=false fitted_gain=false\n";
    return qualityPassed ? 0 : 11;
  }
  if (batch) {
    std::cout << "BATCH_RESULT seed=" << seed << " near_scale=" << nearScale << " nonlinear=" << nonlinear
      << " candidate=" << nearendMask << " weak_nearend=" << weakNearend << " passed=" << qualityPassed << " correlation=" << correlation
      << " gain_db=" << gainDb << " snr_db=" << snr << " echo_before_db=" << before << " echo_after_db=" << after << '\n';
    return qualityPassed ? 0 : 11;
  }

  // Accelerated 120 seconds of stream processing, NOT a real-time hardware soak.
  Aec3Processor continuous;
  for (unsigned block = 0; block < 12000; ++block) {
    for (unsigned i = 0; i < audio_block; ++i) {
      render.samples[i] = noise(farSeed, farLow);
      capture.samples[i] = render.samples[i] * .4f;
    }
    continuous.render(render); continuous.capture(capture);
    for (float sample : capture.samples) if (!std::isfinite(sample) || std::abs(sample) > 1.f) return 12;
  }
  std::cout << "accelerated_stream_seconds=120 finite_output=true\n";
  return qualityPassed ? 0 : 11;
}

int evaluate_speech(const char* farPath, const char* nearPath, bool comparePaths, int gainDb, bool lowExcitation) {
  try {
    auto far = read_speech_wav(std::filesystem::u8path(farPath));
    auto near = read_speech_wav(std::filesystem::u8path(nearPath));
    constexpr size_t count = 40 * audio_rate;
    if (far.size() < count || near.size() < count) throw std::runtime_error("Each input must contain at least 40 seconds");
    far.resize(count); near.resize(count);
    if (far == near) throw std::runtime_error("Near and far must be independent recordings");
    if (gainDb != 0 && gainDb != 12 && gainDb != 24) throw std::runtime_error("Unsupported diagnostic gain");
    const float gain = std::pow(10.f, gainDb/20.f);
    std::cout << "WAV_GAIN db=" << gainDb << " factor=" << gain << " scope=both-inputs diagnostic=" << (gainDb != 0) << '\n';
    for (auto* samples : {&far, &near}) for (float& sample : *samples) {
      sample *= gain;
      if (!std::isfinite(sample) || std::abs(sample) >= 1.f) throw std::runtime_error("Diagnostic gain would clip input; not limited or normalized");
    }
    auto energy = [](const auto& samples, size_t begin, size_t end) {
      double sum = 0;
      for (size_t i=begin*audio_rate; i<end*audio_rate; ++i) sum += double(samples[i])*samples[i];
      return sum / ((end-begin)*audio_rate);
    };
    // Reject meaningless windows, rather than returning a misleading quality pass.
    if (energy(far,5,9)<1e-6 || energy(far,12,19)<1e-6 || energy(far,35,39)<1e-6 || energy(near,12,19)<1e-6)
      throw std::runtime_error("Insufficient signal energy in evaluation windows (RMS < -60 dBFS)");
    std::cout << "fixture_seconds=40 normalization=false resampling=false profile=" << (lowExcitation ? "diagnostic-low-excitation" : "default") << '\n';
    int overall = 0;
    for (int mode = 0; mode < (comparePaths ? 3 : 1); ++mode) {
      std::cout << "WAV_PATH mode=" << mode << " name=" << (mode == 0 ? "changing" : mode == 1 ? "fixed-40ms" : "fixed-160ms") << '\n';
      const int result = evaluate_scenarios(false,false,false,false,false,false,false,3456789,1.f,false,false,false,&far,&near,mode,lowExcitation);
      if (result != 0 && result != 11) return result;
      if (result == 11) overall = 11;
    }
    return overall;
  } catch (const std::exception& e) { std::cerr << "WAV input error: " << e.what() << '\n'; return 65; }
}

int evaluate_batch(bool weakNearend = false) {
  unsigned passed[2]{}, total[2]{}, executionErrors = 0;
  // Seeds not used when tuning the candidate. Freeze the matrix before executing.
  for (uint32_t seed : {20261017u, 7319281u, 419267u})
    for (float nearScale : {.5f, 1.f, 2.f})
      for (bool nonlinear : {false, true})
        for (unsigned candidate = 0; candidate < 2; ++candidate) {
          const int result = evaluate_scenarios(false, false, false, false, false, false,
            candidate != 0, seed, nearScale, nonlinear, true, candidate != 0 && weakNearend);
          ++total[candidate]; passed[candidate] += result == 0;
          executionErrors += result != 0 && result != 11;
        }
  std::cout << "BATCH_SUMMARY default_passed=" << passed[0] << "/" << total[0]
    << " candidate_passed=" << passed[1] << "/" << total[1] << " execution_errors=" << executionErrors << '\n';
  return executionErrors ? 12 : (passed[1] == total[1] ? 0 : 11);
}
