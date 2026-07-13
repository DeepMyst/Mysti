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
 *
 * BackgroundJobManager (Plan 16 / Phase D) — tracks detached Mysti runs so a
 * long task (an agentic run, an orchestration) can execute in the background
 * while the chat stays interactive, and report results when it finishes — the
 * Claude-Code "run it in the background and report when done" model.
 *
 * Durability (Plan 17 P1.5): job records are persisted to globalState so a
 * result isn't lost if its panel closed, and so a window reload doesn't leave a
 * job "running forever" — a still-'running' record whose owning host has stopped
 * heart-beating is marked 'interrupted' (the detached run's processes died with
 * the host). The full cross-reload state machine (resumable runs, orphan
 * detection) is the Plan 10 JobStore and remains out of scope; this is the
 * honest, no-lost-work floor.
 *
 * Multi-window (review [5]): globalState is SHARED across every VSCode window
 * for the extension. Each running host stamps its own `hostId` + a periodic
 * `heartbeat` on the jobs it owns, and `_persist` MERGES with the on-disk array
 * — a host is authoritative ONLY for its own jobs and never clobbers another
 * window's records. `sweep()` (driven by a periodic timer + run once at attach)
 * finalizes a foreign running job only after its heartbeat goes stale, so a live
 * second window's active jobs are never falsely interrupted.
 */

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface BackgroundJob {
  id: string;
  panelId: string;
  conversationId: string;
  /** Short human-facing label (the truncated brief). */
  title: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  /** Final answer text (on done). */
  resultText?: string;
  /** Error message (on failed). */
  error?: string;
  /** Count of delegations the job performed (for the summary card). */
  delegations: number;
  /** True once a terminal state was surfaced to a live panel (P1.5). */
  reported?: boolean;
  /** Id of the host (window session) that owns/last-wrote this job (review [5]). */
  hostId?: string;
  /** Last liveness stamp from the owning host — staleness ⇒ host gone (review [5]). */
  heartbeat?: number;
}

/** Minimal Memento shape (vscode.Memento) so tests can pass a plain object. */
export interface JobStoreLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

const STORE_KEY = 'mysti.backgroundJobs.v1';
const MAX_PERSISTED = 60;
/** How often a live host refreshes its running jobs' heartbeats. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A running job whose heartbeat is older than this is treated as host-dead. */
export const HEARTBEAT_STALE_MS = 90_000;

export class BackgroundJobManager {
  private readonly _jobs = new Map<string, BackgroundJob>();
  private _store?: JobStoreLike;
  /** This window session's id — stamped on every job this instance owns. */
  private _hostId = 'default';
  private _beatTimer?: ReturnType<typeof setInterval>;
  private _beatNow: () => number = () => Date.now();
  /**
   * Ids of jobs THIS session is ACTIVELY EXECUTING right now (review [5]). A job
   * in this set is alive here regardless of what the durable record says, so
   * neither sweep()'s foreign-sync/GC nor _mergeJob may overwrite it with a
   * stale foreign 'interrupted' claim (a machine sleep / event-loop stall can
   * make another window falsely GC a running job, which — without this veto —
   * irreversibly discarded its result via the monotonic rank).
   */
  private readonly _executing = new Set<string>();

  /**
   * Attach durable storage and rehydrate (P1.5 / review [5]). Loads persisted
   * records (from this window's prior session AND any other live window), then
   * runs one `sweep(now)` — a still-'running' record is finalized to
   * 'interrupted' ONLY if its heartbeat is stale (the owning host is gone); a
   * fresh record belonging to another live window is left running. Returns the
   * finished-but-unreported jobs so the caller can notify the user of results
   * that completed while away.
   *
   * @param hostId a stable-per-window-session id (e.g. crypto.randomUUID()).
   */
  attachStore(store: JobStoreLike, now: number, hostId?: string): BackgroundJob[] {
    this._store = store;
    if (hostId) { this._hostId = hostId; }
    const persisted = store.get<BackgroundJob[]>(STORE_KEY);
    if (Array.isArray(persisted)) {
      for (const j of persisted) {
        if (!j || typeof j.id !== 'string') { continue; }
        // Normalize legacy records (pre-review[5]) so staleness math is defined.
        if (typeof j.heartbeat !== 'number') { j.heartbeat = j.finishedAt ?? j.startedAt ?? now; }
        this._jobs.set(j.id, j);
      }
      // sweep FIRST so this reload's stale-running records become 'interrupted',
      // THEN collect what needs surfacing — review[14]: 'interrupted' jobs were
      // previously excluded from the away-notification and had no UI, so a job
      // running when the window reloaded vanished without any trace.
      this.sweep(now);
    }
    const unreportedFinished: BackgroundJob[] = [];
    for (const j of this._jobs.values()) {
      if ((j.status === 'done' || j.status === 'failed' || j.status === 'interrupted') && !j.reported) {
        unreportedFinished.push(j);
      }
    }
    return unreportedFinished;
  }

  /**
   * Start the periodic heartbeat/GC timer (review [5]). Not started at attach so
   * unit tests stay timer-free — the extension calls this once after attach.
   * The timer is unref'd so it never keeps the host process alive.
   */
  startHeartbeat(nowFn: () => number = () => Date.now(), intervalMs: number = HEARTBEAT_INTERVAL_MS): void {
    this._beatNow = nowFn;
    this.stopHeartbeat();
    this._beatTimer = setInterval(() => { try { this.sweep(this._beatNow()); } catch { /* best-effort */ } }, intervalMs);
    // Node timer: don't hold the event loop open on shutdown.
    (this._beatTimer as unknown as { unref?: () => void }).unref?.();
  }

  stopHeartbeat(): void {
    if (this._beatTimer) { clearInterval(this._beatTimer); this._beatTimer = undefined; }
  }

  dispose(): void { this.stopHeartbeat(); }

  /**
   * Liveness + GC pass (review [5]): (1) refresh the heartbeat of every job THIS
   * host owns and still runs — proving to other windows it is alive; (2) finalize
   * any running job whose heartbeat has gone stale to 'interrupted' (its owning
   * host is gone) and claim it so the state persists under the ownership merge.
   */
  sweep(now: number): void {
    // Re-sync jobs we do NOT own from the freshest disk state first: another
    // window may have finished or refreshed them since we loaded our copy, and
    // GC'ing a stale in-memory copy would clobber their true terminal state.
    const disk = this._store?.get<BackgroundJob[]>(STORE_KEY);
    if (Array.isArray(disk)) {
      for (const d of disk) {
        // Never let a foreign record overwrite a job we are actively executing
        // (review [5]) — a false 'interrupted' claim would otherwise replace our
        // live 'running' copy and, via the monotonic rank, become unrecoverable.
        if (d && typeof d.id === 'string' && d.hostId !== this._hostId && !this._executing.has(d.id)) { this._jobs.set(d.id, d); }
      }
    }
    let changed = false;
    for (const job of this._jobs.values()) {
      if (job.status !== 'running') { continue; }
      if (job.hostId === this._hostId || this._executing.has(job.id)) {
        // Ours, or one we are executing → prove liveness and (re)claim ownership
        // so a prior false interrupt from another window cannot stick (review [5]).
        if (job.hostId !== this._hostId) { job.hostId = this._hostId; }
        job.heartbeat = now;
        changed = true;
      } else if (now - (job.heartbeat ?? job.startedAt) > HEARTBEAT_STALE_MS) {
        job.status = 'interrupted';
        job.finishedAt = now;
        job.hostId = this._hostId; // claim it so our authoritative write sticks
        changed = true;
      }
    }
    if (changed) { this._persist(); }
  }

  /** Terminal states beat 'interrupted' (a guess) beats 'running' (review [5]). */
  private static _rank(s: JobStatus): number {
    return s === 'running' ? 0 : s === 'interrupted' ? 1 : 2;
  }

  /**
   * Reconcile a disk record `d` with our in-memory candidate `m` for the same
   * job id, ownership-aware and MONOTONIC (review [5] re-review):
   *   - a more-advanced status wins (never resurrect a terminal job to running,
   *     never let a presumed 'interrupted' override a real done/failed/cancelled);
   *   - on a tie the owner wins, else the fresher heartbeat;
   *   - `reported` is monotonic — once surfaced anywhere it never re-notifies.
   * This prevents cross-window resurrection races and repeated away-notifications.
   */
  private _mergeJob(d: BackgroundJob, m: BackgroundJob): BackgroundJob {
    // A job THIS host is actively executing is authoritative regardless of the
    // disk record (review [5]): another window's stale 'interrupted' claim, which
    // otherwise out-ranks our 'running', must never win over a job we are running.
    if (this._executing.has(m.id)) {
      return (d.reported || m.reported) && !m.reported ? { ...m, reported: true } : m;
    }
    const rd = BackgroundJobManager._rank(d.status);
    const rm = BackgroundJobManager._rank(m.status);
    let winner: BackgroundJob;
    if (rm > rd) { winner = m; }
    else if (rm < rd) { winner = d; }
    else if (m.hostId === this._hostId && d.hostId !== this._hostId) { winner = m; }
    else if (d.hostId === this._hostId && m.hostId !== this._hostId) { winner = d; }
    else { winner = (m.heartbeat ?? 0) >= (d.heartbeat ?? 0) ? m : d; }
    return (d.reported || m.reported) && !winner.reported ? { ...winner, reported: true } : winner;
  }

  private _persist(): void {
    if (!this._store) { return; }
    // Ownership-aware MONOTONIC merge (review [5]): start from the freshest disk
    // array (which may hold another live window's jobs) and reconcile each of our
    // in-memory records against it via _mergeJob — a host is authoritative only
    // for its own jobs, never resurrects a job another window finalized, and the
    // away-notification `reported` flag can never be lost across windows.
    const merged = new Map<string, BackgroundJob>();
    const disk = this._store.get<BackgroundJob[]>(STORE_KEY);
    if (Array.isArray(disk)) {
      for (const j of disk) { if (j && typeof j.id === 'string') { merged.set(j.id, j); } }
    }
    for (const job of this._jobs.values()) {
      const existing = merged.get(job.id);
      merged.set(job.id, existing ? this._mergeJob(existing, job) : job);
    }
    const all = [...merged.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_PERSISTED);
    void this._store.update(STORE_KEY, all);
  }

  /** Register a new running job. `now` is injectable for tests. */
  create(id: string, panelId: string, conversationId: string, title: string, now: number): BackgroundJob {
    const job: BackgroundJob = {
      id, panelId, conversationId,
      title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
      status: 'running',
      startedAt: now,
      delegations: 0,
      hostId: this._hostId,
      heartbeat: now,
    };
    this._jobs.set(id, job);
    this._executing.add(id); // this session is executing it → protected in sweep (review [5])
    this._persist();
    return job;
  }

  get(id: string): BackgroundJob | undefined {
    return this._jobs.get(id);
  }

  /** True while the job exists and hasn't reached a terminal state. */
  isRunning(id: string): boolean {
    return this._jobs.get(id)?.status === 'running';
  }

  /**
   * Number of jobs THIS host is currently running (for the concurrency cap,
   * P1.5). Scoped to own-host (review [5] re-review): another VSCode window's
   * running jobs share globalState but run in that window's processes, so they
   * must not count against this window's cap and refuse the user a new task.
   */
  runningCount(): number {
    let n = 0;
    for (const j of this._jobs.values()) { if (j.status === 'running' && j.hostId === this._hostId) { n++; } }
    return n;
  }

  incrementDelegations(id: string): void {
    const job = this._jobs.get(id);
    if (job) { job.delegations += 1; this._persist(); }
  }

  markDone(id: string, resultText: string, now: number): BackgroundJob | undefined {
    return this._settle(id, 'done', now, { resultText });
  }

  markFailed(id: string, error: string, now: number): BackgroundJob | undefined {
    return this._settle(id, 'failed', now, { error });
  }

  markCancelled(id: string, now: number): BackgroundJob | undefined {
    return this._settle(id, 'cancelled', now, {});
  }

  /** Mark a terminal state as surfaced to a live panel (suppresses re-notify). */
  markReported(id: string): void {
    const job = this._jobs.get(id);
    if (job) { job.reported = true; this._persist(); }
  }

  private _settle(id: string, status: JobStatus, now: number, extra: Partial<BackgroundJob>): BackgroundJob | undefined {
    const job = this._jobs.get(id);
    if (!job) { return undefined; }
    // review[5]: a job we are executing may have been falsely marked terminal by
    // another window's stale-claim — force-settle it to its TRUE outcome so its
    // result is never lost. Otherwise settle only from 'running' (idempotent).
    if (job.status !== 'running' && !this._executing.has(id)) { return undefined; }
    this._executing.delete(id);
    job.status = status;
    job.finishedAt = now;
    // Claim + stamp: settling is authoritative activity by THIS host (review [5]).
    job.hostId = this._hostId;
    job.heartbeat = now;
    Object.assign(job, extra);
    this._persist();
    return job;
  }

  listForPanel(panelId: string): BackgroundJob[] {
    return [...this._jobs.values()]
      .filter(j => j.panelId === panelId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** All jobs, most-recent first (for /jobs across a reloaded session). */
  listAll(): BackgroundJob[] {
    return [...this._jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  listRunning(panelId: string): BackgroundJob[] {
    return this.listForPanel(panelId).filter(j => j.status === 'running');
  }

  /** Drop a job from tracking (e.g. dismissed). */
  remove(id: string): void {
    this._jobs.delete(id);
    this._executing.delete(id);
    this._persist();
  }

  /**
   * Mark every still-running job THIS host owns on a panel cancelled. review[41]:
   * scoped to own-host — the in-memory map holds rehydrated FOREIGN-window jobs
   * and panelIds collide across windows (the fixed 'sidebar' id), so an unscoped
   * settle would cancel (and, via the terminal rank, clobber) another live
   * window's job. Currently unused in the dispose path (jobs deliberately survive
   * tab close, review [8]) but kept host-safe should it be wired later.
   */
  cancelAllForPanel(panelId: string, now: number): void {
    for (const job of this._jobs.values()) {
      if (job.panelId === panelId && job.status === 'running' && job.hostId === this._hostId) {
        this._settle(job.id, 'cancelled', now, {});
      }
    }
  }
}
