# AEC3 上游核对 · 2026-10-17

## 范围和结论

核对提取版 `2cec2f52e26646f93bd2d5498bbabf59cba18da9` 与 [WebRTC 官方固定快照](https://webrtc.googlesource.com/src/+/f7126d621eb47305291a912939d064f9cacdc4fa/) 的 8 个核心文件，不使用浮动 main 作为重现基准。

尚未发现这些文件中能够解释双讲损伤的抑制公式差异。此结论不是整库等价证明，也未追溯出提取版的原始上游提交。双讲质量失败仍然有效，不应因此降低门槛或启用候选配置。

| 文件 | 排除 include 行和空白后的结果 / 人工复核 |
| --- | --- |
| suppression_gain.cc | 一致 |
| dominant_nearend_detector.cc | 一致 |
| erle_estimator.cc | 一致 |
| fullband_erle_estimator.cc | 一致 |
| echo_canceller3_config.h | 一致，包含当前近端检测及抑制阈值默认声明 |
| residual_echo_estimator.cc | 官方多出神经残余估计器初始化耗时的计数与直方图上报；未见该差异改写残余功率公式 |
| subband_erle_estimator.cc | SafeClamp 调用从 rtc::SafeClamp 改为无前缀；函数实现及依赖未在本轮全面验证 |
| signal_dependent_erle_estimator.cc | 同上，4 处 SafeClamp 调用前缀差异 |

文本归一化不是 C++ 语义分析：忽略空白也可能忽略字符串内差异。三份不匹配文件另以 `git diff --no-index --ignore-all-space` 人工检查。没有把遥测或命名空间差异自动删掉以制造“全部相同”。

## 仍有的重要边界

- 提取版 `api/environment.h` 是简化实现，NoOpFieldTrials 的 Lookup 总返回空字符串；不能声称覆盖官方完整运行环境或所有实验分支。
- 提取版 CPU Supports 返回 false；当前未证明 SIMD 性能与官方构建一致。
- 本次不是全依赖链、编译参数、所有头文件、浮点行为或许可证来源的完整审计；也没有编译官方完整 APM 做同输入对照。
- 既有双讲测试使用合成噪声，不是真实语音。下一阶段应加入固定、来源可追溯的语音输入与同输入基线，分别验证近端保真和回声泄漏；不要继续只围绕同一噪声矩阵调参。

## 重现

联网下载固定版本并生成哈希报告：

```powershell
./scripts/audit-aec3-upstream.ps1
```

复用缓存、不联网：

```powershell
./scripts/audit-aec3-upstream.ps1 -Offline
```

报告和原始官方文件保存至 `.local/upstream-audit/f7126d621eb47305291a912939d064f9cacdc4fa/`。report.json 记录两端 SHA-256、固定提交和比较结果。脚本退出成功只代表审计执行成功，不代表音质验收成功。未改动第三方源码、生产参数或默认客户端引擎，未使用麦克风。
