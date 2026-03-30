import type {
  BackendAdapter,
  BackendHealth,
  BackendType,
  UnifiedAgent,
} from './adapters/types.js';
import { parseAgentId } from './adapters/types.js';

export class UnifiedAgentRegistry {
  private readonly adaptersByType: Map<BackendType, BackendAdapter>;
  private readonly defaultBackendType: BackendType;

  constructor(adapters: BackendAdapter[], defaultBackend: BackendType = 'openclaw') {
    this.adaptersByType = new Map();
    for (const adapter of adapters) {
      this.adaptersByType.set(adapter.type, adapter);
    }
    this.defaultBackendType = defaultBackend;
  }

  async listAllAgents(): Promise<UnifiedAgent[]> {
    const results = await Promise.allSettled(
      [...this.adaptersByType.values()].map(a => a.listAgents()),
    );
    const agents: UnifiedAgent[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        agents.push(...result.value);
      }
    }
    return agents;
  }

  getAdapter(compositeAgentId: string): BackendAdapter {
    const parsed = parseAgentId(compositeAgentId);
    if (!parsed) {
      throw new Error(`Invalid agent ID format: ${compositeAgentId}`);
    }
    const adapter = this.adaptersByType.get(parsed.backend);
    if (!adapter) {
      throw new Error(`No adapter registered for backend: ${parsed.backend}`);
    }
    return adapter;
  }

  getDefaultAdapter(): BackendAdapter {
    const adapter = this.adaptersByType.get(this.defaultBackendType);
    if (!adapter) {
      throw new Error(`Default adapter not found: ${this.defaultBackendType}`);
    }
    return adapter;
  }

  getAdapterByType(type: BackendType): BackendAdapter | undefined {
    return this.adaptersByType.get(type);
  }

  async healthCheck(): Promise<BackendHealth[]> {
    const checks = [...this.adaptersByType.entries()].map(async ([type, adapter]) => {
      try {
        const healthy = await adapter.isHealthy();
        const agents = healthy ? await adapter.listAgents() : [];
        return { backend: type, healthy, agentCount: agents.length };
      } catch (error) {
        return {
          backend: type,
          healthy: false,
          agentCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    return Promise.all(checks);
  }
}
