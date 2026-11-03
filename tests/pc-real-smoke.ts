/** Opt-in, model-free smoke: node --import tsx tests/pc-real-smoke.ts /path/to/pi/dist/bundle/cli.js */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager, type ManagerOptions } from '../packages/pc/manager.js';
import { JsonlDecoder } from '../packages/pc/jsonl.js';
import type { AppResult } from '../packages/pc/protocol.js';

const entry = process.argv[2];
if (!entry) throw new Error('Pass the absolute path to the installed Pi CLI JavaScript entry');
const piEntry = resolve(entry);
const version = execFileSync(process.execPath, [piEntry, '--version'], { encoding: 'utf8' }).trim();
const help = execFileSync(process.execPath, [piEntry, '--help'], { encoding: 'utf8' });
for (const flag of ['--mode', '--session', '--session-dir', '--name']) assert.ok(help.includes(flag), `Installed Pi lacks ${flag}`);
const root = mkdtempSync('/tmp/pi-real-smoke-');
mkdirSync(join(root, 'project'));
const options: ManagerOptions = {
  dataDir: join(root, 'state'), socketPath: join(root, 'manager.sock'),
  projects: [{ id: 'smoke', name: 'Smoke', path: join(root, 'project') }],
  piCommand: process.execPath,
  piArgs: [piEntry, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve'],
  env: { PI_CODING_AGENT_DIR: join(root, 'pi-config'), PI_OFFLINE: '1' },
};
async function client() {
  const socket = connect(options.socketPath);
  const pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void }>();
  let next = 0;
  const decoder = new JsonlDecoder(value => {
    const result = value as AppResult;
    if (result.type !== 'result') return;
    const waiter = pending.get(result.id);
    if (!waiter) return;
    pending.delete(result.id);
    if (result.ok) waiter.resolve(result.data); else waiter.reject(new Error(result.error.message));
  });
  socket.on('data', chunk => decoder.write(chunk));
  await once(socket, 'connect');
  const request = (type: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolvePromise, reject) => {
    const id = String(++next); pending.set(id, { resolve: resolvePromise, reject }); socket.write(JSON.stringify({ id, type, ...fields }) + '\n');
  });
  await request('hello', { clientId: 'real-smoke' });
  return { socket, request };
}
let manager = new SessionManager(options);
try {
  await manager.start();
  const first = await client();
  const { session } = await first.request('create_session', { projectId: 'smoke', name: 'real-smoke' });
  await first.request('acquire_control', { sessionId: session.id });
  const state = await first.request('rpc', { sessionId: session.id, rpc: { type: 'get_state' } });
  assert.equal(state.response.success, true); assert.ok(state.response.data.sessionFile);
  const messages = await first.request('rpc', { sessionId: session.id, rpc: { type: 'get_messages' } });
  assert.deepEqual(messages.response.data.messages, []);
  const commands = await first.request('rpc', { sessionId: session.id, rpc: { type: 'get_commands' } });
  assert.ok(Array.isArray(commands.response.data.commands));
  const named = await first.request('rpc', { sessionId: session.id, clientActionId: 'rename', rpc: { type: 'set_session_name', name: 'persisted-smoke' } });
  assert.equal(named.receipt.response.success, true);
  first.socket.destroy(); await manager.stop();
  // Pi intentionally does not flush empty sessions. Seed one message with its
  // own SDK while the worker is stopped, so reload tests actual saved history
  // without sending a prompt or making any provider call.
  const { SessionManager: PiSessionManager } = await import(pathToFileURL(join(dirname(dirname(piEntry)), 'index.js')).href);
  const saved = PiSessionManager.open(state.response.data.sessionFile, undefined, join(root, 'project'));
  saved.appendMessage({ role: 'user', content: 'Saved fixture history; no model invoked.', timestamp: Date.now() });
  saved.appendSessionInfo('persisted-smoke');
  manager = new SessionManager(options); await manager.start();
  const second = await client();
  const restored = await second.request('subscribe', { sessionId: session.id });
  assert.equal(restored.state.sessionFile, state.response.data.sessionFile);
  assert.equal(restored.state.sessionName, 'persisted-smoke');
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0].content, 'Saved fixture history; no model invoked.');
  assert.equal((await second.request('action_status', { sessionId: session.id, clientActionId: 'rename' })).receipt.status, 'completed');
  second.socket.destroy();
  process.stdout.write(JSON.stringify({ package: '@earendil-works/pi-coding-agent', version, passed: ['installed help flags', 'real RPC startup', 'get_state', 'get_messages', 'get_commands', 'set_session_name', 'manager and worker restart', 'session-file reload', 'persisted action receipt'], modelCalls: 0 }) + '\n');
} finally { await manager.stop(); rmSync(root, { recursive: true, force: true }); }
