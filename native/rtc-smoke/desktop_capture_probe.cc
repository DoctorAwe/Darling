#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <memory>
#include <mutex>
#include <thread>

#include "modules/desktop_capture/desktop_capture_options.h"
#include "modules/desktop_capture/desktop_capturer.h"
#include "modules/desktop_capture/desktop_frame.h"
#include "desktop_track_source.h"

class Probe final : public webrtc::DesktopCapturer::Callback {
 public:
  void OnCaptureResult(webrtc::DesktopCapturer::Result result,
                       std::unique_ptr<webrtc::DesktopFrame> frame) override {
    std::lock_guard lock(mutex_);
    done_ = true;
    ok_ = result == webrtc::DesktopCapturer::Result::SUCCESS && frame;
    if (frame) {
      width_ = frame->size().width();
      height_ = frame->size().height();
      cursor_ = frame->may_contain_cursor();
    }
    ready_.notify_one();
  }

  bool Wait() {
    std::unique_lock lock(mutex_);
    return ready_.wait_for(lock, std::chrono::seconds(5), [&] { return done_; }) && ok_;
  }
  int width() const { return width_; }
  int height() const { return height_; }
  bool cursor() const { return cursor_; }

 private:
  std::mutex mutex_;
  std::condition_variable ready_;
  bool done_ = false;
  bool ok_ = false;
  bool cursor_ = true;
  int width_ = 0;
  int height_ = 0;
};

int main() {
  auto options = webrtc::DesktopCaptureOptions::CreateDefault();
  options.set_prefer_cursor_embedded(false);
  options.set_allow_wgc_screen_capturer(true);
  options.set_allow_wgc_capturer_fallback(false);
  auto capturer = webrtc::DesktopCapturer::CreateScreenCapturer(options);
  if (!capturer) return 2;
  webrtc::DesktopCapturer::SourceList sources;
  if (!capturer->GetSourceList(&sources) || sources.empty() || !capturer->SelectSource(sources.front().id)) return 3;
  Probe probe;
  capturer->Start(&probe);
  capturer->CaptureFrame();
  if (!probe.Wait()) return 4;
  capturer.reset();
  auto source = darling::DesktopTrackSource::Create();
  if (!source) return 5;
  std::this_thread::sleep_for(std::chrono::milliseconds(250));
  std::printf("{\"ok\":true,\"width\":%d,\"height\":%d,\"mayContainCursor\":%s,\"trackCursorEmbedded\":%s}\n",
              probe.width(), probe.height(), probe.cursor() ? "true" : "false",
              source->cursor_embedded() ? "true" : "false");
  return probe.cursor() || source->cursor_embedded() ? 6 : 0;
}
