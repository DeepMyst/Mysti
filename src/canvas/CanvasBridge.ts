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
 * Plan 22 §3.4 — the **extension-host end** of the typed canvas protocol.
 *
 * `protocol.ts` declares the contract and `src/webview/canvas/protocolClient.ts`
 * is the webview half. This is the half that was never written: until now the
 * host still switched on legacy `msg.type` strings (`canvasReady`, `canvasSave`,
 * `canvasPrompt`, …) that no shipped webview has sent since Phase 2, and pushed
 * a whole `canvasArtifactUpdate` snapshot on every applied op. So the editor
 * surface existed and was not connected to anything.
 *
 * Four properties this module is responsible for, each tested:
 *
 * 1. **The front door authenticates.** Every client message goes through
 *    {@link acceptCanvasClientMessage} against the per-view token minted when
 *    the panel was created. It fails **closed**: no token, wrong token, or a
 *    token on a view that was never minted rejects the message. This is the
 *    control that stops a sandboxed, model-authored page from forging a human
 *    op — and it is why {@link _dispatch}'s `author: 'user'` is safe.
 * 2. **`author` is stamped from the channel, never read from the payload.**
 *    `CanvasOp` (what `canvas/submit` carries) has no `author` field at all, so
 *    forging one is uncompilable rather than merely refused. The one place that
 *    stamps it is {@link _onSubmit}.
 * 3. **Steady state is deltas.** {@link CanvasBridge.pushOps} sends only the
 *    journal records the view has not seen, with the artifact version they add
 *    up to. A full {@link CanvasBridge.resync} happens only when the
 *    arithmetic does NOT add up —
 *    which is the same rule the client applies, so the two ends can never
 *    silently disagree about whether a message was lost.
 * 4. **Every mutation pushes history.** The webview deliberately keeps no
 *    mirror of the undo stack (ops reach the artifact from MCP, from a
 *    `<canvas:NONCE>` directive and from detached jobs, none of which the view
 *    ever sees), so `canUndo`/`canRedo` only ever become true because this
 *    module pushed {@link CanvasHistory.status}.
 *
 * The exhaustive `switch` in {@link _dispatch} ends in
 * {@link assertNeverCanvasMessage}: a protocol variant added without a handler
 * here is a `tsc` failure, not a message that quietly does nothing.
 */

import {
  acceptCanvasClientMessage,
  assertNeverCanvasMessage,
  toWireArtifact,
  type ArtifactSummary as WireArtifactSummary,
  type CanvasClientMessage,
  type CanvasHostMessage,
  type CanvasOpReceipt,
  type CanvasOpRecord,
  type CapChip,
} from './protocol';
import { isCanvasOpShape, opPageId, type CanvasOp, type CanvasOpRecordV2 } from './CanvasOps';
import type { CanvasHistory } from './CanvasHistory';
import type { CanvasLiveness } from './CanvasLiveness';
import type { ArtifactStore } from '../managers/ArtifactStore';
import type { CanvasJobRouter } from '../managers/CanvasJobRouter';
import type { CanvasApprovalMode, CanvasOpExecutor } from '../managers/CanvasOpExecutor';
import type { Mid } from './doc/DocNode';
import type { CanvasArtifact, CanvasJobEvent } from '../types';

/**
 * Inbox key for a comment typed while no run is in flight.
 *
 * A comment must not evaporate because the human got to the artboard before
 * they got to the chat box: it queues here and the next coordinator run drains
 * this key alongside its own.
 */
export const CANVAS_PENDING_RUN = 'canvas-pending';

/** Everything one open design owns, from the bridge's point of view. */
export interface CanvasBridgeSession {
  artifact: CanvasArtifact;
  store: ArtifactStore;
  executor: CanvasOpExecutor;
  history: CanvasHistory;
  jobRouter: CanvasJobRouter;
  /** Owner of the per-run steering inbox and the agent cursor. */
  liveness?: CanvasLiveness;
}

/** What the bridge cannot do itself (webview panels, dialogs, files). */
export interface CanvasBridgeDeps {
  /** Post one host message to the canvas webview. */
  post: (message: CanvasHostMessage) => void;
  /** The live session, or `null` before the artifact has loaded. */
  session: () => CanvasBridgeSession | null;
  /** The token minted for this view. An empty string rejects every message. */
  viewToken: () => string;
  /** `resolveCanvasApproval(settings)` for the bound chat panel. */
  approvalMode: () => CanvasApprovalMode;
  /** Capability chips, once the async probe resolves. */
  caps?: () => CapChip[];
  /** Debounced persist. */
  scheduleSave?: () => void;
  /**
   * Coordinator runs that should receive steering right now. Empty → a comment
   * queues under {@link CANVAS_PENDING_RUN} for the next run instead.
   */
  steeringRunIds?: () => readonly string[];
  /**
   * Whether ANYTHING on the bound chat lane drains the steering inbox.
   *
   * `CANVAS_PENDING_RUN` has exactly one drain in the codebase — the
   * coordinator loop — so on every other backend a steering note, and the
   * accept/reject outcomes and parked/pinned notices behind it, reached no
   * model at all. The view meanwhile rendered the row as **Queued** with
   * "Mysti reads it when its next step starts", which a person on Claude Code
   * reasonably read as "the agent I am talking to". That is precisely the
   * receipt this module's docstring says it exists to avoid inventing.
   *
   * `false` ⇒ say so, in the view and in the `op_error` notice. Omitted ⇒ the
   * host has not reported, and the wording stays general rather than either
   * claiming or denying delivery.
   */
  steeringReachable?: () => boolean;
  /**
   * Stop whatever is actually producing a job, before the liveness handle is
   * torn down.
   *
   * `CanvasLiveness.cancel` aborts the job's `AbortSignal` and enqueues a
   * "the human cancelled this" note — which is enough for the in-process
   * coordinator lane and nothing at all for a CLI backend streaming through a
   * child process. Without this, a Stop button on such a lane would remove the
   * ghost while the agent kept rewriting artboards: a worse lie than having no
   * button.
   */
  onCancelJob?: (jobId: string) => void;
  onExport?: (format?: 'html' | 'png' | 'pdf') => void | Promise<void>;
  onPresent?: (pageId?: string) => void | Promise<void>;
  onAddScaffold?: (scaffold: string) => void | Promise<void>;
  /** The client painted an artifact. Feeds `mysti.canvasDiagnostics`. */
  onClientRendered?: (info: { pages: number; layoutMode: string; liveFrames: number;
    gestureP50?: number; gestureP95?: number; gestureDropped?: number }) => void;
  listArtifacts?: () => Promise<WireArtifactSummary[]>;
  onOpenArtifact?: (artifactId: string) => void | Promise<void>;
  onNewArtifact?: (opts: { name?: string; kind?: CanvasArtifact['kind']; formatId?: string }) => void | Promise<void>;
  onRenameArtifact?: (artifactId: string, name: string) => void | Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/** The board's current selection, mirrored host-side for the agent cursor. */
export interface CanvasSelectionState {
  pageId: string | null;
  mids: Mid[];
}

export class CanvasBridge {
  private readonly _deps: CanvasBridgeDeps;
  /**
   * The artifact version the view has been told about. `-1` = the view has not
   * had its authoritative transfer yet, so there is nothing to delta against.
   */
  private _sentVersion = -1;
  /** Last status pushed per op id — the delta unit. */
  private readonly _sentStatus = new Map<string, string>();
  /**
   * Serialized staged-op ids, so an unchanged staged set is not re-pushed.
   *
   * `null` = nothing has been sent for the current baseline. It is deliberately
   * NOT `''`: an empty staged set serializes to `''`, so a `''` sentinel made
   * the one push that CLEARS the rail — the authoritative empty snapshot after
   * a `hello`/`resync` — hit the "unchanged" early return and never go out.
   */
  private _sentStaged: string | null = null;
  private _selection: CanvasSelectionState = { pageId: null, mids: [] };
  private _jobSeq = 0;
  /** A `canvas/ready` that arrived before the artifact finished loading. */
  private _pendingHello: { resync: boolean } | null = null;
  /**
   * Depth of a multi-op operation whose intermediate states are not worth
   * shipping (an undo that reverts six ops, a restore that emits ten).
   *
   * Without it each inner `page_updated` reaches {@link onJobEvent}, finds the
   * artifact version ahead of the journal, and answers with a FULL resync — so
   * a six-op undo would ship the whole design six times and the view would
   * briefly render five states that never existed as a whole.
   */
  private _coalesce = 0;
  private _deferredOps = false;
  private _deferredHistory = false;
  /**
   * Jobs the view has been told `started` and not yet been told finished.
   *
   * E2E-4: a webview reload while a canvas job is running used to lose that job
   * permanently. {@link hello} transfers artifact, history, staged set and
   * artifacts and says nothing about work in flight, `CanvasLiveness` has no
   * replay producer (its only emitters are `openJob`'s one-shot `started` and
   * its heartbeat), and the client reducer DROPS a heartbeat for a job it has
   * no `started` for. The board therefore showed no ghost artboard, no elapsed
   * clock and — since `canvas/cancelJob` is only reachable from a ghost or a
   * status row — no way to Stop an agent that was still writing artboards.
   *
   * It is kept HERE rather than in the liveness layer because this is the half
   * that already owns "what has this view been told" ({@link _sentStatus},
   * {@link _sentVersion}, {@link _sentStaged}), and because every producer —
   * the coordinator lane, MCP, a detached job — reaches the view through
   * {@link onJobEvent}, so one map covers all of them. The fold is deliberately
   * the same rule as the client's `applyJobEvent`: `started` sets, a terminal
   * event removes. That is what makes this map equal to the view's own.
   */
  private readonly _liveJobs = new Map<string, { started: CanvasJobEvent; startedAt: number }>();
  /** Monotonic count of ACTUAL `canvas/history` posts. See {@link _coalesced}. */
  private _historyPushes = 0;
  private _disposed = false;

  constructor(deps: CanvasBridgeDeps) {
    this._deps = deps;
  }

  // ========================================================================
  // Front door
  // ========================================================================

  /**
   * Authenticate, narrow and dispatch one webview message.
   *
   * @returns true when the message was accepted and handled.
   */
  async handle(raw: unknown): Promise<boolean> {
    if (this._disposed) { return false; }
    const msg = acceptCanvasClientMessage(raw, this._deps.viewToken());
    if (!msg) {
      // Deliberately terse and un-echoed: the payload is untrusted and a
      // rejected message is a security event, not a debugging aid.
      this._log('canvas: rejected a client message (missing or mismatched view token)');
      return false;
    }
    await this._dispatch(msg);
    return true;
  }

  /** The board's selection, as last reported. View state — never persisted. */
  get selection(): CanvasSelectionState {
    return { pageId: this._selection.pageId, mids: [...this._selection.mids] };
  }

  /** Stop producing. Called when the canvas panel is disposed. */
  dispose(): void {
    this._disposed = true;
    this._coalesce = 0;
    this._deferredOps = false;
    this._deferredHistory = false;
    this._sentStatus.clear();
    this._pendingHello = null;
    this._sentVersion = -1;
    this._sentStaged = null;
    this._liveJobs.clear();
  }

  // ========================================================================
  // Producers
  // ========================================================================

  /**
   * The single authoritative state transfer (§3.4).
   *
   * Nothing is baked into the shell HTML, so this — not the panel's initial
   * render — is what puts a design on screen, and a webview reload therefore
   * cannot show a stale artifact.
   */
  hello(): void {
    const session = this._deps.session();
    if (this._disposed) { return; }
    if (!session) { this._pendingHello = { resync: false }; return; }
    const token = this._deps.viewToken();
    this._baseline(session);
    this._deps.post({
      t: 'canvas/hello',
      artifactId: session.artifact.id,
      artifact: toWireArtifact(session.artifact, { approvalMode: this._deps.approvalMode() }),
      viewToken: token,
      caps: this._deps.caps?.() ?? [],
    });
    this.pushHistory();
    this._flushStaged(session);
    this._replayJobs();
    void this.pushArtifacts();
  }

  /** Full re-send after a version gap. Cheaper than `hello` — no token, no caps. */
  resync(): void {
    const session = this._deps.session();
    if (this._disposed) { return; }
    if (!session) { this._pendingHello = { resync: true }; return; }
    this._baseline(session);
    this._deps.post({
      t: 'canvas/resync',
      artifact: toWireArtifact(session.artifact, { approvalMode: this._deps.approvalMode() }),
      artifactVersion: session.artifact.version,
    });
    this.pushHistory();
    this._flushStaged(session);
    this._replayJobs();
  }

  /** Called by the host once the artifact has finished loading. */
  onSessionReady(): void {
    const pending = this._pendingHello;
    this._pendingHello = null;
    if (!pending) { return; }
    if (pending.resync) { this.resync(); } else { this.hello(); }
  }

  /** Late capability probe (§3.3 "boot splits"). */
  pushCaps(caps: CapChip[]): void {
    if (this._disposed) { return; }
    this._deps.post({ t: 'canvas/caps', caps });
  }

  /**
   * The steady-state delta.
   *
   * Sends only records whose status CHANGED since the last push, so an op is
   * announced as `applied` exactly once and the client never double-applies it.
   * When the artifact version does not equal "what we last told the view, plus
   * the ops that just committed", something moved the artifact outside the
   * journal (an undo cursor revert, a direct store write) — and the honest
   * answer is a full transfer, not a delta that would leave the two ends
   * disagreeing.
   */
  pushOps(): void {
    const session = this._deps.session();
    if (this._disposed || !session) { return; }
    if (this._coalesce > 0) { this._deferredOps = true; return; }
    if (this._sentVersion < 0) { return; }        // no hello yet: nothing to delta against
    const journal = session.executor.journal(session.artifact.id);
    const changed: CanvasOpRecord[] = [];
    let committed = 0;
    for (const record of journal) {
      const previous = this._sentStatus.get(record.opId);
      if (previous === record.status) { continue; }
      if (record.status === 'applied' && previous !== 'applied') { committed++; }
      this._sentStatus.set(record.opId, record.status);
      changed.push(record);
    }
    this._prune(journal);

    const version = session.artifact.version;
    if (version !== this._sentVersion + committed) { this.resync(); return; }
    this._sentVersion = version;
    if (changed.length > 0) {
      this._deps.post({ t: 'canvas/ops', records: changed, artifactVersion: version });
    }
    this._flushStaged(session);
  }

  /** One receipt per write. A refusal is a card, not a `console.warn`. */
  pushReceipt(receipt: CanvasOpReceipt): void {
    if (this._disposed) { return; }
    this._deps.post({ t: 'canvas/receipt', receipt });
  }

  /**
   * Undo / redo / versions, decided host-side over the real op log.
   *
   * Pushed after EVERY mutation. The webview keeps no mirror, so this call is
   * the only reason its undo button is ever enabled.
   */
  pushHistory(): void {
    const session = this._deps.session();
    if (this._disposed || !session) { return; }
    if (this._coalesce > 0) { this._deferredHistory = true; return; }
    this._historyPushes++;
    this._deps.post({ t: 'canvas/history', status: session.history.status() });
  }

  /**
   * Run a multi-op mutation, then push ONCE.
   *
   * Job events still flow (`canvas/job` is liveness and must not be delayed);
   * only the document/history pushes are held, so the view sees the finished
   * state rather than every intermediate one.
   */
  private _coalesced(fn: () => void): void {
    this._coalesce++;
    try { fn(); } finally { this._coalesce--; }
    const ops = this._deferredOps;
    this._deferredOps = false;
    this._deferredHistory = false;
    const pushes = this._historyPushes;
    if (ops) { this.pushOps(); }
    // `fn` was a mutation and the undo cursor is what the view cannot recompute
    // for itself — but `pushOps` may already have answered with a full
    // transfer, which carries its own history push. Only fill the gap.
    if (this._historyPushes === pushes) { this.pushHistory(); }
  }

  /** `started` / `heartbeat` / `progress` from the session's job router. */
  pushJob(event: CanvasJobEvent): void {
    if (this._disposed) { return; }
    this._deps.post({ t: 'canvas/job', event });
  }

  /**
   * Fold one job event into {@link _liveJobs}, by the client's own rule.
   *
   * `heartbeat`/`progress` may re-label a job or move it to another artboard
   * mid-flight, so the replay has to describe where the job IS, not where it
   * began.
   */
  private _trackJob(event: CanvasJobEvent): void {
    const jobId = event?.jobId;
    if (typeof jobId !== 'string' || !jobId) { return; }
    switch (event.type) {
      case 'started':
        this._liveJobs.set(jobId, { started: { ...event }, startedAt: this._now() });
        return;
      case 'heartbeat':
      case 'progress': {
        const open = this._liveJobs.get(jobId);
        if (!open) { return; }
        if (typeof event.label === 'string' && event.label) { open.started.label = event.label; }
        if (typeof event.pageId === 'string' && event.pageId) { open.started.pageId = event.pageId; }
        return;
      }
      case 'done':
      case 'error':
        this._liveJobs.delete(jobId);
        return;
      default:
        return;
    }
  }

  /**
   * Re-announce every job still running, to a view that has just (re)booted.
   *
   * Two messages per job, not one: the client's `readGhost` starts every ghost
   * at `0:00`, so the clock is set by the heartbeat that follows. That also
   * makes this idempotent — a `resync` triggered mid-run by version arithmetic
   * re-states the ghost without rewinding its timer.
   */
  private _replayJobs(): void {
    if (this._disposed) { return; }
    const now = this._now();
    for (const [jobId, open] of this._liveJobs) {
      this.pushJob({ ...open.started, jobId, type: 'started' });
      this.pushJob({
        ...(open.started.label ? { label: open.started.label } : {}),
        ...(open.started.pageId ? { pageId: open.started.pageId } : {}),
        jobId,
        type: 'heartbeat',
        elapsedSeconds: Math.max(0, Math.round((now - open.startedAt) / 1000)),
      });
    }
  }

  /** The artifact picker's rows (Phase 6). */
  async pushArtifacts(): Promise<void> {
    const list = this._deps.listArtifacts;
    if (this._disposed || !list) { return; }
    try {
      const summaries = await list();
      if (this._disposed) { return; }
      this._deps.post({ t: 'canvas/artifacts', summaries });
    } catch (err) {
      this._log(`canvas: artifact listing failed: ${String(err)}`);
    }
  }

  /**
   * The job-router sink. One entry point for every event the executor and the
   * liveness layer emit, so "an op landed" has exactly one path to the view.
   */
  onJobEvent(event: CanvasJobEvent): void {
    if (this._disposed) { return; }
    this._trackJob(event);
    this.pushJob(event);
    switch (event.type) {
      case 'op_applied':
      case 'op_staged':
      case 'op_rejected':
      case 'op_error':
      case 'page_updated':
      case 'asset_ready':
        this.pushOps();
        // Every transport lands here — the coordinator's in-process tool call,
        // an MCP `tools/call` from a CLI backend, a fenced op, a scaffold — so
        // pushing history HERE is what makes "one shared undo stack" true for
        // ops the view never saw, rather than only for its own gestures.
        this.pushHistory();
        if (event.type === 'op_applied' || event.type === 'page_updated') {
          this._deps.scheduleSave?.();
        }
        return;
      default:
        return;
    }
  }

  // ========================================================================
  // Client messages — exhaustive
  // ========================================================================

  private async _dispatch(msg: CanvasClientMessage): Promise<void> {
    switch (msg.t) {
      case 'canvas/ready':
        // A bare `ready` is a boot; one carrying `haveVersion` is the client
        // telling us it detected a gap, and a resync is the cheaper answer.
        if (typeof msg.haveVersion === 'number') { this.resync(); } else { this.hello(); }
        return;
      case 'canvas/submit':
        this._onSubmit(msg);
        return;
      case 'canvas/selection':
        this._selection = {
          pageId: typeof msg.pageId === 'string' ? msg.pageId : null,
          mids: this._mids(msg.mids),
        };
        return;
      case 'canvas/editing':
        this._onEditing(msg);
        return;
      case 'canvas/decide':
        this._onDecide(msg);
        return;
      case 'canvas/undo':
        this._onHistoryStep('undo');
        return;
      case 'canvas/redo':
        this._onHistoryStep('redo');
        return;
      case 'canvas/checkpoint':
        this._onCheckpoint(msg.label);
        return;
      case 'canvas/restore':
        this._onRestore(msg.ref);
        return;
      case 'canvas/comment':
        this._onComment(msg);
        return;
      case 'canvas/cancelJob':
        this._onCancelJob(msg.jobId);
        return;
      case 'canvas/frameError':
        this._onFrameError(msg);
        return;
      case 'canvas/addScaffold':
        await this._deps.onAddScaffold?.(String(msg.scaffold ?? ''));
        return;
      case 'canvas/export':
        await this._deps.onExport?.(msg.format);
        return;
      case 'canvas/present':
        await this._deps.onPresent?.(msg.pageId);
        return;
      case 'canvas/newArtifact':
        await this._deps.onNewArtifact?.({ name: msg.name, kind: msg.kind, formatId: msg.formatId });
        await this.pushArtifacts();
        return;
      case 'canvas/openArtifact':
        await this._deps.onOpenArtifact?.(msg.artifactId);
        return;
      case 'canvas/renameArtifact':
        await this._onRename(msg.artifactId, msg.name);
        return;
      case 'canvas/diag':
        // Positive proof the client rendered, in whatever host it is running.
        // Everything else the bridge sees is a REQUEST; this is the only
        // message that says "the handshake completed and I painted".
        this._deps.onClientRendered?.({
          pages: Number(msg.pages) || 0,
          layoutMode: String(msg.layoutMode ?? ''),
          liveFrames: Number(msg.liveFrames) || 0,
          gestureP50: typeof msg.gestureP50 === 'number' ? msg.gestureP50 : undefined,
          gestureP95: typeof msg.gestureP95 === 'number' ? msg.gestureP95 : undefined,
          gestureDropped: typeof msg.gestureDropped === 'number' ? msg.gestureDropped : undefined,
        });
        return;
      default:
        // Unreachable while both ends share a build. `tsc` has already refused
        // a variant with no case above; this covers a NEWER webview bundle.
        assertNeverCanvasMessage(msg);
    }
  }

  /**
   * A human gesture.
   *
   * `author: 'user'` and `actorId` are stamped HERE, from the fact that the
   * message arrived on a token-authenticated view channel — they are not, and
   * structurally cannot be, read out of the payload. That is what makes pin
   * ownership (§3.5 rule 1) meaningful: a prompt-injected page cannot claim a
   * cell for the human and it cannot claim to be the human overriding a pin.
   *
   * Approval mode is `'auto'` and not {@link CanvasBridgeDeps.approvalMode}:
   * staging exists so an *agent's* edit waits for a human, and parking a
   * human's own drag behind their own accept button is nonsense.
   *
   * `txnId` rides through unchanged — it is what `CanvasHistory` groups on, so
   * re-minting it would turn a 60-frame slider drag into 60 undo steps.
   */
  private _onSubmit(msg: Extract<CanvasClientMessage, { t: 'canvas/submit' }>): void {
    const session = this._deps.session();
    if (!session) { return; }
    const ops = Array.isArray(msg.ops) ? msg.ops.filter(isCanvasOpShape) : [];
    if (ops.length === 0) { return; }
    const txnId = typeof msg.txnId === 'string' && msg.txnId ? msg.txnId : `txn-${this._now()}`;
    const jobId = this._jobId('submit');
    const force = Array.isArray(msg.force) ? msg.force.filter(c => typeof c === 'string') : undefined;

    session.history.beginTxn({ txnId, runId: txnId, author: 'user', label: 'Canvas edit' });
    this._coalesced(() => {
      try {
        for (const op of ops) {
          const receipt = session.executor.submitOp(
            session.artifact,
            {
              op,
              runId: txnId,
              txnId,
              author: 'user',
              actorId: 'canvas-view',
              baseVersion: this._baseVersionFor(session, msg.baseVersions, op),
              ...(force && force.length ? { force } : {}),
            },
            jobId,
            'auto',
          );
          this.pushReceipt(receipt);
        }
      } finally {
        session.history.endTxn();
      }
    });
    this._deps.scheduleSave?.();
  }

  /** Inline text edit / drag in progress: park agent ops in that subtree only. */
  private _onEditing(msg: Extract<CanvasClientMessage, { t: 'canvas/editing' }>): void {
    const session = this._deps.session();
    if (!session || typeof msg.pageId !== 'string' || !msg.pageId) { return; }
    const jobId = this._jobId('editing');
    const mids = this._mids(msg.mids);
    // Releasing a lock flushes whatever parked behind it, so this is a mutation.
    this._coalesced(() => {
      if (mids.length === 0) {
        session.executor.setPageEditing(session.artifact, msg.pageId, !!msg.editing, jobId);
        return;
      }
      for (const mid of mids) {
        session.executor.setSubtreeEditing(session.artifact, msg.pageId, mid, !!msg.editing, jobId);
      }
    });
  }

  /**
   * Accept / reject staged agent suggestions, and tell the run which it was.
   *
   * Routed by WHERE the op lives, not by which call happens to answer first: a
   * V2 submission sits in the executor's journal until it commits, while a
   * legacy kind-based one sits `pending` in `artifact.opLog` and is invisible
   * to `applyStagedOp`. The previous shape used the `undefined` from
   * `applyStagedOp` as a catch-all and fell through to `rejectOp` — so an
   * ACCEPT on any legacy staged op rejected it instead, which is the worst
   * possible way to answer a button labelled "Accept".
   */
  private _onDecide(msg: Extract<CanvasClientMessage, { t: 'canvas/decide' }>): void {
    const session = this._deps.session();
    if (!session) { return; }
    const opIds = Array.isArray(msg.opIds) ? msg.opIds.filter(id => typeof id === 'string' && id) : [];
    if (opIds.length === 0) { return; }
    const jobId = this._jobId('decide');
    const accept = !!msg.accept;
    const receipts: CanvasOpReceipt[] = [];
    this._coalesced(() => {
      for (const opId of opIds) {
        const receipt = accept
          ? session.executor.applyStagedOp(session.artifact, opId, jobId)
          : session.executor.rejectStagedOp(session.artifact, opId, jobId);
        if (receipt) { receipts.push(receipt); continue; }
        // Not in the V2 journal ⇒ a legacy kind-based op in `artifact.opLog`.
        if (!accept) { session.executor.rejectOp(session.artifact, opId, jobId); continue; }
        const applied = session.executor.applyOp(session.artifact, opId, jobId);
        if (!applied) { continue; }
        const legacyReceipt = session.executor.lastReceipt();
        // Only when it is demonstrably THIS op's receipt: `lastReceipt()` is a
        // single slot and reporting a neighbour's verdict would be worse than
        // reporting none.
        if (legacyReceipt && legacyReceipt.opId === opId) { receipts.push(legacyReceipt); }
      }
    });
    for (const receipt of receipts) { this.pushReceipt(receipt); }
    for (const runId of this._steeringRuns()) {
      session.liveness?.decision(runId, { opIds, accept });
    }
    this._deps.scheduleSave?.();
  }

  /**
   * One shared undo stack: Cmd+Z means "undo the last thing that happened",
   * whoever did it.
   *
   * A cursor revert deliberately does not journal (an undone op was applied and
   * can be redone — it is a position, not a verdict), so the artifact version
   * moves without a matching record and {@link pushOps} degrades to a resync.
   * That is correct rather than clever: undo is a discrete human action, not
   * the steady state the delta path exists for.
   */
  private _onHistoryStep(step: 'undo' | 'redo'): void {
    const session = this._deps.session();
    if (!session) { return; }
    const jobId = this._jobId(step);
    let receipts: ReturnType<CanvasHistory['undo']> = [];
    this._coalesced(() => {
      receipts = step === 'undo' ? session.history.undo(jobId) : session.history.redo(jobId);
    });
    for (const receipt of receipts) { this.pushReceipt(receipt); }
    this._deps.scheduleSave?.();
  }

  private _onCheckpoint(label: unknown): void {
    const session = this._deps.session();
    if (!session) { return; }
    const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : 'Checkpoint';
    session.history.checkpoint(name);
    this.pushHistory();
    this._deps.scheduleSave?.();
  }

  private _onRestore(ref: unknown): void {
    const session = this._deps.session();
    if (!session || typeof ref !== 'string' || !ref) { return; }
    // Restore emits OPS through the executor, so it lands in the same journal
    // and is itself one undoable transaction.
    this._coalesced(() => {
      session.history.restore(ref, { author: 'user', jobId: this._jobId('restore') });
    });
    this._deps.scheduleSave?.();
  }

  /**
   * A human comment on an element.
   *
   * This is human text arriving through a webview, so it is **data** (§2.8). It
   * goes into the per-run inbox and reaches a model only when the chat loop
   * drains it and wraps the body in `_fenceLocalToolResult` — never as a system
   * instruction, never concatenated into a prompt here.
   */
  private _onComment(msg: Extract<CanvasClientMessage, { t: 'canvas/comment' }>): void {
    const session = this._deps.session();
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!session?.liveness || !text.trim()) { return; }
    const where = {
      ...(typeof msg.pageId === 'string' && msg.pageId ? { pageId: msg.pageId } : {}),
      ...(typeof msg.mid === 'string' && msg.mid ? { mid: msg.mid } : {}),
    };
    for (const runId of this._steeringRuns()) {
      session.liveness.comment(runId, { ...where, text });
    }
    // It is still enqueued — a later `@mysti` turn drains `CANVAS_PENDING_RUN`
    // and picks it up — but the human is told the truth NOW rather than
    // discovering it by repeating themselves four times.
    this._warnUnreachableSteering();
  }

  /**
   * Say, once per note, that nothing on this lane will read it.
   *
   * Routed through the job seam the view already renders rather than a new wire
   * type: `op_error` is the host's "this did not land" channel, and a steering
   * note that reaches no model has not landed.
   */
  private _warnUnreachableSteering(): void {
    if (this._deps.steeringReachable?.() !== false) { return; }
    this._deps.post({
      t: 'canvas/job',
      event: {
        jobId: 'canvas-steering',
        type: 'op_error',
        error: 'This chat is on a backend that does not read canvas notes — only the Mysti agent drains them. Send “@mysti” in chat (or switch this chat to Mysti) and the note will be picked up.',
      },
    });
  }

  private _onCancelJob(jobId: unknown): void {
    const session = this._deps.session();
    if (!session || typeof jobId !== 'string' || !jobId) { return; }
    // The producer first: aborting the liveness handle only reaches an
    // `AbortSignal` the in-process coordinator polls. A CLI backend has to be
    // stopped by the host, and it has to happen BEFORE the handle disappears,
    // or the ghost is gone while the agent keeps writing.
    this._deps.onCancelJob?.(jobId);
    if (session.liveness?.cancel(jobId)) { return; }
    session.jobRouter.cancel(jobId);
  }

  /**
   * A frame reported a render error.
   *
   * Recorded, and rendered as an on-artboard card by the view. It is
   * deliberately NOT enqueued into the run by default: a render loop that
   * throws every frame would flood a turn with one message, which is why
   * `CanvasLiveness.frameError` defaults `enqueue` to false and the "Fix with
   * AI" affordance is the thing that passes `true`.
   */
  private _onFrameError(msg: Extract<CanvasClientMessage, { t: 'canvas/frameError' }>): void {
    const session = this._deps.session();
    const message = typeof msg.message === 'string' ? msg.message.slice(0, 500) : '';
    this._log(`canvas: frame error on page ${String(msg.pageId)}: ${message}`);
    if (!session?.liveness) { return; }
    for (const runId of this._steeringRuns()) {
      session.liveness.frameError(runId, { pageId: msg.pageId, mid: msg.mid, message }, false);
    }
  }

  private async _onRename(artifactId: unknown, name: unknown): Promise<void> {
    const session = this._deps.session();
    const next = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    if (!next) { return; }
    if (this._deps.onRenameArtifact) {
      await this._deps.onRenameArtifact(String(artifactId ?? ''), next);
    } else if (session && session.artifact.id === artifactId) {
      session.artifact.name = next;
      session.artifact.updatedAt = this._now();
      this._deps.scheduleSave?.();
      this.resync();
    }
    await this.pushArtifacts();
  }

  // ========================================================================
  // Internals
  // ========================================================================

  /**
   * Re-base the delta bookkeeping on a full transfer: the view now holds every
   * record we know about, so the next `pushOps` diffs from here.
   */
  private _baseline(session: CanvasBridgeSession): void {
    this._sentStatus.clear();
    // A full transfer resets the staged rail too, so an empty staged set after
    // a resync CLEARS it instead of leaving suggestion cards the view can no
    // longer act on. `null`, not `''` — see the field.
    this._sentStaged = null;
    for (const record of session.executor.journal(session.artifact.id)) {
      this._sentStatus.set(record.opId, record.status);
    }
    this._sentVersion = session.artifact.version;
  }

  /** Forget statuses for records the journal has evicted (it is bounded). */
  private _prune(journal: readonly CanvasOpRecordV2[]): void {
    if (this._sentStatus.size <= journal.length) { return; }
    const live = new Set(journal.map(r => r.opId));
    for (const opId of [...this._sentStatus.keys()]) {
      if (!live.has(opId)) { this._sentStatus.delete(opId); }
    }
  }

  /**
   * Suggestions awaiting accept/reject — the COMPLETE current set, pushed
   * whenever it changes and once per baseline so the client can hold it as a
   * snapshot rather than merging deltas it can never retract.
   *
   * The union is not cosmetic. Under the shipped default
   * (`mysti.accessLevel: 'ask-permission'` → {@link resolveCanvasApproval}
   * `'staged'`) the legacy kind-based {@link CanvasOpExecutor.submit} leaves an
   * op `pending` in `artifact.opLog` and pushes NO journal entry — the journal
   * mirror only runs after a successful apply. Reading the journal alone meant
   * every `insert_page` / `edit_page` / `delete_page` / `set_theme` /
   * `edit_element` / `scaffold_page` staged into a place no wire message could
   * reach: no board change, no card, no error. The wire type is
   * `LegacyCanvasOpRecord | CanvasOpRecordV2` precisely so both halves can ride
   * it, so nothing has to be fabricated here.
   */
  private _flushStaged(session: CanvasBridgeSession): void {
    const staged: CanvasOpRecord[] = session.executor
      .journal(session.artifact.id)
      .filter(r => r.status === 'staged');
    const seen = new Set(staged.map(r => r.opId));
    for (const op of session.artifact.opLog) {
      if (op.status !== 'pending' && op.status !== 'stale') { continue; }
      if (seen.has(op.opId)) { continue; }
      seen.add(op.opId);
      staged.push(op);
    }
    const key = staged.map(r => r.opId).join(',');
    if (key === this._sentStaged) { return; }
    this._sentStaged = key;
    this._deps.post({ t: 'canvas/staged', records: staged });
  }

  /**
   * The version the author read: the page's for a page-scoped op, the
   * artifact's for an artifact-scoped one. Getting this wrong is what makes a
   * correct edit look stale (§3.5 conflict ladder).
   */
  private _baseVersionFor(
    session: CanvasBridgeSession,
    baseVersions: Record<string, number> | undefined,
    op: CanvasOp,
  ): number | undefined {
    if (!baseVersions || typeof baseVersions !== 'object') { return undefined; }
    const pageId = opPageId(op);
    const key = pageId ?? session.artifact.id;
    const value = Object.prototype.hasOwnProperty.call(baseVersions, key)
      ? baseVersions[key]
      : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private _steeringRuns(): string[] {
    const runs = (this._deps.steeringRunIds?.() ?? []).filter(id => typeof id === 'string' && id);
    return runs.length > 0 ? [...new Set(runs)] : [CANVAS_PENDING_RUN];
  }

  private _mids(value: unknown): Mid[] {
    return Array.isArray(value) ? value.filter((m): m is Mid => typeof m === 'string' && m.length > 0) : [];
  }

  private _jobId(kind: string): string {
    return `canvas-view-${kind}-${++this._jobSeq}`;
  }

  private _now(): number {
    return this._deps.now ? this._deps.now() : Date.now();
  }

  private _log(message: string): void {
    if (this._deps.log) { this._deps.log(message); return; }
    console.log(`[Mysti] ${message}`);
  }
}
