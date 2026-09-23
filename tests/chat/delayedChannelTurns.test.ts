import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedChannelTurns, formatQueuedChannelTurn } from '../../src/chat/DelayedChannelTurns';

describe('delayed channel turns', () => {
  let turns: DelayedChannelTurns;
  beforeEach(() => { vi.useFakeTimers(); turns = new DelayedChannelTurns(); });
  afterEach(() => { turns.dispose(); vi.useRealTimers(); });

  it('cancels only the exact panel and invalidates old work before rescheduling', async () => {
    const first = vi.fn();
    const other = vi.fn();
    const fresh = vi.fn();
    const wasCurrent = turns.capture('panel');
    turns.schedule('panel', first, 500);
    turns.schedule('panel-child', other, 500);
    turns.cancelPanel('panel');
    turns.schedule('panel', fresh, 500);
    expect(wasCurrent()).toBe(false);
    expect(turns.has('panel-child')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(first).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    expect(fresh).toHaveBeenCalledOnce();
    expect(turns.has('panel')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('begins each turn on its own scope even if the previous one was never cancelled', async () => {
    const stale = vi.fn();
    const previous = turns.capture('panel');
    turns.schedule('panel', stale, 500);
    turns.reservePreparation('panel');
    const next = turns.begin('panel');
    expect(previous()).toBe(false);
    expect(previous.signal.aborted).toBe(true);
    expect(next()).toBe(true);
    expect(next.signal).not.toBe(previous.signal);
    expect(next.signal.aborted).toBe(false);
    expect(turns.has('panel')).toBe(false);
    // Later captures inside the same turn join it rather than rotating it.
    expect(turns.capture('panel').signal).toBe(next.signal);
    await vi.advanceTimersByTimeAsync(500);
    expect(stale).not.toHaveBeenCalled();
  });

  it('owns at most one callback per panel', async () => {
    const old = vi.fn();
    const current = vi.fn();
    turns.schedule('panel', old, 200);
    turns.schedule('panel', current, 500);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it('keeps replacement preparation busy when an older owner releases', () => {
    const releaseOld = turns.reservePreparation('panel');
    const releaseOther = turns.reservePreparation('other');
    turns.cancelPanel('panel');
    const releaseNew = turns.reservePreparation('panel');
    releaseOld();
    expect(turns.has('panel')).toBe(true);
    expect(turns.has('other')).toBe(true);
    releaseNew();
    expect(turns.has('panel')).toBe(false);
    releaseOther();
    expect(turns.has('other')).toBe(false);
  });

  it('disposes every timer and refuses new work', async () => {
    const run = vi.fn();
    const isCurrent = turns.capture('panel');
    turns.schedule('panel', run, 500);
    turns.schedule('other', run, 500);
    turns.reservePreparation('preparing');
    turns.dispose();
    turns.schedule('new', run, 500);
    turns.reservePreparation('new');
    expect(isCurrent()).toBe(false);
    expect(turns.has('preparing')).toBe(false);
    expect(turns.has('new')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();
  });

  it('aborts a captured scope signal exactly when that scope is cancelled or disposed', () => {
    const old = turns.capture('panel');
    const other = turns.capture('other');
    const seen: boolean[] = [];
    old.signal.addEventListener('abort', () => seen.push(old()));
    turns.cancelPanel('panel');
    // Listeners run synchronously and already observe the revoked scope.
    expect(seen).toEqual([false]);
    expect(old.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    const fresh = turns.capture('panel');
    expect(fresh.signal.aborted).toBe(false);
    turns.dispose();
    expect(fresh.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(true);
    const late = turns.capture('panel');
    expect(late()).toBe(false);
    expect(late.signal.aborted).toBe(true);
  });

  it('keeps complete attributed inputs in arrival order', () => {
    const longContent = `  first\n${'x'.repeat(300)}\n`;
    expect(formatQueuedChannelTurn([
      { channelId: 'one', channelName: 'Telegram', sender: 'Alice', content: longContent, timestamp: 1 },
      { channelId: 'two', channelName: 'WhatsApp', content: 'second', timestamp: 2 },
    ])).toBe(`[Via Telegram from Alice]: ${longContent}\n\n---\n\n[Via WhatsApp]: second`);
  });
});
