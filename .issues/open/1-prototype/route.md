# Route：原型验证到首版交付

状态：提议，待审阅

## 实施顺序

| 阶段 | 产物 | 通过条件 |
|---|---|---|
| 0．浏览器 SSH 技术验证 | 安卓 PWA 到测试 sshd 的最小链路；记录候选库接口与必要改造 | WSS 字节传输、主机密钥严格校验、私钥认证、非 PTY exec、双向流和锁屏后重连均可演示。未通过则回到 ADR 讨论连接层。 |
| 1．PC 本机桥接 | 常驻管理服务、Unix socket 接入程序、Pi RPC worker 管理 | 两个会话在不同项目目录独立运行；持续消费 stdout；断开客户端后任务继续；从 session 文件重载历史。 |
| 2．本地 PWA | 会话列表、对话流、输入区、命令列表和标准扩展交互 | 可创建／切换会话、提交 prompt、停止任务、选择模型，并处理标准弹窗；用状态与事件确认完成。 |
| 3．SSH 接入整合 | PC sshd 的受限接入命令与 PWA 连接流程 | 手机经 SSH 连到 PC 常驻服务，非 PTY channel 上可运行完整会话协议。 |
| 4．VPS 与双 PC | Passkey 入口、WSS↔TCP 中继、两台 PC 的反向隧道 | VPS 按授权主机 ID 转发至固定回环端口；PC 只需主动出站；未授权主机与跨站 WSS 请求被拒绝。 |
| 5．密钥与恢复 | 加密保存手机私钥、操作去重、事件续接、多端控制 | 锁屏／断网后同一任务继续；重连无重复 prompt，历史与状态一致；多端可看且只有控制端能写。 |

阶段 0 是产品路线的前置关口；阶段 1 和 2 可在本机独立开发。各阶段的具体检查记录存放在临时验证目录或项目 `artifacts/`，issue 只保留通过条件与结论。

## 参考项目的使用位置

| 项目 | 在本路线中的参考点 |
|---|---|
| [ygncode/pi-web](https://github.com/ygncode/pi-web) | 阶段 1：Go 服务、按 session 管理 RPC worker、session 文件索引及 SSE 流；其 worker 有空闲回收策略，首版是否回收须服从后台任务持续要求。 |
| [ayagmar/pi-mobile](https://github.com/ayagmar/pi-mobile) | 阶段 1–2：Node 桥接协议、重连和控制权、Android 交互；其前端是原生 Android，连接层是 Tailscale 上的 WebSocket。 |
| [tiann/hapi](https://github.com/tiann/hapi) | 阶段 2–5：多 Agent 远程产品的会话组织和 Pi 适配，作为交互与运行管理参考。 |
| [agegr/pi-web](https://github.com/agegr/pi-web) | 阶段 2：项目、会话、文件、Git diff 与设置界面；它与 ygncode/pi-web 是不同作者的项目。 |
| [JackDanger/pi-remote](https://github.com/JackDanger/pi-remote) | 阶段 1、5：常驻多会话和多端共享事件；它使用 Pi SDK 的进程内 AgentSession，不能直接复用为 stdio RPC 桥接。 |
| [VerdigrisTech/sshclient-wasm](https://github.com/VerdigrisTech/sshclient-wasm)、[c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) | 阶段 0：浏览器 WASM SSH 与 WebSocket 代理。公开说明偏向终端使用；非 PTY exec 和主机密钥回调以实际接口验证为准。 |

Pi 协议的权威边界以其 [RPC 总览](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[命令](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md) 和 [扩展 UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md) 为准。阶段实施前以 PC 实际安装版本的 `pi --help` 和对应协议定义核对接口。
