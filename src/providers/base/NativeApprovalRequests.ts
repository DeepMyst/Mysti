/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import type { NativeApprovalDecision, NativeApprovalHandler, NativeApprovalRequest } from './IProvider';
import { NativeApprovalScope } from './NativeApprovalScope';

export type { NativeApprovalDecision } from './IProvider';

/** Capture the issuing child and bind its lifetime to one approval scope. */
export class NativeApprovalRequests {
  private readonly _scope: NativeApprovalScope;
  private readonly _process: ChildProcess;
  private readonly _signal: AbortSignal;
  private _disposed = false;
  private readonly _onAbort = () => this.dispose();
  private readonly _onClose = () => this.dispose();

  constructor(owner: {
    providerId: string;
    panelId: string;
    process: ChildProcess;
    signal: AbortSignal;
    handler: NativeApprovalHandler | undefined;
    isCurrent(): boolean;
  }) {
    this._process = owner.process;
    this._signal = owner.signal;
    this._scope = new NativeApprovalScope({
      providerId: owner.providerId, panelId: owner.panelId,
      signal: owner.signal, handler: owner.handler, isCurrent: () => owner.isCurrent(),
    });
    this._signal.addEventListener('abort', this._onAbort, { once: true });
    this._process.once('close', this._onClose);
    this._process.once('exit', this._onClose);
    this._process.once('error', this._onClose);
    if (this._signal.aborted) { this.dispose(); }
  }

  get hasPending(): boolean { return this._scope.hasPending; }

  onPendingChanged(listener: () => void): () => void {
    return this._scope.onPendingChanged(listener);
  }

  request(
    nativeRequestId: string | number,
    toolCall: NativeApprovalRequest['toolCall'],
    defaultDecision: NativeApprovalRequest['defaultDecision'],
    respond: (decision: NativeApprovalDecision, process: ChildProcess) => void,
  ): void {
    this._scope.request(nativeRequestId, toolCall, defaultDecision, decision => respond(decision, this._process));
  }

  dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    this._signal.removeEventListener('abort', this._onAbort);
    this._process.removeListener('close', this._onClose);
    this._process.removeListener('exit', this._onClose);
    this._process.removeListener('error', this._onClose);
    this._scope.dispose();
  }
}
