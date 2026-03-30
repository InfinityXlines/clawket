import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, type } from 'node:os';
import { join } from 'node:path';
import type {
  AgentCapability,
  AgentIdentity,
  AdapterRpcResult,
  BackendAdapter,
  ChatStream,
  ChatChunk,
  EventFrame,
  ReqFrame,
  ResFrame,
  Session,
  UnifiedAgent,
} from './types.js';
import { buildAgentId } from './types.js';

type HermesConfig = {
  apiPort?: number;
  apiKey?: string;
  baseUrl?: string;
};

const DEFAULT_PORT = 8642;
const LOCAL_AGENT_ID = 'magdalena';

export class HermesAdapter extends EventEmitter implements BackendAdapter {
  readonly type = 'hermes' as const;
  readonly displayName = 'Hermes';
  readonly backendCapabilities: AgentCapability[] = ['chat', 'session-history'];

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private healthError: string | null = null;

  constructor(config: HermesConfig = {}, fetchImpl?: typeof fetch) {
    super();
    const home = homedir();
    const envPath = join(home, '.hermes', '.env');
    const port = config.apiPort ?? DEFAULT_PORT;

    // Allow override for testing
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.baseUrl = config.baseUrl ?? `http://127.0.0.1:${port}`;

    // Read API key from .env if not provided
    if (config.apiKey) {
      this.apiKey = config.apiKey;
    } else if (existsSync(envPath)) {
      this.apiKey = readHermesApiKey(envPath);
    } else {
      this.apiKey = null;
    }
  }

  async connect(): Promise<void> {
    await this.isHealthy();
  }

  async disconnect(): Promise<void> {
    // No persistent connections to maintain
  }

  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.healthError = null;
      return response.ok;
    } catch (error) {
      this.healthError =
        error instanceof Error ? error.message : 'Hermes health check failed';
      return false;
    }
  }

  async listAgents(): Promise<UnifiedAgent[]> {
    const healthy = await this.isHealthy();
    if (!healthy) return [];

    // Hermes is single-agent (Magdalena)
    return [
      {
        id: buildAgentId('hermes', LOCAL_AGENT_ID),
        localId: LOCAL_AGENT_ID,
        backend: 'hermes',
        name: 'Magdalena',
        status: 'online',
        capabilities: ['chat', 'session-history'],
      },
    ];
  }

  async getAgentIdentity(_localId: string): Promise<AgentIdentity> {
    return { name: 'Magdalena' };
  }

  async sendMessage(): Promise<ChatStream> {
    // Hermes chat is routed through handleRpc(chat.send)
    throw new Error('Hermes chat is routed through handleRpc(chat.send)');
  }

  async listSessions(_localId: string): Promise<Session[]> {
    // Hermes uses a flat response history; sessions are represented as response IDs
    try {
      const responses = await this.listResponses(20);
      return responses.map((r) => ({
        id: r.id,
        agentId: buildAgentId('hermes', LOCAL_AGENT_ID),
        createdAtMs: r.created_at,
        lastActiveMs: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  async createSession(_localId: string): Promise<Session> {
    const now = Date.now();
    return {
      id: `hermes:${LOCAL_AGENT_ID}:${now}`,
      agentId: buildAgentId('hermes', LOCAL_AGENT_ID),
      createdAtMs: now,
      lastActiveMs: now,
    };
  }

  async canHandleSession(sessionKey: string): Promise<boolean> {
    return sessionKey.startsWith('agent:hermes:') || sessionKey.startsWith('hermes:');
  }

  async getConfig(_localId: string): Promise<Record<string, unknown>> {
    return {
      baseUrl: this.baseUrl,
      configured: this.apiKey != null,
    };
  }

  async patchConfig(): Promise<void> {
    throw new Error('Hermes config is managed via the hermes CLI');
  }

  async handleRpc(frame: ReqFrame): Promise<AdapterRpcResult> {
    switch (frame.method) {
      case 'agent.identity.get':
        return this.handleAgentIdentity(frame);
      case 'chat.send':
        return this.handleChatSend(frame);
      case 'chat.history':
        return this.handleChatHistory(frame);
      case 'chat.abort':
        return this.handleChatAbort(frame);
      case 'sessions.list':
        return this.handleSessionsList(frame);
      default:
        return this.error(
          frame.id,
          'unsupported_method',
          `Hermes does not support ${frame.method}`,
        );
    }
  }

  // ── RPC handlers ──────────────────────────────────────────────────────────

  private async handleAgentIdentity(frame: ReqFrame): Promise<ResFrame> {
    const identity = await this.getAgentIdentity(LOCAL_AGENT_ID);
    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: identity,
    };
  }

  private async handleChatSend(frame: ReqFrame): Promise<ResFrame> {
    const sessionKey =
      typeof frame.params?.sessionKey === 'string'
        ? frame.params.sessionKey
        : null;
    const message =
      typeof frame.params?.message === 'string' ? frame.params.message : null;

    if (!sessionKey || !message) {
      return this.error(
        frame.id,
        'invalid_request',
        'chat.send requires sessionKey and message',
      );
    }

    const runId =
      typeof frame.params?.idempotencyKey === 'string' &&
      frame.params.idempotencyKey.trim()
        ? frame.params.idempotencyKey
        : `hermes-run-${Date.now()}`;

    // Fire-and-forget streaming chat; respond immediately with runId
    // Stream events are emitted via the 'frame' event emitter
    this.startStreamingChat(sessionKey, message, runId).catch((err) => {
      this.emitFrame({
        type: 'event',
        event: 'chat',
        payload: {
          runId,
          sessionKey,
          state: 'error',
          errorMessage: err.message,
        },
      });
    });

    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: { runId },
    };
  }

  private async handleChatHistory(frame: ReqFrame): Promise<ResFrame> {
    const sessionKey =
      typeof frame.params?.sessionKey === 'string'
        ? frame.params.sessionKey
        : null;
    const limit =
      typeof frame.params?.limit === 'number' && Number.isFinite(frame.params.limit)
        ? Math.max(1, frame.params.limit)
        : 50;

    if (!sessionKey) {
      return this.error(
        frame.id,
        'invalid_request',
        'chat.history requires sessionKey',
      );
    }

    try {
      const responses = await this.listResponses(limit);
      const messages: Array<{ role: string; content: unknown }> = [];

      for (const response of responses) {
        // Extract user message from the response's model messages
        if (response.model_messages) {
          for (const msg of response.model_messages as Array<{ role: string; content: unknown }>) {
            if (msg.role === 'user' || msg.role === 'assistant') {
              messages.push({ role: msg.role, content: msg.content });
            }
          }
        }
        // Also include the text output
        if (response.output?.text) {
          messages.push({ role: 'assistant', content: response.output.text });
        }
      }

      return {
        type: 'res',
        id: frame.id,
        ok: true,
        payload: { messages },
      };
    } catch (err) {
      return this.error(
        frame.id,
        'history_failed',
        err instanceof Error ? err.message : 'Failed to fetch chat history',
      );
    }
  }

  private async handleChatAbort(frame: ReqFrame): Promise<ResFrame> {
    // Hermes uses stateless chat completions — abort is a no-op
    // The streaming fetch is already in flight; we signal intent here
    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: { ok: true },
    };
  }

  private async handleSessionsList(frame: ReqFrame): Promise<ResFrame> {
    const agentId =
      typeof frame.params?.agentId === 'string'
        ? frame.params.agentId
        : null;

    const sessions = await this.listSessions(agentId ?? LOCAL_AGENT_ID);

    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: {
        sessions: sessions.map((s) => ({
          key: s.id,
          sessionId: s.id,
          kind: 'direct',
          label: 'Main session',
          title: 'Magdalena main session',
          displayName: 'Magdalena',
          updatedAt: s.lastActiveMs,
        })),
      },
    };
  }

  // ── Streaming chat ────────────────────────────────────────────────────────

  private async startStreamingChat(
    sessionKey: string,
    message: string,
    runId: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const body = {
      model: 'magdalena',
      messages: [{ role: 'user', content: message }],
      stream: true,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Hermes chat error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('Hermes returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let index = 0;
    let buffer = '';

    this.emitFrame({
      type: 'event',
      event: 'agent',
      payload: {
        runId,
        sessionKey,
        stream: 'lifecycle',
        data: { phase: 'start' },
      },
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') {
            this.emitFrame({
              type: 'event',
              event: 'chat',
              payload: {
                runId,
                sessionKey,
                state: 'final',
                message: { role: 'assistant', content: '' },
              },
            });
            this.emitFrame({
              type: 'event',
              event: 'agent',
              payload: {
                runId,
                sessionKey,
                stream: 'lifecycle',
                data: { phase: 'done' },
              },
            });
            return;
          }

          const parsed = tryParseJson(data);
          if (!parsed) continue;

          // OpenAI-compatible SSE shape
          const chunk = extractSseChunk(parsed);
          if (chunk) {
            this.emitFrame({
              type: 'event',
              event: 'chat',
              payload: {
                runId,
                sessionKey,
                state: 'delta',
                message: { role: 'assistant', content: chunk },
                index,
              },
            });
            index++;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async listResponses(
    limit: number,
  ): Promise<Array<{ id: string; created_at: number; model_messages?: unknown; output?: { text?: string } }>> {
    const url = `${this.baseUrl}/v1/responses?limit=${encodeURIComponent(String(limit))}`;
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(url, { method: 'GET', headers });
    if (!response.ok) return [];

    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        created_at?: number;
        model_messages?: unknown;
        output?: { text?: string };
      }>;
    };

    return (data.data ?? []).map((r) => ({
      id: r.id,
      created_at: r.created_at ?? Date.now(),
      model_messages: r.model_messages,
      output: r.output,
    }));
  }

  private emitFrame(frame: EventFrame): void {
    this.emit('frame', frame);
  }

  private error(id: string, code: string, message: string): ResFrame {
    return {
      type: 'res',
      id,
      ok: false,
      error: { code, message },
    };
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function readHermesApiKey(envPath: string): string | null {
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
      if (key === 'API_SERVER_KEY' && value) return value;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed != null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractSseChunk(parsed: Record<string, unknown>): string | null {
  // OpenAI chat completions chunk shape
  const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
  if (choices && choices.length > 0) {
    const delta = choices[0]?.delta;
    if (typeof delta?.content === 'string') return delta.content;
  }
  return null;
}
