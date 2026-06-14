/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'crypto';
import type { CanvasJobEvent } from '../types';

/** A tracked canvas job with its cancellation handle. */
export interface CanvasJob {
  jobId: string;
  label?: string;
  controller: AbortController;
  startedAt: number;
}

/** Sink that forwards a {@link CanvasJobEvent} to the webview (postMessage). */
export type CanvasEventSink = (event: CanvasJobEvent) => void;

/** A job event with the `jobId` omitted — `pipe()`/`emit()` stamp it. */
export type CanvasJobEventBody = Omit<CanvasJobEvent, 'jobId'>;

/**
 * Extension-side job protocol for the canvas (Plan 05 Phase 1.7). Replaces the
 * ~14 copy-pasted `for await` blocks and the seven `_pending*Job` singletons
 * with one jobId-keyed envelope:
 *
 *  - mints/echoes `jobId`s and holds one `AbortController` per job,
 *  - `pipe()` consumes a pipeline's event stream, stamps the `jobId`, forwards
 *    each event to the sink, honors cancellation between events, and guarantees
 *    exactly one terminal (`done`/`error`) event — permanently fixing the F-4
 *    class of leaked-spinner bugs,
 *  - `cancel()` aborts a job by id so concurrent jobs no longer clobber each
 *    other and every overlay has a working Cancel.
 */
export class CanvasJobRouter {
  private _jobs = new Map<string, CanvasJob>();
  private _sink: CanvasEventSink;

  constructor(sink: CanvasEventSink) {
    this._sink = sink;
  }

  /** Rebind the event sink (e.g. when the canvas panel is recreated). */
  setSink(sink: CanvasEventSink): void {
    this._sink = sink;
  }

  /** Mint (or echo an existing) job and register its AbortController. */
  create(label?: string, jobId?: string): CanvasJob {
    const id = jobId ?? crypto.randomUUID();
    const existing = this._jobs.get(id);
    if (existing) { return existing; }
    const job: CanvasJob = {
      jobId: id,
      label,
      controller: new AbortController(),
      startedAt: Date.now(),
    };
    this._jobs.set(id, job);
    return job;
  }

  get(jobId: string): CanvasJob | undefined {
    return this._jobs.get(jobId);
  }

  has(jobId: string): boolean {
    return this._jobs.has(jobId);
  }

  signal(jobId: string): AbortSignal | undefined {
    return this._jobs.get(jobId)?.controller.signal;
  }

  activeCount(): number {
    return this._jobs.size;
  }

  /** Stamp `jobId` onto an event body and forward it to the sink. */
  emit(jobId: string, body: CanvasJobEventBody): void {
    this._sink({ ...body, jobId });
  }

  /**
   * Cancel a job: abort its signal so a running `pipe()` stops between events,
   * emit a single terminal `done {result:{cancelled}}`, and forget it.
   * Returns true if a live job was cancelled.
   */
  cancel(jobId: string): boolean {
    const job = this._jobs.get(jobId);
    if (!job) { return false; }
    job.controller.abort();
    this._jobs.delete(jobId);
    this._sink({ jobId, type: 'done', result: { cancelled: true } });
    return true;
  }

  /** Cancel every live job (panel dispose / new conversation). */
  cancelAll(): void {
    for (const jobId of [...this._jobs.keys()]) {
      this.cancel(jobId);
    }
  }

  /**
   * Drive a pipeline to completion under one job. The source generator yields
   * `CanvasJobEvent` bodies (no `jobId`); each is stamped and forwarded. The
   * job's `AbortSignal` is checked before every forward — once aborted, the
   * loop stops silently (`cancel()` already emitted the terminal event).
   *
   * Guarantees exactly one terminal event: if the generator never emits a
   * `done`/`error`, a `done` is appended; an exception becomes a single
   * `error` (unless the job was cancelled, in which case it stays silent).
   */
  async pipe(
    jobId: string,
    source: AsyncGenerator<CanvasJobEventBody>,
  ): Promise<void> {
    const job = this._jobs.get(jobId);
    const signal = job?.controller.signal;
    let lastType: CanvasJobEvent['type'] | undefined;
    try {
      for await (const body of source) {
        if (signal?.aborted) { return; }
        lastType = body.type;
        this.emit(jobId, body);
        if (lastType === 'done' || lastType === 'error') { break; }
      }
      if (signal?.aborted) { return; }
      if (lastType !== 'done' && lastType !== 'error') {
        this.emit(jobId, { type: 'done' });
      }
    } catch (err) {
      if (signal?.aborted) { return; }
      this.emit(jobId, {
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // A naturally-completed (non-cancelled) job is done with its controller.
      if (!signal?.aborted) { this._jobs.delete(jobId); }
    }
  }
}
