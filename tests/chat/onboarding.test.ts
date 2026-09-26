/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 32 — the host-side onboarding state: once-only tips, the
 * Getting-started card's visibility, and the "used an @-mention" flag.
 */
import { describe, it, expect } from 'vitest';
import {
  TIP_IDS, isTipId, isWizardStep, hasChosenMode, seenTips, markTipSeen,
  hideGettingStarted, recordAgentMention, onboardingSnapshot,
  TIPS_SEEN_KEY, GETTING_STARTED_KEY,
} from '../../src/chat/onboarding';

function store(initial: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    get<T>(k: string, d?: T): T { return (m.has(k) ? m.get(k) : d) as T; },
    async update(k: string, v: unknown) { m.set(k, v); },
  } as any;
}
const base = { tipsEnabled: true, hasCompletedSetup: false, agentReady: false, modeChosen: false, messagesSent: 0 };

describe('tip ids', () => {
  it('accepts only the five known tips', () => {
    expect(TIP_IDS).toEqual(['permission', 'mention', 'rewind', 'brainstorm', 'compaction']);
    expect(isTipId('rewind')).toBe(true);
    expect(isTipId('__proto__')).toBe(false);
    expect(isTipId(3)).toBe(false);
  });

  it('knows the three wizard steps', () => {
    expect(isWizardStep('mode')).toBe(true);
    expect(isWizardStep('finish')).toBe(false);
  });
});

describe('seen tips', () => {
  it('stores each tip once and drops junk already on disk', async () => {
    const s = store({ [TIPS_SEEN_KEY]: ['mention', 'bogus', 7] });
    expect(seenTips(s)).toEqual(['mention']);
    await markTipSeen(s, 'rewind');
    await markTipSeen(s, 'rewind');
    expect(s.map.get(TIPS_SEEN_KEY)).toEqual(['mention', 'rewind']);
  });

  it('treats a non-array value as nothing seen', () => {
    expect(seenTips(store({ [TIPS_SEEN_KEY]: 'rewind' }))).toEqual([]);
  });
});

describe('getting started', () => {
  it('shows for a brand-new user and remembers that decision', async () => {
    const s = store();
    const snap = await onboardingSnapshot({ store: s, ...base });
    expect(snap.gettingStarted).toEqual({ items: { connect: false, mode: false, task: false, mention: false } });
    expect(s.map.get(GETTING_STARTED_KEY)).toBe('show');
  });

  it('never shows for someone who used Mysti before it existed', async () => {
    const s = store();
    const snap = await onboardingSnapshot({ store: s, ...base, hasCompletedSetup: true });
    expect(snap.gettingStarted).toBeNull();
    expect(s.map.get(GETTING_STARTED_KEY)).toBe('hidden');
  });

  it('keeps showing after the first answer if it was decided before it', async () => {
    const s = store({ [GETTING_STARTED_KEY]: 'show' });
    const snap = await onboardingSnapshot({ store: s, ...base, hasCompletedSetup: true, messagesSent: 1 });
    expect(snap.gettingStarted?.items.task).toBe(true);
  });

  it('stops rendering once hidden or once every item is done', async () => {
    const s = store();
    await hideGettingStarted(s);
    expect((await onboardingSnapshot({ store: s, ...base })).gettingStarted).toBeNull();
    const t = store({ [GETTING_STARTED_KEY]: 'show' });
    await recordAgentMention(t);
    const done = await onboardingSnapshot({ store: t, ...base, agentReady: true, modeChosen: true, messagesSent: 3 });
    expect(done.gettingStarted).toBeNull();
  });

  it('reports tips enabled and seen', async () => {
    const snap = await onboardingSnapshot({ store: store({ [TIPS_SEEN_KEY]: ['permission'] }), ...base, tipsEnabled: false });
    expect(snap.tips).toEqual({ enabled: false, seen: ['permission'] });
  });

  it('treats a non-number message count as zero', async () => {
    const snap = await onboardingSnapshot({ store: store(), ...base, messagesSent: undefined as unknown as number });
    expect(snap.gettingStarted?.items.task).toBe(false);
  });
});

describe('hasChosenMode', () => {
  it('is true only when the user set mode or access themselves', () => {
    const cfg = (g: Record<string, unknown>) => ({ inspect: (k: string) => (k in g ? { globalValue: g[k] } : undefined) });
    expect(hasChosenMode(cfg({}))).toBe(false);
    expect(hasChosenMode(cfg({ accessLevel: 'ask-permission' }))).toBe(true);
    expect(hasChosenMode(cfg({ defaultMode: 'quick-plan' }))).toBe(true);
  });
});
