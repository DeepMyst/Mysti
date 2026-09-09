import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import { NativeApprovalScope } from '../../../src/providers/base/NativeApprovalScope';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

const scopes: NativeApprovalScope[] = [];
afterEach(() => { for (const scope of scopes.splice(0)) { scope.dispose(); } });

function harness(handler?: NativeApprovalHandler, panelId = 'panel', signal?: AbortSignal) {
  const controller = new AbortController();
  const respond = vi.fn();
  let current = true;
  const scope = new NativeApprovalScope({
    providerId: 'gateway', panelId, signal: signal ?? controller.signal,
    handler, isCurrent: () => current,
  });
  scopes.push(scope);
  const toolCall: NativeApprovalRequest['toolCall'] = {
    id: 'tool', name: 'Edit', input: {}, status: 'running',
  };
  const request = (id: string | number = 77, policy: NativeApprovalRequest['defaultDecision'] = 'ask') => {
    scope.request(id, toolCall, policy, respond);
  };
  return { scope, controller, respond, request, toolCall, replace: () => { current = false; } };
}

describe('process-free native approval ownership', () => {
  it('settles requests and cancellation even when a pending-state observer throws', async () => {
    const decision = deferred<boolean>();
    const h = harness(() => decision.promise);
    h.scope.onPendingChanged(() => { throw new Error('Observer failed'); });
    expect(() => h.request()).not.toThrow();
    expect(h.scope.hasPending).toBe(true);
    expect(() => h.controller.abort()).not.toThrow();
    expect(h.respond).toHaveBeenCalledExactlyOnceWith('cancelled');
    decision.resolve(true);
    await Promise.resolve();
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.scope.hasPending).toBe(false);
  });

  it('holds a request, suppresses pending duplicates, and reports pending transitions', async () => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(handler);
    const pending: boolean[] = [];
    const release = h.scope.onPendingChanged(() => { pending.push(h.scope.hasPending); });
    h.request(); h.request();
    expect(handler).toHaveBeenCalledOnce();
    const request = handler.mock.calls[0][0];
    expect(request).toMatchObject({
      nativeRequestId: 77, providerId: 'gateway', panelId: 'panel', toolCall: h.toolCall,
    });
    expect(request.signal.aborted).toBe(false);
    expect(pending).toEqual([true]);
    expect(h.respond).not.toHaveBeenCalled();
    decision.resolve(true);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledExactlyOnceWith('allow'));
    expect(request.signal.aborted).toBe(true);
    expect(pending).toEqual([true, false]);
    release();
    h.request(78, 'deny');
    expect(pending).toEqual([true, false]);
  });

  it('keeps typed native IDs separate and mints a fresh host ID when an ID is reused', async () => {
    const decisions = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    const received: NativeApprovalRequest[] = [];
    const h = harness(request => {
      received.push(request);
      return decisions[received.length - 1].promise;
    });
    h.request(77); h.request('77');
    expect(received).toHaveLength(2);
    expect(received[0].id).not.toBe(received[1].id);
    decisions[0].resolve(true);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
    expect(h.scope.hasPending).toBe(true);
    h.request(77);
    expect(new Set(received.map(request => request.id)).size).toBe(3);
    decisions[1].resolve(false); decisions[2].resolve(false);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledTimes(3));
    expect(h.scope.hasPending).toBe(false);
  });

  it.each(['abort', 'dispose'] as const)('%s cancels all pending requests once and ignores late approvals', async event => {
    const decision = deferred<boolean>();
    const onDecision = vi.fn();
    const handler = Object.assign(vi.fn((_request: NativeApprovalRequest) => decision.promise), { onDecision });
    const h = harness(handler);
    h.request(1); h.request(2);
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(1);
    if (event === 'abort') { h.controller.abort(); }
    else { h.scope.dispose(); }
    expect(h.respond.mock.calls).toEqual([['cancelled'], ['cancelled']]);
    expect(onDecision).toHaveBeenCalledTimes(2);
    for (const [request] of handler.mock.calls) { expect(request.signal.aborted).toBe(true); }
    expect(h.scope.hasPending).toBe(false);
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0);
    decision.resolve(true);
    await decision.promise;
    await Promise.resolve();
    h.request(3);
    h.scope.dispose();
    expect(h.respond).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(onDecision).toHaveBeenCalledTimes(2);
  });

  it('does not accept work when constructed with an aborted owner', () => {
    const controller = new AbortController();
    controller.abort();
    const handler = vi.fn(async () => true);
    const h = harness(handler, 'panel', controller.signal);
    h.request();
    expect(handler).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.scope.hasPending).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not ask a stale owner and converts a decision that settles after replacement to cancellation', async () => {
    const decision = deferred<boolean>();
    const onDecision = vi.fn();
    const handler = Object.assign(vi.fn((_request: NativeApprovalRequest) => decision.promise), { onDecision });
    const h = harness(handler);
    h.request(1);
    h.replace();
    h.request(2);
    expect(handler).toHaveBeenCalledOnce();
    expect(h.respond).toHaveBeenCalledExactlyOnceWith('cancelled');
    decision.resolve(true);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledTimes(2));
    expect(h.respond.mock.calls).toEqual([['cancelled'], ['cancelled']]);
    expect(onDecision.mock.calls.map(call => call[1])).toEqual(['cancelled', 'cancelled']);
  });

  it('keeps identical request IDs in different panels and turns independent', async () => {
    const firstDecision = deferred<boolean>();
    const secondDecision = deferred<boolean>();
    const firstHandler = vi.fn((_request: NativeApprovalRequest) => firstDecision.promise);
    const secondHandler = vi.fn((_request: NativeApprovalRequest) => secondDecision.promise);
    const first = harness(firstHandler, 'first');
    const second = harness(secondHandler, 'second');
    first.request(); second.request();
    expect(firstHandler.mock.calls[0][0].id).not.toBe(secondHandler.mock.calls[0][0].id);
    first.controller.abort();
    expect(second.scope.hasPending).toBe(true);
    expect(secondHandler.mock.calls[0][0].signal.aborted).toBe(false);
    expect(second.respond).not.toHaveBeenCalled();
    secondDecision.resolve(true);
    firstDecision.resolve(true);
    await vi.waitFor(() => expect(second.respond).toHaveBeenCalledExactlyOnceWith('allow'));
    expect(first.respond).toHaveBeenCalledExactlyOnceWith('cancelled');
  });

  it('does not let a decision observer turn a policy denial into approval', () => {
    const onDecision = vi.fn(() => true);
    const handler = Object.assign(vi.fn(async () => true), { onDecision });
    const h = harness(handler);
    h.request(1, 'deny');
    expect(handler).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ defaultDecision: 'deny' }), 'deny');
    expect(h.respond).toHaveBeenCalledExactlyOnceWith('deny');
  });

  it.each(['dispose', 'abort', 'replace'] as const)('cancels when a pending-change listener retires the owner by %s', async retirement => {
    const decision = deferred<boolean>();
    const onDecision = vi.fn();
    const handler = Object.assign(vi.fn((_request: NativeApprovalRequest) => decision.promise), { onDecision });
    const h = harness(handler);
    h.scope.onPendingChanged(() => {
      if (h.scope.hasPending) { return; }
      if (retirement === 'dispose') { h.scope.dispose(); }
      else if (retirement === 'abort') { h.controller.abort(); }
      else { h.replace(); }
    });
    h.request();
    decision.resolve(true);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledExactlyOnceWith('cancelled'));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(handler.mock.calls[0][0], 'cancelled');
    expect(handler.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it.each(['dispose', 'abort', 'replace'] as const)('cancellation supersedes a local observation when its observer retires the owner by %s', async retirement => {
    const onDecision = vi.fn(() => {
      if (retirement === 'dispose') { h.scope.dispose(); }
      else if (retirement === 'abort') { h.controller.abort(); }
      else { h.replace(); }
    });
    const handler = Object.assign(vi.fn(async (_request: NativeApprovalRequest) => true), { onDecision });
    const h = harness(handler);
    h.request();
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledExactlyOnceWith('cancelled'));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(handler.mock.calls[0][0], 'allow');
    expect(handler.mock.calls[0][0].signal.aborted).toBe(true);
    expect(h.scope.hasPending).toBe(false);
  });

  it('allows the host to restrict an autonomous policy and preserves host cancellation', async () => {
    const restricted = harness(async () => false);
    const cancelled = harness(async () => 'cancelled');
    restricted.request(1, 'allow');
    cancelled.request();
    await vi.waitFor(() => expect(restricted.respond).toHaveBeenCalledExactlyOnceWith('deny'));
    await vi.waitFor(() => expect(cancelled.respond).toHaveBeenCalledExactlyOnceWith('cancelled'));
  });

  it('denies an unanswered ask while retaining an explicit autonomous policy without a host', () => {
    const h = harness();
    h.request(1, 'ask'); h.request(2, 'allow'); h.request(3, 'deny');
    expect(h.respond.mock.calls).toEqual([['deny'], ['allow'], ['deny']]);
    expect(h.scope.hasPending).toBe(false);
  });

  it.each(['throw', 'reject'] as const)('denies when the handler fails by %s', async failure => {
    const onDecision = vi.fn();
    const handler = Object.assign(vi.fn((_request: NativeApprovalRequest) => {
      if (failure === 'throw') { throw new Error('unavailable'); }
      return Promise.reject(new Error('unavailable'));
    }), { onDecision });
    const h = harness(handler);
    h.request();
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledExactlyOnceWith('deny'));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(handler.mock.calls[0][0], 'deny');
    expect(handler.mock.calls[0][0].signal.aborted).toBe(true);
    expect(h.scope.hasPending).toBe(false);
  });

  it.each(['throw', 'reject'] as const)('still responds and releases the request when an observer fails by %s', async failure => {
    let observed!: NativeApprovalRequest;
    const onDecision = vi.fn((request: NativeApprovalRequest) => {
      observed = request;
      if (failure === 'throw') { throw new Error('observer unavailable'); }
      return Promise.reject(new Error('observer unavailable'));
    });
    const handler = Object.assign(vi.fn(async () => true), { onDecision });
    const h = harness(handler);
    h.request(1, 'deny');
    await new Promise(resolve => setImmediate(resolve));
    expect(handler).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledExactlyOnceWith('deny');
    expect(observed.signal.aborted).toBe(true);
    expect(h.scope.hasPending).toBe(false);
  });

  it('releases request ownership even if the transport response throws', async () => {
    const handler = vi.fn(async (_request: NativeApprovalRequest) => true);
    const h = harness(handler);
    const respond = vi.fn(() => { throw new Error('connection closed'); });
    h.scope.request(77, h.toolCall, 'ask', respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith('allow'));
    expect(handler.mock.calls[0][0].signal.aborted).toBe(true);
    expect(h.scope.hasPending).toBe(false);
  });
});
