import type { ReqFrame, ResFrame } from './adapters/types.js';
import { parseAgentId } from './adapters/types.js';
import type { UnifiedAgentRegistry } from './registry.js';

/**
 * Methods that fan out to all adapters and merge results.
 * EMPTY in Phase 1 — agents.list passthroughs to OpenClaw until Phase 2+
 * when other adapters can self-enumerate agents.
 */
const AGGREGATION_METHODS = new Set<string>([
  // 'agents.list', — add in Phase 2 when Claude Code/Hermes adapters exist
]);

export class RpcDispatcher {
  constructor(private readonly registry: UnifiedAgentRegistry) {}

  /**
   * Attempt to parse a raw text message as a ReqFrame.
   * Returns null if the message is not a valid req frame (should be passed through).
   */
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

  /**
   * Dispatch a parsed ReqFrame to the correct adapter.
   * Returns a ResFrame to send back to mobile, or null if the message
   * should be passed through to the default gateway (backward compat).
   *
   * Null-passthrough contract:
   * - null from dispatch() -> runtime forwards message to OpenClaw gateway as-is
   * - null from adapter.handleRpc() -> same (adapter defers to gateway WS)
   * - ResFrame from adapter -> runtime sends it back to relay (mobile)
   */
  async dispatch(frame: ReqFrame): Promise<ResFrame | null> {
    // Aggregation: fan out to all adapters (empty in Phase 1)
    if (AGGREGATION_METHODS.has(frame.method)) {
      return this.handleAgentsList(frame);
    }

    // Agent-scoped: route by composite agentId (e.g., "claude-code:jade")
    const agentId = this.extractAgentId(frame);
    if (agentId && parseAgentId(agentId)) {
      try {
        const adapter = this.registry.getAdapter(agentId);
        return adapter.handleRpc(frame);
      } catch (error) {
        return {
          type: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: 'adapter_not_found',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    // No composite agentId: passthrough to default gateway
    return null;
  }

  private extractAgentId(frame: ReqFrame): string | null {
    if (!frame.params) return null;
    const id = frame.params.agentId ?? frame.params.agent_id;
    return typeof id === 'string' ? id : null;
  }

  private async handleAgentsList(frame: ReqFrame): Promise<ResFrame> {
    try {
      const agents = await this.registry.listAllAgents();
      return {
        type: 'res',
        id: frame.id,
        ok: true,
        data: { agents },
      };
    } catch (error) {
      return {
        type: 'res',
        id: frame.id,
        ok: false,
        error: {
          code: 'agents_list_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
