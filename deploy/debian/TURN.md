# Darling TURN 部署准备

当前仅提供模板与凭据下发；未安装或验证远程 coturn。无 TURN 配置时业务服务仍能文字聊天，登录返回空 iceServers，不能据此声称公网语音可用。

1. 在 Debian 安装发行版 coturn，先查看该版本 `turnserver --help` 和 systemd 服务配置，确认实际读取的配置文件路径。此工程没有自动修改服务器。
2. 生成随机共享值：`openssl rand -hex 32`。将同一段 64 字符文本填入 `turnserver.conf.example` 的 static-auth-secret 和 `server.turn.config.example.json` 的 turn.secret，不能填入客户端配置，也不要公开提交。
3. 将两个模板中的地址替换为实际 IPv4。203.0.113.10 是文档示例地址，不能用于部署。模板适用于公网 IP 直接绑定网卡；若服务器位于 NAT 后，listening-ip/relay-ip 应使用本机地址，并根据 coturn 文档设置 external-ip=公网IP/本机IP，不能把未绑定地址用作监听地址。
4. coturn 配置采用 use-auth-secret，realm=darling 是认证标识，不要求 DNS 域名。开放 3478 UDP/TCP 和 49160–49200 UDP 中继端口；业务 WebSocket 独立使用 8787 TCP。no-tcp-relay 禁止的是 RFC6062 TCP relay allocation，不是客户端到 TURN 的 TCP 连接。模板禁用 TLS/DTLS 监听，不提供 turns 地址。
5. 按服务器原有方式安装配置并重启服务，核对端口监听和日志。系统时钟需同步。现有 ws:// 登录与临时凭据不受 TLS 保护；本模板不声称解决传输安全。
6. 必须额外验证真实 UDP/TCP TURN allocation 与强制 relay 的双端音频互通；健康检查和登录成功不能代替此验收。当前原生 PeerConnection 尚未集成，所以这项仍未完成。

登录 auth.ok 的 ice 与鉴权后的 rtc.config 响应结构一致：iceServers、expiresAt（Unix 毫秒）。默认有效期 3600 秒，可配置 300–86400 秒。服务端用过期秒数加用户名签名；共享值不下发。客户端读取时拒绝距离过期不足 60 秒的缓存，断线清空。服务端刷新接口已提供，但客户端自动刷新和原生 RTC 消费尚未接入；不能绕过缓存过期判断直接启动协商。

实现依据：[coturn 官方配置与 REST 认证说明](https://github.com/coturn/coturn/blob/master/README.turnserver)。
