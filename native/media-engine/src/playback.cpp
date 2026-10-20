#include "playback.h"
#include "render_timeline.h"
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <wrl/client.h>
#include <chrono>
#include <algorithm>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
using nlohmann::json;
namespace {
void check(HRESULT hr, const char* operation) { if (FAILED(hr)) throw std::runtime_error(std::string(operation) + " failed (HRESULT " + std::to_string(static_cast<unsigned long>(hr)) + ")"); }
struct ComScope { ComScope() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM"); } ~ComScope() { CoUninitialize(); } };
struct Event { HANDLE value = CreateEventW(nullptr, FALSE, FALSE, nullptr); ~Event() { if (value) CloseHandle(value); } };
struct StopStream { IAudioClient* client; ~StopStream() { client->Stop(); } };
struct Priority { DWORD task = 0; HANDLE value = AvSetMmThreadCharacteristicsW(L"Audio", &task); ~Priority() { if (value) AvRevertMmThreadCharacteristics(value); } };
std::wstring wide(const std::string& text) {
  const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (!n) throw std::runtime_error("Invalid output device ID");
  std::wstring result(n, L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n); return result;
}
}
Playback::~Playback() { stop(); }
json Playback::start(const std::string& device) {
  stop(); stop_ = false; frames_ = 0; padding_ = 0;
  { std::lock_guard lock(mutex_); device_ = device; reason_ = "starting"; error_.clear(); latencyMs_ = 0; }
  std::promise<std::string> ready; auto future = ready.get_future();
  worker_ = std::thread(&Playback::run, this, device, std::move(ready));
  const auto error = future.get(); if (!error.empty()) { stop(); throw std::runtime_error(error); }
  return status();
}
json Playback::stop() { stop_ = true; if (worker_.joinable()) worker_.join(); running_ = false; padding_ = 0; return status(); }
json Playback::status() {
  std::lock_guard lock(mutex_);
  return {{"running", running_.load()}, {"deviceId", device_}, {"frames", frames_.load()}, {"paddingFrames", padding_.load()}, {"streamLatencyMs", latencyMs_}, {"reason", reason_}, {"error", error_}, {"referenceBlocks", pipeline_.renderedBlocks.load()}, {"droppedReferences", pipeline_.droppedReferences.load()}, {"sampleRate", audio_rate}, {"channels", 1}};
}
void Playback::run(std::string deviceId, std::promise<std::string> ready) {
  bool announced = false;
  try {
    ComScope com;
    ComPtr<IMMDeviceEnumerator> enumerator; check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)), "Enumerator");
    ComPtr<IMMDevice> device;
    if (deviceId == "default") check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device), "Default output");
    else check(enumerator->GetDevice(wide(deviceId).c_str(), &device), "Selected output");
    ComPtr<IMMEndpoint> endpoint; check(device.As(&endpoint), "Endpoint"); EDataFlow flow; check(endpoint->GetDataFlow(&flow), "Output direction");
    if (flow != eRender) throw std::runtime_error("Selected device is not an output endpoint");
    ComPtr<IAudioClient> client; check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())), "Activate output");
    WAVEFORMATEX format{WAVE_FORMAT_IEEE_FLOAT, 1, audio_rate, audio_rate * 4, 4, 32, 0};
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 0, 0, &format, nullptr), "Initialize 48k output");
    Event event; if (!event.value) throw std::runtime_error("Create render event failed");
    check(client->SetEventHandle(event.value), "Set render event");
    UINT32 capacity; check(client->GetBufferSize(&capacity), "Render buffer size");
    REFERENCE_TIME latency; check(client->GetStreamLatency(&latency), "Stream latency");
    { std::lock_guard lock(mutex_); latencyMs_ = latency / 10000.0; reason_ = "running"; }
    ComPtr<IAudioRenderClient> render; check(client->GetService(IID_PPV_ARGS(&render)), "Render service");
    ComPtr<IAudioClock> clock; check(client->GetService(IID_PPV_ARGS(&clock)), "Render clock service");
    UINT64 frequency = 0; check(clock->GetFrequency(&frequency), "Render clock frequency");
    if (!frequency) throw std::runtime_error("Invalid render clock frequency");
    RenderTimeline timeline;
    Priority priority; FrameAssembler assembler; const auto epoch = pipeline_.new_render_epoch();
    const uint64_t total = audio_rate; // One second, fixed low-amplitude diagnostic tone.
    uint64_t submitted = 0;
    std::array<AudioFrame, 64> staged{};
    auto fill = [&](unsigned padding) {
      const auto count = static_cast<UINT32>(std::min<uint64_t>(capacity - padding, total - submitted));
      if (!count) return;
      BYTE* raw = nullptr; check(render->GetBuffer(count, &raw), "Render buffer");
      auto* samples = reinterpret_cast<float*>(raw);
      for (UINT32 i = 0; i < count; ++i) {
        const auto sample = submitted + i;
        const auto fade = std::min({1.0, sample / 960.0, (total - 1 - sample) / 960.0});
        samples[i] = static_cast<float>(0.04 * fade * std::sin(2.0 * 3.141592653589793 * 440.0 * sample / audio_rate));
      }
      // Copy final application-gain PCM into preallocated frames before releasing the WASAPI buffer.
      // ReleaseBuffer must succeed before staging references; output-clock progress gates publication.
      // Each buffer fits a bounded staging area validated below.
      unsigned stagedCount = 0;
      for (UINT32 i = 0; i < count; ++i) assembler.push(samples[i], 0, false, epoch, padding + i,
        [&](const AudioFrame& frame) {
          staged[stagedCount] = frame;
          staged[stagedCount++].streamFrame = submitted + i + 1 - audio_block;
        });
      check(render->ReleaseBuffer(count, 0), "Submit render buffer");
      for (unsigned i = 0; i < stagedCount; ++i)
        if (!timeline.submit(staged[i])) throw std::runtime_error("Render clock reference backlog overflow");
      submitted += count; frames_ = submitted;
    };
    if (capacity > audio_block * 63) throw std::runtime_error("Output buffer too large for bounded reference staging");
    fill(0); check(client->Start(), "Start output"); StopStream stopStream{client.Get()};
    running_ = true; ready.set_value(""); announced = true;
    const auto started = std::chrono::steady_clock::now();
    while (!stop_) {
      if (std::chrono::steady_clock::now() - started > std::chrono::seconds(4)) throw std::runtime_error("Render drain timed out");
      const auto waited = WaitForSingleObject(event.value, 50);
      if (waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT) throw std::runtime_error("Render wait failed");
      UINT64 position = 0, clockQpc = 0;
      const auto clockResult = clock->GetPosition(&position, &clockQpc);
      check(clockResult, "Render clock position");
      // S_FALSE is a low-confidence measurement; wait for an accurate anchor.
      if (clockResult == S_OK && position &&
          !timeline.advance(position, frequency, clockQpc, [&](const AudioFrame& frame) { pipeline_.render(frame); }))
        throw std::runtime_error("Render clock regressed or became invalid");
      UINT32 padding; check(client->GetCurrentPadding(&padding), "Render padding"); padding_ = padding;
      if (submitted == total && padding == 0 && timeline.empty()) break;
      fill(padding);
    }
    { std::lock_guard lock(mutex_); reason_ = stop_ ? "stopped" : "complete"; }
  } catch (const std::exception& error) {
    { std::lock_guard lock(mutex_); reason_ = "error"; error_ = error.what(); }
    if (!announced) ready.set_value(error.what());
  }
  running_ = false; padding_ = 0;
}
