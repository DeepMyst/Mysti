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
 * PromptCache — explicit prompt-cache breakpoints for the coordinator's own
 * model calls (OpenRouter and the DeepMyst gateway).
 *
 * WHY THIS EXISTS. The coordinator runs a ReAct loop: every round-trip re-sends
 * the entire system prompt (backend roster, tool schemas, skill headers,
 * capability lists — routinely several thousand tokens) plus the whole
 * conversation so far. Neither client declared a single cache breakpoint, so on
 * Anthropic models — where breakpoints are EXPLICIT, unlike OpenAI's automatic
 * prefix caching — an N-round-trip run paid full input price N times over for a
 * prefix that never changed. One `<delegate:>`-heavy turn can be a dozen
 * round-trips.
 *
 * WHAT IT DOES. Marks the stable prefix with `cache_control: {type:'ephemeral'}`,
 * which turns those repeats into cache WRITES (1.25x once) followed by cache
 * READS (0.1x each) — see ModelPricing's CACHE_* multipliers.
 *
 * WHERE IT DOES NOT APPLY. Only models that need an explicit breakpoint get one:
 *
 *   - Anthropic models require it, and are the whole point of this module.
 *   - OpenAI and Google cache long prefixes automatically. Sending them a
 *     `cache_control` part is at best ignored and at worst a 400, so they are
 *     left alone — automatic caching already works there and needs no help.
 *
 * A model we don't recognize is left alone too: the cost of missing a cache is a
 * bigger bill, while the cost of a rejected request is a broken turn.
 */

/**
 * The structural minimum this module needs from a message. Deliberately looser
 * than either client's own message type so both can pass their arrays straight
 * in; every other field rides through untouched on the spread.
 */
export interface CacheableMessage {
  role: string;
  content: unknown;
}

/** Whether this model needs (and accepts) an explicit cache breakpoint. */
export function supportsExplicitCacheControl(model: string | undefined): boolean {
  if (!model) { return false; }
  // Matches both the bare id and OpenRouter's `anthropic/…` namespacing.
  return /(^|\/)anthropic\/|claude|sonnet|opus|haiku/i.test(model);
}

/**
 * Anthropic's minimum cacheable block is 1024 tokens (2048 for the smallest
 * models). Marking anything shorter buys a write premium for a block the API
 * will refuse to cache, which is strictly worse than not marking it. ~4 chars
 * per token, and we use the larger 2048 floor so the decision holds whichever
 * model is behind the id.
 */
const MIN_CACHEABLE_CHARS = 2048 * 4;

/** Convert a string message body into the content-parts form, carrying the breakpoint. */
function withBreakpoint<T extends CacheableMessage>(message: T): T {
  if (typeof message.content !== 'string') {
    // Already in parts form (or something we don't model) — don't rewrite it.
    return message;
  }
  return {
    ...message,
    content: [
      {
        type: 'text',
        text: message.content,
        cache_control: { type: 'ephemeral' },
      },
    ],
  };
}

/**
 * Return `messages` with cache breakpoints on the stable prefix, or unchanged
 * when this model does not take explicit breakpoints.
 *
 * Two breakpoints, both on roles that are safe to express as content parts:
 *
 *   1. The system message — the largest genuinely fixed block, re-sent verbatim
 *      on every round-trip of every turn.
 *   2. The last `user` message — everything before it (prior turns, and the
 *      tool results of earlier round-trips) becomes a cached prefix for the
 *      round-trips that follow.
 *
 * `tool` and `assistant` messages are deliberately not marked: their shape
 * varies across providers (tool_calls arrays, tool_call_id pairing) and a
 * rewrite there risks breaking the call/result pairing for a marginal gain.
 * Anthropic allows four breakpoints; using two leaves headroom and keeps the
 * transformation something a reader can verify at a glance.
 */
export function applyCacheBreakpoints<T extends CacheableMessage>(
  messages: T[],
  model: string | undefined,
): T[] {
  if (!supportsExplicitCacheControl(model) || messages.length === 0) {
    return messages;
  }

  const out = messages.slice();
  let marked = 0;

  const systemIndex = out.findIndex(m => m.role === 'system');
  if (systemIndex >= 0) {
    const sys = out[systemIndex];
    if (typeof sys.content === 'string' && sys.content.length >= MIN_CACHEABLE_CHARS) {
      out[systemIndex] = withBreakpoint(sys);
      marked++;
    }
  }

  // Last user message, only when there is real prefix ahead of it to cache.
  for (let i = out.length - 1; i > systemIndex; i--) {
    if (out[i].role !== 'user') { continue; }
    const precedingChars = out
      .slice(0, i)
      .reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    if (precedingChars >= MIN_CACHEABLE_CHARS) {
      out[i] = withBreakpoint(out[i]);
      marked++;
    }
    break;
  }

  return marked > 0 ? out : messages;
}

/** Cached/creation token counts pulled out of a provider's `usage` object. */
export interface CacheTokenReport {
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Read cache figures out of an OpenAI-compatible `usage` object.
 *
 * Three shapes are accepted because the gateway, OpenRouter and first-party
 * endpoints each report a different one, and neither client read ANY of them
 * before — so every coordinator cache hit was invisible to the ledger, the
 * savings popover and the warmth decision alike.
 *
 * NOTE the convention: `cached_tokens` is a SUBSET of `prompt_tokens`, not an
 * addition to it. Callers must hand the result to `normalizeUsage` with the
 * `openai` convention rather than adding the two together.
 */
export function readCacheTokens(usage: unknown): CacheTokenReport {
  if (!usage || typeof usage !== 'object') { return {}; }
  const u = usage as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? u.input_tokens_details) as Record<string, unknown> | undefined;

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

  const cacheRead =
    num(details?.cached_tokens)
    ?? num(u.cache_read_input_tokens)
    ?? num(u.cached_tokens);

  const cacheCreation =
    num(u.cache_creation_input_tokens)
    ?? num((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_5m_input_tokens);

  return {
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
  };
}
