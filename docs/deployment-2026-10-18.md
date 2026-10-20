# 服务器部署记录 · 2026-10-18

目标：47.104.203.249，Debian 12 x86_64，网卡地址 172.17.63.156。用户授权替换占用 8787 的旧 Darling 进程。

## 已部署

- 新业务服务：`darling.service`，`/opt/darling/apps/server/dist/index.js`，8787 TCP，使用 darling 用户运行。配置 `/etc/darling/server.config.json`，数据 `/var/lib/darling/chat.sqlite`。
- 独立 Node.js 24.22.0：`/opt/darling-node-v24.22.0`；系统 Node 18.20.4 未替换。下载包 SHA256 `cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008` 已核验。
- Debian coturn 4.6.1-1：专用 `darling-turn.service`，配置 `/etc/darling/turnserver.conf`，3478 UDP/TCP，中继 49160–49200 UDP，公网/内网映射已设置。软件包自带 coturn.service 停用，避免重复监听。
- 新业务与 TURN 均 active/enabled。frps 仍 active，未改动配置。
- 业务文件 SHA256 与本地一致：`9209805b312cf4a50c6bc9bd8a149060d18bca783c20122a2d0a02732b76ffaa`。
- 新 dva/mercy 密码及 TURN 共享值随机生成。客户端配置位于本机 `.local/dva.config.json`、`.local/mercy.config.json`，均未纳入版本控制；不要公开这些文件。SSH 密码没有写入部署脚本或项目文件。

## 验证结果与阻塞

- 服务器本机健康检查成功；公网 HTTP 健康检查成功。
- 从 Windows 到公网 WebSocket，两用户登录、消息同步、ICE 配置下发均成功；未发送测试聊天消息。
- 服务器内通过真实 coturn 凭据执行 UDP/TCP 客户端转发测试，各收发 10/10，丢包 0。这不是公网双端媒体验收。
- Windows 到公网 UDP STUN 3478、TCP 3478 均超时。服务器本机监听正常，nft 规则集为空；外部安全组/网络路径是待检查项，尚不能断言具体丢包位置。
- 需要在阿里云实例安全组及相关网络 ACL 放行入站 UDP 3478、TCP 3478、UDP 49160–49200，并重新验证。业务 TCP 8787 已可达。未更改云安全组。
- 原生 RTC 尚未实现，客户端通话仍禁用，未开启真实麦克风。

## 保留与回滚

### 安全组放行后复测

用户确认已放行。本机公网 HTTP、两用户 WebSocket 登录/消息同步和 UDP STUN 均通过。新增 `scripts/verify-turn.mjs` 从业务登录取得短期凭据，完成公网 UDP/TCP TURN 401 challenge、认证 allocation、响应 MESSAGE-INTEGRITY 校验与 refresh lifetime=0 释放；两种传输都通过，返回公网 relay 地址 47.104.203.249（本轮端口 49169/49181）。没有输出凭据，没有打开麦克风。

复测命令：`node scripts/verify-turn.mjs .local/dva.config.json`。注意这会登录该用户，因此会按单会话规则替换已登录的同名客户端；仅在维护测试时运行。当前脚本仅覆盖 IPv4、初次认证分配/释放；未覆盖丢包重传、438 nonce 刷新或真实 WebRTC 媒体互通。分配成功不能独立证明公网中继端口范围上的实际双向媒体已验收。

旧服务 `darling-api.service` 已 stopped/disabled，旧目录 `/opt/darling-api` 和原服务文件保留；备份为 `/root/darling-deploy-U2UGETvm/previous-darling-api.tar.gz`。未删除旧文件。

若要回滚业务（会中断新业务连接），由管理员执行：

```sh
systemctl disable --now darling
systemctl enable --now darling-api
```

新数据库、配置、独立运行时和 TURN 不受上述回滚影响。旧服务协议与新客户端不同，回滚后不可假定新客户端仍兼容。暂存目录包含敏感客户端配置副本，仅 root 可访问。
