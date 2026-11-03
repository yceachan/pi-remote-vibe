# 应用协议 v1

浏览器和 PC 接入程序之间运行 UTF-8 JSONL：一个 JSON 对象一行，**只以 LF 分割**，不将 Unicode U+2028/U+2029 当作换行。SSH 使用非 PTY exec，避免终端回显和换行转换。`packages/pc/protocol.ts` 是结构定义，`packages/pc/README.md` 说明具体实现。

## 握手与请求

所有请求都含唯一 `id` 和 `type`。每条连接先发送：

```json
{"id":"r1","type":"hello","clientId":"browser-tab-uuid"}
```

结果格式：

```json
{"type":"result","id":"r1","ok":true,"data":{"version":1,"leaseMs":30000}}
{"type":"result","id":"r2","ok":false,"error":{"code":"not_controller","message":"Acquire control before sending commands"}}
```

| type | 额外字段 | 结果 |
|---|---|---|
| `list_projects` | 无 | `projects` 白名单 |
| `list_sessions` | 无 | `sessions`（含状态、项目） |
| `create_session` | `projectId`, `name?` | `session` |
| `subscribe` | `sessionId`, `afterSeq?` | snapshot 或 replay |
| `unsubscribe` | `sessionId` | 空对象 |
| `acquire_control` | `sessionId` | `control`, `pendingUi` |
| `release_control` | `sessionId` | `control: null` |
| `heartbeat` | `sessionId` | 更新后的 `control` |
| `rpc` | `sessionId`, `rpc`, 写操作另需 `clientActionId` | `response`（只读）或 `receipt`（写） |
| `action_status` | `sessionId`, `clientActionId` | `receipt` 或 null |

写操作使用：

```json
{"id":"r4","type":"rpc","sessionId":"session-uuid","clientActionId":"action-uuid","rpc":{"id":"pi-command-uuid","type":"prompt","message":"解释这个项目"}}
```

外层 `id` 关联应用请求；`rpc.id` 关联 Pi 命令；`clientActionId` 关联可跨断线重试的同一操作。管理服务使用自身内部 Pi 请求 ID 防止多端 ID 冲突，返回时映射到调用者 ID。`new_session`、`switch_session`、`fork`、`clone` 不能直接改变活跃 worker 的会话身份，必须通过管理会话入口。

`prompt` 的成功响应只代表 Pi 处理了命令；运行完成必须等待 `agent_settled`。标准 `extension_ui_response` 没有原生 Pi 响应，管理服务在成功写入后返回接收结果；这不是扩展业务完成证明。

## 事件与同步

```json
{"type":"event","sessionId":"session-uuid","seq":42,"event":{"type":"agent_settled"}}
```

同一会话序号严格递增，重启时跳到已持久化的保留序号之后，防止旧 cursor 被误认作新事件。环形缓存默认保存 2048 条事件。客户端遇到非连续序号必须完整同步。

订阅先登记并缓冲新事件，刷新 Pi 状态，再取 Pi 历史。`get_messages` 响应被消费时记录 cursor，并拷贝该时刻的状态、进行中的消息和工具。结果包含：`mode`、`session`、`state`、`messages`、`partialMessage`、`activeTools`、`cursor`、`events`、`control`、`pendingUi`、`uiState`。

- `snapshot`：用历史与部分消息替换本地视图，设置 cursor，再应用响应后送达的 `seq > cursor` 事件。状态查询后的实时运行事件也会推进快照状态，客户端按事件序号收敛。
- `replay`：本地已有匹配的会话视图时，按序应用 `events`。无历史视图时不要仅保存 cursor 后发起 replay。
- 缓存缺口、worker/manager 重启或 cursor 无效：服务返回完整 snapshot。

慢客户端超过发送缓冲限制会断开，从而不阻塞 worker stdout。PC 服务始终消费 Pi stdout，无订阅者也保留会话生命周期。标准扩展待处理弹窗保留到响应或超时；状态、widget、title 在 `uiState` 中恢复。

## 去重和不确定结果

服务在向 Pi 写入之前，先通过原子替换及 fsync 持久化 `accepted` receipt。相同 `clientActionId` 和命令再次提交返回原结果；相同 ID 携带不同命令被拒绝。receipt 状态：

- `accepted`：已持久接收，仍等待 Pi 响应。
- `completed`：已有响应（检查 `response.success`，完成接收不代表任务完成）。
- `unknown`：写入后超时、崩溃或服务重启，无法判定执行结果，**禁止自动补发**。

浏览器先持久化待发送操作，再发送。重连查询 `action_status`；只有结果为 null、且当前持有控制权时才能使用原 ID 补发。receipt 为 unknown 时交由用户核实。此策略是保守的至多一次自动转发语义，不能保证网络与进程崩溃中的每次操作都执行，也不能替任意外部工具实现事务。

接收日志当前不自动裁剪；私人部署需监控索引大小。它包含 prompt 与命令参数，和 Pi 历史一样属于敏感本地数据。

## 控制权

租约绑定具体连接和客户端标签页，默认 30 秒，由 heartbeat 续期。断开后保留到到期，原标签页可以重连恢复；其他客户端需等待释放或过期。两个活动连接即使使用相同 clientId，也不会同时获得写权限。clientId 只在已认证的 SSH 身份内区分连接，不是用户认证凭据。

扩展弹窗只由控制端作答，多端仍可接收事件。停止操作清空 Pi 队列后发送 abort。PC 重启只恢复历史与索引，将运行中的会话标记中断，不保证工具进程恢复。
