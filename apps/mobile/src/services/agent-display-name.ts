import type { AgentInfo } from '../types/agent';

function isPlaceholderAssistantName(value?: string): boolean {
  return value?.trim().toLowerCase() === 'assistant';
}

function readValidAgentName(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isPlaceholderAssistantName(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveAgentDisplayName(agent?: AgentInfo): string | undefined {
  const identityName = readValidAgentName(agent?.identity?.name);
  if (identityName) {
    return identityName;
  }

  const configName = readValidAgentName(agent?.name);
  if (configName) {
    return configName;
  }

  const agentId = agent?.id?.trim();
  if (agentId) {
    return agentId;
  }

  return undefined;
}

