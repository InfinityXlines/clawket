import { EventEmitter } from 'node:events';
import type {
  AdapterRpcResult,
  GatewayFrame,
  ReqFrame,
  ResFrame,
  UnifiedAgent,
} from './adapters/types.js';
import { parseAgentId } from './adapters/types.js';
import type { UnifiedAgentRegistry } from './registry.js';

const AGGREGATION_METHODS = new Set<string>(['agents.list', 'backends.health']);

export class RpcDispatcher extends EventEmitter {
  constructor(private readonly registry: UnifiedAgentRegistry) {
    super();
    for (const adapter of registry.listAdapters()) {
      adapter.on('frame', (frame: GatewayFrame) => {
        this.emit('frame', frame);
      });
    }
  }

  tryParseReq(text: string): ReqFrame | null {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (
        parsed.type !== 'req' ||
        typeof parsed.method !== 'string' ||
        typeof parsed.id !== 'string'
      ) {
        return null;
      }
      return {
        type: 'req',
        id: parsed.id,
        method: parsed.method,
        params:
          typeof parsed.params === 'object' && parsed.params != null
            ? (parsed.params as Record<string, unknown>)
            : undefined,
      };
    } catch {
      return null;
    }
  }

  async dispatch(frame: ReqFrame): Promise<AdapterRpcResult> {
    if (AGGREGATION_METHODS.has(frame.method)) {
      if (frame.method === 'backends.health') {
        return this.handleBackendsHealth(frame);
      }
      return this.handleAgentsList(frame);
    }

    const agentId = this.extractAgentId(frame);
    if (agentId && parseAgentId(agentId)) {
      try {
        const adapter = this.registry.getAdapter(agentId);
        return await adapter.handleRpc(frame);
      } catch (error) {
        return this.error(frame.id, 'adapter_not_found', error);
      }
    }

    const sessionKey = this.extractSessionKey(frame);
    if (sessionKey) {
      const adapter = await this.registry.findAdapterForSession(sessionKey);
      if (adapter) {
        return adapter.handleRpc(frame);
      }
    }

    try {
      return await this.registry.getDefaultAdapter().handleRpc(frame);
    } catch (error) {
      return this.error(frame.id, 'adapter_not_found', error);
    }
  }

  private extractAgentId(frame: ReqFrame): string | null {
    if (!frame.params) return null;
    const id = frame.params.agentId ?? frame.params.agent_id;
    return typeof id === 'string' ? id : null;
  }

  private extractSessionKey(frame: ReqFrame): string | null {
    if (!frame.params) return null;
    const sessionKey = frame.params.sessionKey ?? frame.params.key;
    return typeof sessionKey === 'string' ? sessionKey : null;
  }

  private async handleAgentsList(frame: ReqFrame): Promise<ResFrame> {
    try {
      const agents = await this.registry.listAllAgents();
      const defaultId = agents[0]?.id ?? 'main';
      return {
        type: 'res',
        id: frame.id,
        ok: true,
        payload: {
          defaultId,
          mainKey: defaultId === 'main' ? 'main' : `agent:${defaultId}:main`,
          agents: agents.map(agent => toAgentListEntry(agent)),
        },
      };
    } catch (error) {
      return this.error(frame.id, 'agents_list_failed', error);
    }
  }

  private async handleBackendsHealth(frame: ReqFrame): Promise<ResFrame> {
    try {
      const backends = await this.registry.healthCheck();
      return {
        type: 'res',
        id: frame.id,
        ok: true,
        payload: { backends },
      };
    } catch (error) {
      return this.error(frame.id, 'backends_health_failed', error);
    }
  }

  private error(id: string, code: string, error: unknown): ResFrame {
    return {
      type: 'res',
      id,
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

function toAgentListEntry(agent: UnifiedAgent): {
  id: string;
  name: string;
  identity: { name: string; emoji?: string; avatarUrl?: string };
  backend: UnifiedAgent['backend'];
  model?: string;
  status: UnifiedAgent['status'];
  capabilities: UnifiedAgent['capabilities'];
} {
  return {
    id: agent.id,
    name: agent.name,
    identity: {
      name: agent.name,
      ...(agent.emoji ? { emoji: agent.emoji } : {}),
      ...(agent.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
    },
    backend: agent.backend,
    ...(agent.model ? { model: agent.model } : {}),
    status: agent.status,
    capabilities: agent.capabilities,
  };
}
