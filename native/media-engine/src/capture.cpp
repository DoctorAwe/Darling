#include "capture.h"
#include "level_meter.h"
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <ksmedia.h>
#include <avrt.h>
#include <wrl/client.h>
#include <chrono>
#include <memory>
#include <stdexcept>

using Microsoft::WRL::ComPtr;
using nlohmann::json;
namespace {
void check(HRESULT hr, const char* operation) {
  if (FAILED(hr)) throw std::runtime_error(std::string(operation) + " failed (HRESULT " + std::to_string(static_cast<unsigned long>(hr)) + ")");
}
struct ComScope {
  ComScope() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM initialization"); }
  ~ComScope() { CoUninitialize(); }
};
struct Free { void operator()(void* p) const { CoTaskMemFree(p); } };
struct Handle {
  HANDLE value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  ~Handle() { if (value) CloseHandle(value); }
};
struct AudioPriority {
  DWORD index = 0;
  HANDLE value = AvSetMmThreadCharacteristicsW(L"Audio", &index);
  ~AudioPriority() { if (value) AvRevertMmThreadCharacteristics(value); }
};
struct StreamStop { IAudioClient* client; ~StreamStop() { client->Stop(); } };
std::wstring wide(const std::string& value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (!size) throw std::runtime_error("Invalid device identifier");
  std::wstring result(size, L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size); return result;
}
}
Capture::~Capture() { stop(); }
json Capture::start(const std::string& id) {
  stop();
  frames_ = 0; discontinuities_ = 0; clipped_ = 0; timestamp_errors_ = 0; peak_ = 0; rms_ = 0; stop_ = false;
  { std::lock_guard lock(metadata_mutex_); device_id_ = id; error_.clear(); reason_ = "starting"; format_ = nullptr; }
  std::promise<std::string> initialized; auto future = initialized.get_future();
  worker_ = std::thread(&Capture::run, this, id, std::move(initialized));
  // Parent process enforces an overall request timeout if a driver stalls initialization.
  const auto error = future.get();
  if (!error.empty()) { stop(); throw std::runtime_error(error); }
  return status();
}
json Capture::stop() {
  stop_ = true;
  if (worker_.joinable()) worker_.join();
  running_ = false; peak_ = 0; rms_ = 0;
  return status();
}
json Capture::status() {
  std::lock_guard lock(metadata_mutex_);
  return {{"running", running_.load()}, {"deviceId", device_id_}, {"format", format_},
    {"peak", peak_.load()}, {"rms", rms_.load()}, {"frames", frames_.load()}, {"clippedSamples", clipped_.load()},
    {"discontinuities", discontinuities_.load()}, {"timestampErrors", timestamp_errors_.load()},
    {"reason", reason_}, {"error", error_}, {"rawMode", "not-requested"},
    {"processing", {{"sampleRate", audio_rate}, {"blockSamples", audio_block}, {"channels", 1}, {"mode", pipeline_.mode()}, {"processedRms", pipeline_.processedRms.load()}, {"captureBlocks", pipeline_.capturedBlocks.load()}, {"referenceBlocks", pipeline_.consumedReferences.load()}, {"droppedReferences", pipeline_.droppedReferences.load()}, {"staleReferences", pipeline_.staleReferences.load()}}}};
}
void Capture::run(std::string id, std::promise<std::string> initialized) {
  bool announced = false;
  try {
    ComScope com;
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)), "Device enumerator");
    ComPtr<IMMDevice> device;
    if (id == "default") check(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device), "Default microphone");
    else check(enumerator->GetDevice(wide(id).c_str(), &device), "Selected microphone");
    ComPtr<IMMEndpoint> endpoint; check(device.As(&endpoint), "Endpoint interface");
    EDataFlow flow; check(endpoint->GetDataFlow(&flow), "Endpoint direction");
    if (flow != eCapture) throw std::runtime_error("Selected device is not an input endpoint");
    ComPtr<IAudioClient> client;
    check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())), "Activate microphone");
    WAVEFORMATEX* raw = nullptr; check(client->GetMixFormat(&raw), "Get mix format");
    std::unique_ptr<WAVEFORMATEX, Free> format(raw);
    bool floating = format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    bool pcm = format->wFormatTag == WAVE_FORMAT_PCM;
    WORD valid_bits = format->wBitsPerSample;
    if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && format->cbSize >= 22) {
      const auto* ext = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(format.get());
      floating = IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
      pcm = IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM);
      valid_bits = ext->Samples.wValidBitsPerSample;
    }
    if ((!floating && !pcm) || (floating && format->wBitsPerSample != 32) ||
      (pcm && format->wBitsPerSample != 16 && format->wBitsPerSample != 24 && format->wBitsPerSample != 32) ||
      !format->nChannels || !format->nSamplesPerSec || format->nBlockAlign != format->nChannels * (format->wBitsPerSample / 8))
      throw std::runtime_error("Unsupported microphone mix format");
    // Windows performs channel/sample-rate conversion once, with its higher-quality SRC.
    // Keep the device mix format only for validation; processing always receives float32/48k/mono.
    WAVEFORMATEX processingFormat{WAVE_FORMAT_IEEE_FLOAT, 1, audio_rate, audio_rate * 4, 4, 32, 0};
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 0, 0, &processingFormat, nullptr), "Initialize 48k shared capture");
    Handle event; if (!event.value) throw std::runtime_error("Create capture event failed");
    check(client->SetEventHandle(event.value), "Set capture event");
    ComPtr<IAudioCaptureClient> capture;
    check(client->GetService(IID_PPV_ARGS(&capture)), "Get capture service");
    { std::lock_guard lock(metadata_mutex_); format_ = {{"sampleRate", audio_rate}, {"channels", 1}, {"containerBits", 32}, {"validBits", 32}, {"encoding", "float"}}; reason_ = "running"; }
    FrameAssembler assembler;
    AudioPriority priority;
    check(client->Start(), "Start capture"); StreamStop stream{client.Get()};
    running_ = true; initialized.set_value(""); announced = true;
    const auto started = std::chrono::steady_clock::now();
    auto last_packet = started;
    while (!stop_) {
      const auto now = std::chrono::steady_clock::now();
      // Diagnostic preview is bounded even if the UI or control channel is lost.
      if (now - started >= std::chrono::seconds(60)) { std::lock_guard lock(metadata_mutex_); reason_ = "time-limit"; break; }
      if (now - last_packet >= std::chrono::seconds(3)) throw std::runtime_error("No audio packets received for 3 seconds");
      const auto wait = WaitForSingleObject(event.value, 50);
      if (wait == WAIT_TIMEOUT) continue;
      if (wait != WAIT_OBJECT_0) throw std::runtime_error("Capture event wait failed");
      UINT32 available = 0; check(capture->GetNextPacketSize(&available), "Get packet size");
      while (available && !stop_) {
        BYTE* data = nullptr; UINT32 count = 0; DWORD flags = 0;
        UINT64 devicePosition = 0, timestamp = 0;
        check(capture->GetBuffer(&data, &count, &flags, &devicePosition, &timestamp), "Read microphone packet");
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
#ifdef DARLING_REALTIME_AEC3
        if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ||
            ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) && frames_.load() > 0) ||
            pipeline_.droppedReferences.load() > 0 || pipeline_.staleReferences.load() > 0) {
          check(capture->ReleaseBuffer(count), "Release interrupted packet");
          throw std::runtime_error("Experimental AEC timing discontinuity; restart capture to reset processing");
        }
#endif
        const auto levels = measure_levels(data, count, 32, true, silent);
        if (flags & (AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY | AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)) assembler.reset();
        for (UINT32 i = 0; i < count; ++i) {
          float sample = 0; if (!silent) std::memcpy(&sample, data + i * sizeof(float), sizeof(float));
          assembler.push(sample, timestamp + static_cast<uint64_t>(i) * 10000000 / audio_rate, !(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR), 0, 0,
            [&](AudioFrame& frame) { pipeline_.capture(frame); });
        }
        const auto released = capture->ReleaseBuffer(count);
        check(released, "Release microphone packet");
        peak_ = levels.peak; rms_ = levels.rms; frames_ += count; clipped_ += levels.clipped;
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) ++discontinuities_;
        if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ++timestamp_errors_;
        last_packet = std::chrono::steady_clock::now();
        check(capture->GetNextPacketSize(&available), "Next packet size");
      }
    }
    { std::lock_guard lock(metadata_mutex_); if (reason_ == "running") reason_ = "stopped"; }
  } catch (const std::exception& e) {
    { std::lock_guard lock(metadata_mutex_); error_ = e.what(); reason_ = "error"; }
    if (!announced) initialized.set_value(e.what());
  }
  running_ = false; peak_ = 0; rms_ = 0;
}
