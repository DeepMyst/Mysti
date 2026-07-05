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
