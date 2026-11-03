import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { connect } from 'node:net';
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws';
import { AuthError, AuthService } from './auth.ts';
import { validateConfig, type RelayConfig } from './config.ts';

const SESSION = 'prv_session';
const CHALLENGE = 'prv_challenge';
function cookie(req: IncomingMessage, name: string) {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AuthError(415, 'Expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new AuthError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch { throw new AuthError(400, 'Invalid JSON object'); }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
export function createRelay(input: RelayConfig, auth = new AuthService(input)) {
  const config = validateConfig(input);
  const secure = config.origin.startsWith('https:');
  const cookieHeader = (name: string, token: string, maxAge: number) => `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const connections = new Map<WebSocket, { token: string; userId: string; alive: boolean }>();
  const rate = new Map<string, { count: number; until: number }>();
  function rateLimit(req: IncomingMessage) {
    const now = Date.now();
    for (const [key, value] of rate) if (value.until <= now) rate.delete(key);
    const ip = req.socket.remoteAddress ?? 'unknown';
    let value = rate.get(ip);
    if (!value) { value = { count: 0, until: now + 60_000 }; rate.set(ip, value); }
    if (++value.count > 60) throw new AuthError(429, 'Too many authentication attempts; wait a minute');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url ?? '/', config.origin);
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        const token = cookie(req, SESSION);
        const session = auth.session(token);
        const user = session && auth.user(session.userId);
        if (req.method === 'GET' && path === '/api/me') return json(res, 200, user ? { authenticated: true, user: { id: user.id, name: user.name } } : { authenticated: false });
        if (req.method === 'GET' && path === '/api/hosts') {
          if (!user) throw new AuthError(401, 'Please sign in');
          return json(res, 200, { hosts: config.hosts.filter(h => user.hostIds.includes(h.id)).map(({ id, name, sshUser }) => ({ id, name, sshUser })) });
        }
        if (req.method !== 'POST') throw new AuthError(404, 'Not found');
        if (req.headers.origin !== config.origin) throw new AuthError(403, 'Origin rejected');
        rateLimit(req);
        const body = await jsonBody(req);
        if (path === '/api/auth/register/options' || path === '/api/auth/login/options') {
          const result = path.includes('/register/') ? await auth.registerOptions(body.token) : await auth.loginOptions();
          res.setHeader('Set-Cookie', cookieHeader(CHALLENGE, result.token, 120));
          return json(res, 200, { options: result.options });
        }
        if (path === '/api/auth/register/verify' || path === '/api/auth/login/verify') {
          if (!body.credential || typeof body.credential !== 'object') throw new AuthError(400, 'Missing credential');
          const next = path.includes('/register/') ? await auth.registerVerify(cookie(req, CHALLENGE), body.credential) : await auth.loginVerify(cookie(req, CHALLENGE), body.credential);
          auth.logout(token);
          res.setHeader('Set-Cookie', [cookieHeader(SESSION, next, Math.floor((config.sessionTtlMs ?? 12 * 3600_000) / 1000)), cookieHeader(CHALLENGE, '', 0)]);
          return json(res, 200, { ok: true });
        }
        if (path === '/api/auth/logout') {
          auth.logout(token);
          for (const [ws, value] of connections) if (value.token === token) ws.close(1008, 'Signed out');
          res.setHeader('Set-Cookie', cookieHeader(SESSION, '', 0));
          return json(res, 200, { ok: true });
        }
        throw new AuthError(404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AuthError(405, 'Method not allowed');
      if (!config.staticDir) throw new AuthError(404, 'Web app has not been built');
      const root = resolve(config.staticDir);
      const decoded = decodeURIComponent(path);
      const file = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!file.startsWith(`${root}${sep}`)) throw new AuthError(403, 'Invalid path');
      let stat;
      try { stat = statSync(file); } catch { throw new AuthError(404, 'Not found'); }
      if (!stat.isFile()) throw new AuthError(404, 'Not found');
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof AuthError ? error.status : 400;
      json(res, status, { error: error instanceof AuthError ? error.message : 'Request could not be verified' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
    if (req.headers.origin !== config.origin) return reject(403);
    const token = cookie(req, SESSION);
    const session = auth.session(token);
    const user = session && auth.user(session.userId);
    if (!user) return reject(401);
    const match = /^\/relay\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '');
    const host = match && config.hosts.find(h => h.id === match[1]);
    if (!host || !user.hostIds.includes(host.id)) return reject(403);
    if ([...connections.values()].filter(c => c.userId === user.id).length >= 8) return reject(429);
    wss.handleUpgrade(req, socket, head, ws => {
      const connection = { token: token!, userId: user.id, alive: true };
      connections.set(ws, connection);
      ws.on('pong', () => { connection.alive = true; });
      // Never accept a client-supplied address or port. SSH is opaque to the relay.
      const tcp = connect({ host: '127.0.0.1', port: host.port });
      tcp.setTimeout(15_000, () => { if (tcp.connecting) tcp.destroy(new Error('Tunnel unavailable')); });
      tcp.once('connect', () => tcp.setTimeout(0));
      // This listener must run before the stream's message handler: invalid
      // frames must not reach TCP, even briefly, before closing the connection.
      ws.on('message', (_data, binary) => {
        if (!binary) { tcp.destroy(); stream.destroy(); ws.close(1003, 'Binary SSH stream required'); }
      });
      const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
      const stop = () => { tcp.destroy(); stream.destroy(); ws.terminate(); connections.delete(ws); };
      tcp.on('error', stop);
      stream.on('error', stop);
      ws.on('error', stop);
      ws.on('close', () => { tcp.destroy(); stream.destroy(); connections.delete(ws); });
      tcp.on('close', () => ws.close());
      stream.pipe(tcp).pipe(stream);
    });
  });
  const timer = setInterval(() => {
    for (const [ws, value] of connections) {
      if (!value.alive || !auth.session(value.token) || ws.bufferedAmount > 4 * 1024 * 1024) { ws.terminate(); continue; }
      value.alive = false;
      ws.ping();
    }
  }, 15_000);
  timer.unref();
  return {
    server, auth,
    async close() {
      clearInterval(timer);
      for (const ws of connections.keys()) ws.terminate();
      wss.close();
      server.closeIdleConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
