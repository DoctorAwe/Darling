#include "devices.h"
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include <memory>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;
using nlohmann::json;
namespace {
void check(HRESULT hr, const char* operation) {
  if (FAILED(hr)) throw std::runtime_error(std::string(operation) + " failed (HRESULT " + std::to_string(static_cast<unsigned long>(hr)) + ")");
}
std::string utf8(const wchar_t* value) {
  if (!value || !*value) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (!size) throw std::runtime_error("Invalid device name encoding");
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), size, nullptr, nullptr);
  result.pop_back(); return result;
}
struct CoFree { void operator()(void* p) const { CoTaskMemFree(p); } };
std::string device_id(IMMDevice* device) {
  LPWSTR raw = nullptr; check(device->GetId(&raw), "GetId");
  std::unique_ptr<wchar_t, CoFree> id(raw); return utf8(id.get());
}
std::string default_id(IMMDeviceEnumerator* enumerator, EDataFlow flow, ERole role) {
  ComPtr<IMMDevice> device;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(flow, role, &device))) return {};
  return device_id(device.Get());
}
const char* form_factor(ULONG value) {
  switch (value) {
    case Headphones: return "headphones";
    case Headset: return "headset";
    case Speakers: return "speakers";
    case Handset: return "handset";
    case Microphone: return "microphone";
    case LineLevel: return "line-level";
    case SPDIF: return "digital";
    case DigitalAudioDisplayDevice: return "display";
    default: return "unknown";
  }
}
json describe(IMMDevice* device, const char* direction, const std::string& normal, const std::string& communications) {
  const auto id = device_id(device);
  json result = {{"id", id}, {"name", id}, {"direction", direction}, {"isDefault", id == normal},
    {"isCommunicationsDefault", id == communications}, {"mixFormat", nullptr}, {"rawSupport", "unknown"}, {"formFactor", "unknown"}};
  ComPtr<IPropertyStore> properties;
  if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &properties))) {
    PROPVARIANT name; PropVariantInit(&name);
    if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR) result["name"] = utf8(name.pwszVal);
    PropVariantClear(&name);
    PROPVARIANT form; PropVariantInit(&form);
    if (SUCCEEDED(properties->GetValue(PKEY_AudioEndpoint_FormFactor, &form)) && form.vt == VT_UI4)
      result["formFactor"] = form_factor(form.ulVal);
    PropVariantClear(&form);
  }
  ComPtr<IAudioClient> client;
  if (SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())))) {
    WAVEFORMATEX* raw = nullptr;
    if (SUCCEEDED(client->GetMixFormat(&raw))) {
      std::unique_ptr<WAVEFORMATEX, CoFree> format(raw);
      result["mixFormat"] = {{"sampleRate", format->nSamplesPerSec}, {"channels", format->nChannels}, {"containerBits", format->wBitsPerSample}};
    }
  }
  return result;
}
}
json enumerate_devices() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)), "Create device enumerator");
  json devices = json::array();
  for (const auto flow : {eCapture, eRender}) {
    const auto normal = default_id(enumerator.Get(), flow, eConsole);
    const auto communications = default_id(enumerator.Get(), flow, eCommunications);
    ComPtr<IMMDeviceCollection> collection;
    check(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection), "EnumAudioEndpoints");
    UINT count = 0; check(collection->GetCount(&count), "GetCount");
    for (UINT i = 0; i < count; ++i) {
      ComPtr<IMMDevice> device; check(collection->Item(i, &device), "Get device");
      devices.push_back(describe(device.Get(), flow == eCapture ? "input" : "output", normal, communications));
    }
  }
  return {{"devices", devices}};
}
