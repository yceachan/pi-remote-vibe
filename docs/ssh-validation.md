# 浏览器 SSH 验证记录

日期：2026-11-03。状态：**桌面浏览器自动验证通过；阶段 0 的安卓真机验收尚未完成**。

本 PR 已实现 PWA 所需的浏览器 SSH 适配器，并验证浏览器到标准 OpenSSH 的真实连接。没有安卓设备、真实公网 VPS 和两台目标 PC 的验收记录，因此不能据此关闭 prototype issue，也不能将锁屏恢复或最终部署标成通过。

## 候选库检查与选择

检查依据是上游源码的固定提交，而非 README 的能力描述。

| 候选 | 私钥与字节传输 | 主机密钥 | 非 PTY exec | 结论 |
|---|---|---|---|---|
| [VerdigrisTech/sshclient-wasm，e5526d7](https://github.com/VerdigrisTech/sshclient-wasm/blob/e5526d716b6ab03e0b8c4102290c93cfb91ed88d/pkg/sshclient/client.go) | `ssh.ParsePrivateKey`，可注入 transport | `Connect` 固定使用 `ssh.InsecureIgnoreHostKey()`，公开选项无严格 pin | `Send` 首次调用自动 `StartShell`，后者请求 PTY 并启动 shell | 不能直接作为本项目连接层。至少需改主机核验、exec、stdout/stderr 和生命周期接口。 |
| [c2FmZQ/sshterm，922c37c](https://github.com/c2FmZQ/sshterm/blob/922c37c9cb87239f25acfad0497b73ba5bcbe559/go/internal/app/ssh.go) | Go SSH signer；[WebSocket `net.Conn`](https://github.com/c2FmZQ/sshterm/blob/922c37c9cb87239f25acfad0497b73ba5bcbe559/go/internal/websocket/websocket.go) 支持二进制 | 存在 host key 与 host certificate callback，但策略与整个终端应用绑定 | `command != ""` 时先 `session.Run(command)` 返回；PTY 只用于后续交互 shell 分支 | 底层路线可行，但它是完整终端应用，不是本项目可直接导入的流式 TS 库。拆分需要提取存储、终端、交互及命令层。 |

本实现直接使用二者共同依赖的 [Go `golang.org/x/crypto/ssh`](https://pkg.go.dev/golang.org/x/crypto/ssh)，为本项目编写小型 Go/WASM 桥接和 TS Streams 适配器，未复制上述项目代码。SSH 密码学与协议处理由 x/crypto 提供；WSS 只承载其密文字节。本项目没有新实现 SSH 密码学。

固定依赖：Go 1.27 系列，`golang.org/x/crypto v0.58.0`，`golang.org/x/sys v0.49.0`；Go 校验和在包内 `go.sum`。本次实际构建使用 Go 1.27.3 darwin/arm64，官方下载归档 SHA256 为 `dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2`，与 [Go 下载索引](https://go.dev/dl/?mode=json) 相符。更新 Go 时需用同一工具链重新生成 WASM 和 `wasm_exec.js`。

## 实现边界

`packages/browser-ssh` 导出：

```ts
import { connectSsh } from '@pi-remote/browser-ssh';

const connection = await connectSsh({
  url: 'wss://remote.example.com/relay/home-pc',
  username: 'alice',
  privateKey: unlockedPrivateKey,
  expectedFingerprint: independentlyVerifiedHostFingerprint,
  // 默认值如下。接入程序必须与 PC 的 forced command 一致。
  command: 'pi-remote-attach',
  hostKeyAlgorithm: 'ssh-ed25519',
  signal: abortController.signal,
});
// connection.readable / writable: Web Streams，元素为 Uint8Array。
// writable.close() 发 SSH EOF；connection.close() 关闭连接。
```

- `expectedFingerprint` 必填，格式为 OpenSSH `SHA256:...`，在 Go 的 SSH 握手回调中严格比较。pin 不匹配时在手机公钥认证前拒绝；没有自动信任、忽略核验或从 relay 返回值自动登记的分支。
- 默认协商 `ssh-ed25519` 主机密钥，避免一个 sshd 提供多种密钥时协商到未经登记的另一把密钥。适配器可显式选择 ECDSA 或 RSA SHA2；前端默认部署流程登记 Ed25519。指纹通过 PC 本地可信终端取得：`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`。切勿用未核验的网络扫描结果代替可信登记。
- 只用本地解锁的私钥认证，无密码或键盘交互回退。Go 使用 `ssh.ParsePrivateKey`，所以 SSH 文件自身若还有口令，需要在导入流程预先处理；当前 PWA 使用独立的本地 AES-GCM 密钥库保护导入的未加 SSH 口令的私钥。认证私钥不会发送到 VPS。
- 只打开一个 SSH session，调用 `session.Start(command)`；不请求 PTY，不启动交互 shell，不用终端转义承载 JSONL。stdout 是应用流，stderr 持续消费且不混入 JSONL。
- WSS 是默认强制要求；仅 `localhost`、`127.0.0.1`、`[::1]` 允许开发用 WS。Go runtime 与 WASM 只能从本应用同源加载。
- 浏览器 WebSocket 输入队列限制为 512 帧/8 MiB，输出受 `bufferedAmount` 控制。超限关闭连接，使应用层重新同步，不无限积压。SSH 通道写入使用 SSH flow control。
- 连接和握手有超时，`AbortSignal` 能中止连接与后续读写。断开会销毁 socket；重新进入会话建立新的 SSH 连接，应用层游标负责恢复内容。
- Go 解析用的私钥字节副本在连接初始化结束后清零。JS 字符串、浏览器运行时和 Go signer 无法承诺立即物理清零；PWA 锁定时必须清理其解锁密钥引用并关闭连接。客户端代码来自 VPS 这一信任边界仍然成立。

## 可重复验证

先在仓库根安装 Node 依赖并安装 Go 1.27，然后：

```sh
pnpm --filter @pi-remote/browser-ssh build:wasm
cd packages/browser-ssh
go test -race ./internal/...
pnpm exec playwright install chromium
pnpm test:browser
```

`build:wasm` 将生成文件写入 `packages/web/public/ssh/`，该目录不提交；前端构建前需执行它。可用 `GO_BINARY` 指定 Go 可执行文件，或把目标静态资产目录作为 `scripts/build.mjs` 的参数。

浏览器 smoke 需要本机 `sshd`、`ssh-keygen`、`openssl` 和可运行的 Chromium。它自动生成独立 SSH 测试密钥、临时 sshd 配置与自签名 TLS 证书，侦听回环地址，结束后清理；不修改用户的 `authorized_keys` 或系统 sshd。测试脚本只在该隔离环境放宽自签名 TLS 校验。Windows 可在 Linux 环境运行这一测试；首版 PC 接入程序本身依赖 Unix socket。

可选环境变量：

| 变量 | 用途 |
|---|---|
| `SSHD_BINARY` | sshd 路径，默认 `/usr/sbin/sshd` |
| `CHROME_BINARY` | 已安装 Chrome/Chromium 路径；未设置时使用 Playwright 安装的浏览器 |
| `PLAYWRIGHT_MODULE` | 现有 Playwright ESM `index.mjs` 路径；未设置时导入本包 devDependency |

本次执行环境：macOS arm64，Chrome `156.0.8078.80`，OpenSSH `10.3p1` / LibreSSL `3.3.6`，真实 HTTPS/WSS，测试使用本地自签名证书。

| 检查 | 方法 | 结果 |
|---|---|---|
| 严格 host pin | Go 集成测试确认错误 pin 在认证前失败；浏览器连真实 sshd，错误 pin 拒绝 | 通过 |
| 必填 pin | 空 pin 在调用 SSH 前拒绝 | 通过 |
| 私钥认证 | 临时 Ed25519 公钥由 sshd 接受；另一个私钥拒绝 | 通过 |
| 非 PTY exec | Go 服务器记录 `exec` 命令并确认零次 PTY 请求；真实 sshd 执行 `test ! -t 0 && exec /bin/cat` | 通过 |
| 二进制双向流 | Chrome 写入并读回 262,144 字节，覆盖所有 256 字节值 | 通过 |
| 断开及新连接 | 同一页运行两次独立 SSH 连接，两次字节完全一致 | 通过 |
| 取消与握手超时 | 浏览器 `AbortSignal`；Go stalled transport deadline | 通过 |
| Go 并发检查 | `go test -race ./internal/...` | 通过 |
| WASM 与 TS | Go WASM 构建成功；TS 适配器严格类型检查通过 | 通过 |
| 安卓 PWA / 锁屏 / 后台冻结 | 无真机，未执行 | **未验收** |
| 公网 VPS / Passkey / 双 PC | 不属于此隔离 SSH 测试；需目标环境演示 | **未验收** |

## 安卓与部署验收清单

在真实 HTTPS 站点安装安卓 PWA，记录 Android、Chrome 与 Pi 版本、PC 平台、部署 commit 和时间。验证：

1. 用可信登记的主机 pin 和手机密钥连接；替换 pin 或私钥分别失败；恢复正确值后成功。
2. 两台 PC 各自创建会话，确认受限 `authorized_keys` 强制接入命令，且没有 PTY、shell 或端口转发能力。
3. 提交持续输出的 Pi 任务，锁屏至少一分钟再返回。确认 PC worker 持续消费 stdout，PWA 新 SSH 连接接回同一 session，状态及历史一致。
4. 在发送 prompt 后切断网络，在新连接中查询 `clientActionId` 的接收结果，确认没有重复 prompt；制造事件游标缺口，确认完整同步。
5. 清理浏览器站点数据或更换主机密钥时，确认需要重新可信登记，而非自动接受新主机密钥。

上述记录完成前阶段 0 保持未完全验收；可以继续本机独立开发阶段 1、2，但不应声称最终安卓交付已经完成。
