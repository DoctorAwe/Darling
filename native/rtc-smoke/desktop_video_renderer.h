#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>

#include <windows.h>

#include "api/media_stream_interface.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"

namespace darling {

class DesktopVideoRenderer final
    : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  explicit DesktopVideoRenderer(
      webrtc::scoped_refptr<webrtc::VideoTrackInterface> track);
  ~DesktopVideoRenderer() override;

  bool Attach(uintptr_t parent, int x, int y, int width, int height);
  void Resize(int x, int y, int width, int height);
  void OnFrame(const webrtc::VideoFrame& frame) override;
  uint64_t frames() const { return frames_.load(); }
  int width() const { return width_.load(); }
  int height() const { return height_.load(); }
  bool attached() const { return window_.load() != nullptr; }

 private:
  struct Bounds { int x = 0; int y = 0; int width = 1; int height = 1; };
  static LRESULT CALLBACK WindowProc(HWND window, UINT message,
                                     WPARAM wparam, LPARAM lparam);
  void Run(std::stop_token stop, HWND parent);
  void Paint(HWND window);

  webrtc::scoped_refptr<webrtc::VideoTrackInterface> track_;
  std::jthread window_thread_;
  std::atomic<HWND> window_{nullptr};
  std::atomic<uint64_t> frames_{0};
  std::atomic<int> width_{0};
  std::atomic<int> height_{0};
  std::mutex mutex_;
  Bounds bounds_;
  BITMAPINFO bitmap_{};
  std::unique_ptr<uint8_t[]> pixels_;
};

}  // namespace darling
