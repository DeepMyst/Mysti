import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { NativeApprovalRequests } from '../../../src/providers/base/NativeApprovalRequests';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(handler?: NativeApprovalHandler) {
  const proc = new EventEmitter() as ChildProcess;
  const controller = new AbortController();
  const respond = vi.fn();
  let current = true;
  const scope = new NativeApprovalRequests({
    process: proc, panelId: 'p', providerId: 'hermes', signal: controller.signal,
    handler, isCurrent: () => current,
  });
  const toolCall: NativeApprovalRequest['toolCall'] = { id: 'tool', name: 'Edit', input: {}, status: 'running' };
  const request = (id: string | number = 77, policy: NativeApprovalRequest['defaultDecision'] = 'ask') => {
    scope.request(id, toolCall, policy, respond);
  };
  return { proc, controller, respond, scope, request, replace: () => { current = false; } };
}

describe('native request ownership', () => {
  it('holds an empty-input tool until one matching native decision arrives', async () => {
    const decision = deferred<boolean>();
    const handler = vi.fn((_request: NativeApprovalRequest) => decision.promise);
    const h = harness(handler);
    h.request(); h.request();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ nativeRequestId: 77, panelId: 'p', toolCall: { input: {} } });
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.scope.hasPending).toBe(true);
    decision.resolve(true);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledExactlyOnceWith('allow', h.proc));
    expect(h.scope.hasPending).toBe(false);
    h.scope.dispose();
  });

  it('a completed JSON-RPC ID may be reused for another request in the same turn', async () => {
    const first = deferred<boolean>(); const second = deferred<boolean>();
    const seen: NativeApprovalRequest[] = [];
    const h = harness(async request => { seen.push(request); return seen.length === 1 ? first.promise : second.promise; });
    h.request(77);
    first.resolve(true);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
    h.request(77);
    expect(seen).toHaveLength(2);
    expect(seen[1].id).not.toBe(seen[0].id);
    expect(h.respond).toHaveBeenCalledOnce();
    second.resolve(false);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledTimes(2));
    expect(h.respond.mock.calls.map(call => call[0])).toEqual(['allow', 'deny']);
    h.scope.dispose();
  });

  it.each(['abort', 'close', 'exit', 'error', 'dispose'] as const)('%s cancels once and ignores late approval', async event => {
    const decision = deferred<boolean>();
    let request!: NativeApprovalRequest;
    const h = harness(async r => { request = r; return decision.promise; });
    h.request();
    if (event === 'abort') { h.controller.abort(); }
    else if (event === 'dispose') { h.scope.dispose(); }
    else { h.proc.emit(event, event === 'error' ? new Error('closed') : 0); }
    expect(h.respond).toHaveBeenCalledExactlyOnceWith('cancelled', h.proc);
    expect(request.signal.aborted).toBe(true);
    decision.resolve(true);
    await decision.promise;
    await Promise.resolve();
    expect(h.respond).toHaveBeenCalledOnce();
    expect(h.proc.listenerCount('close')).toBe(0);
    expect(h.proc.listenerCount('exit')).toBe(0);
    expect(h.proc.listenerCount('error')).toBe(0);
  });

  it('a stale turn cannot write an allow response to a replacement', async () => {
    const decision = deferred<boolean>();
    const old = harness(() => decision.promise);
    old.request();
    old.replace();
    decision.resolve(true);
    await vi.waitFor(() => expect(old.respond).toHaveBeenCalledExactlyOnceWith('cancelled', old.proc));
    old.scope.dispose();
  });

  it('identical native IDs in different turns and panels remain independent', async () => {
    const a = deferred<boolean>(); const b = deferred<boolean>();
    const requests: NativeApprovalRequest[] = [];
    const first = harness(async r => { requests.push(r); return a.promise; });
    const second = harness(async r => { requests.push(r); return b.promise; });
    first.request(); second.request();
    expect(requests[0].id).not.toBe(requests[1].id);
    a.resolve(false);
    await vi.waitFor(() => expect(first.respond).toHaveBeenCalledExactlyOnceWith('deny', first.proc));
    expect(second.respond).not.toHaveBeenCalled();
    b.resolve(true);
    await vi.waitFor(() => expect(second.respond).toHaveBeenCalledExactlyOnceWith('allow', second.proc));
    first.scope.dispose(); second.scope.dispose();
  });

  it('handler failure denies and cancellation is a distinct native outcome', async () => {
    const failed = harness(async () => { throw new Error('card unavailable'); });
    failed.request();
    await vi.waitFor(() => expect(failed.respond).toHaveBeenCalledExactlyOnceWith('deny', failed.proc));
    const cancelled = harness(async () => 'cancelled');
    cancelled.request();
    await vi.waitFor(() => expect(cancelled.respond).toHaveBeenCalledExactlyOnceWith('cancelled', cancelled.proc));
    failed.scope.dispose(); cancelled.scope.dispose();
  });

  it('host can restrict auto-allowed tools, and cannot widen native read-only denial', async () => {
    const handler = vi.fn(async () => false);
    const h = harness(handler);
    h.request(1, 'allow');
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledExactlyOnceWith('deny', h.proc));
    h.request(2, 'deny');
    expect(handler).toHaveBeenCalledOnce();
    expect(h.respond).toHaveBeenLastCalledWith('deny', h.proc);
    h.scope.dispose();
  });

  it('missing host denies ask but preserves explicit autonomous policy', () => {
    const h = harness();
    h.request(1); h.request(2, 'allow');
    expect(h.respond.mock.calls.map(call => call[0])).toEqual(['deny', 'allow']);
    h.scope.dispose();
  });

  it('reports a hard policy denial without invoking approval or allowing an observer to widen it', () => {
    const onDecision = vi.fn(() => true);
    const handler = Object.assign(vi.fn(async () => true), { onDecision });
    const h = harness(handler);
    h.request(1, 'deny');
    expect(handler).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ defaultDecision: 'deny' }), 'deny');
    expect(h.respond).toHaveBeenCalledExactlyOnceWith('deny', h.proc);
    onDecision.mockImplementation(() => { throw new Error('observer unavailable'); });
    h.request(2, 'deny');
    expect(h.respond).toHaveBeenCalledTimes(2);
    expect(h.respond).toHaveBeenLastCalledWith('deny', h.proc);
    h.scope.dispose();
  });
});
