#pragma once

#include <atomic>
#include <memory>
#include <thread>

#include "media/base/adapted_video_track_source.h"
#include "modules/desktop_capture/desktop_capturer.h"

namespace darling {

class DesktopTrackSource : public webrtc::AdaptedVideoTrackSource,
                           private webrtc::DesktopCapturer::Callback {
 public:
  static webrtc::scoped_refptr<DesktopTrackSource> Create();
  ~DesktopTrackSource() override;

  webrtc::MediaSourceInterface::SourceState state() const override;
  bool remote() const override { return false; }
  bool is_screencast() const override { return true; }
  std::optional<bool> needs_denoising() const override { return false; }
  bool cursor_embedded() const { return cursor_embedded_.load(); }

 protected:
  explicit DesktopTrackSource(std::unique_ptr<webrtc::DesktopCapturer> capturer);

 private:
  void Capture(std::stop_token stop);
  void OnCaptureResult(webrtc::DesktopCapturer::Result result,
                       std::unique_ptr<webrtc::DesktopFrame> frame) override;

  std::unique_ptr<webrtc::DesktopCapturer> capturer_;
  std::jthread capture_thread_;
  std::atomic<bool> live_{true};
  std::atomic<bool> cursor_embedded_{true};
};

}  // namespace darling
