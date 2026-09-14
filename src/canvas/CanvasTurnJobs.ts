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
  private readonly _jobs = new Map<string, TurnJobHandle>();
  private _disposed = false;

  public constructor(private readonly _ports: CanvasTurnJobPorts) {}

  public begin(panelId: string): void {
    if (!this._disposed) { this._streamingPanels.add(panelId); }
  }

  /** A late or detached write has no future turn end, so it cannot open a job. */
  public open(panelId: string, label: string, pageId?: string): void {
    if (this._disposed || !this._streamingPanels.has(panelId) || this._jobs.has(panelId)) { return; }
    const handle = this._ports.openJob({
      runId: 'chat-' + panelId,
      jobId: this._jobId(panelId),
      label,
      ...(pageId ? { pageId } : {}),
    });
    if (handle) { this._jobs.set(panelId, handle); }
  }

  /** Every exit from a streaming turn closes its job at most once. */
  public end(panelId: string, error?: string): void {
    this._streamingPanels.delete(panelId);
    const handle = this._jobs.get(panelId);
    if (!handle) { return; }
    this._jobs.delete(panelId);
    try {
      if (error) { handle.fail(error); } else { handle.done(); }
    } catch { /* a dead panel must never break the send path */ }
  }

  /** Hiding the liveness job alone would leave the provider writing. */
  public cancel(jobId: string): void {
    for (const [panelId, handle] of this._jobs) {
      if (handle.jobId !== jobId && this._jobId(panelId) !== jobId) { continue; }
      this._ports.cancelPanel(panelId);
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
    this._jobs.clear();
  }

  private _jobId(panelId: string): string {
    return `canvas-turn-${panelId}`;
  }
}
