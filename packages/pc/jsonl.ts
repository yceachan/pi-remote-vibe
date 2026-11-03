import { StringDecoder } from 'node:string_decoder';

/** Unlike readline, preserves U+2028/U+2029 and split UTF-8 code points. */
export class JsonlDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private onRecord: (record: unknown) => void, private maxBytes = 8 * 1024 * 1024) {}
  write(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let at: number;
    while ((at = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error('JSONL record exceeds limit');
      if (line.trim()) this.onRecord(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error('JSONL record exceeds limit');
  }
}
