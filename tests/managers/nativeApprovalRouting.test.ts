import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { NativeApprovalHost, NativeApprovalRequest } from '../../src/providers/base/IProvider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const managers: ProviderManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) { manager.dispose(); } });

function harness() {
  const manager = new ProviderManager({
    subscriptions: [], extensionPath: '/mock/extension', extensionUri: vscode.Uri.file('/mock/extension'),
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as vscode.ExtensionContext);
  managers.push(manager);
  const host = (manager as unknown as { _nativeApprovalHost: NativeApprovalHost })._nativeApprovalHost;
  const controller = new AbortController();
  const request = (panelId = 'panel'): NativeApprovalRequest => ({
    id: `card-${panelId}`, nativeRequestId: 77, providerId: 'hermes', panelId,
    toolCall: { id: 'tool', name: 'Bash', input: {}, status: 'running' },
    defaultDecision: 'ask', signal: new AbortController().signal,
  });
  return { manager, host, controller, request };
}

describe('native approval handler routing', () => {
  it('captures the host panel scope at turn start', async () => {
    const h = harness();
    let current = 'original';
    const seen: string[] = [];
    const factory = vi.fn(() => {
      const captured = current;
      return async () => { seen.push(captured); return false; };
    });
    h.manager.setNativeApprovalHandler({ handlerForPanel: factory });
    const handler = h.host.handlerForPanel('panel', h.controller.signal)!;
    expect(factory).toHaveBeenCalledOnce();
    current = 'replacement';
    await handler(h.request());
    expect(seen).toEqual(['original']);
    h.controller.abort();
  });

  it('child registration outranks global, and disposed old registrations never inherit a replacement', async () => {
    const h = harness();
    const global = vi.fn(async () => true);
    h.manager.setNativeApprovalHandler(global);
    const old = h.manager.setNativeApprovalHandlerForPanel('child', async () => true);
    const oldHandler = h.host.handlerForPanel('child', h.controller.signal)!;
    const replacement = vi.fn(async () => false);
    h.manager.setNativeApprovalHandlerForPanel('child', replacement);
    old.dispose();
    expect(await oldHandler(h.request('child'))).toBe('cancelled');
    const handler = h.host.handlerForPanel('child', new AbortController().signal)!;
    expect(await handler(h.request('child'))).toBe(false);
    expect(replacement).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();
  });

  it.each(['panel registration', 'global registration', 'Stop', 'turn end', 'manager disposal'] as const)(
    '%s aborts a hanging callback and ignores its eventual approval', async reason => {
      const h = harness();
      const decision = deferred<boolean>();
      let callbackRequest!: NativeApprovalRequest;
      const handler = async (request: NativeApprovalRequest) => { callbackRequest = request; return decision.promise; };
      const registration = reason === 'panel registration'
        ? h.manager.setNativeApprovalHandlerForPanel('panel', handler)
        : h.manager.setNativeApprovalHandler(handler);
      const captured = h.host.handlerForPanel('panel', h.controller.signal)!;
      const pending = captured(h.request());
      expect(callbackRequest.signal.aborted).toBe(false);
      if (reason.endsWith('registration')) { registration.dispose(); }
      else if (reason === 'Stop') { h.manager.cancelRequest('panel'); }
      else if (reason === 'turn end') { h.controller.abort(); }
      else { h.manager.dispose(); }
      expect(await pending).toBe('cancelled');
      expect(callbackRequest.signal.aborted).toBe(true);
      decision.resolve(true);
      expect(await pending).toBe('cancelled');
    },
  );

  it('global replacement cancellation leaves an independently registered child alive', async () => {
    const h = harness();
    const childDecision = deferred<boolean>();
    let childRequest!: NativeApprovalRequest;
    const old = h.manager.setNativeApprovalHandler(async () => true);
    h.manager.setNativeApprovalHandlerForPanel('child', async request => {
      childRequest = request; return childDecision.promise;
    });
    const child = h.host.handlerForPanel('child', h.controller.signal)!(h.request('child'));
    const replacement = vi.fn(async () => false);
    h.manager.setNativeApprovalHandler(replacement);
    old.dispose();
    expect(childRequest.signal.aborted).toBe(false);
    childDecision.resolve(true);
    expect(await child).toBe(true);
    expect(await h.host.handlerForPanel('panel', new AbortController().signal)!(h.request())).toBe(false);
    expect(replacement).toHaveBeenCalledOnce();
  });

  it('missing panel in an installed host fails closed without invoking a global fallback', async () => {
    const h = harness();
    h.manager.setNativeApprovalHandler({ handlerForPanel: () => undefined });
    expect(await h.host.handlerForPanel('closed', h.controller.signal)!(h.request('closed'))).toBe(false);
  });

  it.each([true, false])('normal decision %s also releases the callback signal', async approved => {
    const h = harness();
    let callbackRequest!: NativeApprovalRequest;
    h.manager.setNativeApprovalHandler(async request => { callbackRequest = request; return approved; });
    const result = await h.host.handlerForPanel('panel', h.controller.signal)!(h.request());
    expect(result).toBe(approved);
    expect(callbackRequest.signal.aborted).toBe(true);
  });

  it('capturing parent relays does not replace its turn or cancel sibling requests', async () => {
    const h = harness();
    const decision = deferred<boolean>();
    const requests: NativeApprovalRequest[] = [];
    h.manager.setNativeApprovalHandler(async request => { requests.push(request); return decision.promise; });
    const parent = h.host.handlerForPanel('panel', h.controller.signal)!(h.request());
    const run = new AbortController();
    const firstRelay = h.manager.captureNativeApprovalHandler('panel', run.signal)!;
    const secondRelay = h.manager.captureNativeApprovalHandler('panel', run.signal)!;
    const first = firstRelay(h.request('first'));
    const second = secondRelay(h.request('second'));
    expect(requests.map(request => request.signal.aborted)).toEqual([false, false, false]);
    run.abort();
    expect(await first).toBe('cancelled');
    expect(await second).toBe('cancelled');
    expect(requests[0].signal.aborted).toBe(false);
    decision.resolve(true);
    expect(await parent).toBe(true);
  });
});
