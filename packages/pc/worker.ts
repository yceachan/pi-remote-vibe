import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JsonlDecoder } from './jsonl.js';
import type { JsonRecord } from './protocol.js';

export interface WorkerOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onRecord: (record: JsonRecord) => void;
  onExit: (error: Error) => void;
  onDiagnostic?: (text: string) => void;
  timeoutMs?: number;
}

/** A worker belongs to a session, never to a socket/subscription. */
export class PiWorker {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; onResponse?: (response: JsonRecord) => void }>();
  private ended = false;
  private reported = false;
  private failure?: Error;
  private exited: Promise<void>;
  private resolveExited!: () => void;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private options: WorkerOptions) {
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new JsonlDecoder(value => {
      if (!value || typeof value !== 'object' || typeof (value as JsonRecord).type !== 'string') throw new Error('Invalid Pi protocol record');
      const record = value as JsonRecord;
      if (record.type === 'response' && typeof record.id === 'string') {
        const pending = this.pending.get(record.id);
        if (pending) {
          this.pending.delete(record.id);
          clearTimeout(pending.timer);
          pending.onResponse?.(record);
          pending.resolve(record);
          return;
        }
      }
      options.onRecord(record);
    });
    this.child.stdout.on('data', chunk => {
      try { decoder.write(chunk); } catch (error) { this.transportFailure(error as Error); }
    });
    this.child.stderr.on('data', chunk => options.onDiagnostic?.(String(chunk)));
    this.child.on('error', error => { if (this.child.pid) this.transportFailure(error); else this.fail(error); });
    this.child.stdin.on('error', error => this.transportFailure(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Pi exited (${signal ?? code})`)));
  }
  private fail(error: Error): void {
    if (this.reported) return;
    this.reported = true;
    this.ended = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.options.onExit(this.failure ?? error);
    this.resolveExited();
  }
  private transportFailure(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    // Never advertise this worker as replaceable before it has actually exited:
    // otherwise a malformed record/EPIPE can create two session-file writers.
    if (this.child.pid) this.child.kill('SIGKILL'); else this.fail(error);
  }
  write(record: JsonRecord): Promise<void> {
    const write = this.writeQueue.then(() => new Promise<void>((resolve, reject) => {
      if (this.ended || !this.child.stdin.writable) { reject(new Error('Pi worker is not running')); return; }
      // The callback waits for the write to flush, honoring pipe backpressure.
      this.child.stdin.write(JSON.stringify(record) + '\n', error => error ? reject(error) : resolve());
    }));
    this.writeQueue = write.catch(() => {});
    return write;
  }
  request(command: JsonRecord, onResponse?: (response: JsonRecord) => void): Promise<JsonRecord> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi command ${command.type} timed out; its execution outcome is unknown`));
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer, onResponse });
      void this.write({ ...command, id }).catch(error => {
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  async stop(): Promise<void> {
    if (this.ended) return this.exited;
    const timeout = setTimeout(() => { this.child.kill('SIGKILL'); }, 2_000);
    this.child.stdin.end();
    try { await this.exited; } finally { clearTimeout(timeout); }
  }
}
