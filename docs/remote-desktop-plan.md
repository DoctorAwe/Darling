# 远程桌面实现记录

日期：2026-10-22。

## 产品行为

- 远程桌面会话与语音通话独立，互不覆盖状态。
- 控制方发出邀请；被控方必须显式接受，并分别授权“远程操作”和“共享系统声音”。接受前不捕获屏幕、不采集回环声音、不注入输入。
- 控制方使用独立的 Windows 有框窗口，连接后默认最大化。被控方显示置顶小状态栏，可随时撤销操作权限、关闭声音或断开。
- 主窗口也保留连接状态和断开入口。断线、账号被替换、超时、任意一方退出都会撤销权限并关闭附属窗口。

## 网络与媒体路线

- 使用独立 `RTCPeerConnection`。ICE 保持 `all`，让浏览器优先选择 host/srflx 直连候选；直连失败时自动选择现有 TURN UDP/TCP relay 候选。不能把“收到信令”当作直连成功，最终路径以 selected candidate pair 为准。
- 桌面视频优先低延迟和清晰文字：捕获原生桌面分辨率，优先硬件 H.264（实际支持情况由 Chromium 能力协商），禁用无意义的摄像头处理；`contentHint=detail`。
- 直连初始视频预算 20–30 Mb/s；TURN 初始预算 14–18 Mb/s。服务器约 50 Mb/s 时，一路 18 Mb/s 视频的中继收发合计约 36 Mb/s，剩余带宽留给系统声音、控制、协议开销和瞬时重传。
- 每 2 秒读取 WebRTC stats：RTT、丢包、可用发送码率、帧率、编码/解码时间和 selected candidate pair。先降低帧率/码率以控制排队延迟，网络恢复后缓慢回升；不在弱网瞬间频繁切换分辨率。
- 系统声音使用 Windows loopback 捕获并走同一 PeerConnection 的音频轨。控制端可本地静音，被控端关闭共享时必须停止或禁用发送轨。

## 远程控制边界

- 键盘、鼠标和滚轮事件只走已建立的 WebRTC data channel，不经过聊天服务器。
- 主进程校验会话 ID、角色、授权状态、事件类型、坐标范围和速率后，才交给 Windows 原生输入辅助进程；渲染器不能直接调用系统输入 API。
- 坐标以捕获源像素尺寸归一化，处理 DPI、缩放、多显示器原点和窗口 letterbox。
- 被控端撤销“允许远程操作”后立即丢弃后续输入事件；断线时释放所有可能处于按下状态的按键和鼠标按钮。

## 当前完成度

- 已完成协议、服务端独立状态机、信令顺序/角色/候选上限、授权更新、超时与断线清理。
- 已完成主窗口邀请和授权 UI、控制端最大化窗口、被控端置顶状态栏及断开/权限按钮。
- 当前正式客户端仍使用 Chromium 屏幕视频；Windows loopback 系统声音、ICE 直连优先/TURN 回退、selected candidate pair 路径识别、RTT/丢包质量和按路径调整发送码率已经接入。屏幕捕获请求只允许来自已经接受会话的被控端状态窗口。
- 控制数据通道已接入独立的 Windows `SendInput` 辅助进程；只接受白名单键盘、受限鼠标事件，并在撤权、失焦、断开和退出时释放按键。
- 当前画面与绝对坐标明确绑定主显示器；多显示器切换留作后续扩展。
- ICE 同时收集直连与 TURN UDP/TCP 候选；直连优先，但中继连通性检查不会等待会话超时才开始。整体协商失败清理保持 30 秒。
- Windows 优先高性能独显与 Chromium H.264 VideoEncodeAccelerator（NVIDIA 设备通常对应 NVENC），硬件不可用时保留软件回退；实际 GPU/video_encode 状态由诊断测试核验。

## 原生无光标采集迁移

- 已增加基于 WebRTC Windows Graphics Capture 的 `DesktopTrackSource`，明确设置 `prefer_cursor_embedded=false`，并关闭会退回旧采集器的路径；因此不再依赖 Chromium 对桌面媒体约束的处理。
- 已将原生桌面源接入 `darling_rtc_process --desktop-video` 的发送视频轨，并保留 `contentHint=text`。本机 2560×1600 主显示器探针实测 `mayContainCursor=false`、`trackCursorEmbedded=false`。
- 已加入 `--control-data` 原生有序控制 DataChannel：控制端在 offer 前创建，被控端按固定标签接收；单条消息、接收队列和发送缓冲均有硬上限。两个本机原生进程已经通过真实 ICE/DTLS 连接完成控制消息往返。
- 这一步只完成原生采集和发送轨，不代表正式客户端已经切换。下一阶段需要让原生 PeerConnection 同时承载桌面视频、语音与控制 DataChannel，并把接收画面交给控制窗口；完成前不得删除 Chromium 正式链路或宣称客户端已无光标。
- 当前原生轨使用 WebRTC 内置视频编码器工厂，尚未接入 NVENC；硬件编码能力必须以实际编码器选择和运行时统计为准。
