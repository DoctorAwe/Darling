// M1 unit tests for the linear AEC core. No devices, no network.
// Build: cl /std:c++20 /O2 /EHsc /I src/aec tests/aec_linear_test.cpp src/aec/linear_aec.cpp

#include "delay_estimator.h"
#include "linear_aec.h"
#include "residual_suppressor.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>

using darling::aec::ComplexFft;
using darling::aec::LinearAec;
using darling::aec::LinearAecConfig;

namespace {

constexpr int kRate = 48000;
constexpr int kBlock = 480;
constexpr double kPi = 3.14159265358979323846;

double energy(const std::vector<float>& samples, int from, int to) {
  double sum = 0;
  for (int i = from; i < to; ++i) sum += static_cast<double>(samples[i]) * samples[i];
  return sum;
}

std::vector<float> voice(double seconds, double f0, unsigned seed) {
  const int frames = static_cast<int>(seconds * kRate);
  std::vector<float> out(frames);
  std::mt19937 random(seed);
  std::uniform_real_distribution<float> noise(-1.f, 1.f);
  double phase = 0;
  for (int i = 0; i < frames; ++i) {
    const double t = static_cast<double>(i) / kRate;
    const double syllable = std::pow(std::max(0.0, std::sin(2 * kPi * 3.1 * t)), 2.0);
    const double cycle = std::fmod(t, 2.7);
    const double pause = (static_cast<int>(t / 2.7) % 3 == 2 && cycle > 2.15) ? 0.0 : 1.0;
    const double pitch = f0 * (1 + 0.06 * std::sin(2 * kPi * 0.31 * t));
    phase += 2 * kPi * pitch / kRate;
    double sample = 0;
    for (int h = 1; h <= 10; ++h) sample += std::sin(phase * h) / h;
    out[i] = static_cast<float>(0.22 * syllable * pause * sample + 0.0015 * noise(random));
  }
  double sum = 0;
  for (float value : out) sum += static_cast<double>(value) * value;
  const double rms = std::sqrt(sum / frames);
  const double gain = 0.1 / std::max(rms, 1e-12);
  for (float& value : out) value = static_cast<float>(value * gain);
  return out;
}

int testFft() {
  constexpr int n = 1024;
  ComplexFft fft(n);
  std::mt19937 random(1234);
  std::uniform_real_distribution<float> dist(-1.f, 1.f);
  std::vector<std::complex<float>> input(n);
  for (auto& value : input) value = {dist(random), 0.f};

  std::vector<std::complex<float>> spectrum = input;
  fft.Forward(spectrum.data());

  double maxError = 0;
  for (int k = 0; k < n; ++k) {
    std::complex<double> expected{};
    for (int i = 0; i < n; ++i) {
      const double angle = -2.0 * kPi * k * i / n;
      expected += std::complex<double>(input[i].real(), 0.0) *
                  std::complex<double>(std::cos(angle), std::sin(angle));
    }
    maxError = std::max(maxError, std::abs(std::complex<double>(spectrum[k].real(), spectrum[k].imag()) - expected));
  }
  if (maxError > 0.05) {
    std::printf("FFT_FAIL maxError=%f\n", maxError);
    return 1;
  }

  std::vector<std::complex<float>> roundTrip = spectrum;
  fft.Inverse(roundTrip.data());
  double roundError = 0;
  for (int i = 0; i < n; ++i) roundError = std::max(roundError, static_cast<double>(std::abs(roundTrip[i].real() - input[i].real())));
  if (roundError > 1e-4) {
    std::printf("FFT_ROUNDTRIP_FAIL maxError=%f\n", roundError);
    return 1;
  }
  std::printf("FFT_OK maxError=%.6f roundTrip=%.8f\n", maxError, roundError);
  return 0;
}

struct EchoResult {
  double erleDb;
  double usPerBlock;
};

EchoResult runEcho(const LinearAecConfig& config, double seconds, int delaySamples, double echoGain) {
  const int frames = static_cast<int>(seconds * kRate);
  const std::vector<float> far = voice(seconds, 118, 11);
  std::vector<float> capture(frames, 0.f);
  for (int i = delaySamples; i < frames; ++i) capture[i] = static_cast<float>(far[i - delaySamples] * echoGain);

  LinearAec aec(config);
  std::vector<float> output(frames, 0.f);
  const auto start = std::chrono::steady_clock::now();
  for (int offset = 0; offset + kBlock <= frames; offset += kBlock)
    aec.Process(far.data() + offset, capture.data() + offset, output.data() + offset);
  const auto elapsed = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count();

  const int tail = frames - 3 * kRate;
  const double in = energy(capture, tail, frames);
  const double out = energy(output, tail, frames);
  EchoResult result{};
  result.erleDb = 10 * std::log10(std::max(in, 1e-20) / std::max(out, 1e-20));
  result.usPerBlock = elapsed / static_cast<double>(frames / kBlock);
  return result;
}

int testDelay() {
  constexpr int seconds = 3;
  constexpr int delay = 4800;  // 100 ms
  const std::vector<float> ref = voice(seconds, 118, 11);
  std::vector<float> mic(ref.size(), 0.f);
  for (int i = delay; i < static_cast<int>(ref.size()); ++i) mic[i] = ref[i - delay] * 0.5f;
  darling::aec::DelayEstimator estimator;
  for (int offset = 0; offset + kBlock <= static_cast<int>(ref.size()); offset += kBlock)
    estimator.Push(ref.data() + offset, mic.data() + offset, kBlock);
  std::printf("DELAY_ESTIMATE got=%d expected=%d confidence=%.3f\n", estimator.delay_samples(),
              delay, estimator.confidence());
  if (std::abs(estimator.delay_samples() - delay) > 96) return 5;
  return 0;
}

int testAdaptiveEcho() {
  constexpr double seconds = 6.0;
  constexpr int delay = 4800;  // 100 ms
  const int frames = static_cast<int>(seconds * kRate);
  const std::vector<float> far = voice(seconds, 118, 11);
  std::vector<float> mic(frames, 0.f);
  for (int i = delay; i < frames; ++i) mic[i] = far[i - delay] * 0.5f;

  darling::aec::DelayEstimator estimator;
  LinearAec aec;
  std::vector<float> output(frames, 0.f);
  for (int offset = 0; offset + kBlock <= frames; offset += kBlock) {
    if (estimator.Push(far.data() + offset, mic.data() + offset, kBlock))
      aec.SetBulkDelay(estimator.delay_samples());
    aec.Process(far.data() + offset, mic.data() + offset, output.data() + offset);
  }
  const int tail = frames - 2 * kRate;
  const double erle = 10 * std::log10(std::max(energy(mic, tail, frames), 1e-20) /
                                      std::max(energy(output, tail, frames), 1e-20));
  std::printf("ADAPTIVE_ECHO delay=%d erle=%.2f dB safety=%llu\n", estimator.delay_samples(), erle,
              static_cast<unsigned long long>(aec.safety_events()));
  if (std::abs(estimator.delay_samples() - delay) > 96 || !std::isfinite(erle) || erle < 30.0)
    return 6;
  return 0;
}

int testResidualSuppressor() {
  darling::aec::ResidualSuppressorConfig config;
  config.fft = 1024;
  darling::aec::ResidualSuppressor res(config);
  std::vector<std::complex<float>> residual(1024);
  std::vector<std::complex<float>> echo(1024);
  const auto run = [&](float near_probability) {
    res.Reset();
    for (int block = 0; block < 50; ++block) {
      for (int i = 0; i < 1024; ++i) {
        residual[i] = {0.1f, 0.f};
        echo[i] = {0.1f, 0.f};
      }
      res.Process(residual.data(), echo.data(), true, false, near_probability);
    }
    return res.mean_gain();
  };
  const float open = run(1.f);
  const float closed = run(0.f);
  std::printf("RES_GATE open=%.3f closed=%.3f\n", open, closed);
  if (open < 0.99f || closed > 0.9f) return 7;
  return 0;
}

int testEcho() {
  LinearAecConfig config;  // defaults: mu=0.5, leakage=1e-5, constrain=true
  const EchoResult result = runEcho(config, 20.0, 2400, 0.5);
  std::printf("ECHO_ERLE mu=%.2f leak=%.0e delay=50ms erle=%.2f dB usPerBlock=%.1f\n",
              config.mu, config.leakage, result.erleDb, result.usPerBlock);
  if (!std::isfinite(result.erleDb) || result.erleDb < 30.0) {
    std::printf("ECHO_FAIL erle=%f\n", result.erleDb);
    return 2;
  }
  const EchoResult aligned = runEcho(config, 20.0, 0, 0.5);
  std::printf("ECHO_ALIGNED erle=%.2f dB\n", aligned.erleDb);
  if (!std::isfinite(aligned.erleDb) || aligned.erleDb < 40.0) {
    std::printf("ECHO_ALIGNED_FAIL erle=%f\n", aligned.erleDb);
    return 2;
  }
  return 0;
}

int testNearOnly() {
  const double seconds = 4.0;
  const int frames = static_cast<int>(seconds * kRate);
  const std::vector<float> near = voice(seconds, 196, 29);
  std::vector<float> silence(frames, 0.f);
  std::vector<float> output(frames, 0.f);
  LinearAec aec{};
  for (int offset = 0; offset + kBlock <= frames; offset += kBlock)
    aec.Process(silence.data() + offset, near.data() + offset, output.data() + offset);
  const double in = energy(near, 0, frames);
  const double out = energy(output, 0, frames);
  const double lossDb = 10 * std::log10(std::max(out, 1e-20) / std::max(in, 1e-20));
  std::printf("NEAR_ONLY loss=%.4f dB\n", lossDb);
  if (std::abs(lossDb) > 0.05) {
    std::printf("NEAR_ONLY_FAIL\n");
    return 3;
  }
  return 0;
}

int testReset() {
  LinearAec aec{};
  const double seconds = 6.0;
  const int frames = static_cast<int>(seconds * kRate);
  const std::vector<float> far = voice(seconds, 118, 7);
  std::vector<float> capture(frames, 0.f);
  for (int i = 2400; i < frames; ++i) capture[i] = far[i - 2400] * 0.5f;
  std::vector<float> output(frames, 0.f);
  for (int offset = 0; offset + kBlock <= frames; offset += kBlock)
    aec.Process(far.data() + offset, capture.data() + offset, output.data() + offset);

  aec.Reset();
  const std::vector<float> near = voice(seconds, 196, 29);
  std::vector<float> silence(frames, 0.f);
  for (int offset = 0; offset + kBlock <= frames; offset += kBlock)
    aec.Process(silence.data() + offset, near.data() + offset, output.data() + offset);
  const double in = energy(near, 0, frames);
  const double out = energy(output, 0, frames);
  const double lossDb = 10 * std::log10(std::max(out, 1e-20) / std::max(in, 1e-20));
  std::printf("RESET_NEAR_ONLY loss=%.4f dB\n", lossDb);
  if (std::abs(lossDb) > 0.05) {
    std::printf("RESET_FAIL\n");
    return 4;
  }
  return 0;
}

}  // namespace

int testSafetyRegressions() {
  constexpr int frames = 48000 * 8;
  std::mt19937 random(9301);
  std::uniform_real_distribution<float> noise(-1, 1);
  std::vector<float> far(frames), near(frames), ref(frames), mic(frames), out(frames);
  for (int i=0; i<frames; ++i) { far[i]=noise(random); near[i]=noise(random)*.15f; }
  for (float weak : {.0001f, .001f, .01f}) {
    LinearAec aec;
    double in_energy=0, out_energy=0;
    float peak=0;
    for (int i=0;i<frames;++i) ref[i]=far[i]*(i<48000?weak:.15f);
    for (int p=0;p<frames;p+=kBlock) {
      aec.Process(ref.data()+p,near.data()+p,out.data()+p);
      for(int i=p;i<p+kBlock;++i) {
        if(!std::isfinite(out[i]) || std::abs(out[i])>1.f) return 20;
        peak=std::max(peak,std::abs(out[i]));
        in_energy+=double(near[i])*near[i]; out_energy+=double(out[i])*out[i];
      }
    }
    const double gain=10*std::log10(out_energy/in_energy);
    std::printf("NO_ECHO_STEP weak=%.4f peak=%.6f gainDb=%.3f\n",weak,peak,gain);
    if(peak>.16f || std::abs(gain)>.1) return 21;
  }
  LinearAec aec;
  aec.SetBulkDelay(2400);
  std::array<float,kBlock> zero{};
  double in_energy=0,out_energy=0;
  for(int i=0;i<frames;++i) {
    ref[i]=far[i]*.15f;
    mic[i]=i>=2400?ref[i-2400]*.5f:0.f;
  }
  for(int p=0;p<frames;p+=kBlock) {
    const bool valid=p<48000*2 || (p/kBlock)%50!=0;
    aec.Process(valid?ref.data()+p:zero.data(),mic.data()+p,out.data()+p,valid);
    if(aec.bulk_delay()!=2400) return 22;
    for(int i=p;i<p+kBlock;++i) {
      if(!std::isfinite(out[i]) || std::abs(out[i])>1.f) return 23;
      if(i>=48000*4) {in_energy+=double(mic[i])*mic[i];out_energy+=double(out[i])*out[i];}
    }
  }
  const double erle=10*std::log10(in_energy/std::max(out_energy,1e-30));
  std::printf("GAPPED_REFERENCE erleDb=%.3f\n",erle);
  if(erle<10) return 24;
  for (bool remove_echo : {false,true}) {
    LinearAec duplex;
    duplex.SetBulkDelay(2400);
    double near_energy=0,error_energy=0;
    for(int p=0;p<frames;p+=kBlock) {
      for(int i=p;i<p+kBlock;++i) {
        const float echo=i>=2400?ref[i-2400]*.5f:0.f;
        mic[i]=(i>=48000*3?near[i]:0.f) + (remove_echo && i>=48000*3?0.f:echo);
      }
      duplex.Process(ref.data()+p,mic.data()+p,out.data()+p);
      for(int i=p;i<p+kBlock;++i) {
        if(!std::isfinite(out[i]) || std::abs(out[i])>1.f) return 25;
        if(i>=48000*6) {
          near_energy+=double(near[i])*near[i];
          const double error=out[i]-near[i]; error_energy+=error*error;
        }
      }
    }
    const double snr=10*std::log10(near_energy/std::max(error_energy,1e-30));
    std::printf("DUPLEX removeEcho=%d nearSnrDb=%.3f\n",remove_echo,snr);
    if(snr<12) return 26;
  }
  return 0;
}

int main() {
  if (const int code = testSafetyRegressions()) return code;
  if (const int code = testFft()) return code;
  if (const int code = testDelay()) return code;
  if (const int code = testAdaptiveEcho()) return code;
  if (const int code = testResidualSuppressor()) return code;
  if (const int code = testEcho()) return code;
  if (const int code = testNearOnly()) return code;
  if (const int code = testReset()) return code;
  std::printf("ALL_OK\n");
  return 0;
}
