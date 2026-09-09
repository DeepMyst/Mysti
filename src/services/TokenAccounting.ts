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
 * TokenAccounting — the one place that knows what a backend's usage numbers MEAN.
 *
 * Every consumer of `UsageStats` (the compaction threshold, the smart-compaction
 * economics, the Boost ledger, the webview context pie) used to compute context
 * fill as `input_tokens + cache_read_input_tokens`. That formula is wrong for
 * both of the two conventions the 15 backends actually speak, in OPPOSITE
 * directions:
 *
 *   - `anthropic` (Claude Code, and Cline when it fronts an Anthropic model):
 *     `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`
 *     are DISJOINT. The prompt is the SUM of all three. Dropping cache-creation
 *     UNDER-counts, and it under-counts worst exactly when it matters most: on
 *     the first turn of a session (or any cold resume) cache_read is 0 and the
 *     entire prefix is booked as cache_creation, so a 400k-token context reports
 *     as the couple of thousand uncached tokens. That is why the threshold
 *     almost never tripped.
 *
 *   - `openai` (Codex, and any OpenAI-compatible endpoint): `cached_input_tokens`
 *     is a SUBSET of `input_tokens` (the `prompt_tokens_details.cached_tokens`
 *     convention). Adding the two DOUBLE-COUNTS the cached part, inflating fill
 *     by up to 2x and tripping compaction early.
 *
 *   - `none`: the backend reports a flat prompt count with no cache split.
 *
 * The fix is to normalize AT THE BOUNDARY into the disjoint (Anthropic) shape,
 * so downstream there is exactly one formula: `input + cache_creation + cache_read`.
 * `normalizeUsage` is idempotent — normalizing an already-normalized record is a
 * no-op — so it is safe to call on any path where provenance is uncertain.
 */

import type { UsageStats } from '../types';

/**
 * How a backend splits prompt tokens between cached and uncached buckets.
 * Declared per provider in `ProviderCapabilities.usageConvention`.
 */
export type UsageConvention =
  /** input / cache_creation / cache_read are disjoint; prompt = sum of all three. */
  | 'anthropic'
  /** cached tokens are a SUBSET of input_tokens (OpenAI `prompt_tokens_details`). */
  | 'openai'
  /** No cache accounting at all; input_tokens is the whole prompt. */
  | 'none'
  /**
   * The backend FRONTS other vendors' models, so the convention is a property of
   * the selected model rather than of the backend (Cline, OpenRouter, LocalAI).
   * Resolved per-turn by `resolveUsageConvention` from the model id.
   */
  | 'auto';

/**
 * Resolve an `auto` declaration against the model actually in use.
 *
 * Defaults to `openai` when the model is unrecognized, and that direction is
 * deliberate: mis-reading Anthropic data as OpenAI loses only the small uncached
 * `input_tokens` bucket (the subtraction clamps at zero), while mis-reading
 * OpenAI data as Anthropic double-counts the cached prefix and can inflate fill
 * by 2x. Under-reading defers a compaction; over-reading destroys a live cache.
 */
export function resolveUsageConvention(declared: UsageConvention, modelId?: string): Exclude<UsageConvention, 'auto'> {
  if (declared !== 'auto') { return declared; }
  if (modelId && /claude|anthropic|sonnet|opus|haiku|fable|mythos/i.test(modelId)) { return 'anthropic'; }
  return 'openai';
}

/** Conventions that can ever carry a cache signal (used for warmth honesty). */
export function reportsCacheTokens(convention: UsageConvention): boolean {
  return convention !== 'none';
}

function nonNegative(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Convert a provider's raw usage into the canonical disjoint shape.
 *
 * For `openai`, the cached subset is SUBTRACTED out of `input_tokens` so the
 * three buckets become disjoint like Anthropic's. That keeps `input_tokens`
 * meaning the same thing ("prompt tokens we paid full price for") across every
 * backend, which is what both the fill math and the cost math need.
 *
 * Clamped at zero: a backend that reports `cached > input` (seen when a provider
 * counts cached tokens against a different denominator) must not produce a
 * negative bucket and a fill that shrinks as context grows.
 */
export function normalizeUsage(raw: UsageStats, convention: UsageConvention, modelId?: string): UsageStats {
  // Already disjoint. Re-running the OpenAI branch would subtract the cached
  // subset a SECOND time and quietly shrink the fill, so the guarantee this
  // function documents has to be enforced rather than assumed.
  if (raw.normalized) { return raw; }

  const resolved = resolveUsageConvention(convention, modelId);
  const input = nonNegative(raw.input_tokens);
  const output = nonNegative(raw.output_tokens);
  const cacheRead = nonNegative(raw.cache_read_input_tokens);
  const cacheCreate = nonNegative(raw.cache_creation_input_tokens);

  if (resolved === 'openai') {
    // cached ⊆ input — split it out so the buckets stop overlapping.
    const uncached = Math.max(0, input - cacheRead);
    return {
      ...raw,
      normalized: true,
      input_tokens: uncached,
      output_tokens: output,
      ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
      ...(cacheCreate > 0 ? { cache_creation_input_tokens: cacheCreate } : {}),
    };
  }

  // 'anthropic' and 'none' already use disjoint buckets ('none' simply has
  // nothing in the cache ones). Still pass through the sanitizer so a
  // negative/NaN field from a backend can't poison the arithmetic downstream.
  return {
    ...raw,
    normalized: true,
    input_tokens: input,
    output_tokens: output,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreate > 0 ? { cache_creation_input_tokens: cacheCreate } : {}),
  };
}

/**
 * Context fill for a NORMALIZED usage record: every prompt token the model read
 * this turn, cached or not. This is the number that is comparable to a model's
 * context window.
 *
 * Cache-creation tokens count: they were in the prompt. The old formula omitted
 * them, which is the single defect that made the threshold blind to cold turns.
 */
export function contextFillTokens(usage: UsageStats | null | undefined): number {
  if (!usage) { return 0; }
  return nonNegative(usage.input_tokens)
    + nonNegative(usage.cache_creation_input_tokens)
    + nonNegative(usage.cache_read_input_tokens);
}

/**
 * Whether a usage record carries a real measurement at all.
 *
 * Several backends DEFAULT a missing field to 0 rather than omitting `usage`
 * (cursor/hermes/kimi/ollama), so an all-zero record means "the provider told us
 * nothing", not "this turn used no context" — no real turn has zero prompt
 * tokens. Callers must treat a false here as UNKNOWN, never as a measured zero:
 * thresholding on it reads as 0% fill and silently disables compaction.
 */
export function hasUsageSignal(usage: UsageStats | null | undefined): boolean {
  return contextFillTokens(usage) > 0;
}

/** Fill as a percentage of the context window; 0 when either side is unknown. */
export function fillPercent(usage: UsageStats | null | undefined, contextWindow: number): number {
  if (!contextWindow || contextWindow <= 0) { return 0; }
  return (contextFillTokens(usage) / contextWindow) * 100;
}

/**
 * Sum usage records into one (for multi-round-trip runs such as the coordinator's
 * ReAct loop). The result answers "what did this turn COST" — it is NOT a context
 * fill, because the same prefix is re-sent every round-trip. Use
 * `contextFillTokens` on the LAST round-trip's record for fill.
 */
export function addUsage(a: UsageStats, b: UsageStats): UsageStats {
  const cacheRead = nonNegative(a.cache_read_input_tokens) + nonNegative(b.cache_read_input_tokens);
  const cacheCreate = nonNegative(a.cache_creation_input_tokens) + nonNegative(b.cache_creation_input_tokens);
  return {
    // A sum of disjoint buckets is still disjoint — flag it so a later
    // normalize() pass can't subtract the cached part out of the total.
    normalized: true,
    input_tokens: nonNegative(a.input_tokens) + nonNegative(b.input_tokens),
    output_tokens: nonNegative(a.output_tokens) + nonNegative(b.output_tokens),
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreate > 0 ? { cache_creation_input_tokens: cacheCreate } : {}),
    ...(a.estimated || b.estimated ? { estimated: true } : {}),
  };
}
