import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket, type ClientOptions } from 'ws';
import { AuthService, hashToken, webAuthn } from '../packages/relay/auth.ts';
import { createRelay } from '../packages/relay/server.ts';
import { validateConfig, type RelayConfig } from '../packages/relay/config.ts';

const invite = 'test-invitation-32-byte-secret-value';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-relay-'));
  const config: RelayConfig = { origin: 'http://localhost:3100', rpId: 'localhost', listenHost: '127.0.0.1', port: 0, dataDir: dir, hosts: [{ id: 'home', name: 'Home', sshUser: 'test', port: 2201 }, { id: 'office', name: 'Office', sshUser: 'test', port: 2202 }], users: [{ id: 'owner', name: 'Owner', hostIds: ['home'], enrollmentTokenHash: hashToken(invite) }] };
  const calls: any[] = [];
  const api: typeof webAuthn = {
    ...webAuthn,
    verifyRegistrationResponse: async input => { calls.push(input); return { verified: true, registrationInfo: { credential: { id: 'test-key', publicKey: new Uint8Array([1, 2]), counter: 0 } } } as any; },
    verifyAuthenticationResponse: async input => { calls.push(input); return { verified: true, authenticationInfo: { newCounter: input.credential.counter + 1 } } as any; },
  };
  const auth = new AuthService(config, api);
  return { config, auth, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function enroll(auth: AuthService) {
  const result = await auth.registerOptions(invite);
  return auth.registerVerify(result.token, { id: 'test-key' } as any);
}
test('config rejects public binds, invalid RP, arbitrary ports, and unknown ACL hosts', () => {
  const f = fixture();
  try {
    for (const override of [{ listenHost: '0.0.0.0' }, { rpId: 'attacker.test' }, { hosts: [{ id: 'x', name: 'x', sshUser: 'u', port: 0 }] }, { users: [{ id: 'u', name: 'u', hostIds: ['not-registered'] }] }]) assert.throws(() => validateConfig({ ...f.config, ...override } as RelayConfig));
  } finally { f.cleanup(); }
});
test('passkey challenges are one-use and invitations persist as consumed', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.auth.registerOptions('not-valid'), /Invalid enrollment/);
    const challenge = await f.auth.registerOptions(invite);
    const token = await f.auth.registerVerify(challenge.token, { id: 'test-key' } as any);
    assert.equal(f.auth.session(token)?.userId, 'owner');
    assert.equal(f.calls[0].requireUserVerification, true);
    assert.equal(f.calls[0].expectedOrigin, f.config.origin);
    assert.equal(f.calls[0].expectedRPID, f.config.rpId);
    await assert.rejects(f.auth.registerVerify(challenge.token, { id: 'test-key' } as any), /expired/);
    const restarted = new AuthService(f.config);
    await assert.rejects(restarted.registerOptions(invite), /already used/);
    assert.equal(restarted.session(token), undefined);
    assert.ok(!readFileSync(join(f.config.dataDir, 'passkeys.json'), 'utf8').includes(invite));
    const options = await f.auth.loginOptions();
    const fresh = await f.auth.loginVerify(options.token, { id: 'test-key' } as any);
    assert.ok(f.auth.session(fresh));
    assert.equal(f.calls[1].credential.counter, 0);
    await assert.rejects(f.auth.loginVerify(options.token, { id: 'test-key' } as any), /expired/);
    f.auth.logout(fresh);
    assert.equal(f.auth.session(fresh), undefined);
  } finally { f.cleanup(); }
});
test('real WebAuthn verifier rejects fabricated enrollment', async () => {
  const f = fixture();
  try {
    const auth = new AuthService(f.config);
    const options = await auth.registerOptions(invite);
    await assert.rejects(auth.registerVerify(options.token, { id: 'fake', response: {}, type: 'public-key' } as any));
    assert.equal(auth.session('fake'), undefined);
  } finally { f.cleanup(); }
});
async function rejectedUpgrade(url: string, options: ClientOptions) {
  const ws = new WebSocket(url, options);
  const status = await new Promise<number>((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); ws.terminate(); });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected authorization')); });
    ws.on('error', () => {});
  });
  return status;
}
test('relay requires session, exact Origin and host ACL; forwards opaque binary bytes; logout closes stream', async () => {
  const f = fixture();
  const tcp = createServer(socket => socket.pipe(socket));
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  f.config.hosts[0].port = (tcp.address() as any).port;
  const relay = createRelay(f.config, f.auth);
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const address = `127.0.0.1:${(relay.server.address() as any).port}`;
  try {
    const unauthenticated = await fetch(`http://${address}/api/hosts`);
    assert.equal(unauthenticated.status, 401);
    const crossSite = await fetch(`http://${address}/api/auth/login/options`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(crossSite.status, 403);
    assert.equal(await rejectedUpgrade(`ws://${address}/relay/home`, { origin: f.config.origin }), 401);
    const token = await enroll(f.auth);
    const headers = { Cookie: `prv_session=${token}` };
    assert.equal(await rejectedUpgrade(`ws://${address}/relay/home`, { headers, origin: 'https://evil.test' }), 403);
    assert.equal(await rejectedUpgrade(`ws://${address}/relay/office`, { headers, origin: f.config.origin }), 403);
    assert.equal(await rejectedUpgrade(`ws://${address}/relay/home?port=22`, { headers, origin: f.config.origin }), 403);
    const hosts = await fetch(`http://${address}/api/hosts`, { headers }).then(r => r.json()) as any;
    assert.deepEqual(hosts.hosts.map((h: any) => h.id), ['home']);
    assert.equal(hosts.hosts[0].port, undefined);
    const ws = new WebSocket(`ws://${address}/relay/home`, { headers, origin: f.config.origin });
    await once(ws, 'open');
    const bytes = Buffer.from([0, 255, 13, 10, 0, 128]);
    const received = once(ws, 'message');
    ws.send(bytes);
    const [echo, binary] = await received;
    assert.deepEqual(echo, bytes);
    assert.equal(binary, true);
    const closed = once(ws, 'close');
    const logout = await fetch(`http://${address}/api/auth/logout`, { method: 'POST', headers: { ...headers, Origin: f.config.origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    await closed;
    assert.equal(f.auth.session(token), undefined);
  } finally {
    await relay.close();
    await new Promise<void>(resolve => tcp.close(() => resolve()));
    f.cleanup();
  }
});

test('concurrent authentication cannot accept the same positive signature counter twice', async () => {
  const f = fixture();
  try {
    await enroll(f.auth);
    const one = await f.auth.loginOptions();
    const two = await f.auth.loginOptions();
    const results = await Promise.allSettled([
      f.auth.loginVerify(one.token, { id: 'test-key' } as any),
      f.auth.loginVerify(two.token, { id: 'test-key' } as any),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  } finally { f.cleanup(); }
});

test('text WebSocket frames are rejected before any bytes reach the TCP target', async () => {
  const f = fixture();
  const received: Buffer[] = [];
  const tcp = createServer(socket => socket.on('data', data => received.push(data)));
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  f.config.hosts[0].port = (tcp.address() as any).port;
  const relay = createRelay(f.config, f.auth);
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  try {
    const token = await enroll(f.auth);
    const ws = new WebSocket(`ws://127.0.0.1:${(relay.server.address() as any).port}/relay/home`, { origin: f.config.origin, headers: { Cookie: `prv_session=${token}` } });
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send('must-not-reach-tcp');
    await closed;
    assert.equal(Buffer.concat(received).length, 0);
  } finally {
    await relay.close();
    await new Promise<void>(resolve => tcp.close(() => resolve()));
    f.cleanup();
  }
});
