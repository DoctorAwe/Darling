# 媒体进程接口边界

## 最新：虚拟接收端解码电平

`rtc.stats` 的 synthetic-audio 条目新增 decodedRms、decodedPeak、maximumPeak，均为 0–1 归一化 PCM 电平。前两项为最近拉取的 10ms 解码/混音输出块，最后一项为本次进程音频会话的最大峰值；不会输出 PCM。其信号可能包含丢包补偿，不构成人声或音质识别。

设备测试主进程每秒采样真实端 outbound Opus 与虚拟端 inbound Opus 及上述电平，以白名单数值结构传到页面。接收总样本可能包含补偿，单独显示 concealedSamples；缺失字段为 null。停止后保留最后采样，下一轮清空，不写录音文件。

## 最新：宿主正常停止策略

`RtcProcessHost.stop()` 立即使请求、轮询和迟到输出失效，再关闭 stdin，利用原生 EOF 路径关闭连接、释放 ADM 并退出。默认等待 2000ms，之后强制终止，返回 graceful/forced/not-running。`close()` 仍用于错误路径的立即终止。协商适配器与应用正常退出改为等待 stop；以下旧段落中的“正常挂断总是立即 kill”已被替代。

显式 WASAPI 诊断模式自子进程启动起限制 60 秒，发出 device-timeout 后执行 stop；UI 尚未消费此事件，真实设备入口仍不开放。虚拟设备回归不能代替实际驱动退出和拔插验收。

## 最新：显式 WASAPI 设备模式（未实测）

`--wasapi-audio` 与 `--synthetic-audio` 互斥。版本 `0.3.0-rtc-diagnostic` 的握手增加 `wasapiAudio`，设备模式为 true，同时 negotiationOnly=false、syntheticAudio=false。rtc/capture/playback 的产品验收标记保持 false；此模式有真实录音/播放副作用，不能仅凭这些 false 标记将其当作无设备测试。

设备模式 `rtc.open` 必须使用 direct/relay，并包含 `deviceAudio:{confirmed:true,inputDeviceId,outputDeviceId,outputProfile:"headphones"|"speakers",noiseSuppression:boolean}`。ID 为明确端点 GUID 字符串，1–127 字符，不接受 default 或 NUL。未确认配置在创建 ADM 前拒绝；非设备模式拒绝 deviceAudio。合法请求会初始化 WASAPI，并在音轨/连接建立过程中打开设备，因此只能在用户明确确认设备测试或通话后发送。

使用独立 Windows Core Audio ADM 构建目标，COM/ADM 在 worker 线程创建与释放。选择输入和输出均按 GUID 精确匹配，失败关闭，不回落默认设备。自动重启关闭；热拔插反馈、设备切换和宿主优雅停止尚待实现。headphones 关闭 AEC、speakers 开启 AEC，NS 按配置，AGC/高通关闭；RAW 及系统 APO 状态未确认，不宣称最优音质。

主进程宿主的最后一个可选参数为 DeviceAudio；仅在参数、显式进程标志、握手三者一致时接入。生产通话适配器未启用此模式。当前验证仅包括编译链接、未确认请求拒绝及既有合成链路，不包括真实采集播放。

## 最新：合成音频模式（不使用物理设备）

显式命令行 `--synthetic-audio` 启用虚拟 ADM，双端各发送不同频率的 48kHz mono 测试音、在内存检查解码输出。默认无此行为。握手版本为 `0.2.0-rtc-diagnostic`，此模式报告 `negotiationOnly:false,syntheticAudio:true`；默认报告 `negotiationOnly:true,syntheticAudio:false`。两者的真实设备/产品通话能力 `rtc/capture/playback` 均为 false，宿主要求启动参数与握手匹配。

`rtc.stats` 最多 30 条标准摘要 + 1 条合成音频摘要 + 1 条候选诊断。新增 inbound-rtp/outbound-rtp 摘要的包计数、Opus codec、接收/隐藏样本计数；合成音频摘要为 `{type:"synthetic-audio",sentBlocks,receivedBlocks,matchedBlocks,errors}`。matchedBlocks 要求解码输出 RMS 超过 100 PCM 单位，且对端频率能量占比超过 80%；每块 10ms。只用于链路验收，不是语音质量指标，不输出 PCM、地址或凭据。

同机直连及公网 TURN UDP/TCP 的双向实际 Opus 收发、对端频率解码检查均已通过。自动直连回退、真实设备与生产通话生命周期仍未接通。

## 最新：强制 TURN 中继扩展及公网验证

下方按阶段保留历史记录；涉及“不支持 ICE/TURN”“尚未接入宿主”的旧描述不代表当前状态。

- `rtc.open` 的 `iceMode` 支持 `disabled|direct|relay`，默认 disabled。relay 使用 relay-only 策略并要求非空 `iceServers`；其余模式不允许非空服务器列表。每项 `{urls:string[],username?:string,credential?:string}`；最多 8 个服务器、每项 1–4 个 URL（每个最多 512 字符，stun:/turn:/turns:），用户名及凭据各最多 256 字符。
- 宿主 relay 模式启动前额外校验配置含 TURN URL，且有效期至少剩余 60 秒；凭据只在主进程与子进程内使用，不进入页面状态。direct/relay 均启用候选轮询，disabled 不启用；apply 队列及接收候选上限均为 128。
- `rtc.stats` 的候选对摘要新增 `localCandidateType` / `remoteCandidateType`，不输出候选地址或凭据。
- 显式运行 `node node_modules/tsx/dist/cli.mjs scripts/test-rtc-relay.ts <客户端配置路径>` 会登录该账号（可能替换已有登录），获取短期 ICE 配置并分别验证 TURN UDP/TCP。2026-10-19 两种模式均已确认双方 relay/relay 提名成功与 DTLS connected；不录音、不发送聊天、不修改服务器。
- 仍使用虚拟 ADM，不代表实际音频 RTP/Opus 已验收；没有自动直连回退。Electron 入口与音频能力门禁不变。

## 更新：同机 ICE/DTLS 验证已通过

此前 checking 根因是独立 Windows 进程遗漏 Winsock 初始化，并非已确认的防火墙问题。补上初始化及错误检查后，显式 direct 测试确认双方成功 nominated 候选对和 DTLS connected（含 UDP 候选）。下面“当前直连失败”的段落保留历史，不再是最新状态。默认依然 disabled；同机成功不代表跨 NAT 或真实语音验收。

新增 `rtc.stats` 同范围请求，响应同名类型，payload 为 `{callId,generation,stats}`。最多31条标准 transport/candidate-pair 摘要，外加1条诊断计数，总数不超过32；只输出类型、状态、收发计数、提名与候选接收/存储数量，不含地址、凭据或 SDP。

## ICE 诊断扩展（尚未连接验收）

rtc.open 增加可选 `iceMode:"disabled"|"direct"`，默认 disabled；direct 启用所有接口（含本机回环）host 候选，无 STUN/TURN。依旧 dummy ADM，rtc/capture/playback 能力保持 false。

- rtc.poll 同范围请求 → rtc.events，payload 包含 callId、generation、candidates（最多16）、connectionState、iceState；候选累计最多128。
- rtc.ice 同范围请求，candidate<=2048、sdpMid非空<=256、sdpMLineIndex 0..255。必须已有远端 SDP；空 candidate 表示结束标记，不向 AddIceCandidate 提交。错误返回 engine.error。
- 宿主显式 direct 模式才轮询（100ms，最多一个轮询在途）；接收候选最多128，远端 SDP 前缓存，成功应用 SDP 后串行提交。apply 总队列上限由8调整为128。转发与状态只在主进程，不暴露 IP 候选到页面。
- `DARLING_TEST_RTC_DIRECT=1` 显式运行 `tests/rtc-process.test.ts` 的本机直连测试。当前该测试失败（双方 checking），默认跳过不代表已通过。Electron 诊断入口仍使用 disabled 模式；切勿开启真实通话。

## Electron 诊断宿主（2026-10-19）

主进程 `RtcProcessHost` 实现受限原生协议，`RtcNegotiation` 绑定 Session 的状态、sendRtcSignal、rtc.signal、rtc.closed。设置 `DARLING_RTC_NEGOTIATION_EXE` 为上述独立 exe 的绝对路径才挂载，默认不启动；它不会解除发起/接听门禁，因此不是可使用的语音模式。

每个 callId 使用新子进程；超时、异常协议、scope 不符、进程退出会失败关闭。挂断/关闭采用终止进程的确定性取消方式，不等待正在处理的 SDP 请求，不依赖旧响应；这是协商原型的清理策略，不是未来真实设备优雅停止流程。允许最多 8 个排队 apply，拒绝 ICE（功能尚未实现）。退出应用/renderer 崩溃均清理，失败同一通话不自动重启。

验证：设置仅当前测试进程环境 `DARLING_TEST_RTC_NATIVE=1`，运行 `node node_modules/tsx/dist/cli.mjs --test tests/rtc-process.test.ts tests/rtc-signaling.test.ts`。默认测试不要求已编译 exe，真实原生测试显式跳过；夹具错误路径仍执行。无真实音频设备访问。

## 独立 RTC 协商原型（2026-10-19）

`darling_rtc_process.exe` 与现有 WASAPI `darling-media` 分离，不替换后者。使用每行一个 JSON，最大 65536 字节；请求/响应均含 `protocolVersion:1`、`requestId`、`type`、`payload`。无异步 ICE 事件，目前不支持真实音频、设备选择、TURN 配置或 ICE 候选命令。

- `engine.hello` → `engine.ready`，明确报告 `negotiationOnly:true, rtc:false, capture:false, playback:false`。
- `rtc.open`：payload `{callId:UUID,generation:1,role:"caller"|"callee"}`；已占用时拒绝，不隐式覆盖当前通话。
- `rtc.offer`：caller 仅一次，生成并应用本地 SDP，响应 `rtc.description`，payload `{callId,generation,kind:"offer",sdp}`。
- `rtc.apply`：同范围 `kind/sdp`；callee 应用 offer 后生成并应用 answer，响应 `rtc.description`；caller 应用 answer 后响应 `rtc.ok`。单步异步等待最多 5 秒，失败关闭当前范围；重复协商拒绝。
- `rtc.close`：仅匹配当前范围时关闭，返回 `rtc.ok`；无当前通话或旧 ID 返回 STALE_CALL。`engine.shutdown` 关闭并退出；stdin EOF 关闭并退出。非法 JSON/信封及超长行直接失败退出。
- 错误响应 `engine.error` payload `{code}`，不回显 SDP/输入内容。

`node scripts/test-rtc-process.mjs` 验证两个真实子进程的受限协商和错误处理；无真实麦克风、STUN/TURN 服务或远程业务服务器。构建依赖已下载的 nlohmann-json 3.12.0 头文件（`native/media-engine/build/_deps/json-src/include`）；正式打包需同时保留其 MIT 许可及 WebRTC 第三方许可。本原型尚未接入 Electron RtcHost，不能打开通话门禁。

## 客户端信令边界（2026-10-19）

Session 主进程新增 `sendRtcSignal(signal)`，返回 Promise 只表示服务器 relay ACK，不表示媒体已连接；内部 `rtc.signal` 事件携带已校验的当前对端信令，`rtc.closed` 携带 `{callId,generation:1}`，未来原生适配器必须据此关闭并丢弃迟到事件。范围仅限 connecting 且未过截止时间的当前通话，发送/接收角色受限，待 ACK 队列上限 16、超时 10 秒。挂断/断线/替换/停止取消待确认请求。没有新增 renderer IPC，也尚未实现原生 stdio 的 RTC 命令；必须等待该适配器和音频通路验证才能打开入口。

0.3.0：新增 playback.start（deviceId）、playback.status、playback.stop，响应 playback.state。固定播放 1 秒低幅度测试音；start 会先停止旧播放。状态包含 frames、paddingFrames、streamLatencyMs、referenceBlocks、droppedReferences、reason/error。关闭面板/退出会停止播放。

capture.state 新增 processing：48000 Hz / 480 samples / mono / bypass，以及累计 captureBlocks、referenceBlocks、droppedReferences、staleReferences。计数为媒体进程生命周期累计值，不是单次测试计数。实时 PCM 留在原生线程之间的有界队列内。提交时间与 padding 仅为后续 AEC 诊断元数据，尚无精确时间对齐。

现有 C++ 源码实现 engine.hello、devices.list、engine.shutdown；Electron 已实现进程管理和设备面板。设备枚举无需录音。语音能力仍为 false，真实原生构建/验证进度见 docs/implementation-status.md。
不得通过浏览器 getUserMedia 替代原生引擎后将能力标为已完成。

stdin/stdout：UTF-8 NDJSON，每行最大 64 KiB。stdout 仅输出协议；stderr 输出诊断。

请求：`{ "protocolVersion": 1, "requestId": "UUID", "type": "engine.hello", "payload": {} }`。
响应关联原 requestId；错误包含 code/message。事件无需 requestId。

预留命令：engine.hello、engine.shutdown、devices.list、devices.select、call.start、call.stop、rtc.offer、rtc.answer、rtc.ice、audio.mute、audio.profile。
预留事件：engine.ready、devices.changed、call.state、rtc.description、rtc.candidate、audio.level、audio.stats、engine.error。

0.2.0 新增已实现命令：capture.start（payload.deviceId 为 default 或输入端点 ID）、capture.status、capture.stop。响应均为 capture.state，包含 running、实际 format、peak/rms、frames、clippedSamples、discontinuities、timestampErrors、reason/error、rawMode。当前 rawMode 固定 not-requested。

capture.start 显式打开麦克风；重复 start 先停止前一采集再打开所选设备。capture.stop 幂等；engine.shutdown 和 stdin EOF 清理采集。客户端轮询 capture.status（约 10 Hz、同一时刻一个状态请求），不通过 stdout 发送音频。诊断自动限制 60 秒。

engine.ready 必须报告真实能力（capture/playback/aec/noiseSuppression/rtc）与依赖版本。
协商命令绑定 callId、generation；不接受旧代事件。不跨 stdio 传 PCM。
audio.level 最多 20 Hz，audio.stats 最多 1 Hz；队列有界，统计可丢弃。

devices.list 响应类型为 devices.listed；设备字段包括 id/name/direction/isDefault/isCommunicationsDefault/mixFormat/rawSupport。mixFormat 为系统共享格式，不是已启用的录音格式；rawSupport 在实测前为 unknown。

下一阶段锁定 libwebrtc/RNNoise commit，再完成 ADM/APM 接入；不使用空实现宣称通过音频验收。
# AEC 显式控制补充（2026-10-18）

引擎握手 capabilities 新增可选 `aecControl`；缺失表示旧引擎不支持模式确认。`aec` 仍表示算法是否可用，不表示当前是否开启。

请求 `processing.set`，payload 为 `{"aecEnabled":false}` 或 `{"aecEnabled":true}`，返回 `capture.state`，其中 `processing.mode` 为 `bypass` 或 `aec3-experimental`。必须先握手，值必须为 boolean；采集或播放运行时拒绝，普通引擎拒绝 true。成功前先停止/join 两路，再选择处理器并清空参考计数。命令本身不打开设备。

新版实验引擎初始为 bypass；调用者必须显式设置 true 才启用 AEC。客户端遇到旧实验引擎缺少 aecControl 时拒绝开始采集，避免无法保证旁路。前端选择不代表实际生效，需核对响应 mode。默认无 AEC 的旧标准引擎仍可用于旁路采集。

