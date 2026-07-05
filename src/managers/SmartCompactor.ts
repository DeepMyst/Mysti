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
 * SmartCompactor (Plan 08 — DeepMyst-gated smart compaction engine).
 *
 * The intelligence behind smart compaction:
 *  - cache-warmth tracking per panel (observational, cache-reporting providers);
 *  - an entitlement-aware activation gate (signed in + paid or within free tier);
 *  - a cache-aware + economic decision (compact when the cache is cold and the
 *    expected savings beat the cache value: N >= N*), with a min-summary quality
 *    floor so we never over-compact below the cacheable prefix;
 *  - an INCREMENTAL structured-memory summarizer run on a cheap model through the
 *    DeepMyst gateway (folds prior memory + new turns, not the whole history);
 *  - realized-savings recording into the ledger.
 *
 * It is provider-agnostic (talks to the gateway directly) and degrades to a
 * `null` result whenever the gateway is unavailable, so CompactionManager can
 * fall back to the existing client-summarize path.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  CacheWarmth,
  CompactionDecision,
  CompactionResult,
  Conversation,
  Message,
  SavingsSnapshot,
  UsageStats,
} from '../types';
import {
  PROMPT_CACHE_TTL_MS,
  SMART_CRITICAL_FILL_PERCENT,
  SMART_MIN_SUMMARY_TOKENS,
  SMART_DEFAULT_REMAINING_TURNS,
  COMPACTION_MESSAGES_TO_PRESERVE,
} from '../constants';
import {
  getModelRate,
  estimateTokens,
  tokensCostUsd,
  cacheReadCostUsd,
  cacheWriteCostUsd,
} from '../services/ModelPricing';
import type { DeepMystAuthManager } from './DeepMystAuthManager';
import type { DeepMystGatewayClient } from '../services/DeepMystGatewayClient';
import type { SavingsLedger } from './SavingsLedger';
import { HistoryStore, safePanelSegment } from '../services/HistoryStore';
import { RetrievalCoordinator } from './RetrievalCoordinator';

/** Min gap between parallel-retrieval runs per panel, to bound scorer cost. */
const RETRIEVAL_COOLDOWN_MS = 20_000;

interface CacheState {
  lastTurnAt: number;
  lastCacheRead: number;
}

export interface HistoryAppend {
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'tool_use' | 'tool_result';
  content: string;
  ts: number;
  msgId?: string;
}

// ── Delta-patch memory (deterministic, cache-drift-resistant) ─────────────────
//
// Instead of re-emitting the whole memory.md every compaction (which makes the
// cheap model paraphrase stable facts and drift over many epochs), we ask it for
// section-scoped PATCHES and apply them deterministically in-process. Unchanged
// sections are carried over byte-for-byte from the prior memory, so long-running
// sessions don't accrete summarization drift. Fully fallback-safe: if the model
// doesn't return a valid patch array we treat its text as a full-memory rewrite
// (the original behaviour), so a misbehaving model never corrupts memory.

/** Canonical section order the memory prompt asks the model to maintain. */
export const MEMORY_SECTION_ORDER = ['Goal', 'Decisions', 'Files', 'Code', 'Open Threads'] as const;

export interface MemoryPatch {
  section: string;
  op: 'replace' | 'append' | 'remove';
  content?: string;
}

/** Strip only leading/trailing BLANK lines — preserves internal indentation (Code blocks). */
function trimBlankLines(s: string): string {
  return s.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

/**
 * Parse a memory.md string into ordered sections keyed by `## <name>` headings.
 * Content before the first heading is ignored (memory files have none). Section
 * bodies are blank-line-trimmed for byte-stability across compactions.
 *
 * Fence-aware: a `## ` line INSIDE a fenced code block (``` or ~~~) is body
 * content, not a heading — critical for the Code section, whose snippets may
 * contain markdown/shell/python `##` lines. Duplicate headings are MERGED (their
 * bodies concatenated) rather than the last one clobbering the earlier, so a
 * reparse is lossless.
 */
export function parseMemorySections(md: string): { order: string[]; bodies: Map<string, string> } {
  const bodies = new Map<string, string>();
  const order: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  let inFence = false;
  let fenceChar = '';
  const flush = () => {
    if (current === null) { return; }
    const body = trimBlankLines(buf.join('\n'));
    const prev = bodies.get(current);
    // Merge duplicate headings (concatenate) instead of overwriting.
    bodies.set(current, prev && prev.trim() ? (body.trim() ? `${prev}\n${body}` : prev) : body);
  };
  for (const line of (md || '').split(/\r?\n/)) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (ch === fenceChar) { inFence = false; fenceChar = ''; }
      if (current !== null) { buf.push(line); }
      continue;
    }
    const m = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1];
      if (!order.includes(current)) { order.push(current); }
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return { order, bodies };
}

/** Reserialize sections in canonical order (known first, then novel) — omits empty bodies. */
export function serializeMemory(order: string[], bodies: Map<string, string>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const emit = (name: string) => {
    if (seen.has(name)) { return; }
    const body = bodies.get(name);
    if (body === undefined || body.trim() === '') { return; }
    seen.add(name);
    out.push(`## ${name}\n${body}`);
  };
  for (const name of MEMORY_SECTION_ORDER) { emit(name); }
  for (const name of order) { emit(name); }
  return out.join('\n\n').trim() + '\n';
}

/** Apply a validated patch list to an existing memory string, deterministically. */
export function applyMemoryPatches(existing: string, patches: MemoryPatch[]): string {
  const { order, bodies } = parseMemorySections(existing);
  for (const p of patches) {
    if (!p || typeof p.section !== 'string') { continue; }
    const section = p.section.trim();
    if (!section) { continue; }
    if (p.op === 'remove') {
      bodies.delete(section);
      continue;
    }
    const content = trimBlankLines(String(p.content ?? ''));
    // A replace/append with no body is a malformed patch — never silently CLEAR
    // a durable section (that must go through an explicit `remove`). Skip it so
    // the existing section carries over byte-for-byte.
    if (!content) { continue; }
    if (p.op === 'append') {
      const prev = bodies.get(section);
      bodies.set(section, prev && prev.trim() ? `${prev}\n${content}` : content);
    } else {
      // 'replace' (and any unexpected op that slipped validation) → set the body.
      bodies.set(section, content);
    }
    if (!order.includes(section)) { order.push(section); }
  }
  return serializeMemory(order, bodies);
}

/**
 * Try to read a JSON patch array out of a model response (tolerant of ```json
 * fences and surrounding prose), validate each element, and apply it. Returns
 * the patched memory, or `null` when the text isn't a usable patch array so the
 * caller can fall back to treating the text as a full-memory rewrite.
 */
export function tryApplyMemoryPatches(existing: string, modelText: string): string | null {
  const patches = extractPatchArray(modelText);
  if (!patches) { return null; }
  // Explicit "nothing changed" ([]): keep the existing memory VERBATIM (byte
  // stable) rather than normalizing it through parse/serialize.
  if (patches.length === 0) { return existing.trim() ? existing : null; }
  try {
    const result = applyMemoryPatches(existing, patches);
    return result.trim() ? result : null;
  } catch {
    return null;
  }
}

/**
 * Find the FIRST `[` that begins a balanced, string-aware span parsing to a JSON
 * array. Skips `[`/`]` inside string literals (honouring escapes) and stray
 * brackets in surrounding prose, so a patch's own content (which may contain
 * brackets or fenced snippets) can't hijack extraction.
 */
function firstJsonArray(t: string): unknown[] | null {
  for (let start = t.indexOf('['); start !== -1; start = t.indexOf('[', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === '\\') { esc = true; }
        else if (ch === '"') { inStr = false; }
        continue;
      }
      if (ch === '"') { inStr = true; }
      else if (ch === '[') { depth++; }
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(t.slice(start, i + 1));
            if (Array.isArray(v)) { return v; }
          } catch { /* not valid JSON — try the next '[' */ }
          break;
        }
      }
    }
  }
  return null;
}

function extractPatchArray(text: string): MemoryPatch[] | null {
  if (!text || !text.trim()) { return null; }
  const t = text.trim();
  // Parse the array out of the FULL text first (so a fenced snippet inside a
  // patch's content value can't hijack extraction); only if that fails, retry
  // against a ```json fence that wraps the whole array.
  let parsed = firstJsonArray(t);
  if (parsed === null) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (fence) { parsed = firstJsonArray(fence[1].trim()); }
  }
  if (parsed === null) { return null; }
  // An explicit empty array is a valid "nothing changed" response.
  if (parsed.length === 0) { return []; }
  const out: MemoryPatch[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') { continue; }
    const rec = item as Record<string, unknown>;
    if (typeof rec.section !== 'string' || typeof rec.op !== 'string') { continue; }
    const op = rec.op.trim().toLowerCase();
    if (op !== 'replace' && op !== 'append' && op !== 'remove') { continue; }
    // append/replace REQUIRE a string body; a non-string (or missing) content
    // would otherwise be String()-coerced ("123", "[object Object]") into memory.
    if ((op === 'append' || op === 'replace') && typeof rec.content !== 'string') { continue; }
    out.push({ section: rec.section, op, content: typeof rec.content === 'string' ? rec.content : undefined });
  }
  return out.length ? out : null;
}

export interface EvaluateParams {
  panelId: string;
  usage: UsageStats;
  contextWindow: number;
  messageCount: number;
  /** The user's active (main) model id, for pricing. */
  providerModel: string;
  /** The cheap compactor model id (gateway-priced). */
  cheapModel: string;
  thresholdPercent: number;
  minSummaryTokens: number;
  /**
   * Estimated tokens in the messages we keep verbatim past a compaction. On the
   * smart path we reseed a fresh (cold) session with `[summary, ...preserved]`,
   * so re-priming the cache writes the summary PLUS these preserved tokens, not
   * just the summary. Folded into the break-even so N* stays honest. Optional —
   * omitted callers just under-count the reseed overhead (older behaviour).
   */
  preserveTokens?: number;
}

export interface SummarizeParams {
  panelId: string;
  conversation: Conversation;
  providerModel: string;
  cheapModel: string;
  minSummaryTokens: number;
  signal?: AbortSignal;
}

export class SmartCompactor {
  private readonly _cacheState = new Map<string, CacheState>();
  private readonly _lastRetrievalAt = new Map<string, number>();
  private _history: HistoryStore | null = null;
  private _retrieval: RetrievalCoordinator | null = null;

  // Measured N (remaining turns) — an EWMA of completed compaction epochs
  // (turns observed between one compaction and the next). Replaces the fixed
  // SMART_DEFAULT_REMAINING_TURNS guess in the break-even gate once we have any
  // real sample. Global (cross-panel) so a fresh panel benefits immediately.
  private static readonly _EPOCH_ALPHA = 0.3;
  private readonly _turnsSinceCompaction = new Map<string, number>();
  private _epochEwma: number | null = null;
  private _epochSamples = 0;

  constructor(
    private readonly _auth: DeepMystAuthManager,
    private readonly _gateway: DeepMystGatewayClient,
    private readonly _ledger: SavingsLedger,
  ) {}

  // ── Activation gate ─────────────────────────────────────────────────────────

  /** Smart compaction is active iff the user enabled it AND is signed in AND entitled. */
  isActive(smartEnabledSetting: boolean): boolean {
    return smartEnabledSetting && this._auth.isSignedIn() && this._auth.hasEntitlement();
  }

  // ── Cache-warmth tracking ────────────────────────────────────────────────────

  /** Record a completed turn's cache signal for warmth reasoning. */
  recordTurn(panelId: string, usage: UsageStats): void {
    this._cacheState.set(panelId, {
      lastTurnAt: Date.now(),
      lastCacheRead: usage.cache_read_input_tokens || 0,
    });
    // Count turns in the current epoch (since the last compaction) so we can
    // measure how many turns actually amortize a compaction — see _noteEpoch.
    this._turnsSinceCompaction.set(panelId, (this._turnsSinceCompaction.get(panelId) || 0) + 1);
  }

  /**
   * Measured estimate of how many turns will read the NEXT compacted prefix
   * before the following compaction (or session end) — the horizon that
   * amortizes a compaction. EWMA of completed epochs; falls back to the fixed
   * default until we've observed at least one epoch.
   */
  estimateRemainingTurns(): number {
    if (this._epochEwma != null && this._epochSamples >= 1) {
      return Math.max(1, Math.round(this._epochEwma));
    }
    return SMART_DEFAULT_REMAINING_TURNS;
  }

  /**
   * Fold a just-completed compaction epoch (turns since the last compaction on
   * this panel) into the global EWMA, then reset that panel's counter. Called
   * on a successful summarize.
   */
  private _noteEpoch(panelId: string): void {
    const turns = this._turnsSinceCompaction.get(panelId) || 0;
    this._turnsSinceCompaction.set(panelId, 0);
    if (turns <= 0) { return; }
    this._epochEwma = this._epochEwma == null
      ? turns
      : SmartCompactor._EPOCH_ALPHA * turns + (1 - SmartCompactor._EPOCH_ALPHA) * this._epochEwma;
    this._epochSamples += 1;
  }

  /**
   * Cache warmth for a panel. WARM iff the last turn was within the TTL AND it
   * actually read from cache (so caching is live). Otherwise COLD (covers both
   * an expired window and providers that never cache). UNKNOWN before any turn.
   */
  getWarmth(panelId: string): CacheWarmth {
    const st = this._cacheState.get(panelId);
    if (!st) { return 'unknown'; }
    const fresh = Date.now() - st.lastTurnAt < PROMPT_CACHE_TTL_MS;
    return fresh && st.lastCacheRead > 0 ? 'warm' : 'cold';
  }

  resetPanel(panelId: string): void {
    this._cacheState.delete(panelId);
    this._lastRetrievalAt.delete(panelId);
    this._turnsSinceCompaction.delete(panelId);
    void this._history?.clear(panelId);
  }

  // ── Full-history file + cherry-pick retrieval ─────────────────────────────────

  private _ensureRetrieval(): { history: HistoryStore; retrieval: RetrievalCoordinator } | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return null; }
    if (!this._history) { this._history = new HistoryStore(root); }
    if (!this._retrieval) { this._retrieval = new RetrievalCoordinator(this._gateway, this._history); }
    return { history: this._history, retrieval: this._retrieval };
  }

  /** Append a finalized turn to the on-disk full history (fire-and-forget). */
  recordHistory(panelId: string, record: HistoryAppend): void {
    const rr = this._ensureRetrieval();
    if (!rr) { return; }
    void rr.history.append(panelId, record);
  }

  /**
   * Cherry-pick relevant buried context for the current prompt. Returns a snippet
   * block to append to the user turn, or '' when retrieval shouldn't run (disabled,
   * no workspace, no prior compaction, on cooldown, or nothing relevant).
   */
  async retrieve(panelId: string, prompt: string, cheapModel: string, retrievalEnabled: boolean): Promise<string> {
    if (!retrievalEnabled) { return ''; }
    const rr = this._ensureRetrieval();
    if (!rr) { return ''; }
    // Only retrieve once a compaction has happened (memory exists) — before that
    // the full conversation is still in context and retrieval is pointless.
    const memory = await this._readMemory(panelId);
    if (!memory.trim()) { return ''; }
    const last = this._lastRetrievalAt.get(panelId) || 0;
    if (Date.now() - last < RETRIEVAL_COOLDOWN_MS) { return ''; }
    this._lastRetrievalAt.set(panelId, Date.now());
    const snippets = await rr.retrieval.retrieve({ panelId, prompt, cheapModel });
    return RetrievalCoordinator.formatSnippets(snippets);
  }

  // ── The decision (cache-aware + economic) ────────────────────────────────────

  evaluate(p: EvaluateParams): CompactionDecision {
    const warmth = this.getWarmth(p.panelId);
    const currentFill = (p.usage.input_tokens || 0) + (p.usage.cache_read_input_tokens || 0);
    const fillPercent = p.contextWindow > 0 ? (currentFill / p.contextWindow) * 100 : 0;

    const below = (reason: string): CompactionDecision =>
      ({ act: false, tier: 'none', reason, deferred: false, warmth });

    if (fillPercent < p.thresholdPercent) {
      return below(`fill ${fillPercent.toFixed(0)}% < ${p.thresholdPercent}%`);
    }

    const critical = fillPercent >= SMART_CRITICAL_FILL_PERCENT;

    // Economics (only when we know the main model's price).
    const rate = getModelRate(p.providerModel);
    const cheapRate = getModelRate(p.cheapModel, { viaGateway: true }) ?? getModelRate(p.cheapModel);
    let breakEvenTurns: number | undefined;
    let projectedSavingsUsd: number | undefined;
    let economical = false;
    let economicsKnown = false;
    const remainingTurns = this.estimateRemainingTurns();

    if (rate && cheapRate) {
      economicsKnown = true;
      const C = currentFill;
      const P = Math.max(p.minSummaryTokens, SMART_MIN_SUMMARY_TOKENS);
      const savingsPerTurn = cacheReadCostUsd(Math.max(0, C - P), rate);
      // The smart path reseeds a fresh (cold) session with [summary, ...preserved],
      // so re-priming the cache writes the summary AND the preserved tail — not
      // just the summary. Count both so the break-even isn't optimistic.
      const reprime = cacheWriteCostUsd(P + Math.max(0, p.preserveTokens || 0), rate, '5m');
      // Conservative incremental summarizer cost: read ~C on the cheap model, write ~P.
      const summarizeCost = tokensCostUsd(C, cheapRate.inputPerMTok) + tokensCostUsd(P, cheapRate.outputPerMTok);
      if (savingsPerTurn > 0) {
        breakEvenTurns = (summarizeCost + reprime) / savingsPerTurn;
        economical = remainingTurns >= breakEvenTurns;
        projectedSavingsUsd = Math.max(0, remainingTurns * savingsPerTurn - summarizeCost - reprime);
      } else {
        // Summary wouldn't shrink the prefix meaningfully — not worth it.
        economical = false;
      }
    }

    if (critical) {
      return { act: true, tier: 'compact', reason: `critical fill ${fillPercent.toFixed(0)}%`, deferred: false, warmth, breakEvenTurns, remainingTurns, projectedSavingsUsd };
    }

    if (warmth === 'warm') {
      // Only override a warm cache when we KNOW compaction wins. When economics
      // are unknown we bias toward protecting the warm cache (caching is cheap).
      if (economicsKnown && economical) {
        return { act: true, tier: 'compact', reason: 'cache warm but compaction clearly wins', deferred: false, warmth, breakEvenTurns, remainingTurns, projectedSavingsUsd };
      }
      // Defer to a cold window; record the (estimated) savings from keeping the cache warm.
      this._recordCacheTimingSaving(p, rate);
      const reason = economicsKnown ? 'cache warm — deferring compaction' : 'cache warm — deferring (economics unknown)';
      return { act: false, tier: 'none', reason, deferred: true, warmth, breakEvenTurns, remainingTurns, projectedSavingsUsd };
    }

    // Cold / unknown warmth: skip only when we know the economics don't clear.
    if (economicsKnown && !economical) {
      return { act: false, tier: 'none', reason: `savings below break-even (N*=${breakEvenTurns?.toFixed(1)})`, deferred: false, warmth, breakEvenTurns, remainingTurns, projectedSavingsUsd };
    }
    const reason = !economicsKnown
      ? 'threshold crossed (economics unknown)'
      : (warmth === 'cold' ? 'cache cold — ideal moment' : 'threshold crossed');
    return { act: true, tier: 'compact', reason, deferred: false, warmth, breakEvenTurns, remainingTurns, projectedSavingsUsd };
  }

  private _recordCacheTimingSaving(p: EvaluateParams, rate: ReturnType<typeof getModelRate>): void {
    if (!rate) { return; }
    const cacheRead = p.usage.cache_read_input_tokens || 0;
    if (cacheRead <= 0) { return; }
    // Had we compacted now, we'd have destroyed this turn's warm cache and paid
    // full price next turn instead of the 0.1x read — the delta is the saving.
    const fullCost = tokensCostUsd(cacheRead, rate.inputPerMTok);
    const readCost = cacheReadCostUsd(cacheRead, rate);
    const saved = Math.max(0, fullCost - readCost);
    this._ledger.record({ kind: 'cache-timing', tokensSaved: cacheRead, usdSaved: saved, estimated: true });
  }

  // ── Incremental summarization (cheap model via the gateway) ───────────────────

  /**
   * Produce/refresh the structured memory and replace the older messages with it.
   * Folds the EXISTING memory (carried as the prior summary) + new turns through
   * a cheap model — incremental, not a full re-summarize. Mutates
   * `conversation.messages`. Returns null on any gateway failure so the caller
   * can fall back to the existing client-summarize path.
   */
  async summarize(p: SummarizeParams): Promise<CompactionResult | null> {
    const messages = p.conversation.messages;
    if (messages.length <= COMPACTION_MESSAGES_TO_PRESERVE) { return null; }

    const start = Date.now();
    const boundary = SmartCompactor._preserveBoundary(messages);
    const toSummarize = messages.slice(0, boundary);
    const toPreserve = messages.slice(boundary);

    const existingMemory = await this._readMemory(p.panelId);
    // First compaction (no prior memory) does a full build; later compactions ask
    // for section PATCHES against the existing memory (cheaper output + no drift on
    // unchanged sections). Either way we degrade gracefully below.
    const bootstrap = !existingMemory.trim();
    const prompt = bootstrap
      ? this._buildMemoryPrompt(existingMemory, toSummarize, p.minSummaryTokens)
      : this._buildPatchPrompt(existingMemory, toSummarize, p.minSummaryTokens);

    const result = await this._gateway.chatCompletion({
      model: p.cheapModel,
      maxTokens: Math.max(1024, Math.ceil(p.minSummaryTokens * 1.2)),
      messages: [
        { role: 'system', content: 'You maintain a compact, structured working memory for a coding assistant. Be faithful and concise.' },
        { role: 'user', content: prompt },
      ],
      signal: p.signal,
    });

    if (result.failed || !result.text.trim()) {
      console.warn(`[Mysti] SmartCompactor: gateway summarize failed (${result.error ?? 'empty'}) — falling back`);
      this._turnsSinceCompaction.set(p.panelId, 0); // the caller will client-summarize — close the epoch
      return null;
    }

    // Delta-patch path: apply the model's section patches onto the prior memory
    // (unchanged sections carried over byte-for-byte). If the response isn't a
    // usable patch array, treat it as a full-memory rewrite — never corrupt memory.
    let updatedMemory: string;
    let patched = false;
    if (bootstrap) {
      // Canonicalize the first memory through parse/serialize so it's already in
      // the structured form the patch path expects — no silent byte-divergence on
      // the first patch epoch. Fall back to raw text only if it has no sections.
      const { order, bodies } = parseMemorySections(result.text);
      updatedMemory = order.length ? serializeMemory(order, bodies) : result.text.trim();
    } else {
      const applied = tryApplyMemoryPatches(existingMemory, result.text);
      if (applied) { updatedMemory = applied; patched = true; }
      else { updatedMemory = result.text.trim(); } // model returned a full rewrite, not patches
    }
    // Quality/validity floor. For UNVALIDATED text (a bootstrap build or a
    // full-rewrite fallback) require recognizable memory structure — a raw or
    // malformed blob (e.g. invalid patch JSON that failed extraction) has zero
    // known sections and must NEVER overwrite good accumulated memory, regardless
    // of length. A successfully-applied patch is structured by construction, so
    // it only needs the degenerate-size check.
    const degenerate = estimateTokens(updatedMemory) < 150;
    if (!patched) {
      const { order } = parseMemorySections(updatedMemory);
      const hasKnownSection = order.some(s => (MEMORY_SECTION_ORDER as readonly string[]).includes(s));
      if (!hasKnownSection || degenerate) {
        console.warn('[Mysti] SmartCompactor: summary not structured or degenerate — falling back');
        this._turnsSinceCompaction.set(p.panelId, 0);
        return null;
      }
    } else if (degenerate) {
      console.warn('[Mysti] SmartCompactor: patched memory degenerate — falling back');
      this._turnsSinceCompaction.set(p.panelId, 0);
      return null;
    }
    if (patched) {
      console.log('[Mysti] SmartCompactor: applied delta-patch memory update');
    }
    await this._writeMemory(p.panelId, updatedMemory);
    // This compaction closes the current epoch — feed its turn count to the
    // measured-N EWMA used by the next economic decision.
    this._noteEpoch(p.panelId);

    const summaryMessage: Message = {
      id: `compaction-summary-${Date.now()}`,
      role: 'system',
      content: `[Conversation Summary]\n${updatedMemory}`,
      timestamp: Date.now(),
    };
    p.conversation.messages = [summaryMessage, ...toPreserve];

    // Record realized cheap-model savings: what the same summarization would have
    // cost on the active model vs. what the gateway actually billed. The input
    // estimate is the ACTUAL prompt size (memory + scaffold + slice), not the
    // slice alone, so the counterfactual baseline matches what the model read.
    const beforeTokens = toSummarize.reduce((s, m) => s + estimateTokens(m.content), 0);
    const afterTokens = estimateTokens(updatedMemory);
    // Output-token estimate is the ACTUAL generation (patch array on the delta
    // path, full memory on bootstrap) — used only when the gateway doesn't return
    // real counts. `afterTokens` (final memory size) is reported for display below.
    this._recordCheapModelSaving(p.providerModel, p.cheapModel, estimateTokens(prompt), estimateTokens(result.text), result.costUsd, result.inputTokens, result.outputTokens);

    return {
      success: true,
      beforeTokens,
      afterTokens,
      strategy: 'client-summarize',
      duration: Date.now() - start,
      summary: updatedMemory,
    };
  }

  private _recordCheapModelSaving(
    providerModel: string,
    cheapModel: string,
    inputTokens: number,
    outputTokens: number,
    gatewayCostUsd: number | undefined,
    gatewayInputTokens: number | undefined,
    gatewayOutputTokens: number | undefined,
  ): void {
    const mainRate = getModelRate(providerModel);
    const cheapRate = getModelRate(cheapModel, { viaGateway: true }) ?? getModelRate(cheapModel);
    if (!mainRate || !cheapRate) { return; }
    const inTok = gatewayInputTokens ?? inputTokens;
    const outTok = gatewayOutputTokens ?? outputTokens;
    const baseline = tokensCostUsd(inTok, mainRate.inputPerMTok) + tokensCostUsd(outTok, mainRate.outputPerMTok);
    const actual = gatewayCostUsd ?? (tokensCostUsd(inTok, cheapRate.inputPerMTok) + tokensCostUsd(outTok, cheapRate.outputPerMTok));
    const saved = Math.max(0, baseline - actual);
    // Flagged estimated unless BOTH the real billed cost and real token counts
    // came back from the gateway — token estimates can be missing independently.
    const haveGatewayTokens = gatewayInputTokens !== undefined && gatewayOutputTokens !== undefined;
    const estimated = gatewayCostUsd === undefined || !haveGatewayTokens;
    this._ledger.record({ kind: 'cheap-model', tokensSaved: inTok, usdSaved: saved, estimated });
  }

  // ── Savings snapshot ─────────────────────────────────────────────────────────

  snapshot(): SavingsSnapshot {
    const ent = this._auth.getEntitlement();
    return this._ledger.snapshot(ent?.freeRemaining, ent?.freeLimit);
  }

  // ── Structured memory file ────────────────────────────────────────────────────

  private _memoryFile(panelId: string): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return null; }
    const safe = safePanelSegment(panelId);
    return path.join(root, '.mysti', 'compaction', safe, 'memory.md');
  }

  private async _readMemory(panelId: string): Promise<string> {
    const file = this._memoryFile(panelId);
    if (!file) { return ''; }
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return '';
    }
  }

  private async _writeMemory(panelId: string, content: string): Promise<void> {
    const file = this._memoryFile(panelId);
    if (!file) { return; }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
    } catch (err) {
      console.warn(`[Mysti] SmartCompactor: failed to write memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Index of the first message to PRESERVE verbatim (everything before it is
   * summarized). Starts at `len - COMPACTION_MESSAGES_TO_PRESERVE` and snaps
   * EARLIER to the nearest user turn (within a bounded window) so a compaction
   * never splits a logical exchange — we never preserve a dangling assistant
   * reply (or its tool results) without the user turn that prompted it. Falls
   * back to the default index when no user boundary is nearby. Always ≥ 1, so
   * at least one message is summarized.
   */
  static _preserveBoundary(messages: Message[]): number {
    const def = Math.max(1, messages.length - COMPACTION_MESSAGES_TO_PRESERVE);
    const floor = Math.max(1, def - COMPACTION_MESSAGES_TO_PRESERVE);
    for (let i = def; i >= floor; i--) {
      if (messages[i]?.role === 'user') { return i; }
    }
    return def;
  }

  private _buildMemoryPrompt(existingMemory: string, newMessages: Message[], minSummaryTokens: number): string {
    const convo = newMessages.map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
      const content = m.content.length > 4000 ? m.content.slice(0, 4000) + '…' : m.content;
      return `${role}: ${content}`;
    }).join('\n\n');

    const wordBudget = Math.max(300, Math.round(minSummaryTokens * 0.7));

    return [
      'Maintain a compact STRUCTURED WORKING MEMORY for an ongoing coding session.',
      'Update the existing memory below by folding in the NEW turns. Preserve everything still relevant; drop only what is now obsolete.',
      '',
      'Use exactly these Markdown sections (omit a section only if truly empty):',
      '## Goal — the durable objective (1-3 lines).',
      '## Decisions — architectural/library/API choices made, with brief rationale.',
      '## Files — path → one-line role, for the working set.',
      '## Code — small load-bearing signatures/snippets worth keeping.',
      '## Open Threads — unresolved tasks/questions; check off and remove completed ones.',
      '',
      `Keep it under about ${wordBudget} words. Output ONLY the updated memory in that structure — no preamble or commentary.`,
      '',
      '=== EXISTING MEMORY (may be empty) ===',
      existingMemory || '(empty)',
      '=== NEW CONVERSATION TURNS ===',
      convo,
      '=== END ===',
    ].join('\n');
  }

  /**
   * Prompt for the INCREMENTAL (delta-patch) path: given the current memory and
   * the new turns, return only the minimal section patches. Applied
   * deterministically by applyMemoryPatches so unchanged sections stay
   * byte-identical (no re-summarization drift). Falls back to full-rewrite
   * semantics if the model ignores the format (see summarize()).
   */
  private _buildPatchPrompt(existingMemory: string, newMessages: Message[], minSummaryTokens: number): string {
    const convo = newMessages.map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
      const content = m.content.length > 4000 ? m.content.slice(0, 4000) + '…' : m.content;
      return `${role}: ${content}`;
    }).join('\n\n');

    return [
      'You maintain a compact STRUCTURED WORKING MEMORY for an ongoing coding session.',
      'Below is the CURRENT memory and the NEW turns since it was last updated.',
      'Return ONLY the minimal set of section PATCHES needed to fold in the new turns.',
      'Do NOT restate unchanged sections — emit a patch ONLY for a section that actually changes.',
      '',
      'Output a single JSON array (no prose, no code fences). Each element:',
      '  {"section": <Goal | Decisions | Files | Code | Open Threads>, "op": <"append" | "replace" | "remove">, "content": <markdown string>}',
      '  • append  — add content to the END of that section (new decisions, files, or open threads).',
      '  • replace — replace that section body entirely (e.g. rewrite Open Threads to check off completed items).',
      '  • remove  — drop that section (omit content).',
      'Keep content faithful and concise. If nothing changed, return [].',
      '',
      '=== CURRENT MEMORY ===',
      existingMemory,
      '=== NEW CONVERSATION TURNS ===',
      convo,
      '=== END — output the JSON patch array now ===',
    ].join('\n');
  }
}
