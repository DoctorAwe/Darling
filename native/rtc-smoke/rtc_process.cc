// Diagnostic RTC prototype. No physical audio devices; synthetic PCM is opt-in.
#include <chrono>
#include <deque>
#include <future>
#include <iostream>
#include <memory>
#include <string>
#include <nlohmann/json.hpp>
#include "api/audio/builtin_audio_processing_builder.h"
#include "api/audio/create_audio_device_module.h"
#include "api/audio_codecs/audio_decoder_factory_template.h"
#include "api/audio_codecs/audio_encoder_factory_template.h"
#include "api/audio_codecs/opus/audio_decoder_opus.h"
#include "api/audio_codecs/opus/audio_encoder_opus.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/environment/environment_factory.h"
#include "api/peer_connection_interface.h"
#include "api/make_ref_counted.h"
#include "api/stats/rtc_stats_collector_callback.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "rtc_base/win32_socket_init.h"
#include "api/audio_options.h"
#include "api/data_channel_interface.h"
#include "synthetic_audio.h"
#include "rnnoise_processing.h"
#include "capture_chain.h"
#include "aec3_pipeline.h"
#include "modules/audio_device/include/audio_device_factory.h"
#include "rtc_base/win/scoped_com_initializer.h"
#include "desktop_track_source.h"

using Json = nlohmann::json;
using namespace std::chrono_literals;
class Observer : public webrtc::PeerConnectionObserver,
                 public webrtc::DataChannelObserver {
 public:
  Json candidates = Json::array();
  int candidate_count = 0;
  bool overflow = false;
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  webrtc::scoped_refptr<webrtc::DataChannelInterface> control;
  std::deque<std::string> control_messages;
  bool control_overflow = false;
  void AttachControl(webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) {
    if (!channel || channel->label() != "control" || control) return;
    control = std::move(channel);
    control->RegisterObserver(this);
  }
  void ResetControl() {
    if (control) control->UnregisterObserver();
    control = nullptr;
    control_messages.clear();
    control_overflow = false;
  }
  bool SendControl(const std::string& message) {
    return control && control->state() == webrtc::DataChannelInterface::kOpen &&
           control->buffered_amount() <= 1024 * 1024 &&
           control->Send(webrtc::DataBuffer(message));
  }
  const char* ControlState() const {
    return control ? webrtc::DataChannelInterface::DataStateString(control->state()) : "unavailable";
  }
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override {
    AttachControl(std::move(channel));
  }
  void OnStateChange() override {}
  void OnMessage(const webrtc::DataBuffer& buffer) override {
    if (buffer.binary || buffer.size() == 0 || buffer.size() > 4096) {
      control_overflow = true;
      return;
    }
    if (control_messages.size() >= 64) {
      control_overflow = true;
      return;
    }
    control_messages.emplace_back(reinterpret_cast<const char*>(buffer.data.cdata()), buffer.size());
  }
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override {
    auto value = candidate->ToString();
    if (++candidate_count > 128 || value.size() > 2048 || candidate->sdp_mid().size() > 256) { overflow = true; return; }
    candidates.push_back({{"kind", "ice"}, {"candidate", value}, {"sdpMid", candidate->sdp_mid()}, {"sdpMLineIndex", candidate->sdp_mline_index()}});
  }
};
class Created : public webrtc::CreateSessionDescriptionObserver {
 public:
  std::promise<std::string> result;
  void OnSuccess(webrtc::SessionDescriptionInterface* raw) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> description(raw);
    std::string sdp; description->ToString(&sdp); result.set_value(std::move(sdp));
  }
  void OnFailure(webrtc::RTCError) override { result.set_value(""); }
};
class Applied : public webrtc::SetSessionDescriptionObserver {
 public:
  std::promise<bool> result;
  void OnSuccess() override { result.set_value(true); }
  void OnFailure(webrtc::RTCError) override { result.set_value(false); }
};
class Stats : public webrtc::RTCStatsCollectorCallback {
 public:
  std::promise<Json> result;
  void OnStatsDelivered(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    auto all = Json::parse(report->ToJson(), nullptr, false);
    Json filtered = Json::array();
    if (all.is_array()) for (const auto& item : all) {
      if (filtered.size() >= 28) break;
      const auto type = item.value("type", "");
      if (type != "candidate-pair" && type != "transport" && type != "inbound-rtp" && type != "outbound-rtp") continue;
      Json entry = Json::object();
      for (const char* key : {"type", "state", "nominated", "requestsSent", "requestsReceived", "responsesSent", "responsesReceived", "bytesSent", "bytesReceived", "iceState", "dtlsState"})
        if (item.contains(key)) entry[key] = item[key];
      if (item.value("type", "") == "candidate-pair") {
        for (const auto& candidate : all) {
          if (candidate.value("id", "") == item.value("localCandidateId", "")) entry["localCandidateType"] = candidate.value("candidateType", "unknown");
          if (candidate.value("id", "") == item.value("remoteCandidateId", "")) entry["remoteCandidateType"] = candidate.value("candidateType", "unknown");
        }
      }
      filtered.push_back(entry);
      if (type == "inbound-rtp" || type == "outbound-rtp") {
        for (const char* key : {"packetsSent", "packetsReceived", "totalSamplesReceived", "concealedSamples", "audioLevel"})
          if (item.contains(key)) filtered.back()[key] = item[key];
        for (const auto& codec : all)
          if (codec.value("id", "") == item.value("codecId", "")) filtered.back()["codec"] = codec.value("mimeType", "unknown");
      }
    }
    result.set_value(filtered);
  }
};
class Engine {
 public:
  std::unique_ptr<webrtc::Thread> network = webrtc::Thread::CreateWithSocketServer();
  std::unique_ptr<webrtc::Thread> worker = webrtc::Thread::Create();
  std::unique_ptr<webrtc::Thread> signaling = webrtc::Thread::Create();
  Observer peer_observer;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc;
  webrtc::scoped_refptr<webrtc::AudioTrackInterface> local_audio;
  std::string call_id, role;
  bool negotiated = false, answer_applied = false;
  int remote_candidates = 0;
  bool synthetic_enabled = false;
  bool wasapi_enabled = false;
  bool synthetic_denoise = false;
  bool aec_enabled = false;
  bool aec3_enabled = false;
  bool desktop_enabled = false;
  bool control_enabled = false;
  webrtc::scoped_refptr<webrtc::AudioProcessing> experimental_apm;
  std::shared_ptr<darling::Aec3PipelineMetrics> aec3_metrics;
  std::unique_ptr<webrtc::ScopedCOMInitializer> com;
  webrtc::scoped_refptr<webrtc::AudioDeviceModule> device_adm;
  webrtc::scoped_refptr<darling::DesktopTrackSource> desktop_source;
  webrtc::scoped_refptr<webrtc::VideoTrackInterface> local_video;
  webrtc::scoped_refptr<SyntheticAudio> synthetic;
  std::shared_ptr<RnnoiseMetrics> denoise_metrics;
  std::shared_ptr<darling::AecMetrics> aec_metrics;
  bool Start() { return network->Start() && worker->Start() && signaling->Start(); }
  void Close() {
    signaling->BlockingCall([&] { peer_observer.ResetControl(); if (pc) pc->Close(); pc = nullptr; local_audio = nullptr; local_video = nullptr; desktop_source = nullptr; factory = nullptr;
      peer_observer.candidates = Json::array(); peer_observer.candidate_count = 0; peer_observer.overflow = false; });
    if (synthetic) synthetic->Terminate();
    synthetic = nullptr;
    denoise_metrics.reset();
    aec_metrics.reset();
    worker->BlockingCall([&] { experimental_apm = nullptr; device_adm = nullptr; com.reset(); });
    aec3_metrics.reset();
    call_id.clear(); role.clear(); negotiated = false; answer_applied = false;
    remote_candidates = 0;
  }
  ~Engine() { Close(); signaling->Stop(); worker->Stop(); network->Stop(); }
  bool Open(const std::string& id, const std::string& requested_role, bool direct, const Json& servers, const Json& audio) {
    if (!call_id.empty()) return false;
    signaling->BlockingCall([&] {
      webrtc::PeerConnectionFactoryDependencies deps;
      deps.env = webrtc::CreateEnvironment(); deps.network_thread = network.get();
      deps.worker_thread = worker.get(); deps.signaling_thread = signaling.get();
      deps.adm = webrtc::CreateAudioDeviceModule(*deps.env, webrtc::AudioDeviceModule::kDummyAudio);
      if (wasapi_enabled) {
        worker->BlockingCall([&] {
          com = std::make_unique<webrtc::ScopedCOMInitializer>(webrtc::ScopedCOMInitializer::kMTA);
          if (!com->Succeeded()) return;
          // Never silently switch to a different endpoint after removal.
          device_adm = webrtc::CreateWindowsCoreAudioAudioDeviceModule(*deps.env, false);
        });
        if (!device_adm) return;
        deps.adm = device_adm;
      }
      if (synthetic_enabled) {
        synthetic = webrtc::make_ref_counted<SyntheticAudio>(requested_role == "caller");
        deps.adm = synthetic;
      }
      deps.audio_encoder_factory = webrtc::CreateAudioEncoderFactory<webrtc::AudioEncoderOpus>();
      deps.audio_decoder_factory = webrtc::CreateAudioDecoderFactory<webrtc::AudioDecoderOpus>();
      deps.video_encoder_factory = webrtc::CreateBuiltinVideoEncoderFactory();
      deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
      auto apm_builder = std::make_unique<webrtc::BuiltinAudioProcessingBuilder>();
      const bool rnnoise_requested = (wasapi_enabled && audio.value("noiseSuppression", false)) || synthetic_denoise;
      if (aec3_enabled) {
        apm_builder = std::make_unique<darling::Aec3PipelineBuilder>(experimental_apm);
        webrtc::AudioProcessing::Config processing;
        processing.echo_canceller.enabled = true;
        processing.echo_canceller.mobile_mode = false;
        processing.echo_canceller.enforce_high_pass_filtering = false;
        processing.noise_suppression.enabled = false;
        processing.gain_controller1.enabled = false;
        processing.gain_controller2.enabled = false;
        processing.high_pass_filter.enabled = false;
        apm_builder->SetConfig(processing);
        aec3_metrics = std::make_shared<darling::Aec3PipelineMetrics>();
        if (rnnoise_requested) denoise_metrics = std::make_shared<RnnoiseMetrics>();
        apm_builder->SetCapturePostProcessing(std::make_unique<darling::Aec3PostProcessing>(aec3_metrics, denoise_metrics));
      } else if (aec_enabled) {
        aec_metrics = std::make_shared<darling::AecMetrics>();
        if (rnnoise_requested) denoise_metrics = std::make_shared<RnnoiseMetrics>();
        auto reference = std::make_shared<darling::RenderReferenceQueue>();
        apm_builder->SetRenderPreProcessing(std::make_unique<darling::RenderReferenceTap>(reference));
        apm_builder->SetCapturePostProcessing(std::make_unique<darling::CaptureChain>(
            reference, rnnoise_requested, aec_metrics, denoise_metrics));
      } else if (rnnoise_requested) {
        denoise_metrics = std::make_shared<RnnoiseMetrics>();
        apm_builder->SetCapturePostProcessing(std::make_unique<RnnoiseProcessing>(denoise_metrics));
      }
      deps.audio_processing_builder = std::move(apm_builder);
      webrtc::EnableMedia(deps);
      factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
      if (!factory) return;
      if (aec3_enabled) worker->BlockingCall([&] {
        // VoiceEngine::Init applies its own NS/AGC/HPF defaults AFTER Build.
        // Restore the experiment policy before any PeerConnection can record.
        // Track options below preserve this policy during SDP negotiation.
        if (!experimental_apm) return;
        auto actual = experimental_apm->GetConfig();
        actual.echo_canceller.enabled = true;
        actual.echo_canceller.mobile_mode = false;
        actual.echo_canceller.enforce_high_pass_filtering = false;
        actual.noise_suppression.enabled = false;
        actual.gain_controller1.enabled = false;
        actual.gain_controller2.enabled = false;
        actual.high_pass_filter.enabled = false;
        experimental_apm->ApplyConfig(actual);
      });
      if (wasapi_enabled) {
        bool selected = false;
        worker->BlockingCall([&] {
          auto select = [&](bool input, const std::string& wanted) {
            const auto count = input ? device_adm->RecordingDevices() : device_adm->PlayoutDevices();
            for (int i = 0; i < count; ++i) {
              char name[webrtc::kAdmMaxDeviceNameSize]{}, guid[webrtc::kAdmMaxGuidSize]{};
              const auto result = input ? device_adm->RecordingDeviceName(i, name, guid) : device_adm->PlayoutDeviceName(i, name, guid);
              if (result == 0 && wanted == guid)
                return (input ? device_adm->SetRecordingDevice(static_cast<uint16_t>(i)) : device_adm->SetPlayoutDevice(static_cast<uint16_t>(i))) == 0;
            }
            return false;
          };
          selected = select(true, audio["inputDeviceId"]) && select(false, audio["outputDeviceId"]);
        });
        if (!selected) return;
      }
      if (direct) {
        webrtc::PeerConnectionFactoryInterface::Options options;
        // Diagnostic same-host tests may use loopback as well as real adapters.
        options.network_ignore_mask = 0;
        factory->SetOptions(options);
      }
      webrtc::PeerConnectionInterface::RTCConfiguration config;
      config.type = direct ? webrtc::PeerConnectionInterface::kAll : webrtc::PeerConnectionInterface::kRelay;
      for (const auto& item : servers) {
        webrtc::PeerConnectionInterface::IceServer server;
        for (const auto& url : item["urls"]) server.urls.push_back(url.get<std::string>());
        if (item.contains("username")) server.username = item["username"].get<std::string>();
        if (item.contains("credential")) server.password = item["credential"].get<std::string>();
        config.servers.push_back(std::move(server));
      }
      auto result = factory->CreatePeerConnectionOrError(config, webrtc::PeerConnectionDependencies(&peer_observer));
      if (!result.ok()) return;
      pc = result.MoveValue(); pc->SetAudioRecording(synthetic_enabled || wasapi_enabled); pc->SetAudioPlayout(synthetic_enabled || wasapi_enabled);
      if (control_enabled && requested_role == "caller") {
        webrtc::DataChannelInit init;
        init.ordered = true;
        auto channel = pc->CreateDataChannelOrError("control", &init);
        if (!channel.ok()) { pc->Close(); pc = nullptr; return; }
        peer_observer.AttachControl(channel.MoveValue());
      }
      if (desktop_enabled) {
        desktop_source = darling::DesktopTrackSource::Create();
        if (!desktop_source) { pc->Close(); pc = nullptr; return; }
        local_video = factory->CreateVideoTrack(desktop_source, "desktop");
        local_video->set_content_hint(webrtc::VideoTrackInterface::ContentHint::kText);
        if (!pc->AddTrack(local_video, {"desktop"}).ok()) { pc->Close(); pc = nullptr; return; }
      }
      if (synthetic_enabled || wasapi_enabled) {
        webrtc::AudioOptions options;
        options.echo_cancellation = aec3_enabled; options.noise_suppression = false; options.auto_gain_control = false;
        options.highpass_filter = false;
        if (wasapi_enabled) {
          // Exactly one AEC, including on headphones. NS remains external.
          options.echo_cancellation = aec3_enabled;
          options.noise_suppression = false;
        }
        auto source = factory->CreateAudioSource(options);
        auto track = factory->CreateAudioTrack(wasapi_enabled ? "wasapi" : "synthetic", source.get());
        local_audio = track;
        if (!pc->AddTrack(track, {"audio"}).ok()) { pc->Close(); pc = nullptr; }
        if (pc && aec3_enabled) {
          const bool valid = worker->BlockingCall([&] {
            if (!experimental_apm) return false;
            // AddTrack creates the send channel with engine defaults before
            // source options take effect during SDP negotiation. No media is
            // flowing yet; restore the policy here as well.
            auto desired = experimental_apm->GetConfig();
            desired.noise_suppression.enabled = false;
            desired.gain_controller1.enabled = false;
            desired.gain_controller2.enabled = false;
            desired.high_pass_filter.enabled = false;
            experimental_apm->ApplyConfig(desired);
            const auto actual = experimental_apm->GetConfig();
            return actual.echo_canceller.enabled && !actual.echo_canceller.mobile_mode &&
                !actual.noise_suppression.enabled && !actual.gain_controller1.enabled &&
                !actual.gain_controller2.enabled && !actual.high_pass_filter.enabled &&
                !actual.echo_canceller.enforce_high_pass_filtering;
          });
          if (!valid) { pc->Close(); pc = nullptr; }
        }
      } else if (requested_role == "caller" && !pc->AddTransceiver(webrtc::MediaType::AUDIO).ok()) {
        pc->Close(); pc = nullptr;
      }
    });
    if (!pc) { Close(); return false; }
    call_id = id; role = requested_role; return true;
  }
  std::string Create(bool offer) {
    auto observer = webrtc::make_ref_counted<Created>(); auto future = observer->result.get_future();
    signaling->BlockingCall([&] {
      webrtc::PeerConnectionInterface::RTCOfferAnswerOptions options;
      if (offer) pc->CreateOffer(observer.get(), options); else pc->CreateAnswer(observer.get(), options);
    });
    return future.wait_for(5s) == std::future_status::ready ? future.get() : std::string();
  }
  bool Apply(bool local, webrtc::SdpType type, const std::string& sdp) {
    auto observer = webrtc::make_ref_counted<Applied>(); auto future = observer->result.get_future();
    bool parsed = false;
    signaling->BlockingCall([&] {
      auto desc = webrtc::CreateSessionDescription(type, sdp); if (!desc) return;
      parsed = true;
      if (local) pc->SetLocalDescription(observer.get(), desc.release());
      else pc->SetRemoteDescription(observer.get(), desc.release());
    });
    return parsed && future.wait_for(5s) == std::future_status::ready && future.get();
  }
};
bool String(const Json& j, const char* key, size_t maximum) {
  return j.contains(key) && j[key].is_string() && !j[key].get_ref<const std::string&>().empty() && j[key].get_ref<const std::string&>().size() <= maximum;
}
bool Uuid(const std::string& value) {
  if (value.size() != 36) return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
    else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f') || (value[i] >= 'A' && value[i] <= 'F'))) return false;
  }
  return true;
}
bool ServersValid(const Json& servers) {
  if (!servers.is_array() || servers.size() > 8) return false;
  for (const auto& server : servers) {
    if (!server.is_object() || !server.contains("urls") || !server["urls"].is_array() || server["urls"].empty() || server["urls"].size() > 4) return false;
    for (const auto& url : server["urls"]) {
      if (!url.is_string() || url.get_ref<const std::string&>().size() > 512) return false;
      const auto& text = url.get_ref<const std::string&>();
      if (text.rfind("stun:", 0) != 0 && text.rfind("turn:", 0) != 0 && text.rfind("turns:", 0) != 0) return false;
    }
    for (const char* key : {"username", "credential"})
      if (server.contains(key) && (!server[key].is_string() || server[key].get_ref<const std::string&>().size() > 256)) return false;
  }
  return true;
}
int main(int argc, char** argv) {
  bool synthetic = false, wasapi = false, denoise = false, aec = false, no_aec = false, aec3 = false, desktop = false, control = false;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--synthetic-audio" && !synthetic) synthetic = true;
    else if (arg == "--wasapi-audio" && !wasapi) wasapi = true;
    else if (arg == "--rnnoise" && !denoise) denoise = true;
    else if (arg == "--aec" && !aec) aec = true;
    else if (arg == "--aec3-experimental" && !aec3) aec3 = true;
    else if (arg == "--no-aec" && !no_aec) no_aec = true;
    else if (arg == "--desktop-video" && !desktop) desktop = true;
    else if (arg == "--control-data" && !control) control = true;
    else return 6;
  }
  if ((synthetic && wasapi) || (aec && no_aec) || (aec3 && (aec || no_aec)) || (denoise && !synthetic) ||
      ((aec || no_aec || aec3) && !synthetic && !wasapi)) return 6;
  webrtc::WinsockInitializer winsock;
  if (winsock.error() != 0) return 5;
  if (!webrtc::InitializeSSL()) return 1;
  {
    Engine engine;
    engine.synthetic_enabled = synthetic;
    engine.synthetic_denoise = denoise;
    engine.wasapi_enabled = wasapi;
    engine.aec_enabled = !no_aec && (wasapi || aec || aec3);
    engine.aec3_enabled = aec3;
    engine.desktop_enabled = desktop;
    engine.control_enabled = control;
    if (!engine.Start()) std::quick_exit(2);
    bool ready = false;
    std::string line;
    while (true) {
      line.clear(); char c;
      while (std::cin.get(c) && c != '\n') { if (line.size() >= 65536) return 3; line += c; }
      if (!std::cin && line.empty()) break;
      auto request = Json::parse(line, nullptr, false);
      if (request.is_discarded() || !request.is_object() || request.value("protocolVersion", Json()) != 1 ||
          !String(request, "requestId", 64) || !String(request, "type", 64) || !request.contains("payload") || !request["payload"].is_object()) return 4;
      const auto& payload = request["payload"];
      std::string type = request["type"], response_type = "rtc.ok", error;
      Json response = Json::object();
      bool shutdown = false;
      if (type == "engine.hello") {
        ready = true; response_type = "engine.ready";
        response = {{"engineVersion", "0.4.2-aec3-experimental"}, {"aec", engine.aec_enabled},
          {"aecAlgorithm", !engine.aec_enabled ? "none" : engine.aec3_enabled ? "webrtc-aec3" : "darling-pbfdaf-v2"},
          {"negotiationOnly", !engine.synthetic_enabled && !engine.wasapi_enabled},
          {"syntheticAudio", engine.synthetic_enabled}, {"wasapiAudio", engine.wasapi_enabled}, {"desktopVideo", engine.desktop_enabled}, {"desktopCursorEmbedded", false}, {"controlData", engine.control_enabled}, {"rtc", false}, {"capture", false}, {"playback", false}};
      } else if (!ready) error = "HANDSHAKE_REQUIRED";
      else if (type == "engine.shutdown") { engine.Close(); shutdown = true; }
      else if (!String(payload, "callId", 36) || !Uuid(payload["callId"]) || payload.value("generation", Json()) != 1) error = "INVALID_SCOPE";
      else {
        const std::string id = payload["callId"];
        response = {{"callId", id}, {"generation", 1}};
        if (type == "rtc.open") {
          if (!String(payload, "role", 6) || (payload["role"] != "caller" && payload["role"] != "callee")) error = "INVALID_ROLE";
          else if (engine.desktop_enabled && payload["role"] != "callee") error = "DESKTOP_VIDEO_REQUIRES_CALLEE";
          else if (payload.contains("iceMode") && payload["iceMode"] != "direct" && payload["iceMode"] != "disabled" && payload["iceMode"] != "relay") error = "INVALID_ICE_MODE";
          else if (!ServersValid(payload.value("iceServers", Json::array()))) error = "INVALID_ICE_SERVERS";
          else if (payload.value("iceMode", Json()) == "relay" && payload.value("iceServers", Json::array()).empty()) error = "ICE_SERVERS_REQUIRED";
          else if (payload.value("iceMode", Json()) != "relay" && !payload.value("iceServers", Json::array()).empty()) error = "ICE_SERVERS_NOT_ALLOWED";
          else if (engine.wasapi_enabled && payload.value("iceMode", Json()) != "direct" && payload.value("iceMode", Json()) != "relay") error = "DEVICE_AUDIO_REQUIRES_ICE";
          else if (engine.wasapi_enabled && (!payload.contains("deviceAudio") || !payload["deviceAudio"].is_object() ||
            !String(payload["deviceAudio"], "inputDeviceId", 127) || !String(payload["deviceAudio"], "outputDeviceId", 127) ||
            payload["deviceAudio"]["inputDeviceId"] == "default" || payload["deviceAudio"]["outputDeviceId"] == "default" ||
            payload["deviceAudio"]["inputDeviceId"].get_ref<const std::string&>().find('\0') != std::string::npos ||
            payload["deviceAudio"]["outputDeviceId"].get_ref<const std::string&>().find('\0') != std::string::npos ||
            payload["deviceAudio"].value("confirmed", Json()) != true ||
            (payload["deviceAudio"].value("outputProfile", Json()) != "headphones" && payload["deviceAudio"].value("outputProfile", Json()) != "speakers") ||
            !payload["deviceAudio"].contains("noiseSuppression") || !payload["deviceAudio"]["noiseSuppression"].is_boolean())) error = "DEVICE_AUDIO_CONFIRMATION_REQUIRED";
          else if (!engine.wasapi_enabled && payload.contains("deviceAudio")) error = "DEVICE_AUDIO_NOT_ALLOWED";
          else if (!engine.Open(id, payload["role"], payload.value("iceMode", Json()) == "direct", payload.value("iceServers", Json::array()), payload.value("deviceAudio", Json::object()))) error = "OPEN_FAILED_OR_BUSY";
        } else if (engine.call_id != id) error = "STALE_CALL";
        else if (type == "rtc.close") engine.Close();
        else if (type == "rtc.audio") {
          if (!payload.contains("micMuted") || !payload["micMuted"].is_boolean() ||
              !payload.contains("speakerMuted") || !payload["speakerMuted"].is_boolean()) error = "INVALID_AUDIO_CONTROL";
          else engine.signaling->BlockingCall([&] {
            if (!engine.local_audio) { error = "AUDIO_UNAVAILABLE"; return; }
            // Track mute sends silence while keeping AEC/reference processing alive.
            engine.local_audio->set_enabled(!payload["micMuted"].get<bool>());
            for (const auto& receiver : engine.pc->GetReceivers()) {
              auto track = receiver->track();
              if (track && track->kind() == webrtc::MediaStreamTrackInterface::kAudioKind)
                track->set_enabled(!payload["speakerMuted"].get<bool>());
            }
          });
        }
        else if (type == "rtc.data.send") {
          if (!engine.control_enabled || !String(payload, "message", 4096)) error = "INVALID_DATA_MESSAGE";
          else engine.signaling->BlockingCall([&] {
            if (!engine.peer_observer.SendControl(payload["message"])) error = "DATA_CHANNEL_NOT_OPEN";
          });
        }
        else if (type == "rtc.stats") {
          auto callback = webrtc::make_ref_counted<Stats>(); auto future = callback->result.get_future();
          engine.signaling->BlockingCall([&] { engine.pc->GetStats(callback.get()); });
          if (future.wait_for(5s) != std::future_status::ready) error = "STATS_TIMEOUT";
          else { response_type = "rtc.stats"; response["stats"] = future.get();
            if (engine.synthetic) response["stats"].push_back({{"type", "synthetic-audio"},
              {"sentBlocks", engine.synthetic->sent.load()}, {"receivedBlocks", engine.synthetic->received.load()},
              {"matchedBlocks", engine.synthetic->matched.load()}, {"errors", engine.synthetic->errors.load()},
              {"decodedRms", engine.synthetic->decoded_rms.load()}, {"decodedPeak", engine.synthetic->decoded_peak.load()},
              {"maximumPeak", engine.synthetic->maximum_peak.load()}});
            if (engine.denoise_metrics) response["stats"].push_back({
              {"type", "noise-suppression"}, {"algorithm", "rnnoise-v0.2"},
              {"frames", engine.denoise_metrics->frames.load()},
              {"totalUs", engine.denoise_metrics->total_us.load()},
              {"maximumUs", engine.denoise_metrics->maximum_us.load()}});
            if (engine.aec_metrics) response["stats"].push_back({
              {"type", "aec"}, {"algorithm", "darling-pbfdaf-v2"},
              {"frames", engine.aec_metrics->frames.load()},
              {"delaySamples", engine.aec_metrics->delay_samples.load()},
              {"erleDb", engine.aec_metrics->erle_db.load()},
              {"gamma", engine.aec_metrics->gamma.load()},
              {"gain", engine.aec_metrics->gain.load()},
              {"missingReference", engine.aec_metrics->missing_reference.load()},
              {"resets", engine.aec_metrics->resets.load()},
              {"safetyEvents", engine.aec_metrics->safety_events.load()},
              {"outputProtection", engine.aec_metrics->output_protection.load()},
              {"totalUs", engine.aec_metrics->total_us.load()},
              {"maximumUs", engine.aec_metrics->maximum_us.load()}});
            if (engine.aec3_metrics) {
              engine.worker->BlockingCall([&] {
                const auto actual = engine.experimental_apm->GetConfig();
                response["stats"].push_back({{"type", "aec"}, {"algorithm", "webrtc-aec3"},
                  {"experimental", true}, {"enabled", actual.echo_canceller.enabled},
                  {"webrtcNs", actual.noise_suppression.enabled},
                  {"agc1", actual.gain_controller1.enabled}, {"agc2", actual.gain_controller2.enabled},
                  {"highpass", actual.high_pass_filter.enabled},
                  {"postFrames", engine.aec3_metrics->post_frames.load()},
                  {"outputProtection", engine.aec3_metrics->output_protection.load()}});
              });
            }
            engine.signaling->BlockingCall([&] {
              const auto* remote = engine.pc->remote_description();
              response["stats"].push_back({{"type", "diagnostic"}, {"received", engine.remote_candidates},
                {"storedRemote", remote && remote->number_of_mediasections() ? remote->candidates(0)->count() : 0}});
            });
          }
        }
        else if (type == "rtc.poll") {
          engine.signaling->BlockingCall([&] {
            if (engine.peer_observer.overflow) { error = "ICE_LIMIT"; return; }
            if (engine.peer_observer.control_overflow) { error = "DATA_LIMIT"; return; }
            response["candidates"] = Json::array();
            auto& queue = engine.peer_observer.candidates;
            const size_t count = queue.size() < 16 ? queue.size() : 16;
            for (size_t i = 0; i < count; ++i) response["candidates"].push_back(queue[i]);
            queue.erase(queue.begin(), queue.begin() + count);
            response["dataState"] = engine.peer_observer.ControlState();
            response["messages"] = Json::array();
            auto& messages = engine.peer_observer.control_messages;
            const size_t message_count = messages.size() < 16 ? messages.size() : 16;
            for (size_t i = 0; i < message_count; ++i) response["messages"].push_back(messages[i]);
            messages.erase(messages.begin(), messages.begin() + message_count);
            response["connectionState"] = webrtc::PeerConnectionInterface::AsString(engine.pc->peer_connection_state());
            response["iceState"] = webrtc::PeerConnectionInterface::AsString(engine.pc->ice_connection_state());
          });
          response_type = "rtc.events";
        } else if (type == "rtc.ice") {
          if (!payload.contains("candidate") || !payload["candidate"].is_string() || payload["candidate"].get_ref<const std::string&>().size() > 2048 ||
              !String(payload, "sdpMid", 256) || !payload.contains("sdpMLineIndex") || !payload["sdpMLineIndex"].is_number_integer() ||
              payload["sdpMLineIndex"] < 0 || payload["sdpMLineIndex"] > 255) error = "INVALID_ICE";
          else if (++engine.remote_candidates > 128) error = "ICE_LIMIT";
          else engine.signaling->BlockingCall([&] {
            if (!engine.pc->remote_description()) { error = "REMOTE_DESCRIPTION_REQUIRED"; return; }
            if (payload["candidate"] == "") return;
            std::unique_ptr<webrtc::IceCandidate> candidate(webrtc::CreateIceCandidate(payload["sdpMid"], payload["sdpMLineIndex"], payload["candidate"], nullptr));
            if (!candidate || !engine.pc->AddIceCandidate(candidate.get())) error = "ICE_REJECTED";
          });
        }
        else if (type == "rtc.offer" && engine.role == "caller" && !engine.negotiated) {
          auto sdp = engine.Create(true);
          if (sdp.empty() || sdp.size() > 24000 || !engine.Apply(true, webrtc::SdpType::kOffer, sdp)) { error = "OFFER_FAILED"; engine.Close(); }
          else { engine.negotiated = true; response_type = "rtc.description"; response["kind"] = "offer"; response["sdp"] = sdp; }
        } else if (type == "rtc.apply" && String(payload, "sdp", 24000) && String(payload, "kind", 6)) {
          const bool offer = payload["kind"] == "offer";
          if ((offer && (engine.role != "callee" || engine.negotiated)) || (!offer && (payload["kind"] != "answer" || engine.role != "caller" || !engine.negotiated || engine.answer_applied))) error = "UNEXPECTED_DESCRIPTION";
          else if (!engine.Apply(false, offer ? webrtc::SdpType::kOffer : webrtc::SdpType::kAnswer, payload["sdp"])) { error = "DESCRIPTION_FAILED"; engine.Close(); }
          else if (offer) {
            auto sdp = engine.Create(false);
            if (sdp.empty() || sdp.size() > 24000 || !engine.Apply(true, webrtc::SdpType::kAnswer, sdp)) { error = "ANSWER_FAILED"; engine.Close(); }
            else { engine.negotiated = true; response_type = "rtc.description"; response["kind"] = "answer"; response["sdp"] = sdp; }
          } else engine.answer_applied = true;
        } else error = "UNSUPPORTED_COMMAND_OR_STATE";
      }
      if (!error.empty()) { response_type = "engine.error"; response = {{"code", error}}; }
      std::cout << Json({{"protocolVersion", 1}, {"requestId", request["requestId"]}, {"type", response_type}, {"payload", response}}).dump() << '\n' << std::flush;
      if (shutdown) break;
    }
  }
  webrtc::CleanupSSL(); return 0;
}
