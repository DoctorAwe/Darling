# 0.5.0-beta.3

Windows 标记为 headphones/headset 的输出在实际通话和 RTC 设备测试中强制使用 headphones profile，原生 RTC 因此关闭 echo_cancellation。手动 voice:configure 与 RTC 测试入口也不能覆盖此策略。降噪保持开启，其他类型保持原有 AEC 策略。

每次通话按当前默认设备重新判断；不靠设备名称或输入设备类型推测输出类型。驱动误报或未知类型仍是识别限制。本版不修改旧的独立实验采集引擎。

类型检查、构建、80 项自动测试通过，未开启物理音频设备。输出：release/voice-beta-2026-10-20T01-27-56-851Z。此变更不代表 AEC/降噪音质验收通过。
