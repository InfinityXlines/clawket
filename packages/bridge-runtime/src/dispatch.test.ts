import { describe, expect, it, vi } from 'vitest';
import { RpcDispatcher } from './dispatch.js';
import { UnifiedAgentRegistry } from './registry.js';
import { createMockAdapter } from './__test-utils__/mock-adapter.js';

describe('RpcDispatcher', () => {
  it('returns null for non-JSON messages', () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    expect(dispatcher.tryParseReq('not json')).toBeNull();
  });

  it('returns null for messages without type=req', () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    expect(dispatcher.tryParseReq(JSON.stringify({ type: 'res', id: '1', ok: true }))).toBeNull();
  });

  it('parses valid req frames and preserves id', () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const frame = dispatcher.tryParseReq(JSON.stringify({
      type: 'req',
      id: 'abc-123',
      method: 'chat.send',
      params: { agentId: 'openclaw:simone' },
    }));
    expect(frame).toEqual({
      type: 'req',
      id: 'abc-123',
      method: 'chat.send',
      params: { agentId: 'openclaw:simone' },
    });
  });

  it('aggregates agents.list into a gateway payload', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '1', method: 'agents.list',
    });
    expect('type' in result && result.type === 'res').toBe(true);
    if ('type' in result && result.type === 'res') {
      expect(result.payload).toEqual({
        defaultId: 'main',
        mainKey: 'main',
        agents: [],
      });
    }
  });

  it('aggregates backends.health into a gateway payload', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: 'health-1', method: 'backends.health',
    });
    expect('type' in result && result.type === 'res').toBe(true);
    if ('type' in result && result.type === 'res') {
      expect(result.payload).toMatchObject({
        backends: [
          expect.objectContaining({
            backend: 'openclaw',
            displayName: 'openclaw',
            ok: true,
            healthy: true,
            agentCount: 0,
          }),
        ],
      });
    }
  });

  it('routes agent-scoped RPCs to correct adapter by composite agentId', async () => {
    const oc = createMockAdapter('openclaw');
    const cc = createMockAdapter('claude-code');
    const registry = new UnifiedAgentRegistry([oc, cc]);
    const dispatcher = new RpcDispatcher(registry);
    await dispatcher.dispatch({
      type: 'req', id: '2', method: 'chat.send',
      params: { agentId: 'claude-code:jade', message: 'hello' },
    });
    expect(cc.handleRpc).toHaveBeenCalled();
    expect(oc.handleRpc).not.toHaveBeenCalled();
  });

  it('returns a passthrough result for RPCs without agentId', async () => {
    const oc = createMockAdapter('openclaw');
    (oc.handleRpc as ReturnType<typeof import('vitest')['vi']['fn']>).mockResolvedValue({
      kind: 'passthrough',
      frame: { type: 'req', id: '3', method: 'some.unroutable.method' },
    });
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '3', method: 'some.unroutable.method',
    });
    expect(result).toEqual({
      kind: 'passthrough',
      frame: { type: 'req', id: '3', method: 'some.unroutable.method' },
    });
  });

  it('routes session-scoped Claude Code RPCs by sessionKey prefix', async () => {
    const oc = createMockAdapter('openclaw');
    const cc = createMockAdapter('claude-code');
    (cc.canHandleSession as ReturnType<typeof import('vitest')['vi']['fn']>).mockResolvedValue(true);
    const registry = new UnifiedAgentRegistry([oc, cc]);
    const dispatcher = new RpcDispatcher(registry);
    await dispatcher.dispatch({
      type: 'req',
      id: 'session-1',
      method: 'chat.send',
      params: { sessionKey: 'agent:claude-code:jade:main', message: 'hello' },
    });
    expect(cc.handleRpc).toHaveBeenCalled();
    expect(oc.handleRpc).not.toHaveBeenCalled();
  });

  it('returns error ResFrame when adapter not found for agentId', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '4', method: 'chat.send',
      params: { agentId: 'hermes:magdalena', message: 'hello' },
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.id).toBe('4');
    expect(result!.error?.code).toBe('adapter_not_found');
  });
});
