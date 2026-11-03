// UI regression fixture only. The smoke script aliases the SSH package to this
// module; production builds always import the real Go/WASM SSH implementation.
const sessions = [{id: 's1', projectId: 'p1', name: '会话一', status: 'idle'}, {id: 's2', projectId: 'p1', name: '会话二', status: 'idle'}];
const cursors = new Map();
const receipts = new Map();
const events = new Map();
const uiStates = new Map();
const pendingDialogs = new Map();
let clientId;
let control;
export async function connectSsh() {
  let output;
  let closed = false;
  const send = (record) => { if (!closed) output.enqueue(new TextEncoder().encode(JSON.stringify(record) + '\n')); };
  window.__fixture = {
    event(sessionId, event) {
      const seq = (cursors.get(sessionId) ?? 0) + 1; cursors.set(sessionId, seq);
      const envelope = {type: 'event', sessionId, seq, event};
      events.set(sessionId, [...(events.get(sessionId) ?? []), envelope]);
      if (event.method === 'setStatus') uiStates.set(sessionId, [event]);
      if (event.type === 'extension_ui_request' && ['confirm', 'input', 'editor', 'select'].includes(event.method)) pendingDialogs.set(event.id, event);
      if (event.type === 'extension_ui_expired' || event.type === 'extension_ui_resolved') pendingDialogs.delete(event.id);
      send(envelope);
    },
    gap(sessionId) { pendingDialogs.clear(); cursors.set(sessionId, (cursors.get(sessionId) ?? 0) + 5); this.event(sessionId, {type: 'control_changed', control}); },
  };
  return {
    readable: new ReadableStream({start(controller) { output = controller; }}),
    writable: new WritableStream({write(bytes) {
      const request = JSON.parse(new TextDecoder().decode(bytes));
      let data;
      switch (request.type) {
        case 'hello': clientId = request.clientId; data = {}; break;
        case 'list_projects': data = {projects: [{id: 'p1', name: '回归测试项目'}]}; break;
        case 'list_sessions': data = {sessions}; break;
        case 'subscribe': data = {mode: typeof request.afterSeq === 'number' ? 'replay' : 'snapshot', session: sessions.find((item) => item.id === request.sessionId), state: {isStreaming: false, model: {id: 'fixture'}}, messages: [], partialMessage: null, activeTools: [], cursor: cursors.get(request.sessionId) ?? 0, events: typeof request.afterSeq === 'number' ? (events.get(request.sessionId) ?? []).filter((event) => event.seq > request.afterSeq) : [], control: null, pendingUi: [...pendingDialogs.values()], uiState: uiStates.get(request.sessionId) ?? []}; break;
        case 'acquire_control': case 'heartbeat': control = {clientId, expiresAt: Date.now() + 30000}; data = {control}; break;
        case 'release_control': control = null; data = {control: null}; break;
        case 'unsubscribe': data = {}; break;
        case 'action_status': data = {receipt: receipts.get(request.clientActionId) ?? null}; break;
        case 'rpc':
          if (request.rpc.type.startsWith('get_')) data = {response: {success: true, data: request.rpc.type === 'get_commands' ? {commands: [{name: 'skill:review', description: '回归测试命令'}]} : {models: [{id: 'fixture', name: '测试模型', provider: 'test'}]}}};
          else {
            if (request.rpc.type === 'extension_ui_response') window.__fixture.event(request.sessionId, {type: 'extension_ui_resolved', id: request.rpc.id});
            const receipt = {clientActionId: request.clientActionId, status: 'completed', rpc: request.rpc, response: {success: true}}; receipts.set(request.clientActionId, receipt); data = {receipt};
          }
          break;
        default: data = {};
      }
      send({type: 'result', id: request.id, ok: true, data});
    }}),
    close() { if (!closed) { closed = true; output.close(); } },
  };
}
