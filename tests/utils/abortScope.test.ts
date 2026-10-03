import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAbortScope } from '../../src/utils/abortScope';

afterEach(() => { vi.useRealTimers(); });

describe('createAbortScope', () => {
  it('propagates either signal and removes all listeners and deadlines on abort', () => {
    vi.useFakeTimers();
    for (const index of [0, 1]) {
      const inputs = [new AbortController(), new AbortController()];
      const scope = createAbortScope(inputs.map(input => input.signal), 60_000);
      const reason = new Error('cancelled');
      inputs[index].abort(reason);
      expect(scope.signal.aborted).toBe(true);
      expect(scope.signal.reason).toBe(reason);
      expect(inputs.map(input => getEventListeners(input.signal, 'abort').length)).toEqual([0, 0]);
      expect(vi.getTimerCount()).toBe(0);
      inputs[1 - index].abort(new Error('later cancellation'));
      expect(scope.signal.reason).toBe(reason);
    }
  });

  it('honors an already cancelled signal without retaining earlier listeners', () => {
    vi.useFakeTimers();
    const active = new AbortController();
    const stopped = new AbortController();
    stopped.abort('stopped');
    const scope = createAbortScope([active.signal, stopped.signal], 100);
    expect(scope.signal.reason).toBe('stopped');
    expect(getEventListeners(active.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases successful operations idempotently without aborting their signals', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const scopes = Array.from({ length: 100 }, () => {
      const scope = createAbortScope([caller.signal, caller.signal, undefined], 60_000);
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(1);
      scope.dispose();
      scope.dispose();
      return scope;
    });
    caller.abort();
    expect(scopes.every(scope => !scope.signal.aborted)).toBe(true);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts at the deadline and cleans up the caller listener', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const scope = createAbortScope([caller.signal], 500);
    await vi.advanceTimersByTimeAsync(499);
    expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason.name).toBe('TimeoutError');
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
