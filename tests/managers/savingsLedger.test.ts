/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for SavingsLedger (Plan 08 savings UI).
 */
import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { SavingsLedger } from '../../src/managers/SavingsLedger';

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
  } as unknown as vscode.ExtensionContext;
}

describe('SavingsLedger', () => {
  it('accumulates session, lifetime and per-kind totals and fires on change', () => {
    const ledger = new SavingsLedger(makeContext());
    const fired: number[] = [];
    ledger.onDidChange(s => fired.push(s.session.usd));
    ledger.record({ kind: 'cheap-model', tokensSaved: 1000, usdSaved: 0.05, estimated: false });
    ledger.record({ kind: 'cache-timing', tokensSaved: 500, usdSaved: 0.01, estimated: true });

    const snap = ledger.snapshot(7, 10);
    expect(snap.session.usd).toBeCloseTo(0.06);
    expect(snap.session.tokens).toBe(1500);
    expect(snap.byKind['cheap-model']?.usd).toBeCloseTo(0.05);
    expect(snap.estimated).toBe(true);
    expect(snap.freeRemaining).toBe(7);
    expect(snap.freeLimit).toBe(10);
    expect(fired).toHaveLength(2);
  });

  it('persists lifetime across instances but resets session', () => {
    const ctx = makeContext();
    const a = new SavingsLedger(ctx);
    a.record({ kind: 'prune', tokensSaved: 200, usdSaved: 0.02, estimated: false });

    const b = new SavingsLedger(ctx);
    expect(b.snapshot().lifetime.usd).toBeCloseTo(0.02);
    expect(b.snapshot().session.usd).toBe(0);
  });

  it('ignores zero events and clamps negatives', () => {
    const l = new SavingsLedger(makeContext());
    l.record({ kind: 'prune', tokensSaved: 0, usdSaved: 0, estimated: false });
    l.record({ kind: 'prune', tokensSaved: 0, usdSaved: -5, estimated: false });
    expect(l.snapshot().lifetime.usd).toBe(0);
  });

  it('resetSession clears session but keeps lifetime', () => {
    const l = new SavingsLedger(makeContext());
    l.record({ kind: 'cheap-model', tokensSaved: 100, usdSaved: 0.1, estimated: false });
    l.resetSession();
    expect(l.snapshot().session.usd).toBe(0);
    expect(l.snapshot().lifetime.usd).toBeCloseTo(0.1);
  });
});
