import { describe, expect, it, vi } from 'vitest';
import { OpenClawAdapter } from './openclaw-adapter.js';
import type { ReqFrame } from './types.js';

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
    const result = await adapter.handleRpc(frame);
    expect(result).toBeNull();
  });

  it('listAgents returns empty array (gateway WS handles this)', async () => {
    const adapter = new OpenClawAdapter();
    const agents = await adapter.listAgents();
    expect(agents).toEqual([]);
  });

  it('getGatewayUrl returns resolved URL', () => {
    const adapter = new OpenClawAdapter();
    expect(adapter.getGatewayUrl()).toBe('ws://127.0.0.1:18789');
  });
});
