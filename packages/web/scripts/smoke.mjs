// Real browser UI regression with explicitly mocked authentication + SSH transport.
// This does not claim Android, WebAuthn authenticator, or SSH integration coverage.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  configFile: false,
  resolve: {alias: {'@pi-remote/browser-ssh': resolve(root, 'test/ssh-fixture.js')}},
  server: {host: '127.0.0.1', port: 0},
  plugins: [{name: 'ui-smoke-api', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith('/api/')) return next();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url === '/api/me' ? {authenticated: true, user: {id: 'fixture', name: '测试账户'}} : request.url === '/api/hosts' ? {hosts: [{id: 'host1', name: '测试主机一', sshUser: 'fixture'}, {id: 'host2', name: '测试主机二', sshUser: 'fixture'}]} : {}));
    });
  }}],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({executablePath: process.env.CHROME_BINARY || undefined, headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const address = server.httpServer.address();
  const url = `http://localhost:${address.port}`;
  await page.goto(url);
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.locator('textarea[name="key"]').fill('-----BEGIN OPENSSH PRIVATE KEY-----\nUI_TEST_ONLY\n-----END OPENSSH PRIVATE KEY-----');
  await page.locator('input[name="passphrase"]').fill('phone separate passphrase');
  await page.getByRole('button', {name: '加密保存并解锁'}).click();
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.locator('input[name="fingerprint"]').fill(`SHA256:${'a'.repeat(43)}`);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', {name: '保存可信指纹'}).click();
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.getByRole('button', {name: '会话一 就绪 ›'}).click();
  await page.locator('#composer').fill('会话一独立草稿');
  await page.getByRole('button', {name: '会话二 就绪 ›'}).click();
  assert.equal(await page.locator('#composer').inputValue(), '');
  await page.locator('#composer').fill('会话二独立草稿');
  await page.getByRole('button', {name: '会话一 就绪 ›'}).click();
  assert.equal(await page.locator('#composer').inputValue(), '会话一独立草稿');
  await page.evaluate(() => window.__fixture.event('s1', {type: 'extension_ui_request', id: 'status1', method: 'setStatus', statusKey: 'test', statusText: '可恢复扩展状态'}));
  await page.getByRole('button', {name: '会话二 就绪 ›'}).click();
  await page.getByRole('button', {name: '会话一 就绪 ›'}).click();
  await page.getByText('可恢复扩展状态', {exact: true}).waitFor();
  await page.getByRole('button', {name: '/ 命令'}).click();
  await page.getByRole('button', {name: '/skill:review 回归测试命令'}).click();
  assert.equal(await page.locator('#composer').inputValue(), '/skill:review 会话一独立草稿');
  await page.getByRole('button', {name: '发送任务'}).click();
  await page.waitForFunction(() => document.querySelector('#composer').value === '');
  assert.equal(await page.locator('#notice').innerText().then((value) => value.includes('等待确认')), false);
  await page.evaluate(() => window.__fixture.event('s1', {type: 'extension_ui_request', id: 'dialog1', method: 'confirm', title: '过期对话测试', message: '此对话将由 PC 过期'}));
  await page.getByRole('heading', {name: '过期对话测试'}).waitFor();
  await page.evaluate(() => window.__fixture.event('s1', {type: 'extension_ui_expired', id: 'dialog1'}));
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  await page.evaluate(() => {
    window.__fixture.event('s1', {type: 'extension_ui_request', id: 'dialog2', method: 'confirm', title: '第一对话', message: '确认后应继续第二对话'});
    window.__fixture.event('s1', {type: 'extension_ui_request', id: 'dialog3', method: 'confirm', title: '第二对话', message: '不可被第一对话的回执关闭'});
  });
  await page.getByRole('button', {name: '是', exact: true}).click();
  await page.getByRole('heading', {name: '第二对话', exact: true}).waitFor();
  await page.evaluate(() => window.__fixture.gap('s1'));
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  await page.locator('#composer').fill('刷新后仍然存在');
  await page.reload();
  assert.equal(await page.locator('#composer').inputValue(), '刷新后仍然存在');
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.locator('input[name="passphrase"]').fill('wrong passphrase');
  await page.getByRole('button', {name: '解锁', exact: true}).click();
  await page.getByRole('alert').filter({hasText: '无法解锁'}).waitFor();
  await page.locator('input[name="passphrase"]').fill('phone separate passphrase');
  await page.getByRole('button', {name: '解锁', exact: true}).click();
  await page.getByRole('button', {name: '连接 PC', exact: true}).click();
  await page.getByRole('heading', {name: '会话一', exact: true}).waitFor();
  assert.equal(await page.locator('#composer').inputValue(), '刷新后仍然存在');
  await page.locator('#host-select').selectOption('host2');
  await page.locator('.welcome h1').waitFor();
  assert.equal(await page.locator('#composer').inputValue(), '');
  assert.equal(await page.locator('.connection').innerText(), '已断开');
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: '切换会话列表'}).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const screenshots = process.env.UI_SMOKE_OUTPUT;
  if (screenshots) { await mkdir(screenshots, {recursive: true}); await page.screenshot({path: resolve(screenshots, 'pwa-mobile.png'), fullPage: true}); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({status: 'passed', transport: 'explicit UI fixture; not real SSH or Passkey', browser: await browser.version(), checks: ['local key encryption and wrong-password rejection', 'explicit fingerprint enrollment', 'cross-session draft isolation', 'extension status restoration on replay', 'command insertion', 'prompt receipt clears pending action', 'expired extension dialog dismissal', 'early extension resolution cannot close next dialog', 'cursor gap snapshot dismisses stale extension dialog', 'reload preserves selection and draft while locking key', 'host switching disconnects and resets session', '390px mobile layout without horizontal overflow']}, null, 2));
} finally { await browser?.close(); await server.close(); }
