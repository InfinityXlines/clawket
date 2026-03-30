# Clawket Unified Multi-Backend Design

**Date:** 2026-03-30
**Author:** Jade | Opus 4.6 | Claude Code
**Status:** DRAFT — awaiting L'Mont approval
**Repo:** InfinityXlines/clawket (fork)

## Implementation Note — 2026-03-30

Phase 2 now has a working bridge-runtime implementation in `packages/bridge-runtime` and `apps/bridge-cli`.

- The bridge runtime now uses the mobile app's real response shape: `res.payload`, not `res.data`.
- `agents.list` is aggregated in the dispatcher instead of passthrough-only, with OpenClaw agents read from `~/.openclaw/openclaw.json`.
- OpenClaw passthrough rewrites composite IDs like `openclaw:simone` back to backend-local IDs before forwarding to the gateway.
- The Claude Code adapter is implemented with real `claude -p` / `claude -r` `stream-json` runs, agent discovery from `~/agents` plus `crew-ctl.sh status`, and chat history from `~/.claude/projects/.../*.jsonl`.
- Verified Claude-backed RPC coverage today: `agents.list`, `agent.identity.get`, `chat.send`, `chat.history`, and `chat.abort`.

Known Phase 2 deferrals:

- No aggregated `sessions.list` merge with live OpenClaw gateway sessions yet. Claude session listing exists in the adapter, but bridge-level session fan-out is still future work.
- Claude tool-event translation is still minimal compared with native OpenClaw events.
- The original session-pool / watchdog / LRU design was not implemented because the local Claude CLI already supports resumable one-shot runs via `session_id`; current code uses that simpler path first.

---

## Problem

Clawket is a mobile client for OpenClaw agents. L'Mont's fleet runs three distinct agent runtimes:

| Runtime | Agents | Model(s) | Gateway |
|---------|--------|----------|---------|
| OpenClaw | Simone, Katana, Mileena, Aria, Sentinel | MiniMax M2.7, GPT 5.4, Gemini 3.1 Pro | WebSocket on port 18789, JSON-RPC |
| Claude Code | Jade, Kira, Melody, Scout, Blitz, etc. | Opus 4.6, Sonnet 4.6, Haiku 4.5 | CLI/MCP stdio, no listening port |
| Hermes | Magdalena | MiniMax M2.7 | REST API on port 8642, OpenAI-compatible |

Today, Clawket only connects to OpenClaw. The goal: one app, all agents, seamless.

---

## Architecture: Multi-Backend Bridge

### Overview

The bridge runtime becomes a **backend aggregator**. It maintains connections to all configured backends and presents a single unified gateway to the mobile app.

```
Mobile App (iOS/Android)
    |
    | (one WebSocket connection)
    v
Unified Bridge Runtime (RPC Dispatch Layer)
    |
    +--- OpenClaw Adapter -----> ws://127.0.0.1:18789 (native JSON-RPC)
    |
    +--- Claude Code Adapter --> claude CLI / MCP stdio
    |
    +--- Hermes Adapter -------> http://127.0.0.1:8642 (REST API)
```

**Key principle:** The mobile app never knows which backend an agent runs on. It sees a flat list of agents and interacts with all of them through the same protocol.

### Critical Architecture Change: From Transparent Proxy to RPC Router

**Today's bridge runtime is a transparent WebSocket proxy.** It forwards raw messages between the relay (mobile) and the OpenClaw gateway without interpreting RPC method names. The only messages it inspects are relay control messages (`__clawket_relay_control__:` prefix), connect handshakes, and pairing-related responses.

**The multi-backend bridge must become an RPC-aware message router.** This is new infrastructure, not a refactor of existing code. The bridge must:

1. Parse every incoming message from the mobile app to extract the RPC method and agent ID
2. Route the message to the correct backend adapter based on the agent ID prefix
3. For aggregation methods (`agents.list`), fan out to all adapters and merge results
4. For passthrough methods (backend-specific RPCs with no agent ID), route to the default backend (OpenClaw for backward compatibility)
5. Translate responses from each adapter back into the Clawket gateway protocol before forwarding to mobile

**Unrecognized methods** without an agent ID prefix are forwarded to the OpenClaw adapter as-is, preserving backward compatibility with existing mobile app versions.

### What Changes vs. What Stays

| Component | Change Level | Details |
|-----------|-------------|---------|
| `packages/bridge-runtime` | **Major** | New RPC dispatch layer, `BackendAdapter` interface, three implementations, unified agent registry |
| `apps/bridge-cli` | **Medium** | Multi-backend config, `--backend` flag for setup, unified pairing |
| `packages/bridge-core` | **Minor** | Config schema adds backend entries |
| `apps/mobile` | **Major** | Audit and abstract all OpenClaw-specific references (12+ files beyond config screens), add backend-aware agent detail, unified agent list |
| `packages/relay-shared` | **None** | Already backend-agnostic |
| `apps/relay-*` | **None** | Already backend-agnostic |

---

## Component Design

### 1. BackendAdapter Interface

New file: `packages/bridge-runtime/src/adapters/types.ts`

```typescript
interface BackendAdapter extends EventEmitter {
  readonly type: 'openclaw' | 'claude-code' | 'hermes';
  readonly displayName: string;

  // Backend-level capabilities (things ALL agents on this backend can/cannot do)
  readonly backendCapabilities: AgentCapability[];

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isHealthy(): Promise<boolean>;

  // Agent discovery
  listAgents(): Promise<UnifiedAgent[]>;
  getAgentIdentity(agentId: string): Promise<AgentIdentity>;

  // Chat
  sendMessage(agentId: string, message: string, sessionId?: string): Promise<ChatStream>;

  // Session management
  listSessions(agentId: string): Promise<Session[]>;
  createSession(agentId: string): Promise<Session>;

  // Config (backend-specific, passed through as opaque JSON)
  getConfig(agentId: string): Promise<Record<string, unknown>>;
  patchConfig(agentId: string, patch: Record<string, unknown>): Promise<void>;

  // Events (pushed to registry without polling)
  on(event: 'agent-status-changed', listener: (agent: UnifiedAgent) => void): this;
  on(event: 'agent-discovered', listener: (agent: UnifiedAgent) => void): this;
  on(event: 'agent-removed', listener: (agentId: string) => void): this;
}

/**
 * ChatStream — the core streaming contract across all backends.
 * Wraps WebSocket streams (OpenClaw), CLI stdout pipes (Claude Code),
 * and SSE chunks (Hermes) into a uniform async interface.
 */
interface ChatStream extends AsyncIterable<ChatChunk> {
  /** Cancel the in-flight response */
  cancel(): void;

  /** Event-based API for consumers that prefer callbacks */
  on(event: 'chunk', listener: (chunk: ChatChunk) => void): this;
  on(event: 'done', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

interface ChatChunk {
  type: 'text' | 'tool-use' | 'tool-result' | 'thinking' | 'error';
  content: string;
  /** Monotonic index for ordering */
  index: number;
  /** Optional metadata (tool name, thinking label, etc.) */
  meta?: Record<string, unknown>;
}

interface UnifiedAgent {
  id: string;                    // Globally unique: `${backendType}:${localId}`
  localId: string;               // Backend-local ID
  backend: 'openclaw' | 'claude-code' | 'hermes';
  name: string;
  model?: string;
  emoji?: string;
  avatarUrl?: string;
  status: 'online' | 'offline' | 'busy';
  capabilities: AgentCapability[];
}

type AgentCapability =
  | 'chat'
  | 'file-management'
  | 'skill-management'
  | 'cron-scheduling'
  | 'config-editing'
  | 'session-history';
```

### 2. RPC Dispatch Layer

New file: `packages/bridge-runtime/src/dispatch.ts`

This is the new infrastructure that transforms the bridge from a transparent proxy into a multi-backend router.

```typescript
class RpcDispatcher {
  constructor(
    private registry: UnifiedAgentRegistry,
    private defaultBackend: 'openclaw'
  ) {}

  /**
   * Parse an incoming mobile RPC frame and route to the correct adapter.
   * Returns the response frame(s) to send back to mobile.
   */
  async dispatch(frame: ReqFrame): Promise<ResFrame | ResFrame[]> {
    const agentId = this.extractAgentId(frame);

    // Aggregation methods: fan out to all adapters
    if (frame.method === 'agents.list') {
      return this.fanOutAgentsList();
    }

    // Agent-scoped methods: route by agent ID prefix
    if (agentId) {
      const adapter = this.registry.getAdapter(agentId);
      return adapter.handleRpc(frame, agentId);
    }

    // Unrecognized methods without agent ID: forward to default backend
    return this.registry.getAdapter(this.defaultBackend)
      .handleRawRpc(frame);
  }

  private extractAgentId(frame: ReqFrame): string | null {
    return frame.params?.agentId ?? frame.params?.agent_id ?? null;
  }

  private async fanOutAgentsList(): Promise<ResFrame> {
    const allAgents = await this.registry.listAllAgents();
    return { type: 'res', ok: true, data: { agents: allAgents } };
  }
}
```

**Integration with BridgeRuntime:** The existing `onMessage` handler in `runtime.ts` currently pipes messages through. It will be updated to:
1. Attempt to parse the message as a `ReqFrame`
2. If parseable and contains a routable method → dispatch via `RpcDispatcher`
3. If not parseable or is a relay control message → handle as today (transparent passthrough to OpenClaw)

This preserves backward compatibility: messages the dispatcher doesn't recognize still flow to OpenClaw as before.

### 3. OpenClaw Adapter

File: `packages/bridge-runtime/src/adapters/openclaw-adapter.ts`

The existing `openclaw.ts` provides the discovery and connection logic. The adapter wraps it and adds:

- **RPC handling:** For agent-scoped RPCs, forward to the OpenClaw WebSocket with the original method/params (native protocol). For `handleRawRpc`, pipe through transparently.
- **Agent list:** Forward `agents.list` to OpenClaw gateway, prefix returned IDs with `openclaw:`
- **Chat:** Existing WebSocket proxy logic, wrapped in `ChatStream`
- **Capabilities:** All capabilities supported (chat, file-management, skill-management, cron-scheduling, config-editing, session-history)
- **Events:** Monitor OpenClaw WebSocket for agent status changes, emit to registry

### 4. Claude Code Adapter

File: `packages/bridge-runtime/src/adapters/claude-code-adapter.ts`

**The most complex adapter.** Claude Code has no listening gateway — it operates via CLI and MCP stdio.

**Strategy: Managed session pool with resource limits**

```
Claude Code Adapter
    |
    +--- Session Manager (max 3 concurrent, LRU eviction)
    |       |
    |       +--- Jade session (claude --agent jade ...)
    |       +--- Kira session (claude --agent kira ...)
    |       +--- (spawned on demand, recycled after idle timeout)
    |
    +--- Agent Discovery (both sources)
    |       |
    |       +--- ~/.claude/ config files → full agent roster (populates list with offline agents)
    |       +--- crew-ctl.sh status → running state (sets online/offline per agent)
    |
    +--- Process Watchdog
            |
            +--- 120s no-output timeout → force kill and respawn
            +--- Stdout/stderr buffer management for long responses
            +--- Startup health check: `claude --version` must succeed
```

**Agent discovery (resolved):** Use BOTH sources. Config files at `~/.claude/` provide the full roster of available agents. `crew-ctl.sh status` provides real-time running state. An agent in config but not running shows as `offline`. An agent that is running shows as `online`.

**Session pool constraints:**
- `maxConcurrentSessions`: 3 (configurable in backends.json)
- Idle timeout: 15 minutes (not 5 — users switch tabs)
- Eviction: LRU — least recently used session is killed when max is reached
- In-flight protection: sessions with active chat streams are never evicted
- On eviction: log a warning to the mobile app that the session was recycled, ephemeral context is lost

**Process lifecycle:**
- Spawn: `claude --agent {localId} --no-browser` on first message
- Watchdog: 120s with no stdout output → kill process, mark as crashed, respawn on next message
- Crash: Detect process exit code, log error, attempt respawn once. If second spawn fails within 30s, mark agent as `offline`
- Graceful shutdown: Send interrupt signal, wait 5s, then kill

**Startup health check:** On adapter `connect()`, run `claude --version`. If it fails (not installed, not on PATH, API key expired), mark entire backend as unavailable with a clear error message.

**Capabilities:** chat, session-history (via JSONL logs). File/skill management not exposed (CLI doesn't support it interactively).

### 5. Hermes Adapter

File: `packages/bridge-runtime/src/adapters/hermes-adapter.ts`

**Medium complexity.** Hermes exposes an OpenAI-compatible REST API.

- **Discovery:** Check `~/.hermes/.env` for `API_SERVER_ENABLED`, `API_SERVER_PORT`, `API_SERVER_KEY`
- **Connection:** HTTP client to `http://127.0.0.1:8642`
- **Health check:** `GET /health` endpoint
- **Agent list:** Hermes is single-agent (Magdalena). Return one agent. If Hermes adds multi-agent later, extend here.
- **Chat:** `POST /v1/chat/completions` with `stream: true`, translate SSE chunks → `ChatStream` chunks
- **Sessions:** Use `/v1/responses` API for stateful conversations (POST to create, GET to retrieve)
- **Retry:** On timeout, retry once with exponential backoff (1s → 2s). On second failure, return error to mobile.
- **Capabilities:** chat, session-history. Config editing via Hermes CLI wrapper.

**Auto-enable:** If Hermes API server isn't enabled, the adapter logs a setup instruction and marks itself as unavailable (not an error — just not configured).

### 6. Unified Agent Registry

File: `packages/bridge-runtime/src/registry.ts`

The registry aggregates agents from all adapters and handles routing.

```typescript
class UnifiedAgentRegistry {
  private adapters: Map<string, BackendAdapter>;
  private agentCache: Map<string, { agent: UnifiedAgent; adapter: BackendAdapter }>;

  // Aggregate all agents from all backends (parallel health checks)
  async listAllAgents(): Promise<UnifiedAgent[]>;

  // Route a request to the correct adapter by parsing agent ID prefix
  getAdapter(agentId: string): BackendAdapter;

  // Health monitoring — parallel checks, mark backends as degraded independently
  async healthCheck(): Promise<BackendHealth[]>;

  // Listen to adapter events, propagate to mobile via bridge
  private setupEventForwarding(adapter: BackendAdapter): void;
}
```

**Agent ID format:** `openclaw:simone`, `claude-code:jade`, `hermes:magdalena`

The mobile app receives these composite IDs but only displays the agent name. The backend prefix is used internally for routing.

### 7. Bridge Configuration

File: `packages/bridge-core/src/config.ts`

New config schema at `~/.clawket/backends.json`:

```json
{
  "backends": [
    {
      "type": "openclaw",
      "enabled": true,
      "configPath": "~/.openclaw/openclaw.json"
    },
    {
      "type": "claude-code",
      "enabled": true,
      "agentsDir": "~/.claude/",
      "crewCtl": "~/.claude/crew-ctl.sh",
      "maxConcurrentSessions": 3,
      "sessionIdleTimeoutMs": 900000
    },
    {
      "type": "hermes",
      "enabled": true,
      "envPath": "~/.hermes/.env",
      "apiPort": 8642
    }
  ]
}
```

**No credentials stored here.** Each adapter reads credentials from its backend's native credential store:
- OpenClaw: token from `~/.openclaw/openclaw.json`
- Claude Code: API key from environment / `~/.claude/` config
- Hermes: API key from `~/.hermes/.env`

`backends.json` contains only connection metadata (paths, ports, enabled flags). File permissions 0600.

Bridge CLI auto-detects installed backends on first run and generates this config.

### 8. Mobile App Changes

#### OpenClaw Abstraction Audit

OpenClaw references exist in 12+ files beyond the three config screens. Phase 4 must audit and abstract ALL of these:

- `ConfigScreen/OpenClawConfigScreen.tsx` — OpenClaw-specific config
- `ConfigScreen/OpenClawPermissionsScreen.tsx` — OpenClaw-specific permissions
- `ConfigScreen/OpenClawDiagnosticsScreen.tsx` — OpenClaw-specific diagnostics
- `ConfigTab.tsx` — references OpenClaw config navigation
- `GatewayToolsScreen.tsx` — OpenClaw tool management
- Deep link handlers — OpenClaw-specific URL schemes
- Analytics events — OpenClaw-specific event names
- `gateway.ts` line 1021 — hardcoded `~/.openclaw/workspace-${agentId}` path
- Various imports and type references across screens

All of these must be abstracted behind a backend-type conditional or removed.

#### Agent List (unified)

`apps/mobile/src/screens/ConsoleScreen/AgentListScreen.tsx`

- Shows all agents from all backends in one flat list
- Each agent shows: emoji/avatar, name, model badge, backend indicator (subtle icon)
- Grouped by backend OR flat alphabetical (user preference)
- Status indicator: online/offline/busy per agent

#### Agent Detail

`apps/mobile/src/screens/ConsoleScreen/AgentDetailScreen.tsx`

- Shows agent identity, model, backend type
- Config editing adapts to backend capabilities (hide sections the backend doesn't support)
- Actions available based on `capabilities` array
- Backend-level capabilities hide entire UI sections (e.g., Claude Code never shows cron scheduling)

#### Config Screens

- Replace OpenClaw-specific screens with `BackendConfigScreen.tsx` that renders config based on backend type
- Add `BackendStatusScreen.tsx` showing health of all three backends
- Conditionally render backend-specific fields

#### Chat

- Chat screen unchanged — it already uses generic gateway protocol
- Agent picker in chat uses the unified agent list
- Backend is transparent to the user

---

## Data Flow: Sending a Message to Jade

```
1. User taps Jade in agent list (id: "claude-code:jade")
2. Mobile sends: { type: "req", method: "chat.send", params: { agentId: "claude-code:jade", message: "..." } }
3. Bridge RPC Dispatcher parses frame, extracts agentId
4. Dispatcher routes to UnifiedAgentRegistry.getAdapter("claude-code:jade")
5. Registry extracts backend="claude-code", returns ClaudeCodeAdapter
6. Adapter receives request with localId="jade"
7. Session Manager checks pool — spawns `claude --agent jade --no-browser` if needed
8. Adapter pipes message to stdin, creates ChatStream from stdout
9. ChatStream chunks flow back: Adapter → Dispatcher → Bridge WS → Relay → Mobile
10. User sees Jade's response streaming in real-time
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Backend offline | Agent shows as "offline" in list, tap shows "Backend unavailable" with setup instructions |
| Backend comes online | Health check detects it (30s interval), agents appear in list |
| Session crash (Claude Code) | Watchdog detects, respawns on next message, warns user context was lost |
| Process hang (Claude Code) | 120s no-output watchdog → force kill → respawn |
| `claude` not installed | Startup health check fails, entire Claude Code backend marked unavailable |
| Hermes API timeout | Retry once (1s backoff), then return error to mobile |
| Mixed backend health | Each backend independent — OpenClaw down doesn't affect Claude Code |
| Session evicted (Claude Code) | LRU eviction when at max concurrent, user warned ephemeral context lost |

---

## Security

- Each backend adapter reads credentials from its backend's native credential store — never from `backends.json`
- `backends.json` stores only connection metadata (paths, ports, flags) with 0600 permissions
- Mobile app auth unchanged — pairing + relay token
- No credentials transmitted to mobile app — bridge handles all backend auth locally
- Claude Code sessions inherit the host user's permissions (same as running `claude` directly)

---

## Testing Strategy

| Layer | Approach |
|-------|----------|
| RPC Dispatcher | Unit tests — routing logic, aggregation, fallback to default backend |
| Adapters | Unit tests with mocked backends — verify protocol translation, ChatStream contract |
| Registry | Integration tests — verify routing, aggregation, health checks, event forwarding |
| Session Pool (Claude Code) | Unit tests — spawn, eviction, watchdog, crash recovery |
| Bridge Runtime | E2E tests — mobile protocol compliance with multi-backend |
| Mobile | Snapshot tests for new screens, interaction tests for agent switching |

---

## Implementation Phases

### Phase 1a: RPC Dispatch Infrastructure (Jade/Kira)
- Build `RpcDispatcher` class with method parsing, agent ID extraction, routing
- Build `ChatStream` type and base implementation
- Build `BackendAdapter` interface and `UnifiedAgentRegistry`
- **Verify:** Dispatcher correctly parses and routes mock RPC frames

### Phase 1b: OpenClaw Adapter + Migration (Jade/Kira)
- Refactor existing `openclaw.ts` into `OpenClawAdapter` implementing `BackendAdapter`
- Wire `BridgeRuntime` to use `RpcDispatcher` instead of transparent proxy
- Backward compatibility: unrecognized RPCs still flow to OpenClaw
- **Verify:** Existing mobile app works identically through new architecture (regression-free)

### Phase 2: Claude Code Adapter (Katana)
- Implement `ClaudeCodeAdapter` with session pool, watchdog, LRU eviction
- Agent discovery from `~/.claude/` config + `crew-ctl.sh status`
- CLI process management, stdin/stdout streaming → `ChatStream`
- Startup health check
- **Verify:** Can list Jade crew agents and chat with them from mobile

### Phase 3: Hermes Adapter (Jade/Kira + Magdalena input)
- Implement `HermesAdapter` with REST client
- OpenAI SSE → `ChatStream` translation
- Session management via `/v1/responses` API
- **Verify:** Can chat with Magdalena from mobile

### Phase 4: Mobile UI Updates (Mileena)
- Full OpenClaw abstraction audit (12+ files)
- Unified agent list with backend indicators
- Backend-aware config screens using `backendCapabilities`
- `BackendStatusScreen` showing health of all three backends
- Remove all hardcoded OpenClaw references
- **Verify:** Seamless UX across all backends, no OpenClaw assumptions in UI

### Phase 5: Polish & Integration (All)
- Auto-detection of installed backends on first run
- Graceful degradation when backends are offline
- Performance optimization (parallel health checks, connection pooling)
- Documentation and setup guide

---

## Agent Assignments

| Agent | Model | Phase | Role |
|-------|-------|-------|------|
| **Jade** | Opus 4.6 | All | Architecture lead, Phase 1a/1b + 3 implementation, all code review |
| **Katana** | GPT 5.4 | Phase 2 | Claude Code adapter — production code, process management |
| **Mileena** | Gemini 3.1 Pro | Phase 4 | Mobile UI/UX design and implementation, OpenClaw abstraction audit |
| **Magdalena** | MiniMax M2.7 | Phase 3 | Hermes integration input, API validation, capability review |
| **Simone** | MiniMax M2.7 | All | Coordination, state tracking, CI/CD |

---

## Resolved Questions

1. **Claude Code agent discovery:** Use BOTH sources. Config files for the full roster (populates list with offline agents), `crew-ctl.sh status` for real-time running state (sets online/offline).
2. **Hermes multi-agent:** Design for one agent now (Magdalena). Adapter returns a single-element list. If Hermes adds multi-agent later, extend the adapter — no architectural changes needed.
3. **Cross-backend agent communication:** Deferred to Phase 5+. The unified chat already enables it implicitly (user can message any agent), but explicit "ask Agent X" routing is future scope.
