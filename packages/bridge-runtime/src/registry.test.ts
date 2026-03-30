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

  it('returns default adapter', () => {
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
    expect(health.find(h => h.backend === 'openclaw')).toEqual(
      expect.objectContaining({
        healthy: true,
        ok: true,
        agentCount: 1,
      }),
    );
    expect(health.find(h => h.backend === 'claude-code')).toEqual(
      expect.objectContaining({
        healthy: false,
        ok: false,
        agentCount: 0,
      }),
    );
  });

  it('tolerates adapter failures in listAllAgents', async () => {
    const oc = createMockAdapter('openclaw', [agentSimone]);
    const cc = createMockAdapter('claude-code');
    (cc.listAgents as ReturnType<typeof import('vitest')['vi']['fn']>).mockRejectedValue(
      new Error('connection failed'),
    );
    const registry = new UnifiedAgentRegistry([oc, cc]);
    const agents = await registry.listAllAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('openclaw:simone');
  });
});
