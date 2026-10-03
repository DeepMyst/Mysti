/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for HistoryStore.chunk (Plan 08 retrieval).
 */
import { describe, it, expect } from 'vitest';
import { HistoryStore, safePanelSegment, type HistoryRecord } from '../../src/services/HistoryStore';

describe('safePanelSegment (path-traversal guard)', () => {
  it('collapses dot-only / empty segments to "panel"', () => {
    for (const evil of ['..', '.', '....', '../..', '']) {
      expect(safePanelSegment(evil)).toBe('panel');
    }
  });

  it('strips path separators and dots from mixed segments', () => {
    for (const evil of ['a/../b', '../../etc/passwd', 'x/..']) {
      const s = safePanelSegment(evil);
      expect(s).not.toMatch(/[./\\]/);
      expect(s).not.toBe('');
    }
  });

  it('keeps already-safe ids', () => {
    expect(safePanelSegment('sidebar')).toBe('sidebar');
    expect(safePanelSegment('panel-1_abc')).toBe('panel-1_abc');
  });
});

function rec(seq: number, tokens: number): HistoryRecord {
  return { seq, ts: seq, role: 'user', kind: 'text', content: 'x', tokensEst: tokens };
}

describe('HistoryStore.chunk', () => {
  it('returns [] when empty', () => {
    expect(HistoryStore.chunk([], { targetChunkTokens: 100, maxWorkers: 4 })).toEqual([]);
  });

  it('excludes the live tail', () => {
    const recs = [rec(1, 10), rec(2, 10), rec(3, 10), rec(4, 10), rec(5, 10)];
    const chunks = HistoryStore.chunk(recs, { targetChunkTokens: 1000, maxWorkers: 4, excludeTail: 2 });
    const kept = chunks.flatMap(c => c.records).length;
    expect(kept).toBe(3);
  });

  it('balances into <= maxWorkers chunks without splitting records', () => {
    const recs = Array.from({ length: 10 }, (_, i) => rec(i + 1, 1000)); // 10k tokens total
    const chunks = HistoryStore.chunk(recs, { targetChunkTokens: 2500, maxWorkers: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(4);
    // Every record appears exactly once, in order.
    const seqs = chunks.flatMap(c => c.records.map(r => r.seq));
    expect(seqs).toEqual(recs.map(r => r.seq));
  });

  it('produces a single chunk when small', () => {
    const chunks = HistoryStore.chunk([rec(1, 50), rec(2, 50)], { targetChunkTokens: 7000, maxWorkers: 4 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].records).toHaveLength(2);
  });
});
