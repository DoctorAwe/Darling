// In-process SDP round trip. Dummy audio, relay-only ICE, no TURN servers.
#include <chrono>
#include <cstdio>
#include <future>
#include <memory>
#include <string>
#include <utility>
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
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "rtc_base/win32_socket_init.h"

using namespace std::chrono_literals;
class PeerObserver : public webrtc::PeerConnectionObserver {
 public:
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate*) override { ++candidates; }
  int candidates = 0;
};
class DescriptionObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  std::promise<std::string> result;
  void OnSuccess(webrtc::SessionDescriptionInterface* raw) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> description(raw);
    std::string sdp;
    if (!description->ToString(&sdp)) sdp.clear();
    result.set_value(std::move(sdp));
  }
  void OnFailure(webrtc::RTCError) override { result.set_value(""); }
};
class AppliedObserver : public webrtc::SetSessionDescriptionObserver {
 public:
  std::promise<bool> result;
  void OnSuccess() override { result.set_value(true); }
  void OnFailure(webrtc::RTCError error) override {
    std::fprintf(stderr, "SDP rejected: %s\n", error.message());
    result.set_value(false);
  }
};

int main() {
  webrtc::WinsockInitializer winsock;
  if (winsock.error() != 0) return 9;
  if (!webrtc::InitializeSSL()) return 1;
  auto network = webrtc::Thread::CreateWithSocketServer();
  auto worker = webrtc::Thread::Create();
  auto signaling = webrtc::Thread::Create();
  if (!network->Start() || !worker->Start() || !signaling->Start()) return 2;
  PeerObserver caller_observer, callee_observer;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> caller, callee;
  signaling->BlockingCall([&] {
    webrtc::PeerConnectionFactoryDependencies deps;
    deps.env = webrtc::CreateEnvironment();
    deps.network_thread = network.get();
    deps.worker_thread = worker.get();
    deps.signaling_thread = signaling.get();
    deps.adm = webrtc::CreateAudioDeviceModule(*deps.env, webrtc::AudioDeviceModule::kDummyAudio);
    deps.audio_encoder_factory = webrtc::CreateAudioEncoderFactory<webrtc::AudioEncoderOpus>();
    deps.audio_decoder_factory = webrtc::CreateAudioDecoderFactory<webrtc::AudioDecoderOpus>();
    deps.audio_processing_builder = std::make_unique<webrtc::BuiltinAudioProcessingBuilder>();
    webrtc::EnableMedia(deps);
    factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
    if (!factory) return;
    webrtc::PeerConnectionInterface::RTCConfiguration config;
    config.type = webrtc::PeerConnectionInterface::kRelay;
    auto a = factory->CreatePeerConnectionOrError(config, webrtc::PeerConnectionDependencies(&caller_observer));
    auto b = factory->CreatePeerConnectionOrError(config, webrtc::PeerConnectionDependencies(&callee_observer));
    if (!a.ok() || !b.ok()) return;
    caller = a.MoveValue(); callee = b.MoveValue();
    caller->SetAudioRecording(false); caller->SetAudioPlayout(false);
    callee->SetAudioRecording(false); callee->SetAudioPlayout(false);
    if (!caller->AddTransceiver(webrtc::MediaType::AUDIO).ok()) {
      caller->Close(); caller = nullptr;
    }
  });
  auto create = [&](bool offer) {
    auto observer = webrtc::make_ref_counted<DescriptionObserver>();
    auto future = observer->result.get_future();
    signaling->BlockingCall([&] {
      webrtc::PeerConnectionInterface::RTCOfferAnswerOptions options;
      if (offer) caller->CreateOffer(observer.get(), options);
      else callee->CreateAnswer(observer.get(), options);
    });
    return future.wait_for(10s) == std::future_status::ready ? future.get() : std::string();
  };
  auto apply = [&](webrtc::PeerConnectionInterface* pc, bool local, webrtc::SdpType type, const std::string& sdp) {
    auto observer = webrtc::make_ref_counted<AppliedObserver>();
    auto future = observer->result.get_future();
    bool parsed = false;
    signaling->BlockingCall([&] {
      auto description = webrtc::CreateSessionDescription(type, sdp);
      if (!description) return;
      parsed = true;
      if (local) pc->SetLocalDescription(observer.get(), description.release());
      else pc->SetRemoteDescription(observer.get(), description.release());
    });
    return parsed && future.wait_for(10s) == std::future_status::ready && future.get();
  };
  int status = 0;
  if (!caller || !callee) status = 3;
  std::string offer, answer;
  if (!status) {
    offer = create(true);
    if (offer.empty() || offer.size() > 24000 || offer.find("opus/48000/2") == std::string::npos ||
        offer.find("m=video") != std::string::npos) status = 4;
  }
  if (!status && (!apply(caller.get(), true, webrtc::SdpType::kOffer, offer) ||
                  !apply(callee.get(), false, webrtc::SdpType::kOffer, offer))) status = 5;
  if (!status) {
    answer = create(false);
    if (answer.empty() || answer.size() > 24000 || answer.find("opus/48000/2") == std::string::npos) status = 6;
  }
  if (!status && (!apply(callee.get(), true, webrtc::SdpType::kAnswer, answer) ||
                  !apply(caller.get(), false, webrtc::SdpType::kAnswer, answer))) status = 7;
  signaling->BlockingCall([&] {
    if (!status && (caller->signaling_state() != webrtc::PeerConnectionInterface::kStable ||
                    callee->signaling_state() != webrtc::PeerConnectionInterface::kStable ||
                    caller_observer.candidates || callee_observer.candidates)) status = 8;
    if (caller) caller->Close();
    if (callee) callee->Close();
    caller = nullptr; callee = nullptr; factory = nullptr;
  });
  signaling->Stop(); worker->Stop(); network->Stop();
  webrtc::CleanupSSL();
  if (status) { std::printf("FAIL: SDP stage %d\n", status); return status; }
  std::printf("PASS: audio Opus offer/answer applied; both stable; offer=%zu answer=%zu bytes; dummy audio, no relay servers. Not a media connectivity test.\n", offer.size(), answer.size());
  return 0;
}
