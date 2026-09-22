/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LivenessJobHandle, LivenessJobSpec } from './CanvasLiveness';

type TurnJobHandle = Pick<LivenessJobHandle, 'jobId' | 'done' | 'fail'>;

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
  private readonly _streamingPanels = new Set<string>();
  private readonly _jobs = new Map<string, { handle: TurnJobHandle; requestedId: string; cancel?: () => void; cancelled?: boolean }>();
  private readonly _cancelTurns = new Map<string, () => void>();
  private readonly _turnIds = new Map<string, string>();
  private _disposed = false;

  public constructor(private readonly _ports: CanvasTurnJobPorts) {}

  public begin(panelId: string, cancelCapturedTurn?: () => void, requestId?: string): void {
    if (!this._disposed) {
      this._streamingPanels.add(panelId);
      if (cancelCapturedTurn) { this._cancelTurns.set(panelId, cancelCapturedTurn); }
      else { this._cancelTurns.delete(panelId); }
      if (requestId) { this._turnIds.set(panelId, requestId); }
      else { this._turnIds.delete(panelId); }
    }
  }

  /** A late or detached write has no future turn end, so it cannot open a job. */
  public open(panelId: string, label: string, pageId?: string): void {
    if (this._disposed || !this._streamingPanels.has(panelId) || this._jobs.has(panelId)) { return; }
    const requestedId = this._jobId(panelId);
    const handle = this._ports.openJob({
      runId: 'chat-' + panelId,
      jobId: requestedId,
      label,
      ...(pageId ? { pageId } : {}),
    });
    if (handle) { this._jobs.set(panelId, { handle, requestedId, cancel: this._cancelTurns.get(panelId) }); }
  }

  /** Every exit from a streaming turn closes its job at most once. */
  public end(panelId: string, error?: string): void {
    this._streamingPanels.delete(panelId);
    this._cancelTurns.delete(panelId);
    this._turnIds.delete(panelId);
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
  }

  /**
   * Called after the view disposes its liveness owner. Forget only its handles:
   * a still-streaming turn can acquire a new job if the canvas is reopened.
   */
  public clearCanvas(): void {
    this._jobs.clear();
  }

  /** The host disposes the canvas liveness owner before discarding this state. */
  public dispose(): void {
    this._disposed = true;
    this._streamingPanels.clear();
    this._cancelTurns.clear();
    this._turnIds.clear();
    this._jobs.clear();
  }

  private _jobId(panelId: string): string {
    const requestId = this._turnIds.get(panelId);
    return `canvas-turn-${panelId}${requestId ? `-${requestId}` : ''}`;
  }
}
