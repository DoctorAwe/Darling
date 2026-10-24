#include "desktop_video_renderer.h"

#include <algorithm>
#include <chrono>

#include "api/video/i420_buffer.h"
#include "libyuv/convert_argb.h"

namespace darling {
namespace {
constexpr wchar_t kWindowClass[] = L"DarlingRemoteVideoRenderer";
constexpr UINT kResizeMessage = WM_APP + 1;
}

DesktopVideoRenderer::DesktopVideoRenderer(
    webrtc::scoped_refptr<webrtc::VideoTrackInterface> track)
    : track_(std::move(track)) {
  bitmap_.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap_.bmiHeader.biPlanes = 1;
  bitmap_.bmiHeader.biBitCount = 32;
  bitmap_.bmiHeader.biCompression = BI_RGB;
  track_->AddOrUpdateSink(this, webrtc::VideoSinkWants());
}

DesktopVideoRenderer::~DesktopVideoRenderer() {
  track_->RemoveSink(this);
  window_thread_.request_stop();
  if (auto window = window_.load()) PostMessageW(window, WM_CLOSE, 0, 0);
  if (window_thread_.joinable()) window_thread_.join();
}

bool DesktopVideoRenderer::Attach(uintptr_t parent_value, int x, int y,
                                  int width, int height) {
  if (window_thread_.joinable() || width <= 0 || height <= 0) return false;
  auto parent = reinterpret_cast<HWND>(parent_value);
  if (!IsWindow(parent)) return false;
  {
    std::lock_guard lock(mutex_);
    bounds_ = {x, y, width, height};
  }
  window_thread_ = std::jthread(
      [this, parent](std::stop_token stop) { Run(stop, parent); });
  for (int i = 0; i < 100 && !window_.load() && window_thread_.joinable(); ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  return window_.load() != nullptr;
}

void DesktopVideoRenderer::Resize(int x, int y, int width, int height) {
  if (width <= 0 || height <= 0) return;
  {
    std::lock_guard lock(mutex_);
    bounds_ = {x, y, width, height};
  }
  if (auto window = window_.load()) PostMessageW(window, kResizeMessage, 0, 0);
}

void DesktopVideoRenderer::Run(std::stop_token stop, HWND parent) {
  WNDCLASSEXW window_class{sizeof(window_class)};
  window_class.style = CS_OWNDC;
  window_class.lpfnWndProc = WindowProc;
  window_class.hInstance = GetModuleHandleW(nullptr);
  window_class.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  window_class.lpszClassName = kWindowClass;
  RegisterClassExW(&window_class);
  Bounds bounds;
  { std::lock_guard lock(mutex_); bounds = bounds_; }
  HWND window = CreateWindowExW(
      WS_EX_NOACTIVATE, kWindowClass, L"",
      WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS, bounds.x, bounds.y,
      bounds.width, bounds.height, parent, nullptr, GetModuleHandleW(nullptr), this);
  if (!window) return;
  // The Electron stage remains the sole input surface. A disabled child still
  // paints normally but Windows routes pointer/keyboard input to the parent.
  EnableWindow(window, FALSE);
  SetWindowPos(window, HWND_TOP, bounds.x, bounds.y, bounds.width,
               bounds.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  RedrawWindow(window, nullptr, nullptr,
               RDW_INVALIDATE | RDW_ERASE | RDW_UPDATENOW);
  window_.store(window);
  MSG message;
  while (!stop.stop_requested() && GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  if (IsWindow(window)) DestroyWindow(window);
  window_.store(nullptr);
}

LRESULT CALLBACK DesktopVideoRenderer::WindowProc(
    HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  auto* self = reinterpret_cast<DesktopVideoRenderer*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    self = static_cast<DesktopVideoRenderer*>(
        reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(self));
  }
  if (message == WM_NCHITTEST) return HTTRANSPARENT;
  if (message == WM_ERASEBKGND) return 1;
  if (message == kResizeMessage && self) {
    Bounds bounds;
    { std::lock_guard lock(self->mutex_); bounds = self->bounds_; }
    SetWindowPos(window, HWND_TOP, bounds.x, bounds.y, bounds.width,
                 bounds.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    return 0;
  }
  if (message == WM_PAINT && self) { self->Paint(window); return 0; }
  if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(window, message, wparam, lparam);
}

void DesktopVideoRenderer::OnFrame(const webrtc::VideoFrame& frame) {
  auto buffer = frame.video_frame_buffer()->ToI420();
  if (!buffer) return;
  const int width = buffer->width();
  const int height = buffer->height();
  width_.store(width);
  height_.store(height);
  {
    std::lock_guard lock(mutex_);
    if (bitmap_.bmiHeader.biWidth != width ||
        bitmap_.bmiHeader.biHeight != -height) {
      bitmap_.bmiHeader.biWidth = width;
      bitmap_.bmiHeader.biHeight = -height;
      bitmap_.bmiHeader.biSizeImage = width * height * 4;
      pixels_ = std::make_unique<uint8_t[]>(bitmap_.bmiHeader.biSizeImage);
    }
    if (libyuv::I420ToARGB(
            buffer->DataY(), buffer->StrideY(), buffer->DataU(),
            buffer->StrideU(), buffer->DataV(), buffer->StrideV(),
            pixels_.get(), width * 4, width, height) != 0) return;
  }
  ++frames_;
  if (auto window = window_.load()) InvalidateRect(window, nullptr, FALSE);
}

void DesktopVideoRenderer::Paint(HWND window) {
  PAINTSTRUCT paint;
  HDC dc = BeginPaint(window, &paint);
  RECT client;
  GetClientRect(window, &client);
  FillRect(dc, &client, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
  {
    std::lock_guard lock(mutex_);
    const int source_width = bitmap_.bmiHeader.biWidth;
    const int source_height = -bitmap_.bmiHeader.biHeight;
    if (pixels_ && source_width > 0 && source_height > 0) {
      const double scale = std::min(
          static_cast<double>(client.right) / source_width,
          static_cast<double>(client.bottom) / source_height);
      const int width = static_cast<int>(source_width * scale);
      const int height = static_cast<int>(source_height * scale);
      const int x = (client.right - width) / 2;
      const int y = (client.bottom - height) / 2;
      SetStretchBltMode(dc, HALFTONE);
      StretchDIBits(dc, x, y, width, height, 0, 0, source_width,
                    source_height, pixels_.get(), &bitmap_, DIB_RGB_COLORS,
                    SRCCOPY);
    }
  }
  EndPaint(window, &paint);
}

}  // namespace darling
