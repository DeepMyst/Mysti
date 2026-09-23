/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueuedChannelMessage } from '../managers/ChannelBridge';

/** Preserve every message and its source when several inputs share a turn. */
export function formatQueuedChannelTurn(messages: readonly QueuedChannelMessage[]): string {
  return messages.map(message => {
    const sender = message.sender ? ` from ${message.sender}` : '';
    return `[Via ${message.channelName}${sender}]: ${message.content}`;
  }).join('\n\n---\n\n');
}

/** A captured panel scope: current until cancelled, and its signal aborts at that moment. */
export type PanelScope = (() => boolean) & { readonly signal: AbortSignal };

/** Owns delayed channel turns independently for each panel and send generation. */
export class DelayedChannelTurns {
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _preparations = new Map<string, object>();
  private readonly _scopes = new Map<string, AbortController>();
  private _disposed = false;

  /**
   * Start a new turn's scope. Whatever scope is still live on the panel is
   * cancelled first (its signal aborts, its timer and preparation go), so two
   * turns never share a signal even if a caller forgot to cancel the old one.
   */
  public begin(panelId: string): PanelScope {
    this.cancelPanel(panelId);
    return this.capture(panelId);
  }

  /**
   * Join the panel's current scope. The signal aborts synchronously when the
   * scope is cancelled (Stop, replacement send, conversation change, dispose),
   * so work owned by it can close its transport instead of ignoring a late reply.
   * Work inside a turn (the send body, compaction, plan offers) joins; only
   * begin() starts a turn, so joining never rotates the turn it belongs to.
   */
  public capture(panelId: string): PanelScope {
    if (this._disposed) { return Object.assign(() => false, { signal: AbortSignal.abort() }); }
    let scope = this._scopes.get(panelId);
    if (!scope) { scope = new AbortController(); this._scopes.set(panelId, scope); }
    const captured = scope;
    return Object.assign(() => !this._disposed && this._scopes.get(panelId) === captured, { signal: captured.signal });
  }

  public has(panelId: string): boolean {
    return this._timers.has(panelId) || this._preparations.has(panelId);
  }

  /** Keep inbound messages queued until the prepared turn becomes an active stream. */
  public reservePreparation(panelId: string): () => void {
    if (this._disposed) { return () => {}; }
    const preparation = {};
    this._preparations.set(panelId, preparation);
    return () => {
      if (this._preparations.get(panelId) === preparation) {
        this._preparations.delete(panelId);
      }
    };
  }

  public schedule(panelId: string, callback: () => void, delayMs: number): void {
    if (this._disposed) { return; }
    const previous = this._timers.get(panelId);
    if (previous !== undefined) { clearTimeout(previous); }
    const isCurrent = this.capture(panelId);
    const timer = setTimeout(() => {
      if (!isCurrent() || this._timers.get(panelId) !== timer) { return; }
      this._timers.delete(panelId);
      callback();
    }, delayMs);
    this._timers.set(panelId, timer);
  }

  public cancelPanel(panelId: string): void {
    const scope = this._scopes.get(panelId);
    this._scopes.delete(panelId);
    scope?.abort();
    this._preparations.delete(panelId);
    const timer = this._timers.get(panelId);
    if (timer !== undefined) { clearTimeout(timer); }
    this._timers.delete(panelId);
  }

  public dispose(): void {
    this._disposed = true;
    const scopes = [...this._scopes.values()];
    this._scopes.clear();
    for (const scope of scopes) { scope.abort(); }
    this._preparations.clear();
    for (const panelId of this._timers.keys()) { this.cancelPanel(panelId); }
  }
}
