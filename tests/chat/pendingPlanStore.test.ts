/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingPlanStore, type PendingPlanData } from '../../src/chat/PendingPlanStore';

const data = (messageId: string): PendingPlanData => ({ options: [], messageId, originalQuery: messageId });

describe('PendingPlanStore', () => {
  let store: PendingPlanStore;
  beforeEach(() => { vi.useFakeTimers(); store = new PendingPlanStore(); });
  afterEach(() => { store.dispose(); vi.useRealTimers(); });

  it('allows identical plan ids in different panels without sharing data', () => {
    store.set('a', 'same-plan', data('a-message'));
    store.set('b', 'same-plan', data('b-message'));
    expect(store.take('unknown-panel', 'same-plan')).toBeUndefined();
    expect(store.take('a', 'same-plan')?.messageId).toBe('a-message');
    expect(store.take('b', 'same-plan')?.messageId).toBe('b-message');
  });

  it('clears only the closing panel and keeps the other deadline and data live', async () => {
    const selected: string[] = [];
    for (const panel of ['a', 'b']) {
      store.set(panel, 'plan', data(panel));
      store.schedule(panel, 'plan', 1000, () => {
        selected.push(store.take(panel, 'plan')!.messageId);
      });
    }
    store.clearPanel('a');
    expect(vi.getTimerCount()).toBe(1);
    expect(store.take('a', 'plan')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(selected).toEqual(['b']);
  });

  it('cancels an old deadline when replacing the same plan', async () => {
    const expired = vi.fn();
    store.set('a', 'plan', data('old'));
    store.schedule('a', 'plan', 1000, expired);
    store.set('a', 'plan', data('new'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(expired).not.toHaveBeenCalled();
    expect(store.take('a', 'plan')?.messageId).toBe('new');
  });

  it('disposes every timer and selection, including selections with no timer', async () => {
    const expired = vi.fn();
    for (const panel of ['a', 'b']) {
      store.set(panel, 'timed', data(panel));
      store.schedule(panel, 'timed', 1000, expired);
      store.set(panel, 'manual', data(panel));
    }
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.take('a', 'manual')).toBeUndefined();
    expect(store.take('b', 'manual')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(expired).not.toHaveBeenCalled();
  });

  it('invalidates pending classification even before its first plan is stored', () => {
    const first = store.capture('a');
    const other = store.capture('b');
    store.clearPanel('a');
    const replacement = store.capture('a');
    expect(first()).toBe(false);
    expect(other()).toBe(true);
    expect(replacement()).toBe(true);
  });

  it('refuses plans and scopes arriving after disposal', () => {
    const current = store.capture('a');
    store.dispose();
    store.set('a', 'late', data('late'));
    store.schedule('a', 'late', 1000, vi.fn());
    expect(current()).toBe(false);
    expect(store.capture('a')()).toBe(false);
    expect(store.take('a', 'late')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
