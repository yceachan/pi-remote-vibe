import test from 'node:test';
import assert from 'node:assert/strict';
import {ProtocolClient} from './src/transport.js';

test('JSONL preserves split UTF-8 and Unicode line separators, correlates out-of-order responses', async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const requests: any[] = [];
  const received: any[] = [];
  const client = new ProtocolClient({
    readable: new ReadableStream({start(controller) { output = controller; }}),
    writable: new WritableStream({write(bytes) { requests.push(JSON.parse(new TextDecoder().decode(bytes))); }}),
    close() { output.close(); },
  });
  client.onEvent = (event) => received.push(event);
  const first = client.request('hello', {clientId: 'one'});
  const second = client.request('list_projects');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const bytes = new TextEncoder().encode(JSON.stringify({type: 'event', sessionId: 's', seq: 1, event: {type: 'message_end', text: '你好\u2028world\u2029end'}}) + '\r\n' +
    JSON.stringify({type: 'result', id: requests[1].id, ok: true, data: {projects: []}}) + '\n' +
    JSON.stringify({type: 'result', id: requests[0].id, ok: true, data: {version: 1}}) + '\n');
  for (let index = 0; index < bytes.length; index += 2) output.enqueue(bytes.slice(index, index + 2));
  assert.deepEqual(await first, {version: 1});
  assert.deepEqual(await second, {projects: []});
  assert.equal(received.length, 1);
  assert.equal(received[0].event.text, '你好\u2028world\u2029end');
  client.close();
});
test('a lost connection rejects pending operations without inventing a server rejection code', async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const client = new ProtocolClient({readable: new ReadableStream({start(controller) { output = controller; }}), writable: new WritableStream(), close() {}});
  const operation = client.request('rpc', {clientActionId: 'persisted-before-send'});
  output.close();
  await assert.rejects(operation, (error: any) => { assert.equal(error.code, undefined); return /断开/.test(error.message); });
});
test('a structured manager rejection preserves its explicit code', async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const client = new ProtocolClient({
    readable: new ReadableStream({start(controller) { output = controller; }}),
    writable: new WritableStream({write(bytes) { const request = JSON.parse(new TextDecoder().decode(bytes)); output.enqueue(new TextEncoder().encode(JSON.stringify({type: 'result', id: request.id, ok: false, error: {code: 'not_controller', message: 'Acquire control'}}) + '\n')); }}), close() { output.close(); },
  });
  await assert.rejects(client.request('rpc'), (error: any) => error.code === 'not_controller');
  client.close();
});
