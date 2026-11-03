// Local integration test: real Chromium, WSS, and an isolated OpenSSH sshd.
// SSH keys and TLS certificate are generated solely for this run and removed.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import ts from 'typescript';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '../../web/public/ssh');
const temporary = await mkdtemp(resolve(tmpdir(), 'pi-remote-ssh-'));
let sshd, browser, relay, wss;
const sockets = new Set();
let sshLog = '';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (const key of ['host', 'client', 'wrong']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', resolve(temporary, key)]);
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(temporary, 'tls.key'), '-out', resolve(temporary, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  const probe = createTcpServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const sshPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const config = [
    `Port ${sshPort}`, 'ListenAddress 127.0.0.1',
    `HostKey ${resolve(temporary, 'host')}`,
    `AuthorizedKeysFile ${resolve(temporary, 'client.pub')}`,
    `PidFile ${resolve(temporary, 'sshd.pid')}`,
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', 'LogLevel VERBOSE',
  ].join('\n');
  await writeFile(resolve(temporary, 'sshd_config'), config);
  sshd = spawn(process.env.SSHD_BINARY ?? '/usr/sbin/sshd', ['-D', '-e', '-f', resolve(temporary, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  sshd.stderr.on('data', (data) => { sshLog += data; });
  sshd.on('error', (error) => { sshLog += error.message; });
  for (let i = 0; i < 100 && !sshLog.includes('Server listening'); i++) {
    if (sshd.exitCode !== null) throw new Error(`Test sshd failed: ${sshLog}`);
    await pause(50);
  }
  if (!sshLog.includes('Server listening')) throw new Error(`Test sshd did not start: ${sshLog}`);

  const source = await readFile(resolve(here, '../src/index.ts'), 'utf8');
  const clientJs = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  relay = createServer({ key: await readFile(resolve(temporary, 'tls.key')), cert: await readFile(resolve(temporary, 'tls.crt')) }, async (request, response) => {
    try {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>SSH validation</title>'); }
      else if (request.url === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(clientJs); }
      else if (request.url === '/ssh/wasm_exec.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(resolve(assets, 'wasm_exec.js'))); }
      else if (request.url === '/ssh/ssh.wasm') { response.setHeader('Content-Type', 'application/wasm'); response.end(await readFile(resolve(assets, 'ssh.wasm'))); }
      else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end('Build WASM assets before running the test'); }
  });
  wss = new WebSocketServer({ server: relay, maxPayload: 8 << 20 });
  wss.on('connection', (ws, request) => {
    // A connected relay that never sends the SSH server identification lets
    // the test cancel a real pending handshake rather than an unopened call.
    if (request.url === '/stall') return;
    const tcp = connect({ host: '127.0.0.1', port: sshPort });
    sockets.add(tcp);
    tcp.on('data', (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    tcp.on('error', () => ws.close());
    tcp.on('close', () => { sockets.delete(tcp); ws.close(); });
    ws.on('message', (data, binary) => { if (binary) tcp.write(data); else ws.close(1003); });
    ws.on('close', () => tcp.destroy());
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const port = relay.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY || undefined, headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  page.setDefaultTimeout(30_000);
  await page.goto(`https://127.0.0.1:${port}`);
  const fingerprint = execFileSync('ssh-keygen', ['-lf', resolve(temporary, 'host.pub'), '-E', 'sha256'], { encoding: 'utf8' }).split(/\s+/)[1];
  const result = await Promise.race([page.evaluate(async (fixture) => {
    const { connectSsh } = await import('/client.js');
    const options = {
      url: `wss://${location.host}/ssh`, username: fixture.username,
      privateKey: fixture.privateKey, expectedFingerprint: fixture.fingerprint,
      command: 'test ! -t 0 && exec /bin/cat',
    };
    async function rejected(overrides) {
      try { const c = await connectSsh({ ...options, ...overrides }); c.close(); return ''; }
      catch (error) { return String(error); }
    }
    const mismatch = await rejected({ expectedFingerprint: `SHA256:${'A'.repeat(43)}` });
    const wrongKey = await rejected({ privateKey: fixture.wrongKey });
    const missingPin = await rejected({ expectedFingerprint: '' });
    const rounds = [];
    for (let round = 0; round < 2; round++) {
      const conn = await connectSsh(options);
      const writer = conn.writable.getWriter();
      const reader = conn.readable.getReader();
      const input = Uint8Array.from({ length: 262_144 }, (_, i) => i % 256);
      const output = [];
      const reading = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          output.push(...value);
        }
      })();
      await writer.write(input);
      await writer.close();
      await reading;
      conn.close();
      rounds.push(output.length === input.length && output.every((v, i) => v === input[i]));
    }
    const controller = new AbortController();
    const started = performance.now();
    const canceled = connectSsh({ ...options, url: `wss://${location.host}/stall`, signal: controller.signal }).then((c) => { c.close(); return false; }, () => true);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const handshakeCanceled = await canceled;
    return { mismatch, wrongKey, missingPin, rounds, canceled: handshakeCanceled && performance.now() - started < 2_000 };
  }, { username: userInfo().username, privateKey: await readFile(resolve(temporary, 'client'), 'utf8'), wrongKey: await readFile(resolve(temporary, 'wrong'), 'utf8'), fingerprint }),
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Browser SSH smoke test timed out')), 60_000); timer.unref(); })]);
  assert.match(result.mismatch, /host key mismatch/);
  assert.match(result.wrongKey, /unable to authenticate/);
  assert.match(result.missingPin, /fingerprint is required/);
  assert.deepEqual(result.rounds, [true, true]);
  assert.equal(result.canceled, true);
  const sshVersion = spawnSync(process.env.SSHD_BINARY ?? '/usr/sbin/sshd', ['-V'], { encoding: 'utf8' });
  console.log(JSON.stringify({ status: 'passed', browser: await browser.version(), sshd: `${sshVersion.stdout}${sshVersion.stderr}`.trim(), checks: ['WSS relay', 'strict host pin rejection', 'private key authentication and rejection', 'non-PTY exec', '262144 binary bytes each direction', 'disconnect and reconnect', 'AbortSignal during stalled SSH handshake'] }, null, 2));
} finally {
  await browser?.close();
  for (const ws of wss?.clients ?? []) ws.terminate();
  for (const socket of sockets) socket.destroy();
  wss?.close();
  relay?.close();
  sshd?.kill();
  await rm(temporary, { recursive: true, force: true });
}
