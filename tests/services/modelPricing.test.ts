/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for ModelPricing (Plan 08 smart compaction).
 */
import { describe, it, expect } from 'vitest';
import {
  getModelRate,
  estimateTokens,
  tokensCostUsd,
  cacheReadCostUsd,
  cacheWriteCostUsd,
} from '../../src/services/ModelPricing';

describe('ModelPricing.getModelRate', () => {
  it('matches the Claude families', () => {
    expect(getModelRate('claude-opus-4-8')).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(getModelRate('claude-sonnet-4-6')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(getModelRate('claude-haiku-4-5')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(getModelRate('gpt-4o-mini')).toEqual({ inputPerMTok: 0.15, outputPerMTok: 0.6 });
  });

  it('prices GPT-6 Astra at its own rate, not the GPT-5 fallback', () => {
    // Before the gpt-6 pattern existed this returned null (billed as unknown),
    // because /gpt-5|gpt-4/ does not match "gpt-6-astra".
    expect(getModelRate('gpt-6-astra')).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
    // The gpt-5 family must be unaffected by the new, earlier pattern.
    expect(getModelRate('gpt-5.4-codex')).toEqual({ inputPerMTok: 2.5, outputPerMTok: 10 });
    // Astra is 4x the GPT-5 input rate — a mismatch here understates spend.
    expect(getModelRate('gpt-6-astra')!.inputPerMTok)
      .toBeGreaterThan(getModelRate('gpt-5.2')!.inputPerMTok);
  });

  it('prices the 2026 Anthropic line, including the Sonnet 5 price DROP', () => {
    // Fable/Mythos matched nothing before — an unpriced top-tier model.
    expect(getModelRate('claude-fable-5-1')).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(getModelRate('claude-fable-5')).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(getModelRate('claude-opus-5')).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    // Sonnet 5 is cheaper than Sonnet 4.6; the generic /sonnet/ rule would over-bill it.
    expect(getModelRate('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(getModelRate('claude-sonnet-4-6')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it('does not let the sonnet-5 rule swallow older 4.x Sonnet ids', () => {
    // "claude-sonnet-4-5" / "claude-sonnet-4.5" must NOT match /sonnet-5/.
    expect(getModelRate('claude-sonnet-4-5-20250929')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(getModelRate('claude-sonnet-4.5')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it('prices each GPT-5.6 tier separately (they differ by ~20x)', () => {
    expect(getModelRate('gpt-5.6-sol')).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(getModelRate('gpt-5.6-terra')).toEqual({ inputPerMTok: 2, outputPerMTok: 12 });
    expect(getModelRate('gpt-5.6-luna')).toEqual({ inputPerMTok: 0.2, outputPerMTok: 1.2 });
    // Older GPT-5 ids keep the generic rate.
    expect(getModelRate('gpt-5.5')).toEqual({ inputPerMTok: 2.5, outputPerMTok: 10 });
  });

  it('prices Gemini 3.5+ Flash above the legacy Flash rate', () => {
    expect(getModelRate('gemini-3.8-flash')).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
    expect(getModelRate('gemini-3.7-flash')).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
    // Legacy Flash keeps the old cheap rate.
    expect(getModelRate('gemini-2.5-flash')).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.4 });
  });

  it('returns null for unknown / missing models', () => {
    expect(getModelRate('totally-unknown-xyz')).toBeNull();
    expect(getModelRate(undefined)).toBeNull();
    expect(getModelRate('')).toBeNull();
  });

  it('uses the cheaper gateway rate for the compactor model', () => {
    expect(getModelRate('claude-haiku-4-5', { viaGateway: true })).toEqual({ inputPerMTok: 0.25, outputPerMTok: 1.25 });
    // Gateway haiku is strictly cheaper than first-party haiku.
    const fp = getModelRate('claude-haiku-4-5')!;
    const gw = getModelRate('claude-haiku-4-5', { viaGateway: true })!;
    expect(gw.inputPerMTok).toBeLessThan(fp.inputPerMTok);
  });
});

describe('ModelPricing token + cache math', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(401))).toBe(101);
  });

  it('prices reads at 0.1x and writes at 1.25x / 2x base input', () => {
    const rate = { inputPerMTok: 5, outputPerMTok: 25 };
    expect(tokensCostUsd(1_000_000, 5)).toBeCloseTo(5);
    expect(cacheReadCostUsd(1_000_000, rate)).toBeCloseTo(0.5);
    expect(cacheWriteCostUsd(1_000_000, rate, '5m')).toBeCloseTo(6.25);
    expect(cacheWriteCostUsd(1_000_000, rate, '1h')).toBeCloseTo(10);
  });
});
