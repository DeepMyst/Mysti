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
 * CapabilityLedger (Plan 20 Phase 6) — per-artifact health, and the aging that
 * keeps a growing library from quietly rotting.
 *
 * WHY `helped` AND `hurt` ARE NEVER AVERAGED
 * ------------------------------------------
 * A single "score" hides the failure mode that actually matters. An artifact
 * with 6 helps and 6 harms is not neutral — it is UNSTABLE, and it is worse
 * than one with 0 of each, because it fires often and misleads half the time.
 * Averaging turns that into 50% and files it next to "no data". So the two
 * counters are kept apart and reported apart.
 *
 * WHY NOTHING IS EVER AUTO-DELETED
 * --------------------------------
 * Harsh retirement measured BELOW baseline in the published evaluation: pruning
 * an artifact also destroys the evidence for why it was there, and the agent
 * re-derives it. Aging here is `active -> stale -> archived`, all reversible,
 * and `quarantined` still leaves the files on disk.
 */

/** Lifecycle state. Every transition is reversible; none deletes anything. */
export type CapabilityStatus = 'active' | 'stale' | 'archived' | 'quarantined';

export interface CapabilityRecord {
  id: string;
  uses: number;
  /** Turns where consulting this artifact preceded a clean finish. */
  helped: number;
  /** Turns where it preceded a failure — tracked SEPARATELY, never netted off. */
  hurt: number;
  consecutiveFailures: number;
  lastUsedAt: number;
  status: CapabilityStatus;
}

export interface LedgerHealth extends CapabilityRecord {
  /** True when helped and hurt are both material — fires often, misleads often. */
  unstable: boolean;
}

/** Minimal Memento shape (vscode.Memento) so tests can pass a plain object. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

const KEY = 'mysti.capabilityLedger.v1';

/** Consecutive failures before a capability is quarantined. */
export const QUARANTINE_AFTER = 2;
/** Consecutive failures before it stops being offered at all. */
export const DEREGISTER_AFTER = 4;
/** Uses below which an artifact ages out of the active set. */
const STALE_AFTER_MS = 60 * 24 * 60 * 60 * 1000; // 60 days unused

export class CapabilityLedger {
  constructor(private readonly _state: MementoLike, private readonly _nowMs: () => number = () => Date.now()) {}

  private _load(): Record<string, CapabilityRecord> {
    const raw = this._state.get<Record<string, CapabilityRecord>>(KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  private _save(all: Record<string, CapabilityRecord>): void {
    void this._state.update(KEY, all);
  }

  private _blank(id: string): CapabilityRecord {
    return { id, uses: 0, helped: 0, hurt: 0, consecutiveFailures: 0, lastUsedAt: this._nowMs(), status: 'active' };
  }

  /**
   * Record one use and its outcome.
   *
   * `outcome` is the HOST's observation of the turn, not the model's opinion of
   * its own work — a model-reported "that helped" is untrusted evidence by the
   * same rule that governs everything else it emits.
   */
  record(id: string, outcome: 'helped' | 'hurt' | 'neutral'): CapabilityRecord {
    const all = this._load();
    const rec = all[id] || this._blank(id);
    rec.uses++;
    rec.lastUsedAt = this._nowMs();
    if (outcome === 'helped') {
      rec.helped++;
      rec.consecutiveFailures = 0;
      // A success lifts a quarantine: the point of quarantine is "this is
      // failing now", not a permanent mark.
      if (rec.status === 'quarantined') { rec.status = 'active'; }
    } else if (outcome === 'hurt') {
      rec.hurt++;
      rec.consecutiveFailures++;
      if (rec.consecutiveFailures >= QUARANTINE_AFTER) { rec.status = 'quarantined'; }
    }
    all[id] = rec;
    this._save(all);
    return rec;
  }

  get(id: string): CapabilityRecord | undefined {
    return this._load()[id];
  }

  /**
   * Should this artifact still be offered to the model?
   *
   * A quarantined artifact stays visible but every call is forced; past
   * DEREGISTER_AFTER it is no longer offered at all — though the files remain
   * on disk and a success would restore it.
   */
  isOffered(id: string): boolean {
    const rec = this._load()[id];
    if (!rec) { return true; } // never used is not the same as failing
    return rec.consecutiveFailures < DEREGISTER_AFTER && rec.status !== 'archived';
  }

  /** Every call of a quarantined artifact must face an explicit card. */
  requiresForcedApproval(id: string): boolean {
    return this._load()[id]?.status === 'quarantined';
  }

  /** Age unused artifacts to `stale`. Reversible: any use restores `active`. */
  ageOut(knownIds: string[]): string[] {
    const all = this._load();
    const now = this._nowMs();
    const aged: string[] = [];
    for (const id of knownIds) {
      const rec = all[id];
      if (!rec || rec.status !== 'active') { continue; }
      if (now - rec.lastUsedAt > STALE_AFTER_MS) {
        rec.status = 'stale';
        aged.push(id);
      }
    }
    if (aged.length > 0) { this._save(all); }
    return aged;
  }

  /** Health rows, worst first, so a report leads with what needs attention. */
  health(): LedgerHealth[] {
    return Object.values(this._load())
      .map(rec => ({
        ...rec,
        // "Fires often AND misleads often" — the state a single averaged score
        // would have rendered as unremarkable.
        unstable: rec.hurt >= 2 && rec.helped >= 2,
      }))
      .sort((a, b) => (b.hurt - a.hurt) || (b.uses - a.uses) || a.id.localeCompare(b.id));
  }

  /**
   * A readable health section for the agent-catalog report (Plan 20 Phase 6).
   *
   * Rendered as part of the ONE report rather than a second command: two places
   * to look is how a health surface stops being looked at. Leads with what is
   * wrong, because a dashboard that opens on green is a dashboard nobody reads
   * past.
   */
  reportSection(): string {
    const rows = this.health();
    if (rows.length === 0) {
      return ['## Capability health', '', 'No capability has been called yet.', ''].join('\n');
    }

    const unstable = rows.filter(r => r.unstable);
    const quarantined = rows.filter(r => r.status === 'quarantined');
    const dropped = rows.filter(r => !this.isOffered(r.id));

    const lines = ['## Capability health', ''];

    if (dropped.length > 0) {
      lines.push(`**${dropped.length} no longer offered** (repeated failures; files are still on disk and a fix + republish restores them): ${dropped.map(r => r.id).join(', ')}`, '');
    }
    if (quarantined.length > 0) {
      lines.push(`**${quarantined.length} quarantined** — still callable, but every call needs explicit approval: ${quarantined.map(r => r.id).join(', ')}`, '');
    }
    if (unstable.length > 0) {
      lines.push(
        `**${unstable.length} unstable** — these both help and harm often, which a single averaged score would have hidden as "about 50%":`,
        ...unstable.map(r => `- ${r.id}: helped ${r.helped}, hurt ${r.hurt}, over ${r.uses} call(s)`),
        ''
      );
    }

    lines.push(
      '| capability | uses | helped | hurt | status |',
      '|---|---|---|---|---|',
      ...rows.map(r => `| ${r.id} | ${r.uses} | ${r.helped} | ${r.hurt} | ${r.status}${r.unstable ? ' ⚠︎' : ''} |`),
      '',
      'Helped and hurt are deliberately never combined. A 6-help/6-harm capability is',
      'unstable — it fires often and misleads half the time — not "neutral", which is',
      'what an average would call it.',
      ''
    );
    return lines.join('\n');
  }

  /** Forget one artifact's history (used when it is revoked). */
  forget(id: string): void {
    const all = this._load();
    if (all[id]) { delete all[id]; this._save(all); }
  }

  clear(): void { this._save({}); }
}
