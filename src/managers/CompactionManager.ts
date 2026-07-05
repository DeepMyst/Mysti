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
import type { ProviderManager } from './ProviderManager';
import type { ConversationManager } from './ConversationManager';
import type { SmartCompactor, HistoryAppend } from './SmartCompactor';

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

  private _configDisposable: vscode.Disposable;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._thresholdPercent = this._loadThreshold();
    this._enabled = this._loadEnabled();
    this._smartEnabled = this._loadSmartEnabled();
    this._cheapModel = this._loadCheapModel();
    this._minSummaryTokens = this._loadMinSummaryTokens();
    this._retrievalEnabled = this._loadRetrievalEnabled();

    // Listen for configuration changes
    this._configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mysti.compaction')) {
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

    // The most recent input_tokens represents the current context window fill level
    const currentFill = usage.input_tokens + (usage.cache_read_input_tokens || 0);
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

    // Check threshold using most recent input_tokens as context fill level
    const currentFill = usage.input_tokens + (usage.cache_read_input_tokens || 0);
    const percentage = (currentFill / contextWindow) * 100;

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
  ): Promise<CompactionResult> {
    const startTime = Date.now();
    console.log(`[Mysti] CompactionManager: Executing client-side summarization for panel ${panelId}`);
    this._lastCompactionTime.set(panelId, Date.now());

    const messages = conversation.messages;
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

    // Update conversation: replace messages array
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
   */
  public getUsage(panelId: string): CumulativeUsage | null {
    return this._panelUsage.get(panelId) || null;
  }

  /**
   * Reset usage tracking for a panel (on new conversation).
   */
  public resetUsage(panelId: string): void {
    this._panelUsage.delete(panelId);
    this._lastCompactionTime.delete(panelId);
    this._smart?.resetPanel(panelId);
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
  ): { act: boolean; smart: boolean; decision?: CompactionDecision } {
    if (this.isSmartActive() && this._smart) {
      this._smart.recordTurn(panelId, usage);
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
  ): Promise<CompactionResult | null> {
    if (!this.isSmartActive() || !this._smart) { return null; }
    this._lastCompactionTime.set(panelId, Date.now());
    return this._smart.summarize({
      panelId,
      conversation,
      providerModel: settings.model,
      cheapModel: this._cheapModel,
      minSummaryTokens: this._minSummaryTokens,
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
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<number>('compaction.threshold', COMPACTION_DEFAULT_THRESHOLD_PERCENT);
  }

  private _loadEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<boolean>('compaction.enabled', true);
  }

  private _loadSmartEnabled(): boolean {
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
