# RNNoise 接入（2026-10-20）

## 实现

- 固定上游 Xiph RNNoise v0.2，提交和模型 SHA256 见 `native/rnnoise.lock.json`。使用官方常规模型，不使用未注明来源的第三方权重。
- WebRTC `BuiltinAudioProcessingBuilder.SetCapturePostProcessing` 在 AEC、多频带重组之后处理采集数据，WebRTC NS 同时关闭；不叠加双重降噪，不新增 AGC 或硬噪声门。
- RNNoise 使用 48 kHz、480 样本的单声道 10 ms 块。WebRTC AudioBuffer 与 RNNoise 均使用 float S16 幅度范围，无错误的 32768 倍二次缩放。
- 16/32 kHz 处理格式使用 WebRTC sinc 重采样适配；48 kHz 不额外重采样。状态在初始化/格式改变时重建，每次通话独立。非单声道格式拒绝处理。
- Windows 识别为耳机/耳麦仍强制禁用 AEC；降噪开启时用 RNNoise，显式关闭降噪时不创建 RNNoise 处理器。
- RNNoise 编译成独立 DLL，避免与 WebRTC 内置 Opus 的 C 符号冲突。x64 SSE2，无 AVX2 硬要求；静态 CRT，仅依赖 KERNEL32。
- 统计提供 RNNoise 算法名、帧数、累计/最大处理耗时，不包含 PCM。模型在本机运行，无网络推理。

## 构建

使用既有 SDK 10.0.26100.0，不安装或升级 SDK：

```powershell
powershell -NoProfile -File scripts/build-rnnoise.ps1 -Fetch -Proxy http://127.0.0.1:7897
```

首次下载后可省略 `-Fetch`；脚本核对上游提交、源码修改和模型哈希。应用更新后的 `native/rtc-smoke/target.patch` 并用原有 GN 参数重新生成，构建 `darling_rtc_process`、`darling_rnnoise_evaluate`。DLL 必须与 RTC exe 同目录。打包脚本随包附带 DLL、COPYING 与版本清单。

## 本地评测

```powershell
node scripts/evaluate-denoise.mjs resource/near.wav
```

不打开设备，不上传或修改原录音；报告及 float32 输出位于忽略上传的 `.local/denoise-*`。使用前 20 秒，双声道仅在完全相同时提取一个声道。增益诊断独立标注，受峰值限制，不冒充原始电平结果。含静音、合成低频噪声、原电平录音、增益诊断与混噪对照，以及 16/32 kHz 格式检查。

首轮 `.local/denoise-1792478048180/report.json`（48 kHz）：

| 场景 | WebRTC NS | RNNoise |
| --- | --- | --- |
| 合成风扇噪声衰减 | 13.10 dB | 41.41 dB |
| 原电平录音整体 RMS 衰减 | 0.389 dB | -0.012 dB |
| 混噪诊断处理 P95 | 16.0 μs | 147.4 μs |

首轮报告的 `realtimeCpuPercent` 字段实际按墙钟耗时/音频时长计算，不是系统 CPU 计数器；评测程序已更名为 `wallTimeRatioPercent`。RNNoise 首轮噪声测试最大耗时曾达 13.98 ms，不能只凭 P95 宣称无实时长尾。

## 验收边界

最终复测报告：`.local/denoise-1792478332805/report.json`，包含 16/32/48 kHz 格式检查；静音输出为零，合成噪声衰减结果重复一致。48 kHz 非静音 RNNoise P95 约 0.18–0.19 ms，墙钟耗时占音频时长约 1.17–1.32%（不是整机 CPU 百分比）。81 项完整回归通过，包含真实本地信令、RNNoise 开/关的原生合成音频通话及处理帧计数。打包 RTC+RNNoise DLL 无设备启动检查通过。

可试听包：`release/voice-beta-2026-10-20T06-39-37-339Z`，版本 `0.5.0-beta.4`。只更新客户端，不需要服务端更新；未操作 GitHub。

纯噪声抑制改善不等于人声质量通过，RMS 接近也不能证明不吞字。仍缺独立多说话人、键盘瞬态噪声、真实两机试听、AEC 联合声学评测和设备 CPU 长测。离线比对未做时延对齐保真指标，不以混合输出能量下降直接充当 SNR 改善。RNNoise 的窗口及低采样率重采样会带来延迟，需要独立测量。当前为可试听测试版，不是“极致音质已验收”。
