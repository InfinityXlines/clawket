import {
  buildBackendSections,
  buildBackendSummaries,
  getCapabilityLabel,
  getBackendLabel,
  summarizeBackendHealth,
} from './backendDisplay';
import type { AgentInfo, BackendHealth } from '../../types/agent';

describe('backendDisplay', () => {
  it('builds grouped backend sections and keeps the current agent first', () => {
    const agents: AgentInfo[] = [
      { id: 'claude-code:jade', backend: 'claude-code', status: 'online', identity: { name: 'Jade' } },
      { id: 'openclaw:simone', backend: 'openclaw', status: 'online', identity: { name: 'Simone' } },
      { id: 'openclaw:katana', backend: 'openclaw', status: 'busy', identity: { name: 'Katana' } },
    ];

    const sections = buildBackendSections(agents, 'openclaw:simone');

    expect(sections.map((section) => section.backend)).toEqual(['openclaw', 'claude-code']);
    expect(sections[0]?.agents.map((agent) => agent.id)).toEqual(['openclaw:simone', 'openclaw:katana']);
  });

  it('builds backend summaries in stable order and includes empty backends', () => {
    const agents: AgentInfo[] = [
      { id: 'openclaw:simone', backend: 'openclaw', status: 'online', identity: { name: 'Simone' } },
      { id: 'claude-code:jade', backend: 'claude-code', status: 'online', identity: { name: 'Jade' } },
    ];

    expect(buildBackendSummaries(agents)).toEqual([
      {
        backend: 'openclaw',
        title: 'OpenClaw',
        description: 'Local gateway and automation',
        count: 1,
      },
      {
        backend: 'claude-code',
        title: 'Claude Code',
        description: 'Claude-powered coding agents',
        count: 1,
      },
      {
        backend: 'hermes',
        title: 'Hermes',
        description: 'Hermes runtime',
        count: 0,
      },
    ]);
  });

  it('returns readable labels for backends and capabilities', () => {
    expect(getBackendLabel('claude-code')).toBe('Claude Code');
    expect(getCapabilityLabel('session-history')).toBe('History');
  });

  it('summarizes healthy vs degraded backends', () => {
    const backends: BackendHealth[] = [
      {
        backend: 'openclaw',
        displayName: 'OpenClaw',
        ok: true,
        healthy: true,
        latencyMs: 12,
        checkedAtMs: 1000,
        agentCount: 3,
      },
      {
        backend: 'claude-code',
        displayName: 'Claude Code',
        ok: false,
        healthy: false,
        latencyMs: 220,
        checkedAtMs: 1000,
        agentCount: 0,
        error: 'Unavailable',
      },
    ];

    expect(summarizeBackendHealth(backends)).toEqual({
      total: 2,
      healthy: 1,
      degraded: 1,
    });
  });
});
