/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { NativeApprovalCards } from '../../src/chat/NativeApprovalCards';
import type { NativeApprovalRequest } from '../../src/providers/base/IProvider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const panels = new Map([['panel', {}], ['other', {}]]);
  const cards = new Set<string>();
  const answers = new Map<string, ReturnType<typeof deferred<boolean>>>();
  const request = vi.fn((native: NativeApprovalRequest) => {
    cards.add(native.id);
    const answer = deferred<boolean>();
    answers.set(native.id, answer);
    return answer.promise;
  });
  const cancelCard = vi.fn((id: string) => { cards.delete(id); answers.get(id)?.resolve(false); });
  const helper = new NativeApprovalCards({
    hasPanel: panelId => panels.has(panelId),
    captureScope: panelId => { const scope = panels.get(panelId); return () => panels.get(panelId) === scope; },
    request, cancelCard,
  });
  let sequence = 0;
  const native = (overrides: Partial<NativeApprovalRequest> = {}) => {
    const controller = new AbortController();
    const payload: NativeApprovalRequest = {
      id: 'host-' + (++sequence), nativeRequestId: 7, providerId: 'claude-code', panelId: 'panel',
      toolCall: { id: 'native-tool', name: 'Write', input: { path: 'file.ts' }, status: 'pending' },
      defaultDecision: 'ask', signal: controller.signal, ...overrides,
    };
    return { controller, payload };
  };
  return { helper, panels, cards, answers, request, cancelCard, native };
}

describe('native approval authority', () => {
  it.each([['allow', true], ['deny', false]] as const)('honors native %s without creating a card', async (defaultDecision, result) => {
    const h = harness();
    const { payload } = h.native({ defaultDecision });
    expect(await h.helper.handle(payload)).toBe(result);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.cancelCard).not.toHaveBeenCalled();
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
  });

  it.each(['allow', 'ask', 'deny'] as const)('denies %s when there is no owning panel', async defaultDecision => {
    const h = harness();
    const { payload } = h.native({ defaultDecision, panelId: 'closed' });
    expect(await h.helper.handle(payload)).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('does not let a captured handler approve a different panel', async () => {
    const h = harness();
    const handler = h.helper.handlerForPanel('panel')!;
    expect(await handler(h.native({ panelId: 'other', defaultDecision: 'allow' }).payload)).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('keeps a handler bound to its original panel scope', async () => {
    const h = harness();
    const handler = h.helper.handlerForPanel('panel')!;
    h.panels.set('panel', {});
    expect(await handler(h.native({ defaultDecision: 'allow' }).payload)).toBe('cancelled');
    expect(await h.helper.handle(h.native({ defaultDecision: 'allow' }).payload)).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each([true, false])('returns explicit user decision %s and cleans its card and listener', async approved => {
    const h = harness();
    const { payload } = h.native();
    const result = h.helper.handle(payload);
    expect(h.request).toHaveBeenCalledWith(payload);
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(1);
    h.answers.get(payload.id)!.resolve(approved);
    expect(await result).toBe(approved);
    expect(h.cards.size).toBe(0);
    expect(h.cancelCard).toHaveBeenCalledExactlyOnceWith(payload.id);
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
  });

  it.each(['reject', 'throw'] as const)('denies a permission adapter %s without retaining its card', async failure => {
    const h = harness();
    const { payload } = h.native();
    h.request.mockImplementation(request => {
      h.cards.add(request.id);
      if (failure === 'throw') { throw new Error('closed'); }
      return Promise.reject(new Error('closed'));
    });
    expect(await h.helper.handle(payload)).toBe(false);
    expect(h.cards.size).toBe(0);
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
  });
});

describe('native approval lifecycle', () => {
  it('does not create a card for an already aborted delivery', async () => {
    const h = harness();
    const { payload, controller } = h.native();
    controller.abort();
    expect(await h.helper.handle(payload)).toBe('cancelled');
    expect(h.request).not.toHaveBeenCalled();
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
  });

  it('cancels only its request even when another process reused the native RPC ID', async () => {
    const h = harness();
    const first = h.native();
    const second = h.native({ panelId: 'other' });
    const a = h.helper.handle(first.payload);
    const b = h.helper.handle(second.payload);
    first.controller.abort();
    expect(await a).toBe('cancelled');
    expect([...h.cards]).toEqual([second.payload.id]);
    h.answers.get(first.payload.id)!.resolve(true);
    h.answers.get(second.payload.id)!.resolve(true);
    expect(await b).toBe(true);
    expect(h.cancelCard.mock.calls.map(call => call[0])).toEqual([first.payload.id, second.payload.id]);
  });

  it.each(['abort', 'dispose'] as const)('observes synchronous %s during card creation and cancels after resolver installation', async action => {
    const h = harness();
    const { payload, controller } = h.native();
    const answer = deferred<boolean>();
    let installed = false;
    h.cancelCard.mockImplementation(id => {
      expect(installed).toBe(true);
      h.cards.delete(id);
      answer.resolve(false);
    });
    h.request.mockImplementation(request => {
      expect(getEventListeners(request.signal, 'abort')).toHaveLength(1);
      if (action === 'abort') { controller.abort(); } else { h.helper.dispose(); }
      h.cards.add(request.id);
      installed = true;
      return answer.promise;
    });
    expect(await h.helper.handle(payload)).toBe('cancelled');
    expect(await answer.promise).toBe(false);
    expect(h.cards.size).toBe(0);
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
    expect(h.cancelCard).toHaveBeenCalledExactlyOnceWith(payload.id);
  });

  it.each(['replace', 'remove'] as const)('cannot approve after the panel scope changes: %s', async action => {
    const h = harness();
    const { payload } = h.native();
    const pending = h.helper.handle(payload);
    if (action === 'replace') { h.panels.set('panel', {}); } else { h.panels.delete('panel'); }
    h.answers.get(payload.id)!.resolve(true);
    expect(await pending).toBe('cancelled');
    expect(h.cards.size).toBe(0);
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
  });

  it('cancels a card if its scope changes synchronously while it is being created', async () => {
    const h = harness();
    const { payload } = h.native();
    h.request.mockImplementation(request => {
      h.panels.set('panel', {});
      h.cards.add(request.id);
      return new Promise<boolean>(() => {});
    });
    expect(await h.helper.handle(payload)).toBe('cancelled');
    expect(h.cards.size).toBe(0);
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
  });

  it('cancellation wins over an answer already queued for promise delivery', async () => {
    const h = harness();
    const { payload, controller } = h.native();
    const result = h.helper.handle(payload);
    h.answers.get(payload.id)!.resolve(true);
    controller.abort();
    expect(await result).toBe('cancelled');
    expect(h.cards.size).toBe(0);
    expect(getEventListeners(payload.signal, 'abort')).toHaveLength(0);
  });

  it('shares an identical delivery and denies a conflicting owner without cancelling it', async () => {
    const h = harness();
    const { payload } = h.native();
    const first = h.helper.handle(payload);
    const repeated = h.helper.handle(payload);
    expect(await h.helper.handle(h.native({ id: payload.id }).payload)).toBe(false);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.cancelCard).not.toHaveBeenCalled();
    h.answers.get(payload.id)!.resolve(true);
    expect(await Promise.all([first, repeated])).toEqual([true, true]);
  });

  it('disposal settles every pending caller, detaches listeners, and rejects retained handlers', async () => {
    const h = harness();
    const retained = h.helper.handlerForPanel('panel')!;
    const first = h.native();
    const second = h.native({ panelId: 'other' });
    const results = [h.helper.handle(first.payload), h.helper.handle(second.payload)];
    h.helper.dispose();
    h.helper.dispose();
    expect(await Promise.all(results)).toEqual(['cancelled', 'cancelled']);
    expect(h.cards.size).toBe(0);
    expect(getEventListeners(first.payload.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(second.payload.signal, 'abort')).toHaveLength(0);
    expect(await retained(h.native({ defaultDecision: 'allow' }).payload)).toBe('cancelled');
    expect(await h.helper.handle(h.native().payload)).toBe('cancelled');
    expect(h.request).toHaveBeenCalledTimes(2);
  });
});
