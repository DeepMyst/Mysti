/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * BoostManager (Plan 24 Phases 0–2) — one switch that applies the measured
 * defaults instead of the stock ones, and records what each turn actually
 * cost so the effect is visible.
 *
 * Three responsibilities, deliberately small:
 *  1. OVERLAY — effective values for compaction settings, consumed by
 *     CompactionManager's loaders. Overlay, not persistence: nothing is ever
 *     written to the user's settings, and a value the user set EXPLICITLY
 *     (any scope) always wins over the overlay. Toggling Boost off restores
 *     stock behaviour instantly.
 *  2. LEDGER — per-turn usage records (Phase 1 sensor). Session totals in
 *     memory, lifetime persisted to globalState. Records only; never gates.
 *  3. ROUTER — owns the ModelRouter (Phase 2) so ChatViewProvider needs a
 *     single seam.
 *
 * Authority invariant (Plan 24): Boost NEVER touches mode, accessLevel,
 * autonomy, or permission settings — it only tunes spend-shaped knobs, and its
 * own keys are machine-scoped so a workspace cannot flip them.
 */

import * as vscode from 'vscode';
import {
  BoostProfile,
  BoostSnapshot,
  BoostTotals,
  BoostTurnRecord,
} from '../types';
import { ModelRouter, SuggestedTier } from '../services/ModelRouter';
import { EffortLevel } from '../types';

const LEDGER_KEY = 'mysti.boost.ledger.v1';

const PROFILES: readonly BoostProfile[] = ['economy', 'balanced', 'quality'];

/**
 * Effective compaction threshold per profile (percent of context window at
 * which compaction triggers). Grounded in the Plan 24 evidence base: context
 * per round-trip is the dominant cost and post-compaction context measured
 * ~26k against ~990k before, repaying the summary write within one round-trip.
 * All three sit below the stock default (75) — Boost on means compact sooner.
 */
const PROFILE_THRESHOLDS: Record<BoostProfile, number> = {
  economy: 35,
  balanced: 45,
  quality: 60,
};

/**
 * Plan 24 Phase 5 — cold-resume interception thresholds.
 *
 * A session left idle past the provider cache TTL and then resumed re-writes
 * its whole prefix at the 2x cache-WRITE rate instead of reading it back at
 * 0.1x. Measured: ~9% of total spend and 52% of ALL cache-write tokens came
 * from these. One hour matches the 1h cache TTL the measurement was taken
 * against, so anything past it has certainly expired.
 *
 * Both conditions must hold: a small session re-writes a small prefix, and the
 * interception (a compaction) is only worth its own summary cost above a real
 * context size.
 */
const COLD_RESUME_IDLE_MS = 60 * 60 * 1000;
const COLD_RESUME_MIN_CONTEXT_TOKENS = 60_000;

/** Max lanes dispatched in parallel by the Phase 4 fan-out scheduler. */
const FANOUT_MAX_LANES: Record<BoostProfile, number> = {
  economy: 3,
  balanced: 3,
  quality: 4,
};

/**
 * Config access seam. The default reads live from
 * `vscode.workspace.getConfiguration('mysti')` on every call (the
 * CoordinatorModelClient thunk pattern — no cache to invalidate); tests inject
 * a plain object.
 */
export interface BoostConfigReader {
  get<T>(key: string, fallback: T): T;
  /** True when the user explicitly set the key at ANY scope (global/workspace/folder). */
  isExplicitlySet(key: string): boolean;
}

function defaultConfigReader(): BoostConfigReader {
  return {
    get<T>(key: string, fallback: T): T {
      return vscode.workspace.getConfiguration('mysti').get<T>(key, fallback);
    },
    isExplicitlySet(key: string): boolean {
      const info = vscode.workspace.getConfiguration('mysti').inspect(key);
      if (!info) { return false; }
      return info.globalValue !== undefined
        || info.workspaceValue !== undefined
        || info.workspaceFolderValue !== undefined;
    },
  };
}

interface PersistedLedger {
  lifetime: BoostTotals;
  anyEstimated: boolean;
}

function emptyTotals(): BoostTotals {
  return {
    turns: 0, roundTrips: 0, contextTokens: 0, outputTokens: 0, delegations: 0,
    redundantToolCalls: 0, mergeableRoundTrips: 0, coldResumesIntercepted: 0,
  };
}

export class BoostManager {
  private readonly _cfg: () => BoostConfigReader;
  private readonly _router: ModelRouter;

  private _session: BoostTotals = emptyTotals();
  private _lifetime: BoostTotals = emptyTotals();
  /** Turns recorded but not yet merged into the persisted lifetime totals. */
  private _pendingDelta: BoostTotals = emptyTotals();
  private _sessionEstimated = false;
  private _lifetimeEstimated = false;
  private _pendingEstimated = false;
  /**
   * Last observed context fill per panel, for Phase 5 cold-resume detection.
   * The FILL (input + cache-read of the most recent turn), not a running total
   * — CompactionManager's CumulativeUsage accumulates across turns and is the
   * wrong quantity to compare against a context window.
   */
  private _panelActivity = new Map<string, { fill: number; at: number }>();
  /** Sum of context tokens across session turns that actually reported context. */
  private _sessionContextSum = 0;
  private _sessionContextTurns = 0;

  private readonly _onDidChange = new vscode.EventEmitter<BoostSnapshot>();
  /** Fires after every recorded turn and on mysti.boost.* config changes. */
  public readonly onDidChange = this._onDidChange.event;

  private _configDisposable: vscode.Disposable | undefined;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    configReader?: () => BoostConfigReader,
  ) {
    this._cfg = configReader ?? defaultConfigReader;
    this._router = new ModelRouter(() => ({ enabled: this.isEnabled(), profile: this.profile() }));

    const persisted = this._context.globalState.get<PersistedLedger>(LEDGER_KEY);
    if (persisted && persisted.lifetime) {
      this._lifetime = { ...emptyTotals(), ...persisted.lifetime };
      this._lifetimeEstimated = !!persisted.anyEstimated;
    }

    // Only wired when running against the real vscode API surface; the test
    // mock may not provide onDidChangeConfiguration.
    const onCfg = vscode.workspace?.onDidChangeConfiguration;
    if (typeof onCfg === 'function') {
      this._configDisposable = onCfg((e: vscode.ConfigurationChangeEvent) => {
        if (e.affectsConfiguration('mysti.boost')) {
          console.log(`[Mysti] BoostManager: Config updated - enabled=${this.isEnabled()}, profile=${this.profile()}`);
          this._onDidChange.fire(this.snapshot());
        }
      });
    }
  }

  // ---------------------------------------------------------------- settings

  public isEnabled(): boolean {
    return this._cfg().get<boolean>('boost.enabled', false);
  }

  public profile(): BoostProfile {
    const raw = this._cfg().get<string>('boost.profile', 'balanced');
    return (PROFILES as readonly string[]).includes(raw) ? (raw as BoostProfile) : 'balanced';
  }

  // ----------------------------------------------------------------- overlay

  /**
   * Effective compaction threshold override, or undefined to leave the stock
   * read in place. Undefined when Boost is off OR the user explicitly set
   * `mysti.compaction.threshold` themselves — an explicit user value always
   * beats the overlay.
   */
  public compactionThreshold(): number | undefined {
    if (!this.isEnabled()) { return undefined; }
    if (this._cfg().isExplicitlySet('compaction.threshold')) { return undefined; }
    return PROFILE_THRESHOLDS[this.profile()];
  }

  /**
   * Effective smart-compaction override (true = on), or undefined to leave the
   * stock read in place. Same explicit-user-wins rule as the threshold. Smart
   * compaction itself still fail-opens to the native path when the DeepMyst
   * entitlement is absent (SmartCompactor.isActive), so forcing it on is safe.
   */
  public smartCompactionEnabled(): boolean | undefined {
    if (!this.isEnabled()) { return undefined; }
    if (this._cfg().isExplicitlySet('compaction.smart.enabled')) { return undefined; }
    return true;
  }

  // ------------------------------------------------------------------ router

  /** Tier suggestion for an UN-tiered delegation (undefined = don't route). */
  public suggestTier(task: string): SuggestedTier | undefined {
    return this._router.suggestTier(task);
  }

  /** Effort override for a delegation lane (undefined = inherit parent). */
  public delegationEffort(
    tier: SuggestedTier | undefined,
    parentEffort?: EffortLevel,
  ): EffortLevel | undefined {
    return this._router.delegationEffort(tier, parentEffort);
  }

  // ------------------------------------------------- phase 3: round-trip work

  /**
   * Whether to batch the leading READ-ONLY run of a mixed native tool-call
   * batch (Plan 24 Phase 3). Off ⇒ the stock behaviour: a batch is only run in
   * parallel when EVERY call is read-only, otherwise just the first call runs
   * and the rest are re-issued a round-trip later.
   *
   * This never widens what may run — the prefix is read-only by construction,
   * so no gated or mutating call is affected. It only stops throwing away
   * reads the model already asked for.
   */
  public batchReadOnlyPrefix(): boolean {
    return this.isEnabled();
  }

  // ------------------------------------------------ phase 4: fan-out policy

  /** Lane cap for one parallel frontier. Concurrency measured saturating ~3-4. */
  public maxLanes(): number {
    return FANOUT_MAX_LANES[this.profile()];
  }

  /**
   * Whether to refuse dispatching a plan that is a single lane. Serial
   * delegation measured 0.98x — SLOWER than answering inline — so a one-node
   * "DAG" costs a full extra agent spawn to lose time. Only meaningful with
   * Boost on; without it the orchestrator keeps its existing behaviour.
   */
  public refuseSingleLane(): boolean {
    return this.isEnabled();
  }

  /**
   * Whether to run one read-only verification pass before merging results from
   * lanes that ACTUALLY ran in parallel. Parallel lanes never saw each other's
   * edits, so contradictions only surface after the merge — and the `quality`
   * profile is exactly the posture that should pay a delegation to catch them.
   * Costs one read-only delegation per run, so it is off in `economy`.
   */
  public verifyParallelLanes(): boolean {
    return this.isEnabled() && this.profile() !== 'economy';
  }

  // ------------------------------------------------- phase 5: cold resumes

  /**
   * Whether this turn is resuming a session that has gone cold on a large
   * context — the case that measured 52% of all cache-write tokens. Pure
   * predicate: the caller decides what to do about it.
   */
  public isColdResume(panelId: string, nowMs: number = Date.now()): boolean {
    if (!this.isEnabled()) { return false; }
    const last = this._panelActivity.get(panelId);
    if (!last) { return false; }
    return (nowMs - last.at) >= COLD_RESUME_IDLE_MS
      && last.fill >= COLD_RESUME_MIN_CONTEXT_TOKENS;
  }

  /** Last observed fill/idle for a panel — for logging and tests. */
  public panelActivity(panelId: string): { fill: number; at: number } | undefined {
    const a = this._panelActivity.get(panelId);
    return a ? { ...a } : undefined;
  }

  /**
   * Forget a panel's activity — call after intercepting, and on panel dispose,
   * so one cold resume cannot fire twice off the same stale reading.
   */
  public clearPanelActivity(panelId: string): void {
    this._panelActivity.delete(panelId);
  }

  // ------------------------------------------------------------------ ledger

  /**
   * Record one completed turn. Sensor only: tolerates missing usage, never
   * throws, never gates. Records regardless of whether Boost is enabled so
   * that turning Boost on later has a before/after baseline.
   */
  public recordTurn(rec: BoostTurnRecord): void {
    const ctx = Math.max(0, rec.contextTokens ?? 0);
    const out = Math.max(0, rec.outputTokens ?? 0);
    // A completed turn implies at least one model round-trip on either path.
    const rt = Math.max(0, rec.roundTrips ?? 1);
    const del = Math.max(0, rec.delegations ?? 0);
    const redundant = Math.max(0, rec.redundantToolCalls ?? 0);
    const mergeable = Math.max(0, rec.mergeableRoundTrips ?? 0);
    const coldResume = rec.coldResumeIntercepted ? 1 : 0;

    for (const t of [this._session, this._lifetime, this._pendingDelta]) {
      t.turns += 1;
      t.roundTrips += rt;
      t.contextTokens += ctx;
      t.outputTokens += out;
      t.delegations += del;
      t.redundantToolCalls += redundant;
      t.mergeableRoundTrips += mergeable;
      t.coldResumesIntercepted += coldResume;
    }
    if (rec.contextTokens !== undefined && rec.contextTokens > 0) {
      this._sessionContextSum += ctx;
      this._sessionContextTurns += 1;
      // Only a KNOWN fill updates panel activity; an unknown-usage turn must
      // not reset the clock, or a backend that reports nothing would make
      // every session look permanently warm.
      if (rec.panelId) {
        this._panelActivity.set(rec.panelId, { fill: ctx, at: Date.now() });
      }
    }
    if (rec.estimated) {
      this._sessionEstimated = true;
      this._lifetimeEstimated = true;
      this._pendingEstimated = true;
    }

    this._persist();
    this._onDidChange.fire(this.snapshot());
  }

  public snapshot(): BoostSnapshot {
    return {
      enabled: this.isEnabled(),
      profile: this.profile(),
      session: { ...this._session },
      lifetime: { ...this._lifetime },
      sessionMeanContextTokens: this._sessionContextTurns > 0
        ? Math.round(this._sessionContextSum / this._sessionContextTurns)
        : 0,
      estimated: this._sessionEstimated,
      lifetimeEstimated: this._lifetimeEstimated,
    };
  }

  /** Reset session totals (lifetime persists). Boost "session" = since reset/activation. */
  public resetSession(): void {
    this._session = emptyTotals();
    this._sessionContextSum = 0;
    this._sessionContextTurns = 0;
    this._sessionEstimated = false;
    this._onDidChange.fire(this.snapshot());
  }

  /**
   * Merge this instance's un-persisted turns into whatever is CURRENTLY stored,
   * rather than overwriting with our own running total. VS Code globalState is
   * shared across windows, and each window snapshots it once at construction —
   * a blind write makes concurrent windows clobber each other's lifetime totals
   * (last writer wins, the other window's turns vanish). Read-modify-write with
   * a delta converges instead.
   *
   * Assumes `globalState.get()` reflects this instance's own pending
   * `update()` — true for VS Code's Memento, which updates its in-memory cache
   * synchronously and flushes to disk in the background. If it did not, our
   * previous contribution would be missing from `stored` and the delta would
   * under-count (never double-count).
   */
  private _persist(): void {
    let stored: BoostTotals = emptyTotals();
    let storedEstimated = false;
    try {
      const cur = this._context.globalState.get<PersistedLedger>(LEDGER_KEY);
      if (cur && cur.lifetime) {
        stored = { ...emptyTotals(), ...cur.lifetime };
        storedEstimated = !!cur.anyEstimated;
      }
    } catch {
      // Unreadable store: fall back to our own accumulation below.
      stored = { ...this._lifetime };
      storedEstimated = this._lifetimeEstimated;
    }
    const merged: BoostTotals = {
      turns: stored.turns + this._pendingDelta.turns,
      roundTrips: stored.roundTrips + this._pendingDelta.roundTrips,
      contextTokens: stored.contextTokens + this._pendingDelta.contextTokens,
      outputTokens: stored.outputTokens + this._pendingDelta.outputTokens,
      delegations: stored.delegations + this._pendingDelta.delegations,
      redundantToolCalls: stored.redundantToolCalls + this._pendingDelta.redundantToolCalls,
      mergeableRoundTrips: stored.mergeableRoundTrips + this._pendingDelta.mergeableRoundTrips,
      coldResumesIntercepted: stored.coldResumesIntercepted + this._pendingDelta.coldResumesIntercepted,
    };
    const mergedEstimated = storedEstimated || this._pendingEstimated;
    // Defensive COPY: an in-memory Memento (VS Code's cache, and the test
    // fake) stores the reference we hand it. Sharing `merged` with _lifetime
    // means the next turn's increments mutate the persisted value in place,
    // and the read-modify-write above then double-counts its own delta.
    const payload: PersistedLedger = { lifetime: { ...merged }, anyEstimated: mergedEstimated };
    // Adopt the merged view so our own snapshot reflects other windows too.
    this._lifetime = merged;
    this._lifetimeEstimated = mergedEstimated;
    this._pendingDelta = emptyTotals();
    this._pendingEstimated = false;
    try {
      const result = this._context.globalState.update(LEDGER_KEY, payload);
      if (result && typeof (result as Thenable<void>).then === 'function') {
        (result as Thenable<void>).then(undefined, (err: unknown) => {
          console.warn('[Mysti] BoostManager: failed to persist ledger', err);
        });
      }
    } catch (err) {
      console.warn('[Mysti] BoostManager: failed to persist ledger', err);
    }
  }

  public dispose(): void {
    this._configDisposable?.dispose();
    this._onDidChange.dispose();
  }
}
