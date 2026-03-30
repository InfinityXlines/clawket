export type BackendType = 'openclaw' | 'claude-code' | 'hermes';

export type AgentCapability =
  | 'chat'
  | 'file-management'
  | 'skill-management'
  | 'cron-scheduling'
  | 'config-editing'
  | 'session-history';

export type AgentStatus = 'online' | 'offline' | 'busy';

export interface AgentIdentity {
  name?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
}

export interface AgentInfo {
  id: string;
  localId?: string;
  name?: string;
  backend?: BackendType;
  model?: string;
  status?: AgentStatus;
  capabilities?: AgentCapability[];
  identity?: AgentIdentity;
}

export interface AgentsListResult {
  defaultId: string;
  mainKey: string;
  agents: AgentInfo[];
}

export interface AgentCreateResult {
  ok: boolean;
  agentId: string;
  name: string;
  workspace: string;
}

export interface AgentUpdateResult {
  ok: boolean;
  agentId: string;
}

export interface AgentDeleteResult {
  ok: boolean;
  agentId: string;
  removedBindings?: number;
}

export interface BackendHealth {
  backend: BackendType;
  displayName: string;
  ok: boolean;
  healthy: boolean;
  latencyMs: number;
  checkedAtMs: number;
  agentCount: number;
  error?: string;
}
