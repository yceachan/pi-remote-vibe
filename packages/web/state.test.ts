import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEvent, emptyView, messageText} from './src/state.js';

test('prompt acceptance and agent_end never imply completion; only settled finishes the run', () => {
  const view = emptyView();
  applyEvent(view, {seq: 1, event: {type: 'agent_start'}});
  applyEvent(view, {seq: 2, event: {type: 'response', command: 'prompt', success: true}});
  applyEvent(view, {seq: 3, event: {type: 'agent_end'}});
  assert.equal(view.running, true);
  applyEvent(view, {seq: 4, event: {type: 'agent_settled'}});
  assert.equal(view.running, false);
});
test('replayed duplicates do not duplicate messages and missing events force full synchronization', () => {
  const view = emptyView();
  const message = {seq: 1, event: {type: 'message_end', message: {role: 'user', content: 'hello'}}};
  assert.equal(applyEvent(view, message), true);
  assert.equal(applyEvent(view, message), true);
  assert.equal(view.messages.length, 1);
  assert.equal(applyEvent(view, {seq: 3, event: {type: 'agent_start'}}), false);
  assert.equal(view.cursor, 1);
  assert.equal(view.running, false);
});
test('streaming reconstructs independent thinking and text blocks then stores the authoritative final message', () => {
  const view = emptyView();
  const events = [
    {type: 'message_start', message: {role: 'assistant', content: []}},
    {type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', contentIndex: 0, delta: 'reason'}},
    {type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 1, delta: '你'}},
    {type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 1, delta: '好'}},
  ];
  events.forEach((event, index) => applyEvent(view, {seq: index + 1, event}));
  assert.equal(messageText(view.streaming), '思考：reason\n\n你好');
  applyEvent(view, {seq: 5, event: {type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: '你好'}]}}});
  assert.equal(view.streaming, null);
  assert.equal(messageText(view.messages[0]), '你好');
});
test('a worker interruption remains visible instead of claiming successful completion', () => {
  const view = emptyView(); view.running = true;
  applyEvent(view, {seq: 1, event: {type: 'worker_exit'}});
  assert.equal(view.running, false);
  assert.match(view.status, /中断/);
});
