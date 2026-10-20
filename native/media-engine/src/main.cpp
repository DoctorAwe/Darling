#include "devices.h"
#include "capture.h"
#include "playback.h"
#ifdef DARLING_REALTIME_AEC3
#include "aec3_processor.h"
#endif
#include <windows.h>
#include <objbase.h>
#include <iostream>
#include <string>

using nlohmann::json;
constexpr size_t max_line = 64 * 1024;
void send(const std::string& type, const std::string& request, const json& payload) {
  const json packet = {{"protocolVersion", 1}, {"requestId", request}, {"type", type}, {"payload", payload}};
  const auto line = packet.dump();
  if (line.size() > max_line) throw std::runtime_error("Response exceeds protocol limit");
  std::cout << line << '\n' << std::flush;
}
void error(const std::string& request, const std::string& code, const std::string& message) {
  send("engine.error", request, {{"code", code}, {"message", message}});
}
int main() {
  const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { std::cerr << "COM initialization failed\n"; return 1; }
  bool ready = false;
#ifdef DARLING_REALTIME_AEC3
  Aec3Processor aec;
  AudioPipeline pipeline; // Explicit opt-in per session; never infer from device name.
  bool playbackUsed = false;
  constexpr bool hasAec = true;
  constexpr const char* version = "0.4.1-aec3-experimental";
#else
  AudioPipeline pipeline;
  constexpr bool hasAec = false;
  constexpr const char* version = "0.3.1";
#endif
  Capture capture(pipeline);
  Playback playback(pipeline);
  std::string line;
  char ch;
  while (std::cin.get(ch)) {
    if (ch != '\n') {
      if (line.size() >= max_line) { std::cerr << "Input exceeds protocol limit\n"; CoUninitialize(); return 2; }
      line.push_back(ch); continue;
    }
    std::string request;
    try {
      const auto packet = json::parse(line);
      if (!packet.is_object() || !packet.contains("requestId") || !packet["requestId"].is_string()) throw std::runtime_error("Missing requestId");
      request = packet["requestId"].get<std::string>();
      if (request.empty() || request.size() > 128) { request.clear(); throw std::runtime_error("Invalid requestId"); }
      if (packet.value("protocolVersion", 0) != 1) { error(request, "VERSION_MISMATCH", "Unsupported protocol version"); }
      else if (!packet.contains("payload") || !packet["payload"].is_object()) { error(request, "INVALID_PACKET", "Object payload required"); }
      else {
        const auto type = packet.value("type", std::string());
        if (type == "engine.hello") {
          ready = true;
          send("engine.ready", request, {{"engineVersion", version}, {"capabilities", {{"devices", true}, {"capture", true}, {"playback", true}, {"aec", hasAec}, {"aecControl", true}, {"noiseSuppression", false}, {"rtc", false}}}, {"dependencies", {{"json", NLOHMANN_JSON_VERSION_MAJOR}, {"libwebrtc", hasAec ? json("extracted-aec3-2cec2f52") : json(nullptr)}, {"rnnoise", nullptr}}}});
        } else if (!ready) error(request, "HANDSHAKE_REQUIRED", "Send engine.hello first");
        else if (type == "devices.list") send("devices.listed", request, enumerate_devices());
        else if (type == "processing.set") {
          if (!packet["payload"].contains("aecEnabled") || !packet["payload"]["aecEnabled"].is_boolean())
            throw std::runtime_error("Boolean aecEnabled required");
          const bool enabled = packet["payload"]["aecEnabled"].get<bool>();
          if (enabled && !hasAec) throw std::runtime_error("AEC unavailable in this engine");
          if (capture.status().value("running", false) || playback.status().value("running", false))
            throw std::runtime_error("Stop capture and playback before changing AEC");
          playback.stop(); capture.stop(); // Join even workers already reporting stopped.
#ifdef DARLING_REALTIME_AEC3
          aec.reset(); playbackUsed = false;
          pipeline.select_processor(enabled ? &aec : nullptr, "aec3-experimental");
#else
          pipeline.select_processor(nullptr, "bypass");
#endif
          send("capture.state", request, capture.status());
        }
        else if (type == "capture.start") {
          const auto id = packet["payload"].value("deviceId", std::string("default"));
          if (id.empty() || id.size() > 4096) throw std::runtime_error("Invalid deviceId");
#ifdef DARLING_REALTIME_AEC3
          playback.stop(); capture.stop();
          aec.reset(); pipeline.begin_session(); playbackUsed = false;
#endif
          send("capture.state", request, capture.start(id));
        }
        else if (type == "capture.stop") send("capture.state", request, capture.stop());
        else if (type == "capture.status") send("capture.state", request, capture.status());
        else if (type == "playback.start") {
          const auto id = packet["payload"].value("deviceId", std::string("default"));
          if (id.empty() || id.size() > 4096) throw std::runtime_error("Invalid output deviceId");
#ifdef DARLING_REALTIME_AEC3
          if (!capture.status().value("running", false) || playbackUsed)
            throw std::runtime_error("Experimental AEC requires a fresh capture session before each playback");
          playbackUsed = true;
#endif
          send("playback.state", request, playback.start(id));
        }
        else if (type == "playback.stop") send("playback.state", request, playback.stop());
        else if (type == "playback.status") send("playback.state", request, playback.status());
        else if (type == "engine.shutdown") { playback.stop(); capture.stop(); send("engine.stopped", request, json::object()); break; }
        else error(request, "UNSUPPORTED_COMMAND", "Unsupported media command");
      }
    } catch (const std::exception& e) { error(request, "REQUEST_FAILED", e.what()); }
    line.clear();
  }
  playback.stop(); capture.stop(); CoUninitialize(); return 0;
}
