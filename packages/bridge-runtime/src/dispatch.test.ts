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

  it('passthroughs agents.list in Phase 1 (returns null)', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '1', method: 'agents.list',
    });
    expect(result).toBeNull();
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

  it('returns null for RPCs without agentId (passthrough to gateway)', async () => {
    const oc = createMockAdapter('openclaw');
    const registry = new UnifiedAgentRegistry([oc]);
    const dispatcher = new RpcDispatcher(registry);
    const result = await dispatcher.dispatch({
      type: 'req', id: '3', method: 'some.unroutable.method',
    });
    expect(result).toBeNull();
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
