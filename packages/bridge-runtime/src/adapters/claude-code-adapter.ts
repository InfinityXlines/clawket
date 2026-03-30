import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AgentCapability,
  AgentIdentity,
  AdapterRpcResult,
  BackendAdapter,
  ChatStream,
  EventFrame,
  ReqFrame,
  ResFrame,
  Session,
  UnifiedAgent,
} from './types.js';
import { buildAgentId, parseAgentId } from './types.js';

type ExecFileLike = typeof execFile;
type SpawnLike = typeof spawn;

type ClaudeCodeAdapterOptions = {
  claudeCommand?: string;
  crewCtlPath?: string;
  claudeHome?: string;
  agentsDir?: string;
  execFileImpl?: ExecFileLike;
  spawnImpl?: SpawnLike;
  now?: () => number;
};

type CrewStatus = {
  tmux?: string;
  claude?: string;
};

type PersistedClaudeSession = {
  sessionId: string;
  cwd: string;
  startedAtMs: number;
};

type ClaudeSessionState = {
  sessionKey: string;
  agentId: string;
  localId: string;
  cwd: string;
  createdAtMs: number;
  lastActiveMs: number;
  sessionId?: string;
  activeRun?: {
    runId: string;
    child: ChildProcessWithoutNullStreams | ReturnType<typeof spawn>;
    abortRequested: boolean;
    killTimer?: NodeJS.Timeout;
  };
};

type CrewMetadata = {
  name?: string;
  model?: string;
};

export class ClaudeCodeAdapter extends EventEmitter implements BackendAdapter {
  readonly type = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly backendCapabilities: AgentCapability[] = ['chat', 'session-history'];

  private readonly claudeCommand: string;
  private readonly crewCtlPath: string;
  private readonly claudeHome: string;
  private readonly agentsDir: string;
  private readonly execFileImpl: ExecFileLike;
  private readonly spawnImpl: SpawnLike;
  private readonly now: () => number;
  private readonly sessions = new Map<string, ClaudeSessionState>();
  private healthError: string | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    super();
    const home = homedir();
    this.claudeCommand = options.claudeCommand ?? 'claude';
    this.claudeHome = options.claudeHome ?? join(home, '.claude');
    this.crewCtlPath = options.crewCtlPath ?? join(this.claudeHome, 'crew-ctl.sh');
    this.agentsDir = options.agentsDir ?? join(home, 'agents');
    this.execFileImpl = options.execFileImpl ?? execFile;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.now = options.now ?? Date.now;
  }

  async connect(): Promise<void> {
    await this.isHealthy();
  }

  async disconnect(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.activeRun) {
        stopClaudeRun(session.activeRun);
      }
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await execFilePromise(this.execFileImpl, this.claudeCommand, ['--version']);
      this.healthError = null;
      return true;
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async listAgents(): Promise<UnifiedAgent[]> {
    const metadata = this.readCrewMetadata();
    const status = await this.readCrewStatus();
    const localIds = new Set<string>([
      ...readAgentDirectoryIds(this.agentsDir),
      ...metadata.keys(),
      ...status.keys(),
    ]);

    return [...localIds]
      .filter((localId) => localId.trim().length > 0)
      .sort((a, b) => a.localeCompare(b))
      .map((localId) => {
        const crewMeta = metadata.get(localId);
        const identity = this.readLocalIdentity(localId);
        return {
          id: buildAgentId('claude-code', localId),
          localId,
          backend: 'claude-code',
          name: crewMeta?.name ?? identity.name ?? titleCase(localId),
          ...(crewMeta?.model ? { model: crewMeta.model } : {}),
          ...(identity.emoji ? { emoji: identity.emoji } : {}),
          ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
          status: resolveClaudeStatus(status.get(localId)),
          capabilities: ['chat', 'session-history'],
        } satisfies UnifiedAgent;
      });
  }

  async getAgentIdentity(localId: string): Promise<AgentIdentity> {
    const agent = (await this.listAgents()).find((entry) => entry.localId === localId);
    return {
      name: agent?.name ?? titleCase(localId),
      ...(agent?.emoji ? { emoji: agent.emoji } : {}),
      ...(agent?.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
    };
  }

  async sendMessage(): Promise<ChatStream> {
    throw new Error('Claude Code chat is routed through handleRpc(chat.send)');
  }

  async listSessions(localId: string): Promise<Session[]> {
    const sessionKey = buildClaudeMainSessionKey(localId);
    const state = await this.ensureSession(sessionKey, localId);
    return state.sessionId
      ? [
        {
          id: state.sessionKey,
          agentId: state.agentId,
          createdAtMs: state.createdAtMs,
          lastActiveMs: state.lastActiveMs,
        },
      ]
      : [];
  }

  async createSession(localId: string): Promise<Session> {
    const state = await this.ensureSession(buildClaudeMainSessionKey(localId), localId);
    return {
      id: state.sessionKey,
      agentId: state.agentId,
      createdAtMs: state.createdAtMs,
      lastActiveMs: state.lastActiveMs,
    };
  }

  async canHandleSession(sessionKey: string): Promise<boolean> {
    return sessionKey.startsWith('agent:claude-code:');
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return this.healthError ? { error: this.healthError } : {};
  }

  async patchConfig(): Promise<void> {
    throw new Error('Claude Code config is managed outside bridge-runtime');
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
        return this.error(frame.id, 'unsupported_method', `Claude Code does not support ${frame.method}`);
    }
  }

  private async handleAgentIdentity(frame: ReqFrame): Promise<ResFrame> {
    const compositeId = frame.params?.agentId;
    if (typeof compositeId !== 'string') {
      return this.error(frame.id, 'invalid_request', 'agentId is required');
    }
    const parsed = parseAgentId(compositeId);
    if (!parsed || parsed.backend !== 'claude-code') {
      return this.error(frame.id, 'invalid_request', 'agentId must target the Claude Code backend');
    }
    const identity = await this.getAgentIdentity(parsed.localId);
    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: {
        name: identity.name,
        ...(identity.emoji ? { emoji: identity.emoji } : {}),
        ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
      },
    };
  }

  private async handleChatSend(frame: ReqFrame): Promise<ResFrame> {
    const sessionKey = typeof frame.params?.sessionKey === 'string' ? frame.params.sessionKey : null;
    const message = typeof frame.params?.message === 'string' ? frame.params.message : null;
    if (!sessionKey || !message) {
      return this.error(frame.id, 'invalid_request', 'chat.send requires sessionKey and message');
    }

    const localId = await this.resolveLocalIdForSessionKey(sessionKey);
    if (!localId) {
      return this.error(frame.id, 'adapter_not_found', `No Claude Code agent matched session ${sessionKey}`);
    }

    const session = await this.ensureSession(sessionKey, localId);
    if (session.activeRun) {
      return this.error(frame.id, 'chat_already_running', `A Claude run is already active for ${sessionKey}`);
    }

    const runId = typeof frame.params?.idempotencyKey === 'string' && frame.params.idempotencyKey.trim()
      ? frame.params.idempotencyKey
      : `claude-run-${randomUUID()}`;
    this.startRun(session, message, runId);

    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: { runId },
    };
  }

  private async handleChatHistory(frame: ReqFrame): Promise<ResFrame> {
    const sessionKey = typeof frame.params?.sessionKey === 'string' ? frame.params.sessionKey : null;
    const limit = typeof frame.params?.limit === 'number' && Number.isFinite(frame.params.limit)
      ? Math.max(1, frame.params.limit)
      : 50;
    if (!sessionKey) {
      return this.error(frame.id, 'invalid_request', 'chat.history requires sessionKey');
    }

    const localId = await this.resolveLocalIdForSessionKey(sessionKey);
    if (!localId) {
      return this.error(frame.id, 'adapter_not_found', `No Claude Code agent matched session ${sessionKey}`);
    }

    const session = await this.ensureSession(sessionKey, localId);
    const messages = this.readHistoryMessages(session, limit);
    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: {
        messages,
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      },
    };
  }

  private async handleChatAbort(frame: ReqFrame): Promise<ResFrame> {
    const sessionKey = typeof frame.params?.sessionKey === 'string' ? frame.params.sessionKey : null;
    if (!sessionKey) {
      return this.error(frame.id, 'invalid_request', 'chat.abort requires sessionKey');
    }

    const session = this.sessions.get(sessionKey);
    if (!session?.activeRun) {
      return {
        type: 'res',
        id: frame.id,
        ok: true,
        payload: { ok: true },
      };
    }

    session.activeRun.abortRequested = true;
    session.activeRun.child.kill('SIGINT');
    session.activeRun.killTimer = setTimeout(() => {
      session.activeRun?.child.kill('SIGKILL');
    }, 5_000);

    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: { ok: true },
    };
  }

  private async handleSessionsList(frame: ReqFrame): Promise<ResFrame> {
    const agentId = typeof frame.params?.agentId === 'string' ? frame.params.agentId : null;
    const agents = agentId
      ? [agentId]
      : (await this.listAgents()).map((agent) => agent.id);
    const sessions = [];
    for (const compositeId of agents) {
      const parsed = parseAgentId(compositeId);
      if (!parsed || parsed.backend !== 'claude-code') continue;
      const state = await this.ensureSession(buildClaudeMainSessionKey(parsed.localId), parsed.localId);
      if (!state.sessionId) continue;
      const identity = await this.getAgentIdentity(parsed.localId);
      sessions.push({
        key: state.sessionKey,
        sessionId: state.sessionId,
        kind: 'direct',
        label: 'Main session',
        title: `${identity.name ?? titleCase(parsed.localId)} main session`,
        displayName: identity.name ?? titleCase(parsed.localId),
        updatedAt: state.lastActiveMs,
      });
    }
    return {
      type: 'res',
      id: frame.id,
      ok: true,
      payload: { sessions },
    };
  }

  private async ensureSession(sessionKey: string, localId: string): Promise<ClaudeSessionState> {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastActiveMs = this.now();
      return existing;
    }

    const cwd = resolveAgentWorkspace(this.agentsDir, localId);
    const persisted = this.findLatestPersistedSession(cwd);
    const state: ClaudeSessionState = {
      sessionKey,
      agentId: buildAgentId('claude-code', localId),
      localId,
      cwd,
      createdAtMs: persisted?.startedAtMs ?? this.now(),
      lastActiveMs: this.now(),
      ...(persisted?.sessionId ? { sessionId: persisted.sessionId } : {}),
    };
    this.sessions.set(sessionKey, state);
    return state;
  }

  private async resolveLocalIdForSessionKey(sessionKey: string): Promise<string | null> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing.localId;

    const agents = await this.listAgents();
    const matched = agents.find((agent) => sessionKey.startsWith(`agent:${agent.id}:`));
    return matched?.localId ?? null;
  }

  private startRun(session: ClaudeSessionState, message: string, runId: string): void {
    const args = [
      '-p',
      message,
      '--agent',
      session.localId,
      '--verbose',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
    ];
    if (session.sessionId) {
      args.push('-r', session.sessionId);
    }

    const child = this.spawnImpl(this.claudeCommand, args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run = {
      runId,
      child,
      abortRequested: false,
    };
    session.activeRun = run;
    session.lastActiveMs = this.now();

    this.emitFrame({
      type: 'event',
      event: 'agent',
      payload: {
        runId,
        sessionKey: session.sessionKey,
        stream: 'lifecycle',
        data: { phase: 'start' },
      },
    });

    let stderr = '';
    let finalSent = false;
    let lastAssistantMessage: unknown;
    let finalUsage: Record<string, number> | undefined;

    const stdout = child.stdout;
    if (!stdout) {
      this.emitRunError(session, runId, 'Claude stdout was not available');
      return;
    }
    const lines = createInterface({ input: stdout });
    lines.on('line', (line) => {
      const parsed = tryParseJson(line);
      if (!parsed) return;

      const discoveredSessionId = readString(parsed.session_id) ?? readString(parsed.sessionId);
      if (discoveredSessionId) {
        session.sessionId = discoveredSessionId;
      }

      if (parsed.type === 'stream_event') {
        const event = isRecord(parsed.event) ? parsed.event : null;
        const eventType = readString(event?.type);
        if (eventType === 'content_block_delta') {
          const delta = isRecord(event?.delta) ? event.delta : null;
          if (readString(delta?.type) === 'text_delta') {
            const text = readString(delta?.text);
            if (text) {
              this.emitFrame({
                type: 'event',
                event: 'chat',
                payload: {
                  runId,
                  sessionKey: session.sessionKey,
                  state: 'delta',
                  message: { role: 'assistant', content: text },
                },
              });
            }
          }
        }
        return;
      }

      if (parsed.type === 'assistant') {
        lastAssistantMessage = normalizeAssistantMessage(parsed.message);
        return;
      }

      if (parsed.type === 'result') {
        finalSent = true;
        finalUsage = normalizeUsage(isRecord(parsed.usage) ? parsed.usage : undefined);
        const finalMessage = lastAssistantMessage ?? {
          role: 'assistant',
          content: readString(parsed.result) ?? '',
        };
        this.emitFrame({
          type: 'event',
          event: 'chat',
          payload: {
            runId,
            sessionKey: session.sessionKey,
            state: 'final',
            message: finalMessage,
            ...(finalUsage ? { usage: finalUsage } : {}),
          },
        });
        this.clearActiveRun(session, runId);
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.once('error', (error: Error) => {
      if (finalSent) return;
      finalSent = true;
      this.emitRunError(session, runId, error.message);
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      lines.close();
      if (finalSent) return;
      finalSent = true;
      if (run.abortRequested || signal === 'SIGINT') {
        this.emitFrame({
          type: 'event',
          event: 'chat',
          payload: {
            runId,
            sessionKey: session.sessionKey,
            state: 'aborted',
          },
        });
        this.clearActiveRun(session, runId);
        return;
      }

      const reason = stderr.trim() || `Claude exited with code ${code ?? 'unknown'}`;
      this.emitRunError(session, runId, reason);
    });
  }

  private emitRunError(session: ClaudeSessionState, runId: string, message: string): void {
    this.emitFrame({
      type: 'event',
      event: 'chat',
      payload: {
        runId,
        sessionKey: session.sessionKey,
        state: 'error',
        errorMessage: message,
      },
    });
    this.clearActiveRun(session, runId);
  }

  private clearActiveRun(session: ClaudeSessionState, runId: string): void {
    if (!session.activeRun || session.activeRun.runId !== runId) return;
    if (session.activeRun.killTimer) {
      clearTimeout(session.activeRun.killTimer);
    }
    session.activeRun = undefined;
    session.lastActiveMs = this.now();
  }

  private readCrewMetadata(): Map<string, CrewMetadata> {
    const metadata = new Map<string, CrewMetadata>();
    const globalClaudePath = join(this.claudeHome, 'CLAUDE.md');
    if (!existsSync(globalClaudePath)) return metadata;
    const content = readFileSync(globalClaudePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.startsWith('|')) continue;
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length < 4) continue;
      const [name, command, model] = cells;
      const normalizedCommand = command.replace(/`/g, '').trim();
      if (!normalizedCommand.startsWith('/')) continue;
      const localId = normalizedCommand.slice(1).trim().toLowerCase();
      if (!localId) continue;
      metadata.set(localId, {
        name,
        ...(model ? { model } : {}),
      });
    }
    return metadata;
  }

  private async readCrewStatus(): Promise<Map<string, CrewStatus>> {
    const status = new Map<string, CrewStatus>();
    if (!existsSync(this.crewCtlPath)) return status;

    try {
      const output = await execFilePromise(this.execFileImpl, 'bash', [this.crewCtlPath, 'status']);
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('AGENT') || trimmed.startsWith('-----')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) continue;
        status.set(parts[0].toLowerCase(), { tmux: parts[1], claude: parts[2] });
      }
    } catch {
      return status;
    }

    return status;
  }

  private readLocalIdentity(localId: string): AgentIdentity {
    const claudePath = join(resolveAgentWorkspace(this.agentsDir, localId), 'CLAUDE.md');
    if (!existsSync(claudePath)) {
      return { name: titleCase(localId) };
    }
    const content = readFileSync(claudePath, 'utf8');
    const match = content.match(/You are \*\*([^*]+)\*\*/);
    return { name: match?.[1]?.trim() || titleCase(localId) };
  }

  private findLatestPersistedSession(cwd: string): PersistedClaudeSession | null {
    const sessionsDir = join(this.claudeHome, 'sessions');
    if (!existsSync(sessionsDir)) return null;

    let latest: PersistedClaudeSession | null = null;
    for (const entry of readdirSync(sessionsDir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(sessionsDir, entry);
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
          sessionId?: unknown;
          cwd?: unknown;
          startedAt?: unknown;
        };
        if (parsed.cwd !== cwd || typeof parsed.sessionId !== 'string') continue;
        const startedAtMs = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0;
        if (!latest || startedAtMs > latest.startedAtMs) {
          latest = {
            sessionId: parsed.sessionId,
            cwd,
            startedAtMs,
          };
        }
      } catch {
        // Ignore malformed session files.
      }
    }
    return latest;
  }

  private readHistoryMessages(session: ClaudeSessionState, limit: number): Array<{ role: string; content: unknown }> {
    if (!session.sessionId) return [];
    const historyPath = join(
      this.claudeHome,
      'projects',
      encodeClaudeProjectDir(session.cwd),
      `${session.sessionId}.jsonl`,
    );
    if (!existsSync(historyPath)) return [];

    const seen = new Map<string, { order: number; role: string; content: unknown }>();
    let order = 0;
    const lines = readFileSync(historyPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = tryParseJson(line);
      if (!parsed) continue;
      const parsedSessionId = readString(parsed.sessionId);
      if (parsedSessionId && parsedSessionId !== session.sessionId) continue;

      if (parsed.type === 'user' && isRecord(parsed.message)) {
        const key = `user:${readString(parsed.uuid) ?? order}`;
        if (!seen.has(key)) {
          seen.set(key, {
            order: order += 1,
            role: 'user',
            content: normalizeHistoryContent(parsed.message.content),
          });
        }
        continue;
      }

      if (parsed.type === 'assistant' && isRecord(parsed.message)) {
        const key = `assistant:${readString(parsed.message.id) ?? readString(parsed.requestId) ?? readString(parsed.uuid) ?? order}`;
        const previous = seen.get(key);
        seen.set(key, {
          order: previous?.order ?? (order += 1),
          role: 'assistant',
          content: normalizeHistoryContent(parsed.message.content),
        });
      }
    }

    return [...seen.values()]
      .sort((a, b) => a.order - b.order)
      .slice(-limit)
      .map((entry) => ({ role: entry.role, content: entry.content }));
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

function readAgentDirectoryIds(agentsDir: string): string[] {
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name.toLowerCase());
}

function resolveClaudeStatus(status: CrewStatus | undefined): UnifiedAgent['status'] {
  const tmux = status?.tmux?.toUpperCase();
  const claude = status?.claude?.toUpperCase();
  if (claude === 'STARTING') return 'busy';
  if (tmux === 'UP' || claude === 'RUNNING') return 'online';
  return 'offline';
}

function buildClaudeMainSessionKey(localId: string): string {
  return `agent:${buildAgentId('claude-code', localId)}:main`;
}

function resolveAgentWorkspace(agentsDir: string, localId: string): string {
  return join(agentsDir, localId);
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replaceAll('/', '-');
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

function normalizeAssistantMessage(message: unknown): { role: 'assistant'; content: unknown } | undefined {
  if (!isRecord(message)) return undefined;
  if (readString(message.role) !== 'assistant') return undefined;
  return {
    role: 'assistant',
    content: normalizeHistoryContent(message.content),
  };
}

function normalizeHistoryContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content;
  return typeof content === 'undefined' ? '' : content;
}

function normalizeUsage(usage: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const input = readNumber(usage.input_tokens);
  const output = readNumber(usage.output_tokens);
  const cacheRead = readNumber(usage.cache_read_input_tokens);
  const cacheWrite = readNumber(usage.cache_creation_input_tokens);
  if ([input, output, cacheRead, cacheWrite].every((value) => value == null)) {
    return undefined;
  }
  const total = [input, output, cacheRead, cacheWrite].reduce<number>(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  return {
    ...(input != null ? { input } : {}),
    ...(output != null ? { output } : {}),
    ...(cacheRead != null ? { cacheRead } : {}),
    ...(cacheWrite != null ? { cacheWrite } : {}),
    total,
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function execFilePromise(execFileImpl: ExecFileLike, command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

function stopClaudeRun(run: ClaudeSessionState['activeRun']): void {
  if (!run) return;
  run.child.kill('SIGINT');
  if (run.killTimer) {
    clearTimeout(run.killTimer);
  }
}
