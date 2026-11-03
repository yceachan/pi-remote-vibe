// Deterministic protocol fixture, never presented as a real Pi/model integration.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const sessionDir = option('--session-dir');
mkdirSync(sessionDir, { recursive: true });
const sessionFile = args.includes('--session') ? option('--session') : join(sessionDir, 'mock-session.json');
const messages = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : [];
let running = false;
let timer;
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const save = () => writeFileSync(sessionFile, JSON.stringify(messages));
const response = (command, data) => output({ type: 'response', id: command.id, command: command.type, success: true, data });
// Framing is tested separately against the real strict-LF decoder.
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const command = JSON.parse(line);
  switch (command.type) {
    case 'bad_output': process.stdout.write('not a JSON record\n'); break;
    case 'get_state': response(command, { sessionFile, isStreaming: running, sessionId: 'fixture', cwd: process.cwd() }); break;
    case 'get_messages': response(command, { messages }); break;
    case 'get_commands': response(command, { commands: [{ name: 'skill:test', source: 'skill' }] }); break;
    case 'get_available_models': response(command, { models: [] }); break;
    case 'prompt': {
      if (command.message === 'crash') { running = true; output({ type: 'agent_start' }); setTimeout(() => process.exit(12), 10); break; }
      const user = { role: 'user', content: command.message, timestamp: Date.now() };
      messages.push(user); save(); running = true;
      output({ type: 'agent_start' });
      output({ type: 'message_end', message: user });
      output({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } });
      output({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
      output({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'working…' } });
      if (command.message === 'dialog') {
        output({ type: 'extension_ui_request', id: 'status-1', method: 'setStatus', statusKey: 'example', statusText: 'Waiting' });
        output({ type: 'extension_ui_request', id: 'widget-1', method: 'setWidget', widgetKey: 'example', widgetLines: ['Visible after reconnect'] });
        output({ type: 'extension_ui_request', id: 'title-1', method: 'setTitle', title: 'Fixture title' });
        output({ type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: 'Continue?' });
      }
      response(command, { disposition: 'started' });
      timer = setTimeout(() => {
        const message = { role: 'assistant', content: [{ type: 'text', text: 'done: ' + command.message }], timestamp: Date.now() };
        messages.push(message); save(); running = false;
        output({ type: 'message_end', message });
        output({ type: 'agent_end', messages: [message] });
        output({ type: 'agent_settled', aborted: false });
      }, command.message === 'slow' ? 400 : 100);
      break;
    }
    case 'extension_ui_response': output({ type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'response ' + String(command.confirmed) }); break;
    case 'abort': clearTimeout(timer); running = false; output({ type: 'agent_settled', aborted: true }); response(command); break;
    default: response(command, {});
  }
});
input.on('close', () => { clearTimeout(timer); process.exit(0); });
