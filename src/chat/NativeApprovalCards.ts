/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NativeApprovalHandler, NativeApprovalHost, NativeApprovalRequest } from '../providers/base/IProvider';

type Decision = boolean | 'cancelled';

export interface NativeApprovalCardPorts {
  hasPanel(panelId: string): boolean;
  /** Capture once when the provider acquires its turn's approval handler. */
  captureScope(panelId: string): () => boolean;
  /** Create the interactive card synchronously, then await its decision. */
  request(request: NativeApprovalRequest): Promise<boolean>;
  /** Cancel only the permission whose toolCallId is this unique host request ID. */
  cancelCard(requestId: string): void;
}

interface PendingApproval {
  request: NativeApprovalRequest;
  promise: Promise<Decision>;
  cancel(): void;
}

/** Owns native approval cards independently of VS Code and provider transports. */
export class NativeApprovalCards implements NativeApprovalHost {
  private readonly _pending = new Map<string, PendingApproval>();
  private _disposed = false;

  public constructor(private readonly _ports: NativeApprovalCardPorts) {}

  public handlerForPanel(panelId: string): NativeApprovalHandler | undefined {
    if (this._disposed || !this._ports.hasPanel(panelId)) { return undefined; }
    const isCurrentScope = this._ports.captureScope(panelId);
    return request => request.panelId === panelId
      ? this._handle(request, isCurrentScope) : Promise.resolve(false);
  }

  /** For scoped callers that already carry the issuing turn's abort signal. */
  public handle(request: NativeApprovalRequest): Promise<Decision> {
    if (this._disposed || request.signal.aborted) { return Promise.resolve('cancelled'); }
    return this.handlerForPanel(request.panelId)?.(request) ?? Promise.resolve(false);
  }

  private _handle(request: NativeApprovalRequest, isCurrentScope: () => boolean): Promise<Decision> {
    const cancelled = () => this._disposed || request.signal.aborted || !isCurrentScope();
    if (cancelled()) { return Promise.resolve('cancelled'); }
    if (!this._ports.hasPanel(request.panelId)) { return Promise.resolve(false); }
    // A native deny is authoritative; it never becomes a request to the user.
    if (request.defaultDecision === 'deny') { return Promise.resolve(false); }
    if (request.defaultDecision === 'allow') { return Promise.resolve(cancelled() ? 'cancelled' : true); }
    if (request.defaultDecision !== 'ask') { return Promise.resolve(false); }

    const existing = this._pending.get(request.id);
    if (existing) {
      // The same delivery shares its card. A different owner cannot reuse its ID
      // to gain the first request's answer or cancel its pending permission.
      return existing.request === request ? existing.promise : Promise.resolve(false);
    }

    let resolve!: (decision: Decision) => void;
    const promise = new Promise<Decision>(settle => { resolve = settle; });
    let settled = false;
    let creating = false;
    let requested = false;
    let cardCleaned = false;
    const cleanCard = () => {
      if (!requested || creating || cardCleaned) { return; }
      cardCleaned = true;
      this._ports.cancelCard(request.id);
    };
    const finish = (decision: Decision) => {
      if (settled) { return; }
      settled = true;
      request.signal.removeEventListener('abort', onAbort);
      if (this._pending.get(request.id) === pending) { this._pending.delete(request.id); }
      try { cleanCard(); }
      finally { resolve(decision); }
    };
    const onAbort = () => finish('cancelled');
    const pending: PendingApproval = { request, promise, cancel: onAbort };
    this._pending.set(request.id, pending);
    // Observe before card creation: request() may synchronously close the panel,
    // dispose the registration, or abort while posting the permission message.
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (cancelled() || !this._ports.hasPanel(request.panelId)) {
      finish('cancelled');
      return promise;
    }

    creating = true;
    requested = true;
    try {
      const answer = this._ports.request(request);
      void Promise.resolve(answer).then(
        approved => finish(cancelled() || !this._ports.hasPanel(request.panelId) ? 'cancelled' : approved === true),
        () => finish(cancelled() || !this._ports.hasPanel(request.panelId) ? 'cancelled' : false),
      );
    } catch {
      finish(cancelled() || !this._ports.hasPanel(request.panelId) ? 'cancelled' : false);
    } finally {
      creating = false;
      // An adapter can synchronously abort before installing its pending card.
      // Wait until creation returns so cancellation also removes that card.
      if (settled) { cleanCard(); }
    }
    if (!settled && (cancelled() || !this._ports.hasPanel(request.panelId))) { finish('cancelled'); }
    return promise;
  }

  public dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    for (const pending of [...this._pending.values()]) { pending.cancel(); }
  }
}
