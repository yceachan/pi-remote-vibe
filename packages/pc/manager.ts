import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect as connectSocket, createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { JsonlDecoder } from './jsonl.js';
import { PiWorker } from './worker.js';
import type { ActionReceipt, AppRequest, Control, JsonRecord, Project, ServerRecord, SessionEvent, SessionInfo, SubscriptionSnapshot } from './protocol.js';

interface StoredSession extends SessionInfo { seqReserved: number; actions: Record<string, ActionReceipt & { fingerprint: string }> }
interface Runtime {
  stored: StoredSession;
  seq: number;
  events: SessionEvent[];
  worker?: PiWorker;
  starting?: Promise<PiWorker>;
  control: (Control & { connectionId?: string }) | null;
  state: Record<string, unknown>;
  partial: Record<string, unknown> | null;
  tools: Map<string, JsonRecord>;
  pendingUi: Map<string, JsonRecord>;
  uiState: Map<string, JsonRecord>;
  uiTimers: Map<string, NodeJS.Timeout>;
}
interface Connection {
  id: string;
  clientId?: string;
  socket: Socket;
  subscriptions: Map<string, SessionEvent[] | null>;
  inFlight: number;
}
export interface ManagerOptions {
  dataDir: string;
  socketPath: string;
  projects: Project[];
  piCommand?: string;
  piArgs?: string[];
  env?: NodeJS.ProcessEnv;
  eventLimit?: number;
  leaseMs?: number;
  rpcTimeoutMs?: number;
  diagnostic?: (sessionId: string, text: string) => void;
}
class ProtocolError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const readCommands = new Set(['get_state', 'get_messages', 'get_available_models', 'get_available_thinking_levels', 'get_session_stats', 'get_fork_messages', 'get_entries', 'get_tree', 'get_last_assistant_text', 'get_commands']);
const identityCommands = new Set(['new_session', 'switch_session', 'fork', 'clone']);
const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new ProtocolError('invalid_request', `${label} must be a nonempty string of at most 256 characters`);
  return value;
}
function clone<T>(value: T): T { return structuredClone(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}

export class SessionManager {
  private options: ManagerOptions;
  private sessions = new Map<string, Runtime>();
  private connections = new Map<string, Connection>();
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private ownsLock = false;
  constructor(options: ManagerOptions) {
    this.options = { ...options, dataDir: resolve(options.dataDir), socketPath: resolve(options.socketPath), projects: options.projects.map(project => ({ ...project, path: realpathSync(project.path) })) };
    const ids = new Set<string>();
    for (const project of this.options.projects) {
      required(project.id, 'project id');
      if (ids.has(project.id) || !statSync(project.path).isDirectory()) throw new Error(`Invalid/duplicate project ${project.id}`);
      ids.add(project.id);
    }
  }
  private get indexPath(): string { return join(this.options.dataDir, 'index.json'); }
  private get lockPath(): string { return join(this.options.dataDir, 'manager.lock'); }
  private save(): void {
    const temporary = this.indexPath + '.tmp';
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, sessions: [...this.sessions.values()].map(s => s.stored) })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.indexPath);
    const directory = openSync(this.options.dataDir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private runtime(stored: StoredSession): Runtime {
    stored.actions = Object.assign(Object.create(null), stored.actions);
    return { stored, seq: stored.seqReserved, events: [], control: null, state: {}, partial: null, tools: new Map(), pendingUi: new Map(), uiState: new Map(), uiTimers: new Map() };
  }
  async start(): Promise<void> {
    mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.options.dataDir, 0o700);
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      writeFileSync(fd, String(process.pid)); closeSync(fd); this.ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid manager lock; inspect it before removing');
      try { process.kill(pid, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
        unlinkSync(this.lockPath);
        return this.start();
      }
      throw new Error(`A manager already owns this data directory (PID ${pid})`);
    }
    try {
      if (existsSync(this.indexPath)) {
        const index = JSON.parse(readFileSync(this.indexPath, 'utf8'));
        if (index.version !== 1 || !Array.isArray(index.sessions)) throw new Error('Unsupported session index');
        for (const stored of index.sessions as StoredSession[]) {
          if (stored.status === 'running') { stored.status = 'interrupted'; stored.lastError = 'Manager restarted during a run; saved history was retained.'; }
          for (const action of Object.values(stored.actions)) if (action.status === 'accepted') { action.status = 'unknown'; action.error = 'Manager restarted after accepting this action; do not automatically resubmit.'; }
          this.sessions.set(stored.id, this.runtime(stored));
        }
      }
      this.save();
      mkdirSync(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
      if (existsSync(this.options.socketPath)) {
        if (!statSync(this.options.socketPath).isSocket()) throw new Error('Refusing to replace a non-socket path');
        await new Promise<void>((resolvePromise, reject) => {
          const probe = connectSocket(this.options.socketPath);
          probe.once('connect', () => { probe.destroy(); reject(new Error('Another service is already listening on this socket')); });
          probe.once('error', error => {
            if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (error as NodeJS.ErrnoException).code === 'ENOENT') resolvePromise();
            else reject(error);
          });
        });
        unlinkSync(this.options.socketPath);
      }
      this.server = createServer(socket => this.connect(socket));
      await new Promise<void>((resolvePromise, reject) => { this.server!.once('error', reject); this.server!.listen(this.options.socketPath, resolvePromise); });
      chmodSync(this.options.socketPath, 0o600);
      this.timer = setInterval(() => { for (const session of this.sessions.values()) this.expireControl(session); }, Math.min(1_000, this.options.leaseMs ?? 30_000));
      this.timer.unref();
    } catch (error) { if (this.ownsLock) { unlinkSync(this.lockPath); this.ownsLock = false; } throw error; }
  }
  private info(runtime: Runtime): SessionInfo {
    const { id, projectId, name, createdAt, sessionFile, status, lastError } = runtime.stored;
    return { id, projectId, name, createdAt, sessionFile, status, lastError };
  }
  private send(connection: Connection, record: ServerRecord): void {
    if (connection.socket.destroyed) return;
    // Slow phones must never stop consumption of a worker's stdout.
    if (connection.socket.writableLength > 4 * 1024 * 1024) { connection.socket.destroy(); return; }
    connection.socket.write(JSON.stringify(record) + '\n');
  }
  private connect(socket: Socket): void {
    const connection: Connection = { id: randomUUID(), socket, subscriptions: new Map(), inFlight: 0 };
    this.connections.set(connection.id, connection);
    const decoder = new JsonlDecoder(value => {
      if (connection.inFlight >= 64) { socket.destroy(); return; }
      connection.inFlight++;
      void this.receive(connection, value).finally(() => { connection.inFlight--; });
    });
    socket.on('data', data => { try { decoder.write(data); } catch { socket.destroy(); } });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.connections.delete(connection.id);
      for (const session of this.sessions.values()) if (session.control?.connectionId === connection.id) delete session.control.connectionId;
    });
  }
  private session(id: unknown): Runtime {
    const session = this.sessions.get(required(id, 'sessionId'));
    if (!session) throw new ProtocolError('not_found', 'Unknown session');
    return session;
  }
  private control(session: Runtime): Control | null {
    this.expireControl(session);
    return session.control ? { clientId: session.control.clientId, expiresAt: session.control.expiresAt } : null;
  }
  private expireControl(session: Runtime): void {
    if (session.control && session.control.expiresAt <= Date.now()) { session.control = null; this.emit(session, { type: 'control_changed', control: null }); }
  }
  private requireControl(session: Runtime, connection: Connection): void {
    this.expireControl(session);
    if (session.control?.connectionId !== connection.id) throw new ProtocolError('not_controller', 'Acquire control before sending commands');
    session.control.expiresAt = Date.now() + (this.options.leaseMs ?? 30_000);
  }
  private emit(session: Runtime, event: JsonRecord): void {
    if (session.seq >= session.stored.seqReserved) { session.stored.seqReserved = session.seq + 1024; this.save(); }
    const envelope: SessionEvent = { type: 'event', sessionId: session.stored.id, seq: ++session.seq, event };
    session.events.push(envelope);
    if (session.events.length > (this.options.eventLimit ?? 2048)) session.events.shift();
    for (const connection of this.connections.values()) {
      if (!connection.subscriptions.has(session.stored.id)) continue;
      const queue = connection.subscriptions.get(session.stored.id);
      if (queue) {
        queue.push(envelope);
        if (queue.length > (this.options.eventLimit ?? 2048) * 2) connection.socket.destroy();
      } else this.send(connection, envelope);
    }
  }
  private record(session: Runtime, event: JsonRecord): void {
    if (event.type === 'agent_start') { session.stored.status = 'running'; session.state.isStreaming = true; this.save(); }
    if (event.type === 'agent_settled') { session.stored.status = 'idle'; delete session.stored.lastError; session.state.isStreaming = false; session.tools.clear(); session.partial = null; this.save(); }
    if (event.type === 'message_start' && event.message && typeof event.message === 'object' && (event.message as Record<string, unknown>).role === 'assistant') session.partial = clone(event.message as Record<string, unknown>);
    if (event.type === 'message_update' && session.partial) this.updatePartial(session.partial, event.assistantMessageEvent as Record<string, unknown>);
    if (event.type === 'message_end' && (event.message as Record<string, unknown>)?.role === 'assistant') session.partial = null;
    if ((event.type === 'tool_execution_start' || event.type === 'tool_execution_update') && typeof event.toolCallId === 'string') session.tools.set(event.toolCallId, clone(event));
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') session.tools.delete(event.toolCallId);
    if (event.type === 'session_info_changed') { session.stored.name = typeof event.name === 'string' ? event.name : session.stored.name; session.state.sessionName = event.name; this.save(); }
    if (event.type === 'thinking_level_changed') session.state.thinkingLevel = event.level;
    if (event.type === 'compaction_start') session.state.isCompacting = true;
    if (event.type === 'compaction_end') session.state.isCompacting = false;
    if (event.type === 'queue_update') session.state.pendingMessageCount = (Array.isArray(event.steering) ? event.steering.length : 0) + (Array.isArray(event.followUp) ? event.followUp.length : 0);
    if (event.type === 'extension_ui_request') {
      if (event.method === 'setStatus') {
        const key = 'status:' + String(event.statusKey);
        if (event.statusText === undefined) session.uiState.delete(key); else session.uiState.set(key, clone(event));
      }
      if (event.method === 'setWidget') {
        const key = 'widget:' + String(event.widgetKey);
        if (event.widgetLines === undefined) session.uiState.delete(key); else session.uiState.set(key, clone(event));
      }
      if (event.method === 'setTitle') session.uiState.set('title', clone(event));
    }
    if (event.type === 'extension_ui_request' && dialogMethods.has(String(event.method)) && typeof event.id === 'string') {
      session.pendingUi.set(event.id, clone(event));
      if (typeof event.timeout === 'number' && event.timeout > 0) {
        const id = event.id;
        const timer = setTimeout(() => { session.pendingUi.delete(id); session.uiTimers.delete(id); this.emit(session, { type: 'extension_ui_expired', id }); }, event.timeout);
        timer.unref(); session.uiTimers.set(id, timer);
      }
    }
    this.emit(session, event);
  }
  private updatePartial(message: Record<string, unknown>, update: Record<string, unknown> | undefined): void {
    if (!update || typeof update.contentIndex !== 'number') return;
    const content = (Array.isArray(message.content) ? message.content : []) as Record<string, unknown>[];
    message.content = content;
    const index = update.contentIndex;
    if (update.type === 'text_start') content[index] = { type: 'text', text: '' };
    if (update.type === 'thinking_start') content[index] = { type: 'thinking', thinking: '' };
    if (update.type === 'toolcall_start') content[index] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {} };
    if (update.type === 'text_delta' || update.type === 'thinking_delta') {
      const key = update.type === 'text_delta' ? 'text' : 'thinking';
      const block = content[index] ?? (content[index] = { type: key });
      block[key] = String(block[key] ?? '') + String(update.delta ?? '');
    }
    if (update.type === 'text_end') content[index] = { type: 'text', text: update.content };
    if (update.type === 'thinking_end') content[index] = { type: 'thinking', thinking: update.content };
    if (update.type === 'toolcall_end') content[index] = clone(update.toolCall as Record<string, unknown>);
  }
  private async worker(session: Runtime): Promise<PiWorker> {
    if (session.worker) return session.worker;
    if (session.starting) return session.starting;
    const project = this.options.projects.find(p => p.id === session.stored.projectId);
    if (!project) throw new ProtocolError('project_missing', 'This session’s project is no longer configured');
    session.starting = (async () => {
      const sessionDir = join(this.options.dataDir, 'sessions', session.stored.id);
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const args = [...(this.options.piArgs ?? []), '--mode', 'rpc', '--session-dir', sessionDir];
      if (session.stored.sessionFile) args.push('--session', session.stored.sessionFile);
      // Pi deliberately keeps empty sessions in memory. Restore their display
      // name from our durable index until a user/assistant message creates a file.
      if ((!session.stored.sessionFile || !existsSync(session.stored.sessionFile)) && session.stored.name) args.push('--name', session.stored.name);
      const worker = new PiWorker({ command: this.options.piCommand ?? 'pi', args, cwd: project.path, env: this.options.env, timeoutMs: this.options.rpcTimeoutMs,
        onRecord: record => this.record(session, record),
        onDiagnostic: text => this.options.diagnostic?.(session.stored.id, text),
        onExit: error => {
          session.worker = undefined;
          session.partial = null; session.tools.clear(); session.pendingUi.clear(); session.uiState.clear();
          for (const timer of session.uiTimers.values()) clearTimeout(timer);
          session.uiTimers.clear();
          if (session.stored.status === 'running') session.stored.status = 'interrupted';
          else if (!this.stopping) session.stored.status = 'error';
          if (!this.stopping) session.stored.lastError = error.message;
          this.save();
          this.emit(session, { type: 'worker_exit', status: session.stored.status, error: error.message });
        },
      });
      try {
        const state = await worker.request({ type: 'get_state' });
        if (!state.success || !state.data || typeof state.data !== 'object') throw new Error('Pi did not provide initial state');
        session.state = state.data as Record<string, unknown>;
        if (typeof session.state.sessionFile === 'string') session.stored.sessionFile = session.state.sessionFile;
        if (!session.stored.sessionFile) throw new Error('Pi did not provide a persistent session file; refusing ephemeral worker');
        session.worker = worker;
        this.save();
        return worker;
      } catch (error) { await worker.stop(); throw error; }
      finally { session.starting = undefined; }
    })();
    return session.starting;
  }
  private async subscribe(connection: Connection, session: Runtime, afterSeq: unknown): Promise<SubscriptionSnapshot> {
    connection.subscriptions.set(session.stored.id, []);
    const worker = await this.worker(session);
    if (typeof afterSeq === 'number' && Number.isSafeInteger(afterSeq) && afterSeq >= 0 && afterSeq <= session.seq && (afterSeq === session.seq || (session.events.length && afterSeq >= session.events[0]!.seq - 1))) {
      return { mode: 'replay', session: this.info(session), state: clone(session.state), messages: [], partialMessage: clone(session.partial), activeTools: [...session.tools.values()].map(clone), cursor: session.seq, events: session.events.filter(event => event.seq > afterSeq), control: this.control(session), pendingUi: [...session.pendingUi.values()].map(clone), uiState: [...session.uiState.values()].map(clone) };
    }
    // Refresh state first, then let live events advance it until the messages
    // response. Capture every projected field at that one stdout boundary.
    const state = await worker.request({ type: 'get_state' }, response => {
      if (response.success) session.state = clone(response.data as Record<string, unknown>);
    });
    if (!state.success) throw new Error('Unable to synchronize Pi state');
    let cursor = session.seq;
    let snapshotState = clone(session.state);
    let partial: Record<string, unknown> | null = null;
    let tools: JsonRecord[] = [];
    const messages = await worker.request({ type: 'get_messages' }, () => { cursor = session.seq; snapshotState = clone(session.state); partial = clone(session.partial); tools = [...session.tools.values()].map(clone); });
    if (!messages.success) throw new Error('Unable to synchronize Pi messages');
    return { mode: 'snapshot', session: this.info(session), state: snapshotState, messages: ((messages.data as Record<string, unknown>)?.messages ?? []) as unknown[], partialMessage: partial, activeTools: tools, cursor, events: [], control: this.control(session), pendingUi: [...session.pendingUi.values()].map(clone), uiState: [...session.uiState.values()].map(clone) };
  }
  private async rpc(connection: Connection, session: Runtime, request: AppRequest): Promise<unknown> {
    if (!request.rpc || typeof request.rpc !== 'object' || typeof request.rpc.type !== 'string') throw new ProtocolError('invalid_request', 'rpc must contain a Pi command');
    const rpc = clone(request.rpc);
    if (readCommands.has(rpc.type)) {
      const response = await (await this.worker(session)).request(rpc);
      if (request.rpc.id !== undefined) response.id = request.rpc.id;
      return { response };
    }
    if (identityCommands.has(rpc.type)) throw new ProtocolError('managed_session', 'Create a managed session instead of switching a worker’s session identity');
    const actionId = required(request.clientActionId, 'clientActionId');
    const fingerprint = createHash('sha256').update(canonical(rpc)).digest('hex');
    const previous = session.stored.actions[actionId];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ProtocolError('action_conflict', 'clientActionId already identifies a different command');
      return { receipt: previous };
    }
    this.requireControl(session, connection);
    const worker = await this.worker(session);
    // Another concurrent request can finish worker startup first.
    const concurrent = session.stored.actions[actionId];
    if (concurrent) {
      if (concurrent.fingerprint !== fingerprint) throw new ProtocolError('action_conflict', 'clientActionId already identifies a different command');
      return { receipt: concurrent };
    }
    this.requireControl(session, connection);
    if (rpc.type === 'extension_ui_response') {
      const pending = session.pendingUi.get(required(rpc.id, 'extension request id'));
      if (!pending) throw new ProtocolError('ui_expired', 'This extension dialog is no longer pending');
      if (rpc.cancelled !== true && (pending.method === 'confirm' ? typeof rpc.confirmed !== 'boolean' : typeof rpc.value !== 'string')) throw new ProtocolError('invalid_request', 'Invalid extension dialog response');
      if (pending.method === 'select' && rpc.cancelled !== true && !(pending.options as unknown[]).includes(rpc.value)) throw new ProtocolError('invalid_request', 'Select one of the requested options');
    }
    const receipt: StoredSession['actions'][string] = { clientActionId: actionId, status: 'accepted', acceptedAt: new Date().toISOString(), rpc, fingerprint };
    session.stored.actions[actionId] = receipt;
    // Durable acceptance precedes writing to Pi. An uncertain outcome is never retried automatically.
    this.save();
    try {
      if (rpc.type === 'extension_ui_response') {
        await worker.write(rpc);
        session.pendingUi.delete(String(rpc.id));
        clearTimeout(session.uiTimers.get(String(rpc.id))); session.uiTimers.delete(String(rpc.id));
        receipt.response = { type: 'response', command: rpc.type, success: true };
        this.emit(session, { type: 'extension_ui_resolved', id: rpc.id });
      } else {
        receipt.response = await worker.request(rpc, response => {
          if (!response.success) return;
          if (rpc.type === 'set_model') session.state.model = response.data;
          if (rpc.type === 'cycle_model' && response.data) Object.assign(session.state, response.data);
          if (rpc.type === 'set_thinking_level') session.state.thinkingLevel = rpc.level;
          if (rpc.type === 'cycle_thinking_level' && response.data) session.state.thinkingLevel = (response.data as Record<string, unknown>).level;
          if (rpc.type === 'set_session_name') { session.state.sessionName = rpc.name; session.stored.name = String(rpc.name); }
        });
        if (rpc.id !== undefined) receipt.response.id = rpc.id;
      }
      receipt.status = 'completed';
    } catch (error) { receipt.status = 'unknown'; receipt.error = (error as Error).message; }
    this.save();
    this.emit(session, { type: 'action_result', receipt });
    return { receipt };
  }
  private async receive(connection: Connection, value: unknown): Promise<void> {
    const request = value as AppRequest;
    const id = typeof request?.id === 'string' ? request.id : '';
    let subscribing: Runtime | undefined;
    try {
      if (!request || typeof request !== 'object') throw new ProtocolError('invalid_request', 'Expected an object');
      required(request.id, 'id'); required(request.type, 'type');
      if (request.type === 'hello') {
        if (connection.clientId) throw new ProtocolError('already_initialized', 'hello has already completed');
        connection.clientId = required(request.clientId, 'clientId');
        this.send(connection, { type: 'result', id, ok: true, data: { version: 1, leaseMs: this.options.leaseMs ?? 30_000 } }); return;
      }
      if (!connection.clientId) throw new ProtocolError('hello_required', 'Send hello before other requests');
      let data: unknown;
      if (request.type === 'list_projects') data = { projects: this.options.projects };
      else if (request.type === 'list_sessions') data = { sessions: [...this.sessions.values()].map(session => this.info(session)) };
      else if (request.type === 'create_session') {
        const projectId = required(request.projectId, 'projectId');
        if (!this.options.projects.some(project => project.id === projectId)) throw new ProtocolError('not_found', 'Unknown project');
        const session = this.runtime({ id: randomUUID(), projectId, name: request.name ? required(request.name, 'name') : 'New session', createdAt: new Date().toISOString(), status: 'idle', seqReserved: 0, actions: {} });
        this.sessions.set(session.stored.id, session); this.save();
        await this.worker(session);
        data = { session: this.info(session) };
      } else {
        const session = this.session(request.sessionId);
        switch (request.type) {
          case 'subscribe': subscribing = session; data = await this.subscribe(connection, session, request.afterSeq); break;
          case 'unsubscribe': connection.subscriptions.delete(session.stored.id); data = {}; break;
          case 'acquire_control': {
            this.expireControl(session);
            if (session.control && (session.control.clientId !== connection.clientId || (session.control.connectionId && session.control.connectionId !== connection.id))) throw new ProtocolError('control_busy', 'Another client currently controls this session');
            session.control = { clientId: connection.clientId, connectionId: connection.id, expiresAt: Date.now() + (this.options.leaseMs ?? 30_000) };
            data = { control: this.control(session), pendingUi: [...session.pendingUi.values()].map(clone) };
            this.emit(session, { type: 'control_changed', control: this.control(session) }); break;
          }
          case 'heartbeat': this.requireControl(session, connection); data = { control: this.control(session) }; break;
          case 'release_control': this.requireControl(session, connection); session.control = null; this.emit(session, { type: 'control_changed', control: null }); data = { control: null }; break;
          case 'action_status': data = { receipt: session.stored.actions[required(request.clientActionId, 'clientActionId')] ?? null }; break;
          case 'rpc': data = await this.rpc(connection, session, request); break;
          default: throw new ProtocolError('unknown_request', `Unknown request type ${request.type}`);
        }
      }
      this.send(connection, { type: 'result', id, ok: true, data });
      if (subscribing) {
        const snapshot = data as SubscriptionSnapshot;
        const queue = connection.subscriptions.get(subscribing.stored.id) ?? [];
        connection.subscriptions.set(subscribing.stored.id, null);
        for (const event of queue) if (event.seq > snapshot.cursor) this.send(connection, event);
      }
    } catch (error) {
      if (subscribing) connection.subscriptions.delete(subscribing.stored.id);
      this.send(connection, { type: 'result', id, ok: false, error: { code: error instanceof ProtocolError ? error.code : 'internal_error', message: (error as Error).message } });
    }
  }
  stop(): Promise<void> {
    this.stopPromise ??= this.shutdown();
    return this.stopPromise;
  }
  private async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    for (const connection of this.connections.values()) connection.socket.destroy();
    const serverClosed = this.server ? new Promise<void>(resolvePromise => this.server!.close(() => resolvePromise())) : Promise.resolve();
    await Promise.all([...this.sessions.values()].map(async session => {
      for (const timer of session.uiTimers.values()) clearTimeout(timer);
      const worker = session.worker ?? await session.starting?.catch(() => undefined);
      await worker?.stop();
    }));
    await serverClosed;
    this.save();
    if (this.ownsLock) { unlinkSync(this.lockPath); this.ownsLock = false; }
  }
}
