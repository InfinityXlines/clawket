import { describe, expect, it, vi } from 'vitest';
import { OpenClawAdapter } from './openclaw-adapter.js';
import type { ReqFrame } from './types.js';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs', () => fsMock);
vi.mock('../openclaw.js', () => ({
  readOpenClawInfo: vi.fn().mockReturnValue({
    configFound: true,
    gatewayPort: 18789,
    authMode: 'token',
    token: 'test-token',
    password: null,
  }),
  resolveGatewayUrl: vi.fn().mockReturnValue('ws://127.0.0.1:18789'),
  getOpenClawConfigPath: vi.fn().mockReturnValue('/Users/tester/.openclaw/openclaw.json'),
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

  it('handleRpc returns a passthrough frame with stripped OpenClaw agent ids', async () => {
    const adapter = new OpenClawAdapter();
    const frame: ReqFrame = {
      type: 'req',
      id: '1',
      method: 'chat.send',
      params: { agentId: 'openclaw:simone', message: 'hello' },
    };
    const result = await adapter.handleRpc(frame);
    expect(result).toEqual({
      kind: 'passthrough',
      frame: {
        type: 'req',
        id: '1',
        method: 'chat.send',
        params: { agentId: 'simone', message: 'hello' },
      },
    });
  });

  it('listAgents reads configured OpenClaw agents from disk', async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({
      agents: {
        list: [
          { id: 'simone', name: 'Simone', emoji: 'S', model: 'gpt-5.4' },
        ],
      },
    }));
    const adapter = new OpenClawAdapter();
    const agents = await adapter.listAgents();
    expect(agents).toEqual([
      {
        id: 'openclaw:simone',
        localId: 'simone',
        backend: 'openclaw',
        name: 'Simone',
        model: 'gpt-5.4',
        emoji: 'S',
        status: 'online',
        capabilities: [
          'chat',
          'file-management',
          'skill-management',
          'cron-scheduling',
          'config-editing',
          'session-history',
        ],
      },
    ]);
  });

  it('getGatewayUrl returns resolved URL', () => {
    const adapter = new OpenClawAdapter();
    expect(adapter.getGatewayUrl()).toBe('ws://127.0.0.1:18789');
  });
});
