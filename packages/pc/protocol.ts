/** Application protocol v1. Transport is UTF-8 JSON objects separated only by LF. */
export type JsonRecord = { type: string; [key: string]: unknown };
export interface Project { id: string; name: string; path: string }
export interface SessionInfo {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  sessionFile?: string;
  status: 'idle' | 'running' | 'interrupted' | 'error';
  lastError?: string;
}
export interface Control { clientId: string; expiresAt: number }
export interface SessionEvent { type: 'event'; sessionId: string; seq: number; event: JsonRecord }
export interface AppRequest extends JsonRecord {
  id: string;
  clientId?: string;
  sessionId?: string;
  projectId?: string;
  name?: string;
  afterSeq?: number;
  clientActionId?: string;
  rpc?: JsonRecord;
}
export interface ActionReceipt {
  clientActionId: string;
  status: 'accepted' | 'completed' | 'unknown';
  acceptedAt: string;
  rpc: JsonRecord;
  response?: JsonRecord;
  error?: string;
}
export interface SubscriptionSnapshot {
  mode: 'snapshot' | 'replay';
  session: SessionInfo;
  state: Record<string, unknown>;
  messages: unknown[];
  /** In-progress message at cursor, not yet included in messages. */
  partialMessage: Record<string, unknown> | null;
  activeTools: JsonRecord[];
  cursor: number;
  events: SessionEvent[];
  control: Control | null;
  pendingUi: JsonRecord[];
  /** Latest persistent standard UI records (status/widget/title), not notices. */
  uiState: JsonRecord[];
}
export type AppResult =
  | { type: 'result'; id: string; ok: true; data: unknown }
  | { type: 'result'; id: string; ok: false; error: { code: string; message: string } };
export type ServerRecord = AppResult | SessionEvent;
