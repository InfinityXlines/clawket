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

  listAdapters(): BackendAdapter[] {
    return [...this.adaptersByType.values()];
  }

  async findAdapterForSession(sessionKey: string): Promise<BackendAdapter | null> {
    for (const adapter of this.adaptersByType.values()) {
      if (await adapter.canHandleSession(sessionKey)) {
        return adapter;
      }
    }
    return null;
  }

  async healthCheck(): Promise<BackendHealth[]> {
    const checks = [...this.adaptersByType.entries()].map(async ([type, adapter]) => {
      const startedAt = Date.now();
      try {
        const healthy = await adapter.isHealthy();
        const checkedAtMs = Date.now();
        const agents = healthy ? await adapter.listAgents() : [];
        return {
          backend: type,
          displayName: adapter.displayName,
          ok: healthy,
          healthy,
          latencyMs: Math.max(0, checkedAtMs - startedAt),
          checkedAtMs,
          agentCount: agents.length,
        };
      } catch (error) {
        const checkedAtMs = Date.now();
        return {
          backend: type,
          displayName: adapter.displayName,
          ok: false,
          healthy: false,
          latencyMs: Math.max(0, checkedAtMs - startedAt),
          checkedAtMs,
          agentCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    return Promise.all(checks);
  }
}
