# Phase 1: RPC Dispatch Infrastructure + OpenClaw Adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the bridge from a transparent WebSocket proxy into an RPC-aware multi-backend router, with OpenClaw as the first adapter — without breaking existing functionality.

**Architecture:** New `RpcDispatcher` intercepts messages between relay and gateway. Messages containing a routable agent ID go to the matching `BackendAdapter`. Unrecognized messages pass through to OpenClaw as today. The `UnifiedAgentRegistry` aggregates agents from all adapters.

**Tech Stack:** TypeScript, vitest, ws (WebSocket), Node.js EventEmitter

**Spec:** `docs/superpowers/specs/2026-03-30-unified-multi-backend-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `packages/bridge-runtime/src/adapters/types.ts` | BackendAdapter interface, ChatStream, ChatChunk, UnifiedAgent, AgentCapability types |
| `packages/bridge-runtime/src/adapters/openclaw-adapter.ts` | OpenClaw BackendAdapter implementation — wraps existing openclaw.ts |
| `packages/bridge-runtime/src/adapters/openclaw-adapter.test.ts` | Unit tests for OpenClaw adapter |
| `packages/bridge-runtime/src/adapters/index.ts` | Barrel export for adapters |
| `packages/bridge-runtime/src/__test-utils__/mock-adapter.ts` | Shared mock adapter factory for tests |
| `packages/bridge-runtime/src/registry.ts` | UnifiedAgentRegistry — aggregates agents, routes by ID prefix |
| `packages/bridge-runtime/src/registry.test.ts` | Unit tests for registry |
| `packages/bridge-runtime/src/dispatch.ts` | RpcDispatcher — parses RPC frames, routes to adapters via registry |
| `packages/bridge-runtime/src/dispatch.test.ts` | Unit tests for dispatcher |

### Modified Files
| File | Changes |
|------|---------|
| `packages/bridge-runtime/src/runtime.ts` | Import dispatcher, intercept relay messages before forwarding to gateway |
| `packages/bridge-runtime/src/runtime.test.ts` | Add tests for dispatcher integration |
| `packages/bridge-runtime/src/index.ts` | Export new modules |

### Unchanged Files
| File | Reason |
|------|--------|
| `packages/bridge-runtime/src/openclaw.ts` | Kept as-is — adapter wraps it, doesn't replace it |
| `packages/bridge-runtime/src/protocol.ts` | Already generic enough |

---

### Task 1: Define Core Types

**Files:**
- Create: `packages/bridge-runtime/src/adapters/types.ts`
- Create: `packages/bridge-runtime/src/adapters/index.ts`

- [ ] **Step 1: Create the adapter types file**

```typescript
// packages/bridge-runtime/src/adapters/types.ts
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
   * "passthrough to the default gateway WebSocket." The null-passthrough
   * contract is how the OpenClaw adapter defers to BridgeRuntime's
   * existing WS proxy for methods it cannot handle directly.
   */
  handleRpc(frame: ReqFrame): Promise<ResFrame | null>;
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
```

- [ ] **Step 2: Create the barrel export**

```typescript
// packages/bridge-runtime/src/adapters/index.ts
export * from './types.js';
```

- [ ] **Step 3: Verify types compile**

Run: `cd ~/Development/clawket && npm run --workspace @clawket/bridge-runtime typecheck`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
cd ~/Development/clawket
git add packages/bridge-runtime/src/adapters/
git commit -m "feat(bridge): add BackendAdapter interface and core types"
```

---

### Task 2: Build the Unified Agent Registry

**Files:**
- Create: `packages/bridge-runtime/src/registry.test.ts`
- Create: `packages/bridge-runtime/src/registry.ts`

- [ ] **Step 0: Create shared test utility**

```typescript
// packages/bridge-runtime/src/__test-utils__/mock-adapter.ts
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { BackendAdapter, UnifiedAgent } from '../adapters/types.js';

export function createMockAdapter(
  type: 'openclaw' | 'claude-code' | 'hermes',
  agents: UnifiedAgent[] = [],
  healthy = true,
): BackendAdapter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type,
    displayName: type,
    backendCapabilities: ['chat' as const],
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(healthy),
    listAgents: vi.fn().mockResolvedValue(agents),
    getAgentIdentity: vi.fn().mockResolvedValue({ name: 'test' }),
    sendMessage: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({}),
    patchConfig: vi.fn().mockResolvedValue(undefined),
    handleRpc: vi.fn().mockResolvedValue({ type: 'res', id: '1', ok: true, data: { routed: true } }),
  }) as unknown as BackendAdapter;
}
```

- [ ] **Step 1: Write failing tests for the registry**

```typescript
// packages/bridge-runtime/src/registry.test.ts
import { describe, expect, it } from 'vitest';
import { UnifiedAgentRegistry } from './registry.js';
import { createMockAdapter } from './__test-utils__/mock-adapter.js';
import type { UnifiedAgent } from './adapters/types.js';

const agentSimone: UnifiedAgent = {
  id: 'openclaw:simone',
  localId: 'simone',
  backend: 'openclaw',
  name: 'Simone',
  model: 'minimax-m2.7',
  status: 'online',
  capabilities: ['chat'],
};

const agentJade: UnifiedAgent = {
  id: 'claude-code:jade',
  localId: 'jade',
  backend: 'claude-code',
  name: 'Jade',
  model: 'opus-4.6',
  status: 'online',
  capabilities: ['chat'],
};

describe('UnifiedAgentRegistry', () => {
  it('aggregates agents from all adapters', async () => {
    const oc = createMockAdapter('openclaw', [agentSimone]);
    const cc = createMockAdapter('claude-code', [agentJade]);
    const registry = new UnifiedAgentRegistry([oc, cc]);
    const agents = await registry.listAllAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.id)).toContain('openclaw:simone');
    expect(agents.map(a => a.id)).toContain('claude-code:jade');
  });

  it('routes to correct adapter by agent ID', () => {
    const oc = createMockAdapter('openclaw', [agentSimone]);
    const cc = createMockAdapter('claude-code', [agentJade]);
    const registry = new UnifiedAgentRegistry([oc, cc]);
    expect(registry.getAdapter('openclaw:simone')).toBe(oc);
    expect(registry.getAdapter('claude-code:jade')).toBe(cc);
  });

  it('throws for unknown agent ID prefix', () => {
    const oc = createMockAdapter('openclaw', [agentSimone]);
    const registry = new UnifiedAgentRegistry([oc]);
    expect(() => registry.getAdapter('unknown:foo')).toThrow();
  });

  it('returns default adapter for unrecognized IDs without colon', () => {
    const oc = createMockAdapter('openclaw', [agentSimone]);
    const registry = new UnifiedAgentRegistry([oc]);
    expect(registry.getDefaultAdapter()).toBe(oc);
  });

  it('runs parallel health checks', async () => {
    const oc = createMockAdapter('openclaw', [agentSimone], true);
    const cc = createMockAdapter('claude-code', [], false);
    const registry = new UnifiedAgentRegistry([oc, cc]);
    const health = await registry.healthCheck();
    expect(health).toHaveLength(2);
    expect(health.find(h => h.backend === 'openclaw')?.healthy).toBe(true);
    expect(health.find(h => h.backend === 'claude-code')?.healthy).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Development/clawket && npx vitest run packages/bridge-runtime/src/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the registry**

```typescript
// packages/bridge-runtime/src/registry.ts
import type { BackendAdapter, BackendHealth, BackendType, UnifiedAgent } from './adapters/types.js';
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Development/clawket && npx vitest run packages/bridge-runtime/src/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/Development/clawket
git add packages/bridge-runtime/src/registry.ts packages/bridge-runtime/src/registry.test.ts
git commit -m "feat(bridge): add UnifiedAgentRegistry with routing and health checks"
```

---

### Task 3: Build the RPC Dispatcher

**Files:**
- Create: `packages/bridge-runtime/src/dispatch.test.ts`
- Create: `packages/bridge-runtime/src/dispatch.ts`

- [ ] **Step 1: Write failing tests for the dispatcher**

```typescript
// packages/bridge-runtime/src/dispatch.test.ts
import { describe, expect, it, vi } from 'vitest';
import { RpcDispatcher } from './dispatch.js';
import { UnifiedAgentRegistry } from './registry.js';
import { createMockAdapter } from './__test-utils__/mock-adapter.js';

describe('RpcDispatcher', () => {
  it('returns null for non-JSON messages', () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    expect(dispatcher.tryParseReq('not json')).toBeNull();
  });

  it('returns null for messages without type=req', () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    expect(dispatcher.tryParseReq(JSON.stringify({ type: 'res', id: '1', ok: true }))).toBeNull();
  });

  it('parses valid req frames and preserves id', () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const frame = dispatcher.tryParseReq(JSON.stringify({
      type: 'req',
      id: 'abc-123',
      method: 'chat.send',
      params: { agentId: 'openclaw:simone' },
    }));
    expect(frame).toEqual({
      type: 'req',
      id: 'abc-123',
      method: 'chat.send',
      params: { agentId: 'openclaw:simone' },
    });
  });

  it('passthroughs agents.list in Phase 1 (returns null)', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '1', method: 'agents.list',
    });
    // Phase 1: agents.list is NOT in AGGREGATION_METHODS, so it passthroughs
    expect(result).toBeNull();
  });

  it('routes agent-scoped RPCs to correct adapter by composite agentId', async () => {
    const oc = createMockAdapter('openclaw');
    const cc = createMockAdapter('claude-code');
    const registry = new UnifiedAgentRegistry([oc, cc]);
    const dispatcher = new RpcDispatcher(registry);
    await dispatcher.dispatch({
      type: 'req', id: '2', method: 'chat.send',
      params: { agentId: 'claude-code:jade', message: 'hello' },
    });
    expect(cc.handleRpc).toHaveBeenCalled();
    expect(oc.handleRpc).not.toHaveBeenCalled();
  });

  it('returns null for RPCs without agentId (passthrough to gateway)', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '3', method: 'some.unroutable.method',
    });
    expect(result).toBeNull();
  });

  it('returns error ResFrame when adapter not found for agentId', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '4', method: 'chat.send',
      params: { agentId: 'hermes:magdalena', message: 'hello' },
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.id).toBe('4');
    expect(result!.error?.code).toBe('adapter_not_found');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Development/clawket && npx vitest run packages/bridge-runtime/src/dispatch.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the dispatcher**

```typescript
// packages/bridge-runtime/src/dispatch.ts
import type { ReqFrame, ResFrame } from './adapters/types.js';
import { parseAgentId } from './adapters/types.js';
import type { UnifiedAgentRegistry } from './registry.js';

/**
 * Methods that fan out to all adapters and merge results.
 * EMPTY in Phase 1 — agents.list passthroughs to OpenClaw until Phase 2+
 * when other adapters can self-enumerate agents. Adding agents.list here
 * in Phase 1 would return an empty array since OpenClawAdapter.listAgents()
 * cannot query the gateway WS it does not own.
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
      if (parsed.type !== 'req' || typeof parsed.method !== 'string' || typeof parsed.id !== 'string') {
        return null;
      }
      return {
        type: 'req',
        id: parsed.id,
        method: parsed.method,
        params: typeof parsed.params === 'object' && parsed.params != null
          ? parsed.params as Record<string, unknown>
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
   * - null from dispatch() → runtime forwards message to OpenClaw gateway as-is
   * - null from adapter.handleRpc() → same (adapter defers to gateway WS)
   * - ResFrame from adapter → runtime sends it back to relay (mobile)
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
        // adapter.handleRpc returns null for passthrough (OpenClaw) or ResFrame (other adapters)
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

  /**
   * Fan out agents.list to all adapters and merge results.
   * Not used in Phase 1 — added when Phase 2+ adapters can self-enumerate.
   */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Development/clawket && npx vitest run packages/bridge-runtime/src/dispatch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/Development/clawket
git add packages/bridge-runtime/src/dispatch.ts packages/bridge-runtime/src/dispatch.test.ts
git commit -m "feat(bridge): add RpcDispatcher for multi-backend message routing"
```

---

### Task 4: Implement OpenClaw Adapter

**Files:**
- Create: `packages/bridge-runtime/src/adapters/openclaw-adapter.test.ts`
- Create: `packages/bridge-runtime/src/adapters/openclaw-adapter.ts`
- Modify: `packages/bridge-runtime/src/adapters/index.ts`

- [ ] **Step 1: Write failing tests for OpenClaw adapter**

```typescript
// packages/bridge-runtime/src/adapters/openclaw-adapter.test.ts
import { describe, expect, it, vi } from 'vitest';
import { OpenClawAdapter } from './openclaw-adapter.js';
import type { ReqFrame } from './types.js';

// Mock the openclaw module
vi.mock('../openclaw.js', () => ({
  readOpenClawInfo: vi.fn().mockReturnValue({
    configFound: true,
    gatewayPort: 18789,
    authMode: 'token',
    token: 'test-token',
    password: null,
  }),
  resolveGatewayUrl: vi.fn().mockReturnValue('ws://127.0.0.1:18789'),
}));

describe('OpenClawAdapter', () => {
  it('has type openclaw', () => {
    const adapter = new OpenClawAdapter();
    expect(adapter.type).toBe('openclaw');
  });

  it('has full capabilities', () => {
    const adapter = new OpenClawAdapter();
    expect(adapter.backendCapabilities).toContain('chat');
    expect(adapter.backendCapabilities).toContain('file-management');
    expect(adapter.backendCapabilities).toContain('cron-scheduling');
  });

  it('reports healthy when OpenClaw config is found', async () => {
    const adapter = new OpenClawAdapter();
    const healthy = await adapter.isHealthy();
    expect(healthy).toBe(true);
  });

  it('handleRpc returns null (null-passthrough contract)', async () => {
    const adapter = new OpenClawAdapter();
    const frame: ReqFrame = {
      type: 'req',
      id: '1',
      method: 'chat.send',
      params: { agentId: 'openclaw:simone', message: 'hello' },
    };
    // OpenClaw adapter returns null — signals "forward to gateway WS as-is"
    const result = await adapter.handleRpc(frame);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Development/clawket && npx vitest run packages/bridge-runtime/src/adapters/openclaw-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the OpenClaw adapter**

```typescript
// packages/bridge-runtime/src/adapters/openclaw-adapter.ts
import { EventEmitter } from 'node:events';
import { readOpenClawInfo, resolveGatewayUrl } from '../openclaw.js';
import type {
  AgentCapability,
  AgentIdentity,
  BackendAdapter,
  ChatStream,
  ReqFrame,
  ResFrame,
  Session,
  UnifiedAgent,
} from './types.js';
import { buildAgentId } from './types.js';

/**
 * OpenClaw adapter.
 *
 * Unlike other adapters, OpenClaw messages are forwarded through the existing
 * gateway WebSocket in BridgeRuntime. This adapter handles:
 * - Health checks (does OpenClaw config exist?)
 * - Agent listing (placeholder — real list comes from gateway)
 * - RPC passthrough (returns null to signal "forward to gateway WS as-is")
 *
 * The bridge runtime maintains the actual WebSocket to OpenClaw gateway.
 * This adapter is the metadata/routing layer, not the transport layer.
 */
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
    // OpenClaw gateway connection is managed by BridgeRuntime, not this adapter
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
    // OpenClaw agent enumeration happens via the gateway WebSocket RPC.
    // This adapter cannot call it directly because the WS is owned by BridgeRuntime.
    // Return empty — the runtime will merge OpenClaw's native agents.list response
    // with adapters that can self-enumerate (Claude Code, Hermes).
    //
    // TODO(phase-2+): When BridgeRuntime is fully refactored, this adapter
    // can hold its own WS connection and enumerate agents directly.
    return [];
  }

  async getAgentIdentity(localId: string): Promise<AgentIdentity> {
    return { name: localId };
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

  async getConfig(): Promise<Record<string, unknown>> {
    return {};
  }

  async patchConfig(): Promise<void> {
    // Handled via gateway passthrough
  }

  /**
   * OpenClaw RPCs are forwarded through the existing gateway WS.
   * Return null to signal the bridge runtime to passthrough.
   * This is the explicit null-passthrough contract: null means
   * "I cannot handle this, forward to the gateway WebSocket as-is."
   */
  async handleRpc(_frame: ReqFrame): Promise<ResFrame | null> {
    return null;
  }

  getGatewayUrl(): string {
    return resolveGatewayUrl();
  }
}
```

- [ ] **Step 4: Update barrel export**

```typescript
// packages/bridge-runtime/src/adapters/index.ts
export * from './types.js';
export * from './openclaw-adapter.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Development/clawket && npx vitest run packages/bridge-runtime/src/adapters/openclaw-adapter.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd ~/Development/clawket
git add packages/bridge-runtime/src/adapters/
git commit -m "feat(bridge): add OpenClawAdapter wrapping existing gateway integration"
```

---

### Task 5: Wire Dispatcher Into Bridge Runtime

**Files:**
- Modify: `packages/bridge-runtime/src/runtime.ts`
- Modify: `packages/bridge-runtime/src/runtime.test.ts`
- Modify: `packages/bridge-runtime/src/index.ts`

This is the critical integration task. The bridge must intercept messages via the dispatcher while preserving 100% backward compatibility for existing mobile clients.

- [ ] **Step 1: Add dispatcher integration tests using FakeSocket**

Add to `packages/bridge-runtime/src/runtime.test.ts` (after existing test blocks):

```typescript
import { RpcDispatcher } from './dispatch.js';
import { UnifiedAgentRegistry } from './registry.js';
import { OpenClawAdapter } from './adapters/openclaw-adapter.js';
import { createMockAdapter } from './__test-utils__/mock-adapter.js';

describe('BridgeRuntime with RpcDispatcher', () => {
  it('passes unrecognized RPCs through to gateway socket unchanged', async () => {
    // Set up: create runtime with dispatcher, connect relay + gateway via FakeSockets
    const adapter = new OpenClawAdapter();
    const registry = new UnifiedAgentRegistry([adapter]);
    const dispatcher = new RpcDispatcher(registry);

    const sockets: FakeSocket[] = [];
    const runtime = new BridgeRuntime({
      config: stubConfig(),
      gatewayUrl: 'ws://127.0.0.1:18789',
      dispatcher,
      createWebSocket: (url, opts) => {
        const s = new FakeSocket(url, opts);
        sockets.push(s);
        return s;
      },
    });
    runtime.start();
    const relaySock = sockets[0]!;
    relaySock.readyState = 1; // OPEN
    relaySock.emit('open');

    // Simulate a connect handshake from mobile (no agentId, not aggregation)
    const connectMsg = JSON.stringify({
      type: 'req', id: '1', method: 'connect',
      params: { nonce: 'abc', auth: { token: 'test' } },
    });
    relaySock.emit('message', Buffer.from(connectMsg), false);

    // Gateway should receive it (passthrough)
    await delay(50);
    const gatewaySock = sockets[1];
    // If gateway not yet connected, message is queued — verify it was NOT
    // intercepted by the dispatcher (no response on relay socket)
    const relayResponses = relaySock.sent.filter(
      s => typeof s === 'string' && s.includes('"type":"res"'),
    );
    expect(relayResponses).toHaveLength(0); // No dispatcher response — passthrough

    await runtime.stop();
  });

  it('routes agent-scoped RPC via dispatcher and sends response to relay', async () => {
    // Create a mock claude-code adapter that returns a real ResFrame
    const ccAdapter = createMockAdapter('claude-code');
    (ccAdapter.handleRpc as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: 'res', id: 'test-42', ok: true, data: { answer: 'hello from jade' },
    });
    const ocAdapter = new OpenClawAdapter();
    const registry = new UnifiedAgentRegistry([ocAdapter, ccAdapter]);
    const dispatcher = new RpcDispatcher(registry);

    const sockets: FakeSocket[] = [];
    const runtime = new BridgeRuntime({
      config: stubConfig(),
      gatewayUrl: 'ws://127.0.0.1:18789',
      dispatcher,
      createWebSocket: (url, opts) => {
        const s = new FakeSocket(url, opts);
        sockets.push(s);
        return s;
      },
    });
    runtime.start();
    const relaySock = sockets[0]!;
    relaySock.readyState = 1;
    relaySock.emit('open');

    // Send an agent-scoped RPC with composite agentId
    const rpcMsg = JSON.stringify({
      type: 'req', id: 'test-42', method: 'chat.send',
      params: { agentId: 'claude-code:jade', message: 'hey' },
    });
    relaySock.emit('message', Buffer.from(rpcMsg), false);
    await delay(50);

    // Response should appear on relay socket (sent back to mobile)
    const responses = relaySock.sent.filter(
      s => typeof s === 'string' && s.includes('test-42'),
    );
    expect(responses).toHaveLength(1);
    const parsed = JSON.parse(responses[0] as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.answer).toBe('hello from jade');

    await runtime.stop();
  });
});
```

Note: `stubConfig()` should return a minimal `PairingConfig`. Check the existing test file for its pattern and reuse.

- [ ] **Step 2: Run test to verify they pass** (uses existing FakeSocket infrastructure)

Run: `cd ~/Development/clawket && npx vitest run packages/bridge-runtime/src/runtime.test.ts`
Expected: New tests PASS, existing tests still PASS

- [ ] **Step 3: Modify runtime.ts — add optional dispatcher**

In `packages/bridge-runtime/src/runtime.ts`, add the dispatcher as an optional dependency that intercepts messages when present.

Add to `BridgeRuntimeOptions` type (around line 63):

```typescript
import type { RpcDispatcher } from './dispatch.js';

// Add to BridgeRuntimeOptions:
  dispatcher?: RpcDispatcher;
```

Modify `handleRelayMessage` (around line 255) to try dispatcher first:

```typescript
  private async handleRelayMessage(data: RawData, isBinary: boolean): Promise<void> {
    this.lastRelayActivityMs = Date.now();
    if (isBinary) {
      this.forwardOrQueueGatewayMessage({ kind: 'binary', data: normalizeBinary(data) });
      return;
    }
    const text = normalizeText(data);
    if (text == null) return;
    const control = parseControl(text);
    if (control) {
      await this.handleRelayControl(control);
      return;
    }

    // NEW: Try dispatcher for routable RPC frames
    if (this.options.dispatcher) {
      const frame = this.options.dispatcher.tryParseReq(text);
      if (frame) {
        const result = await this.options.dispatcher.dispatch(frame);
        if (result !== null) {
          // Dispatcher handled it — send response back to relay
          this.sendToRelay(JSON.stringify(result));
          return;
        }
        // result === null means passthrough to gateway
      }
    }

    const identity = parseConnectStartIdentity(text);
    if (identity) {
      this.observeConnectStart(identity.id, identity.label);
    }
    this.forwardOrQueueGatewayMessage({ kind: 'text', text });
  }
```

Add a `sendToRelay` helper (near `sendToGateway`):

```typescript
  private sendToRelay(text: string): void {
    const relay = this.relaySocket;
    if (!relay || relay.readyState !== WebSocket.OPEN) return;
    relay.send(text);
  }
```

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `cd ~/Development/clawket && npm run bridge:test`
Expected: ALL tests PASS

- [ ] **Step 5: Update index.ts exports**

```typescript
// packages/bridge-runtime/src/index.ts
export * from './adapters/index.js';
export * from './dispatch.js';
export * from './openclaw.js';
export * from './protocol.js';
export * from './registry.js';
export * from './runtime.js';
```

- [ ] **Step 6: Verify full typecheck passes**

Run: `cd ~/Development/clawket && npm run bridge:typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd ~/Development/clawket
git add packages/bridge-runtime/src/
git commit -m "feat(bridge): wire RpcDispatcher into BridgeRuntime with backward-compatible passthrough"
```

---

### Task 6: Update Bridge CLI to Initialize Dispatcher

**Files:**
- Modify: `apps/bridge-cli/src/index.ts` (only the runtime initialization path)

- [ ] **Step 1: Read the current bridge-cli initialization**

Read `apps/bridge-cli/src/index.ts` to find where `BridgeRuntime` is constructed with its options. The dispatcher is opt-in (passed via `BridgeRuntimeOptions.dispatcher`), so existing behavior is preserved when omitted.

- [ ] **Step 2: Add dispatcher initialization where BridgeRuntime is created**

Find the `BridgeRuntime` constructor call and add:

```typescript
import { RpcDispatcher, UnifiedAgentRegistry, OpenClawAdapter } from '@clawket/bridge-runtime';

// Before creating BridgeRuntime:
const openclawAdapter = new OpenClawAdapter();
const registry = new UnifiedAgentRegistry([openclawAdapter]);
const dispatcher = new RpcDispatcher(registry);

// Add to BridgeRuntime options:
const runtime = new BridgeRuntime({
  ...existingOptions,
  dispatcher,
});
```

- [ ] **Step 3: Run bridge tests**

Run: `cd ~/Development/clawket && npm run bridge:test`
Expected: ALL tests PASS

- [ ] **Step 4: Run full project typecheck**

Run: `cd ~/Development/clawket && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/Development/clawket
git add apps/bridge-cli/src/
git commit -m "feat(bridge-cli): initialize RpcDispatcher with OpenClawAdapter on startup"
```

---

### Task 7: End-to-End Verification

- [ ] **Step 1: Run the full test suite**

Run: `cd ~/Development/clawket && npm run test`
Expected: ALL tests PASS

- [ ] **Step 2: Run full typecheck**

Run: `cd ~/Development/clawket && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Manual smoke test** (if OpenClaw is running locally)

```bash
cd ~/Development/clawket
npm run bridge:build
npm run bridge:status
```

Verify bridge still connects to OpenClaw and mobile app can still chat with agents.

- [ ] **Step 4: Final commit with any cleanup**

```bash
cd ~/Development/clawket
git add -A
git commit -m "chore(bridge): Phase 1 complete — RPC dispatch infrastructure with OpenClaw adapter"
```

---

## Summary

After completing all 7 tasks, the bridge runtime:

1. Has a clean `BackendAdapter` interface that Claude Code and Hermes adapters will implement
2. Has a `UnifiedAgentRegistry` that aggregates agents from multiple backends
3. Has an `RpcDispatcher` that routes messages to the correct adapter
4. Still works exactly as before for existing mobile clients (backward compatible)
5. Is ready for Phase 2 (Katana: Claude Code adapter) and Phase 3 (Jade: Hermes adapter)
