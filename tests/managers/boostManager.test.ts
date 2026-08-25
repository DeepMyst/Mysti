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
 * Plan 24 Phases 0–1 — BoostManager overlay precedence and the sensor ledger.
 * The invariant under test: the overlay NEVER beats a value the user set
 * explicitly, and returns undefined entirely when Boost is off — so the stock
 * configuration path is byte-identical with Boost disabled.
 */
import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { BoostManager, BoostConfigReader } from '../../src/managers/BoostManager';

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
  } as unknown as vscode.ExtensionContext;
}

function makeReader(opts: {
  enabled?: boolean;
  profile?: string;
  explicit?: string[];
}): BoostConfigReader {
  const explicit = new Set(opts.explicit ?? []);
  return {
    get<T>(key: string, fallback: T): T {
      if (key === 'boost.enabled') { return (opts.enabled ?? false) as unknown as T; }
      if (key === 'boost.profile') { return (opts.profile ?? 'balanced') as unknown as T; }
      return fallback;
    },
    isExplicitlySet(key: string): boolean {
      return explicit.has(key);
    },
  };
}

function make(opts: Parameters<typeof makeReader>[0], ctx = makeContext()): BoostManager {
  const reader = makeReader(opts);
  return new BoostManager(ctx, () => reader);
}

describe('BoostManager overlay', () => {
  it('returns undefined for everything when disabled', () => {
    const m = make({ enabled: false });
    expect(m.compactionThreshold()).toBeUndefined();
    expect(m.smartCompactionEnabled()).toBeUndefined();
  });

  it('applies profile thresholds when enabled', () => {
    expect(make({ enabled: true, profile: 'economy' }).compactionThreshold()).toBe(35);
    expect(make({ enabled: true, profile: 'balanced' }).compactionThreshold()).toBe(45);
    expect(make({ enabled: true, profile: 'quality' }).compactionThreshold()).toBe(60);
    expect(make({ enabled: true }).smartCompactionEnabled()).toBe(true);
  });

  it('an explicit user setting always beats the overlay — per key', () => {
    const m = make({ enabled: true, explicit: ['compaction.threshold'] });
    expect(m.compactionThreshold()).toBeUndefined();
    // The other overlay key still applies.
    expect(m.smartCompactionEnabled()).toBe(true);

    const m2 = make({ enabled: true, explicit: ['compaction.smart.enabled'] });
    expect(m2.smartCompactionEnabled()).toBeUndefined();
    expect(m2.compactionThreshold()).toBe(45);
  });

  it('falls back to balanced on an unknown profile string', () => {
    const m = make({ enabled: true, profile: 'turbo' });
    expect(m.profile()).toBe('balanced');
    expect(m.compactionThreshold()).toBe(45);
  });
});

describe('BoostManager ledger', () => {
  it('accumulates turns and tolerates missing usage', () => {
    const m = make({ enabled: true });
    m.recordTurn({ kind: 'cli', provider: 'test', estimated: false });
    m.recordTurn({
      kind: 'cli', provider: 'test', contextTokens: 100_000, outputTokens: 2_000,
      roundTrips: 1, estimated: false,
    });
    const s = m.snapshot();
    expect(s.session.turns).toBe(2);
    expect(s.session.roundTrips).toBe(2); // missing roundTrips defaults to 1
    expect(s.session.contextTokens).toBe(100_000);
    expect(s.session.outputTokens).toBe(2_000);
    // Mean is computed only over turns that reported context.
    expect(s.sessionMeanContextTokens).toBe(100_000);
    expect(s.estimated).toBe(false);
  });

  it('flags estimates and counts delegations (coordinator path)', () => {
    const m = make({ enabled: true });
    m.recordTurn({
      kind: 'coordinator', provider: 'test', contextTokens: 50_000,
      outputTokens: 1_000, delegations: 3, estimated: true,
    });
    const s = m.snapshot();
    expect(s.session.delegations).toBe(3);
    expect(s.estimated).toBe(true);
  });

  it('persists lifetime totals across instances; session starts fresh', () => {
    const ctx = makeContext();
    const a = make({ enabled: true }, ctx);
    a.recordTurn({ kind: 'cli', provider: 'test', contextTokens: 10_000, estimated: false });
    a.recordTurn({ kind: 'cli', provider: 'test', contextTokens: 30_000, estimated: false });

    const b = make({ enabled: true }, ctx);
    const s = b.snapshot();
    expect(s.lifetime.turns).toBe(2);
    expect(s.lifetime.contextTokens).toBe(40_000);
    expect(s.session.turns).toBe(0);
  });

  it('resetSession clears session but keeps lifetime', () => {
    const m = make({ enabled: true });
    m.recordTurn({ kind: 'cli', provider: 'test', contextTokens: 5_000, estimated: false });
    m.resetSession();
    const s = m.snapshot();
    expect(s.session.turns).toBe(0);
    expect(s.sessionMeanContextTokens).toBe(0);
    expect(s.lifetime.turns).toBe(1);
  });

  it('fires onDidChange on every record', () => {
    const m = make({ enabled: true });
    const seen: number[] = [];
    m.onDidChange(s => seen.push(s.session.turns));
    m.recordTurn({ kind: 'cli', provider: 'test', estimated: false });
    m.recordTurn({ kind: 'cli', provider: 'test', estimated: false });
    expect(seen).toEqual([1, 2]);
  });

  it('keeps unknown usage UNKNOWN rather than booking a measured zero', () => {
    // A coordinator run whose gateway never sent a usage frame, and a CLI turn
    // from a provider that synthesized its numbers, must both land as estimates
    // — the lifetime totals are persisted and shown, so a fabricated zero would
    // silently pass as measured.
    const m = make({ enabled: true });
    m.recordTurn({ kind: 'coordinator', provider: 'mysti', estimated: true });
    const s = m.snapshot();
    expect(s.session.turns).toBe(1);
    expect(s.session.contextTokens).toBe(0);
    // No context-reporting turn ⇒ no mean claimed at all.
    expect(s.sessionMeanContextTokens).toBe(0);
    expect(s.estimated).toBe(true);
  });

  it('records regardless of enabled state (baseline before opting in)', () => {
    const m = make({ enabled: false });
    m.recordTurn({ kind: 'cli', provider: 'test', contextTokens: 1_000, estimated: false });
    expect(m.snapshot().session.turns).toBe(1);
    expect(m.snapshot().enabled).toBe(false);
  });
});
