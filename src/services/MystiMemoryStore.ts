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
 * MystiMemoryStore (Plan 17 P2.5) — unified cross-backend project memory for the
 * Mysti coordinator. Every delegation reads the same memory regardless of which
 * of the 14 backends runs it, so the fleet behaves like ONE agent that knows the
 * project instead of 14 goldfish.
 *
 * Writers:
 *   - the MODEL, via a nonce-gated `<remember:NONCE>fact</remember>` tag
 *     (source 'model' — UNTRUSTED, always injected fenced, never as a system
 *     prefix; Plan 12 trust rule).
 *   - a trusted HOST source ('host') is also supported for operational facts
 *     recorded with no model involvement; it currently has no live writer (the
 *     reroute's outage note was removed in review[3]) but stays available and
 *     is scored/labelled '[system]' when present.
 *
 * Backed by workspaceState (per-workspace), capped with LRU-ish eviction.
 */

export interface MemoryEntry {
  text: string;
  at: number;
  source: 'model' | 'host';
  /** Times this entry was surfaced/re-affirmed — protects hot facts from eviction. */
  hits: number;
}

/** Minimal Memento shape (vscode.Memento) so tests can pass a plain object. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

const KEY = 'mysti.crossBackendMemory.v1';
const MAX_ENTRIES = 40;
const MAX_TEXT = 400;

export class MystiMemoryStore {
  constructor(private readonly _state: MementoLike, private readonly _nowMs: () => number = () => 0) {}

  private _load(): MemoryEntry[] {
    const raw = this._state.get<MemoryEntry[]>(KEY);
    return Array.isArray(raw) ? raw.filter(e => e && typeof e.text === 'string') : [];
  }

  private _save(entries: MemoryEntry[]): void {
    void this._state.update(KEY, entries);
  }

  /**
   * Record a fact. De-duplicates case-insensitively (re-affirming bumps hits +
   * recency instead of adding a copy). Evicts the lowest-value entry when full:
   * host facts and high-hit facts are kept preferentially over stale model facts.
   */
  remember(text: string, source: 'model' | 'host'): void {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!clean) { return; }
    const entries = this._load();
    const key = clean.toLowerCase();
    const existing = entries.find(e => e.text.toLowerCase() === key);
    if (existing) {
      existing.hits++;
      existing.at = this._nowMs();
      existing.source = source === 'host' ? 'host' : existing.source; // host confirmation upgrades trust
      this._save(entries);
      return;
    }
    entries.push({ text: clean, at: this._nowMs(), source, hits: 0 });
    if (entries.length > MAX_ENTRIES) {
      // Score: host + hits + recency-rank are worth more; drop the weakest.
      const scored = entries.map((e, i) => ({ e, i, score: (e.source === 'host' ? 3 : 0) + e.hits + i / entries.length }));
      scored.sort((a, b) => a.score - b.score);
      const dropIdx = scored[0].i;
      entries.splice(dropIdx, 1);
    }
    this._save(entries);
  }

  /** All entries, most-recent first (for the injected block). */
  list(): MemoryEntry[] {
    return this._load().sort((a, b) => b.at - a.at);
  }

  /** Compact, cap-bounded text for injecting into a prompt (most-recent first). */
  digest(max = 20): string {
    const rows = this.list().slice(0, max).map(e => `- ${e.text}${e.source === 'host' ? ' [system]' : ''}`);
    return rows.join('\n');
  }

  /** Wipe (test/debug/reset). */
  clear(): void {
    this._save([]);
  }
}
