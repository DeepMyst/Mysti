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
 * SavingsLedger (Plan 08 — smart compaction).
 *
 * Accumulates REALIZED savings from smart-compaction actions (cheaper model,
 * cache-aware timing, avoided compaction, free pruning, retrieval) and exposes
 * a snapshot for the always-on savings chip. Session totals live in memory;
 * lifetime totals persist in globalState. Honesty rule: only realized savings
 * are recorded (never projected), and `estimated` events (e.g. cache-timing)
 * are flagged so the UI can show "~".
 */

import * as vscode from 'vscode';
import type { SavingsEvent, SavingsKind, SavingsSnapshot, SavingsTotals } from '../types';

const LIFETIME_KEY = 'mysti.smartCompaction.savings.lifetime';

interface PersistedTotals {
  tokens: number;
  usd: number;
  byKind: Partial<Record<SavingsKind, SavingsTotals>>;
  anyEstimated: boolean;
}

export class SavingsLedger {
  private readonly _onDidChange = new vscode.EventEmitter<SavingsSnapshot>();
  /** Fires whenever savings are recorded, so the UI can refresh the chip. */
  readonly onDidChange = this._onDidChange.event;

  private _session: PersistedTotals = SavingsLedger._empty();
  private _lifetime: PersistedTotals;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._lifetime = this._loadLifetime();
  }

  /** Record a realized savings event. `usdSaved` is clamped to >= 0. */
  record(event: Omit<SavingsEvent, 'at'>): void {
    const usd = Math.max(0, event.usdSaved || 0);
    const tokens = Math.max(0, event.tokensSaved || 0);
    if (usd === 0 && tokens === 0) { return; }

    this._apply(this._session, event.kind, tokens, usd, event.estimated);
    this._apply(this._lifetime, event.kind, tokens, usd, event.estimated);
    void this._persistLifetime();

    console.log(`[Mysti] SavingsLedger: +${tokens} tok / $${usd.toFixed(4)} (${event.kind}${event.estimated ? ', est' : ''}); session $${this._session.usd.toFixed(4)}, lifetime $${this._lifetime.usd.toFixed(4)}`);
    this._onDidChange.fire(this.snapshot());
  }

  /** A snapshot for the webview, optionally enriched with free-tier quota. */
  snapshot(freeRemaining?: number, freeLimit?: number): SavingsSnapshot {
    return {
      session: { tokens: this._session.tokens, usd: round(this._session.usd) },
      lifetime: { tokens: this._lifetime.tokens, usd: round(this._lifetime.usd) },
      byKind: this._mergeByKind(),
      estimated: this._session.anyEstimated || this._lifetime.anyEstimated,
      freeRemaining,
      freeLimit,
    };
  }

  /** Reset the per-session total (e.g. on a new conversation). Lifetime persists. */
  resetSession(): void {
    this._session = SavingsLedger._empty();
    this._onDidChange.fire(this.snapshot());
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  // --- internals ---

  private _apply(t: PersistedTotals, kind: SavingsKind, tokens: number, usd: number, estimated: boolean): void {
    t.tokens += tokens;
    t.usd += usd;
    t.anyEstimated = t.anyEstimated || estimated;
    const k = t.byKind[kind] ?? { tokens: 0, usd: 0 };
    k.tokens += tokens;
    k.usd += usd;
    t.byKind[kind] = k;
  }

  private _mergeByKind(): Partial<Record<SavingsKind, SavingsTotals>> {
    const out: Partial<Record<SavingsKind, SavingsTotals>> = {};
    for (const src of [this._lifetime.byKind]) {
      for (const [kind, v] of Object.entries(src) as Array<[SavingsKind, SavingsTotals]>) {
        out[kind] = { tokens: v.tokens, usd: round(v.usd) };
      }
    }
    return out;
  }

  private _loadLifetime(): PersistedTotals {
    const raw = this._context.globalState.get<PersistedTotals>(LIFETIME_KEY);
    if (raw && typeof raw === 'object' && typeof raw.usd === 'number') {
      return {
        tokens: raw.tokens || 0,
        usd: raw.usd || 0,
        byKind: raw.byKind ?? {},
        anyEstimated: raw.anyEstimated ?? false,
      };
    }
    return SavingsLedger._empty();
  }

  private async _persistLifetime(): Promise<void> {
    try {
      await this._context.globalState.update(LIFETIME_KEY, this._lifetime);
    } catch (err) {
      console.warn(`[Mysti] SavingsLedger: failed to persist lifetime totals: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private static _empty(): PersistedTotals {
    return { tokens: 0, usd: 0, byKind: {}, anyEstimated: false };
  }
}

function round(usd: number): number {
  return Math.round(usd * 10000) / 10000;
}
