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
 * CoordinatorModelClient — the single "run the Mysti coordinator model" entry the
 * Mysti agent uses for its own answer + decomposition/synthesis.
 *
 * Policy (2026-07-10): runs through the **DeepMyst gateway** by default, using
 * the signed-in DeepMyst account's `dm_` key — NO local model key required. A
 * DeepMyst account is required (free is fine; not gated on paid entitlement — the
 * gateway meters usage against the account's own credits). If a user explicitly
 * sets `mysti.openrouter.apiKey`, that OpenRouter key is used instead (power-user
 * opt-in). When neither is available, the client reports it needs sign-in so the
 * UI can prompt the user.
 */

import type { GatewayChatMessage, DeepMystGatewayClient } from './DeepMystGatewayClient';
import type { AccumulatedToolCall } from '../utils/toolCallAccumulator';
import { modelSupportsToolCalls } from './coordinatorTools';
import { normalizeUsage } from './TokenAccounting';
import type { OpenRouterClient } from './OpenRouterClient';

export interface CoordinatorConfig {
  /**
   * Ordered gateway models the coordinator tries (via the dm_ key). Free-tier
   * OpenRouter models have a hard rpm cap, so this is a curated list of FREE
   * models tried in turn: on a rate-limit (before any text streams) the client
   * advances to the next, maximizing free usage.
   */
  freeModels: string[];
  /**
   * Cheap PAID gateway model tried after every free model is rate-limited.
   * Covered by a free DeepMyst account's monthly credits. Empty ⇒ free-only.
   */
  gatewayFallbackModel: string;
  /** OpenRouter model when the user opts in with a key ('auto' ⇒ discover a free model). */
  openRouterModel: string;
}

/**
 * Free coordinator models via the DeepMyst gateway (litellm `openrouter/` prefix
 * selects the OpenRouter provider; the remainder is the OpenRouter slug).
 *
 * The coordinator has to reliably follow the delegation protocol and produce
 * coherent output, so we pin STRONG concrete free models (strongest first,
 * reviewed 2026-07 from openrouter.ai/collections/free-models) rather than
 * OpenRouter's random `openrouter/free` auto-router — the router picks any free
 * model including weak ones that can't follow the protocol (observed emitting a
 * bare "User Safety: safe" instead of delegating). The list is still a chain:
 * on a rate-limit the coordinator rolls to the next strong free model (graceful
 * degradation), and only then to the paid `gatewayFallbackModel`.
 *
 * To use the random free auto-router instead, set `mysti.mysti.freeModels` to
 * `["openrouter/openrouter/free"]` (note the DOUBLED prefix — a bare
 * `openrouter/free` mis-parses as model=`free` → 502 "Invalid URL").
 */
export const MYSTI_DEFAULT_FREE_MODELS: string[] = [
  'openrouter/openai/gpt-oss-120b:free',             // primary — 117B MoE, reasoning + function calling (strong, proven)
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free', // 120B MoE, RL-trained, agentic
  'openrouter/google/gemma-4-31b-it:free',           // 30.7B dense, function calling, fast
];

export interface CoordinatorCompletion {
  text: string;
  failed: boolean;
  /** True when the answering model was NOT the first in the chain (a later free
   * model or the paid fallback took over after an earlier one was rate-limited). */
  viaFallback: boolean;
  error?: string;
  costUsd?: number;
  /** The model that actually produced the answer (may differ from chain[0]
   * when the chain fell through, or be the concrete model behind a router id). */
  model?: string;
}

/** Raw usage as the OpenRouter/gateway clients report it. */
interface ClientUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** SUBSET of inputTokens (OpenAI convention) — see PromptCache.readCacheTokens. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Convert a client's raw usage into the canonical disjoint shape.
 *
 * The clients speak the OpenAI convention, where cached tokens are a SUBSET of
 * the prompt count; `normalizeUsage` subtracts them out so that
 * input + cache_creation + cache_read is the round-trip's prompt with nothing
 * counted twice. Everything downstream (the run's fill, the Boost record, the
 * savings ledger) assumes that shape.
 */
function coordinatorUsage(u: ClientUsage): NonNullable<CoordinatorStreamEvent['usage']> {
  const normalized = normalizeUsage(
    {
      input_tokens: u.inputTokens ?? 0,
      output_tokens: u.outputTokens ?? 0,
      ...(u.cacheReadTokens ? { cache_read_input_tokens: u.cacheReadTokens } : {}),
      ...(u.cacheCreationTokens ? { cache_creation_input_tokens: u.cacheCreationTokens } : {}),
    },
    'openai',
  );
  return {
    input_tokens: normalized.input_tokens,
    output_tokens: normalized.output_tokens,
    ...(normalized.cache_read_input_tokens ? { cache_read_input_tokens: normalized.cache_read_input_tokens } : {}),
    ...(normalized.cache_creation_input_tokens ? { cache_creation_input_tokens: normalized.cache_creation_input_tokens } : {}),
  };
}

/** One streamed delta from the coordinator model. */
export interface CoordinatorStreamEvent {
  text?: string;
  reasoning?: string;
  /**
   * Prompt/completion tokens for ONE round-trip, in the canonical disjoint shape
   * (see src/services/TokenAccounting.ts). `cache_read_input_tokens` has already
   * been split OUT of `input_tokens` here, so the three add up to the round-trip's
   * prompt — the caller must not re-derive that split.
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  done?: boolean;
  error?: string;
  /** The model that actually answered (the concrete model behind a router id, or
   * the later chain entry that took over). Consumers persist this as attribution. */
  model?: string;
  /** 'length' ⇒ max_tokens cut the turn — the caller can auto-continue (P0.5). */
  finishReason?: string;
  /** Real billed cost for this stream (X-DeepMyst-Cost-USD), when reported (P0.8). */
  costUsd?: number;
  /** Plan 19 P4: the coordinator model requested native tool calls this turn. */
  toolCalls?: AccumulatedToolCall[];
}

/** Message shown when the Mysti agent has no credential to run on. */
export const MYSTI_SIGNIN_MESSAGE =
  'Sign in to DeepMyst to use the Mysti agent — it runs on your DeepMyst account (free works). No local API key needed.';

/**
 * Why a coordinator turn could not run (Plan 25). Each reason maps to a set of
 * BUTTONS in the chat, not to a sentence — a credential failure the user cannot
 * act on from where they are reading it is a dead end.
 */
export type CoordinatorFailureReason =
  /** No credential at all — sign in (or create an account). */
  | 'signin'
  /** A DeepMyst key exists and was rejected (401/403) — it is stale/revoked. */
  | 'auth-rejected'
  /** The OpenRouter key the user opted into was rejected — NOT a DeepMyst problem. */
  | 'openrouter-rejected'
  /** 402 / out of credits — top up, or switch to a local agent. */
  | 'credits'
  /** Anything else: shown as an ordinary error. */
  | 'other';

/** What the caller knows about which credential the failed turn actually used. */
export interface CoordinatorCredentialState {
  /** A `dm_` key is stored (so a 401 means it went stale, not that it is missing). */
  hasDeepMystKey: boolean;
  /** The run used the OpenRouter opt-in path rather than the DeepMyst gateway. */
  usingOpenRouter: boolean;
}

/**
 * Classify a raw coordinator/gateway error into an actionable reason.
 *
 * Deliberately mirrors the hard-stop test in `_isRetryable` — those are exactly
 * the failures that fail identically on every model in the chain, i.e. the ones
 * a user has to resolve rather than wait out. The credential state decides WHOSE
 * credential to blame: telling someone on the OpenRouter path to "sign in to
 * DeepMyst again" is advice that fixes nothing.
 */
export function classifyCoordinatorFailure(
  raw: string,
  credentials: CoordinatorCredentialState,
): CoordinatorFailureReason {
  const err = raw || '';
  // Payment first: a 402 body often ALSO mentions the key/account, and
  // "out of credits" is a different action from "signed out".
  if (/\b402\b|insufficient[_ ]?(credit|funds|quota|balance)|out of credit|payment required|top[_ ]?up/i.test(err)) {
    return 'credits';
  }
  if (/\b40[13]\b|unauthoriz|forbidden|invalid[_ ]?(api|key)|invalid[_ ]?api[_ ]?key|no auth credentials|authentication/i.test(err)) {
    if (credentials.usingOpenRouter) { return 'openrouter-rejected'; }
    return credentials.hasDeepMystKey ? 'auth-rejected' : 'signin';
  }
  return 'other';
}

export class CoordinatorModelClient {
  /**
   * Sticky chain index (P0.5): remember which chain entry last answered so a
   * multi-turn agentic run doesn't re-hit a rate-limited free model on every
   * turn. Expires after a few minutes — free-tier rpm windows pass, so we
   * drift back to the cheapest entry instead of sticking to the paid fallback
   * forever.
   */
  private _stickyIndex = 0;
  private _stickyAt = 0;
  private static readonly _STICKY_TTL_MS = 10 * 60 * 1000;
  /** Per-turn stream ceiling — long agentic turns on slow free models need more than the 120s default. */
  private static readonly _STREAM_TIMEOUT_MS = 300_000;

  constructor(
    private readonly _gateway: DeepMystGatewayClient,
    private readonly _openRouter: OpenRouterClient,
    private readonly _isSignedIn: () => boolean,
    private readonly _getConfig: () => CoordinatorConfig,
  ) {}

  /** OpenRouter is used ONLY when the user explicitly configured a key (opt-in). */
  private _useOpenRouter(): boolean {
    return this._openRouter.isConfigured();
  }

  /**
   * Readiness for the Mysti agent. `ready:false, reason:'signin'` ⇒ the user must
   * sign in to DeepMyst (default path) — or set an OpenRouter key (opt-in).
   */
  status(): { ready: boolean; reason?: 'signin' } {
    if (this._useOpenRouter()) { return { ready: true }; }
    return this._isSignedIn() ? { ready: true } : { ready: false, reason: 'signin' };
  }

  /**
   * Which credential a turn would run on (Plan 25). The UI needs this to tell a
   * stale DeepMyst key apart from a rejected OpenRouter key — both surface as a
   * bare 401 from very different places.
   */
  credentialState(): CoordinatorCredentialState {
    return { hasDeepMystKey: this._isSignedIn(), usingOpenRouter: this._useOpenRouter() };
  }

  /** The model id the coordinator will run on (first free gateway model, or the OpenRouter opt-in). */
  public async resolveCoordinatorModel(): Promise<string> {
    if (this._useOpenRouter()) {
      const m = (this._getConfig().openRouterModel || 'auto').trim();
      return m && m.toLowerCase() !== 'auto' ? m : this._openRouter.getDefaultFreeModel();
    }
    const chain = this._gatewayChain(this._getConfig());
    return chain[0] ?? this._getConfig().gatewayFallbackModel;
  }

  /**
   * Ordered, de-duplicated gateway model chain: every configured free model,
   * then the paid fallback. Blank entries are dropped. The client walks this on
   * rate-limit — free-tier models are rpm-capped, so a cap on one rolls over to
   * the next free model, and only then to the paid fallback.
   */
  private _gatewayChain(cfg: CoordinatorConfig): string[] {
    const seen = new Set<string>();
    const chain: string[] = [];
    for (const raw of [...(cfg.freeModels ?? []), cfg.gatewayFallbackModel]) {
      const id = (raw || '').trim();
      if (id && !seen.has(id)) { seen.add(id); chain.push(id); }
    }
    return chain;
  }

  /**
   * Fresh sticky start index for a chain of `len` models (P0.5): resume from the
   * entry that last answered while the stickiness is fresh, else the cheapest
   * entry (index 0). Shared by the streaming and non-streaming paths so both
   * walk from the same learned chain position.
   */
  private _stickyStart(len: number): number {
    return Date.now() - this._stickyAt < CoordinatorModelClient._STICKY_TTL_MS
      ? Math.max(0, Math.min(this._stickyIndex, len - 1))
      : 0;
  }

  /**
   * Stamp the winning chain index. Re-arms on an index CHANGE (measures time-
   * since-demotion, not time-since-use → after the TTL a run re-probes from
   * index 0 instead of pinning to paid forever) OR when the current stamp is
   * already EXPIRED (re-pin a persistently-down free tier to the winner for
   * another TTL rather than re-probing free every turn).
   */
  private _stampSticky(i: number): void {
    if (this._stickyIndex !== i || Date.now() - this._stickyAt >= CoordinatorModelClient._STICKY_TTL_MS) {
      this._stickyIndex = i;
      this._stickyAt = Date.now();
    }
  }

  /**
   * After a failed walk that skipped the chain prefix (sticky > 0), drop the
   * stickiness so the next call retries from the cheapest entry (it may have
   * recovered).
   */
  private _resetStickyIfSkipped(sticky: number): void {
    if (sticky > 0) { this._stickyAt = 0; }
  }

  /** Non-streaming completion (decompose/synthesize). */
  public async complete(
    messages: GatewayChatMessage[],
    opts: { maxTokens?: number; signal?: AbortSignal } = {},
  ): Promise<CoordinatorCompletion> {
    if (this._useOpenRouter()) {
      const model = await this.resolveCoordinatorModel();
      const r = await this._openRouter.chatCompletion({ model, messages, maxTokens: opts.maxTokens, signal: opts.signal });
      return r.failed
        ? { text: '', failed: true, viaFallback: false, error: r.error || 'OpenRouter failed' }
        : { text: r.text, failed: false, viaFallback: false, costUsd: r.costUsd };
    }
    if (!this._isSignedIn()) {
      return { text: '', failed: true, viaFallback: false, error: MYSTI_SIGNIN_MESSAGE };
    }
    const cfg = this._getConfig();
    const chain = this._gatewayChain(cfg);
    if (chain.length === 0) {
      return { text: '', failed: true, viaFallback: false, error: 'No coordinator model configured' };
    }
    // Start from the same sticky index the streaming path learned (P0.5) so
    // decompose/synthesize don't re-probe a model the stream already found
    // rate-limited. Fresh/expired stickiness ⇒ index 0.
    const sticky = this._stickyStart(chain.length);
    // Walk the free→paid chain: on a transient failure (rpm cap, provider drop,
    // 5xx, mid-stream fallback) advance to the next model; a hard error stops.
    let last: Awaited<ReturnType<DeepMystGatewayClient['chatCompletion']>> | undefined;
    for (let i = sticky; i < chain.length; i++) {
      last = await this._gateway.chatCompletion({ model: chain[i], messages, maxTokens: opts.maxTokens, signal: opts.signal });
      if (!last.failed) {
        this._stampSticky(i);
        return { text: last.text, failed: false, viaFallback: i > 0, costUsd: last.costUsd, model: last.model || chain[i] };
      }
      if (i < chain.length - 1 && this._isRetryable(last.error || '')) { continue; }
      break;
    }
    // Failed walk that skipped the prefix → retry from the cheapest entry next time.
    this._resetStickyIfSkipped(sticky);
    return { text: '', failed: true, viaFallback: false, error: last?.error || 'DeepMyst gateway failed' };
  }

  /** Stream a completion token-by-token (Mysti's default answer + delegation loop). */
  public async *stream(
    messages: GatewayChatMessage[],
    opts: { maxTokens?: number; reasoningEffort?: 'low' | 'medium' | 'high'; signal?: AbortSignal; tools?: unknown[] } = {},
  ): AsyncGenerator<CoordinatorStreamEvent> {
    if (this._useOpenRouter()) {
      // Match the gateway path's generous ceiling (was OpenRouterClient's 120s
      // default, which killed any coordinator turn > 2 min). OpenRouterClient
      // treats this as a total-stream timeout; the idle-watchdog refinement
      // lives in the gateway client's read loop.
      // Gate tools on the ACTUAL resolved model — the caller decides coordTools
      // from the primary, but only attach them when THIS model is tool-capable
      // so a non-capable model never 400s on an unsupported `tools` field
      // (review round-5 #5/#9).
      const orModel = await this.resolveCoordinatorModel();
      yield* this._drain(this._openRouter.streamChat({ model: orModel, messages, maxTokens: opts.maxTokens, reasoningEffort: opts.reasoningEffort, signal: opts.signal, timeoutMs: CoordinatorModelClient._STREAM_TIMEOUT_MS, tools: modelSupportsToolCalls(orModel) ? opts.tools : undefined }));
      return;
    }
    if (!this._isSignedIn()) {
      yield { error: MYSTI_SIGNIN_MESSAGE };
      return;
    }
    yield* this._streamGatewayChain(this._gatewayChain(this._getConfig()), messages, opts);
  }

  /**
   * Stream through the free→paid model chain. For each model: if it emits text,
   * that model owns the answer (a late error is surfaced, never silently
   * completed — we can't cleanly restart a partially-rendered bubble). If it
   * fails with a transient error BEFORE any text (rpm cap, provider drop, 5xx,
   * mid-stream fallback) and another model remains, advance to the next. Any
   * other failure — or the last model — surfaces the error.
   */
  private async *_streamGatewayChain(
    models: string[],
    messages: GatewayChatMessage[],
    opts: { maxTokens?: number; reasoningEffort?: 'low' | 'medium' | 'high'; signal?: AbortSignal; tools?: unknown[] },
  ): AsyncGenerator<CoordinatorStreamEvent> {
    // Empty-chain guard, symmetric with complete() (review [19]) — otherwise a
    // fresh sticky computes Math.min(0, -1) = -1 ⇒ models[-1] undefined ⇒ a
    // model-less POST ⇒ raw HTTP 400 instead of this friendly message.
    if (models.length === 0) { yield { error: 'No coordinator model configured' }; return; }
    // Sticky start (P0.5): resume from the entry that last answered while the
    // stickiness is fresh; expired ⇒ back to the cheapest entry.
    const sticky = this._stickyStart(models.length);
    for (let i = sticky; i < models.length; i++) {
      const isLast = i === models.length - 1;
      let sawText = false;
      let streamErr: string | undefined;
      // The concrete model the gateway resolved to (behind a router id); falls
      // back to the requested id so attribution always names a real model.
      let resolvedModel: string | undefined;
      // Hold this attempt's cost and only surface it once the attempt OWNS the
      // answer — a failed pre-text attempt that advances must not add its head
      // cost to the total (review [18]).
      let attemptCost: number | undefined;
      // Per-model tool gating (review round-5 #5/#9): coordTools is decided from
      // the PRIMARY, but the chain walks free→paid — attach `tools` only to a
      // model that actually supports them so a non-capable fallback can't 400 on
      // an unsupported field and break a run the text protocol would've survived.
      const modelTools = modelSupportsToolCalls(models[i]) ? opts.tools : undefined;
      for await (const ev of this._gateway.streamChat({ model: models[i], messages, maxTokens: opts.maxTokens, reasoningEffort: opts.reasoningEffort, signal: opts.signal, timeoutMs: CoordinatorModelClient._STREAM_TIMEOUT_MS, tools: modelTools })) {
        if (ev.error) { streamErr = ev.error; break; }
        if (ev.model) { resolvedModel = ev.model; yield { model: ev.model }; }
        if (ev.reasoning) { yield { reasoning: ev.reasoning }; }
        if (ev.costUsd !== undefined) { attemptCost = ev.costUsd; }
        if (ev.text) {
          if (!sawText) {
            sawText = true;
            this._stampSticky(i);
            if (!resolvedModel) { yield { model: models[i] }; }
            if (attemptCost !== undefined) { yield { costUsd: attemptCost }; attemptCost = undefined; }
          }
          yield { text: ev.text };
        }
        if (ev.usage) { yield { usage: coordinatorUsage(ev.usage) }; }
        if (ev.toolCalls && ev.toolCalls.length) {
          // A finalized tool_call set means THIS attempt OWNS the turn (mirrors
          // first-text ownership at L297): stamp sticky + surface the held cost,
          // and — via sawText — never fail over to the next chain model
          // afterwards. Without this, a retryable error AFTER the toolCalls were
          // emitted would `continue` to the next model and merge two models into
          // one turn, or a to-be-abandoned attempt's toolCalls would still reach
          // the consumer and get dispatched (review round-5 #4/#6).
          if (!sawText) {
            sawText = true;
            this._stampSticky(i);
            if (!resolvedModel) { yield { model: models[i] }; }
            if (attemptCost !== undefined) { yield { costUsd: attemptCost }; attemptCost = undefined; }
          }
          yield { toolCalls: ev.toolCalls };
        }
        if (ev.finishReason) { yield { finishReason: ev.finishReason }; }
        if (ev.done) {
          if (!resolvedModel && !sawText) { yield { model: models[i] }; }
          if (attemptCost !== undefined) { yield { costUsd: attemptCost }; } // owns the (possibly empty) answer
          yield { done: true };
          return;
        }
      }
      if (sawText) {
        // Text already streamed — surface a late error, else complete.
        yield streamErr ? { error: streamErr } : { done: true };
        return;
      }
      // Nothing streamed. Transient error and another model remains → advance.
      if (streamErr && !isLast && this._isRetryable(streamErr)) { continue; }
      // Failed walk that skipped the chain prefix: drop stickiness so the next
      // call retries from the cheapest entry (it may have recovered).
      this._resetStickyIfSkipped(sticky);
      yield { error: streamErr || 'No response from the coordinator model' };
      return;
    }
    this._resetStickyIfSkipped(sticky);
    yield { error: 'No coordinator model configured' };
  }

  /** Normalize an OpenRouter/gateway stream into CoordinatorStreamEvents. */
  private async *_drain(source: AsyncGenerator<{ text?: string; reasoning?: string; usage?: ClientUsage; done?: boolean; error?: string; finishReason?: string; costUsd?: number; toolCalls?: AccumulatedToolCall[] }>): AsyncGenerator<CoordinatorStreamEvent> {
    let sawText = false;
    let sawToolCalls = false;
    let streamErr: string | undefined;
    for await (const ev of source) {
      if (ev.error) { streamErr = ev.error; break; }
      if (ev.reasoning) { yield { reasoning: ev.reasoning }; }
      if (ev.text) { sawText = true; yield { text: ev.text }; }
      if (ev.usage) { yield { usage: coordinatorUsage(ev.usage) }; }
      if (ev.toolCalls) { sawToolCalls = true; yield { toolCalls: ev.toolCalls }; }
      // [8]: forward finish_reason so the OpenRouter-key path also auto-continues
      // on a length truncation (was gateway-path-only).
      if (ev.finishReason) { yield { finishReason: ev.finishReason }; }
      if (ev.costUsd !== undefined) { yield { costUsd: ev.costUsd }; }
      if (ev.done) { yield { done: true }; return; }
    }
    if (streamErr) { yield { error: streamErr }; return; }
    // A tool-call-only turn legitimately emits no text; treat it as complete.
    if (sawText || sawToolCalls) { yield { done: true }; return; }
    yield { error: 'No response from the coordinator model' };
  }

  /**
   * Whether a gateway/model failure is worth retrying on the NEXT model in the
   * chain (used only BEFORE any text has streamed). A positive allowlist of
   * transient/model-specific signals — NOT "any error".
   *
   * HARD STOP first: 401/402/403 auth / out-of-credits / content-policy /
   * context-length failures fail IDENTICALLY on every model, so they must stop —
   * never walk the whole chain and burn a paid fallback call. This guard also
   * makes stream() and complete() symmetric: streamChat appends the response
   * BODY to its error (which may contain a transient word), so without the guard
   * an HTTP 402 whose body says "provider returned error" would wrongly advance.
   *
   * Otherwise retry on: rpm caps (429 / "rate limit" / "too many requests" /
   * quota); transient upstream/provider drops on flaky free models (5xx,
   * "provider returned error", "no (allowed) providers/endpoints", overloaded,
   * MidStreamFallbackError / "stream interrupted", timeouts); generic transport
   * failures — undici collapses these to "fetch failed" / "terminated" and hides
   * the code (ECONNRESET/ENOTFOUND/…) in err.cause, which the gateway now
   * appends; and THIS model id being unusable (400/404, model-not-found,
   * invalid/unknown model) so an unverified router id degrades gracefully to the
   * concrete free models behind it.
   */
  private _isRetryable(err: string): boolean {
    // Hard stops — fail the same on every model; do not walk the chain. The
    // `insufficient`/`violat` matches are anchored to their PAYMENT/POLICY
    // phrasings so transient capacity/rate errors ("insufficient capacity",
    // "rate limit violation") stay retryable and still roll to the next model.
    if (/\b40[123]\b|unauthoriz|forbidden|invalid[_ ]?(api|key)|api[_ ]?key|insufficient[_ ]?(credit|funds|quota|balance)|out of credit|payment required|content[_ ]?(policy|filter)|(policy|content)[_ ]?violat|context[_ ]?length|maximum context|prompt is too long|too many tokens/i.test(err)) {
      return false;
    }
    return /\b429\b|\b5\d{2}\b|\b40[04]\b|rate.?limit|temporarily rate|too many requests|quota|mid.?stream|stream interrupted|provider (returned|error)|no (allowed )?(providers|endpoints)|overloaded|unavailable|timed? ?out|timeout|econnreset|econnrefused|enotfound|eai_again|epipe|socket hang|other side closed|fetch failed|terminated|network error|connection (reset|closed|error)|(model|it) (was )?not found|no such model|(invalid|unknown|unsupported) model|not a valid model/i.test(err);
  }
}
