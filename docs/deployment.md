# 部署指南

以下示例使用域名 `pi.example.com`、VPS `vps.example.com`、PC 用户 `alice`、安装目录 `/opt/pi-remote-vibe`。请逐项替换。两台 PC 的隧道账号、密钥和监听端口各自独立；两台机器上的 Pi 均使用其本机用户的配置、项目及模型凭据。

## 1. 构建与 PC 常驻服务

在可信机器安装锁定依赖，运行 README 的构建命令。向 VPS 和 PC 安装应用代码及 Node 依赖；只有 VPS 需要前端构建产物。不要向 VPS 复制 PC 的 Pi 配置或模型凭据。

PC 配置参照 `packages/pc/config.example.json`。项目路径是显式白名单。`dataDir` 保存私有索引、接收日志和 Pi session 文件；目录为 0700，socket/index 为 0600。备份该目录和 Pi 配置。不要让两套管理服务同时写同一个目录或 Pi session 文件。

将 `deploy/pi-remote-manager.service` 放入 `~/.config/systemd/user/`，修改绝对路径。以 `alice` 用户执行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now pi-remote-manager
```

需要退出桌面后仍运行时，由管理员为该用户启用 systemd linger。服务没有空闲 worker 回收；手机离线不会终止任务。systemd 的 control-group 保证服务退出时不留下孤立子进程。macOS 可使用 launchd 保持同一 CLI 常驻，但仓库暂未提供实机验证的 launchd plist。

## 2. 手机到 PC 的 SSH 身份

为 PWA 创建**专用** SSH 密钥，与日常管理密钥、隧道密钥分开。当前导入支持未加密的 OpenSSH/PEM 私钥，然后立即用浏览器独立口令 AES-GCM 加密。已带 OpenSSH 口令的私钥需先在本地生成/导出专用导入副本；不要上传给 VPS。私钥在浏览器的 IndexedDB 中只以密文存储，解锁后存在当前页面和 WASM 内存，锁定即断开该 SSH 连接。浏览器垃圾回收语言不能保证内存物理擦除。

将 `deploy/pi-remote-attach` 安装为 root 拥有的 `/usr/local/bin/pi-remote-attach`，权限 0755，并编辑其 socket 路径。它忽略 `SSH_ORIGINAL_COMMAND`，只把 stdio 接到管理服务。按 `deploy/authorized_keys.pc.example` 为手机公钥配置 `restrict,command=...`，从而禁止 PTY、端口转发、agent/X11 转发和任意 shell。

手机身份是该公钥在 PC 上的身份；当前单用户管理服务内的 `clientId` 仅区分浏览器标签页和控制租约，**不是新的认证边界**。持有此手机私钥的人拥有这个 Pi 用户所配置项目的操作能力。

在 PC 本机取得主机指纹：

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

通过 PC 屏幕、当面或其他已认证的独立渠道将指纹登记到 PWA。不要以中继首次返回的主机密钥作为可信来源。更换主机密钥时需再次核实并手动修改固定指纹。客户端优先 Ed25519；实际 sshd 如使用其他主机密钥，登记其实际协商密钥的指纹。

## 3. PC 到 VPS 的反向隧道

在 VPS 创建 `tunnel-home` 和 `tunnel-office` 专用 Unix 账号。将每台 PC 的独立隧道公钥分别写入对应账号 `authorized_keys`，参考 `deploy/authorized_keys.vps.example`，office 的 permitlisten 改为 2202。

安装 `deploy/sshd-vps.conf` 并通过 `sshd -t` 验证后重载。只允许 remote TCP forwarding，明确固定 PermitListen、GatewayPorts no、禁止 Unix socket 转发及 PTY/agent/X11；普通 session 会执行 `/bin/false`。不要使用 `DisableForwarding`，它会一并关闭所需的反向隧道。

在每台 PC 上通过可信渠道核实 VPS 主机密钥，将其登记到该用户 `known_hosts`。隧道配置使用 `StrictHostKeyChecking=yes`。

```sh
ssh -N -T -i ~/.ssh/pi-tunnel-home \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:2201:127.0.0.1:22 tunnel-home@vps.example.com
```

office 使用独立密钥/账号/2202。将 `deploy/pi-remote-tunnel@.service` 安装为 PC systemd 用户服务，创建 `~/.config/pi-remote/tunnel-home.env`（`TUNNEL_PORT=2201`），修改 VPS 地址后运行 `systemctl --user enable --now pi-remote-tunnel@home`。

VPS 防火墙仅开放 HTTPS 与必要 SSH 入口。2201/2202 永远只监听 127.0.0.1，不公开暴露。PWA 的 SSH 在隧道中完成另一次独立握手，VPS 中继只得到密文字节。

## 4. Passkey 与 relay

复制 `deploy/relay.example.json`，设定 HTTPS origin、匹配的 rpId、用户到 hostIds 的授权和固定回环端口。配置中的 sshUser 是 PC 用户，不能由连接请求提供任意目标地址或端口。

在可信终端运行：

```sh
node scripts/enrollment-token.mjs
```

将输出的 SHA-256 hash 配到该用户 `enrollmentTokenHash`；一次性 token 只交给对应设备。前端「首次使用」会要求该 token，再进行 Passkey 登记。relay 验证 RP、Origin、challenge 和用户验证标志，持久化公钥与计数器，消费该邀请。增加新 Passkey 时生成新的 token/hash，更新配置并重启 relay；旧邀请不能重用。丢失设备时管理员应在停服务后移除对应 `passkeys.json` credential，同时撤销 PC 的手机 SSH 公钥。生产运维可在后续版本增加管理 UI。

relay 会话为内存中随机 cookie（HttpOnly、SameSite=Strict、生产 Secure），默认 12 小时，重启需重新登录。退出登录或会话过期会关闭相关 WSS。写 API 与 WSS 均严格核验 Origin；host ACL 在 WSS 握手检查。前端 API 和认证数据不进入 service worker 缓存。认证按 TCP 来源每分钟 60 次限流；示例代理统一为 loopback，不信任客户端提供的 X-Forwarded-For，适用于私人低流量部署。

按 `deploy/pi-remote-relay.service` 创建专用低权限 `pi-relay` 用户并运行，使用 `deploy/Caddyfile` 终止可信 HTTPS。relay 只能绑定回环，使用本机反向代理。前端代码属于信任边界：被篡改的前端可接触解锁后的私钥。保护 VPS 的发布权限，并在更新前审阅构建产物与依赖。

首次访问 HTTPS 网站，登记 Passkey、解锁手机私钥、登记 PC 指纹；再连接 PC。安卓浏览器可将带 manifest 的页面安装到主屏幕。

## 5. 故障与恢复

- **未知/变更主机密钥**：连接失败；在 PC 核实后重新登记，不提供「忽略验证」。
- **隧道未连接**：WSS 关闭，查看隧道服务日志及本机回环端口；Pi 任务不受影响。
- **手机断网或锁屏**：服务持续消费 Pi stdout；回到前台后重连，同步历史/状态并查询未确认操作。
- **缓存缺口**：从完整历史切面恢复，再应用该游标后的事件。
- **操作状态 unknown**：可能已交给 Pi，禁止自动补发。用户核实历史/工具实际结果后自行决定后续任务。
- **PC/worker 重启**：恢复 Pi session 历史，执行中的任务标记中断。不会声称任意外部工具已继续执行或自动回滚它的副作用。
- **多端输入**：同一时刻只允许一个连接持有租约，默认 30 秒。手机恢复后重新取得控制；其他端可以只读订阅。

阶段验收需要真实安卓、真实 Passkey 和至少两台 PC。详细脚本与待执行项目见 `docs/validation.md`。
