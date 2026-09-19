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
 */

import * as vscode from 'vscode';
import type {
  CumulativeUsage,
  CompactionResult,
  CompactionStrategy,
  CompactionDecision,
  SavingsSnapshot,
  UsageStats,
  ProviderType,
  Conversation,
  Message,
  StreamChunk,
  Settings,
} from '../types';
import {
  COMPACTION_DEFAULT_THRESHOLD_PERCENT,
  COMPACTION_COOLDOWN_MS,
  COMPACTION_MIN_MESSAGES_BEFORE_COMPACT,
  COMPACTION_MESSAGES_TO_PRESERVE,
  SMART_DEFAULT_CHEAP_MODEL,
  SMART_MIN_SUMMARY_TOKENS,
} from '../constants';
import { estimateTokens } from '../services/ModelPricing';
import { contextFillTokens, hasUsageSignal } from '../services/TokenAccounting';
import type { UsageConvention } from '../services/TokenAccounting';
import type { ProviderManager } from './ProviderManager';
import type { ConversationManager } from './ConversationManager';
import type { SmartCompactor, HistoryAppend } from './SmartCompactor';
import { captureCompactionInput } from './CompactionInput';

/**
 * Boost overlay seam (Plan 24). Structural on purpose — BoostManager satisfies
 * it without CompactionManager importing it. Each accessor returns undefined
 * to mean "no overlay; use the stock settings read".
 */
export interface BoostCompactionOverlay {
  compactionThreshold(): number | undefined;
  smartCompactionEnabled(): boolean | undefined;
}

/**
 * CompactionManager - Unified context compaction across all providers
 *
 * Monitors per-panel token usage and triggers compaction when the context
 * window fill level exceeds a configurable threshold (default 75%).
 *
 * Two strategies:
 * - native-cli: Sends /compact to providers that support it (e.g. Claude Code)
 * - client-summarize: Summarizes older messages and replaces them with a condensed summary
 */
export class CompactionManager {
  private _extensionContext: vscode.ExtensionContext;

  // Per-panel cumulative usage tracking
  // Key: panelId (or panelId-brainstorm-agentId for brainstorm agents)
  private _panelUsage: Map<string, CumulativeUsage> = new Map();

  // The LAST normalized usage record per panel. Kept separately from the
  // cumulative totals because they answer different questions: the totals are a
  // session-lifetime spend, this is the current context fill.
  private _panelLastFill: Map<string, UsageStats> = new Map();

  // Cooldown tracking to prevent rapid re-compaction
  private _lastCompactionTime: Map<string, number> = new Map();

  // Configurable threshold
  private _thresholdPercent: number;

  // Whether compaction is enabled
  private _enabled: boolean;

  // Whether smart compaction (DeepMyst-gated premium) is enabled via settings.
  // This reflects the user toggle only; full activation additionally requires a
  // signed-in DeepMyst account + entitlement (resolved by the SmartCompactor).
  private _smartEnabled: boolean;

  // Smart-compaction tunables (loaded from settings).
  private _cheapModel: string;
  private _minSummaryTokens: number;
  private _retrievalEnabled: boolean;

  // The smart engine, injected post-construction (null until wired in extension.ts).
  private _smart: SmartCompactor | null = null;

  /** Boost overlay (Plan 24); undefined until wired via setBoostOverlay. */
  private _boostOverlay: BoostCompactionOverlay | undefined;

  private _configDisposable: vscode.Disposable;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._thresholdPercent = this._loadThreshold();
    this._enabled = this._loadEnabled();
    this._smartEnabled = this._loadSmartEnabled();
    this._cheapModel = this._loadCheapModel();
    this._minSummaryTokens = this._loadMinSummaryTokens();
    this._retrievalEnabled = this._loadRetrievalEnabled();

    // Listen for configuration changes. `mysti.boost` is included because the
    // Boost overlay (Plan 24) feeds _loadThreshold/_loadSmartEnabled — toggling
    // Boost must re-run the loaders exactly like a compaction settings change.
    this._configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mysti.compaction') || e.affectsConfiguration('mysti.boost')) {
        this._thresholdPercent = this._loadThreshold();
        this._enabled = this._loadEnabled();
        this._smartEnabled = this._loadSmartEnabled();
        this._cheapModel = this._loadCheapModel();
        this._minSummaryTokens = this._loadMinSummaryTokens();
        this._retrievalEnabled = this._loadRetrievalEnabled();
        console.log(`[Mysti] CompactionManager: Config updated - enabled=${this._enabled}, smart=${this._smartEnabled}, threshold=${this._thresholdPercent}%`);
      }
    });
  }

  /**
   * Record usage from a completed response and return whether threshold is exceeded.
   */
  public recordUsage(panelId: string, usage: UsageStats, contextWindow: number): boolean {
    const existing = this._panelUsage.get(panelId) || this._createEmptyUsage();

    existing.totalInputTokens += usage.input_tokens || 0;
    existing.totalOutputTokens += usage.output_tokens || 0;
    existing.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
    existing.totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
    existing.messageCount += 1;
    existing.lastUpdated = Date.now();

    this._panelUsage.set(panelId, existing);
    this._panelLastFill.set(panelId, usage);

    // Context fill for the most recent turn. `usage` must ALREADY be normalized
    // (ChatViewProvider normalizes at the stream boundary) — the fill is the sum
    // of all three disjoint prompt buckets, cache-creation included. Omitting
    // cache-creation, as this did, reported a cold 400k-token turn as the couple
    // of thousand uncached tokens and the threshold never tripped.
    const currentFill = contextFillTokens(usage);
    const percentage = (currentFill / contextWindow) * 100;

    console.log(`[Mysti] CompactionManager: Panel ${panelId} - ${currentFill}/${contextWindow} tokens (${percentage.toFixed(1)}%, threshold: ${this._thresholdPercent}%)`);

    return percentage >= this._thresholdPercent;
  }

  /**
   * Check if compaction should be triggered.
   * Considers: enabled, threshold, cooldown, minimum message count.
   */
  public shouldCompact(panelId: string, usage: UsageStats, contextWindow: number, messageCount: number): boolean {
    if (!this._enabled) {
      return false;
    }

    // Check minimum message count
    if (messageCount < COMPACTION_MIN_MESSAGES_BEFORE_COMPACT) {
      return false;
    }

    // Check cooldown
    const lastCompaction = this._lastCompactionTime.get(panelId) || 0;
    if (Date.now() - lastCompaction < COMPACTION_COOLDOWN_MS) {
      console.log(`[Mysti] CompactionManager: Skipping compaction for ${panelId} - cooldown active`);
      return false;
    }

    // No measurement at all (a backend that omits usage, or defaults every field
    // to 0) is UNKNOWN, not 0% — thresholding on it silently disables compaction
    // for the whole session while looking like a healthy "plenty of room" answer.
    if (!hasUsageSignal(usage)) {
      return false;
    }

    const percentage = (contextFillTokens(usage) / contextWindow) * 100;

    return percentage >= this._thresholdPercent;
  }

  /**
   * Determine the compaction strategy for a provider.
   * Checks the provider's capabilities for native compact support.
   */
  public getStrategy(providerId: ProviderType, providerManager: ProviderManager): CompactionStrategy {
    const provider = providerManager.getProviderInstance(providerId);
    if (provider?.capabilities && 'supportsNativeCompact' in provider.capabilities) {
      const caps = provider.capabilities as { supportsNativeCompact?: boolean };
      if (caps.supportsNativeCompact) {
        return 'native-cli';
      }
    }
    return 'client-summarize';
  }

  /**
   * Execute native CLI compaction by sending /compact to the provider.
   * Returns an AsyncGenerator of StreamChunks from the compact response.
   */
  public async *executeNativeCompaction(
    providerManager: ProviderManager,
    settings: Settings,
    conversation: Conversation | null,
    panelId: string,
  ): AsyncGenerator<StreamChunk> {
    console.log(`[Mysti] CompactionManager: Executing native /compact for panel ${panelId}`);
    this._lastCompactionTime.set(panelId, Date.now());

    const stream = providerManager.sendMessage(
      '/compact',
      [],
      settings,
      conversation,
      undefined,
      panelId,
    );

    yield* stream;
  }

  /**
   * Execute client-side summarization for providers without native /compact.
   * Summarizes older messages and replaces them with a condensed summary.
   */
  public async executeClientSummarization(
    providerManager: ProviderManager,
    conversationManager: ConversationManager,
    settings: Settings,
    conversation: Conversation,
    panelId: string,
    isCurrent: () => boolean = () => true,
  ): Promise<CompactionResult> {
    const startTime = Date.now();
    const refused = (): CompactionResult => ({ success: false, beforeTokens: 0, afterTokens: 0,
      strategy: 'client-summarize', duration: Date.now() - startTime,
      error: 'Compaction cancelled because the request or conversation changed.' });
    if (!isCurrent()) { return refused(); }
    const input = captureCompactionInput(conversation, isCurrent);
    console.log(`[Mysti] CompactionManager: Executing client-side summarization for panel ${panelId}`);
    // Authorized attempts, including failed/in-flight summaries, retain the
    // cooldown so a high-fill conversation cannot repeatedly spend on retries.
    this._lastCompactionTime.set(panelId, Date.now());

    const messages = input.messages;
    if (messages.length <= COMPACTION_MESSAGES_TO_PRESERVE) {
      return {
        success: false,
        beforeTokens: 0,
        afterTokens: 0,
        strategy: 'client-summarize',
        duration: 0,
        error: 'Not enough messages to compact',
      };
    }

    // Split messages: older ones to summarize, recent ones to preserve
    const toSummarize = messages.slice(0, -COMPACTION_MESSAGES_TO_PRESERVE);
    const toPreserve = messages.slice(-COMPACTION_MESSAGES_TO_PRESERVE);

    // Build summarization prompt
    const summaryPrompt = this._buildSummarizationPrompt(toSummarize);

    // Send summarization request to the active provider
    let summaryContent = '';
    let completed = false;
    try {
      const stream = providerManager.sendMessage(
        summaryPrompt,
        [],
        settings,
        null, // No conversation context for the summarization itself
        undefined,
        `${panelId}-compaction`,
      );

      for await (const chunk of stream) {
        if (!isCurrent()) { return refused(); }
        if (chunk.type === 'error' || chunk.type === 'auth_error') {
          return { ...refused(), error: chunk.content?.trim() || 'The provider could not complete the compaction summary.' };
        }
        if (chunk.type === 'done') { completed = true; break; }
        if (chunk.type === 'text' && chunk.content) {
          summaryContent += chunk.content;
        }
      }
    } catch (error) {
      return {
        success: false,
        beforeTokens: messages.length,
        afterTokens: messages.length,
        strategy: 'client-summarize',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    // Successful provider contracts terminate with done. EOF alone can be an
    // interrupted request, so partial text must never replace durable history.
    if (!completed) { return { ...refused(), error: 'The provider ended before completing the compaction summary.' }; }
    if (!summaryContent.trim()) {
      return {
        success: false,
        beforeTokens: messages.length,
        afterTokens: messages.length,
        strategy: 'client-summarize',
        duration: Date.now() - startTime,
        error: 'Empty summary generated',
      };
    }

    // Estimate before/after token counts (rough: 4 chars per token)
    const beforeTokens = toSummarize.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    const afterTokens = Math.ceil(summaryContent.length / 4);

    // Replace older messages with a summary message
    const summaryMessage: Message = {
      id: `compaction-summary-${Date.now()}`,
      role: 'system',
      content: `[Conversation Summary]\n${summaryContent}`,
      timestamp: Date.now(),
    };

    // No await between admission and replacement. Concurrent compactions share
    // the captured source array; once one commits, every other one is stale.
    if (!input.canCommit()) { return refused(); }
    conversation.messages = [summaryMessage, ...toPreserve];

    return {
      success: true,
      beforeTokens,
      afterTokens,
      strategy: 'client-summarize',
      duration: Date.now() - startTime,
      summary: summaryContent,
    };
  }

  /**
   * Get cumulative usage for a panel.
   *
   * These are LIFETIME sums across the session. They answer "what has this panel
   * spent", never "how full is the context" — use `getLastFill` for that.
   */
  public getUsage(panelId: string): CumulativeUsage | null {
    return this._panelUsage.get(panelId) || null;
  }

  /**
   * The most recent measured turn for a panel, in normalized form — the only
   * record that is comparable to the model's context window. Null before the
   * panel has completed a measurable turn.
   */
  public getLastFill(panelId: string): UsageStats | null {
    return this._panelLastFill.get(panelId) || null;
  }

  /**
   * Reset usage tracking for a panel (on new conversation). Also sweeps the
   * panel's brainstorm-child keys (`${panelId}-brainstorm-<agent>`): those are
   * written per agent during brainstorm but were never reset, so they
   * accumulated across conversations (S7).
   */
  public resetUsage(panelId: string): void {
    this._panelUsage.delete(panelId);
    this._panelLastFill.delete(panelId);
    this._lastCompactionTime.delete(panelId);
    this._smart?.resetPanel(panelId);
    const childPrefix = `${panelId}-brainstorm-`;
    for (const key of Array.from(this._panelUsage.keys())) {
      if (key.startsWith(childPrefix)) {
        this._panelUsage.delete(key);
        this._panelLastFill.delete(key);
        this._lastCompactionTime.delete(key);
      }
    }
  }

  /**
   * Update usage tracking after compaction to reflect the new token state.
   */
  public updateUsageAfterCompaction(panelId: string, afterTokens: number): void {
    const existing = this._panelUsage.get(panelId) || this._createEmptyUsage();
    existing.totalInputTokens = afterTokens;
    existing.totalCacheReadTokens = 0;
    existing.lastUpdated = Date.now();
    this._panelUsage.set(panelId, existing);
    // The fill is now the compacted prefix, all of it uncached: compaction
    // invalidates the prompt cache by construction. Leaving the pre-compaction
    // record in place would make the very next threshold check re-fire off a
    // reading that compaction just made obsolete.
    this._panelLastFill.set(panelId, { input_tokens: afterTokens, output_tokens: 0 });
    console.log(`[Mysti] CompactionManager: Updated usage for ${panelId} to ${afterTokens} tokens post-compaction`);
  }

  /**
   * Get the current threshold percentage.
   */
  public getThreshold(): number {
    return this._thresholdPercent;
  }

  /**
   * Check if compaction is enabled.
   */
  public isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Whether the user has opted into smart compaction via settings
   * (`mysti.compaction.smart.enabled`). This reflects the toggle only — smart
   * compaction additionally requires a signed-in DeepMyst account + entitlement
   * before it actually activates (Plan 08 Phase 2, wired in a later slice).
   */
  public isSmartEnabled(): boolean {
    return this._smartEnabled;
  }

  /** Inject the smart-compaction engine (Plan 08). Wired in extension.ts. */
  public setSmartCompactor(smart: SmartCompactor): void {
    this._smart = smart;
  }

  /**
   * Inject the Boost overlay (Plan 24). Wired in extension.ts. Re-runs the two
   * overlay-aware loaders immediately so an already-constructed manager picks
   * the boosted values up without waiting for a settings change.
   */
  public setBoostOverlay(overlay: BoostCompactionOverlay): void {
    this._boostOverlay = overlay;
    this._thresholdPercent = this._loadThreshold();
    this._smartEnabled = this._loadSmartEnabled();
  }

  /** Whether smart compaction is currently active (toggle + signed in + entitled). */
  public isSmartActive(): boolean {
    return !!this._smart && this._smart.isActive(this._smartEnabled);
  }

  /**
   * Decide whether to compact after a completed response. When smart compaction
   * is active this uses the cache-aware + economic engine (and records cache
   * warmth / cache-timing savings); otherwise it falls back to the standard
   * percentage-threshold trigger. `recordUsage` is still the caller's job on the
   * non-act path (it accumulates the per-panel token totals).
   */
  public evaluateCompaction(
    panelId: string,
    usage: UsageStats,
    contextWindow: number,
    messageCount: number,
    settings: Settings,
    conversation?: Conversation | null,
    /**
     * The backend's token-accounting convention, so the smart engine can tell
     * "cache cold" from "this backend cannot report cache". Defaults to 'none'
     * (the honest answer for a caller that doesn't know) rather than 'anthropic',
     * which would claim a cache signal that was never observed.
     */
    usageConvention: UsageConvention = 'none',
  ): { act: boolean; smart: boolean; decision?: CompactionDecision } {
    if (this.isSmartActive() && this._smart) {
      this._smart.recordTurn(panelId, usage, usageConvention);
      // Same UNKNOWN-vs-zero rule as shouldCompact: an unmeasured turn must not
      // reach the economic engine, which would read it as 0% fill.
      if (!hasUsageSignal(usage)) {
        return { act: false, smart: true };
      }
      if (!this._enabled || messageCount < COMPACTION_MIN_MESSAGES_BEFORE_COMPACT) {
        return { act: false, smart: true };
      }
      const lastCompaction = this._lastCompactionTime.get(panelId) || 0;
      if (Date.now() - lastCompaction < COMPACTION_COOLDOWN_MS) {
        return { act: false, smart: true };
      }
      const decision = this._smart.evaluate({
        panelId,
        usage,
        contextWindow,
        messageCount,
        providerModel: settings.model,
        cheapModel: this._cheapModel,
        thresholdPercent: this._thresholdPercent,
        minSummaryTokens: this._minSummaryTokens,
        preserveTokens: conversation ? this._estimatePreserveTokens(conversation) : undefined,
      });
      console.log(`[Mysti] CompactionManager: smart decision for ${panelId} — act=${decision.act}, ${decision.reason}`);
      return { act: decision.act, smart: true, decision };
    }
    return { act: this.shouldCompact(panelId, usage, contextWindow, messageCount), smart: false };
  }

  /**
   * Smart incremental summarization through the cheap gateway model. Returns null
   * when smart compaction isn't active or the gateway is unavailable, so the
   * caller falls back to executeClientSummarization.
   */
  public async executeSmartSummarization(
    settings: Settings,
    conversation: Conversation,
    panelId: string,
    isCurrent: () => boolean = () => true,
  ): Promise<CompactionResult | null> {
    if (!this.isSmartActive() || !this._smart) { return null; }
    if (isCurrent()) { this._lastCompactionTime.set(panelId, Date.now()); }
    return this._smart.summarize({
      panelId,
      conversation,
      providerModel: settings.model,
      cheapModel: this._cheapModel,
      minSummaryTokens: this._minSummaryTokens,
      isCurrent,
    });
  }

  /** Current savings snapshot for the always-on UI (null when smart isn't wired). */
  public getSavingsSnapshot(): SavingsSnapshot | null {
    return this._smart ? this._smart.snapshot() : null;
  }

  /** Append a finalized turn to the on-disk full history (smart compaction only). */
  public appendHistory(panelId: string, record: HistoryAppend): void {
    if (this.isSmartActive() && this._smart) {
      this._smart.recordHistory(panelId, record);
    }
  }

  /**
   * Cherry-pick relevant buried context for the prompt, as a block to append to
   * the user turn. Returns '' when smart compaction isn't active or retrieval
   * shouldn't run. Never throws.
   */
  public async retrieveContext(panelId: string, prompt: string): Promise<string> {
    if (!this.isSmartActive() || !this._smart) { return ''; }
    try {
      return await this._smart.retrieve(panelId, prompt, this._cheapModel, this._retrievalEnabled);
    } catch {
      return '';
    }
  }

  public dispose(): void {
    this._panelUsage.clear();
    this._lastCompactionTime.clear();
    this._configDisposable.dispose();
  }

  // --- Private helpers ---

  /**
   * Estimate the tokens in the tail we keep verbatim past a compaction (the last
   * COMPACTION_MESSAGES_TO_PRESERVE messages). Used to charge the smart path's
   * cold reseed for re-priming the preserved tail, not just the summary.
   */
  private _estimatePreserveTokens(conversation: Conversation): number {
    const tail = conversation.messages.slice(-COMPACTION_MESSAGES_TO_PRESERVE);
    return tail.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
  }

  private _loadThreshold(): number {
    // Boost overlay (Plan 24): an effective threshold computed by BoostManager.
    // The overlay returns undefined when Boost is off OR the user explicitly
    // set mysti.compaction.threshold — explicit user values always win there,
    // so this read stays a plain pass-through in the stock configuration.
    const boosted = this._boostOverlay?.compactionThreshold();
    if (boosted !== undefined) { return boosted; }
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<number>('compaction.threshold', COMPACTION_DEFAULT_THRESHOLD_PERCENT);
  }

  private _loadEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<boolean>('compaction.enabled', true);
  }

  private _loadSmartEnabled(): boolean {
    // Boost overlay (Plan 24): forces smart compaction ON under Boost unless
    // the user explicitly set the key. Safe to force: SmartCompactor.isActive
    // still requires sign-in + entitlement and fail-opens to the native path.
    const boosted = this._boostOverlay?.smartCompactionEnabled();
    if (boosted !== undefined) { return boosted; }
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<boolean>('compaction.smart.enabled', false);
  }

  private _loadCheapModel(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('compaction.smart.cheapModel', SMART_DEFAULT_CHEAP_MODEL) || SMART_DEFAULT_CHEAP_MODEL;
  }

  private _loadMinSummaryTokens(): number {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<number>('compaction.smart.minSummaryTokens', SMART_MIN_SUMMARY_TOKENS);
  }

  private _loadRetrievalEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<boolean>('compaction.smart.retrieval.enabled', true);
  }

  private _createEmptyUsage(): CumulativeUsage {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
      lastUpdated: Date.now(),
    };
  }

  private _buildSummarizationPrompt(messages: Message[]): string {
    const conversationText = messages.map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
      // Truncate very long messages to keep prompt manageable
      const content = m.content.length > 1000 ? m.content.substring(0, 1000) + '...' : m.content;
      return `${role}: ${content}`;
    }).join('\n\n');

    return [
      'You are a conversation summarizer. Create a concise summary of the following conversation.',
      'Preserve key decisions, code changes, file paths, and important context.',
      'Keep the summary under 500 words. Do not add any preamble or meta-commentary.',
      '',
      '--- Conversation to summarize ---',
      conversationText,
      '--- End of conversation ---',
      '',
      'Summary:',
    ].join('\n');
  }
}
