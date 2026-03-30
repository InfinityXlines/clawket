import type { AgentCapability, AgentInfo, AgentStatus, BackendHealth, BackendType } from '../../types/agent';

export const BACKEND_ORDER: BackendType[] = ['openclaw', 'claude-code', 'hermes'];

export type BackendTone = {
  background: string;
  foreground: string;
};

export type BackendSection = {
  backend: BackendType;
  title: string;
  description: string;
  count: number;
  agents: AgentInfo[];
  data: AgentInfo[];
};

export type BackendSummary = {
  backend: BackendType;
  title: string;
  description: string;
  count: number;
};

export function getBackendLabel(backend?: BackendType): string {
  switch (backend) {
    case 'openclaw':
      return 'OpenClaw';
    case 'claude-code':
      return 'Claude Code';
    case 'hermes':
      return 'Hermes';
    default:
      return 'Backend';
  }
}

export function getBackendDescription(backend?: BackendType): string {
  switch (backend) {
    case 'openclaw':
      return 'Local gateway and automation';
    case 'claude-code':
      return 'Claude-powered coding agents';
    case 'hermes':
      return 'Hermes runtime';
    default:
      return 'Connected backend';
  }
}

export function getBackendTone(backend: BackendType | undefined, colors: {
  primary: string;
  primarySoft: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  warning: string;
  success: string;
}): BackendTone {
  switch (backend) {
    case 'openclaw':
      return { background: colors.primarySoft, foreground: colors.primary };
    case 'claude-code':
      return { background: colors.surfaceMuted, foreground: colors.text };
    case 'hermes':
      return { background: `${colors.warning}1A`, foreground: colors.warning };
    default:
      return { background: colors.surfaceMuted, foreground: colors.textMuted };
  }
}

export function getAgentStatusTone(status: AgentStatus | undefined, colors: {
  success: string;
  warning: string;
  textSubtle: string;
}): string {
  switch (status) {
    case 'online':
      return colors.success;
    case 'busy':
      return colors.warning;
    case 'offline':
    default:
      return colors.textSubtle;
  }
}

export function getAgentStatusLabel(status: AgentStatus | undefined): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'busy':
      return 'Busy';
    case 'offline':
      return 'Offline';
    default:
      return 'Unknown';
  }
}

export function getCapabilityLabel(capability: AgentCapability): string {
  switch (capability) {
    case 'chat':
      return 'Chat';
    case 'file-management':
      return 'Files';
    case 'skill-management':
      return 'Skills';
    case 'cron-scheduling':
      return 'Cron';
    case 'config-editing':
      return 'Config';
    case 'session-history':
      return 'History';
    default:
      return capability;
  }
}

function getBackendRank(backend?: BackendType): number {
  const index = backend ? BACKEND_ORDER.indexOf(backend) : -1;
  return index === -1 ? BACKEND_ORDER.length : index;
}

function getStatusRank(status?: AgentStatus): number {
  switch (status) {
    case 'busy':
      return 0;
    case 'online':
      return 1;
    case 'offline':
    default:
      return 2;
  }
}

function compareAgentNames(left: AgentInfo, right: AgentInfo): number {
  const leftName = (left.identity?.name || left.name || left.id).toLowerCase();
  const rightName = (right.identity?.name || right.name || right.id).toLowerCase();
  return leftName.localeCompare(rightName);
}

export function sortUnifiedAgents(agents: AgentInfo[], currentAgentId?: string): AgentInfo[] {
  return [...agents].sort((left, right) => {
    const currentRank = Number(right.id === currentAgentId) - Number(left.id === currentAgentId);
    if (currentRank !== 0) return currentRank;

    const backendRank = getBackendRank(left.backend) - getBackendRank(right.backend);
    if (backendRank !== 0) return backendRank;

    const statusRank = getStatusRank(left.status) - getStatusRank(right.status);
    if (statusRank !== 0) return statusRank;

    return compareAgentNames(left, right);
  });
}

export function buildBackendSections(agents: AgentInfo[], currentAgentId?: string): BackendSection[] {
  const grouped = new Map<BackendType, AgentInfo[]>();
  for (const agent of sortUnifiedAgents(agents, currentAgentId)) {
    if (!agent.backend) continue;
    const existing = grouped.get(agent.backend);
    if (existing) {
      existing.push(agent);
      continue;
    }
    grouped.set(agent.backend, [agent]);
  }

  return BACKEND_ORDER
    .map((backend) => {
      const backendAgents = grouped.get(backend);
      if (!backendAgents?.length) return null;
      return {
        backend,
        title: getBackendLabel(backend),
        description: getBackendDescription(backend),
        count: backendAgents.length,
        agents: backendAgents,
        data: backendAgents,
      };
    })
    .filter((section): section is BackendSection => section != null);
}

export function buildBackendSummaries(agents: AgentInfo[]): BackendSummary[] {
  const counts = new Map<BackendType, number>(
    BACKEND_ORDER.map((backend) => [backend, 0]),
  );

  for (const agent of agents) {
    if (!agent.backend) continue;
    counts.set(agent.backend, (counts.get(agent.backend) ?? 0) + 1);
  }

  return BACKEND_ORDER.map((backend) => ({
    backend,
    title: getBackendLabel(backend),
    description: getBackendDescription(backend),
    count: counts.get(backend) ?? 0,
  }));
}

export function summarizeBackendHealth(backends: BackendHealth[]): {
  total: number;
  healthy: number;
  degraded: number;
} {
  return backends.reduce(
    (summary, backend) => {
      summary.total += 1;
      if (backend.ok) {
        summary.healthy += 1;
      } else {
        summary.degraded += 1;
      }
      return summary;
    },
    { total: 0, healthy: 0, degraded: 0 },
  );
}
