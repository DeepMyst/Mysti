/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The compaction threshold's arithmetic, and the UNKNOWN-vs-zero rule that
 * decides whether it can run at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompactionManager } from '../../src/managers/CompactionManager';
import type { UsageStats } from '../../src/types';
import { normalizeUsage } from '../../src/services/TokenAccounting';

const ctx = { globalState: { get: vi.fn(), update: vi.fn() } } as never;

function make(): CompactionManager {
  return new CompactionManager(ctx);
}

/** A turn as Claude Code reports it: three disjoint prompt buckets. */
function anthropicTurn(input: number, cacheRead: number, cacheCreate: number): UsageStats {
  return normalizeUsage(
    {
      input_tokens: input,
      output_tokens: 100,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    },
    'anthropic',
  );
}

describe('CompactionManager token math', () => {
  let cm: CompactionManager;
  beforeEach(() => { cm = make(); });

  describe('the threshold sees every prompt bucket', () => {
    it('fires on a cold turn whose context is almost entirely cache-CREATION', () => {
      // The defect this test exists for. A cold resume books the whole prefix as
      // cache_creation, so `input + cache_read` reported 2_000 of a 200_000
      // window — 1% — and compaction never ran when it was most needed.
      const cold = anthropicTurn(2_000, 0, 178_000);
      expect(cm.shouldCompact('p1', cold, 200_000, 10)).toBe(true);
    });

    it('does not fire below the threshold', () => {
      expect(cm.shouldCompact('p1', anthropicTurn(1_000, 10_000, 1_000), 200_000, 10)).toBe(false);
    });

    it('recordUsage reports crossing on the same arithmetic', () => {
      expect(cm.recordUsage('p1', anthropicTurn(2_000, 0, 178_000), 200_000)).toBe(true);
      expect(cm.recordUsage('p2', anthropicTurn(1_000, 5_000, 1_000), 200_000)).toBe(false);
    });

    it('does not double-count an OpenAI turn whose cached tokens are a subset', () => {
      // Codex: cached_input_tokens ⊆ input_tokens. Summed, a 100k context reads
      // as 190k — 95% of a 200k window — and compaction fires far too early.
      const codex = normalizeUsage(
        { input_tokens: 100_000, output_tokens: 100, cache_read_input_tokens: 90_000 },
        'openai',
      );
      expect(cm.shouldCompact('p1', codex, 200_000, 10)).toBe(false);
    });
  });

  describe('an unmeasured turn is UNKNOWN, never 0%', () => {
    it('refuses to threshold on an all-zero record', () => {
      // Read as a measured zero this says "plenty of room" forever, which
      // silently disables compaction for the whole session.
      expect(cm.shouldCompact('p1', { input_tokens: 0, output_tokens: 120 }, 200_000, 10)).toBe(false);
    });

    it('evaluateCompaction declines to act on one too', () => {
      const settings = { provider: 'claude-code', model: 'claude-opus-5' } as never;
      const evaluated = cm.evaluateCompaction('p1', { input_tokens: 0, output_tokens: 9 }, 200_000, 10, settings);
      expect(evaluated.act).toBe(false);
    });
  });

  describe('lifetime totals vs current fill', () => {
    it('keeps them separate — the totals are a spend, the fill is a position', () => {
      // Manual /compact used to report the CUMULATIVE totals as "before", a
      // number that grows past the context window after a few turns and made
      // every small context look critical.
      cm.recordUsage('p1', anthropicTurn(1_000, 5_000, 1_000), 200_000);
      cm.recordUsage('p1', anthropicTurn(1_000, 6_000, 1_000), 200_000);
      cm.recordUsage('p1', anthropicTurn(1_000, 7_000, 1_000), 200_000);

      const totals = cm.getUsage('p1');
      expect(totals?.messageCount).toBe(3);
      expect(totals?.totalCacheReadTokens).toBe(18_000);

      // The fill is the LAST turn only.
      const fill = cm.getLastFill('p1');
      expect(fill?.cache_read_input_tokens).toBe(7_000);
    });

    it('resets the fill after a compaction so the next check cannot re-fire off it', () => {
      cm.recordUsage('p1', anthropicTurn(2_000, 0, 178_000), 200_000);
      cm.updateUsageAfterCompaction('p1', 5_000);
      const fill = cm.getLastFill('p1');
      expect(fill?.input_tokens).toBe(5_000);
      // Compaction invalidates the cache by construction — nothing is cached now.
      expect(fill?.cache_read_input_tokens).toBeUndefined();
    });

    it('clears the fill on reset', () => {
      cm.recordUsage('p1', anthropicTurn(1_000, 5_000, 1_000), 200_000);
      cm.resetUsage('p1');
      expect(cm.getLastFill('p1')).toBeNull();
    });

    it('sweeps brainstorm child panels on reset', () => {
      cm.recordUsage('p1-brainstorm-codex', anthropicTurn(1_000, 5_000, 1_000), 200_000);
      cm.resetUsage('p1');
      expect(cm.getLastFill('p1-brainstorm-codex')).toBeNull();
    });
  });
});
