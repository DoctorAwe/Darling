# PBFDAF 分支迁移（2026-10-20）

**更新：beta.5 实机报告严重回声/炸麦，不能继续视为可用音质版本。**
当前修复为 beta.6 / darling-pbfdaf-v2，详见 `pbfdaf-safety-fix.md`。
下文是 beta.5 首次迁移记录，其中“参数不调优”“欠载重置”等已由安全修复替代。

来源：`D:/WorkSpace/deepseek/project/Darling` 当前工作文件，不覆盖该目录。
迁移 `native/media-engine/src/aec` 算法核心及 `aec_linear_test.cpp`，
参考该分支 `capture_chain.h` / `render_tap.h` 接入当前 RTC 引擎。

## 当前默认链路

WASAPI → PBFDAF 双路径线性滤波 → 残余回声抑制（RES）→ RNNoise → Opus。
播放参考取自 APM render pre-processing。WebRTC 自带 AEC/NS 关闭，
不叠加第二套处理；AGC/高通仍关闭。

按最新用户要求，**耳机也开启 AEC**，替代之前“耳机强制关闭”的规则。
`outputProfile` 仍用于记录设备类型，但不决定是否启用新 AEC。
旧提取版 AEC3 实验引擎保留，不改变其独立诊断开关。

分支默认参数不调优：48 kHz、480 样本块、1024 点 FFT、8 分区、
80 ms 滤波尾、最大 300 ms bulk delay、mu=0.8、双路径、
RES 低/高频增益下限 −18/−30 dB。
除删除一个未使用常量以满足 WebRTC 警告即错误构建外，算法核心保持一致。

## 与分支接入层的差异

- 独立 GN 编译单元，不把 `.cpp` 包含进主文件；固定 SDK 10.0.26100.0。
- SPSC 播放参考队列满时不覆盖消费者正在读取的槽位。溢出/格式变化使
  对齐状态失效，采集侧清空旧参考并重置滤波器和延迟估计。
- 参考欠载时跳过 AEC、重置一次并统计，不拿过期回声估计去减近端人声。
  RNNoise 仍处理；这意味着参考中断时可能短暂残留回声。
- 多声道播放参考取均值；16/32 kHz 采集通过 WebRTC 重采样适配至 48 kHz，
  不再静默绕过 AEC。48 kHz 不额外重采样。格式重建时重置处理状态。
- AEC/RNNoise 独立计时，统计最多 32 项；不保存或上传 PCM。
- 无参数仍支持仅信令模式，不打开设备。常规 `--synthetic-audio` 不启用 AEC；
  `--synthetic-audio --aec [--rnnoise]` 显式测试新链路。
  `--wasapi-audio` 默认启用新 AEC（包括耳机），诊断 `--no-aec` 可显式旁路。

## 验证

- `aec-linear-test`：FFT、延迟、合成回声、RES 门控、近端单讲、Reset 通过。
  合成固定路径/纯延迟的高 ERLE 不代表真实房间性能。
- `render-reference-test`：满队列、清空、50,000 帧并发传输通过。
- `darling_aec_chain_test`：真实 APM 钩子，16/32/48 kHz 与同实例格式切换、
  RNNoise 开/关、缺参考旁路通过；不打开设备。
- 应用测试（启用 `DARLING_TEST_RTC_NATIVE=1`）：84 通过，1 个单独门控的
  direct ICE 测试跳过；包括 AEC/RNNoise 四组合合成双端呼叫。
- TypeScript 类型检查、桌面构建、原生 RTC 构建通过。

## 尚未验收

没有录制麦克风或播放声音；没有把分支文档中的音质数字作为本项目实测。
耳机“有远端参考但麦克风无声学回声”、弱近端双讲、非线性音箱、长混响、
声卡时钟漂移、长通话 CPU/尾延迟仍待验证。当前参考队列没有硬件时间戳
或专门的时钟漂移补偿；欠载/溢出会重置并重新收敛。
不能据此宣称胜过 AEC3，或宣称音质已经验收。

## 构建与测试入口

沿用已有 RNNoise DLL 和 WebRTC 构建环境；`target.patch` 包含新增 GN 目标。
Ninja 目标：`darling_rtc_process darling_aec_chain_test`。
CMake 目标：`aec-linear-test render-reference-test`。
已同步新 RTC EXE 至 `apps/desktop/dist/native`，与构建产物 SHA256 一致：
`A499FF549D2B498EFCAF38029BE9F32D7EEBE5B2B00FB5C1C34FCED672C3EAE7`。
旧发布 ZIP 不会被修改；新打包脚本版本为 `0.5.0-beta.5`，本轮未生成新 ZIP。
