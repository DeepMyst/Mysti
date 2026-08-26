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
import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { clearMockConfig, setMockConfig, setMockConfigInspect } from '../helpers/mockVscode';
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

  it('merges concurrent windows instead of clobbering (read-modify-write)', () => {
    // globalState is shared across VS Code windows and each BoostManager reads
    // it once at construction. A blind write makes the last writer win and the
    // other window's turns vanish.
    const ctx = makeContext();
    const w1 = make({ enabled: true }, ctx);
    const w2 = make({ enabled: true }, ctx);
    w1.recordTurn({ kind: 'cli', provider: 'a', contextTokens: 1_000, estimated: false });
    w2.recordTurn({ kind: 'cli', provider: 'b', contextTokens: 2_000, estimated: false });
    w1.recordTurn({ kind: 'cli', provider: 'a', contextTokens: 4_000, estimated: false });

    const fresh = make({ enabled: true }, ctx);
    expect(fresh.snapshot().lifetime.turns).toBe(3);
    expect(fresh.snapshot().lifetime.contextTokens).toBe(7_000);
    // Each window still reports only its OWN session.
    expect(w2.snapshot().session.turns).toBe(1);
  });

  it('does not let a persisted total keep mutating after it is stored', () => {
    // Regression: the payload once shared its object with the in-memory
    // lifetime, so later turns mutated the stored value in place and the
    // read-modify-write double-counted its own delta.
    const ctx = makeContext();
    const m = make({ enabled: true }, ctx);
    m.recordTurn({ kind: 'cli', provider: 't', contextTokens: 10_000, estimated: false });
    m.recordTurn({ kind: 'cli', provider: 't', contextTokens: 30_000, estimated: false });
    expect(m.snapshot().lifetime.turns).toBe(2);
    expect(m.snapshot().lifetime.contextTokens).toBe(40_000);
  });

  it('scopes the estimate flag to the session, not forever', () => {
    // A lifetime-sticky flag marks every later clean session as estimated —
    // a warning that is always on is a warning nobody reads.
    const ctx = makeContext();
    const a = make({ enabled: true }, ctx);
    a.recordTurn({ kind: 'coordinator', provider: 'mysti', estimated: true });
    expect(a.snapshot().estimated).toBe(true);
    expect(a.snapshot().lifetimeEstimated).toBe(true);

    a.resetSession();
    expect(a.snapshot().estimated).toBe(false);
    expect(a.snapshot().lifetimeEstimated).toBe(true);

    // A brand-new session over the same store starts clean too.
    const b = make({ enabled: true }, ctx);
    b.recordTurn({ kind: 'cli', provider: 't', contextTokens: 5, estimated: false });
    expect(b.snapshot().estimated).toBe(false);
    expect(b.snapshot().lifetimeEstimated).toBe(true);
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

describe('BoostManager against the REAL config reader', () => {
  // The overlay-precedence tests above inject a fake BoostConfigReader, so they
  // cannot catch a wrong settings key or a dropped scope in the shipped
  // defaultConfigReader — which is the thing that actually decides whether a
  // user's explicit value survives. These construct BoostManager with NO
  // injected reader, so it goes through vscode.workspace.getConfiguration.
  beforeEach(() => { clearMockConfig(); });

  it('reads the boost keys under the mysti section', () => {
    setMockConfig('boost.enabled', true);
    setMockConfig('boost.profile', 'economy');
    const m = new BoostManager(makeContext());
    expect(m.isEnabled()).toBe(true);
    expect(m.profile()).toBe('economy');
    expect(m.compactionThreshold()).toBe(35);
    m.dispose();
  });

  it('is inert by default — no overlay when nothing is configured', () => {
    const m = new BoostManager(makeContext());
    expect(m.isEnabled()).toBe(false);
    expect(m.compactionThreshold()).toBeUndefined();
    expect(m.smartCompactionEnabled()).toBeUndefined();
    m.dispose();
  });

  it('detects an explicit user value at EVERY scope, per key', () => {
    for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue'] as const) {
      clearMockConfig();
      setMockConfig('boost.enabled', true);
      setMockConfigInspect('compaction.threshold', { [scope]: 80 });
      const m = new BoostManager(makeContext());
      expect(m.compactionThreshold(), scope).toBeUndefined();
      // The untouched key is still overlaid.
      expect(m.smartCompactionEnabled(), scope).toBe(true);
      m.dispose();
    }
  });

  it('a package.json default alone is NOT an explicit user value', () => {
    setMockConfig('boost.enabled', true);
    // inspect() reports only defaultValue — the user never set anything.
    setMockConfigInspect('compaction.threshold', { defaultValue: 75 });
    setMockConfigInspect('compaction.smart.enabled', { defaultValue: false });
    const m = new BoostManager(makeContext());
    expect(m.compactionThreshold()).toBe(45);
    expect(m.smartCompactionEnabled()).toBe(true);
    m.dispose();
  });
});
