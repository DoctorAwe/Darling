# 原生 RTC 构建准备 · 2026-10-19

## 后续：双端 SDP 协商验证通过

`native/rtc-smoke/sdp_smoke.cc` / GN `darling_sdp_smoke`：dummy ADM 两个 PeerConnection，relay-only、无中继服务器，完成 CreateOffer → caller SetLocal → callee SetRemote → CreateAnswer → callee SetLocal → caller SetRemote，异步回调在主线程等待（单步 10 秒），清理回到信令线程。确认双方 stable、无候选回调、Opus SDP 与长度限制，运行退出码 0（offer 1053 / answer 900 bytes）。不打印完整 SDP，不访问真实音频设备，不连接已部署服务。此结果不代表 ICE/DTLS/RTP 连通；客户端及原生进程协议接入尚未完成。

## 后续：PeerConnection / Opus 生命周期检查通过

`native/rtc-smoke/peer_connection_smoke.cc` 通过 `darling_pc_smoke` GN 目标链接完整静态库。网络/工作/信令线程分离，工厂和连接在信令线程创建销毁，3 次创建、添加音频 transceiver、Close，确认关闭状态及候选数量为 0；退出码 0。检查工厂 Opus 发送和接收能力，但未验证实际编码解码输出。dummy ADM，无真实设备访问、无 SDP 设置、无 ICE gathering、无服务端连接。target.patch 已包含两项冒烟目标；实际客户端未变。

## 最新结果：核心编译及 APM 链接运行通过

- 原始核心构建完成全部 3870 步，Ninja 退出码 0。`out/DarlingRelease/obj/webrtc.lib` 为 341,709,726 字节，SHA256 `7C7E9FDD251F6308EDAD58C5AFAE473F0C05EF0C82349DD90F788D029D1880BE`。这是开发用静态库，不是最终客户端体积。
- 新增 `native/rtc-smoke/audio_processing_smoke.cc`，通过 `native/rtc-smoke/target.patch` 在 WebRTC 源码根 BUILD.gn 添加 `darling_apm_smoke`。只依赖完整 `:webrtc` 静态库；使用同一 GN 工具链，避免 CMake/MSVC 与 Chromium libc++ 的 ABI 混用。
- GN 再生成、Ninja 编译链接和程序执行均退出码 0；exe 为 1,470,464 字节。100 帧 x 10ms、48kHz mono 合成输入，启用 AEC/NS、禁用 AGC，检查处理返回值和输出有限性/范围。不访问音频设备或网络，不是音质评测。
- 重现：在 `.local/webrtc/src` 应用 target.patch（已应用不要重复），使用上文环境与显式 Python 执行 GN，然后 `third_party/ninja/ninja.exe -C out/DarlingRelease -j 4 darling_apm_smoke`，运行 `out/DarlingRelease/darling_apm_smoke.exe`。
- 下一阶段：独立原生 RTC 桥接与 PeerConnection/Opus 生命周期验证，再接入现有 WASAPI 数据通路和信令。未替换客户端媒体引擎，真实 AEC/NS 音质、端到端通话仍未验收。

## 最新：GN 生成通过，核心库编译进行中

- 完整依赖同步退出码 0；Git 版本仅有建议更新警告，没有升级 Git 或 SDK。
- 生成 `build/util/LASTCHANGE` 后，以已有 Python 显式作为 GN script-executable，避免重复初始化 vpython。未运行全量 hooks 或下载测试音视频素材。
- 首次 GN 在复制 SDK 调试器 DLL 时失败：缺少 `Debuggers/x64/dbghelp.dll`。遵守禁止安装 SDK 的要求，对本地 `build/vs_toolchain.py` 增加 `DARLING_SKIP_DEBUGGER_COPY=1` 显式开关，仅跳过调试器 DLL 部署。补丁保存在 `native/webrtc-debugger-copy.patch`，应用目录为 `src/build`。此开关仅用于核心静态库验证，不代表崩溃符号化/调试工具可用，不跳过 SDK 头文件/库或编译器检查。
- GN 重试退出码 0：2831 targets / 381 files。输出目录 `.local/webrtc/src/out/DarlingRelease`；参数为 `is_debug=false target_cpu="x64" is_component_build=false rtc_include_tests=false rtc_build_examples=false rtc_build_tools=false use_remoteexec=false use_siso=false`。
- 已启动 `third_party/ninja/ninja.exe -C out/DarlingRelease -j 4 webrtc`，约 3870 步；尚未确认编译完成。使用 VS 2022 路径及上述显式开关，PATH 优先现有构建 Python 和 depot_tools，`DEPOT_TOOLS_WIN_TOOLCHAIN=0`、`DEPOT_TOOLS_UPDATE=0`。
- 未替换客户端媒体引擎，未开启麦克风或验证通话质量。

用户提供本地代理 127.0.0.1:7897，仅以进程级 HTTP_PROXY/HTTPS_PROXY 使用，不改系统代理和全局 Git 配置。

## 已确认

- 官方 WebRTC 源码已浅检出，HEAD=f7126d621eb47305291a912939d064f9cacdc4fa；官方 depot_tools HEAD=d38909eb68d85b91259f4bf20fe5ebcd38461bc2。
- CIPD 客户端已下载（上游引导脚本校验摘要）；构建 Python 3.11.8 chromium.35 包已完成部署，Windows bootstrap 完成。
- CIPD 初次出现 EOF/停顿，在该下载进程设置 GODEBUG=http2client=0 后重试完成。不能由此断定全部网络问题都源于 HTTP/2。
- `scripts/sync-webrtc.ps1` 增加可选 `-Proxy http://127.0.0.1:7897 -DisableHttp2`，PowerShell 语法检查通过；修改仅影响运行该脚本的进程环境。

## 进行中与边界

### 更新：仅使用已有 SDK 26100

用户明确禁止安装或升级其他 SDK。原先需要 SDK 28000 的源码候选已被锁文件替换为：

- WebRTC `refs/branch-heads/7499`：`4e31d1a1ff41bb1b79609c83f998458a111a149c`（2025-12-15）。
- DEPS build：`cf713174ea023af50cba4c1e4c5b450eda181341`。
- 官方 `vs_toolchain.py` 与 `toolchain/win/setup_toolchain.py` 均为 `SDK_VERSION = '10.0.26100.0'`；上游备注 VS 2022 17.13.4 / SDK 26100.4654。本机 rc.exe 为 26100.7705，MSVC 为 14.44.35207，具体组合尚未构建验证。
- 锁文件记录 `allowSdkInstall=false`，同步脚本禁用自动工具链下载，并在 hooks 前核验 SDK 要求。没有安装其他 SDK；之前下载的 SDK 安装器没有执行。
- 重新下载已成功，fetch/checkout 退出码 0，HEAD 已切换并核验为上述固定提交；工作区干净，DEPS 中 build revision 符合锁定值。此前中断遗留的 shallow.lock 在确认没有 Git 进程后改名备份为 shallow.lock.interrupted-*，未删除源码或临时 pack。
- CIPD 辅助工具 ensure 已完成（退出码 0，全部部署完成）。完整 DEPS 依赖仍待同步；主仓库下载成功不代表完整构建环境就绪。

### 后续：完整依赖同步已启动

最新检查：`.gclient_entries` 已生成，Clang 的内容哈希标记和 `clang-cl.exe` 已落盘，Rust 的 `rustc.exe` 已落盘。gclient 正等待 CIPD ensure 部署 GN、Ninja、Siso、reclient 和 LUCI 辅助包；该子进程使用 error 日志级别，未返回完成退出码。GN/Ninja 尚不可用，不能开始生成构建文件。此辅助包清单不包含 Windows SDK；仍未运行 hooks 或编译。

- 通过 `scripts/sync-webrtc.ps1 -Proxy http://127.0.0.1:7897 -DisableHttp2` 启动 `gclient sync --nohooks --no-history --jobs=4`，尚未确认完成。
- 本地 `src/build` 已检出 `cf713174ea023af50cba4c1e4c5b450eda181341`；读取本地两份工具链脚本，均确认 SDK_VERSION 为 `10.0.26100.0`，与此前上游核对一致。
- 仍有依赖下载进程运行；没有运行 hooks、GN 或编译，没有安装或升级 SDK。请勿同时重复启动同一目录的同步。

### 本机工具链探测修正

后续进展：`src/third_party` 的 703,841,737 字节 Git pack 已接收并检出，HEAD 已核验为 `38af9d21c8a7ab4e78a3e9c7024068d769acf5d8`。同步已进入其余子依赖；farmhash 初次 fetch 失败后自动重试成功，HEAD 为 `816a4ae622e964763ca0862d9dbd19324a1eaf45`。同步尚未整体完成；以下停留在 third_party 的描述为此前检查结果。

- 同步仍停留在获取 `src/third_party` 提交 `38af9d21c8a7ab4e78a3e9c7024068d769acf5d8` 的阶段；进程存活，但未返回同步完成结果，不能根据目录存在判定就绪。
- 上游默认从 Program Files 查找 VS 2022，而本机 Build Tools 安装在 Program Files (x86)。同步脚本新增 vswhere 查找已有 VS 2022 C++ 工具、设置进程级 `vs2022_install`，不改系统环境或安装内容。
- 使用上述环境运行 `build/vs_toolchain.py get_toolchain_dir` 成功，返回 VS 2022 / SDK 10.0.26100.0；PowerShell 脚本语法检查通过。
- 本机 SDK 的 `Debuggers/x64/dbghelp.dll` 不存在，上游 `_CopyDebugger` 如被调用会报错。尚未运行 GN，不能断定此路径必定影响目标库；不得通过安装其他 SDK 解决。

选择较旧官方版本避免先行强改 SDK 检查，但仍需验证构建与 API 兼容性。尚未运行 GN、编译或替换现有媒体程序。

### 之前的候选记录（已被上述约束替代）

已启动 gclient 无 hooks 的依赖同步，尚未确认完成；不要同时重复启动同一 checkout 的同步。D 盘观察到约 86 GiB 空闲。尚未生成 GN、编译或替换现有媒体程序，也未启动音频设备。

源码 DEPS 固定 build revision 8f4d213ca23327067940282e2e896084844aa7a8，其 vs_toolchain.py 的 SDK_VERSION 为 10.0.28000.0；本机 Include 为 10.0.26100.0。脚本包含 VS 2022/2026 探测映射，不能仅凭该映射就断言 VS 2022 的完整构建已获支持。后续需核对 setup_toolchain.py/GN 并处理 SDK 差异，当前未升级系统工具链。

这份进度不代表完整 RTC 依赖或编译已成功，客户端语音入口仍禁用。
