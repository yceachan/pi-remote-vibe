// Real built PWA + Passkey verification + WSS relay + Go/WASM SSH + OpenSSH
// forced stdio command + SessionManager. Only Pi and the authenticator are test
// fixtures. All network listeners use loopback and all credentials are ephemeral.
import assert from 'node:assert/strict';
import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, chmod, rm} from 'node:fs/promises';
import {createServer as createHttpsServer} from 'node:https';
import {request as httpRequest} from 'node:http';
import {connect as tcpConnect, createServer as createTcpServer} from 'node:net';
import type {Duplex} from 'node:stream';
import {userInfo} from 'node:os';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {SessionManager} from '../packages/pc/manager.ts';
import {createRelay} from '../packages/relay/server.ts';
import {hashToken} from '../packages/relay/auth.ts';
import type {RelayConfig} from '../packages/relay/config.ts';

const {chromium} = process.env.PLAYWRIGHT_MODULE
  ? await import(process.env.PLAYWRIGHT_MODULE)
  : createRequire(new URL('../packages/browser-ssh/package.json', import.meta.url))('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Keep the Unix socket pathname below the macOS sun_path limit.
const temporary = await mkdtemp('/tmp/prv-e2e-');
const socketPath = resolve(temporary, 'manager.sock');
const invite = randomBytes(32).toString('base64url');
const localPassphrase = 'only-for-this-browser-smoke-test';
const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;
let manager: SessionManager | undefined;
let relay: ReturnType<typeof createRelay> | undefined;
let proxy: ReturnType<typeof createHttpsServer> | undefined;
let sshd: ChildProcess | undefined;
let browser: any;
let sshLog = '';
const proxySockets = new Set<Duplex>();
const pageErrors: string[] = [];
let stage = 'setup';

try {
  await mkdir(resolve(temporary, 'project'));
  manager = new SessionManager({
    dataDir: resolve(temporary, 'pc-state'), socketPath,
    projects: [{id: 'project', name: 'E2E project', path: resolve(temporary, 'project')}],
    piCommand: process.execPath, piArgs: [resolve(root, 'tests/fixtures/mock-pi.mjs')],
    rpcTimeoutMs: 5_000,
  });
  await manager.start();
  for (const name of ['host', 'phone']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', resolve(temporary, name)]);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(temporary, 'tls.key'), '-out', resolve(temporary, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], {stdio: 'ignore'});
  const bridge = resolve(temporary, 'attach.sh');
  await writeFile(bridge, `#!/bin/sh\ncd ${quote(root)} || exit 1\nexec ${quote(process.execPath)} --import tsx ${quote(resolve(root, 'packages/pc/stdio.ts'))} ${quote(socketPath)}\n`);
  await chmod(bridge, 0o700);
  await writeFile(resolve(temporary, 'authorized_keys'), `restrict,command="${bridge}" ${await readFile(resolve(temporary, 'phone.pub'), 'utf8')}`);
  const portProbe = createTcpServer();
  await new Promise<void>((r) => portProbe.listen(0, '127.0.0.1', r));
  const sshPort = (portProbe.address() as {port: number}).port;
  await new Promise<void>((r) => portProbe.close(() => r()));
  await writeFile(resolve(temporary, 'sshd_config'), [
    `Port ${sshPort}`, 'ListenAddress 127.0.0.1',
    `HostKey ${resolve(temporary, 'host')}`, `AuthorizedKeysFile ${resolve(temporary, 'authorized_keys')}`,
    `PidFile ${resolve(temporary, 'sshd.pid')}`, 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'LogLevel VERBOSE',
  ].join('\n'));
  sshd = spawn(process.env.SSHD_BINARY ?? '/usr/sbin/sshd', ['-D', '-e', '-f', resolve(temporary, 'sshd_config')], {stdio: ['ignore', 'ignore', 'pipe']});
  sshd.stderr!.on('data', data => { sshLog += String(data); });
  sshd.on('error', error => { sshLog += error.message; });
  for (let i = 0; i < 100 && !sshLog.includes('Server listening'); i++) {
    if (sshd.exitCode !== null) throw new Error(`Test sshd failed: ${sshLog}`);
    await delay(50);
  }
  if (!sshLog.includes('Server listening')) throw new Error(`Test sshd did not start: ${sshLog}`);

  const config: RelayConfig = {
    origin: 'https://localhost', rpId: 'localhost', listenHost: '127.0.0.1', port: 0,
    dataDir: resolve(temporary, 'relay-state'), staticDir: resolve(root, 'packages/web/dist'),
    hosts: [{id: 'test-pc', name: 'E2E PC', sshUser: userInfo().username, port: sshPort}],
    users: [{id: 'e2e', name: 'E2E', hostIds: ['test-pc'], enrollmentTokenHash: hashToken(invite)}],
  };
  relay = createRelay(config);
  await new Promise<void>((r) => relay!.server.listen(0, '127.0.0.1', r));
  const relayPort = (relay.server.address() as {port: number}).port;
  // This local TLS proxy models the deployed Caddy boundary. The relay itself
  // remains the unchanged production HTTP/upgrade handler behind it.
  proxy = createHttpsServer({key: await readFile(resolve(temporary, 'tls.key')), cert: await readFile(resolve(temporary, 'tls.crt'))}, (req, res) => {
    const upstream = httpRequest({host: '127.0.0.1', port: relayPort, path: req.url, method: req.method, headers: req.headers}, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.on('connection', socket => { proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); });
  proxy.on('upgrade', (req, client, head) => {
    const upstream = tcpConnect({host: '127.0.0.1', port: relayPort}, () => {
      const headers = req.rawHeaders.reduce((all, value, index) => all + (index % 2 ? `${value}\r\n` : `${value}: `), '');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    proxySockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { proxySockets.delete(upstream); client.destroy(); });
  });
  await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', r));
  config.origin = `https://localhost:${(proxy.address() as {port: number}).port}`;

  browser = await chromium.launch({executablePath: process.env.CHROME_BINARY || undefined, headless: true, args: ['--ignore-certificate-errors']});
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error: Error) => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true}});
  stage = 'real Passkey registration';
  await page.goto(config.origin);
  await page.getByRole('button', {name: '账户与登录'}).click();
  await page.locator('details.register summary').click();
  await page.locator('input[name="name"]').fill('E2E');
  await page.locator('input[name="token"]').fill(invite);
  await page.getByRole('button', {name: '登记并登录'}).click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('#modal')?.open);
  assert.equal((await (await page.request.get(`${config.origin}/api/me`)).json()).authenticated, true);
  const cookie = (await context.cookies()).find((item: any) => item.name === 'prv_session');
  assert.equal(cookie?.secure, true); assert.equal(cookie?.httpOnly, true);

  stage = 'encrypted vault and trusted host registration';
  await page.getByRole('button', {name: '解锁密钥', exact: true}).click();
  await page.locator('textarea[name="key"]').fill(await readFile(resolve(temporary, 'phone'), 'utf8'));
  await page.locator('input[name="passphrase"]').fill(localPassphrase);
  await page.getByRole('button', {name: '加密保存并解锁', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('#modal')?.open);
  await page.getByRole('button', {name: '主机信任', exact: true}).click();
  const fingerprint = execFileSync('ssh-keygen', ['-lf', resolve(temporary, 'host.pub'), '-E', 'sha256'], {encoding: 'utf8'}).split(/\s+/)[1]!;
  await page.locator('input[name="fingerprint"]').fill(fingerprint);
  await page.locator('#trust-form input[type="checkbox"]').check();
  await page.getByRole('button', {name: '保存可信指纹', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('#modal')?.open);
  stage = 'WSS / SSH / forced stdio / PC hello';
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.getByText('SSH 已验证 · 端到端连接', {exact: true}).waitFor();
  assert.equal(await page.locator('#project-select').inputValue(), 'project');
  stage = 'create session and submit prompt';
  await page.getByRole('button', {name: '创建会话', exact: true}).click();
  await page.locator('#new-session input[name="name"]').fill('End to end session');
  await page.locator('#new-session button[type="submit"]').click();
  await page.getByText('你正在控制', {exact: true}).waitFor();
  await page.locator('#composer').fill('slow');
  await page.getByRole('button', {name: '发送任务', exact: true}).click();
  await page.locator('.message.user .message-body').getByText('slow', {exact: true}).waitFor();
  const selection = await page.evaluate(() => JSON.parse(localStorage.getItem('pi:selection')!));
  assert.ok(selection.sessionId);
  stage = 'disconnect while worker runs';
  await page.getByRole('button', {name: '断开连接', exact: true}).click();
  await page.getByText('已断开', {exact: true}).waitFor();
  const disconnectedIndex = JSON.parse(await readFile(resolve(temporary, 'pc-state/index.json'), 'utf8'));
  assert.equal(disconnectedIndex.sessions.find((item: any) => item.id === selection.sessionId).status, 'running', 'The test must disconnect before the fixture finishes');
  await delay(600);
  const index = JSON.parse(await readFile(resolve(temporary, 'pc-state/index.json'), 'utf8'));
  const stored = index.sessions.find((item: any) => item.id === selection.sessionId);
  assert.equal(stored.status, 'idle');
  const history = JSON.parse(await readFile(stored.sessionFile, 'utf8'));
  assert.equal(history.length, 2); assert.equal(history[1].content[0].text, 'done: slow');
  stage = 'reconnect and resume same session';
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.getByText('SSH 已验证 · 端到端连接', {exact: true}).waitFor();
  await page.locator('.message.assistant .message-body').getByText('done: slow', {exact: true}).waitFor();
  assert.equal(await page.locator('.message.user').count(), 1);
  assert.equal(await page.locator('.message.assistant').count(), 1);
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('pi:selection')!))).sessionId, selection.sessionId);

  stage = 'reload, unlock encrypted key, and full history synchronization';
  await page.reload();
  await page.getByRole('button', {name: '解锁密钥', exact: true}).click();
  assert.equal(await page.locator('textarea[name="key"]').count(), 0);
  await page.locator('input[name="passphrase"]').fill(localPassphrase);
  await page.getByRole('button', {name: '解锁', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('#modal')?.open);
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.locator('.message.assistant .message-body').getByText('done: slow', {exact: true}).waitFor();
  assert.equal(await page.locator('.message.user').count(), 1);
  assert.equal(await page.locator('.message.assistant').count(), 1);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({status: 'passed', browser: await browser.version(), chain: 'production PWA → real Passkey verifier → HTTPS/WSS → production relay → Go/WASM SSH → OpenSSH forced command → production stdio → SessionManager → mock Pi RPC worker', checks: ['Secure HttpOnly Passkey session cookie', 'local encrypted vault import and unlock', 'independent host pin registration', 'project discovery over SSH', 'session creation and control lease', 'prompt and streamed messages', 'worker completes with browser disconnected', 'same session and exactly one prompt after reconnect', 'reload and complete history synchronization'], limitations: ['mock Pi worker and virtual authenticator', 'local self-signed TLS test certificate', 'Android lock screen and real two-PC deployment still require device acceptance']}, null, 2));
} catch (error) {
  throw new Error(`E2E smoke failed at ${stage}: ${(error as Error).message}\n${sshLog}`, {cause: error});
} finally {
  await browser?.close();
  for (const socket of proxySockets) socket.destroy();
  if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
  await relay?.close();
  await manager?.stop();
  sshd?.kill();
  await rm(temporary, {recursive: true, force: true});
}
