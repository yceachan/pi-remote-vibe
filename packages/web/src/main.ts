import {startAuthentication, startRegistration} from '@simplewebauthn/browser';
import {connectSsh} from '@pi-remote/browser-ssh';
import {ProtocolClient} from './transport.js';
import {applyEvent, emptyView, messageText, type SessionView} from './state.js';
import {decryptPrivateKey, encryptPrivateKey, loadEncryptedKey, saveEncryptedKey, deleteEncryptedKey, normalizeFingerprint} from './vault.js';
import './style.css';

type Host = {id: string; name: string; sshUser: string};
type Session = {id: string; name: string; projectId: string; status: string; lastError?: string};
type PendingAction = {hostId: string; sessionId: string; clientActionId: string; rpc: any; status?: string};
const app = document.querySelector<HTMLDivElement>('#app')!;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]!));
const read = <T>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(`pi:${key}`) ?? 'null') ?? fallback; } catch { return fallback; } };
const save = (key: string, value: unknown) => localStorage.setItem(`pi:${key}`, JSON.stringify(value));
const selection = read<{hostId?: string; projectId?: string; sessionId?: string}>('selection', {});
// A tab owns its lease. Reusing a shared browser-wide ID would let two tabs write.
let clientId = sessionStorage.getItem('pi:clientId');
if (!clientId) { clientId = crypto.randomUUID(); sessionStorage.setItem('pi:clientId', clientId); }
const state = {
  authenticated: false, account: '', hosts: [] as Host[], hostId: selection.hostId ?? '', projects: [] as {id: string; name: string}[],
  projectId: selection.projectId ?? '', sessions: [] as Session[], sessionId: selection.sessionId ?? '', views: new Map<string, SessionView>(),
  controls: new Map<string, {clientId: string; expiresAt: number} | null>(),
  models: [] as any[], commands: [] as any[], model: '', busy: false, connecting: false,
  connected: false, connectionText: '尚未连接', error: '', notice: '', sidebar: !matchMedia('(max-width:600px)').matches, hasKey: false,
  statuses: new Map<string, string>(), widgets: new Map<string, {text: string; placement: string}>(), ui: [] as any[],
};
let privateKey: string | null = null;
let protocol: ProtocolClient | null = null;
let controller: AbortController | null = null;
let explicitDisconnect = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let subscriptionBuffer: any[] | null = null;
let syncing = false;
let renderFrame = 0;
let historyPosition = -1;
let needsSync = false;
let activeUiId: string | null = null;
const pending = () => read<PendingAction[]>('pending-actions', []);
const setPending = (actions: PendingAction[]) => save('pending-actions', actions);
const current = () => state.views.get(state.sessionId);
const ownsControl = () => state.controls.get(state.sessionId)?.clientId === clientId && (state.controls.get(state.sessionId)?.expiresAt ?? 0) > Date.now();
const draftKey = () => `draft:${state.hostId}:${state.sessionId}`;
const setError = (error: unknown) => { state.error = error instanceof Error ? error.message : String(error); renderNotice(); };
const busy = async (work: () => Promise<void>) => { if (state.busy) return; state.busy = true; renderControls(); try { await work(); } catch (error) { setError(error); } finally { state.busy = false; renderControls(); } };

async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`/api${path}`, {method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message ?? result.error ?? `服务响应 ${response.status}`);
  return result;
}

async function refreshAccount(): Promise<void> {
  const account = await api('/me');
  state.authenticated = account.authenticated;
  state.account = account.user?.name ?? account.user?.id ?? '';
  state.hosts = state.authenticated ? (await api('/hosts')).hosts : [];
  if (state.authenticated && !state.hosts.some((host) => host.id === state.hostId)) {
    state.hostId = state.hosts[0]?.id ?? ''; state.sessionId = ''; state.projectId = ''; state.views.clear();
  }
  render();
}

async function login(register = false, token = '', name = ''): Promise<void> {
  if (!window.isSecureContext) throw new Error('Passkey 与本地密钥需要 HTTPS 或 localhost 安全环境。');
  const kind = register ? 'register' : 'login';
  const {options} = await api(`/auth/${kind}/options`, register ? {token, name} : {});
  const credential = register ? await startRegistration({optionsJSON: options}) : await startAuthentication({optionsJSON: options});
  await api(`/auth/${kind}/verify`, {credential});
  state.error = ''; await refreshAccount();
}

function persistDraft(): void {
  const editor = document.querySelector<HTMLTextAreaElement>('#composer');
  if (editor?.dataset.draftKey) save(editor.dataset.draftKey, editor.value);
}

function disconnect(): void {
  explicitDisconnect = true; clearTimeout(reconnectTimer); controller?.abort(); protocol?.close(); protocol = null;
  state.connected = false; state.connecting = false; state.connectionText = '已断开';
  state.controls.clear(); render();
}

async function connect(): Promise<void> {
  if (state.connecting) return;
  if (state.authenticated && !(await api('/me')).authenticated) {
    state.authenticated = false; state.hosts = []; render();
    throw new Error('登录已过期，请重新使用 Passkey 登录。');
  }
  const host = state.hosts.find((item) => item.id === state.hostId);
  if (!host) throw new Error('请先登录并选择已授权的主机。');
  if (!privateKey) { showVault(); return; }
  const pin = read<Record<string, string>>('host-pins', {})[host.id];
  if (!pin) { showTrust(); return; }
  explicitDisconnect = false; state.connecting = true; state.connectionText = '正在验证 SSH 身份…'; state.error = ''; render();
  controller = new AbortController();
  try {
    const url = new URL(`/relay/${encodeURIComponent(host.id)}`, location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const channel = await connectSsh({url: url.href, username: host.sshUser, privateKey, expectedFingerprint: pin, signal: controller.signal});
    const client = new ProtocolClient(channel); protocol = client;
    client.onEvent = onRecord;
    client.onClose = (error) => {
      if (protocol !== client) return;
      protocol = null; state.connected = false; state.connecting = false; state.controls.clear(); state.connectionText = '连接断开 · PC 任务继续';
      if (!explicitDisconnect) { setError(error); scheduleReconnect(); } render();
    };
    await client.request('hello', {clientId});
    const [projects, sessions] = await Promise.all([client.request('list_projects'), client.request('list_sessions')]);
    state.projects = projects.projects; state.sessions = sessions.sessions;
    if (!state.projects.some((project) => project.id === state.projectId)) state.projectId = state.projects[0]?.id ?? '';
    state.connected = true; state.connecting = false; state.connectionText = 'SSH 已验证 · 端到端连接'; reconnectAttempt = 0;
    if (state.sessionId && state.sessions.some((session) => session.id === state.sessionId)) await selectSession(state.sessionId);
    else { state.sessionId = ''; render(); }
  } catch (error) {
    state.connecting = false; state.connectionText = '连接失败';
    if (protocol) { protocol.onClose = () => {}; protocol.close(); } protocol = null; render(); throw error;
  }
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  if (explicitDisconnect || !privateKey || !state.authenticated || !navigator.onLine || document.visibilityState === 'hidden') return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
  reconnectTimer = setTimeout(() => { void connect().catch((error) => { setError(error); scheduleReconnect(); }); }, delay);
}

async function selectSession(sessionId: string): Promise<void> {
  if (!protocol) return;
  persistDraft();
  const previous = state.sessionId;
  if (previous && previous !== sessionId) {
    if (ownsControl()) await protocol.request('release_control', {sessionId: previous}).catch(() => {});
    await protocol.request('unsubscribe', {sessionId: previous});
  }
  state.sessionId = sessionId; state.ui = []; state.statuses.clear(); state.widgets.clear(); state.models = []; state.commands = [];
  state.projectId = state.sessions.find((session) => session.id === sessionId)?.projectId ?? state.projectId;
  save('selection', {hostId: state.hostId, projectId: state.projectId, sessionId});
  if (matchMedia('(max-width:600px)').matches) state.sidebar = false;
  historyPosition = -1; await synchronize();
  try { const result = await protocol.request('acquire_control', {sessionId}); state.controls.set(sessionId, result.control ?? result); }
  catch { state.notice = '此会话由另一客户端控制。仍可查看实时结果。'; }
  await reconcileActions();
  const [models, commands] = await Promise.allSettled([query('get_available_models'), query('get_commands')]);
  if (models.status === 'fulfilled') state.models = models.value.models ?? [];
  if (commands.status === 'fulfilled') state.commands = commands.value.commands ?? [];
  render(); showNextUi();
}

async function synchronize(force = false): Promise<void> {
  if (!protocol || !state.sessionId || syncing) return;
  syncing = true; subscriptionBuffer = [];
  const sessionId = state.sessionId;
  try {
    const existing = state.views.get(sessionId);
    const snapshot = await protocol.request('subscribe', {sessionId, ...(existing && !force ? {afterSeq: existing.cursor} : {})});
    const view = snapshot.mode === 'replay' && existing ? existing : emptyView();
    if (snapshot.mode === 'snapshot') {
      view.cursor = snapshot.cursor; view.messages = snapshot.messages ?? []; view.streaming = snapshot.partialMessage;
      view.running = !!snapshot.state?.isStreaming || snapshot.session?.status === 'running';
      view.status = snapshot.session?.status === 'interrupted' ? '已中断 · 历史已恢复' : view.running ? '运行中' : '就绪';
      for (const tool of snapshot.activeTools ?? []) {
        view.tools[tool.toolCallId] = {name: tool.toolName, text: messageText(tool.partialResult ?? tool.result) || JSON.stringify(tool.args ?? {}), done: tool.type === 'tool_execution_end', error: tool.isError};
      }
    }
    state.views.set(sessionId, view); state.controls.set(sessionId, snapshot.control);
    state.model = snapshot.state?.model?.name ?? snapshot.state?.model?.id ?? '';
    state.statuses.clear(); state.widgets.clear(); document.title = 'Pi Remote';
    for (const event of snapshot.uiState ?? []) handleUi(event);
    state.ui = snapshot.pendingUi ?? [];
    if (activeUiId && !state.ui.some((item) => item.id === activeUiId)) {
      activeUiId = null; document.querySelector<HTMLDialogElement>('#modal')?.close();
    }
    for (const event of snapshot.events ?? []) consumeEvent(event);
    for (const event of subscriptionBuffer) consumeEvent(event);
  } finally { subscriptionBuffer = null; syncing = false; }
  if (needsSync) { needsSync = false; await synchronize(true); return; }
  render(); showNextUi();
}

function onRecord(record: any): void {
  if (record.type !== 'event') return;
  if (subscriptionBuffer) { subscriptionBuffer.push(record); return; }
  consumeEvent(record);
}

function consumeEvent(record: any): void {
  const view = state.views.get(record.sessionId);
  if (!view) return;
  if (record.seq <= view.cursor) return;
  if (!applyEvent(view, record)) {
    state.notice = '事件序号存在缺口，正在重新同步完整状态。';
    if (!syncing) void synchronize(true).catch(setError); else needsSync = true;
    return;
  }
  const event = record.event;
  if (event.type === 'control_changed') {
    state.controls.set(record.sessionId, event.control ?? null);
    if (!ownsControl() && activeUiId) { activeUiId = null; document.querySelector<HTMLDialogElement>('#modal')?.close(); }
  }
  if (event.type === 'extension_ui_request') handleUi(event);
  if (event.type === 'extension_ui_expired' || event.type === 'extension_ui_resolved') {
    state.ui = state.ui.filter((item) => item.id !== event.id);
    if (activeUiId === event.id) { activeUiId = null; document.querySelector<HTMLDialogElement>('#modal')?.close(); }
    showNextUi();
  }
  if (event.type === 'response' && event.success === false) state.error = event.error ?? 'Pi 命令失败。';
  if (event.type === 'action_result' && event.receipt) finishReceipt(event.receipt);
  const session = state.sessions.find((item) => item.id === record.sessionId);
  if (session) session.status = view.running ? 'running' : view.status.startsWith('已中断') ? 'interrupted' : 'idle';
  if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderConversation(); renderControls(); renderNotice(); });
}

async function query(type: string): Promise<any> {
  if (!protocol) throw new Error('请先连接 PC。');
  const result = await protocol.request('rpc', {sessionId: state.sessionId, rpc: {type, id: crypto.randomUUID()}});
  const response = result.response;
  if (response?.success === false) throw new Error(response.error ?? 'Pi 查询失败。');
  return response?.data ?? {};
}

function finishReceipt(receipt: any): void {
  const actions = pending();
  if (receipt.status === 'completed') {
    setPending(actions.filter((action) => action.clientActionId !== receipt.clientActionId));
    if (receipt.response?.success === false) state.error = receipt.response.error ?? 'Pi 未接受操作。';
  } else {
    const action = actions.find((item) => item.clientActionId === receipt.clientActionId);
    if (action) { action.status = receipt.status; setPending(actions); }
  }
}

async function sendRpc(rpc: any): Promise<any> {
  if (!protocol || !ownsControl()) throw new Error('需要取得此会话控制权才能操作。');
  const action: PendingAction = {hostId: state.hostId, sessionId: state.sessionId, clientActionId: crypto.randomUUID(), rpc: {...rpc, id: rpc.id ?? crypto.randomUUID()}};
  setPending([...pending(), action]); // Persist before any bytes leave the browser.
  let result: any;
  try { result = await protocol.request('rpc', {...action}); }
  catch (error) {
    // A structured rejection means the manager did not durably accept the action.
    // Transport errors/timeouts remain pending until action_status resolves them.
    if ((error as {code?: string}).code && (error as {code?: string}).code !== 'action_conflict') setPending(pending().filter((item) => item.clientActionId !== action.clientActionId));
    throw error;
  }
  if (result.receipt) finishReceipt(result.receipt);
  if (result.receipt?.response?.success === false) throw new Error(result.receipt.response.error ?? 'Pi 拒绝了操作。');
  return result.receipt;
}

async function reconcileActions(): Promise<void> {
  if (!protocol) return;
  for (const action of pending().filter((item) => item.hostId === state.hostId && item.sessionId === state.sessionId)) {
    const {receipt} = await protocol.request('action_status', {sessionId: action.sessionId, clientActionId: action.clientActionId});
    if (receipt) finishReceipt(receipt);
    else if (ownsControl()) {
      const result = await protocol.request('rpc', {...action}); // Same ID; server confirms it never received it.
      if (result.receipt) finishReceipt(result.receipt);
    }
  }
  renderNotice();
}

async function submitPrompt(): Promise<void> {
  const editor = document.querySelector<HTMLTextAreaElement>('#composer')!;
  const message = editor.value.trim(); if (!message) return;
  const unresolved = pending().some((item) => item.hostId === state.hostId && item.sessionId === state.sessionId && item.rpc.type === 'prompt');
  if (unresolved) throw new Error('上一次输入的接收状态尚未确定，请先检查待确认操作，避免重复提交。');
  const mode = document.querySelector<HTMLSelectElement>('#queue-mode')?.value ?? 'followUp';
  await sendRpc({type: 'prompt', message, ...(current()?.running ? {streamingBehavior: mode} : {})});
  save(`history:${state.hostId}`, [message, ...read<string[]>(`history:${state.hostId}`, []).filter((text) => text !== message)].slice(0, 50));
  save(draftKey(), ''); editor.value = ''; historyPosition = -1; renderNotice();
}

function render(): void {
  persistDraft();
  activeUiId = null;
  app.innerHTML = `<header class="topbar"><button class="icon-button" data-action="sidebar" aria-label="切换会话列表">☰</button><a class="brand" href="/">π <span>remote</span></a><span class="top-spacer"></span><span class="connection ${state.connected ? 'online' : ''}"><i></i>${escape(state.connectionText)}</span><button class="text-button" data-action="vault">${privateKey ? '锁定密钥' : '解锁密钥'}</button><button class="avatar" data-action="account" aria-label="账户与登录">${state.authenticated ? escape(state.account.slice(0, 1).toUpperCase() || '我') : '登录'}</button></header>
  <div class="workspace ${state.sidebar ? '' : 'sidebar-hidden'}"><aside class="sidebar"><div class="section-heading"><span>工作空间</span><span class="eyebrow">PRIVATE</span></div>
  <label class="field-label" for="host-select">主机</label><select id="host-select" ${state.connecting ? 'disabled' : ''}>${state.hosts.length ? state.hosts.map((host) => `<option value="${escape(host.id)}" ${host.id === state.hostId ? 'selected' : ''}>${escape(host.name)}</option>`).join('') : '<option>登录后加载主机</option>'}</select>
  <div class="host-actions"><button class="button primary small" data-action="connect" ${!state.authenticated || state.connecting ? 'disabled' : ''}>${state.connected ? '断开连接' : state.connecting ? '连接中…' : '连接 PC'}</button><button class="text-button" data-action="trust" ${!state.hostId ? 'disabled' : ''}>主机信任</button></div>
  <label class="field-label" for="project-select">项目</label><select id="project-select" ${!state.connected ? 'disabled' : ''}>${state.projects.length ? state.projects.map((project) => `<option value="${escape(project.id)}" ${project.id === state.projectId ? 'selected' : ''}>${escape(project.name)}</option>`).join('') : '<option>连接后由 PC 提供</option>'}</select>
  <div class="section-heading session-heading"><span>会话</span><button class="icon-button" data-action="create" aria-label="创建会话" ${!state.connected || !state.projectId ? 'disabled' : ''}>＋</button></div>
  <nav class="session-list" aria-label="会话列表">${state.sessions.filter((session) => session.projectId === state.projectId).map((session) => `<button class="session ${session.id === state.sessionId ? 'selected' : ''}" data-session="${escape(session.id)}"><span class="session-dot ${session.status}"></span><span><strong>${escape(session.name || '未命名会话')}</strong><small>${escape(({running: '运行中', idle: '就绪', interrupted: '已中断', error: '发生错误'} as Record<string, string>)[session.status] ?? session.status)}</small></span><span class="chevron">›</span></button>`).join('') || '<p class="muted empty-list">尚无会话<br>连接 PC 后创建第一个会话。</p>'}</nav>
  <div class="sidebar-footer"><span class="shield">◇</span><p>计算留在你的 PC<br><small>手机离线，任务继续</small></p></div></aside>
  <main class="main"><div id="notice" aria-live="polite"></div><section id="conversation" class="conversation" aria-live="polite" aria-label="会话内容"></section><div id="widgets-above" class="widgets"></div><footer class="composer-area"><div id="control-bar"></div><form id="prompt-form"><textarea id="composer" data-draft-key="${state.sessionId ? escape(draftKey()) : ''}" rows="3" placeholder="${state.sessionId ? '告诉 Pi 接下来做什么…' : '选择一个会话开始工作'}" aria-label="多行任务输入" ${!state.sessionId ? 'disabled' : ''}>${escape(state.sessionId ? read(draftKey(), '') : '')}</textarea><div class="composer-toolbar"><button type="button" class="text-button" data-action="commands" ${!state.sessionId ? 'disabled' : ''}>/ 命令</button><button type="button" class="text-button" data-action="history" ${!state.sessionId ? 'disabled' : ''}>输入历史</button><select id="queue-mode" aria-label="运行中输入处理方式"><option value="followUp">完成后接续</option><option value="steer">当前任务中追加</option></select><span class="top-spacer"></span><button class="send-button" id="send-button" type="submit" aria-label="发送任务">发送 ↑</button></div></form><div id="widgets-below" class="widgets"></div><p class="composer-hint">Enter 换行 · Ctrl / ⌘ + Enter 发送<span>草稿保存在此设备</span></p></footer></main></div><dialog id="modal"></dialog>`;
  renderNotice(); renderConversation(); renderControls();
}

function renderNotice(): void {
  const node = document.querySelector('#notice'); if (!node) return;
  const actions = pending().filter((action) => action.hostId === state.hostId && action.sessionId === state.sessionId);
  node.innerHTML = `${state.error ? `<div class="notice error"><span>${escape(state.error)}</span><button data-action="dismiss" aria-label="关闭错误">×</button></div>` : ''}${state.notice ? `<div class="notice info">${escape(state.notice)}</div>` : ''}${actions.length ? `<div class="notice warning"><span>${actions.length} 个操作等待确认${actions.some((action) => action.status === 'unknown') ? '；存在结果不确定的操作，请检查历史，系统不会自动重发。' : ''}</span><button data-action="pending" ${!state.connected ? 'disabled' : ''}>检查状态</button></div>` : ''}`;
}

function renderConversation(): void {
  const node = document.querySelector('#conversation'); if (!node) return;
  const stick = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
  const view = current();
  if (!view) {
    node.innerHTML = `<div class="welcome"><div class="welcome-mark">π</div><p class="eyebrow">YOUR PC, FROM ANYWHERE</p><h1>想法在手边。<br>工作在继续。</h1><p>连接自己的电脑，把任务交给 Pi。<br>离开屏幕，也不必停下进度。</p><ol class="setup-steps"><li><b>01</b><span>使用 Passkey 登录</span><em>${state.authenticated ? '已登录' : '待登录'}</em></li><li><b>02</b><span>解锁手机 SSH 密钥</span><em>${privateKey ? '已解锁' : '独立保护'}</em></li><li><b>03</b><span>验证主机，选择会话</span><em>${state.connected ? '已连接' : '安全连接'}</em></li></ol>${!state.authenticated ? '<button class="button primary" data-action="login">使用 Passkey 登录 →</button>' : '<button class="button primary" data-action="connect">连接我的 PC →</button>'}</div>`;
    return;
  }
  const session = state.sessions.find((item) => item.id === state.sessionId);
  const messages = view.messages.map((message) => messageMarkup(message)).join('');
  const tools = Object.values(view.tools).map((tool) => `<details class="tool"><summary><span>${tool.done ? tool.error ? '!' : '✓' : '◌'}</span>${escape(tool.name)}<small>${tool.done ? tool.error ? '失败' : '完成' : '执行中'}</small></summary><pre>${escape(tool.text)}</pre></details>`).join('');
  node.innerHTML = `<div class="conversation-title"><div><p class="eyebrow">${escape(state.projects.find((project) => project.id === state.projectId)?.name ?? 'PROJECT')}</p><h1>${escape(session?.name ?? 'Pi 会话')}</h1></div><span class="state-pill ${view.running ? 'running' : ''}">${escape(view.status)}</span></div>${session?.lastError ? `<div class="notice error">${escape(session.lastError)}</div>` : ''}${messages || '<div class="empty-conversation"><span>✳</span><h2>准备好开始了</h2><p>描述任务，Pi 会在此项目中继续工作。</p></div>'}${view.streaming ? messageMarkup(view.streaming, true) : ''}${tools ? `<div class="tools">${tools}</div>` : ''}`;
  if (stick) node.scrollTop = node.scrollHeight;
}

function messageMarkup(message: any, streaming = false): string {
  const role = message.role ?? 'system';
  const text = messageText(message);
  if (!text) return '';
  return `<article class="message ${role === 'user' ? 'user' : 'assistant'}"><div class="message-label"><span>${escape(role === 'user' ? '你' : role === 'assistant' ? 'π Pi' : role === 'toolResult' ? `工具 · ${message.toolName ?? ''}` : role)}</span>${streaming ? '<small>生成中 <span class="pulse">●</span></small>' : ''}</div><div class="message-body">${escape(text)}</div>${message.errorMessage ? `<p class="error-text">${escape(message.errorMessage)}</p>` : ''}</article>`;
}

function renderControls(): void {
  const node = document.querySelector('#control-bar'); if (!node) return;
  const own = ownsControl();
  node.innerHTML = `<div class="control-bar"><button class="text-button model-button" data-action="models" ${!state.connected || !state.sessionId ? 'disabled' : ''}>${escape(state.model || '选择模型')} ▾</button><span class="top-spacer"></span>${state.sessionId ? `<span class="control-label">${own ? '你正在控制' : '只读查看'}</span><button class="text-button" data-action="control" ${!state.connected || state.busy ? 'disabled' : ''}>${own ? '释放控制' : '取得控制'}</button><button class="stop-button" data-action="stop" ${!own || !current()?.running || state.busy ? 'disabled' : ''}>■ 停止</button>` : ''}</div>`;
  const send = document.querySelector<HTMLButtonElement>('#send-button');
  if (send) send.disabled = state.busy || !state.connected || !own;
  for (const placement of ['above', 'below']) {
    const widgets = document.querySelector(`#widgets-${placement}`);
    if (widgets) widgets.innerHTML = [...state.widgets.values()].filter((widget) => widget.placement === `${placement}Editor`).map((widget) => `<pre>${escape(widget.text)}</pre>`).join('') + (placement === 'above' ? [...state.statuses.values()].map((text) => `<p>${escape(text)}</p>`).join('') : '');
  }
}

function modal(title: string, content: string): HTMLDialogElement {
  const previous = document.querySelector<HTMLDialogElement>('#modal')!;
  if (previous.open) previous.close();
  // Native close events are queued. A fresh node prevents an earlier dialog's
  // close event from firing a newly installed dialog's cancellation listener.
  const dialog = document.createElement('dialog'); dialog.id = 'modal'; previous.replaceWith(dialog);
  dialog.innerHTML = `<div class="dialog-heading"><h2>${escape(title)}</h2><button class="icon-button" data-close aria-label="关闭弹窗">×</button></div>${content}<p class="dialog-error" role="alert"></p>`;
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
  dialog.showModal(); return dialog;
}

function dialogTask(dialog: HTMLDialogElement, work: () => Promise<void>): void {
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach((button) => button.disabled = true);
  void work().catch((error) => { const errorNode = dialog.querySelector('.dialog-error'); if (errorNode) errorNode.textContent = error.message; }).finally(() => buttons.forEach((button) => button.disabled = false));
}

function showAccount(): void {
  if (state.authenticated) {
    const dialog = modal('已登录', `<p>${escape(state.account)}</p><p class="muted">网站登录与 SSH 私钥解锁分别进行。</p><button class="button" id="logout">退出登录并锁定密钥</button>`);
    dialog.querySelector('#logout')!.addEventListener('click', () => dialogTask(dialog, async () => { await api('/auth/logout', {}); privateKey = null; disconnect(); await refreshAccount(); }));
  } else {
    const dialog = modal('登录 Pi Remote', '<p class="muted">使用已登记的 Passkey，或凭管理员发放的一次性邀请登记新设备。</p><button class="button primary" id="passkey-login">使用 Passkey 登录</button><details class="register"><summary>首次使用 · 登记 Passkey</summary><form id="register-form"><label>名称<input name="name" required autocomplete="name" /></label><label>邀请令牌<input name="token" required type="password" autocomplete="off" /></label><button class="button" type="submit">登记并登录</button></form></details>');
    dialog.querySelector('#passkey-login')!.addEventListener('click', () => dialogTask(dialog, async () => { await login(); }));
    dialog.querySelector('#register-form')!.addEventListener('submit', (event) => { event.preventDefault(); const data = new FormData(event.target as HTMLFormElement); dialogTask(dialog, () => login(true, String(data.get('token')), String(data.get('name')))); });
  }
}

function showVault(): void {
  if (privateKey) { privateKey = null; disconnect(); state.notice = 'SSH 私钥已锁定。已断开手机连接，PC 后台任务继续。'; render(); return; }
  const dialog = modal(state.hasKey ? '解锁此设备的 SSH 密钥' : '保存手机 SSH 私钥', `<p class="muted">私钥使用独立口令在本地加密保存。解锁后仅供当前页面使用，不上传到 VPS。请使用已在 PC 授权的专用 SSH 密钥。</p><form id="vault-form">${state.hasKey ? '' : '<label>SSH 私钥<textarea name="key" rows="5" required autocomplete="off" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>'}<label>本地解锁口令<input name="passphrase" type="password" minlength="12" required autocomplete="${state.hasKey ? 'current-password' : 'new-password'}" /></label><button class="button primary" type="submit">${state.hasKey ? '解锁' : '加密保存并解锁'}</button></form>${state.hasKey ? '<button class="text-button danger" id="delete-key">删除本地加密密钥</button>' : ''}`);
  dialog.querySelector('#vault-form')!.addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.target as HTMLFormElement; const data = new FormData(form);
    dialogTask(dialog, async () => {
      const passphrase = String(data.get('passphrase'));
      if (state.hasKey) { const encrypted = await loadEncryptedKey(); if (!encrypted) throw new Error('本地密钥不存在，请重新导入。'); privateKey = await decryptPrivateKey(encrypted, passphrase); }
      else { const key = String(data.get('key')); const encrypted = await encryptPrivateKey(key, passphrase); await saveEncryptedKey(encrypted); privateKey = key.trim(); state.hasKey = true; }
      form.reset(); dialog.close(); state.notice = '密钥已解锁。现在可连接已登记指纹的 PC。'; render();
    });
  });
  dialog.querySelector('#delete-key')?.addEventListener('click', () => {
    const confirmation = modal('删除本地密钥', '<p>删除此浏览器中保存的加密密钥后，需要重新导入。PC 上的授权公钥不会被删除。</p><button class="button danger" id="confirm-delete">删除本地加密密钥</button>');
    confirmation.querySelector('#confirm-delete')!.addEventListener('click', () => dialogTask(confirmation, async () => { await deleteEncryptedKey(); state.hasKey = false; privateKey = null; confirmation.close(); render(); }));
  });
}

function showTrust(): void {
  if (!state.hostId) { setError('请先登录并选择主机。'); return; }
  const pins = read<Record<string, string>>('host-pins', {});
  const host = state.hosts.find((item) => item.id === state.hostId)!;
  const dialog = modal('登记可信主机指纹', `<p>主机：<strong>${escape(host.name)}</strong></p><p class="muted">请在 PC 本机或通过独立可信渠道核实 SSH 主机指纹。此页面不会接受网络返回的未知指纹。</p><pre class="command-sample">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256</pre><form id="trust-form"><label>已核实的 SHA256 指纹<input name="fingerprint" required value="${escape(pins[host.id] ?? '')}" placeholder="SHA256:…" autocomplete="off" spellcheck="false" /></label><label class="check-label"><input type="checkbox" required />我已通过 PC 本机或独立可信渠道核实该指纹</label><button class="button primary" type="submit">保存可信指纹</button></form>`);
  dialog.querySelector('#trust-form')!.addEventListener('submit', (event) => {
    event.preventDefault(); dialogTask(dialog, async () => {
      const fingerprint = normalizeFingerprint(String(new FormData(event.target as HTMLFormElement).get('fingerprint')));
      if (state.connected && pins[host.id] !== fingerprint) disconnect();
      pins[host.id] = fingerprint; save('host-pins', pins); dialog.close(); state.notice = '已保存经你核实的主机指纹。连接时会严格比对。'; render();
    });
  });
}

function showCommands(): void {
  const dialog = modal('命令', `<p class="muted">由当前 PC 的 Pi 配置提供，包含 skills、模板和扩展。</p><div class="choice-list">${state.commands.map((command, index) => `<button data-command="${index}"><strong>/${escape(command.name)}</strong><small>${escape(command.description ?? command.source ?? '')}</small></button>`).join('') || '<p>当前没有可用命令。</p>'}</div>`);
  dialog.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => button.addEventListener('click', () => {
    const editor = document.querySelector<HTMLTextAreaElement>('#composer')!; const name = state.commands[Number(button.dataset.command)].name;
    editor.value = `${name.startsWith('/') ? name : `/${name}`} ${editor.value}`; persistDraft(); dialog.close(); editor.focus();
  }));
}

function showModels(): void {
  const dialog = modal('选择模型', `<div class="choice-list">${state.models.map((model, index) => `<button data-model="${index}" ${!ownsControl() ? 'disabled' : ''}><strong>${escape(model.name ?? model.id)}</strong><small>${escape(model.provider)} · ${escape(model.id)}</small></button>`).join('') || '<p>此 PC 没有返回可用模型。请检查 Pi 配置。</p>'}</div>`);
  dialog.querySelectorAll<HTMLButtonElement>('[data-model]').forEach((button) => button.addEventListener('click', () => dialogTask(dialog, async () => {
    const model = state.models[Number(button.dataset.model)]; const receipt = await sendRpc({type: 'set_model', provider: model.provider, modelId: model.id});
    if (receipt.status === 'completed') state.model = model.name ?? model.id;
    dialog.close(); renderControls(); renderNotice();
  })));
}

function showHistory(): void {
  const history = read<string[]>(`history:${state.hostId}`, []);
  const dialog = modal('输入历史', `<p class="muted">最近 50 条输入仅保存在此设备。</p><div class="choice-list">${history.map((text, index) => `<button data-history="${index}"><span>${escape(text.slice(0, 240))}</span></button>`).join('') || '<p>还没有输入历史。</p>'}</div>`);
  dialog.querySelectorAll<HTMLButtonElement>('[data-history]').forEach((button) => button.addEventListener('click', () => { const editor = document.querySelector<HTMLTextAreaElement>('#composer')!; editor.value = history[Number(button.dataset.history)]!; persistDraft(); dialog.close(); editor.focus(); }));
}

function handleUi(event: any): void {
  switch (event.method) {
    case 'notify': state.notice = event.message; break;
    case 'setStatus': if (event.statusText) state.statuses.set(event.statusKey, event.statusText); else state.statuses.delete(event.statusKey); break;
    case 'setWidget': if (event.widgetLines) state.widgets.set(event.widgetKey, {text: event.widgetLines.join('\n'), placement: event.widgetPlacement ?? 'aboveEditor'}); else state.widgets.delete(event.widgetKey); break;
    case 'setTitle': document.title = event.title || 'Pi Remote'; break;
    case 'set_editor_text': if (ownsControl()) { const editor = document.querySelector<HTMLTextAreaElement>('#composer'); if (editor) { editor.value = event.text; persistDraft(); } } break;
    case 'select': case 'confirm': case 'input': case 'editor':
      if (!state.ui.some((item) => item.id === event.id)) state.ui.push(event); showNextUi(); break;
  }
}

function showNextUi(): void {
  const active = document.querySelector<HTMLDialogElement>('#modal');
  if (!ownsControl() || active?.open || !state.ui.length) return;
  const event = state.ui[0];
  activeUiId = event.id;
  const content = event.method === 'select' ? `<div class="choice-list">${(event.options ?? []).map((option: string, index: number) => `<button type="button" data-option="${index}">${escape(option)}</button>`).join('')}</div>` : event.method === 'confirm' ? `<p>${escape(event.message)}</p><div class="button-row"><button type="button" class="button" id="ui-no">否</button><button class="button primary" type="submit">是</button></div>` : `<label>${escape(event.placeholder ?? '内容')}${event.method === 'editor' ? `<textarea name="value" rows="8">${escape(event.prefill ?? '')}</textarea>` : `<input name="value" placeholder="${escape(event.placeholder ?? '')}" />`}</label><button class="button primary" type="submit">提交</button>`;
  const dialog = modal(event.title ?? 'Pi 扩展', `<p class="eyebrow">PI EXTENSION</p><form id="ui-form">${content}</form>`);
  let answered = false;
  const respond = (fields: any) => dialogTask(dialog, async () => {
    await sendRpc({type: 'extension_ui_response', id: event.id, ...fields}); answered = true;
    state.ui = state.ui.filter((item) => item.id !== event.id);
    // The manager can resolve this dialog before its action receipt arrives and
    // already present the next one. Never close that next dialog with this result.
    if (activeUiId === event.id) { activeUiId = null; if (dialog.open) dialog.close(); }
    showNextUi();
  });
  dialog.querySelector('#ui-form')!.addEventListener('submit', (submit) => { submit.preventDefault(); respond(event.method === 'confirm' ? {confirmed: true} : {value: String(new FormData(submit.target as HTMLFormElement).get('value'))}); });
  dialog.querySelector('#ui-no')?.addEventListener('click', () => respond({confirmed: false}));
  dialog.querySelectorAll<HTMLButtonElement>('[data-option]').forEach((button) => button.addEventListener('click', () => respond({value: event.options[Number(button.dataset.option)]})));
  dialog.addEventListener('close', () => {
    if (!answered && activeUiId === event.id && ownsControl() && state.ui.some((item) => item.id === event.id)) {
      state.ui = state.ui.filter((item) => item.id !== event.id); activeUiId = null;
      void sendRpc({type: 'extension_ui_response', id: event.id, cancelled: true}).catch(setError).finally(showNextUi);
    }
  }, {once: true});
}

app.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>('button'); if (!target) return;
  if (target.dataset.session) { void busy(() => selectSession(target.dataset.session!)); return; }
  const action = target.dataset.action;
  switch (action) {
    case 'sidebar': state.sidebar = !state.sidebar; render(); break;
    case 'login': case 'account': showAccount(); break;
    case 'vault': showVault(); break;
    case 'trust': showTrust(); break;
    case 'connect': if (state.connected) disconnect(); else void busy(connect); break;
    case 'dismiss': state.error = ''; renderNotice(); break;
    case 'commands': showCommands(); break;
    case 'models': showModels(); break;
    case 'history': showHistory(); break;
    case 'pending': void busy(reconcileActions); break;
    case 'create': {
      const dialog = modal('创建会话', '<form id="new-session"><label>会话名称<input name="name" required maxlength="120" placeholder="例如：完善登录流程" /></label><button class="button primary" type="submit">创建会话</button></form>');
      dialog.querySelector('#new-session')!.addEventListener('submit', (submit) => { submit.preventDefault(); dialogTask(dialog, async () => { const {session} = await protocol!.request('create_session', {projectId: state.projectId, name: String(new FormData(submit.target as HTMLFormElement).get('name'))}); state.sessions.push(session); dialog.close(); await selectSession(session.id); }); }); break;
    }
    case 'control': void busy(async () => { const type = ownsControl() ? 'release_control' : 'acquire_control'; const result = await protocol!.request(type, {sessionId: state.sessionId}); state.controls.set(state.sessionId, type === 'release_control' ? null : result.control ?? result); state.notice = ''; renderControls(); showNextUi(); }); break;
    case 'stop': void busy(async () => { await sendRpc({type: 'clear_queue'}); await sendRpc({type: 'abort'}); }); break;
  }
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === 'host-select') { persistDraft(); disconnect(); state.hostId = target.value; state.sessionId = ''; state.projects = []; state.sessions = []; state.projectId = ''; state.views.clear(); state.notice = ''; state.model = ''; state.commands = []; state.models = []; state.ui = []; state.statuses.clear(); state.widgets.clear(); save('selection', {hostId: state.hostId}); render(); }
  if (target.id === 'project-select') { state.projectId = target.value; render(); }
});
app.addEventListener('input', (event) => { if ((event.target as Element).id === 'composer') persistDraft(); });
app.addEventListener('submit', (event) => { if ((event.target as Element).id === 'prompt-form') { event.preventDefault(); void busy(submitPrompt); } });
app.addEventListener('keydown', (event) => {
  if ((event.target as Element).id !== 'composer') return;
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void busy(submitPrompt); }
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); const history = read<string[]>(`history:${state.hostId}`, []);
    historyPosition = Math.max(-1, Math.min(history.length - 1, historyPosition + (event.key === 'ArrowUp' ? 1 : -1)));
    (event.target as HTMLTextAreaElement).value = history[historyPosition] ?? ''; persistDraft();
  }
});
setInterval(() => {
  if (protocol && ownsControl() && state.sessionId) void protocol.request('heartbeat', {sessionId: state.sessionId}).then((result) => { state.controls.set(state.sessionId, result.control ?? result); renderControls(); }).catch((error) => { state.controls.set(state.sessionId, null); setError(error); renderControls(); });
}, 10_000);
window.addEventListener('online', () => { if (!state.connected) scheduleReconnect(); });
document.addEventListener('visibilitychange', () => { persistDraft(); if (document.visibilityState === 'visible' && !state.connected) scheduleReconnect(); });
window.addEventListener('pagehide', () => { persistDraft(); privateKey = null; disconnect(); });

render();
void Promise.all([refreshAccount(), loadEncryptedKey().then((key) => { state.hasKey = !!key; })]).catch(setError);
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js').catch((error) => { console.warn('PWA service worker registration failed', error); });
