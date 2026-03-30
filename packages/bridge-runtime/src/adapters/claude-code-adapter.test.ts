import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const osMock = vi.hoisted(() => ({
  homedir: vi.fn(() => '/Users/tester'),
}));

vi.mock('node:child_process', () => childProcessMock);
vi.mock('node:fs', () => fsMock);
vi.mock('node:os', () => osMock);

type Disk = Map<string, string>;
type Directories = Map<string, string[]>;

describe('ClaudeCodeAdapter', () => {
  let disk: Disk;
  let directories: Directories;

  beforeEach(() => {
    disk = new Map();
    directories = new Map();

    fsMock.existsSync.mockImplementation((path: string) => {
      const key = String(path);
      return disk.has(key) || directories.has(key);
    });

    fsMock.readFileSync.mockImplementation((path: string) => {
      const key = String(path);
      const value = disk.get(key);
      if (value == null) throw new Error(`ENOENT: ${key}`);
      return value;
    });

    fsMock.readdirSync.mockImplementation((path: string, options?: { withFileTypes?: boolean }) => {
      const entries = directories.get(String(path)) ?? [];
      if (options?.withFileTypes) {
        return entries.map((name) => ({
          name,
          isDirectory: () => true,
        }));
      }
      return entries;
    });

    childProcessMock.execFile.mockImplementation((command: string, args: string[], callback: (error: Error | null, stdout?: string) => void) => {
      if (command === 'bash' && args[0] === '/Users/tester/.claude/crew-ctl.sh') {
        callback(
          null,
          [
            'AGENT      TMUX       CLAUDE     TELEGRAM     UPTIME     PID    MODE',
            '-----      ----       ------     --------     ------     ---    ----',
            'jade       UP         STARTING   -            -          -      TG',
            'kira       DOWN       -          -            -          -      -',
          ].join('\n'),
        );
        return;
      }
      if (command === 'claude' && args[0] === '--version') {
        callback(null, '2.1.87 (Claude Code)');
        return;
      }
      callback(new Error(`unexpected execFile: ${command} ${args.join(' ')}`));
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('discovers agents from the local crew and status output', async () => {
    directories.set('/Users/tester/agents', ['jade', 'kira']);
    disk.set('/Users/tester/.claude/crew-ctl.sh', '#!/usr/bin/env bash');
    disk.set('/Users/tester/.claude/CLAUDE.md', [
      '| Agent | Command | Model | Domain |',
      '|-------|---------|-------|--------|',
      '| Kira | `/kira` | Opus | Production coding |',
    ].join('\n'));
    disk.set('/Users/tester/agents/jade/CLAUDE.md', 'You are **Jade**');
    disk.set('/Users/tester/agents/kira/CLAUDE.md', 'You are **Kira**');

    const adapter = new ClaudeCodeAdapter();
    const agents = await adapter.listAgents();

    expect(agents).toEqual([
      {
        id: 'claude-code:jade',
        localId: 'jade',
        backend: 'claude-code',
        name: 'Jade',
        status: 'busy',
        capabilities: ['chat', 'session-history'],
      },
      {
        id: 'claude-code:kira',
        localId: 'kira',
        backend: 'claude-code',
        name: 'Kira',
        model: 'Opus',
        status: 'offline',
        capabilities: ['chat', 'session-history'],
      },
    ]);
  });

  it('translates Claude stream-json output into relay chat events', async () => {
    directories.set('/Users/tester/agents', ['jade']);
    disk.set('/Users/tester/agents/jade/CLAUDE.md', 'You are **Jade**');
    const child = createMockChild();
    childProcessMock.spawn.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter();
    const frames: unknown[] = [];
    adapter.on('frame', (frame) => {
      frames.push(frame);
    });

    const response = await adapter.handleRpc({
      type: 'req',
      id: 'chat-1',
      method: 'chat.send',
      params: {
        sessionKey: 'agent:claude-code:jade:main',
        message: 'hello',
      },
    });

    expect('type' in response && response.type === 'res').toBe(true);
    if ('type' in response && response.type === 'res') {
      expect(response.ok).toBe(true);
    }

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
      session_id: 'sess-1',
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      session_id: 'sess-1',
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'Hello',
      session_id: 'sess-1',
      usage: { input_tokens: 10, output_tokens: 5 },
    })}\n`);
    child.emit('close', 0, null);
    await flushMicrotasks();

    expect(frames).toEqual([
      {
        type: 'event',
        event: 'agent',
        payload: {
          runId: expect.any(String),
          sessionKey: 'agent:claude-code:jade:main',
          stream: 'lifecycle',
          data: { phase: 'start' },
        },
      },
      {
        type: 'event',
        event: 'chat',
        payload: {
          runId: expect.any(String),
          sessionKey: 'agent:claude-code:jade:main',
          state: 'delta',
          message: { role: 'assistant', content: 'Hello' },
        },
      },
      {
        type: 'event',
        event: 'chat',
        payload: {
          runId: expect.any(String),
          sessionKey: 'agent:claude-code:jade:main',
          state: 'final',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
          },
          usage: { input: 10, output: 5, total: 15 },
        },
      },
    ]);
  });

  it('rebuilds chat history from Claude project logs', async () => {
    directories.set('/Users/tester/agents', ['jade']);
    directories.set('/Users/tester/.claude/sessions', ['123.json']);
    disk.set('/Users/tester/agents/jade/CLAUDE.md', 'You are **Jade**');
    disk.set('/Users/tester/.claude/sessions/123.json', JSON.stringify({
      sessionId: 'sess-1',
      cwd: '/Users/tester/agents/jade',
      startedAt: 123,
    }));
    disk.set('/Users/tester/.claude/projects/-Users-tester-agents-jade/sess-1.jsonl', [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: 'sess-1',
        message: { role: 'user', content: 'hi' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        requestId: 'req-1',
        sessionId: 'sess-1',
        message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'draft' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        requestId: 'req-1',
        sessionId: 'sess-1',
        message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] },
      }),
    ].join('\n'));

    const adapter = new ClaudeCodeAdapter();
    const response = await adapter.handleRpc({
      type: 'req',
      id: 'history-1',
      method: 'chat.history',
      params: {
        sessionKey: 'agent:claude-code:jade:main',
        limit: 10,
      },
    });

    expect(response).toEqual({
      type: 'res',
      id: 'history-1',
      ok: true,
      payload: {
        sessionId: 'sess-1',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
        ],
      },
    });
  });
});

function createMockChild(): ReturnType<typeof childProcessMock.spawn> {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child as ReturnType<typeof childProcessMock.spawn>;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
