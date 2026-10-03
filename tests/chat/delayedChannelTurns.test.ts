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

  it('keeps complete attributed inputs in arrival order', () => {
    const longContent = `  first\n${'x'.repeat(300)}\n`;
    expect(formatQueuedChannelTurn([
      { channelId: 'one', channelName: 'Telegram', sender: 'Alice', content: longContent, timestamp: 1 },
      { channelId: 'two', channelName: 'WhatsApp', content: 'second', timestamp: 2 },
    ])).toBe(`[Via Telegram from Alice]: ${longContent}\n\n---\n\n[Via WhatsApp]: second`);
  });
});
