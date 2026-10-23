#include "desktop_track_source.h"

#include <chrono>

#include "api/make_ref_counted.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "libyuv/convert.h"
#include "modules/desktop_capture/desktop_capture_options.h"
#include "rtc_base/time_utils.h"

namespace darling {

webrtc::scoped_refptr<DesktopTrackSource> DesktopTrackSource::Create() {
  auto options = webrtc::DesktopCaptureOptions::CreateDefault();
  options.set_prefer_cursor_embedded(false);
  options.set_allow_wgc_screen_capturer(true);
  options.set_allow_wgc_capturer_fallback(false);
  auto capturer = webrtc::DesktopCapturer::CreateScreenCapturer(options);
  if (!capturer) return nullptr;
  webrtc::DesktopCapturer::SourceList sources;
  if (!capturer->GetSourceList(&sources) || sources.empty() ||
      !capturer->SelectSource(sources.front().id)) return nullptr;
  return webrtc::make_ref_counted<DesktopTrackSource>(std::move(capturer));
}

DesktopTrackSource::DesktopTrackSource(
    std::unique_ptr<webrtc::DesktopCapturer> capturer)
    : capturer_(std::move(capturer)) {
  capturer_->Start(this);
  capture_thread_ = std::jthread([this](std::stop_token stop) { Capture(stop); });
}

DesktopTrackSource::~DesktopTrackSource() {
  live_ = false;
  capture_thread_.request_stop();
  if (capture_thread_.joinable()) capture_thread_.join();
}

webrtc::MediaSourceInterface::SourceState DesktopTrackSource::state() const {
  return live_ ? webrtc::MediaSourceInterface::kLive
               : webrtc::MediaSourceInterface::kEnded;
}

void DesktopTrackSource::Capture(std::stop_token stop) {
  auto next = std::chrono::steady_clock::now();
  while (!stop.stop_requested()) {
    capturer_->CaptureFrame();
    next += std::chrono::milliseconds(16);
    std::this_thread::sleep_until(next);
  }
}

void DesktopTrackSource::OnCaptureResult(
    webrtc::DesktopCapturer::Result result,
    std::unique_ptr<webrtc::DesktopFrame> frame) {
  if (result != webrtc::DesktopCapturer::Result::SUCCESS || !frame) return;
  cursor_embedded_ = frame->may_contain_cursor();
  const int width = frame->size().width() & ~1;
  const int height = frame->size().height() & ~1;
  if (width <= 0 || height <= 0) return;
  auto i420 = webrtc::I420Buffer::Create(width, height);
  if (libyuv::ARGBToI420(frame->data(), frame->stride(), i420->MutableDataY(),
                         i420->StrideY(), i420->MutableDataU(), i420->StrideU(),
                         i420->MutableDataV(), i420->StrideV(), width, height)) return;
  OnFrame(webrtc::VideoFrame::Builder()
              .set_video_frame_buffer(i420)
              .set_timestamp_us(webrtc::TimeMicros())
              .set_rotation(webrtc::kVideoRotation_0)
              .build());
}

}  // namespace darling
