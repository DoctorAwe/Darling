# AEC3 实验链路

日期：2026-10-21。分支：`codex/aec3-experimental`。
状态：已实现官方 AEC3 RTC 实验模式、桌面启动选择及独立构建入口；合成通话通过，首轮离线回声门槛未通过，尚未完成音质验收。

## 确定的处理顺序

```text
麦克风 → AEC3（含残余回声抑制）→ RNNoise／其他独立降噪 → Opus 编码
                    ↑
                 播放参考
```

- 首个实验以项目已锁定并构建的官方 libwebrtc AEC3 为基线，不升级依赖或 SDK。
- 第三方提取版 Enaium/webrtc-aec3 保留为研究、诊断对照，不将其失败候选当作默认配置。
- 关闭 WebRTC 自带 NS，保留独立降噪位置；首轮沿用 RNNoise v0.2，避免同时更换两个变量。
- 保持 AGC 关闭；同一路径不能串联 PBFDAF 与 AEC3，不能叠加 Electron 的音频处理。
- AEC3 内部残余回声抑制与背景降噪不同，不因启用 RNNoise 而移除前者。
- 播放参考必须与实际播放的通话信号及音量语义一致；静音、设备切换和参考中断需要专门测试。
- 保持现有耳机也允许启用 AEC 的策略。

## 隔离与版本边界

当前发布的 beta.7、默认 PBFDAF 链路和远程服务器保持不变。后续实现必须增加显式实验选择，不能仅修改默认处理器。
实验产物使用独立路径，不覆盖正式原生 EXE 或发布包。不得自动开启麦克风或播放测试音。

创建分支时工作区已有稳定版相关的未提交修改，已原样保留；没有自动提交或推送。
因此分支引用本身尚不构成 beta.7 源码快照。后续切换工作区、共享分支或交付前，须明确保存基线，不能声称当前 main 提交已包含全部稳定版修复。

## 实施与验收顺序

1. 加入显式 RTC 实验模式，核对 APM 实际配置与钩子顺序，确保独立降噪确实在 AEC3 后运行。
2. 先用合成输入验证调用顺序、尺度、有限输出和静音控制，不使用声卡。
3. 用同一输入分别运行当前 PBFDAF、官方 AEC3；分别测 AEC 单独处理和 AEC + RNNoise，区分问题来源。
4. 评估远端单讲的回声残留、近端单讲/双讲的人声损伤、弱近端、路径突变、参考欠载及长流漂移；同时记录处理耗时分位数。
5. 在获授权的实际双机测试中检验听感，再决定是否推广。合成 ERLE 数字不等于音质验收；不降低既有门槛来制造通过结果。

## 实际入口

- `node scripts/build-aec3-experiment.mjs`：复用固定 SDK 和现有 GN/Ninja 构建，输出到 `.local/aec3-experiment`，不启动程序或覆盖桌面 dist、发布包。中间产物仍使用现有 WebRTC out 目录。
- `node scripts/start-aec3-experiment.mjs --user=dva --check`：只检查实验产物与配置路径，不登录、不使用设备。
- 去掉 `--check` 才启动独立用户数据目录的客户端；自动登录可能替换同账号会话，主动拨打或接听才启用音频。另一账号使用 `--user=mercy`。
- 原生参数 `--aec3-experimental` 必须配合 `--wasapi-audio` 或 `--synthetic-audio`，与 `--aec` / `--no-aec` 互斥。合成模式仍需额外 `--rnnoise` 才启用降噪。
- 桌面环境变量 `DARLING_AEC_EXPERIMENT=webrtc-aec3` 必须同时指定语音模式和实验 EXE；握手校验 `aecAlgorithm`，旧 EXE 不会被默认为实验模式。
- 官方 APM 自行消费播放参考，不安装自研 reference tap 或 PBFDAF；CapturePostProcessing 执行 RNNoise 和输出保护。建立通话时校验实际 APM 中 AEC 开启、NS/AGC/HPF 关闭。
- `rtc.stats` 报告 `webrtc-aec3`、实际 AEC/NS 配置、后处理帧数和保护次数；后处理帧数不冒充 AEC 内部有效消回声帧数，也不伪造 ERLE 或耗时。

关联记录：`aec3-evaluation.md`、`aec3-upstream-audit.md`、`aec3-batch-results.md`、`pbfdaf-safety-fix.md`。

## 本轮代码检查

- TypeScript 类型检查、原生 Ninja 编译链接、独立桌面打包通过；两个账号的 `--check` 路径检查通过。
- 入口及既有进程/设备控制单元测试共 26 项：22 通过、4 项原生通话相关测试主动跳过。
- 原生新增检查仅发送 hello/shutdown，验证参数互斥和算法标识；没有发送 rtc.open、没有打开音频设备。
- 尚未运行 AEC3 PCM 处理、双端实际连接或音质实验。实际建链配置断言及后处理顺序仍需下一阶段运行验证；编译成功不等于音质或完整通话验收。

## 后续运行验证（2026-10-21）

上述“尚未运行”是实现轮的历史状态，本轮已进行以下验证，不使用实际音频设备，不登录远程账号。

- 发现并修复初始化时序：VoiceEngine::Init 和 AddTrack 创建的发送通道会应用默认 NS/AGC/HPF，覆盖 builder 设置。现在在媒体流启动前恢复实验配置，源 AudioOptions 在协商阶段保持相同策略；保留配置断言，没有降低校验。
- `DARLING_TEST_AEC3_CALL=1 node --import tsx --test tests/aec3-experiment-call.test.ts`：AEC3 单独 / AEC3 + RNNoise 两组合成本机 ICE/DTLS/Opus 通话通过。两端实际 AEC=true，WebRTC NS/AGC1/AGC2/HPF=false；后处理及 RNNoise 帧数递增，采样时输出保护计数为 0。
- 不带 RNNoise 的合成通话验证麦克风静音、对方声音静音及恢复。带 RNNoise 组只验证通路与配置，未宣称静音恢复听感通过：固定纯音可能被降噪器抑制，不能作为人声存活门槛。
- 新入口：构建 `darling_aec_chain_test` 后运行 `darling_aec_chain_test.exe --official-aec3`；20 秒固定种子输入，后 10 秒计能量，遍历所有组合后返回质量失败码 42。

| RNNoise | 声学回声 | 输入/输出能量衰减 dB | 全链路 P95 µs（本次） | 保护次数 | 判定 |
|---|---|---:|---:|---:|---|
| 关 | 无，独立近端随机信号 | 2.593 | 60.5 | 0 | 能量偏差 ≤3 dB 通过，不代表语音保真 |
| 关 | 100 ms 延迟、0.6 增益 | 9.995 | 64.3 | 0 | 未达 ≥15 dB 门槛 |
| 开 | 无，独立近端随机信号 | 54.182 | 222.6 | 0 | 仅有限输出/通路检查通过；噪声被抑制不代表人声保留 |
| 开 | 100 ms 延迟、0.6 增益 | 84.348 | 247.5 | 0 | 组合能量门槛通过，不能归功于 AEC 单独性能 |

输入是低通随机远端/随机近端，不是真实语音，不含双讲、硬件漂移或非线性扬声器。耗时包含每帧 reverse/capture 调用，不是实际电脑总体 CPU 占用。保留失败结果，不调低门槛、不据 RNNoise 的高衰减宣称 AEC 合格。
下一步需要定位 AEC 单独处理的收敛/参考电平/延迟估计，并使用已有授权 near.wav、far.wav 做同输入对照；当前不推广为稳定默认链路。
