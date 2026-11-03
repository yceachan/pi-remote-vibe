export interface SshOptions {
  url: string;
  username: string;
  /** An unlocked OpenSSH/PEM private key. Never sent to the relay. */
  privateKey: string;
  /** OpenSSH SHA256 fingerprint obtained from a trusted registration channel. */
  expectedFingerprint: string;
  /** Defaults to ssh-ed25519; use the algorithm of the registered host key. */
  hostKeyAlgorithm?: 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' | 'ecdsa-sha2-nistp521' | 'rsa-sha2-512' | 'rsa-sha2-256';
  command?: string;
  signal?: AbortSignal;
  assetBaseUrl?: string;
}

export interface SshConnection {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

interface WasmApi {
  open(options: { id: string; url: string; username: string; privateKey: string; expectedFingerprint: string; hostKeyAlgorithm: string; command: string }): Promise<string>;
  read(id: string): Promise<Uint8Array | null>;
  write(id: string, data: Uint8Array): Promise<void>;
  eof(id: string): Promise<void>;
  close(id: string): void;
}

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

const globals = globalThis as typeof globalThis & {
  Go?: new () => GoRuntime;
  piRemoteSsh?: WasmApi;
};

let initialization: Promise<WasmApi> | undefined;

/** Assets are built from this package's pinned Go dependencies, never a CDN. */
async function loadWasm(assetBaseUrl: string): Promise<WasmApi> {
  if (globals.piRemoteSsh) return globals.piRemoteSsh;
  initialization ??= (async () => {
    const base = new URL(assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`, location.href);
    if (base.origin !== location.origin) throw new Error('SSH WASM assets must be served from this origin');
    if (!globals.Go) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => { script.remove(); reject(new Error('SSH runtime load timed out')); }, 20_000);
        script.src = new URL('wasm_exec.js', base).href;
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Build the SSH WASM assets before connecting')); };
        document.head.append(script);
      });
    }
    if (!globals.Go) throw new Error('SSH Go runtime is unavailable');
    const response = await fetch(new URL('ssh.wasm', base), { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`SSH WASM download failed (${response.status})`);
    const go = new globals.Go();
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    let runtimeError: unknown;
    void go.run(result.instance).catch((error: unknown) => { runtimeError = error; });
    const started = Date.now();
    while (!globals.piRemoteSsh) {
      if (runtimeError) throw runtimeError;
      if (Date.now() - started > 5_000) throw new Error('SSH WASM initialization timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return globals.piRemoteSsh;
  })().catch((error: unknown) => { initialization = undefined; throw error; });
  return initialization;
}

/** Opens one binary, non-PTY SSH exec channel with strict host key pinning. */
export async function connectSsh(options: SshOptions): Promise<SshConnection> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.expectedFingerprint)) {
    throw new Error('A registered SHA256 SSH host fingerprint is required');
  }
  if (!options.username.trim() || !options.privateKey) throw new Error('SSH username and unlocked private key are required');
  const url = new URL(options.url, location.href);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) throw new Error('SSH relay requires WSS');
  if (url.username || url.password || url.hash) throw new Error('Invalid SSH relay URL');
  const api = await loadWasm(options.assetBaseUrl ?? '/ssh/');
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  let disposed = false;
  let reader: ReadableStreamDefaultController<Uint8Array> | undefined;
  const close = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', close);
    api.close(id);
    try { reader?.close(); } catch { /* A failed or canceled stream is already closed. */ }
  };
  // Go registers the transport before open() returns, so even an abort during
  // its SSH handshake can close the underlying socket immediately.
  const opening = api.open({
    id,
    url: url.href,
    username: options.username,
    privateKey: options.privateKey,
    expectedFingerprint: options.expectedFingerprint,
    hostKeyAlgorithm: options.hostKeyAlgorithm ?? 'ssh-ed25519',
    command: options.command ?? 'pi-remote-attach',
  });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  try {
    await opening;
    signal?.throwIfAborted();
  } catch (error) {
    close();
    throw error;
  }
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { reader = controller; },
    async pull(controller) {
      try {
        const chunk = await api.read(id);
        if (disposed) return;
        if (chunk === null) close();
        else controller.enqueue(chunk);
      } catch (error) {
        if (!disposed) controller.error(error);
        close();
      }
    },
    cancel: close,
  }, { highWaterMark: 2 });
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (disposed) throw new Error('SSH connection is closed');
      try { await api.write(id, chunk); } catch (error) { close(); throw error; }
    },
    async close() { if (!disposed) await api.eof(id); },
    abort: close,
  });
  return { readable, writable, close };
}
