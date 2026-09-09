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

import type { CoordinatorStreamEvent } from '../services/CoordinatorModelClient';
import type { GatewayChatMessage } from '../services/DeepMystGatewayClient';
import { MystiTagScanner, type MystiDirective, type MystiDirectiveKind } from '../utils/mystiDelegateParser';
import type { AccumulatedToolCall } from '../utils/toolCallAccumulator';

export interface CoordinatorStreamOptions {
  maxTokens: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal: AbortSignal;
  tools?: unknown[];
}

/** Host effects only. Tool execution and permission decisions stay with the caller. */
export interface CoordinatorTurnPorts {
  stream(messages: GatewayChatMessage[], options: CoordinatorStreamOptions): AsyncIterable<CoordinatorStreamEvent>;
  isCancelled(): boolean;
  registerAbort(controller: AbortController): void;
  getMaxTokens(): number;
  output: CoordinatorTurnOutput;
  /** Runs before every main stream, including length continuations. */
  beforeTurn?(): void;
  /** Complete raw turn text for the host's capability-refusal notices. */
  onTurnText?(text: string): void;
}

/** Stream/replay accounting can be shared with the host's tool-output record. */
export interface CoordinatorTurnOutput {
  beginTurn(): void;
  observe(event: CoordinatorStreamEvent): void;
  emitText(text: string): void;
  estimateInterruptedTurn(rawText: string): void;
}

export interface CoordinatorTurnConfig {
  nonce: string;
  /** Already authorized scanner kinds; this runner never adds capabilities. */
  scanKinds: readonly MystiDirectiveKind[];
  maxTurns: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  tools?: unknown[];
}

export type CoordinatorTurnResult =
  | { kind: 'turn'; text: string; directive?: MystiDirective; toolCalls?: AccumulatedToolCall[] }
  | { kind: 'error'; message: string; cause?: unknown };

interface TurnIterationScope {
  closed: boolean;
  controller?: AbortController;
}

const LENGTH_NUDGE = 'Your answer was cut off by the length limit. Continue EXACTLY where it stopped — do not repeat anything.';
const REASONING_NUDGE = 'You used your token budget without emitting a visible answer. Answer the user now, briefly and directly — do not think at length first.';
const FINALIZE_NUDGE = 'You have used your tool budget for this task. Do NOT emit any tool directives now. Using everything gathered above, give your best, complete final answer to the user\'s request — briefly and directly.';

/**
 * One coordinator run's model-turn state machine. The caller consumes a turn,
 * executes its already-gated tool, and appends the fenced result to messages
 * before asking for the next turn. A plain answer ends when the caller breaks.
 *
 * Owns scanner continuity, the two length continuations, the main stream cap,
 * the single additional no-tools rescue stream, and their round-trip count.
 * No VS Code, panel ids, credentials, tool dispatch, or persistence are needed.
 */
export class CoordinatorTurnRunner {
  private _roundTrips = 0;
  private _started = false;
  private _finalized = false;

  constructor(private readonly _config: CoordinatorTurnConfig, private readonly _ports: CoordinatorTurnPorts) {}

  public get roundTrips(): number { return this._roundTrips; }

  public turns(messages: GatewayChatMessage[]): AsyncGenerator<CoordinatorTurnResult> {
    const scope: TurnIterationScope = { closed: false };
    const iterator = this._turns(messages, scope);
    const stop = () => { scope.closed = true; scope.controller?.abort(); };
    // Async-generator return() otherwise queues behind a pending stream next().
    // Abort first so a consumer can abandon a blocked transport promptly.
    return {
      next: value => iterator.next(value),
      return: value => { stop(); return iterator.return(value); },
      throw: error => { stop(); return iterator.throw(error); },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  private async *_turns(messages: GatewayChatMessage[], scope: TurnIterationScope): AsyncGenerator<CoordinatorTurnResult> {
    if (this._started || this._finalized) { throw new Error('Coordinator turns can only run once'); }
    this._started = true;
    let scanner = this._scanner();
    let carryScanner = false;
    let lengthContinues = 0;
    const isCancelled = () => scope.closed || this._ports.isCancelled();
    for (let turn = 0; turn < this._config.maxTurns; turn++) {
      if (isCancelled()) { return; }
      this._ports.beforeTurn?.();
      if (!carryScanner) { scanner = this._scanner(); }
      carryScanner = false;
      const controller = new AbortController();
      scope.controller = controller;
      this._ports.registerAbort(controller);
      if (isCancelled()) { controller.abort(); return; }

      let text = '';
      let directive: MystiDirective | undefined;
      let toolCalls: AccumulatedToolCall[] | undefined;
      let finishReason: string | undefined;
      let failure: Extract<CoordinatorTurnResult, { kind: 'error' }> | undefined;
      try {
        this._ports.output.beginTurn();
        const maxTokens = this._ports.getMaxTokens();
        this._roundTrips++;
        for await (const event of this._ports.stream(messages, {
          maxTokens, reasoningEffort: this._config.reasoningEffort,
          signal: controller.signal, tools: this._config.tools,
        })) {
          if (isCancelled()) { break; }
          if (event.error) { failure = { kind: 'error', message: event.error }; break; }
          this._ports.output.observe(event);
          if (event.toolCalls?.length) { toolCalls = event.toolCalls; }
          if (event.finishReason) { finishReason = event.finishReason; }
          if (event.text) {
            text += event.text;
            const parsed = scanner.feed(event.text);
            if (parsed.text) { this._ports.output.emitText(parsed.text); }
            if (parsed.directive) {
              directive = parsed.directive;
              // Aborting omits the trailing usage frame. Estimate only output,
              // flag the receipt partial, and never pretend it measures fill.
              this._ports.output.estimateInterruptedTurn(text);
              controller.abort();
              break;
            }
          }
        }
      } catch (cause) {
        if (!directive && !isCancelled()) {
          failure = { kind: 'error', message: cause instanceof Error ? cause.message : 'Mysti failed', cause };
        }
      } finally {
        controller.abort();
        if (scope.controller === controller) { scope.controller = undefined; }
      }
      if (isCancelled()) { return; }
      if (failure) { yield failure; return; }
      this._ports.onTurnText?.(text);
      if (isCancelled()) { return; }

      // Do not flush a partial nonce tag until the continuation can finish it.
      // Native calls always win over the length-continuation path.
      if (!directive && !toolCalls?.length && finishReason === 'length' && lengthContinues < 2) {
        lengthContinues++;
        if (text.trim()) {
          carryScanner = true;
          messages.push({ role: 'assistant', content: text }, { role: 'user', content: LENGTH_NUDGE });
        } else {
          this._appendNudge(messages, REASONING_NUDGE);
        }
        continue;
      }

      // A captured text directive precedes native calls. Otherwise flush prose
      // alongside native calls, leaving their conversion/authority to the host.
      if (!directive) {
        const tail = scanner.flush();
        if (tail.text) { this._ports.output.emitText(tail.text); }
        if (!toolCalls?.length) { directive = tail.directive; }
      }
      if (toolCalls?.length && !directive && !text.trim()) {
        text = `(tool: ${toolCalls.map(call => call.name).join(', ')})`;
      }
      if (isCancelled()) { return; }
      yield { kind: 'turn', text, directive, toolCalls };
    }
  }

  /**
   * One best-effort rescue when the caller has no visible answer. It is an
   * additional, counted stream beyond maxTurns, with NO native tools. The same
   * scanner kinds redact directives, but nothing from this pass is dispatched.
   */
  public async finalize(messages: GatewayChatMessage[]): Promise<void> {
    if (this._finalized || this._ports.isCancelled()) { return; }
    this._finalized = true;
    const controller = new AbortController();
    this._ports.registerAbort(controller);
    if (this._ports.isCancelled()) { controller.abort(); return; }
    const finalMessages = messages.map(message => ({ ...message }));
    this._appendNudge(finalMessages, FINALIZE_NUDGE);
    const scanner = this._scanner();
    try {
      this._ports.output.beginTurn();
      this._roundTrips++;
      for await (const event of this._ports.stream(finalMessages, {
        maxTokens: 4096, reasoningEffort: this._config.reasoningEffort, signal: controller.signal,
      })) {
        if (this._ports.isCancelled() || event.error) { break; }
        this._ports.output.observe(event);
        if (event.text) {
          const parsed = scanner.feed(event.text);
          if (parsed.text) { this._ports.output.emitText(parsed.text); }
        }
      }
      if (!this._ports.isCancelled()) {
        const tail = scanner.flush();
        if (tail.text) { this._ports.output.emitText(tail.text); }
      }
    } catch { /* The caller keeps the partial answer when rescue fails. */ }
    finally { controller.abort(); }
  }

  private _scanner(): MystiTagScanner {
    return new MystiTagScanner(this._config.nonce, [...this._config.scanKinds]);
  }

  private _appendNudge(messages: GatewayChatMessage[], nudge: string): void {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') { last.content += `\n\n${nudge}`; }
    else { messages.push({ role: 'user', content: nudge }); }
  }
}
