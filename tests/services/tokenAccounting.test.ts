/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two conventions the 15 backends speak, and the single formula that is
 * wrong for both of them in opposite directions.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeUsage,
  resolveUsageConvention,
  reportsCacheTokens,
  contextFillTokens,
  hasUsageSignal,
  fillPercent,
  addUsage,
} from '../../src/services/TokenAccounting';

describe('TokenAccounting', () => {
  describe('the Anthropic convention (disjoint buckets)', () => {
    it('counts cache-CREATION as context fill', () => {
      // The bug this whole module exists for. Claude Code's message_delta splits
      // the prompt three ways and they do not overlap, so dropping the creation
      // bucket under-counts by exactly the tokens written to cache this turn.
      const usage = normalizeUsage(
        { input_tokens: 1_000, output_tokens: 250, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 4_000 },
        'anthropic',
      );
      expect(contextFillTokens(usage)).toBe(104_000);
      // The old formula (input + cache_read) would have said 100_000.
    });

    it('reads a COLD first turn at its true size, not near zero', () => {
      // On the first turn of a session (or any cold resume) cache_read is 0 and
      // the entire prefix lands in cache_creation. Under the old formula a
      // 400k-token context reported as 2_000 — 0.5% fill against a 200k window —
      // which is precisely why the threshold almost never tripped.
      const cold = normalizeUsage(
        { input_tokens: 2_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 398_000 },
        'anthropic',
      );
      expect(contextFillTokens(cold)).toBe(400_000);
      expect(fillPercent(cold, 400_000)).toBe(100);
    });

    it('handles a fully cache-hit turn (input_tokens legitimately 0)', () => {
      const usage = normalizeUsage(
        { input_tokens: 0, output_tokens: 40, cache_read_input_tokens: 120_000 },
        'anthropic',
      );
      expect(contextFillTokens(usage)).toBe(120_000);
      expect(hasUsageSignal(usage)).toBe(true);
    });
  });

  describe('the OpenAI convention (cached ⊆ input)', () => {
    it('does not double-count the cached subset', () => {
      // Codex reports cached_input_tokens as part of input_tokens. Adding them,
      // as the shared formula did, inflates fill by up to 2x and trips
      // compaction early.
      const usage = normalizeUsage(
        { input_tokens: 100_000, output_tokens: 250, cache_read_input_tokens: 90_000 },
        'openai',
      );
      expect(contextFillTokens(usage)).toBe(100_000);
      // The full-price bucket is what's left after the cached part is split out.
      expect(usage.input_tokens).toBe(10_000);
      expect(usage.cache_read_input_tokens).toBe(90_000);
    });

    it('clamps rather than going negative when cached exceeds input', () => {
      const usage = normalizeUsage(
        { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 5_000 },
        'openai',
      );
      expect(usage.input_tokens).toBe(0);
      expect(contextFillTokens(usage)).toBe(5_000);
    });

    it('is idempotent — normalizing an already-split record changes nothing', () => {
      const once = normalizeUsage(
        { input_tokens: 100_000, output_tokens: 1, cache_read_input_tokens: 90_000 },
        'openai',
      );
      const twice = normalizeUsage(once, 'openai');
      expect(contextFillTokens(twice)).toBe(contextFillTokens(once));
    });
  });

  describe('auto resolution for backends that front other vendors', () => {
    it('reads an Anthropic model as the disjoint convention', () => {
      expect(resolveUsageConvention('auto', 'anthropic/claude-sonnet-5')).toBe('anthropic');
      expect(resolveUsageConvention('auto', 'claude-opus-5')).toBe('anthropic');
    });

    it('falls back to openai for an unrecognized model', () => {
      // Deliberate direction: mis-reading Anthropic data as OpenAI loses only the
      // small uncached bucket, while the reverse double-counts the whole cached
      // prefix. Under-reading defers a compaction; over-reading destroys a cache.
      expect(resolveUsageConvention('auto', 'some-new-model')).toBe('openai');
      expect(resolveUsageConvention('auto', undefined)).toBe('openai');
    });

    it('leaves an explicit declaration alone', () => {
      expect(resolveUsageConvention('none', 'claude-opus-5')).toBe('none');
      expect(resolveUsageConvention('anthropic', 'gpt-6')).toBe('anthropic');
    });
  });

  describe('unknown vs measured zero', () => {
    it('treats an all-zero record as UNKNOWN', () => {
      // cursor/hermes/kimi/ollama default missing fields to 0 rather than
      // omitting usage. Read as a measured zero this says "0% full", which
      // silently disables compaction for the rest of the session.
      expect(hasUsageSignal({ input_tokens: 0, output_tokens: 120 })).toBe(false);
      expect(hasUsageSignal(null)).toBe(false);
      expect(hasUsageSignal(undefined)).toBe(false);
    });

    it('survives NaN and negative fields without poisoning the arithmetic', () => {
      const usage = normalizeUsage(
        { input_tokens: Number.NaN, output_tokens: -5, cache_read_input_tokens: 1_000 },
        'anthropic',
      );
      expect(contextFillTokens(usage)).toBe(1_000);
      expect(usage.output_tokens).toBe(0);
    });

    it('reports 0% rather than Infinity when the context window is unknown', () => {
      expect(fillPercent({ input_tokens: 1_000, output_tokens: 0 }, 0)).toBe(0);
    });
  });

  it('knows which conventions can carry a cache signal at all', () => {
    expect(reportsCacheTokens('anthropic')).toBe(true);
    expect(reportsCacheTokens('openai')).toBe(true);
    expect(reportsCacheTokens('auto')).toBe(true);
    // A backend that cannot report cache must not be read as "cache cold".
    expect(reportsCacheTokens('none')).toBe(false);
  });

  describe('addUsage (multi-round-trip COST, never a fill)', () => {
    it('sums every bucket and propagates the estimated flag', () => {
      const total = addUsage(
        { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 },
        { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 50, estimated: true },
      );
      expect(total.input_tokens).toBe(300);
      expect(total.output_tokens).toBe(30);
      expect(total.cache_read_input_tokens).toBe(900);
      expect(total.cache_creation_input_tokens).toBe(50);
      expect(total.estimated).toBe(true);
    });
  });
});
