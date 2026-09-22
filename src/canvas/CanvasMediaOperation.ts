/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { CanvasToolContext } from '../managers/CanvasToolDispatch';
import type { CanvasApprovalMode } from '../managers/CanvasOpExecutor';
import type { MediaAssetCommitControl, MediaAssetDestination, MediaAssetSubmission } from '../managers/ArtifactStore';
import { createAbortScope, type AbortScope } from '../utils/abortScope';

export interface CanvasMediaOperationCapture {
  readonly id: string;
  readonly ctx: CanvasToolContext;
  readonly signal: AbortSignal;
  readonly signals?: readonly AbortSignal[];
  isCurrent(): boolean;
  liveApproval(): CanvasApprovalMode;
  publish(): void;
  onDispose?(): void;
}

export class CanvasMediaCancelled extends Error {
  public constructor() { super('Canvas media operation cancelled.'); this.name = 'CanvasMediaCancelled'; }
}

/**
 * One admitted MCP media request. Context and destination are captured before
 * generation; a panel ID or a new request can never replace this owner.
 * The store alone admits the final commit. Once admitted, its captured
 * submission must finish even if the originating view subsequently retires.
 */
export class CanvasMediaOperation {
  public readonly id: string;
  public readonly destination: MediaAssetDestination | null;
  public readonly control: MediaAssetCommitControl;
  public readonly submission: MediaAssetSubmission;
  public readonly store: CanvasToolContext['store'];
  private readonly _controller = new AbortController();
  private readonly _scope: AbortScope;
  private readonly _owns: () => boolean;
  private readonly _publish: () => void;
  private readonly _onDispose?: () => void;
  private _disposed = false;

  public constructor(capture: CanvasMediaOperationCapture) {
    this.id = capture.id;
    this._owns = capture.isCurrent;
    this._publish = capture.publish;
    this._onDispose = capture.onDispose;
    const { artifact, executor, store, runId, jobId, approvalMode } = capture.ctx;
    this.store = store;
    this.destination = store.captureMediaDestination(artifact);
    this._scope = createAbortScope([capture.signal, ...(capture.signals ?? []), this._controller.signal]);
    const liveApproval = capture.liveApproval;
    this.control = Object.freeze({
      signal: this._scope.signal,
      isCurrent: this.isCurrent,
      approvalFloor: approvalMode,
      liveApproval,
    });
    this.submission = Object.freeze({
      runId, jobId,
      // This is called only AFTER the store's synchronous admission boundary.
      // Checking live ownership here would abandon an already accepted asset.
      submit: (record, approval) => executor.submit(artifact, {
        kind: 'add_asset', runId, author: 'agent', proposedValue: record,
      }, jobId, approval),
    } satisfies MediaAssetSubmission);
  }

  public get signal(): AbortSignal { return this._scope.signal; }

  public readonly isCurrent = (): boolean => {
    if (this._disposed || this.signal.aborted) { return false; }
    let owns = false;
    try { owns = this._owns(); } catch { /* A failed owner probe grants no authority. */ }
    if (!owns) { this.retire(); }
    return owns && !this._disposed && !this.signal.aborted;
  };

  public assertCurrent(): void { if (!this.isCurrent()) { throw new CanvasMediaCancelled(); } }

  public retire(): void { this._controller.abort(); }

  /** Explicit publication may reach only the captured, still-current view. */
  public publish(): void { if (this.isCurrent()) { this._publish(); } }

  public dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    this._scope.dispose();
    try { this._onDispose?.(); }
    catch (error) { console.warn('[Mysti] Canvas media owner cleanup failed:', error instanceof Error ? error.message : String(error)); }
  }

  /** Release a cancelled generation/fetch waiter while observing late failure. */
  public wait<T>(work: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => this.signal.removeEventListener('abort', aborted);
      const aborted = () => {
        if (settled) { return; }
        settled = true; cleanup(); reject(new CanvasMediaCancelled());
      };
      this.signal.addEventListener('abort', aborted, { once: true });
      if (this.signal.aborted) { aborted(); return; }
      Promise.resolve().then(() => { this.assertCurrent(); return work(); }).then(value => {
        if (settled) { return; }
        settled = true; cleanup();
        try { this.assertCurrent(); resolve(value); } catch (error) { reject(error); }
      }, error => {
        if (settled) { return; }
        settled = true; cleanup();
        try { this.assertCurrent(); } catch (cancelled) { reject(cancelled); return; }
        reject(error);
      });
    });
  }
}
