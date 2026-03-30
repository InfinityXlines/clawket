import { EventEmitter } from 'node:events';

// ── Agent types ──

export type BackendType = 'openclaw' | 'claude-code' | 'hermes';

export type AgentCapability =
  | 'chat'
  | 'file-management'
  | 'skill-management'
  | 'cron-scheduling'
  | 'config-editing'
  | 'session-history';

export type AgentStatus = 'online' | 'offline' | 'busy';

export type AgentIdentity = {
  name: string;
  emoji?: string;
  avatarUrl?: string;
};

export type UnifiedAgent = {
  /** Globally unique: `${backendType}:${localId}` */
  id: string;
  /** Backend-local identifier */
  localId: string;
  backend: BackendType;
  name: string;
  model?: string;
  emoji?: string;
  avatarUrl?: string;
  status: AgentStatus;
  capabilities: AgentCapability[];
};

// ── Chat streaming ──

export type ChatChunkType = 'text' | 'tool-use' | 'tool-result' | 'thinking' | 'error';

export type ChatChunk = {
  type: ChatChunkType;
  content: string;
  /** Monotonic index for ordering */
  index: number;
  /** Optional metadata (tool name, thinking label, etc.) */
  meta?: Record<string, unknown>;
};

export interface ChatStream {
  [Symbol.asyncIterator](): AsyncIterator<ChatChunk>;
  cancel(): void;
  on(event: 'chunk', listener: (chunk: ChatChunk) => void): this;
  on(event: 'done', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

// ── Session types ──

export type Session = {
  id: string;
  agentId: string;
  createdAtMs: number;
  lastActiveMs: number;
};

// ── RPC frame types ──

export type ReqFrame = {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type ResFrame = {
  type: 'res';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

// ── Backend adapter interface ──

export type BackendHealth = {
  backend: BackendType;
  healthy: boolean;
  agentCount: number;
  error?: string;
};

export interface BackendAdapter extends EventEmitter {
  readonly type: BackendType;
  readonly displayName: string;
  readonly backendCapabilities: AgentCapability[];

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isHealthy(): Promise<boolean>;

  listAgents(): Promise<UnifiedAgent[]>;
  getAgentIdentity(localId: string): Promise<AgentIdentity>;

  sendMessage(localId: string, message: string, sessionId?: string): Promise<ChatStream>;

  listSessions(localId: string): Promise<Session[]>;
  createSession(localId: string): Promise<Session>;

  getConfig(localId: string): Promise<Record<string, unknown>>;
  patchConfig(localId: string, patch: Record<string, unknown>): Promise<void>;

  /**
   * Handle an RPC frame targeted at this backend.
   * Returns a ResFrame to send back to mobile, or null to signal
   * "passthrough to the default gateway WebSocket."
   */
  handleRpc(frame: ReqFrame): Promise<ResFrame | null>;

  on(event: 'agent-status-changed', listener: (agent: UnifiedAgent) => void): this;
  on(event: 'agent-discovered', listener: (agent: UnifiedAgent) => void): this;
  on(event: 'agent-removed', listener: (agentId: string) => void): this;
}

export function buildAgentId(backend: BackendType, localId: string): string {
  return `${backend}:${localId}`;
}

export function parseAgentId(compositeId: string): { backend: BackendType; localId: string } | null {
  const colonIndex = compositeId.indexOf(':');
  if (colonIndex === -1) return null;
  const backend = compositeId.slice(0, colonIndex) as BackendType;
  if (backend !== 'openclaw' && backend !== 'claude-code' && backend !== 'hermes') return null;
  return { backend, localId: compositeId.slice(colonIndex + 1) };
}
