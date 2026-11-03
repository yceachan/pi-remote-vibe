# 原型验证记录

日期：2026-11-03。测试对象：本 PR 的新增实现。目标部署验收保持开放，尚未创建 issue 的 `close.md`。

## 已执行的检查

| 检查 | 结果与边界 |
|---|---|
| `pnpm check` | TypeScript 严格检查通过。 |
| `pnpm test` | 26 项通过：11 项 PC、9 项网页状态/协议/密钥、6 项 relay/认证。使用确定性的 mock Pi 模拟流、崩溃和延迟。 |
| Go `go test -race ./internal/...` | 4 项通过：主机固定指纹、私钥认证、非 PTY、二进制及超时；完整明细见 SSH 记录。 |
| `pnpm build:ssh` / `pnpm build` | Go/WASM 与 Vite 生产构建通过。构建来自锁定依赖，不从 CDN 载入 SSH 代码。 |
| `pnpm test:ssh-browser` | Chrome 156 → HTTPS/WSS → TCP → 标准 OpenSSH_10.3p1，通过坏指纹/错误私钥拒绝、非 PTY exec、双向各 262,144 字节、断开重连、握手中取消。隔离本机测试 sshd 和临时密钥。 |
| `pnpm test:web-browser` | Chrome 390px UI 验证：独立密钥口令、指纹登记、会话草稿隔离、命令插入、receipt、扩展状态恢复/过期弹窗、刷新选择与密钥重锁、主机切换、无横向溢出。此项使用显式测试传输 fixture，不冒充真实 SSH。 |
| `pnpm test:passkey` | 编译后的真实 PWA + 生产 relay + SimpleWebAuthn + Chrome CDP 虚拟平台认证器：邀请登记、真实签名验证、退出/再次登录、HttpOnly/SameSite cookie、授权主机、邀请重用拒绝、网站登录不解锁 SSH、API 不进缓存。不是实体安卓认证器验证。 |
| `pnpm test:e2e` | 完整生产 PWA → Passkey 验证 → HTTPS/WSS → relay → Go/WASM → 独立 OpenSSH 受限命令 → stdio → SessionManager。使用虚拟认证器和 mock Pi，创建会话、发送后断线期间仍 running、离线完成、重连及刷新恢复同一会话，通过并确认 prompt 只出现一次。 |
| `tests/pc-real-smoke.ts` | 实际安装 `@earendil-works/pi-coding-agent@1.5.0`，核对 `--help`、RPC 状态/历史/命令、元数据变更、manager/worker 重启和已保存历史恢复。通过 Pi SDK 写入隔离测试历史，不调用付费模型，不读取用户模型凭据。 |

本机环境：macOS、Node 24.19.0、Go 1.27.3、Chrome 156.0.8078.80。详细浏览器 SSH 候选比较、接口与命令在 [ssh-validation.md](ssh-validation.md)。

## 复现

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:ssh
pnpm build:ssh
pnpm build
pnpm --filter @pi-remote/web exec playwright install chromium
pnpm test:web-browser
pnpm test:passkey
pnpm test:ssh-browser
pnpm test:e2e
```

浏览器测试可用 `CHROME_BINARY=/path/to/chrome` 选择现有 Chrome。SSH smoke 还需要 OpenSSH `sshd`、`ssh-keygen` 和 `openssl`，只能在允许启动本机测试 sshd 的环境执行；不会修改系统 sshd 配置或使用用户私钥。本机测试 TLS 使用仅该测试可接受的临时自签名证书，不修改生产客户端的 HTTPS 或主机密钥验证。CI 运行类型、单元/服务集成、Go race 和生产构建；实体设备验收不在 CI 中伪造。

真实 Pi 可选验证：

```sh
node --import tsx tests/pc-real-smoke.ts /absolute/path/to/pi/dist/bundle/cli.js
```

## 目标部署待验收

| 场景 | 操作与预期 | 当前结果 |
|---|---|---|
| 安卓安装与 Passkey | 真实 HTTPS 域名登记/登录 Passkey，安装 PWA；拒绝错误 Origin 和未授权主机。 | 待设备/VPS |
| 阶段 0 安卓 SSH | 真实安卓浏览器验证指纹、私钥、非 PTY exec 与双向流；错误指纹必须失败。 | 桌面已过，安卓待测 |
| 锁屏与切后台 | 开始持续生成或长工具任务，锁屏至少 2 分钟；PC 仍消费 stdout，回前台恢复同一任务与历史。 | 服务离线模拟已过，安卓待测 |
| 断网与重复提交 | 发送后立刻断网，重连查 receipt；不重复 prompt，unknown 不自动补发。 | 自动故障测试已过，真实网络待测 |
| VPS 与两台 PC | 各 PC 仅主动出站，分别映射 2201/2202，同时独立会话；不可任意转发其他主机/端口。 | 授权/中继测试已过，实体拓扑待测 |
| 多端控制 | 两个实际设备订阅同会话，只有一个输入；释放/租约超时后另一端接管。 | 服务集成已过，双设备待测 |
| 真实模型与工具 | 在日常 Pi 配置下验证文本流、工具更新、abort、模型切换、skills/模板/扩展及标准弹窗。 | RPC/fixture 已过，真实模型待测 |
| PC 断电/worker 崩溃 | 历史重载，中断状态明确，工具副作用不自动重做。 | 进程模拟/真实 Pi 重载已过，断电待测 |

只有这些目标部署检查记录通过后，才应将 `.issues/open/1-prototype` 判为完成并撰写 `close.md`。本 PR 提供可部署、可复现验证的实现，不把桌面模拟等同于安卓实机验收。

## 已知边界

- 首版为文本任务；附件、文件浏览、Git diff、原生 Windows、动态补全、自定义 TUI 组件不在实现内。
- 标准 Pi RPC 单条 JSONL 记录受 8 MiB 上限保护。极大历史或工具输出可能超限并中断 worker，界面显示错误；后续需要历史分页或可配置有界上限。测试不覆盖超长生产会话。
- Pi 1.5.0 在启动扩展钩子结束后才接收 RPC stdin；在 `session_start` 内等待无超时标准弹窗的扩展会使其启动阻塞，管理服务按超时失败。普通命令执行中的标准弹窗受支持。
- 任意工具的外部副作用不具备事务保证；崩溃后 receipt 为 unknown 时必须核实实际结果。
- receipt 和会话索引当前不做自动裁剪；长期部署需监控磁盘和历史规模。
- 使用同一网页来源的前端代码可访问解锁后的私钥；浏览器本地加密不防恶意前端更新。部署方须保护发布权限。
