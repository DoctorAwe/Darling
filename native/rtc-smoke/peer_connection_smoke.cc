// Lifecycle verification only: dummy ADM, no SDP applied, no ICE gathering.
#include <cstdio>
#include <memory>
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
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "rtc_base/win32_socket_init.h"

class Observer final : public webrtc::PeerConnectionObserver {
 public:
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate*) override { ++candidates; }
  int candidates = 0;
};

int main() {
  webrtc::WinsockInitializer winsock;
  if (winsock.error() != 0) return 9;
  if (!webrtc::InitializeSSL()) return 1;
  int status = 0;
  {
    auto network = webrtc::Thread::CreateWithSocketServer();
    auto worker = webrtc::Thread::Create();
    auto signaling = webrtc::Thread::Create();
    if (!network->Start() || !worker->Start() || !signaling->Start()) return 2;
    signaling->BlockingCall([&] {
      for (int iteration = 0; iteration < 3; ++iteration) {
        webrtc::PeerConnectionFactoryDependencies deps;
        deps.env = webrtc::CreateEnvironment();
        deps.network_thread = network.get();
        deps.worker_thread = worker.get();
        deps.signaling_thread = signaling.get();
        deps.adm = webrtc::CreateAudioDeviceModule(*deps.env, webrtc::AudioDeviceModule::kDummyAudio);
        if (!deps.adm) { status = 3; return; }
        deps.audio_encoder_factory = webrtc::CreateAudioEncoderFactory<webrtc::AudioEncoderOpus>();
        deps.audio_decoder_factory = webrtc::CreateAudioDecoderFactory<webrtc::AudioDecoderOpus>();
        deps.audio_processing_builder = std::make_unique<webrtc::BuiltinAudioProcessingBuilder>();
        webrtc::EnableMedia(deps);
        auto factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
        if (!factory) { status = 4; return; }
        bool encoder_opus = false, decoder_opus = false;
        for (const auto& codec : factory->GetRtpSenderCapabilities(webrtc::MediaType::AUDIO).codecs)
          encoder_opus |= codec.name == "opus";
        for (const auto& codec : factory->GetRtpReceiverCapabilities(webrtc::MediaType::AUDIO).codecs)
          decoder_opus |= codec.name == "opus";
        if (!encoder_opus || !decoder_opus) { status = 5; return; }
        Observer observer;
        webrtc::PeerConnectionInterface::RTCConfiguration config;
        auto result = factory->CreatePeerConnectionOrError(config, webrtc::PeerConnectionDependencies(&observer));
        if (!result.ok()) { status = 6; return; }
        auto pc = result.MoveValue();
        pc->SetAudioRecording(false);
        pc->SetAudioPlayout(false);
        auto transceiver = pc->AddTransceiver(webrtc::MediaType::AUDIO);
        if (!transceiver.ok()) { pc->Close(); status = 7; return; }
        pc->Close();
        if (pc->signaling_state() != webrtc::PeerConnectionInterface::kClosed || observer.candidates != 0)
          status = 8;
        pc = nullptr;
        factory = nullptr;
        if (status) return;
      }
    });
    signaling->Stop();
    worker->Stop();
    network->Stop();
  }
  webrtc::CleanupSSL();
  if (status) { std::printf("FAIL: lifecycle stage %d\n", status); return status; }
  std::puts("PASS: 3 PeerConnection create/audio-transceiver/close cycles; Opus send+receive available; dummy audio, no ICE gathering.");
  return 0;
}
