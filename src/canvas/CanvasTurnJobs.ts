/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LivenessJobHandle, LivenessJobSpec } from './CanvasLiveness';

type TurnJobHandle = Pick<LivenessJobHandle, 'jobId' | 'done' | 'fail'>;

interface TurnState {
  requestId?: string;
  cancel?: () => void;
}

interface OpenRequest {
  turn: TurnState;
  canvas: object;
  label: string;
  pageId?: string;
}

interface OpeningJob {
  request: OpenRequest;
  requestedId: string;
  cancelled?: boolean;
  error?: string;
  next?: OpenRequest;
}

export interface CanvasTurnJobPorts {
  /** Resolve the current view's liveness owner at the moment an edit begins. */
  openJob(spec: LivenessJobSpec): TurnJobHandle | undefined;
  /** Stop the provider request that produces this panel's canvas edits. */
  cancelPanel(panelId: string): void;
}

/**
 * Owns the canvas jobs produced by streaming CLI and MCP chat turns.
 *
 * One job brackets the whole turn once it touches the canvas. Individual edits
 * are synchronous, so opening and closing a job around each edit would hide the
 * running state and leave the board's Stop button unable to stop the producer.
 * This owner cannot write an artifact, render a view, or access a provider.
 */
export class CanvasTurnJobs {
  private readonly _turns = new Map<string, TurnState>();
  private readonly _jobs = new Map<string, { handle: TurnJobHandle; requestedId: string; cancel?: () => void; cancelled?: boolean }>();
  private readonly _opening = new Map<string, OpeningJob>();
  private _canvas: object = {};
  private _disposed = false;

  public constructor(private readonly _ports: CanvasTurnJobPorts) {}

  public begin(panelId: string, cancelCapturedTurn?: () => void, requestId?: string): void {
    if (!this._disposed) {
      this._turns.set(panelId, { cancel: cancelCapturedTurn, requestId });
    }
  }

  /** A late or detached write has no future turn end, so it cannot open a job. */
  public open(panelId: string, label: string, pageId?: string): void {
    const turn = this._turns.get(panelId);
    if (this._disposed || !turn || this._jobs.has(panelId)) { return; }
    const request: OpenRequest = { turn, canvas: this._canvas, label, pageId };
    const opening = this._opening.get(panelId);
    if (opening) {
      // A started sink may replace the turn or view synchronously. Serialize
      // the replacement until the old handle returns: legacy IDs can match,
      // and opening immediately would otherwise borrow that old live handle.
      if (opening.request.turn !== turn || opening.request.canvas !== this._canvas) {
        opening.next = request;
      }
      return;
    }
    this._open(panelId, request);
  }

  /** Every exit from a streaming turn closes its job at most once. */
  public end(panelId: string, error?: string): void {
    const turn = this._turns.get(panelId);
    this._turns.delete(panelId);
    const opening = this._opening.get(panelId);
    if (opening && opening.request.turn === turn) { opening.error = error; }
    const job = this._jobs.get(panelId);
    if (!job) { return; }
    const { handle } = job;
    this._jobs.delete(panelId);
    try {
      if (error) { handle.fail(error); } else { handle.done(); }
    } catch { /* a dead panel must never break the send path */ }
  }

  /** Hiding the liveness job alone would leave the provider writing. */
  public cancel(jobId: string): void {
    for (const [panelId, job] of this._jobs) {
      const { handle, requestedId, cancel } = job;
      if (handle.jobId !== jobId && requestedId !== jobId) { continue; }
      if (job.cancelled) { return; }
      job.cancelled = true;
      if (cancel) { cancel(); } else { this._ports.cancelPanel(panelId); }
      return;
    }
    for (const [panelId, opening] of this._opening) {
      if (opening.requestedId !== jobId) { continue; }
      if (opening.cancelled) { return; }
      opening.cancelled = true;
      const cancel = opening.request.turn.cancel;
      if (cancel) { cancel(); } else { this._ports.cancelPanel(panelId); }
      return;
    }
  }

  /**
   * Called after the view disposes its liveness owner. Forget only its handles:
   * a still-streaming turn can acquire a new job if the canvas is reopened.
   */
  public clearCanvas(): void {
    this._canvas = {};
    this._jobs.clear();
  }

  /** The host disposes the canvas liveness owner before discarding this state. */
  public dispose(): void {
    this._disposed = true;
    this._turns.clear();
    this._jobs.clear();
  }

  private _isCurrent(panelId: string, request: OpenRequest): boolean {
    return !this._disposed && this._turns.get(panelId) === request.turn && this._canvas === request.canvas;
  }

  private _open(panelId: string, request: OpenRequest): void {
    const { turn, label, pageId } = request;
    const requestedId = `canvas-turn-${panelId}${turn.requestId ? `-${turn.requestId}` : ''}`;
    const opening: OpeningJob = { request, requestedId };
    this._opening.set(panelId, opening);
    try {
      const handle = this._ports.openJob({
        runId: 'chat-' + panelId,
        jobId: requestedId,
        label,
        ...(pageId ? { pageId } : {}),
      });
      if (handle) {
        if (this._isCurrent(panelId, request)) {
          this._jobs.set(panelId, { handle, requestedId, cancel: turn.cancel, cancelled: opening.cancelled });
        } else {
          try {
            if (opening.error) { handle.fail(opening.error); } else { handle.done(); }
          } catch { /* only the obsolete handle is being retired */ }
        }
      }
    } finally {
      this._opening.delete(panelId);
      const next = opening.next;
      if (next && this._isCurrent(panelId, next)) { this._open(panelId, next); }
    }
  }
}
