/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { NativeApprovalHandler, NativeApprovalRequest } from './IProvider';

export type NativeApprovalDecision = 'allow' | 'deny' | 'cancelled';

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
    let settled = false;
    const finish = (decision: NativeApprovalDecision) => {
      if (settled) { return; }
      settled = true;
      this._pending.delete(key);
      this._notify();
      if (decision !== 'cancelled' && !this._owner.isCurrent()) { decision = 'cancelled'; }
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
    const request: NativeApprovalRequest = {
      id: `native-${randomUUID()}`, nativeRequestId,
      providerId: this._owner.providerId, panelId: this._owner.panelId,
      toolCall, defaultDecision, signal: controller.signal,
    };
    try {
      void Promise.resolve(this._owner.handler(request)).then(
        approved => finish(approved === 'cancelled' ? 'cancelled' : approved === true ? 'allow' : 'deny'),
        () => finish('deny'),
      );
    } catch { finish('deny'); }
  }

  /**
   * Park a native request whose answer comes from elsewhere (a question card)
   * rather than the approval handler. Like an approval it pauses the
   * inactivity clock and is cancelled with its turn or process. Returns the
   * settle function, or undefined when the request cannot be held.
   */
  hold<T>(nativeRequestId: string | number, respond: (value: T | 'cancelled', process: ChildProcess) => void): ((value: T) => void) | undefined {
    const key = `${typeof nativeRequestId}:${nativeRequestId}`;
    if (this._disposed || this._owner.signal.aborted || !this._owner.isCurrent() || this._pending.has(key)) { return undefined; }
    let settled = false;
    const finish = (value: T | 'cancelled') => {
      if (settled) { return; }
      settled = true;
      this._pending.delete(key);
      this._notify();
      if (value !== 'cancelled' && !this._owner.isCurrent()) { value = 'cancelled'; }
      try { respond(value, this._owner.process); } catch { /* process closed while writing */ }
    };
    this._pending.set(key, () => finish('cancelled'));
    this._notify();
    return finish;
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
