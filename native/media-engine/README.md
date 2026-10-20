# Darling 原生媒体基础

当前版本 0.3.0 已支持 48 kHz 单声道/10 ms 处理帧，以及原生播放参考队列。`pnpm native:duplex-smoke` 会短暂开启麦克风并播放 1 秒低幅度提示音，验证参考块被采集处理接口消费；不在默认测试中运行。

处理器目前是明确的 bypass（直通），AEC、降噪、RTC 未接入。WASAPI 按需完成共享格式转换，未请求 RAW。参考位于应用增益之后、系统混音/设备效果之前，提交时间不等于声学播放时间；其他应用声音也不包含在参考中。

播放测试可以单独运行。没有采集消费者时，64 帧参考队列可能填满并增加丢弃计数，这是诊断可见的有限缓冲行为。开始新的播放会增加 epoch；采集侧丢弃旧 epoch 和超过 500 ms 的参考。所有统计随进程累计。

C++20 Windows 子进程，当前提供协议握手、真实 MMDevice/WASAPI 设备格式检查，以及显式启动的共享模式麦克风电平测试。枚举不会 Initialize/Start 音频流；capture.start 才开启采集。

需要 Visual Studio 2022 C++ Build Tools、Windows SDK、CMake。仓库根目录执行 `pnpm native:build`，输出到 `apps/desktop/dist/native/darling-media.exe`。也可通过 DARLING_MEDIA_ENGINE 指定现有可执行文件路径。

编译后运行 `pnpm native:smoke`，对真实 exe 完成握手、设备枚举和正常退出；仅打印设备数量与能力，不输出设备标识。不具备可执行文件时明确失败，不跳过后宣称成功。

CMake 下载固定发行版 nlohmann/json 3.12.0。首次配置需要访问 GitHub。原生代码使用该依赖的 MIT 许可证，分发时应携带其 LICENSE.MIT；本阶段尚未制作分发安装包。

构建已在本机 MSVC 19.44 / Windows SDK 10.0.26100.0 验证通过。依赖下载固定 SHA-256，超时后明确失败；安装步骤会复制第三方许可证至 native/licenses。

客户端点击“音频设备”→“检测 / 刷新设备”启动进程。0.2.0 报告 devices/capture=true，播放、AEC、降噪、RTC 仍为 false。界面不允许发起语音。

选择输入设备后点击“开始麦克风测试”，独立线程以 WASAPI 共享事件模式采集，只计算峰值/RMS、帧数和异常标记。没有 PCM 文件、网络传输或回放。点击停止、关闭面板、退出程序会释放采集；测试最长 60 秒，无数据 3 秒报错停止。默认设备在开始时解析，热插拔不会自动切换正在测试的设备。

`pnpm native:capture-smoke` 会明确打开真实麦克风约两秒，验证收帧、停止和重启；它不在默认测试套件中。当前采集使用设备共享格式，RAW 未请求、无重采样、无 AEC/NS/AGC，不代表最终通信处理链。

构建会执行 CTest 电平算法测试，覆盖 float32、PCM16/24/32、静音包、削波和非有限样本。实时线程不做 JSON 编码或 IPC；控制线程通过 capture.status 读取统计，客户端最多约 10 Hz 更新。长时间稳定性、真实热拔插、故障驱动超时和 CPU 预算仍待进一步测试。

当前设备热插拔通过刷新按钮重新枚举；尚未实现 IMMNotificationClient 事件。RAW 支持状态保持 unknown，位深显示为共享格式容器位深，不宣称硬件有效位深。

进程管理层测试使用 tests/fixtures/media-child.mjs，仅测试 IPC 故障与分段解析，不替代真实 Windows 原生测试。
