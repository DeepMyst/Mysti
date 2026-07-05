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
 * ModelPricing (Plan 08 — smart compaction).
 *
 * A small, deliberately-editable price table for the compact-vs-cache economic
 * decision and the savings ledger. Rates are USD per million tokens (MTok).
 * Cache multipliers follow Anthropic prompt-caching economics: a cache READ is
 * ~0.1x base input, a cache WRITE is 1.25x (5-min TTL) or 2x (1-hour TTL).
 *
 * Unknown models return `null` so callers degrade to non-economic behaviour
 * rather than acting on a wrong number.
 */

export interface ModelRate {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/** Cache-read price as a fraction of base input price. */
export const CACHE_READ_MULT = 0.1;
/** Cache-write premium for the 5-minute ephemeral TTL. */
export const CACHE_WRITE_MULT_5M = 1.25;
/** Cache-write premium for the 1-hour TTL. */
export const CACHE_WRITE_MULT_1H = 2.0;

/**
 * First-party / generic provider rates, matched by substring on the model id.
 * Order matters — the first match wins, so put more specific patterns first.
 */
const FAMILY_RATES: Array<{ match: RegExp; rate: ModelRate }> = [
  { match: /opus/i, rate: { inputPerMTok: 5, outputPerMTok: 25 } },
  { match: /sonnet/i, rate: { inputPerMTok: 3, outputPerMTok: 15 } },
  { match: /haiku/i, rate: { inputPerMTok: 1, outputPerMTok: 5 } },
  { match: /4o-mini|gpt-4o-mini|o4-mini/i, rate: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { match: /flash/i, rate: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { match: /gemini/i, rate: { inputPerMTok: 1.25, outputPerMTok: 5 } },
  { match: /gpt-5|gpt-4\.1|gpt-4o|gpt-4/i, rate: { inputPerMTok: 2.5, outputPerMTok: 10 } },
];

/**
 * DeepMyst gateway catalog rates for the cheap compactor models — these are
 * what a smart-compaction summarizer call actually costs when routed through
 * the gateway, and are cheaper than first-party for the same model.
 */
const GATEWAY_RATES: Array<{ match: RegExp; rate: ModelRate }> = [
  { match: /haiku/i, rate: { inputPerMTok: 0.25, outputPerMTok: 1.25 } },
  { match: /4o-mini|gpt-4o-mini/i, rate: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { match: /flash/i, rate: { inputPerMTok: 0.075, outputPerMTok: 0.3 } },
];

/**
 * Look up the per-MTok rate for a model id. Pass `{ viaGateway: true }` to get
 * the (cheaper) DeepMyst-gateway rate for the compactor model. Returns `null`
 * for an unknown model so callers can skip economic reasoning.
 */
export function getModelRate(modelId: string | undefined, opts?: { viaGateway?: boolean }): ModelRate | null {
  if (!modelId) { return null; }
  const id = modelId.trim();
  if (!id) { return null; }
  if (opts?.viaGateway) {
    for (const { match, rate } of GATEWAY_RATES) {
      if (match.test(id)) { return rate; }
    }
    // Fall through to family rate if the gateway table has no specific entry.
  }
  for (const { match, rate } of FAMILY_RATES) {
    if (match.test(id)) { return rate; }
  }
  return null;
}

/** Crude token estimate (≈4 chars/token) — shared by chunking, budgets, and economics. */
export function estimateTokens(text: string): number {
  if (!text) { return 0; }
  return Math.ceil(text.length / 4);
}

/** USD for `tokens` priced at `perMTok`. */
export function tokensCostUsd(tokens: number, perMTok: number): number {
  return (Math.max(0, tokens) / 1_000_000) * perMTok;
}

/** USD to READ `tokens` from cache for a model (0.1x base input). */
export function cacheReadCostUsd(tokens: number, rate: ModelRate): number {
  return tokensCostUsd(tokens, rate.inputPerMTok * CACHE_READ_MULT);
}

/** USD to WRITE `tokens` to cache for a model (1.25x base input @5-min, 2x @1-hour). */
export function cacheWriteCostUsd(tokens: number, rate: ModelRate, ttl: '5m' | '1h' = '5m'): number {
  const mult = ttl === '1h' ? CACHE_WRITE_MULT_1H : CACHE_WRITE_MULT_5M;
  return tokensCostUsd(tokens, rate.inputPerMTok * mult);
}
