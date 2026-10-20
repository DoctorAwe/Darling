# 原生 RTC 构建前检查 · 2026-10-18

本轮未下载完整 libwebrtc，未安装或升级系统工具链，未打开音频设备。

## 空间清理后的准备进展

用户清理后 D 盘空闲约 86.5 GB，改为分阶段尝试，不再以 100 GB 作为硬性门槛。选用项目 `.local/webrtc` 和 `.local/depot_tools`；现有媒体引擎不覆盖。

`native/webrtc-build.lock.json` 固定官方 WebRTC 候选 f7126d621eb47305291a912939d064f9cacdc4fa（2026-10-16）与 depot_tools d38909eb68d85b91259f4bf20fe5ebcd38461bc2。后者浅克隆完成并核对 HEAD；前者完整源码尚未成功获取。候选仅沿用 AEC 审计使用的官方 revision，不代表 Windows RTC 构建已验证。

已提供 `scripts/sync-webrtc.ps1`：校验两份 checkout 的固定 HEAD，禁用 depot_tools 自动更新，将 vpython/CIPD 缓存放在项目内，分离无 hooks 同步与显式 RunHooks，进入同步前检查至少 15 GiB 剩余空间。此底线只是停止下载的保护，不是完整构建足够空间的保证，也没有持续自动监控机制。

准备期间官方源码 fetch 与 CIPD 初始化持续无下载数据，临时文件为 0 字节。对 chrome-infra-packages.appspot.com 与 webrtc.googlesource.com 的独立 curl 连接检查均在 10 秒连接阶段超时；已停止挂起任务，保留可恢复目录。没有改用第三方预编译库，没有开始依赖同步、GN 生成或编译。需要恢复这些官方端点（以及随后 CIPD 使用的存储端点）的网络连通性。

随后重试仍未完成：WebRTC 临时 pack 最终约 16 MB，但目标 tree 无法检出；CIPD 客户端未就绪。确认无 Git 进程后将中断遗留的 shallow.lock 改名保留为 shallow.lock.interrupted-20261018，未删除源码；再次停止挂起下载后，续跑前需检查是否存在新的遗留锁，不能在活跃 Git 进程期间清理。当前未配置 HTTP_PROXY/HTTPS_PROXY，未擅自修改系统代理。

## 本机检查

- D 盘空闲约 5 GB；C 盘约 53.3 GB。项目位于 D 盘，不能直接在现有 .local 下开始大规模同步。
- Git 已安装；VS 2022 Build Tools，MSVC 14.44.35207；Windows SDK Include 10.0.26100.0。
- Windows SDK Debuggers/x64 未发现；当前 PATH 未发现 gn/ninja/python 命令。此项不代表其他目录完全没有工具；depot_tools 可管理自身 Python 等依赖。
- 原生 CMake 工程仍只有 WASAPI 与 AEC 实验构建，不包含完整 libwebrtc PeerConnection/Opus。

## 构建策略与待确认项

使用官方 libwebrtc 源码与 GN/Ninja，不将现有 CMake AEC 提取库当作完整 RTC。需固定 libwebrtc 和 depot_tools 版本，再依据该 revision 的 build/DEPS 验证 VS、SDK、clang 的具体要求；不能根据现有 C++ 编译成功推断 RTC 工具链兼容，也不盲目更新最新 main。

[WebRTC 官方开发说明](https://webrtc.googlesource.com/src/+/main/docs/native-code/development/README.md)说明依赖检出较大并支持 --no-history；Windows 前置说明指向 Chromium 构建指南。当前 [Chromium Windows 指南](https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md)建议至少 100 GB 空间，但这是 Chromium 完整构建基线，不是本项目纯音频 WebRTC 的实测硬性占用量。工程上建议提供至少约 100 GB 空闲的独立构建位置，给源码、工具链、编译中间件与系统余量留空间；所选 revision 的实际峰值仍待测。

下一步需用户提供合适构建位置，或释放磁盘后确认。未授权删除用户文件，不自动把大体积依赖迁入 C 盘。确定路径后依次固定版本、浅检出、同步依赖、生成 Release GN、编译最小 PeerConnection 目标，然后接入自定义 WASAPI 设备与 PCM 链路；在此之前继续禁用通话。
