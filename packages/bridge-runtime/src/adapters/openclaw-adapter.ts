import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { getOpenClawConfigPath, readOpenClawInfo, resolveGatewayUrl } from '../openclaw.js';
import type {
  AgentCapability,
  AgentIdentity,
  AdapterRpcResult,
  BackendAdapter,
  ChatStream,
  ReqFrame,
  Session,
  UnifiedAgent,
} from './types.js';
import { buildAgentId, parseAgentId } from './types.js';

type OpenClawConfigAgent = {
  id?: unknown;
  name?: unknown;
  emoji?: unknown;
  avatarUrl?: unknown;
  model?: unknown;
};

export class OpenClawAdapter extends EventEmitter implements BackendAdapter {
  readonly type = 'openclaw' as const;
  readonly displayName = 'OpenClaw';
  readonly backendCapabilities: AgentCapability[] = [
    'chat',
    'file-management',
    'skill-management',
    'cron-scheduling',
    'config-editing',
    'session-history',
  ];

  async connect(): Promise<void> {
    // Gateway connection managed by BridgeRuntime
  }

  async disconnect(): Promise<void> {
    // Managed by BridgeRuntime
  }

  async isHealthy(): Promise<boolean> {
    try {
      const info = readOpenClawInfo();
      return info.configFound && info.gatewayPort != null;
    } catch {
      return false;
    }
  }

  async listAgents(): Promise<UnifiedAgent[]> {
    const configPath = getOpenClawConfigPath();
    if (!existsSync(configPath)) return [];

    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
        agents?: { list?: OpenClawConfigAgent[] };
      };
      const rawAgents = Array.isArray(parsed.agents?.list) ? parsed.agents.list : [];
      return rawAgents
        .map(toUnifiedOpenClawAgent)
        .filter((agent): agent is UnifiedAgent => agent != null);
    } catch {
      return [];
    }
  }

  async getAgentIdentity(localId: string): Promise<AgentIdentity> {
    const agents = await this.listAgents();
    const agent = agents.find((entry) => entry.localId === localId);
    return {
      name: agent?.name ?? localId,
      ...(agent?.emoji ? { emoji: agent.emoji } : {}),
      ...(agent?.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
    };
  }

  async sendMessage(): Promise<ChatStream> {
    throw new Error('OpenClaw chat is handled via gateway WebSocket passthrough');
  }

  async listSessions(): Promise<Session[]> {
    return [];
  }

  async createSession(): Promise<Session> {
    throw new Error('OpenClaw sessions are handled via gateway WebSocket passthrough');
  }

  async canHandleSession(): Promise<boolean> {
    return false;
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return {};
  }

  async patchConfig(): Promise<void> {
    // Handled via gateway passthrough
  }

  async handleRpc(frame: ReqFrame): Promise<AdapterRpcResult> {
    return {
      kind: 'passthrough',
      frame: rewriteOpenClawAgentParams(frame),
    };
  }

  getGatewayUrl(): string {
    return resolveGatewayUrl();
  }
}

function toUnifiedOpenClawAgent(agent: OpenClawConfigAgent): UnifiedAgent | null {
  const localId = typeof agent.id === 'string' && agent.id.trim() ? agent.id.trim() : null;
  if (!localId) return null;
  const name = typeof agent.name === 'string' && agent.name.trim() ? agent.name.trim() : localId;
  return {
    id: buildAgentId('openclaw', localId),
    localId,
    backend: 'openclaw',
    name,
    ...(typeof agent.model === 'string' && agent.model.trim() ? { model: agent.model.trim() } : {}),
    ...(typeof agent.emoji === 'string' && agent.emoji.trim() ? { emoji: agent.emoji.trim() } : {}),
    ...(typeof agent.avatarUrl === 'string' && agent.avatarUrl.trim()
      ? { avatarUrl: agent.avatarUrl.trim() }
      : {}),
    status: 'online',
    capabilities: [
      'chat',
      'file-management',
      'skill-management',
      'cron-scheduling',
      'config-editing',
      'session-history',
    ],
  };
}

function rewriteOpenClawAgentParams(frame: ReqFrame): ReqFrame {
  if (!frame.params) return frame;
  const agentId = frame.params.agentId ?? frame.params.agent_id;
  if (typeof agentId !== 'string') return frame;
  const parsed = parseAgentId(agentId);
  if (!parsed || parsed.backend !== 'openclaw') return frame;
  return {
    ...frame,
    params: {
      ...frame.params,
      ...(frame.params.agentId !== undefined ? { agentId: parsed.localId } : {}),
      ...(frame.params.agent_id !== undefined ? { agent_id: parsed.localId } : {}),
    },
  };
}
