# 通话协调第一阶段 · 2026-10-18

已接入现有已鉴权 WebSocket，不传音频、不打开设备。客户端 UI/主进程已接入状态同步和拒绝/结束控制；原生 RTC 尚未接入，当前不能实际语音通话。

## 协议

沿用 version=1、UUID requestId、type、payload 信封。

- `call.invite {}`：对方必须在线。服务端分配 callId，固定 caller/callee。重复或交叉邀请返回当前同一通话，不隐式接听、不延长超时。
- `call.accept {callId}`：仅被叫可接听；进入 connecting，重复接听返回当前状态，不延长超时。
- `call.end {callId}`：振铃期间主叫为 cancelled、被叫为 rejected；connecting 期间为 hangup。
- `call.sync {}`：读取当前通话，无通话返回 null。
- `call.state {call}`：请求确认含 requestId；状态变更向双方推送不含 requestId。同一操作可能收到推送和确认，后续客户端必须按 callId/状态归并。

CallState 含 callId、caller、callee、phase、deadline（服务端 Unix 毫秒）；结束推送附 reason。结束后清空当前房间，不持久化历史；旧 callId 返回 STALE_CALL，不影响下一轮。未登录、旧会话、离线对端、主叫自接听均拒绝。

## 生命周期边界

ringing 与 connecting 各 30 秒超时。connecting 仅表示已接听、等待媒体，绝不意味着音频连通；暂不提供 active。服务端重启不恢复旧通话。

## 初次 RTC 协商转发

新增 `rtc.signal`，payload 为 `{callId,generation:1,kind:'offer'|'answer',sdp}` 或 `{callId,generation:1,kind:'ice',candidate,sdpMid,sdpMLineIndex}`。只允许当前 connecting 通话；主叫唯一 offer 在前、被叫唯一 answer 在后。每端提交自己的描述之后才允许发送 ICE，包括空字符串的候选收集结束标记。未来原生适配器应短暂缓存早到的本地 ICE，并按此顺序提交；当前不提供客户端缓存或 ICE restart。

服务端只向对端推送 `{type:'rtc.signal',payload:{sender,signal}}`，sender 来自已鉴权连接；发送者收到带 requestId 的 `rtc.ack`。确认只表示已交给 WebSocket 发送，不表示对端解析成功或媒体已连接。SDP 最多 24000 字符，candidate 最多 2048，每端每轮最多 128 个 ICE 消息；仍受 WebSocket 64 KiB 总包限制。结束通话重置所有计数；信令不延长连接截止时间，不落盘，不解析 SDP 媒体语义。

此接口通过合成 SDP 文本和本地真实 WebSocket 验证，不代表 SDP 有效性或 WebRTC 互通已通过。桌面发送入口、原生 PeerConnection/Opus 仍未接入，发起/接听继续禁用。TURN 配置下发已实现，部署说明见 `../deploy/debian/TURN.md`；真实中继尚未验证。

当前断线立即结束；账号替换和服务关闭同样释放通话。架构中的 15 秒媒体恢复窗口尚未实现，待原生 RTC 与客户端会话恢复共同接入后再启用，不能在无媒体状态核对时保留假通话。旧 socket 的迟到关闭不会结束新会话的通话。

## 验证

状态机单测覆盖交叉邀请、角色限制、重复接听、旧 ID、拒绝/取消/挂断以及两个阶段超时。真实本地 WebSocket 测试覆盖鉴权、离线、交叉邀请、接听、账号替换、旧连接关闭与断线释放。未部署远程服务器，未访问声卡。

客户端阶段已完成：登录同步，推送状态归并，断线清空；通话请求独立确认，10 秒超时断线重同步，不自动重试。发起/接听在主进程保持拒绝，UI 接听禁用；拒绝/结束要求当前 callId 且没有在途操作。未开启麦克风。

下一步：接原生 RTC 信令与媒体能力门控；当前硬性门控不得仅凭 rtc 能力位移除，必须完成端到端媒体生命周期。媒体未就绪时不得展示可用语音通话或启动采集。
