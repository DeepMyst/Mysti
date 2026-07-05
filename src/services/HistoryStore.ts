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
 * HistoryStore (Plan 08 — smart compaction, full-history + cherry-pick retrieval).
 *
 * The authoritative, append-only full transcript on disk, per panel, under
 * `.mysti/compaction/<panelId>/history.jsonl`. Compaction summarises what's in
 * context; this file keeps EVERYTHING, so retrieval can pull back detail that
 * was summarised away. Lives on the filesystem (not globalState, which is
 * size-capped) so it survives reloads for free.
 *
 * Privacy: full tool output may include sensitive data. `.mysti/` is gitignored,
 * and this store ALSO drops a self-protecting `.gitignore` (`*`) into the
 * compaction tree on first write, so a transcript can never be committed even if
 * the repo's root .gitignore is missing the entry.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { estimateTokens } from './ModelPricing';

export interface HistoryRecord {
  seq: number;
  ts: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'tool_use' | 'tool_result';
  content: string;
  tokensEst: number;
  msgId?: string;
}

/** A token-balanced contiguous slice of history for one parallel scorer. */
export interface HistoryChunk {
  index: number;
  records: HistoryRecord[];
  tokensEst: number;
}

/**
 * Sanitise a panelId into a SAFE single path segment. Critically, `.` is NOT in
 * the allowlist, so `.` / `..` / `....` collapse to all-underscores and are
 * rejected to `'panel'` — closing the path-traversal hole where a crafted
 * panelId from the webview could escape the per-panel directory (and, via
 * clear()'s recursive rm, delete `.mysti`). No `/` or `\` survives either.
 */
export function safePanelSegment(panelId: string): string {
  const seg = (panelId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return (!seg || /^_+$/.test(seg)) ? 'panel' : seg;
}

export class HistoryStore {
  /** Per-panel append serialization chain (prevents duplicate-seq races). */
  private readonly _appendChains = new Map<string, Promise<void>>();
  /** In-memory last-seq cache per panel (seeded once; avoids O(n²) re-reads). */
  private readonly _seqCache = new Map<string, number>();

  constructor(private readonly _workspaceRoot: string) {}

  private _compactionRoot(): string {
    return path.join(this._workspaceRoot, '.mysti', 'compaction');
  }

  private _dir(panelId: string): string {
    const dir = path.join(this._compactionRoot(), safePanelSegment(panelId));
    // Defense-in-depth: the resolved dir must stay under .mysti/compaction.
    const root = path.resolve(this._compactionRoot());
    if (!path.resolve(dir).startsWith(root + path.sep)) {
      return path.join(this._compactionRoot(), 'panel');
    }
    return dir;
  }

  private _file(panelId: string): string {
    return path.join(this._dir(panelId), 'history.jsonl');
  }

  /** Append one finalized message to the panel's history log. Never throws.
   * Appends are serialized per panel so back-to-back user+assistant writes get
   * distinct, monotonic seqs. */
  async append(panelId: string, record: Omit<HistoryRecord, 'seq' | 'tokensEst'> & { tokensEst?: number }): Promise<void> {
    const prev = this._appendChains.get(panelId) ?? Promise.resolve();
    const next = prev.then(() => this._doAppend(panelId, record)).catch(() => undefined);
    this._appendChains.set(panelId, next);
    return next;
  }

  private async _doAppend(panelId: string, record: Omit<HistoryRecord, 'seq' | 'tokensEst'> & { tokensEst?: number }): Promise<void> {
    try {
      const dir = this._dir(panelId);
      await fs.mkdir(dir, { recursive: true });
      await this._ensureGitignore();
      const seq = await this._nextSeq(panelId);
      const full: HistoryRecord = {
        seq,
        ts: record.ts,
        role: record.role,
        kind: record.kind,
        content: record.content,
        tokensEst: record.tokensEst ?? estimateTokens(record.content),
        msgId: record.msgId,
      };
      await fs.appendFile(this._file(panelId), JSON.stringify(full) + '\n', 'utf8');
      this._seqCache.set(panelId, seq);
    } catch (err) {
      console.warn(`[Mysti] HistoryStore.append(${panelId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read all records for a panel (in order). Returns [] when no file exists. */
  async readAll(panelId: string): Promise<HistoryRecord[]> {
    try {
      const raw = await fs.readFile(this._file(panelId), 'utf8');
      const out: HistoryRecord[] = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) { continue; }
        try {
          const rec = JSON.parse(t) as HistoryRecord;
          if (rec && typeof rec.seq === 'number') { out.push(rec); }
        } catch { /* skip a corrupt line */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Whether any archived history exists for this panel. */
  async hasHistory(panelId: string): Promise<boolean> {
    try {
      const st = await fs.stat(this._file(panelId));
      return st.size > 0;
    } catch {
      return false;
    }
  }

  /** Clear a panel's history (e.g. new conversation). Never throws. */
  async clear(panelId: string): Promise<void> {
    this._seqCache.delete(panelId);
    try {
      await fs.rm(this._dir(panelId), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /**
   * Split records into up to `maxWorkers` contiguous, token-balanced chunks of
   * ~`targetChunkTokens` each (never splitting a record). Drops the last
   * `excludeTail` records (already in the live window). Pure function — exposed
   * static so it can be unit-tested without disk.
   */
  static chunk(
    records: HistoryRecord[],
    opts: { targetChunkTokens: number; maxWorkers: number; excludeTail?: number },
  ): HistoryChunk[] {
    const usable = opts.excludeTail && opts.excludeTail > 0
      ? records.slice(0, Math.max(0, records.length - opts.excludeTail))
      : records.slice();
    if (usable.length === 0) { return []; }

    const total = usable.reduce((s, r) => s + (r.tokensEst || 0), 0);
    const target = Math.max(1, opts.targetChunkTokens);
    const wantChunks = Math.min(Math.max(1, opts.maxWorkers), Math.max(1, Math.ceil(total / target)));
    const perChunk = Math.ceil(total / wantChunks);

    const chunks: HistoryChunk[] = [];
    let cur: HistoryRecord[] = [];
    let curTokens = 0;
    for (const rec of usable) {
      cur.push(rec);
      curTokens += rec.tokensEst || 0;
      if (curTokens >= perChunk && chunks.length < wantChunks - 1) {
        chunks.push({ index: chunks.length, records: cur, tokensEst: curTokens });
        cur = [];
        curTokens = 0;
      }
    }
    if (cur.length > 0) {
      chunks.push({ index: chunks.length, records: cur, tokensEst: curTokens });
    }
    return chunks;
  }

  /** Next seq from the in-memory cache, seeded once from disk on first use. */
  private async _nextSeq(panelId: string): Promise<number> {
    let last = this._seqCache.get(panelId);
    if (last === undefined) {
      const existing = await this.readAll(panelId);
      last = existing.length === 0 ? 0 : existing[existing.length - 1].seq;
      this._seqCache.set(panelId, last);
    }
    return last + 1;
  }

  /** Drop a `*` .gitignore into the compaction tree so transcripts never commit. */
  private async _ensureGitignore(): Promise<void> {
    const gi = path.join(this._compactionRoot(), '.gitignore');
    try {
      await fs.access(gi);
    } catch {
      try {
        await fs.mkdir(this._compactionRoot(), { recursive: true });
        await fs.writeFile(gi, '*\n', 'utf8');
      } catch { /* ignore */ }
    }
  }
}
