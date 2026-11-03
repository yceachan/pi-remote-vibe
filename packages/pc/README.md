# PC session service

The service runs as the same local user who runs Pi. It supports Linux and macOS
Unix sockets; Windows needs a Linux environment such as WSL2. Copy
`config.example.json`, set absolute project/data/socket/Pi paths, and run:

```sh
pnpm pc /absolute/path/to/pc-config.json
pnpm bridge /absolute/path/to/manager.sock
```

Use a user service to keep the manager alive. The bridge is a byte pipe suitable
for an SSH `authorized_keys` forced command. It rejects PTYs, ignores
`SSH_ORIGINAL_COMMAND`, opens no shell, and never starts or stops Pi. Disconnecting
the bridge leaves every worker and its stdout reader running. A slow client is
disconnected once its pending output exceeds 4 MiB, preserving worker progress.

The state directory is mode `0700`; the Unix socket and session index are mode
`0600`. The directory lock prevents duplicate managers, and startup never removes
a socket with an active listener. Pi inherits the service user's environment,
with optional `env` overrides; configure PATH explicitly in the service unit.
Do not run the service as root or expose the Unix socket to other users.

## Protocol v1

All transport records are UTF-8 JSON objects terminated by LF. CRLF is accepted.
Unicode U+2028/U+2029 are preserved. The first request must be:

```json
{"id":"1","type":"hello","clientId":"stable-client-uuid"}
```

Every request has an `id`. Responses are
`{type:"result",id,ok:true,data}` or
`{type:"result",id,ok:false,error:{code,message}}`.

| Request `type` | Additional fields | `data` |
| --- | --- | --- |
| `list_projects` | — | `{projects}` |
| `list_sessions` | — | `{sessions}` |
| `create_session` | `projectId`, optional `name` | `{session}` |
| `subscribe` | `sessionId`, optional `afterSeq` | `SubscriptionSnapshot` from `protocol.ts` |
| `unsubscribe` | `sessionId` | `{}` |
| `acquire_control` | `sessionId` | `{control,pendingUi}` |
| `heartbeat` | `sessionId` | `{control}` |
| `release_control` | `sessionId` | `{control:null}` |
| `rpc` | `sessionId`, `rpc`, `clientActionId` for writes | `{response}` for reads; `{receipt}` for writes |
| `action_status` | `sessionId`, `clientActionId` | `{receipt}` or `{receipt:null}` |

Subscribe before acquiring control and sending commands. Events are
`{type:"event",sessionId,seq,event}`; `event` contains an unchanged Pi record or a
manager event (`control_changed`, `action_result`, `worker_exit`,
`extension_ui_resolved`, `extension_ui_expired`). A write requires the current
connection's control lease. A second connection with the same client ID cannot
write while the original connection is still alive. After disconnection the
same ID can reclaim the lease immediately; other IDs wait for expiry. Send
heartbeats every ten seconds for the default thirty-second lease.

For read RPC commands, `rpc` is the documented Pi command object. For writes,
also generate and durably retain a unique `clientActionId` **before** sending.
The manager persists acceptance before writing to Pi and preserves all receipts
without automatic eviction. Retrying the same ID and payload returns its receipt.
Reusing an ID with a different payload fails. A receipt means:

- `accepted`: recorded, with a response still pending.
- `completed`: Pi replied; inspect `response.success` for command success.
- `unknown`: accepted, but a crash or timeout prevents knowing whether Pi ran it.

Only `receipt:null` means the manager has no record of acceptance and the client
may resend the same ID. **Never automatically resubmit an accepted/unknown action
under a new ID.** This conservative policy prevents duplicate prompts across the
non-transactional boundary between durable storage and Pi stdin. It can leave an
action undelivered after a crash; the UI must make that uncertainty visible.

`prompt` acceptance is not completion. `agent_end` is not completion either:
retries and queued work can follow. Use `agent_settled`, with `aborted` when
relevant. Identity-changing RPC commands (`new_session`, `switch_session`, `fork`,
`clone`) are rejected; use managed session creation so two workers never share a
session file.

## Synchronization and extension UI

For a cached cursor, `mode:"replay"` returns the retained events after `afterSeq`.
Apply them in order and retain the returned cursor. When there is a gap, missing
cursor, or manager restart, `mode:"snapshot"` returns Pi history, current state,
the in-progress assistant message, active tools, pending dialogs, and current
status/widget/title records. Replace the previous local snapshot. Do not replay
notification popups during full synchronization.

The subscription is installed before querying Pi. State is refreshed, then
messages, partial text, tools, and cursor are captured at the `get_messages`
stdout response boundary. Events arriving after that cursor are buffered and
sent only after the snapshot response. Clients must ignore already-seen event
numbers and resubscribe on a gap. Sequence ranges are durably reserved before
events are sent; restart deliberately skips unused numbers and forces a full
sync rather than reusing old numbers.

Pi dialog methods `select`, `confirm`, `input`, and `editor` remain pending when
the controller disconnects. Only the current controller may answer, using
`rpc:{type:"extension_ui_response",id:<Pi request id>,...}` and a new action ID.
Pi does not produce a normal response for this record: a completed receipt means
the record was written to Pi, not that the extension's subsequent work completed.
Pi-owned dialog timeouts expire the cached request. The standard fire-and-forget
methods pass through unchanged; current `setStatus`, `setWidget`, and `setTitle`
values also appear in `uiState` after a full sync.

## Recovery and verification

Each managed session starts one independent `pi --mode rpc` process with the
configured project as cwd and a private `--session-dir`. Its actual `sessionFile`
is read from `get_state` and saved. A replacement worker uses `--session` to load
that file. Empty Pi sessions are not immediately written to disk; their display
names are restored from the manager's index. An interrupted run is labeled
`interrupted`; its arbitrary tool processes are not resumed.

The implementation was checked against the installed
`@earendil-works/pi-coding-agent@1.5.0` help and these official references:
[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md),
[commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md),
[extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md),
[events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md),
and [CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md).

```sh
node --import tsx --test tests/pc.test.ts
node --import tsx tests/pc-real-smoke.ts /absolute/path/to/pi/dist/bundle/cli.js
```

The deterministic tests cover two independent project workers, continued work
after disconnect, durable receipts and conflicts, leases, replay/cache gaps,
Unicode framing, extension dialogs/current UI, manager restart, worker crashes,
and socket ownership. The opt-in real-Pi smoke verifies installed flags, RPC
state/history/command listing, metadata changes, restart, and persisted history
without model calls. It uses Pi's own SDK to seed a history fixture while the
worker is stopped. These checks do not certify Android suspension, real SSH/WSS,
VPS deployment, model/tool execution, or two physical PCs.
