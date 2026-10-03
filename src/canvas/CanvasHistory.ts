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
import type { CanvasOpExecutor } from '../managers/CanvasOpExecutor';
import type {
  ArtifactPage,
  CanvasArtifact,
  CanvasFormatSpec,
  CanvasOp,
  CanvasOpKind,
  CanvasOpStatus,
  DesignTheme,
} from '../types';
import type { DocNode } from './doc/DocNode';

/** A named restore point over the artifact's page/theme/format state. */
export interface VersionRef {
  id: string;
  label: string;
  ts: number;
  /** `artifact.version` at the moment the checkpoint was taken. */
  artifactVersion: number;
}

/**
 * One undo step as the timeline UI sees it.
 *
 * Deliberately carries no display string: `label` is only ever what
 * {@link CanvasHistory.beginTxn}'s caller supplied, and `kinds` is raw op
 * vocabulary. Turning that into "Mysti · edited 3 artboards" is the webview's
 * job (`src/webview/canvas/historyUi.ts`) — a host-side class that formats UI
 * copy is the second implementation of a seam, which is how every other part of
 * this subsystem drifted.
 */
export interface CanvasHistoryTxnView {
  txnId: string;
  runId?: string;
  author: 'user' | 'agent';
  /** The author-supplied label; absent for a step inferred from `runId`. */
  label?: string;
  /** Distinct op kinds in this step, first-seen order. The UI's label source. */
  kinds: CanvasOpKind[];
  opCount: number;
  ts: number;
  /** True when the step is currently in effect (its index is below the cursor). */
  inEffect: boolean;
}

/**
 * A checkpoint plus what a parent-rendered thumbnail needs.
 *
 * `thumbDoc` is the FIRST artboard's document as it stood at checkpoint time,
 * cloned once when the checkpoint is taken. `src/webview/canvas/preview.ts`
 * draws it with no iframe and no scripts, which is the only way a thumbnail of
 * a past version can exist at all: `sandbox="allow-scripts"` without
 * `allow-same-origin` denies the parent pixel access to a live frame, so
 * rasterizing was never on the table.
 */
export interface CanvasVersionView extends VersionRef {
  pageCount: number;
  /** Read-only. Owned by this history; the wire projection serializes it. */
  thumbDoc?: DocNode;
  /** The format that artboard was designed at, so the tile scales correctly. */
  thumbFormat?: CanvasFormatSpec;
}

/**
 * Everything the undo/redo chrome and the version timeline need, in one
 * snapshot.
 *
 * This exists because the webview must NOT keep its own copy of the undo stack.
 * `canUndo()`/`canRedo()` are decided here, over the real op log, by the one
 * class that owns the cursor; the UI renders the answer. A client-side mirror
 * would be a second implementation of history, and it would be wrong the first
 * time an op arrived from a transport the webview never saw (an MCP `tools/call`
 * from a CLI backend, a `<canvas:NONCE>` directive, a background job).
 */
export interface CanvasHistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  /** How many transactions are in effect. */
  position: number;
  /** The step Cmd+Z would revert, for the button's tooltip. */
  undo?: CanvasHistoryTxnView;
  /** The step Cmd+Shift+Z would re-apply. */
  redo?: CanvasHistoryTxnView;
  transactions: CanvasHistoryTxnView[];
  versions: CanvasVersionView[];
}

/**
 * The subset of Plan 20 §3.2's `CanvasOpReceipt` that today's engine can
 * honestly fill in. Phase 2 widens this (rebased/pinned/newMids/since) once the
 * doc model lands; the field names here are already the final ones so callers
 * do not have to change.
 *
 * `status` carries `'undone'` — which {@link CanvasOpStatus} deliberately does
 * NOT, because undone-ness is a position in this history's cursor, not a
 * verdict stamped on the op (a `rejected` op was refused by a human; an
 * `undone` op was applied, reverted, and can be redone).
 */
export interface CanvasOpReceiptLike {
  opId: string;
  status: CanvasOpStatus | 'undone';
  pageId?: string;
  pageVersion?: number;
  artifactVersion: number;
  error?: string;
}

/** Author-supplied grouping for {@link CanvasHistory.beginTxn}. */
export interface CanvasTxnMeta {
  txnId?: string;
  /** Chat turn / job id whose ops belong to this transaction. */
  runId?: string;
  author: 'user' | 'agent';
  label?: string;
}

/** One undo step: the ops that landed between a `beginTxn`/`endTxn` pair. */
export interface CanvasTxn {
  txnId: string;
  runId?: string;
  author: 'user' | 'agent';
  label?: string;
  opIds: string[];
  ts: number;
  /** False when the transaction was inferred from `runId` rather than opened. */
  explicit: boolean;
}

/** Deep copy of the restorable slice of an artifact, taken at checkpoint time. */
interface VersionSnapshot {
  pages: ArtifactPage[];
  theme: DesignTheme;
  format: CanvasFormatSpec;
}

/** Page fields a restore may not patch (identity / version bookkeeping). */
const PAGE_IDENTITY_KEYS = new Set(['id', 'version']);

/**
 * Undo/redo for a canvas artifact as a **cursor over transaction boundaries**
 * (Plan 20 §3.2), replacing `CanvasOpExecutor.undoLastApplied` — which flipped
 * `status` to `'rejected'`, conflating "the user refused this" with "this was
 * undone" and making redo impossible.
 *
 * Semantics:
 * - The cursor splits the transaction list: `[0, position)` are in effect,
 *   `[position, length)` are undone and redoable.
 * - A new op recorded while the cursor is rewound **truncates the redo tail**,
 *   the way every editor does.
 * - Grouping: one human drag is one transaction (`beginTxn`/`endTxn`); one
 *   agent turn is one transaction keyed by `runId`, so undoing a bad design
 *   pass reverts the whole pass instead of one page at a time.
 * - Ops are discovered from `artifact.opLog` on every call, so ops submitted
 *   through any transport (MCP tool, fenced directive, prompt bar, the webview)
 *   are captured without that transport knowing this class exists. Ops that
 *   were applied before this history was constructed are captured too.
 * - Only `applied` ops become undo steps: `pending`/`stale` ops are re-checked
 *   on later calls (a staged op that a human accepts joins the history then),
 *   and `rejected`/`superseded` ops never enter it.
 *
 * This object is bound to one in-memory {@link CanvasArtifact} instance. A
 * reload that replaces the artifact object must construct a new history.
 */
export class CanvasHistory {
  private _artifact: CanvasArtifact;
  private _executor: CanvasOpExecutor;
  /** Job id used for `page_updated` re-render events; undefined = silent. */
  private _jobId: string | undefined;

  private _txns: CanvasTxn[] = [];
  /** Number of transactions currently in effect (the undo cursor). */
  private _cursor = 0;
  private _open: CanvasTxn | null = null;

  /** Ops already folded into the transaction list. */
  private _seen = new Set<string>();
  private _opById = new Map<string, CanvasOp>();
  /** Low-water mark for op-log scanning (ops before it are seen or terminal). */
  private _scanFrom = 0;

  private _versions: VersionRef[] = [];
  private _snapshots = new Map<string, VersionSnapshot>();
  /** Timeline views, built once per checkpoint (a snapshot never changes). */
  private _versionViews: CanvasVersionView[] = [];

  constructor(
    artifact: CanvasArtifact,
    executor: CanvasOpExecutor,
    opts: { jobId?: string } = {},
  ) {
    this._artifact = artifact;
    this._executor = executor;
    this._jobId = opts.jobId;
    this._ingest();
  }

  // ========================================================================
  // Transactions
  // ========================================================================

  /**
   * Open a transaction. Every op applied until {@link endTxn} becomes part of
   * one undo step. Returns the transaction id (generated when not supplied) so
   * the caller can stamp it onto the ops it is about to submit.
   */
  beginTxn(meta: CanvasTxnMeta): string {
    // Anything applied before this call belongs to the previous step.
    this.endTxn();
    this._open = {
      txnId: meta.txnId ?? crypto.randomUUID(),
      runId: meta.runId,
      author: meta.author,
      label: meta.label,
      opIds: [],
      ts: Date.now(),
      explicit: true,
    };
    return this._open.txnId;
  }

  /** Close the open transaction (no-op when none is open). */
  endTxn(): void {
    this._ingest();
    this._open = null;
  }

  // ========================================================================
  // Cursor
  // ========================================================================

  canUndo(): boolean {
    this._ingest();
    return this._cursor > 0;
  }

  canRedo(): boolean {
    this._ingest();
    return this._cursor < this._txns.length;
  }

  /**
   * Revert the most recent transaction still in effect, applying each of its
   * ops' recorded inverse in reverse order. Returns one receipt per reverted
   * op; an empty array when there is nothing to undo.
   *
   * `jobId` (falling back to the constructor's) addresses the `page_updated`
   * re-render events at the live job, so an `undo_canvas` tool call re-renders
   * under its own spinner.
   */
  undo(jobId?: string): CanvasOpReceiptLike[] {
    this.endTxn();
    if (this._cursor <= 0) { return []; }
    const txn = this._txns[this._cursor - 1];
    const job = jobId ?? this._jobId;
    const receipts: CanvasOpReceiptLike[] = [];
    /** Reverted so far, newest first — the rollback order is its reverse. */
    const reverted: CanvasOp[] = [];
    for (let i = txn.opIds.length - 1; i >= 0; i--) {
      const op = this._opById.get(txn.opIds[i]);
      if (!op) { continue; }
      try {
        const pageId = this._revertOp(op, job);
        reverted.push(op);
        receipts.push(this._receipt(op, 'undone', pageId));
      } catch (err) {
        this._rollback(reverted, op => this._reapplyOp(op, job), 'undo', err);
        return [];
      }
    }
    this._cursor -= 1;
    console.log(
      `[Mysti] canvas-history undo txn=${txn.txnId} ops=${txn.opIds.length} run=${txn.runId ?? '-'}`,
    );
    return receipts;
  }

  /** Re-apply the transaction the cursor is parked on. */
  redo(jobId?: string): CanvasOpReceiptLike[] {
    this.endTxn();
    if (this._cursor >= this._txns.length) { return []; }
    const txn = this._txns[this._cursor];
    const job = jobId ?? this._jobId;
    const receipts: CanvasOpReceiptLike[] = [];
    /** Re-applied so far, oldest first — the rollback order is its reverse. */
    const applied: CanvasOp[] = [];
    for (const opId of txn.opIds) {
      const op = this._opById.get(opId);
      if (!op) { continue; }
      try {
        const pageId = this._reapplyOp(op, job);
        applied.push(op);
        receipts.push(this._receipt(op, 'applied', pageId));
      } catch (err) {
        this._rollback(applied, op => this._revertOp(op, job), 'redo', err);
        return [];
      }
    }
    this._cursor += 1;
    console.log(
      `[Mysti] canvas-history redo txn=${txn.txnId} ops=${txn.opIds.length} run=${txn.runId ?? '-'}`,
    );
    return receipts;
  }

  /**
   * Put the document back the way this undo/redo found it, and leave the
   * cursor where it was.
   *
   * A transaction is ONE undo step, so a half-applied one is a document state
   * that exists in no transaction: history would report the step as undone
   * while part of it is in effect, pressing undo again would revert the
   * PREVIOUS step on top of it, and the next new op would `_truncate()` the
   * stranded ops to `superseded` — permanently out of the undo stack with
   * their effect still in the tree. All-or-nothing is the only honest answer,
   * and the failure is reported rather than thrown so the view still resyncs.
   */
  private _rollback(
    done: readonly CanvasOp[],
    inverse: (op: CanvasOp) => unknown,
    step: 'undo' | 'redo',
    err: unknown,
  ): void {
    for (let i = done.length - 1; i >= 0; i--) {
      try { inverse(done[i]); }
      catch (rollbackErr) {
        console.log(`[Mysti] canvas-history ${step} rollback failed for op ${done[i].opId}:`, rollbackErr);
      }
    }
    console.log(`[Mysti] canvas-history ${step} failed, rolled back ${done.length} op(s):`, err);
  }

  // ========================================================================
  // Runs — "undo this whole design pass"
  // ========================================================================

  /** Every op the given chat turn / job authored, in op-log order. */
  opsForRun(runId: string): CanvasOp[] {
    this._ingest();
    return this._artifact.opLog.filter(op => op.runId === runId);
  }

  /**
   * Undo every in-effect transaction belonging to `runId`.
   *
   * The log is linear, so this rewinds the cursor **through** any newer
   * transactions that landed after the run — selectively reverting a middle
   * transaction can silently corrupt later work that built on it (undoing the
   * insert of a page a later op edited would drop that edit's target). The
   * collateral work is not lost: it sits in the redo tail and {@link redo}
   * restores it, and the returned receipts name every op that was reverted.
   */
  undoRun(runId: string, jobId?: string): CanvasOpReceiptLike[] {
    this.endTxn();
    const receipts: CanvasOpReceiptLike[] = [];
    while (this._cursor > 0 && this._runIsInEffect(runId)) {
      const before = this._cursor;
      receipts.push(...this.undo(jobId));
      if (this._cursor === before) { break; } // defensive: never spin
    }
    if (receipts.length) {
      console.log(`[Mysti] canvas-history undoRun run=${runId} ops=${receipts.length}`);
    }
    return receipts;
  }

  // ========================================================================
  // Checkpoints
  // ========================================================================

  /**
   * Take a named restore point over pages + theme + format. Assets are
   * deliberately excluded: they are content-addressed and additive, so a
   * restore never deletes generated media.
   */
  checkpoint(label: string): VersionRef {
    this._ingest();
    const ref: VersionRef = {
      id: crypto.randomUUID(),
      label,
      ts: Date.now(),
      artifactVersion: this._artifact.version,
    };
    this._snapshots.set(ref.id, {
      pages: this._clone(this._artifact.pages),
      theme: this._clone(this._artifact.theme),
      format: this._clone(this._artifact.format),
    });
    this._versions.push(ref);
    this._versionViews.push(this._makeVersionView(ref));
    return ref;
  }

  /** Checkpoints taken in this session, oldest first. */
  versions(): VersionRef[] {
    return [...this._versions];
  }

  /**
   * The same checkpoints, plus the page count and the thumbnail document the
   * version timeline draws. Built once per checkpoint, so calling this on every
   * status push costs an array copy rather than a deep clone per version.
   */
  versionViews(): CanvasVersionView[] {
    return [...this._versionViews];
  }

  /** Look a checkpoint up by id — what `canvas/restore`'s `ref` string carries. */
  versionById(id: string): VersionRef | null {
    return this._versions.find(v => v.id === id) ?? null;
  }

  /**
   * Roll the artifact back to a checkpoint **by emitting ops** through the
   * executor, so the restore lands in the same op log, re-renders through the
   * same job events, and is itself one undoable transaction.
   */
  restore(
    target: VersionRef | string,
    opts: { author?: 'user' | 'agent'; runId?: string; jobId?: string } = {},
  ): void {
    // `canvas/restore` carries `ref: string` on the wire, so the id form is the
    // one the UI actually uses; the object form is kept for in-process callers.
    const ref = typeof target === 'string' ? this.versionById(target) : target;
    if (!ref) {
      console.log(`[Mysti] canvas-history restore: unknown version ${String(target)}`);
      return;
    }
    const snap = this._snapshots.get(ref.id);
    if (!snap) {
      console.log(`[Mysti] canvas-history restore: unknown version ${ref.id}`);
      return;
    }
    const author = opts.author ?? 'user';
    const runId = opts.runId ?? `restore-${ref.id}`;
    const txnId = this.beginTxn({ runId, author, label: `Restore "${ref.label}"` });
    const jobId = opts.jobId ?? this._jobId ?? `history-${txnId}`;
    try {
      const snapIds = new Set(snap.pages.map(p => p.id));
      // 1. Pages created after the checkpoint go away.
      for (const page of [...this._artifact.pages]) {
        if (!snapIds.has(page.id)) {
          this._submit({ kind: 'delete_page', runId, author, targetPageId: page.id, proposedValue: {} }, jobId);
        }
      }
      // 2. Pages that existed are re-created (deleted since) or patched back.
      for (let i = 0; i < snap.pages.length; i++) {
        const want = snap.pages[i];
        const have = this._artifact.pages.find(p => p.id === want.id);
        if (!have) {
          this._submit(
            {
              kind: 'insert_page',
              runId,
              author,
              proposedValue: { ...this._clone(want), index: i },
            },
            jobId,
          );
          continue;
        }
        const patch = this._pagePatch(have, want);
        if (patch) {
          this._submit({ kind: 'edit_page', runId, author, targetPageId: want.id, proposedValue: patch }, jobId);
        }
      }
      // 3. Order.
      const order = snap.pages.map(p => p.id);
      if (this._artifact.pages.map(p => p.id).join(' ') !== order.join(' ')) {
        this._submit({ kind: 'reorder', runId, author, proposedValue: order }, jobId);
      }
      // 4. Artifact-scope state.
      if (!this._sameJson(this._artifact.theme, snap.theme)) {
        this._submit({ kind: 'set_theme', runId, author, proposedValue: this._clone(snap.theme) }, jobId);
      }
      if (!this._sameJson(this._artifact.format, snap.format)) {
        this._submit({ kind: 'set_format', runId, author, proposedValue: this._clone(snap.format) }, jobId);
      }
    } finally {
      this.endTxn();
    }
    console.log(`[Mysti] canvas-history restore version=${ref.id} label=${ref.label} txn=${txnId}`);
  }

  // ========================================================================
  // Introspection (timeline UI, tests)
  // ========================================================================

  /** Transactions oldest-first; `[0, position())` are currently in effect. */
  transactions(): ReadonlyArray<CanvasTxn> {
    this._ingest();
    return this._txns.map(t => ({ ...t, opIds: [...t.opIds] }));
  }

  /** The cursor position — how many transactions are currently in effect. */
  position(): number {
    this._ingest();
    return this._cursor;
  }

  /**
   * Everything the canvas chrome needs to render undo/redo and the version
   * timeline, in ONE snapshot the host pushes to the webview.
   *
   * The webview deliberately derives nothing: it cannot see the op log, and
   * ops arrive from transports it never observes (an MCP `tools/call` from a
   * CLI backend, a `<canvas:NONCE>` directive, a detached background job). A
   * client-side mirror of the cursor would therefore be wrong — and wrong in
   * the direction that matters, since a stale "nothing to undo" is exactly the
   * state a user reaches for Cmd+Z in.
   */
  status(): CanvasHistoryStatus {
    this._ingest();
    const transactions = this._txns.map((txn, i) => this._txnView(txn, i));
    return {
      canUndo: this._cursor > 0,
      canRedo: this._cursor < this._txns.length,
      position: this._cursor,
      undo: this._cursor > 0 ? transactions[this._cursor - 1] : undefined,
      redo: this._cursor < transactions.length ? transactions[this._cursor] : undefined,
      transactions,
      versions: this.versionViews(),
    };
  }

  // ========================================================================
  // Revert / re-apply — the ONE seam Plan 20 Phase 2 re-points
  // ========================================================================

  /**
   * Undo a single op. Today this replays the op's recorded `previousValue`
   * through the executor; Phase 2 replaces `previousValue` with a computed
   * `inverse` from `DocPatch`, and only this method changes.
   */
  private _revertOp(op: CanvasOp, jobId: string | undefined): string | undefined {
    // An insert re-creates its page on redo. Pin the canonical id + current
    // index into the proposal before the page is deleted, so the redo restores
    // the same page identity (and therefore keeps later ops in the same
    // transaction addressable) instead of minting a fresh uuid.
    if (op.kind === 'insert_page' && op.targetPageId) {
      const index = this._artifact.pages.findIndex(p => p.id === op.targetPageId);
      const proposal = (op.proposedValue ?? {}) as Record<string, unknown>;
      op.proposedValue = {
        ...proposal,
        id: op.targetPageId,
        index: index >= 0 ? index : proposal.index,
      };
    }
    return this._executor.revertApplied(this._artifact, op, jobId);
  }

  /** Re-apply an op this cursor previously reverted. */
  private _reapplyOp(op: CanvasOp, jobId: string | undefined): string | undefined {
    return this._executor.reapplyUndone(this._artifact, op, jobId);
  }

  // ========================================================================
  // Op-log ingestion + transaction grouping
  // ========================================================================

  /**
   * Fold newly-applied op-log entries into transactions. Idempotent, and cheap:
   * the scan starts at the earliest entry that could still change state.
   */
  private _ingest(): void {
    const log = this._artifact.opLog;
    let low = -1;
    for (let i = this._scanFrom; i < log.length; i++) {
      const op = log[i];
      if (this._seen.has(op.opId)) { continue; }
      if (op.status === 'applied') {
        this._seen.add(op.opId);
        this._opById.set(op.opId, op);
        this._record(op);
        continue;
      }
      if (op.status === 'pending' || op.status === 'stale') {
        // Not history yet — it may still be accepted. Re-examined next scan.
        if (low < 0) { low = i; }
        continue;
      }
      this._seen.add(op.opId); // rejected / superseded — never enters history
    }
    this._scanFrom = low >= 0 ? low : log.length;
  }

  private _record(op: CanvasOp): void {
    // A new op while the cursor is rewound truncates the redo tail.
    if (this._cursor < this._txns.length) { this._truncate(); }
    this._targetTxn(op).opIds.push(op.opId);
  }

  private _targetTxn(op: CanvasOp): CanvasTxn {
    if (this._open) {
      if (!this._open.opIds.length) { this._push(this._open); }
      return this._open;
    }
    // Implicit grouping: consecutive ops from the same author sharing a real
    // runId are one agent turn / one gesture. Ops with no runId each get their
    // own step, so an unlabelled human edit is individually undoable.
    const last = this._txns[this._txns.length - 1];
    if (last && !last.explicit && last.author === op.author && !!op.runId && last.runId === op.runId) {
      return last;
    }
    const txn: CanvasTxn = {
      txnId: crypto.randomUUID(),
      runId: op.runId || undefined,
      author: op.author,
      opIds: [],
      ts: op.ts,
      explicit: false,
    };
    this._push(txn);
    return txn;
  }

  private _push(txn: CanvasTxn): void {
    this._txns.push(txn);
    this._cursor = this._txns.length;
  }

  /**
   * Drop the redo tail. The op log keeps the audit record; the status moves to
   * `superseded` — the op is no longer in effect and can never be redone —
   * rather than `rejected`, which means a human refused it. (Plan 20 Phase 2's
   * `CanvasOpRecord` gains a dedicated `undone` status for this.)
   *
   * Routed through the executor rather than written onto the op-log entry:
   * the executor holds a SECOND record of the same op (its journal, which is
   * what `since[]` and the `canvas/ops` delta read), and mutating one of the
   * two is how discarded ops kept being advertised to the next agent write.
   */
  private _truncate(): void {
    const dropped = this._txns.splice(this._cursor);
    for (const txn of dropped) {
      for (const opId of txn.opIds) {
        this._executor.markSuperseded(this._artifact, opId);
      }
    }
  }

  private _runIsInEffect(runId: string): boolean {
    for (let i = 0; i < this._cursor; i++) {
      const txn = this._txns[i];
      if (txn.runId === runId) { return true; }
      for (const opId of txn.opIds) {
        if (this._opById.get(opId)?.runId === runId) { return true; }
      }
    }
    return false;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private _submit(
    submission: { kind: CanvasOp['kind']; runId: string; author: 'user' | 'agent'; targetPageId?: string; proposedValue: unknown },
    jobId: string,
  ): void {
    const op = this._executor.submit(this._artifact, submission, jobId, 'auto');
    if (!op) {
      console.log(`[Mysti] canvas-history restore op rejected: ${this._executor.lastSubmitError() ?? 'unknown'}`);
    }
  }

  /** Content keys where `have` differs from `want`, as an `edit_page` patch. */
  private _pagePatch(have: ArtifactPage, want: ArtifactPage): Partial<ArtifactPage> | null {
    const from = have as unknown as Record<string, unknown>;
    const to = want as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
    const patch: Record<string, unknown> = {};
    let dirty = false;
    for (const key of keys) {
      if (PAGE_IDENTITY_KEYS.has(key)) { continue; }
      if (this._sameJson(from[key], to[key])) { continue; }
      patch[key] = this._clone(to[key]);
      dirty = true;
    }
    return dirty ? (patch as Partial<ArtifactPage>) : null;
  }

  private _txnView(txn: CanvasTxn, index: number): CanvasHistoryTxnView {
    const kinds: CanvasOpKind[] = [];
    for (const opId of txn.opIds) {
      const kind = this._opById.get(opId)?.kind;
      if (kind && !kinds.includes(kind)) { kinds.push(kind); }
    }
    return {
      txnId: txn.txnId,
      runId: txn.runId,
      author: txn.author,
      label: txn.label,
      kinds,
      opCount: txn.opIds.length,
      ts: txn.ts,
      inEffect: index < this._cursor,
    };
  }

  /**
   * Build a version's timeline view once, at checkpoint time.
   *
   * The thumbnail doc is CLONED rather than aliased into the snapshot: the view
   * crosses a wire and lands in a webview cache, and a consumer that mutated a
   * shared tree would silently corrupt the restore this checkpoint exists to
   * perform.
   */
  private _makeVersionView(ref: VersionRef): CanvasVersionView {
    const snap = this._snapshots.get(ref.id);
    const first = snap?.pages[0];
    return {
      ...ref,
      pageCount: snap?.pages.length ?? 0,
      thumbDoc: first ? this._clone(first.doc) : undefined,
      thumbFormat: first ? this._clone(first.format ?? snap?.format) : undefined,
    };
  }

  private _receipt(op: CanvasOp, status: CanvasOpReceiptLike['status'], pageId?: string): CanvasOpReceiptLike {
    const page = pageId ? this._artifact.pages.find(p => p.id === pageId) : undefined;
    return {
      opId: op.opId,
      status,
      pageId,
      pageVersion: page?.version,
      artifactVersion: this._artifact.version,
    };
  }

  private _sameJson(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }

  private _clone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  }
}
