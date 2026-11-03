# Pi Remote Vibe

从安卓 PWA 操作自己的 PC 上的 Pi：选择项目和会话，提交任务、查看增量结果和工具活动。手机断开时，Pi worker 由 PC 常驻服务继续管理。

这是根据 [Issue 1](.issues/open/1-prototype/issue.md) 实现的首版原型。浏览器 SSH、PC 生命周期和中继已提供自动验证；**安卓真机锁屏、生产 Passkey、VPS 与两台实体 PC 的联合验收尚未执行**。不应据此关闭原 issue。验证边界见 [验收记录](docs/validation.md)。

## 架构

```text
PWA + Go/WASM SSH
    │ WSS：SSH 密文字节
VPS：Passkey、主机 ACL、固定回环端口中继
    │ PC 主动建立的反向 SSH 隧道
PC sshd：手机公钥 + 受限非 PTY exec
    │ stdio → 私有 Unix socket
常驻会话管理服务 → 每会话独立 Pi RPC worker
```

- `packages/pc`：会话索引、Pi 子进程、操作接收日志、事件续接和控制权租约。
- `packages/browser-ssh`：基于 Go `x/crypto/ssh` 的最小非 PTY 客户端，强制验证已登记的 SHA256 主机指纹。
- `packages/web`：响应式 PWA、Passkey 登录、加密私钥库、草稿与输入历史、模型与命令选择、标准扩展交互。
- `packages/relay`：Passkey 验证、用户到主机的授权、WSS ↔ TCP 字节中继。

VPS 不接触 Pi 配置、模型凭据或明文会话内容。PWA 的代码仍由 VPS 提供，前端发布方处于信任边界内。

## 环境与构建

需要 Node.js 24 LTS、pnpm 11.25.0、Go（版本见 `packages/browser-ssh/go.mod`），以及 PC 上已安装、配置好的 Pi 和 OpenSSH。当前 PC 服务支持 Linux/macOS 的 Unix socket；Windows 可使用 WSL2，原生 Windows 尚未实现。生产部署示例以 Linux/systemd 为目标。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:ssh
pnpm build:ssh
pnpm build
```

Go/WASM 构建产物位于 `packages/web/public/ssh/`，不提交 Git；网页输出到 `packages/web/dist/`。`pnpm build:ssh` 必须在网页构建之前执行。可用 `GO_BINARY=/absolute/path/to/go` 选择 Go。

## 本机启动

1. 复制 `packages/pc/config.example.json` 到自己的配置目录，修改 `dataDir`、`socketPath`、项目白名单和 `piCommand` 的绝对路径。服务以运行 Pi 的同一用户身份启动；配置 `env.PATH` 以匹配日常工具环境。
2. 启动常驻服务：

   ```sh
   pnpm pc /absolute/path/to/pc.json
   ```

3. 不经 SSH 的本机协议调试：

   ```sh
   pnpm bridge /absolute/path/to/manager.sock
   ```

   然后逐行输入：

   ```json
   {"id":"1","type":"hello","clientId":"local-debug"}
   {"id":"2","type":"list_projects"}
   {"id":"3","type":"list_sessions"}
   ```

4. 根据 [部署说明](docs/deployment.md) 配置 relay、SSH 密钥和反向隧道，再运行：

   ```sh
   pnpm relay /absolute/path/to/relay.json
   ```

   relay 同时提供构建后的 PWA 和 API。开发时可将 `origin`/`rpId` 改为 `http://localhost:3100`/`localhost`，仅在回环地址测试。

## 手机使用

1. 管理员生成一次性邀请，将 **hash** 写入 relay 用户配置；手机在 HTTPS 页面用邀请登记 Passkey。
2. 使用独立口令导入并加密保存手机专用 SSH 私钥。网站登录和私钥解锁相互独立；PC 的 `authorized_keys` 中放对应公钥。
3. 在 PC 本机核实 SSH 主机 SHA256 指纹，在 PWA「主机信任」中登记。未知或变更的主机密钥不会被自动接受。
4. 选择主机、项目，创建/进入会话。获得控制权后可发送、停止、切换模型及处理标准扩展弹窗。其他客户端可同时查看。
5. 断网后重新打开页面，登录/解锁后重连原会话。浏览器先查询未确认操作的接收结果；不自动重发结果不确定的操作。PC/worker 重启后保留历史，将中断任务明确标记。

输入区支持多行、命令插入、本机草稿和最近 50 条输入历史。首版只发送文本，不支持附件、文件浏览、Git diff 或自定义 TUI 扩展组件。标准弹窗及 Pi RPC 暴露的状态、widget、通知受支持。

## 运行与验证文档

- [部署、首次信任与密钥管理](docs/deployment.md)
- [应用协议与恢复语义](docs/protocol.md)
- [浏览器 SSH 候选比较和验证](docs/ssh-validation.md)
- [验证结果与待验收项目](docs/validation.md)

Pi RPC 使用 `prompt` 的响应确认接收，通过流式事件和 `agent_settled` 确认完成。不会把手机连接的断开当成任务取消，也不会接管既有 Pi TUI 进程。
