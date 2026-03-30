import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { BackendAdapter, UnifiedAgent } from '../adapters/types.js';

export function createMockAdapter(
  type: 'openclaw' | 'claude-code' | 'hermes',
  agents: UnifiedAgent[] = [],
  healthy = true,
): BackendAdapter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type,
    displayName: type,
    backendCapabilities: ['chat' as const],
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(healthy),
    listAgents: vi.fn().mockResolvedValue(agents),
    getAgentIdentity: vi.fn().mockResolvedValue({ name: 'test' }),
    sendMessage: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    canHandleSession: vi.fn().mockResolvedValue(false),
    getConfig: vi.fn().mockResolvedValue({}),
    patchConfig: vi.fn().mockResolvedValue(undefined),
    handleRpc: vi.fn().mockResolvedValue({ type: 'res', id: '1', ok: true, payload: { routed: true } }),
  }) as unknown as BackendAdapter;
}
