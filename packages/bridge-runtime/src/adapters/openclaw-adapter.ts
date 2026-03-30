import { EventEmitter } from 'node:events';
import { readOpenClawInfo, resolveGatewayUrl } from '../openclaw.js';
import type {
  AgentCapability,
  AgentIdentity,
  BackendAdapter,
  ChatStream,
  ReqFrame,
  ResFrame,
  Session,
  UnifiedAgent,
} from './types.js';

/**
 * OpenClaw adapter.
 *
 * Unlike other adapters, OpenClaw messages are forwarded through the existing
 * gateway WebSocket in BridgeRuntime. This adapter handles:
 * - Health checks (does OpenClaw config exist?)
 * - Agent listing (returns empty — real list comes from gateway WS)
 * - RPC passthrough (returns null to signal "forward to gateway WS as-is")
 */
export class OpenClawAdapter extends EventEmitter implements BackendAdapter {
  readonly type = 'openclaw' as const;
  readonly displayName = 'OpenClaw';
  readonly backendCapabilities: AgentCapability[] = [
    'chat',
    'file-management',
    'skill-management',
    'cron-scheduling',
    'config-editing',
    'session-history',
  ];

  async connect(): Promise<void> {
    // Gateway connection managed by BridgeRuntime
  }

  async disconnect(): Promise<void> {
    // Managed by BridgeRuntime
  }

  async isHealthy(): Promise<boolean> {
    try {
      const info = readOpenClawInfo();
      return info.configFound && info.gatewayPort != null;
    } catch {
      return false;
    }
  }

  async listAgents(): Promise<UnifiedAgent[]> {
    // OpenClaw agents are enumerated via gateway WS, not this adapter.
    // Returns empty — BridgeRuntime merges native agents.list response.
    return [];
  }

  async getAgentIdentity(localId: string): Promise<AgentIdentity> {
    return { name: localId };
  }

  async sendMessage(): Promise<ChatStream> {
    throw new Error('OpenClaw chat is handled via gateway WebSocket passthrough');
  }

  async listSessions(): Promise<Session[]> {
    return [];
  }

  async createSession(): Promise<Session> {
    throw new Error('OpenClaw sessions are handled via gateway WebSocket passthrough');
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return {};
  }

  async patchConfig(): Promise<void> {
    // Handled via gateway passthrough
  }

  /**
   * Returns null — signals "forward to gateway WebSocket as-is."
   * This is the explicit null-passthrough contract.
   */
  async handleRpc(_frame: ReqFrame): Promise<ResFrame | null> {
    return null;
  }

  getGatewayUrl(): string {
    return resolveGatewayUrl();
  }
}
