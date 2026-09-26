import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleWithin } from '../../src/utils/settleWithin';

describe('bounded discovery waits', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns successful probe values and immediately releases their timers', async () => {
    await expect(settleWithin(Promise.resolve({ ready: true }), 4000)).resolves.toEqual({ ready: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps a rejected probe to null and releases its timer', async () => {
    await expect(settleWithin(Promise.reject(new Error('CLI missing')), 6000)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a hung probe at its deadline, preserving the full wait before then', async () => {
    let settled = false;
    const pending = settleWithin(new Promise<never>(() => {}), 4000).then(value => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(3999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes a late rejection after timing out without changing the completed result', async () => {
    let reject!: (error: Error) => void;
    const probe = new Promise<string>((_, fail) => { reject = fail; });
    const pending = settleWithin(probe, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeNull();
    reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accumulate timers across concurrent cached provider probes', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => settleWithin(Promise.resolve(index), 6000)));
    expect(results).toHaveLength(100);
    expect(results.at(-1)).toBe(99);
    expect(vi.getTimerCount()).toBe(0);
  });
});
