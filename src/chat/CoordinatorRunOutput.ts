/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageSegment, ToolCall, UsageStats, WebviewMessage } from '../types';
import type { CoordinatorStreamEvent } from '../services/CoordinatorModelClient';
import { addUsage, contextFillTokens, normalizeUsage } from '../services/TokenAccounting';

/** One run's streamed UI output, replay record and usage receipt. No host state. */
export class CoordinatorRunOutput {
  private _text = '';
  private _thinking = '';
  private _model?: string;
  private _firstText = false;
  private readonly _segments: MessageSegment[] = [];
  private readonly _tools: ToolCall[] = [];
  private _usage: UsageStats = { input_tokens: 0, output_tokens: 0 };
  private _lastTurnUsage?: UsageStats;
  private _sawUsage = false;
  private _turnStarted = false;
  private _turnHasUsage = false;
  private _partial = false;
  private _cost = 0;
  private _sawCost = false;

  constructor(
    private readonly _post: (message: WebviewMessage) => void,
    private readonly _jobId?: string,
    private readonly _now: () => number = Date.now,
  ) {}

  public get text(): string { return this._text; }
  public get model(): string | undefined { return this._model; }
  public get hasContent(): boolean { return this._tools.length > 0 || !!this._text.trim(); }

  public beginTurn(): void {
    if (this._turnStarted && !this._turnHasUsage) { this._partial = true; }
    this._turnStarted = true;
    this._turnHasUsage = false;
    // The previous prompt size is not a measurement of this round-trip.
    this._lastTurnUsage = undefined;
  }

  /** Consume metadata before scanning text: a directive may end the same event. */
  public observe(event: CoordinatorStreamEvent): void {
    if (event.model) { this._model = event.model; }
    if (event.reasoning) { this.emitThinking(event.reasoning); }
    if (typeof event.costUsd === 'number' && Number.isFinite(event.costUsd) && event.costUsd >= 0) {
      this._cost += event.costUsd;
      this._sawCost = true;
    }
    if (event.usage) {
      // CoordinatorModelClient already supplies disjoint buckets. Sanitize,
      // without subtracting cache reads from the uncached input a second time.
      const usage = normalizeUsage(event.usage, 'anthropic');
      this._usage = addUsage(this._usage, usage);
      this._lastTurnUsage = usage;
      this._sawUsage = true;
      this._turnHasUsage = true;
    }
  }

  /** An early directive abort can prevent the trailing usage frame arriving. */
  public estimateInterruptedTurn(rawText: string): void {
    if (this._turnHasUsage) { return; }
    this._usage.output_tokens += Math.ceil(rawText.length / 4);
    this._partial = true;
    // A previous round-trip's fill is no longer the current context size.
    this._lastTurnUsage = undefined;
  }

  public emitText(text: string): void {
    if (!text) { return; }
    this._text += text;
    const last = this._segments[this._segments.length - 1];
    if (last?.type === 'text') { last.content = (last.content || '') + text; }
    else { this._segments.push({ type: 'text', content: text }); }
    if (this._jobId) {
      this._post({ type: 'jobProgress', payload: { jobId: this._jobId, kind: 'text', content: text } });
      return;
    }
    const payload: { type: string; content: string; perfSentAt?: number } = { type: 'text', content: text };
    if (!this._firstText) { this._firstText = true; payload.perfSentAt = this._now(); }
    this._post({ type: 'responseChunk', payload });
  }

  public emitThinking(text: string): void {
    if (!text) { return; }
    this._thinking += text;
    this._post(this._jobId
      ? { type: 'jobProgress', payload: { jobId: this._jobId, kind: 'thinking', content: text } }
      : { type: 'responseChunk', payload: { type: 'thinking', content: text } });
  }

  public postToolUse(tool: Pick<ToolCall, 'id' | 'name' | 'input'>): void {
    this._post(this._jobId
      ? { type: 'jobToolUse', payload: { jobId: this._jobId, toolCall: tool } }
      : { type: 'toolUse', payload: tool });
  }

  public postToolResult(tool: { id: string; name: string; output: string; status: string }): void {
    this._post(this._jobId
      ? { type: 'jobToolResult', payload: { jobId: this._jobId, toolCall: tool } }
      : { type: 'toolResult', payload: tool });
  }

  public recordTool(id: string, name: string, input: Record<string, unknown>, output: string, failed: boolean): void {
    this._tools.push({ id, name, input: structuredClone(input), output, status: failed ? 'failed' : 'completed' });
    this._segments.push({ type: 'tool', toolCallId: id });
  }

  public recordDelegation(id: string, agent: string, task: string, output: string, failed: boolean, tier?: string): void {
    this.recordTool(id, 'delegate', { agent, task, ...(tier ? { tier } : {}) }, output, failed);
  }

  public recordReview(id: string, reviewer: string, of: string, output: string, failed: boolean): void {
    this.recordTool(id, 'review', { reviewer, of }, output, failed);
  }

  /** Detached snapshot: storing an interrupted run must not mutate live state. */
  public snapshot(model: string, marker?: string) {
    const text = this._text.trim();
    const segments = this._segments.map(segment => ({ ...segment }));
    if (marker) { segments.push({ type: 'text', content: `\n\n${marker}` }); }
    return {
      content: marker ? (text ? `${text}\n\n${marker}` : marker) : text || 'The Mysti agent did not produce a result.',
      thinking: this._thinking.trim() || undefined,
      extras: {
        model,
        toolCalls: this._tools.length ? structuredClone(this._tools) : undefined,
        segments: segments.length ? segments : undefined,
      },
    };
  }

  public measurements() {
    return {
      contextTokens: this._lastTurnUsage ? contextFillTokens(this._lastTurnUsage) : undefined,
      outputTokens: this._sawUsage ? this._usage.output_tokens : undefined,
      cacheReadTokens: this._usage.cache_read_input_tokens || undefined,
      cacheCreationTokens: this._usage.cache_creation_input_tokens || undefined,
      estimated: this._usageIsPartial(),
    };
  }

  public receipt(delegations: number) {
    if (!this._sawUsage && !this._sawCost && delegations === 0) { return undefined; }
    return {
      ...this._usage,
      ...(this._lastTurnUsage ? { contextTokens: contextFillTokens(this._lastTurnUsage) } : {}),
      ...(this._sawCost && this._cost > 0 ? { costUsd: this._cost } : {}),
      ...(delegations > 0 ? { delegations } : {}),
      ...(this._usageIsPartial() ? { tokensPartial: true } : {}),
    };
  }

  private _usageIsPartial(): boolean {
    return this._partial || !this._sawUsage || (this._turnStarted && !this._turnHasUsage);
  }
}
