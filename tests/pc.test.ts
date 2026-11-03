import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager, type ManagerOptions } from '../packages/pc/manager.js';
import { JsonlDecoder } from '../packages/pc/jsonl.js';
import { PiWorker } from '../packages/pc/worker.js';
import type { AppResult, JsonRecord, SessionEvent } from '../packages/pc/protocol.js';

class Client {
  socket: Socket;
  events: SessionEvent[] = [];
  private next = 0;
  private pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void }>();
  constructor(path: string) {
    this.socket = connect(path);
    const decoder = new JsonlDecoder(value => {
      const record = value as AppResult | SessionEvent;
      if (record.type === 'event') { this.events.push(record); return; }
      const waiter = this.pending.get(record.id);
      if (!waiter) return;
      this.pending.delete(record.id);
      if (record.ok) waiter.resolve(record.data); else waiter.reject(new Error(record.error.code + ': ' + record.error.message));
    });
    this.socket.on('data', chunk => decoder.write(chunk));
  }
  async ready(clientId: string): Promise<this> { await once(this.socket, 'connect'); await this.request('hello', { clientId }); return this; }
  request(type: string, fields: Record<string, unknown> = {}): Promise<any> {
    const id = String(++this.next);
    return new Promise((resolvePromise, reject) => { this.pending.set(id, { resolve: resolvePromise, reject }); this.socket.write(JSON.stringify({ id, type, ...fields }) + '\n'); });
  }
  close(): void { this.socket.destroy(); }
}
async function fixture(overrides: Partial<ManagerOptions> = {}) {
  const directory = mkdtempSync('/tmp/pi-remote-test-');
  const project1 = join(directory, 'one'); const project2 = join(directory, 'two');
  mkdirSync(project1); mkdirSync(project2);
  const options: ManagerOptions = { dataDir: join(directory, 'state'), socketPath: join(directory, 'manager.sock'),
    projects: [{ id: 'one', name: 'One', path: project1 }, { id: 'two', name: 'Two', path: project2 }],
    piCommand: process.execPath, piArgs: [resolve('tests/fixtures/mock-pi.mjs')], rpcTimeoutMs: 1000, ...overrides };
  const manager = new SessionManager(options); await manager.start();
  const clients: Client[] = [];
  return { directory, options, manager, async client(id: string) { const client = await new Client(options.socketPath).ready(id); clients.push(client); return client; },
    async cleanup() { clients.forEach(client => client.close()); await manager.stop(); rmSync(directory, { recursive: true, force: true }); } };
}
async function eventually(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}
const create = async (client: Client, projectId = 'one') => (await client.request('create_session', { projectId })).session.id as string;

test('JSONL splits only LF and preserves fragmented UTF-8 and Unicode separators', () => {
  const values: unknown[] = [];
  const decoder = new JsonlDecoder(value => values.push(value));
  const input = Buffer.from('{"type":"test","text":"中文\u2028and\u2029more"}\r\n{"type":"next"}\n');
  for (const byte of input) decoder.write(Buffer.from([byte]));
  assert.deepEqual(values, [{ type: 'test', text: '中文\u2028and\u2029more' }, { type: 'next' }]);
  assert.throws(() => new JsonlDecoder(() => {}, 4).write('12345'), /limit/);
});

test('independent workers use project directories and finish after every client disconnects', async () => {
  const f = await fixture();
  try {
    const client = await f.client('phone');
    const first = await create(client, 'one'); const second = await create(client, 'two');
    const firstState = await client.request('rpc', { sessionId: first, rpc: { type: 'get_state' } });
    const secondState = await client.request('rpc', { sessionId: second, rpc: { type: 'get_state' } });
    assert.equal(firstState.response.data.cwd, realpathSync(join(f.directory, 'one')));
    assert.equal(secondState.response.data.cwd, realpathSync(join(f.directory, 'two')));
    for (const sessionId of [first, second]) {
      await client.request('acquire_control', { sessionId });
      const result = await client.request('rpc', { sessionId, clientActionId: sessionId, rpc: { type: 'prompt', message: 'slow' } });
      assert.equal(result.receipt.response.data.disposition, 'started');
    }
    client.close();
    await delay(550);
    const reconnected = await f.client('phone');
    for (const sessionId of [first, second]) {
      const sync = await reconnected.request('subscribe', { sessionId });
      assert.equal(sync.mode, 'snapshot'); assert.equal(sync.session.status, 'idle');
      assert.equal(sync.messages.length, 2); assert.equal(sync.messages[1].content[0].text, 'done: slow');
      const duplicate = await reconnected.request('rpc', { sessionId, clientActionId: sessionId, rpc: { type: 'prompt', message: 'slow' } });
      assert.equal(duplicate.receipt.status, 'completed');
      const messages = await reconnected.request('rpc', { sessionId, rpc: { type: 'get_messages' } });
      assert.equal(messages.response.data.messages.filter((message: any) => message.role === 'user').length, 1);
    }
  } finally { await f.cleanup(); }
});

test('dedupe is race-safe, conflicts fail, and only the control connection writes', async () => {
  const f = await fixture({ leaseMs: 150 });
  try {
    const owner = await f.client('owner'); const observer = await f.client('observer');
    const sessionId = await create(owner);
    await owner.request('acquire_control', { sessionId });
    await assert.rejects(observer.request('acquire_control', { sessionId }), /control_busy/);
    await assert.rejects(observer.request('rpc', { sessionId, clientActionId: 'denied', rpc: { type: 'prompt', message: 'wrong' } }), /not_controller/);
    const action = { sessionId, clientActionId: 'same-action', rpc: { type: 'prompt', message: 'slow' } };
    const results = await Promise.all([owner.request('rpc', action), owner.request('rpc', action)]);
    assert.ok(results.every(result => ['accepted', 'completed'].includes(result.receipt.status)));
    await assert.rejects(owner.request('rpc', { ...action, rpc: { type: 'prompt', message: 'changed' } }), /action_conflict/);
    const messages = await owner.request('rpc', { sessionId, rpc: { type: 'get_messages' } });
    assert.equal(messages.response.data.messages.length, 1);
    await delay(200);
    const claimed = await observer.request('acquire_control', { sessionId });
    assert.equal(claimed.control.clientId, 'observer');
    assert.equal((await owner.request('action_status', { sessionId, clientActionId: 'missing' })).receipt, null);
  } finally { await f.cleanup(); }
});

test('stream replay, cache gaps, and in-progress snapshots preserve consistent cursors', async () => {
  const f = await fixture({ eventLimit: 12 });
  try {
    const client = await f.client('phone'); const sessionId = await create(client);
    await client.request('subscribe', { sessionId });
    await client.request('acquire_control', { sessionId });
    await client.request('rpc', { sessionId, clientActionId: 'stream', rpc: { type: 'prompt', message: 'slow' } });
    const running = await client.request('subscribe', { sessionId });
    assert.equal(running.partialMessage.content[0].text, 'working…');
    assert.equal(running.messages.length, 1);
    const cursor = running.cursor;
    await eventually(() => client.events.some(event => event.event.type === 'agent_settled'), 'completion event');
    const replay = await client.request('subscribe', { sessionId, afterSeq: cursor });
    assert.equal(replay.mode, 'replay');
    assert.ok(replay.events.some((event: SessionEvent) => event.event.type === 'agent_settled'));
    assert.ok(replay.events.every((event: SessionEvent) => event.seq > cursor));
    for (let i = 0; i < 15; i++) await client.request('acquire_control', { sessionId });
    const gap = await client.request('subscribe', { sessionId, afterSeq: 0 });
    assert.equal(gap.mode, 'snapshot'); assert.equal(gap.messages.length, 2);
  } finally { await f.cleanup(); }
});

test('extension dialogs survive controller disconnect and responses require the lease', async () => {
  const f = await fixture();
  try {
    const owner = await f.client('phone'); const sessionId = await create(owner);
    await owner.request('subscribe', { sessionId }); await owner.request('acquire_control', { sessionId });
    await owner.request('rpc', { sessionId, clientActionId: 'dialog', rpc: { type: 'prompt', message: 'dialog' } });
    owner.close(); await delay(20);
    const next = await f.client('phone');
    const snapshot = await next.request('subscribe', { sessionId });
    assert.equal(snapshot.pendingUi[0].id, 'dialog-1');
    assert.deepEqual(snapshot.uiState.map((record: JsonRecord) => record.method), ['setStatus', 'setWidget', 'setTitle']);
    await next.request('acquire_control', { sessionId });
    const answered = await next.request('rpc', { sessionId, clientActionId: 'answer', rpc: { type: 'extension_ui_response', id: 'dialog-1', confirmed: true } });
    assert.equal(answered.receipt.status, 'completed');
    const sync = await next.request('subscribe', { sessionId }); assert.deepEqual(sync.pendingUi, []);
    await assert.rejects(next.request('rpc', { sessionId, clientActionId: 'again', rpc: { type: 'extension_ui_response', id: 'dialog-1', confirmed: false } }), /ui_expired/);
  } finally { await f.cleanup(); }
});

test('action ids are opaque even when they match JavaScript prototype properties', async () => {
  const f = await fixture();
  try {
    const client = await f.client('phone'); const sessionId = await create(client);
    await client.request('acquire_control', { sessionId });
    for (const clientActionId of ['__proto__', 'constructor', 'toString']) {
      assert.equal((await client.request('action_status', { sessionId, clientActionId })).receipt, null);
      const result = await client.request('rpc', { sessionId, clientActionId, rpc: { type: 'set_session_name', name: clientActionId } });
      assert.equal(result.receipt.status, 'completed');
      assert.equal((await client.request('action_status', { sessionId, clientActionId })).receipt.clientActionId, clientActionId);
    }
  } finally { await f.cleanup(); }
});

test('a second manager cannot unlink a live socket, even with a different state directory', async () => {
  const f = await fixture();
  try {
    const other = new SessionManager({ ...f.options, dataDir: join(f.directory, 'other-state') });
    await assert.rejects(other.start(), /already listening/);
    const client = await f.client('phone');
    assert.equal((await client.request('list_projects')).projects.length, 2);
  } finally { await f.cleanup(); }
});

test('manager restart reloads history, marks interrupted work, and never repeats accepted actions', async () => {
  const f = await fixture();
  let restarted: SessionManager | undefined;
  try {
    const client = await f.client('phone'); const sessionId = await create(client);
    await client.request('acquire_control', { sessionId });
    await client.request('rpc', { sessionId, clientActionId: 'restart', rpc: { type: 'prompt', message: 'slow' } });
    await f.manager.stop();
    restarted = new SessionManager(f.options); await restarted.start();
    const next = await f.client('phone');
    const sync = await next.request('subscribe', { sessionId, afterSeq: 1 });
    assert.equal(sync.mode, 'snapshot'); assert.equal(sync.session.status, 'interrupted'); assert.equal(sync.messages.length, 1);
    const receipt = await next.request('action_status', { sessionId, clientActionId: 'restart' });
    assert.equal(receipt.receipt.status, 'completed');
    await next.request('rpc', { sessionId, clientActionId: 'restart', rpc: { type: 'prompt', message: 'slow' } });
    const messages = await next.request('rpc', { sessionId, rpc: { type: 'get_messages' } });
    assert.equal(messages.response.data.messages.length, 1);
  } finally { await restarted?.stop(); await f.cleanup(); }
});

test('worker crash records an uncertain outcome and can load the session again', async () => {
  const f = await fixture();
  try {
    const client = await f.client('phone'); const sessionId = await create(client);
    await client.request('acquire_control', { sessionId });
    const result = await client.request('rpc', { sessionId, clientActionId: 'crash', rpc: { type: 'prompt', message: 'crash' } });
    assert.equal(result.receipt.status, 'unknown');
    const recovered = await client.request('subscribe', { sessionId });
    assert.equal(recovered.session.status, 'interrupted');
    const repeated = await client.request('rpc', { sessionId, clientActionId: 'crash', rpc: { type: 'prompt', message: 'crash' } });
    assert.equal(repeated.receipt.status, 'unknown');
  } finally { await f.cleanup(); }
});

test('protocol failure reports a replaceable worker only after the child exits', async () => {
  const directory = mkdtempSync('/tmp/pi-worker-test-');
  let exitObserved = false;
  let processHadExited = false;
  const worker = new PiWorker({ command: process.execPath, args: [resolve('tests/fixtures/mock-pi.mjs'), '--session-dir', directory], cwd: directory,
    onRecord: () => {}, onExit: () => { exitObserved = true; processHadExited = worker.child.exitCode !== null || worker.child.signalCode !== null; } });
  try {
    await assert.rejects(worker.request({ type: 'bad_output' }), /JSON/);
    await eventually(() => exitObserved, 'child exit');
    assert.equal(processHadExited, true);
  } finally { await worker.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker startup errors reject pending commands and shutdown does not hang', async () => {
  let exitObserved = false;
  const worker = new PiWorker({ command: '/nonexistent/pi-remote-fixture', cwd: process.cwd(), onRecord: () => {}, onExit: () => { exitObserved = true; } });
  await assert.rejects(worker.request({ type: 'get_state' }), /ENOENT/);
  await worker.stop();
  assert.equal(exitObserved, true);
});
