# Darling

最新音频基础：可在“音频设备”面板选择输出并播放 1 秒低幅度测试音；采集已统一为 48 kHz 单声道/10 ms 处理帧。开启麦克风测试后再播放，可检查参考帧消费数量。当前仍为直通模式，不具备回声消除、降噪或网络语音。最新结果见 `docs/implementation-status.md`。

Windows Electron 双人聊天应用，用户为 dva 和 mercy。架构见 [docs/architecture.md](docs/architecture.md)。

## 当前可用范围

配置自动登录、双人文字消息、SQLite 持久化、离线补拉、消息去重、在线状态、重连、持久待发队列，以及 Electron 霓虹风页面。Windows 11 支持时启用系统 Acrylic 和圆角，其他系统深色回退。

语音、截图、文件、远程桌面尚未实现。已加入 C++ 设备检查源码、媒体进程管理与“音频设备”面板；编译说明见 `native/media-engine/README.md`。语音入口明确禁用，原生接口边界记录于 `native/protocol/README.md`。

## 环境与构建

需要 Node.js 24 和 pnpm 11。安装并验证：

```powershell
pnpm install
pnpm check
```

## 启动服务端

复制 `server.config.example.json` 为 `server.config.json`，填写两个用户密码。数据库路径相对于服务端配置文件。

```powershell
pnpm server
```

默认业务地址 `ws://127.0.0.1:8787/ws`，健康检查 `/health`。实际远程使用将 IP 改为 Debian 公网 IP。

## 启动客户端

复制 `config.example.json` 为项目根目录 `config.json`，填写服务器地址、用户名和对应密码，然后：

```powershell
$env:DARLING_CONFIG = (Resolve-Path .\config.json).Path
pnpm build
pnpm desktop
```

未设置 DARLING_CONFIG 时，从 Electron userData 下的 config.json 读取。缺配置时主页面显示路径和错误，不出现登录表单。修改后点击“重新加载”。

本机测试两个窗口：在两个终端分别设置 DARLING_CONFIG 指向两个账号的配置，并设置不同的 DARLING_USER_DATA（例如项目 `.local/dva`、`.local/mercy`），然后分别运行 pnpm desktop。同账号第二次登录会替换前一连接。

待发消息最多 100 条，单条最多 8000 字符；服务端确认意味着已存储，不意味着对方已读。待发队列按服务器与账号隔离。历史重启后重新从服务端读取；当前界面尚未做超大历史虚拟列表。

## Debian

安装 Node.js 24 与 pnpm，上传源码，执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。将配置放到 `/etc/darling/server.config.json`，建议数据库使用绝对路径 `/var/lib/darling/chat.sqlite`，创建 darling 用户并给予数据库目录写权限。

`deploy/debian/darling.service` 假定代码位于 `/opt/darling`，Node 位于 `/usr/bin/node`；按实际位置调整后安装 systemd 单元。业务仅需配置的 TCP 端口，默认 8787。本阶段没有部署 TURN，也没有连接真实远程服务器。

SQLite 使用 WAL，备份应在停止服务后复制数据库，或使用 SQLite 在线备份工具；不要只复制运行中的主数据库文件而遗漏 WAL。

## 验证

`pnpm test` 使用真实本地 WebSocket 和 SQLite，覆盖鉴权失败、双方投递、幂等重发、分页补拉、会话替换、重启持久化与客户端自动登录。构建输出在各 app 的 dist 目录。

媒体 IPC 测试另覆盖握手、中文分段、超时、异常退出和不兼容版本，总计 10 项测试。真实桌面冒烟可在构建后使用 Electron 运行 `scripts/smoke-desktop.cjs`，它使用独立 `.local/desktop-smoke` 数据目录和隐藏窗口，验证配置错误状态及设备面板，不连接实际账号、不录音。

原生音质和性能尚无测试结果；本阶段不声明 AEC3、RNNoise 或语音已可用。

现已提供真实麦克风电平测试：先 `pnpm native:build` 与 `pnpm build`，打开客户端的“音频设备”，检测后选择输入并点击“开始麦克风测试”。测试会打开麦克风，显示实际格式与电平，不录制、不发送，关闭面板停止，最长 60 秒。命令行 `pnpm native:capture-smoke` 可执行约两秒真实采集诊断，不在默认测试中自动运行。AEC/降噪和网络语音仍未接入。
