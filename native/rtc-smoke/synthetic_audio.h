// Diagnostic only: generated PCM in, decoded PCM measured in memory. No devices.
#pragma once
#include <atomic>
#include <algorithm>
#include <array>
#include <cmath>
#include <mutex>
#include <thread>
#include "modules/audio_device/include/audio_device_default.h"

class SyntheticAudio : public webrtc::webrtc_impl::AudioDeviceModuleDefault<webrtc::AudioDeviceModule> {
 public:
  explicit SyntheticAudio(bool caller) : frequency_(caller ? 600 : 1200), expected_(caller ? 1200 : 600) {}
  ~SyntheticAudio() override { Terminate(); }
  int32_t RegisterAudioCallback(webrtc::AudioTransport* callback) override {
    std::lock_guard<std::mutex> lock(mutex_); callback_ = callback; return 0;
  }
  int32_t Init() override {
    if (!running_.exchange(true)) thread_ = std::thread([this] { Run(); });
    return 0;
  }
  int32_t Terminate() override {
    running_ = false;
    if (thread_.joinable()) thread_.join();
    return 0;
  }
  int32_t StartRecording() override { recording_ = true; return 0; }
  int32_t StopRecording() override { recording_ = false; return 0; }
  bool Recording() const override { return recording_; }
  int32_t StartPlayout() override { playing_ = true; return 0; }
  int32_t StopPlayout() override { playing_ = false; return 0; }
  bool Playing() const override { return playing_; }
  int32_t StereoRecording(bool* value) const override { *value = false; return 0; }
  int32_t StereoPlayout(bool* value) const override { *value = false; return 0; }
  std::atomic<uint64_t> sent{0}, received{0}, matched{0}, errors{0};
  std::atomic<double> decoded_rms{0}, decoded_peak{0}, maximum_peak{0};
 private:
  void Run() {
    std::array<int16_t, 480> input{}, output{};
    std::array<double, 480> sine{}, cosine{};
    for (size_t i = 0; i < input.size(); ++i) {
      input[i] = static_cast<int16_t>(4000 * std::sin(2 * 3.141592653589793 * frequency_ * i / 48000));
      sine[i] = std::sin(2 * 3.141592653589793 * expected_ * i / 48000);
      cosine[i] = std::cos(2 * 3.141592653589793 * expected_ * i / 48000);
    }
    while (running_) {
      const auto next = std::chrono::steady_clock::now() + std::chrono::milliseconds(10);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (callback_ && recording_) {
          uint32_t level = 0;
          if (callback_->RecordedDataIsAvailable(input.data(), 480, 2, 1, 48000, 0, 0, 0, false, level) != 0) ++errors;
          ++sent;
        }
        if (callback_ && playing_) {
          output.fill(0); size_t count = 0; int64_t elapsed = 0, ntp = 0;
          if (callback_->NeedMorePlayData(480, 2, 1, 48000, output.data(), count, &elapsed, &ntp) != 0 || count != 480) ++errors;
          double energy = 0, re = 0, im = 0, peak = 0;
          for (size_t i = 0; i < output.size(); ++i) {
            const double value = output[i]; energy += value * value; re += value * cosine[i]; im += value * sine[i];
            peak = std::max(peak, std::abs(value) / 32768.0);
          }
          ++received;
          decoded_rms = std::sqrt(energy / output.size()) / 32768.0;
          decoded_peak = peak;
          if (peak > maximum_peak.load()) maximum_peak = peak;
          // Match the OTHER peer's tone, not silence, local loopback or RTP bytes.
          if (energy > 480 * 100.0 * 100.0 && 2 * (re * re + im * im) / (480 * energy) > 0.8) ++matched;
        }
      }
      std::this_thread::sleep_until(next);
    }
  }
  const int frequency_, expected_;
  std::atomic<bool> running_{false}, recording_{false}, playing_{false};
  std::mutex mutex_;
  webrtc::AudioTransport* callback_ = nullptr;
  std::thread thread_;
};
