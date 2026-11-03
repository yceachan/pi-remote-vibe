// Production web + real relay + real SimpleWebAuthn verification. Only the
// authenticator is virtual; credentials and relay state are isolated and removed.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRelay} from '../../relay/server.ts';
import {hashToken} from '../../relay/auth.ts';
import type {RelayConfig} from '../../relay/config.ts';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(resolve(tmpdir(), 'pi-remote-auth-smoke-'));
const invite = randomBytes(32).toString('base64url');
const config: RelayConfig = {
  origin: 'http://localhost', rpId: 'localhost', listenHost: '127.0.0.1', port: 0, dataDir: directory,
  staticDir: resolve(root, 'dist'),
  hosts: [{id: 'authorized', name: '授权主机', sshUser: 'test', port: 22222}, {id: 'forbidden', name: '未授权主机', sshUser: 'test', port: 22223}],
  users: [{id: 'virtual-user', name: '虚拟认证器测试', hostIds: ['authorized'], enrollmentTokenHash: hashToken(invite)}],
};
const relay = createRelay(config);
let browser: any;
try {
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  const address = relay.server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected listen address');
  config.origin = `http://localhost:${address.port}`;
  browser = await chromium.launch({executablePath: process.env.CHROME_BINARY || undefined, headless: true});
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true}});
  await page.goto(config.origin);
  await page.getByRole('button', {name: '账户与登录'}).click();
  await page.locator('details.register summary').click();
  await page.locator('input[name="name"]').fill('虚拟认证器测试');
  await page.locator('input[name="token"]').fill(invite);
  await page.getByRole('button', {name: '登记并登录'}).click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('#modal')?.open);
  const me = await page.request.get(`${config.origin}/api/me`);
  assert.deepEqual(await me.json(), {authenticated: true, user: {id: 'virtual-user', name: '虚拟认证器测试'}});
  const hosts = await page.request.get(`${config.origin}/api/hosts`);
  assert.deepEqual((await hosts.json()).hosts.map((host: any) => host.id), ['authorized']);
  const sessionCookie = (await context.cookies()).find((cookie: any) => cookie.name === 'prv_session');
  assert.equal(sessionCookie?.httpOnly, true);
  assert.equal(sessionCookie?.sameSite, 'Strict');
  assert.equal(await page.evaluate(() => document.cookie.includes('prv_session')), false);
  await page.getByRole('button', {name: '解锁密钥', exact: true}).waitFor();
  const reused = await page.request.post(`${config.origin}/api/auth/register/options`, {headers: {Origin: config.origin}, data: {token: invite}});
  assert.equal(reused.status(), 403);
  await page.getByRole('button', {name: '账户与登录'}).click();
  await page.getByRole('button', {name: '退出登录并锁定密钥'}).click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('#modal')?.open);
  assert.equal((await (await page.request.get(`${config.origin}/api/me`)).json()).authenticated, false);
  assert.equal((await page.request.get(`${config.origin}/api/hosts`)).status(), 401);
  await page.getByRole('button', {name: '账户与登录'}).click();
  await page.getByRole('button', {name: '使用 Passkey 登录', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>('#modal')?.open);
  assert.equal((await (await page.request.get(`${config.origin}/api/me`)).json()).authenticated, true);
  await page.getByRole('button', {name: '解锁密钥', exact: true}).waitFor();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.evaluate(async () => { await fetch('/api/me'); await fetch('/api/hosts'); });
  const cachedUrls: string[] = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    return urls;
  });
  assert.equal(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/')), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({status: 'passed', browser: await browser.version(), authentication: 'real production relay and SimpleWebAuthn; CDP virtual platform authenticator', checks: ['one-time invitation registration', 'real registration and assertion signature verification', 'HttpOnly SameSite=Strict cookie and script isolation', 'authorized host list only', 'reused invite rejected', 'logout invalidates session', 'discoverable Passkey login', 'website login does not unlock SSH private key', 'service worker does not cache authenticated APIs']}, null, 2));
} finally { await browser?.close(); await relay.close(); await rm(directory, {recursive: true, force: true}); }
