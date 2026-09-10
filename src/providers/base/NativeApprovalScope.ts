/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'crypto';
import type { NativeApprovalDecision, NativeApprovalHandler, NativeApprovalRequest } from './IProvider';

export interface NativeApprovalScopeOptions {
  providerId: string;
  panelId: string;
  signal: AbortSignal;
  handler: NativeApprovalHandler | undefined;
  isCurrent(): boolean;
}

/** One captured turn owns its approval requests, independent of transport. */
export class NativeApprovalScope {
  private readonly _pending = new Map<string, (decision: NativeApprovalDecision) => void>();
  private readonly _listeners = new Set<() => void>();
  private _disposed = false;
  private readonly _onAbort = () => this.dispose();

  constructor(private readonly _owner: NativeApprovalScopeOptions) {
    _owner.signal.addEventListener('abort', this._onAbort, { once: true });
    if (_owner.signal.aborted) { this.dispose(); }
  }

  get hasPending(): boolean { return this._pending.size > 0; }

  onPendingChanged(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try { listener(); } catch { /* observation must not strand native decisions or cancellation */ }
    }
  }

  private _isCurrent(): boolean {
    return !this._disposed && !this._owner.signal.aborted && this._owner.isCurrent();
  }

  request(
    nativeRequestId: string | number,
    toolCall: NativeApprovalRequest['toolCall'],
    defaultDecision: NativeApprovalRequest['defaultDecision'],
    respond: (decision: NativeApprovalDecision) => void,
  ): void {
    if (this._disposed) { return; }
    const key = `${typeof nativeRequestId}:${nativeRequestId}`;
    if (this._pending.has(key)) { return; }
    const controller = new AbortController();
    const request: NativeApprovalRequest = {
      id: `native-${randomUUID()}`, nativeRequestId,
      providerId: this._owner.providerId, panelId: this._owner.panelId,
      toolCall, defaultDecision, signal: controller.signal,
    };
    let settled = false;
    const finish = (decision: NativeApprovalDecision) => {
      if (settled) { return; }
      settled = true;
      this._pending.delete(key);
      this._notify();
      if (decision !== 'cancelled' && !this._isCurrent()) { decision = 'cancelled'; }
      // Observation cannot widen a local policy denial or request a card.
      try {
        void Promise.resolve(this._owner.handler?.onDecision?.(request, decision)).catch(() => {});
      } catch { /* host observation must not prevent the native response */ }
      // An observer can synchronously retire this turn. Its local observation
      // cannot authorize a wire response after cancellation supersedes it.
      if (decision !== 'cancelled' && !this._isCurrent()) { decision = 'cancelled'; }
      try { respond(decision); } catch { /* transport closed while responding */ }
      controller.abort();
    };
    this._pending.set(key, finish);
    this._notify();
    if (!this._isCurrent()) {
      finish('cancelled');
      return;
    }
    if (defaultDecision === 'deny' || !this._owner.handler) {
      finish(defaultDecision === 'allow' ? 'allow' : 'deny');
      return;
    }
    try {
      void Promise.resolve(this._owner.handler(request)).then(
        approved => finish(approved === 'cancelled' ? 'cancelled' : approved === true ? 'allow' : 'deny'),
        () => finish('deny'),
      );
    } catch { finish('deny'); }
  }

  /** A native cancellation retires only its own pending request and card. */
  cancel(nativeRequestId: string | number): void {
    this._pending.get(`${typeof nativeRequestId}:${nativeRequestId}`)?.('cancelled');
  }

  dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    this._owner.signal.removeEventListener('abort', this._onAbort);
    for (const finish of [...this._pending.values()]) { finish('cancelled'); }
    this._listeners.clear();
  }
}
