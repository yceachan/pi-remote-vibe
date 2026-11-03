export interface ByteChannel {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}
export interface Envelope { type: string; [key: string]: unknown }

export class ProtocolClient {
  private pending = new Map<string, {resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  onEvent: (record: any) => void = () => {};
  onClose: (error: Error) => void = () => {};

  constructor(private channel: ByteChannel) {
    this.writer = channel.writable.getWriter();
    void this.read();
  }

  request(type: string, fields: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('连接已断开。'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('PC 响应超时。操作可能已接收，重连后会查询状态。')); }, 30_000);
      this.pending.set(id, {resolve, reject, timer});
      this.writes = this.writes.then(() => this.writer.write(new TextEncoder().encode(JSON.stringify({...fields, type, id}) + '\n')));
      this.writes.catch((error) => this.finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  close(): void { this.channel.close(); this.finish(new Error('连接已关闭。')); }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.onClose(error);
  }

  private async read(): Promise<void> {
    const reader = this.channel.readable.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let buffer = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, {stream: true});
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          if (line.length > 16 * 1024 * 1024) throw new Error('PC 协议记录超出 16 MiB 限制。');
          const record = JSON.parse(line);
          if (!record || typeof record !== 'object' || typeof record.type !== 'string') throw new Error('PC 返回了无效协议记录。');
          if (record.type === 'result') {
            const item = this.pending.get(record.id);
            if (item) {
              clearTimeout(item.timer); this.pending.delete(record.id);
              if (record.ok) item.resolve(record.data);
              else item.reject(Object.assign(new Error(record.error?.message ?? 'PC 请求失败。'), {code: record.error?.code}));
            }
          } else this.onEvent(record);
        }
        if (buffer.length > 16 * 1024 * 1024) throw new Error('PC 协议记录超出 16 MiB 限制。');
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error('连接结束时收到不完整协议记录。');
      this.finish(new Error('与 PC 的连接已断开。后台任务仍由 PC 管理。'));
    } catch (error) { this.channel.close(); this.finish(error instanceof Error ? error : new Error(String(error))); }
    finally { reader.releaseLock(); }
  }
}
