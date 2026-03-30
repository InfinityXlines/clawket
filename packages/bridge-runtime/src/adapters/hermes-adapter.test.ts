import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesAdapter } from './hermes-adapter.js';

const osMock = vi.hoisted(() => ({
  homedir: vi.fn(() => '/Users/tester'),
}));

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => osMock);
vi.mock('node:fs', () => fsMock);

type FetchMock = ReturnType<typeof vi.fn>;

function createMockFetch(overrides: {
  ok?: boolean;
  status?: number;
  body?: string;
  responses?: Array<{ id: string; created_at: number }>;
  throw?: Error;
}): FetchMock {
  const mock = vi.fn() as FetchMock;

  mock.mockImplementation(async (url: string) => {
    // Simulate network errors
    if (overrides.throw) {
      throw overrides.throw;
    }

    if (url.endsWith('/health')) {
      return {
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
      };
    }

    if (url.includes('/v1/responses')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: overrides.responses ?? [] }),
      };
    }

    if (url.includes('/v1/chat/completions')) {
      const chunks = (overrides.body ?? '').split('|');
      let i = 0;

      const readable = {
        getReader() {
          return {
            read: async () => {
              if (i >= chunks.length) return { done: true, value: undefined };
              const chunk = chunks[i++];
              const encoded = new TextEncoder().encode(chunk);
              return { done: false, value: encoded };
            },
            releaseLock: () => {},
          };
        },
      };

      return {
        ok: true,
        status: 200,
        body: readable,
      };
    }

    return { ok: false, status: 404 };
  });

  return mock;
}

describe('HermesAdapter', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReturnValue('');
    osMock.homedir.mockReturnValue('/Users/tester');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('health check', () => {
    it('returns healthy when /health returns 200', async () => {
      const fetchMock = createMockFetch({ ok: true });
      const adapter = new HermesAdapter({}, fetchMock);
      const healthy = await adapter.isHealthy();
      expect(healthy).toBe(true);
    });

    it('returns unhealthy when /health fails or times out', async () => {
      const fetchMock = createMockFetch({ throw: new Error('ECONNREFUSED') });
      const adapter = new HermesAdapter({}, fetchMock);
      const healthy = await adapter.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  describe('listAgents', () => {
    it('returns Magdalena as the single agent when healthy', async () => {
      const fetchMock = createMockFetch({ ok: true });
      const adapter = new HermesAdapter({}, fetchMock);
      const agents = await adapter.listAgents();
      expect(agents).toEqual([
        {
          id: 'hermes:magdalena',
          localId: 'magdalena',
          backend: 'hermes',
          name: 'Magdalena',
          status: 'online',
          capabilities: ['chat', 'session-history'],
        },
      ]);
    });

    it('returns empty list when Hermes is unreachable', async () => {
      const fetchMock = createMockFetch({ throw: new Error('ECONNREFUSED') });
      const adapter = new HermesAdapter({}, fetchMock);
      const agents = await adapter.listAgents();
      expect(agents).toEqual([]);
    });
  });

  describe('handleRpc', () => {
    it('handles agent.identity.get', async () => {
      const fetchMock = createMockFetch({ ok: true });
      const adapter = new HermesAdapter({}, fetchMock);

      const response = await adapter.handleRpc({
        type: 'req',
        id: 'req-1',
        method: 'agent.identity.get',
        params: { agentId: 'hermes:magdalena' },
      });

      expect(response).toEqual({
        type: 'res',
        id: 'req-1',
        ok: true,
        payload: { name: 'Magdalena' },
      });
    });

    it('handles chat.send by starting a stream and returning runId', async () => {
      const fetchMock = createMockFetch({ ok: true });
      const adapter = new HermesAdapter({}, fetchMock);
      const frames: unknown[] = [];
      adapter.on('frame', (f) => frames.push(f));

      const response = await adapter.handleRpc({
        type: 'req',
        id: 'req-2',
        method: 'chat.send',
        params: {
          sessionKey: 'agent:hermes:magdalena:main',
          message: 'hello',
        },
      });

      expect(response).toMatchObject({
        type: 'res',
        id: 'req-2',
        ok: true,
      });
      expect((response as { payload?: { runId?: string } }).payload).toHaveProperty('runId');
    });

    it('returns error for chat.send without sessionKey or message', async () => {
      const fetchMock = createMockFetch({ ok: true });
      const adapter = new HermesAdapter({}, fetchMock);

      const response = await adapter.handleRpc({
        type: 'req',
        id: 'req-3',
        method: 'chat.send',
        params: { message: 'hello' },
      });

      expect(response).toMatchObject({
        type: 'res',
        id: 'req-3',
        ok: false,
        error: { code: 'invalid_request' },
      });
    });

    it('returns error for unsupported methods', async () => {
      const fetchMock = createMockFetch({ ok: true });
      const adapter = new HermesAdapter({}, fetchMock);

      const response = await adapter.handleRpc({
        type: 'req',
        id: 'req-99',
        method: 'config.patch',
        params: {},
      });

      expect(response).toMatchObject({
        type: 'res',
        id: 'req-99',
        ok: false,
        error: { code: 'unsupported_method' },
      });
    });
  });

  describe('canHandleSession', () => {
    it('returns true for hermes session keys', async () => {
      const fetchMock = createMockFetch({});
      const adapter = new HermesAdapter({}, fetchMock);
      expect(await adapter.canHandleSession('agent:hermes:magdalena:main')).toBe(true);
      expect(await adapter.canHandleSession('hermes:magdalena:123')).toBe(true);
    });

    it('returns false for other backends', async () => {
      const fetchMock = createMockFetch({});
      const adapter = new HermesAdapter({}, fetchMock);
      expect(await adapter.canHandleSession('agent:claude-code:jade:main')).toBe(false);
      expect(await adapter.canHandleSession('agent:openclaw:simone:main')).toBe(false);
    });
  });

  describe('api key loading', () => {
    it('reads API_SERVER_KEY from ~/.hermes/.env', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('API_SERVER_KEY=sk-test-key-123\n');

      const fetchMock = createMockFetch({});
      const adapter = new HermesAdapter({}, fetchMock);

      // @ts-expect-error — private field access for test
      expect(adapter.apiKey).toBe('sk-test-key-123');
    });

    it('uses provided config.apiKey over .env', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('API_SERVER_KEY=env-key\n');

      const fetchMock = createMockFetch({});
      const adapter = new HermesAdapter({ apiKey: 'config-key' }, fetchMock);

      // @ts-expect-error — private field access for test
      expect(adapter.apiKey).toBe('config-key');
    });

    it('gracefully handles malformed .env', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('not-valid-yaml-at-all\n\t  broken');

      const fetchMock = createMockFetch({});
      const adapter = new HermesAdapter({}, fetchMock);

      // @ts-expect-error — private field access for test
      expect(adapter.apiKey).toBeNull();
    });
  });
});
