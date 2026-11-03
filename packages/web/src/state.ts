export interface SessionView {
  cursor: number;
  messages: any[];
  streaming: any | null;
  running: boolean;
  status: string;
  tools: Record<string, {name: string; text: string; done: boolean; error?: boolean}>;
}
export const emptyView = (): SessionView => ({cursor: 0, messages: [], streaming: null, running: false, status: '就绪', tools: {}});

export function messageText(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map((block: any) => {
    if (block.type === 'text') return block.text ?? '';
    if (block.type === 'thinking') return block.thinking ? `思考：${block.thinking}` : '';
    if (block.type === 'toolCall') return `调用 ${block.name}\n${JSON.stringify(block.arguments, null, 2)}`;
    if (block.type === 'image') return '[图片]';
    return '';
  }).filter(Boolean).join('\n\n');
  return '';
}

/** Returns false for a cursor gap; caller must obtain a fresh snapshot. */
export function applyEvent(view: SessionView, envelope: {seq: number; event: any}): boolean {
  if (envelope.seq <= view.cursor) return true;
  if (envelope.seq !== view.cursor + 1) return false;
  view.cursor = envelope.seq;
  const event = envelope.event;
  switch (event.type) {
    case 'agent_start': view.running = true; view.status = '运行中'; break;
    case 'agent_end': view.status = '等待后续工作'; break;
    case 'agent_settled': view.running = false; view.status = '已完成'; break;
    case 'message_start': if (event.message?.role === 'assistant') view.streaming = event.message; break;
    case 'message_update': {
      if (event.message) view.streaming = event.message;
      else if (event.assistantMessageEvent) {
        const update = event.assistantMessageEvent;
        view.streaming ??= {role: 'assistant', content: []};
        if (!Array.isArray(view.streaming.content)) view.streaming.content = [];
        const content = view.streaming.content;
        const index = update.contentIndex ?? 0;
        if (update.type === 'text_start') content[index] = {type: 'text', text: ''};
        if (update.type === 'thinking_start') content[index] = {type: 'thinking', thinking: ''};
        if (update.type === 'text_delta') { content[index] ??= {type: 'text', text: ''}; content[index].text += update.delta; }
        if (update.type === 'thinking_delta') { content[index] ??= {type: 'thinking', thinking: ''}; content[index].thinking += update.delta; }
        if (update.type === 'text_end') content[index] = {type: 'text', text: update.content};
        if (update.type === 'thinking_end') content[index] = {type: 'thinking', thinking: update.content};
        if (update.type === 'toolcall_end') content[index] = update.toolCall;
      }
      break;
    }
    case 'message_end':
      if (event.message) view.messages.push(event.message);
      if (event.message?.role === 'assistant') view.streaming = null;
      break;
    case 'tool_execution_start':
      view.tools[event.toolCallId] = {name: event.toolName, text: JSON.stringify(event.args ?? {}, null, 2), done: false};
      break;
    case 'tool_execution_update': {
      const tool = view.tools[event.toolCallId];
      if (tool) tool.text = messageText(event.partialResult) || JSON.stringify(event.partialResult ?? '');
      break;
    }
    case 'tool_execution_end':
      view.tools[event.toolCallId] = {name: event.toolName, text: messageText(event.result), done: true, error: event.isError};
      break;
    case 'worker_exit': case 'worker_interrupted': case 'session_interrupted':
      view.running = false; view.status = '已中断 · 可恢复历史'; break;
    case 'compaction_start': case 'auto_compaction_start': view.status = '整理上下文'; break;
    case 'auto_retry_start': view.status = '正在重试'; break;
  }
  return true;
}
