/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { NativeApprovalDecision, NativeApprovalHandler, NativeApprovalRequest } from './IProvider';

export type { NativeApprovalDecision } from './IProvider';

/** One process and one turn own all requests in this scope. */
export class NativeApprovalRequests {
  private readonly _pending = new Map<string, (decision: NativeApprovalDecision) => void>();
  private readonly _listeners = new Set<() => void>();
  private _disposed = false;
  private readonly _onAbort = () => this.dispose();
  private readonly _onClose = () => this.dispose();

  constructor(private readonly _owner: {
    providerId: string;
    panelId: string;
    process: ChildProcess;
    signal: AbortSignal;
    handler: NativeApprovalHandler | undefined;
    isCurrent(): boolean;
  }) {
    _owner.signal.addEventListener('abort', this._onAbort, { once: true });
    _owner.process.once('close', this._onClose);
    _owner.process.once('exit', this._onClose);
    _owner.process.once('error', this._onClose);
    if (_owner.signal.aborted) { this.dispose(); }
  }

  get hasPending(): boolean { return this._pending.size > 0; }

  onPendingChanged(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  private _notify(): void {
    for (const listener of this._listeners) { listener(); }
  }

  request(
    nativeRequestId: string | number,
    toolCall: NativeApprovalRequest['toolCall'],
    defaultDecision: NativeApprovalRequest['defaultDecision'],
    respond: (decision: NativeApprovalDecision, process: ChildProcess) => void,
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
      if (decision !== 'cancelled' && !this._owner.isCurrent()) { decision = 'cancelled'; }
      // Observation cannot widen a local policy denial or request a card.
      try {
        void Promise.resolve(this._owner.handler?.onDecision?.(request, decision)).catch(() => {});
      } catch { /* host observation must not prevent the native response */ }
      // Capture the original process. Never look up a replacement by panel ID.
      try { respond(decision, this._owner.process); } catch { /* process closed while writing */ }
      controller.abort();
    };
    this._pending.set(key, finish);
    this._notify();
    if (this._disposed || this._owner.signal.aborted || !this._owner.isCurrent()) {
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

  dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    this._owner.signal.removeEventListener('abort', this._onAbort);
    this._owner.process.removeListener('close', this._onClose);
    this._owner.process.removeListener('exit', this._onClose);
    this._owner.process.removeListener('error', this._onClose);
    for (const finish of [...this._pending.values()]) { finish('cancelled'); }
    this._listeners.clear();
  }
}
