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
import type { ArtifactStore, PageInit } from './ArtifactStore';
import type { CanvasJobRouter } from './CanvasJobRouter';
import {
  ARTIFACT_SCOPED_OPS,
  ELEMENT_SCOPED_OPS,
  isCanvasOpShape,
  opCells,
  opMid,
  opPageId,
  type CanvasOp as CanvasOpV2,
  type CanvasOpKindV2,
  type CanvasOpRecordV2,
  type CanvasOpReceiptV2,
  type CanvasOpStatus as CanvasOpStatusV2,
} from '../canvas/CanvasOps';
import {
  applyOp,
  isDocScopedOp,
  isStaleDocPatchError,
} from '../canvas/doc/DocPatch';
import {
  cloneNode,
  findNode,
  isPinned,
  pinnedCells,
  putOwn,
  walk,
  type DocNode,
  type Mid,
  type PinCell,
  type PinRecord,
} from '../canvas/doc/DocNode';
import { withFreshMids } from '../canvas/doc/PageCompiler';
import { boardPosForIndex, migratePage, refreshJsxCache } from '../canvas/pageMigration';
import type {
  CanvasArtifact,
  ArtifactPage,
  CanvasOp,
  CanvasOpKind,
  CanvasAssetRecord,
  DesignTheme,
  CanvasFormatSpec,
} from '../types';

/** How a submitted op is resolved against the artifact. */
export type CanvasApprovalMode = 'staged' | 'auto';

/** A request to mutate an artifact (from a tool call, fenced op, or the UI). */
export interface OpSubmission {
  kind: CanvasOpKind;
  /** Chat turn / job id that authored this op. */
  runId: string;
  targetPageId?: string;
  /** Page version the author read before proposing (stale detection). */
  baseVersion?: number;
  proposedValue: unknown;
  author?: 'agent' | 'user';
  /** Pin cells the author explicitly overrides (Plan 22 §3.5 rule 3). */
  force?: PinCell[];
}

/** A request to mutate an artifact through the Plan 22 §3.2 op algebra. */
export interface OpSubmissionV2 {
  op: CanvasOpV2;
  /** Chat turn / job id that authored this op. */
  runId: string;
  /** One human drag = 1 txn; one agent turn = 1 txn. Defaults to `runId`. */
  txnId?: string;
  /**
   * STAMPED HOST-SIDE by the transport from the channel the op arrived on —
   * never read out of a model- or webview-authored payload.
   */
  author?: 'user' | 'agent';
  actorId?: string;
  /** Page version (page ops) or artifact version (artifact ops) the author read. */
  baseVersion?: number;
  /** Pin cells the author explicitly overrides. */
  force?: PinCell[];
}

/** Sentinel subtree lock covering an entire page (the old page-level lock). */
export const WHOLE_PAGE_LOCK = '*';

/**
 * One committed op, plus the two things a receipt needs that the wire record
 * deliberately does not carry.
 *
 * `committed*Version` is what {@link CanvasOpExecutor.submitOp}'s `since[]`
 * slices on: without it "what did I miss since version N" degenerates into
 * counting version bumps and silently mis-reports the moment anything mutates
 * a page outside the op path.
 *
 * `restore` exists for exactly one op — `asset.add`, which the algebra has no
 * inverse for (there is no `asset.remove`) — and for restoring a *legacy* page
 * whose uncompilable source `NewPageSpec` cannot express. Every other op is
 * undone by a real {@link CanvasOpV2}, which is the whole point of `inverse`.
 */
interface CanvasJournalEntry extends CanvasOpRecordV2 {
  committedArtifactVersion: number;
  committedPageVersion?: number;
  restore?: { assetId?: string; page?: ArtifactPage; index?: number };
}

/**
 * The pin ownership one op took, and what the cells carried before it.
 *
 * §3.5 rule 1 stamps a pin on every cell a HUMAN op wrote — but the pin is
 * ownership of that EDIT, so it has to die with it. Undoing the edit and
 * leaving the pin behind locks the agent out of a cell whose human value no
 * longer exists, with no op in the algebra able to clear it. `before` is what
 * makes the release exact when a human edited the same cell twice: undoing the
 * second edit hands the cell back to the first, not to nobody.
 */
interface PinWrite {
  pageId: string;
  mid: Mid;
  cells: PinCell[];
  before: Record<PinCell, PinRecord | undefined>;
}

/** How many missed ops a receipt will carry before it stops being a help. */
const MAX_SINCE_RECORDS = 50;
/** Journal entries retained per artifact (bounds a long design session). */
const MAX_JOURNAL_ENTRIES = 2000;

/**
 * The single executor every transport (MCP tools, fenced `canvas-op` fallback,
 * prompt-bar commands, the canvas webview) routes through.
 *
 * Plan 22 §3.2 rebuilt the internals on the document model while keeping the
 * shape:
 *
 * 1. **Document mutations go through `DocPatch.applyOp`** — a pure function
 *    returning the new tree plus the op that exactly undoes it, so undo is a
 *    ~200-byte record instead of a deep clone of the whole page source.
 * 2. **Staleness is scope-correct.** Page ops check `page.version`;
 *    artifact-scoped ops check `artifact.version` — the field `_touch` has
 *    always maintained and nothing read.
 * 3. **A stale element op rebases.** If the target `mid` still exists, the op
 *    is re-applied against the current document and the receipt says
 *    `rebased: true`. Only a vanished mid is `stale`.
 * 4. **Pins.** Any committed op authored by a human writes a `PinRecord` on the
 *    cells it touched; an unforced agent write to a pinned cell is refused with
 *    `pinned: [cell]` rather than silently reverting a person's work.
 * 5. **Subtree locks.** `_lockedSubtrees: Map<pageId, Set<Mid>>` — an agent op
 *    inside the subtree a human is editing parks as a staged suggestion, while
 *    ops elsewhere on the same page apply immediately. Page-level locking could
 *    never be this permissive; mid addressing is what buys it.
 * 6. **`since[]`.** Every receipt carries the committed ops the writer has not
 *    seen, so a chain of edits needs ONE read instead of a read between writes.
 *
 * Canvas ops deliberately bypass the SafetyClassifier — they only ever touch
 * `.mysti/canvas/`, never the workspace or a shell.
 */
export class CanvasOpExecutor {
  private _store: ArtifactStore;
  private _router: CanvasJobRouter;
  /**
   * Subtrees currently locked by an in-progress inline edit, per page.
   * {@link WHOLE_PAGE_LOCK} means the whole artboard.
   */
  private _lockedSubtrees = new Map<string, Set<Mid>>();
  /** Auto-mode ops queued behind a lock, replayed on unlock. */
  private _queuedByPage = new Map<string, string[]>();
  /** Reason the most recent submit() was rejected by validation (else null). */
  private _lastSubmitError: string | null = null;
  /** Receipt for the most recent submit()/submitOp() call. */
  private _lastReceipt: CanvasOpReceiptV2 | null = null;
  /** Committed ops per artifact id — the source of `since[]`. */
  private _journal = new Map<string, CanvasJournalEntry[]>();
  /** Pin ownership taken per op id, so undoing the op releases exactly it. */
  private _pinWrites = new Map<string, PinWrite>();

  constructor(store: ArtifactStore, router: CanvasJobRouter) {
    this._store = store;
    this._router = router;
  }

  /**
   * The validation reason the most recent {@link submit} call rejected with, or
   * null when it did not reject. Read synchronously right after submit() so the
   * tool layer can surface the specific message to the agent (the same reason is
   * also emitted as an `op_error` event to the webview).
   */
  lastSubmitError(): string | null {
    return this._lastSubmitError;
  }

  /**
   * The full receipt for the most recent submission on ANY surface.
   *
   * `submit()` keeps its legacy `CanvasOp | null` return so no transport had to
   * change in this phase; the parts of the Plan 22 receipt that legacy shape
   * cannot express (`since`, `pinned`, `rebased`, `newMids`) are read here.
   */
  lastReceipt(): CanvasOpReceiptV2 | null {
    return this._lastReceipt;
  }

  /** Committed ops for an artifact, oldest first. */
  journal(artifactId: string): CanvasOpRecordV2[] {
    return (this._journal.get(artifactId) ?? []).map(publicRecord);
  }

  // ========================================================================
  // Submission — Plan 22 §3.2 op algebra
  // ========================================================================

  /**
   * Validate and stage (or, in `auto` mode, apply) one {@link CanvasOpV2}.
   *
   * Always returns a receipt: a refusal is data the writer can act on, never a
   * `null` it has to guess about.
   */
  submitOp(
    artifact: CanvasArtifact,
    submission: OpSubmissionV2,
    jobId: string,
    mode: CanvasApprovalMode = 'staged',
  ): CanvasOpReceiptV2 {
    const author = submission.author ?? 'agent';
    const record: CanvasJournalEntry = {
      opId: crypto.randomUUID(),
      txnId: submission.txnId ?? submission.runId,
      runId: submission.runId,
      author,
      actorId: submission.actorId ?? author,
      op: submission.op,
      baseVersion: submission.baseVersion,
      status: 'staged',
      ts: Date.now(),
      committedArtifactVersion: artifact.version,
    };

    this._lastSubmitError = null;

    const invalid = this._validateV2(artifact, submission.op);
    if (invalid) {
      this._lastSubmitError = invalid;
      record.status = 'rejected';
      this._journalPush(artifact, record);
      this._emitLegacy(jobId, 'op_error', record, invalid);
      return this._receipt(artifact, record, { error: invalid });
    }

    const pageId = opPageId(submission.op);
    const page = pageId ? this._store.getPage(artifact, pageId) : undefined;

    // ── pins: a human owns these cells (§3.5) ────────────────────────────
    if (author === 'agent' && page) {
      const refused = pinnedConflicts(page, submission.op, submission.force);
      if (refused.length > 0) {
        record.status = 'rejected';
        this._lastSubmitError = `refused: ${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} user-set`;
        this._journalPush(artifact, record);
        this._emitLegacy(jobId, 'op_error', record, this._lastSubmitError);
        return this._receipt(artifact, record, { pinned: refused, error: this._lastSubmitError });
      }
    }

    // Plan 27 lane J, finding J-1: `pinnedConflicts` addresses one element, so
    // `page.remove` (MCP `remove_page`) walked past it and deleted every human
    // pin on the artboard. Same rule as the legacy `delete_page` in `submit`.
    if (author === 'agent' && page && submission.op.op === 'page.remove') {
      const refused = pinnedAddresses(page);
      if (refused.length > 0) {
        record.status = 'rejected';
        this._lastSubmitError = pageRemovalRefusal(refused);
        this._journalPush(artifact, record);
        this._emitLegacy(jobId, 'op_error', record, this._lastSubmitError);
        return this._receipt(artifact, record, { pinned: refused, error: this._lastSubmitError });
      }
    }

    // ── staleness / rebase (§3.5 conflict ladder) ───────────────────────
    const conflict = this._classify(artifact, submission.op, submission.baseVersion);
    if (conflict === 'stale') {
      record.status = 'stale';
      this._journalPush(artifact, record);
      this._emitLegacy(jobId, 'op_staged', record);
      return this._receipt(artifact, record, {});
    }

    // ── subtree locks: park, do not clobber a live inline edit ──────────
    if (page && this._isParked(page, submission.op)) {
      record.status = 'staged';
      this._journalPush(artifact, record);
      this._emitLegacy(jobId, 'op_staged', record);
      if (mode === 'auto') {
        const q = this._queuedByPage.get(page.id) ?? [];
        q.push(record.opId);
        this._queuedByPage.set(page.id, q);
      }
      return this._receipt(artifact, record, { rebased: conflict === 'rebase' || undefined });
    }

    if (mode !== 'auto') {
      record.status = 'staged';
      this._journalPush(artifact, record);
      this._emitLegacy(jobId, 'op_staged', record);
      return this._receipt(artifact, record, { rebased: conflict === 'rebase' || undefined });
    }

    return this._commitV2(artifact, record, jobId, conflict === 'rebase');
  }

  /**
   * Refuse a previously staged V2 op (the human rejected the suggestion).
   *
   * {@link rejectOp} cannot do this: it looks the op up in `artifact.opLog`,
   * which V2 submissions never enter until they COMMIT (see
   * {@link _mirrorToOpLog}) — so without this a `canvas/decide` reject silently
   * did nothing and the suggestion card came back on the next `canvas/staged`.
   */
  rejectStagedOp(artifact: CanvasArtifact, opId: string, jobId: string): CanvasOpReceiptV2 | undefined {
    const record = (this._journal.get(artifact.id) ?? []).find(e => e.opId === opId);
    if (!record) { return undefined; }
    if (record.status !== 'staged' && record.status !== 'stale') { return this._receipt(artifact, record, {}); }
    record.status = 'rejected';
    this._journalPush(artifact, record);
    this._emitLegacy(jobId, 'op_rejected', record);
    return this._receipt(artifact, record, {});
  }

  /** Apply a previously staged V2 op (a human accepted it, or a lock lifted). */
  applyStagedOp(artifact: CanvasArtifact, opId: string, jobId: string): CanvasOpReceiptV2 | undefined {
    const record = (this._journal.get(artifact.id) ?? []).find(e => e.opId === opId);
    if (!record) { return undefined; }
    if (record.status !== 'staged' && record.status !== 'stale') { return this._receipt(artifact, record, {}); }
    const conflict = this._classify(artifact, record.op, record.baseVersion);
    if (conflict === 'stale') {
      record.status = 'stale';
      this._emitLegacy(jobId, 'op_staged', record);
      return this._receipt(artifact, record, {});
    }
    return this._commitV2(artifact, record, jobId, conflict === 'rebase');
  }

  // ========================================================================
  // Submission — legacy kind-based surface (still every shipped transport)
  // ========================================================================

  /**
   * Validate and stage (or, in `auto` mode, apply) a legacy kind-based op.
   *
   * Kept verbatim in signature and semantics; the internals now share the
   * document model, the journal, the pin/lock rules and the conflict ladder
   * with {@link submitOp}, so which transport wrote an op never changes how it
   * is resolved. Returns the resulting op, or null when the op is structurally
   * invalid (an `op_error` event is emitted in that case).
   */
  submit(
    artifact: CanvasArtifact,
    submission: OpSubmission,
    jobId: string,
    mode: CanvasApprovalMode = 'staged',
  ): CanvasOp | null {
    const op: CanvasOp = {
      opId: crypto.randomUUID(),
      runId: submission.runId,
      kind: submission.kind,
      targetPageId: submission.targetPageId,
      baseVersion: submission.baseVersion,
      proposedValue: submission.proposedValue,
      status: 'pending',
      author: submission.author ?? 'agent',
      ts: Date.now(),
    };

    this._lastSubmitError = null;
    this._lastReceipt = null;
    const invalid = this._validate(artifact, op);
    if (invalid) {
      this._lastSubmitError = invalid;
      op.status = 'rejected';
      this._store.appendOp(artifact, op);
      this._router.emit(jobId, { type: 'op_error', op, error: invalid });
      this._lastReceipt = this._legacyReceipt(artifact, op, { error: invalid });
      return null;
    }

    const page = op.targetPageId ? this._store.getPage(artifact, op.targetPageId) : undefined;

    // Pin enforcement for the one legacy kind that addresses an element.
    if (op.author === 'agent' && page && op.kind === 'edit_element') {
      const v2 = this._elementOpFor(op);
      const refused = v2 ? pinnedConflicts(page, v2, submission.force) : [];
      if (refused.length > 0) {
        this._lastSubmitError = `refused: ${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} user-set`;
        op.status = 'rejected';
        this._store.appendOp(artifact, op);
        this._router.emit(jobId, { type: 'op_error', op, error: this._lastSubmitError });
        this._lastReceipt = this._legacyReceipt(artifact, op, { pinned: refused, error: this._lastSubmitError });
        return null;
      }
    }

    // Pin enforcement for the legacy kind that rewrites a WHOLE artboard.
    //
    // Plan 27 lane E, finding E-1. `edit_page` with a content patch hands
    // `ArtifactStore.updatePage` a fresh document and `page.doc` is replaced
    // wholesale, so every human pin — and the hand edit each pin records —
    // died silently: `ok: true`, no `pinned`, no `dropped`, and the model
    // reported success. `write_page` has always refused exactly this
    // (`pinsAcrossReplace` in CanvasToolDispatch), and the two write
    // vocabularies must agree, because `edit_page` is the one the fenced
    // `canvas-op` lane TEACHES 13 of the 14 CLI backends.
    //
    // The check lives HERE rather than in the dispatcher because this is the
    // chokepoint both transports pass through — the MCP tool call and the
    // fenced op. `submission.force` is deliberately NOT consulted: a bare cell
    // name on a whole-artboard rewrite means "every element on this artboard",
    // which is the reason `writePage` demands `<mid>:<cell>` scoping, and no
    // caller passes `force` on an `edit_page` at all.
    if (op.author === 'agent' && page && op.kind === 'edit_page') {
      const refused = pinsDestroyedByPagePatch(page, op.proposedValue);
      if (refused.length > 0) {
        this._lastSubmitError = `refused: this patch would replace the whole artboard and destroy `
          + `${refused.length} cell(s) the human owns (${refused.join(', ')}). ${PIN_REFUSAL_REMEDY} `
          + 'Over MCP, write_page also works: it diffs your source against the current document and preserves them.';
        op.status = 'rejected';
        this._store.appendOp(artifact, op);
        this._router.emit(jobId, { type: 'op_error', op, error: this._lastSubmitError });
        this._lastReceipt = this._legacyReceipt(artifact, op, { pinned: refused, error: this._lastSubmitError });
        return null;
      }
    }

    // Plan 27 lane J, finding J-1: the destruction the gate above refuses was
    // one ungated op away — `delete_page` took every human pin on the artboard
    // with it, `ok: true`. Same gate, same shape; the V2 twin (`page.remove`,
    // MCP `remove_page`) is gated in `submitOp`, so the vocabularies agree.
    if (op.author === 'agent' && page && op.kind === 'delete_page') {
      const refused = pinnedAddresses(page);
      if (refused.length > 0) {
        this._lastSubmitError = pageRemovalRefusal(refused);
        op.status = 'rejected';
        this._store.appendOp(artifact, op);
        this._router.emit(jobId, { type: 'op_error', op, error: this._lastSubmitError });
        this._lastReceipt = this._legacyReceipt(artifact, op, { pinned: refused, error: this._lastSubmitError });
        return null;
      }
    }

    // Base-version mismatch → stale; surfaced for "re-read & retry", never
    // applied — UNLESS the target element survived, in which case it rebases.
    const conflict = this._classifyLegacy(artifact, op);
    if (conflict === 'stale') {
      op.status = 'stale';
      this._store.appendOp(artifact, op);
      this._router.emit(jobId, { type: 'op_staged', op });
      this._lastReceipt = this._legacyReceipt(artifact, op, {});
      return op;
    }

    this._store.appendOp(artifact, op);

    // A locked subtree parks even auto-mode ops until the user blurs the edit.
    if (page && this._isParkedLegacy(page, op)) {
      this._router.emit(jobId, { type: 'op_staged', op });
      if (mode === 'auto') {
        const q = this._queuedByPage.get(page.id) ?? [];
        q.push(op.opId);
        this._queuedByPage.set(page.id, q);
      }
      this._lastReceipt = this._legacyReceipt(artifact, op, { rebased: conflict === 'rebase' || undefined });
      return op;
    }

    if (mode === 'auto') {
      const applied = this.applyOp(artifact, op.opId, jobId) ?? op;
      return applied;
    }
    this._router.emit(jobId, { type: 'op_staged', op });
    this._lastReceipt = this._legacyReceipt(artifact, op, { rebased: conflict === 'rebase' || undefined });
    return op;
  }

  // ========================================================================
  // Decisions
  // ========================================================================

  /** Apply a pending/stale op (user accepted, or auto mode). */
  applyOp(artifact: CanvasArtifact, opId: string, jobId: string): CanvasOp | undefined {
    const op = this._store.findOp(artifact, opId);
    if (!op) { return undefined; }
    if (op.status !== 'pending' && op.status !== 'stale') { return op; }

    // Re-check staleness at apply time — the page may have moved since staging.
    const conflict = this._classifyLegacy(artifact, op);
    if (conflict === 'stale') {
      op.status = 'stale';
      this._router.emit(jobId, { type: 'op_staged', op });
      this._lastReceipt = this._legacyReceipt(artifact, op, {});
      return op;
    }

    let affectedPageId: string | undefined;
    try {
      affectedPageId = this._apply(artifact, op);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      op.status = 'rejected';
      this._lastSubmitError = detail;
      this._router.emit(jobId, { type: 'op_error', op, error: detail });
      this._lastReceipt = this._legacyReceipt(artifact, op, { error: detail });
      return op;
    }
    op.status = 'applied';

    // Supersede other still-pending ops that target the same page.
    if (affectedPageId) {
      for (const other of artifact.opLog) {
        if (other.opId !== op.opId && other.status === 'pending' && other.targetPageId === affectedPageId) {
          other.status = 'superseded';
          this._router.emit(jobId, { type: 'op_staged', op: other });
        }
      }
    }

    if (op.author === 'agent') {
      console.log(`[Mysti] canvas-op applied: ${op.kind} page=${op.targetPageId ?? '-'} run=${op.runId}`);
    }
    this._router.emit(jobId, { type: 'op_applied', op });
    if (affectedPageId) {
      this._router.emit(jobId, { type: 'page_updated', pageId: affectedPageId });
    }
    this._lastReceipt = this._legacyReceipt(artifact, op, { rebased: conflict === 'rebase' || undefined });
    this._journalLegacy(artifact, op);
    return op;
  }

  /**
   * Retire an applied op that is no longer in effect and can never be redone
   * — the redo tail `CanvasHistory._truncate` drops.
   *
   * Both records move, and that is the whole point: the executor journal and
   * `artifact.opLog` are two objects describing one op, so flipping only the
   * op-log mirror (as the history used to) left the journal saying `applied`.
   * `since[]` then kept advertising discarded ops to the next agent write, and
   * `CanvasBridge.pushOps` — which diffs the journal — never told the view.
   */
  markSuperseded(artifact: CanvasArtifact, opId: string): void {
    const entry = (this._journal.get(artifact.id) ?? []).find(e => e.opId === opId);
    if (entry && entry.status === 'applied') { entry.status = 'superseded'; }
    const mirror = this._store.findOp(artifact, opId);
    if (mirror && mirror.status === 'applied') { mirror.status = 'superseded'; }
  }

  /** Reject a pending/stale op. */
  rejectOp(artifact: CanvasArtifact, opId: string, jobId: string): CanvasOp | undefined {
    const op = this._store.findOp(artifact, opId);
    if (!op) { return undefined; }
    if (op.status === 'pending' || op.status === 'stale') {
      op.status = 'rejected';
      this._router.emit(jobId, { type: 'op_rejected', op });
    }
    return op;
  }

  /**
   * Undo the most recently applied op (regardless of author), restoring its
   * `inverse` (or, for the ops the algebra cannot invert, its
   * `previousValue`). The op's status flips to `rejected` (= no longer applied)
   * so a subsequent undo targets the next applied op. Returns the undone op.
   */
  undoLastApplied(artifact: CanvasArtifact, jobId: string): CanvasOp | undefined {
    for (let i = artifact.opLog.length - 1; i >= 0; i--) {
      const op = artifact.opLog[i];
      if (op.status === 'applied') {
        const revertedPageId = this._revert(artifact, op);
        const pinnedPageId = this._clearPins(artifact, op.opId);
        const affectedPageId = revertedPageId ?? pinnedPageId;
        op.status = 'rejected';
        this._router.emit(jobId, { type: 'op_rejected', op });
        if (affectedPageId) {
          this._router.emit(jobId, { type: 'page_updated', pageId: affectedPageId });
        }
        return op;
      }
    }
    return undefined;
  }

  // ========================================================================
  // History cursor primitives (Plan 20 §3.2)
  //
  // `CanvasHistory` owns undone-ness as a *cursor position*, so these two
  // deliberately do NOT touch `op.status`: an `undone` op was applied and can
  // be redone, while a `rejected` op was refused by a human. Both emit only
  // `page_updated` — there is no honest job-event type for "reverted", and the
  // renderer only needs to know which page to re-draw.
  // ========================================================================

  /**
   * Revert an applied op for the history cursor. Returns the affected page id
   * (if any). Unlike {@link undoLastApplied} this leaves the op log's status
   * alone.
   */
  revertApplied(artifact: CanvasArtifact, op: CanvasOp, jobId?: string): string | undefined {
    const affectedPageId = this._revert(artifact, op);
    // A pin is ownership of ONE edit (§3.5 rule 1). Reverting the edit without
    // releasing the cells it claimed leaves the agent refused on a value the
    // user no longer has — and nothing in the algebra can clear a pin.
    const pinnedPageId = this._clearPins(artifact, op.opId);
    const pageId = affectedPageId ?? pinnedPageId;
    if (jobId && pageId) {
      this._router.emit(jobId, { type: 'page_updated', pageId });
    }
    return pageId;
  }

  /**
   * Re-apply an op the history cursor previously reverted, re-capturing its
   * inverse against the reverted state so it stays undoable.
   *
   * Deliberately skips {@link applyOp}'s stale re-check: an undo bumps page
   * versions, so a redo would always look stale against its original
   * `baseVersion` even though it is replaying known-good history.
   */
  reapplyUndone(artifact: CanvasArtifact, op: CanvasOp, jobId?: string): string | undefined {
    // A V2 op reaches the op log through `_mirrorToOpLog`, which stores the
    // whole V2 op as `proposedValue` under a LOSSY legacy `kind`. Routing that
    // back through the legacy `_apply` switch reads the op envelope as a legacy
    // payload — `theme.set` overwrote `artifact.theme` with `{op:'theme.set',
    // theme:{…}}` (persisted by the next save, so every colour read goes
    // undefined and the design renders unstyled), `page.add` came back as a
    // blank artboard under the original id, and the element ops threw. Undo was
    // always correct because `_revert` prefers `record.inverse`; only redo was
    // wrong. Detect the mirrored record and replay it through the V2 path,
    // re-capturing the fresh inverse so the NEXT undo stays exact.
    if (isCanvasOpShape(op.proposedValue)) {
      const v2 = op.proposedValue;
      const out = this._applyV2(artifact, v2);
      op.inverse = out.inverse;
      const affected = out.pageId ?? op.targetPageId;
      // The journal — not the op log — carries the `restore` hint for the two
      // ops `inverse` structurally cannot undo. Re-capturing it here is what
      // keeps the NEXT undo exact across an undo → redo → undo cycle.
      const entry = (this._journal.get(artifact.id) ?? []).find(e => e.opId === op.opId);
      if (entry) { entry.inverse = out.inverse; entry.restore = out.restore; }
      // Redoing a human edit re-takes ownership of the cells it wrote.
      if (op.author === 'user' && out.pageId) { this._writePins(artifact, out.pageId, v2, op.opId); }
      if (jobId && affected) {
        this._router.emit(jobId, { type: 'page_updated', pageId: affected });
      }
      return affected;
    }
    const affectedPageId = this._apply(artifact, op);
    if (jobId && affectedPageId) {
      this._router.emit(jobId, { type: 'page_updated', pageId: affectedPageId });
    }
    return affectedPageId;
  }

  // ========================================================================
  // Subtree edit locks (conflict rules)
  // ========================================================================

  isPageLocked(pageId: string): boolean {
    const locks = this._lockedSubtrees.get(pageId);
    return !!locks && locks.size > 0;
  }

  /** The subtree roots currently locked on a page (`'*'` = the whole page). */
  lockedSubtrees(pageId: string): Mid[] {
    return [...(this._lockedSubtrees.get(pageId) ?? [])];
  }

  /**
   * Toggle a page's whole-artboard edit lock. Unlocking flushes any auto-mode
   * ops that queued behind it (in submission order).
   */
  setPageEditing(artifact: CanvasArtifact, pageId: string, editing: boolean, jobId: string): void {
    this.setSubtreeEditing(artifact, pageId, WHOLE_PAGE_LOCK, editing, jobId);
  }

  /**
   * Toggle the lock on ONE subtree of a page.
   *
   * This is what page-level locking could never be: while a human edits a card,
   * an agent restyling the sidebar of the same artboard is not parked at all.
   */
  setSubtreeEditing(
    artifact: CanvasArtifact,
    pageId: string,
    mid: Mid,
    editing: boolean,
    jobId: string,
  ): void {
    if (editing) {
      const locks = this._lockedSubtrees.get(pageId) ?? new Set<Mid>();
      locks.add(mid);
      this._lockedSubtrees.set(pageId, locks);
      return;
    }
    const locks = this._lockedSubtrees.get(pageId);
    if (locks) {
      locks.delete(mid);
      if (locks.size === 0) { this._lockedSubtrees.delete(pageId); }
    }
    // Ops parked behind a lock only flush once NOTHING on the page is locked —
    // flushing into a still-live edit is the clobber the lock exists to stop.
    if (this.isPageLocked(pageId)) { return; }
    const queued = this._queuedByPage.get(pageId);
    this._queuedByPage.delete(pageId);
    if (!queued) { return; }
    for (const opId of queued) {
      const legacy = this._store.findOp(artifact, opId);
      if (legacy && legacy.status === 'pending') {
        this.applyOp(artifact, opId, jobId);
        continue;
      }
      const entry = (this._journal.get(artifact.id) ?? []).find(e => e.opId === opId);
      if (entry && entry.status === 'staged') {
        this.applyStagedOp(artifact, opId, jobId);
      }
    }
  }

  // ========================================================================
  // Validation
  // ========================================================================

  /** Returns an error string when the op is structurally invalid, else null. */
  private _validate(artifact: CanvasArtifact, op: CanvasOp): string | null {
    const needsExistingPage =
      op.kind === 'edit_page' || op.kind === 'delete_page' || op.kind === 'edit_element';
    if (needsExistingPage) {
      if (!op.targetPageId) { return `${op.kind} requires a targetPageId`; }
      if (!this._store.getPage(artifact, op.targetPageId)) {
        return `page ${op.targetPageId} does not belong to this artifact`;
      }
    }
    switch (op.kind) {
      case 'insert_page': {
        if (!op.proposedValue || typeof op.proposedValue !== 'object') {
          return 'insert_page requires a page object';
        }
        const raw = op.proposedValue as Record<string, unknown>;
        // A page must arrive with SOME content contract: the document-first
        // `doc`, or the legacy `mode` + source the transports still speak.
        if (raw.doc === undefined && raw.legacy === undefined && !raw.mode) {
          return 'insert_page page requires a mode';
        }
        break;
      }
      case 'reorder':
        if (!Array.isArray(op.proposedValue)) { return 'reorder requires an array of page ids'; }
        break;
      case 'edit_element': {
        if (!op.proposedValue || typeof op.proposedValue !== 'object') {
          return 'edit_element requires an object payload';
        }
        const v = op.proposedValue as Record<string, unknown>;
        if (typeof v.mid !== 'string' || !v.mid) {
          return 'edit_element requires a mid (element edits are addressed by mid, not by DOM path)';
        }
        const given = ['text', 'style', 'prop'].filter(k => v[k] !== undefined);
        if (given.length !== 1) {
          return 'edit_element requires exactly one of text, style or prop';
        }
        if (v.style !== undefined && (typeof v.style !== 'object' || v.style === null || Array.isArray(v.style))) {
          return 'edit_element style must be an object of css property → value|null';
        }
        if (v.prop !== undefined) {
          const prop = v.prop as { name?: unknown };
          if (!prop || typeof prop !== 'object' || typeof prop.name !== 'string' || !prop.name) {
            return 'edit_element prop requires { name, value }';
          }
        }
        break;
      }
      case 'set_theme':
      case 'set_format':
      case 'edit_page':
      case 'add_asset':
        if (!op.proposedValue || typeof op.proposedValue !== 'object') {
          return `${op.kind} requires an object payload`;
        }
        break;
    }
    return null;
  }

  /** Returns an error string when a V2 op is structurally invalid, else null. */
  private _validateV2(artifact: CanvasArtifact, op: CanvasOpV2): string | null {
    const pageId = opPageId(op);
    if (pageId !== null) {
      if (!this._store.getPage(artifact, pageId)) {
        return `page ${pageId} does not belong to this artifact`;
      }
    }
    switch (op.op) {
      case 'page.add':
        if (!op.page || typeof op.page !== 'object' || !op.page.doc) {
          return 'page.add requires page.doc';
        }
        break;
      case 'page.reorder':
        if (!Array.isArray(op.orderedIds)) { return 'page.reorder requires orderedIds: string[]'; }
        break;
      case 'page.setMeta':
        if (!op.patch || typeof op.patch !== 'object') { return 'page.setMeta requires a patch object'; }
        break;
      case 'page.move':
        if (!op.boardPos || !Number.isFinite(op.boardPos.x) || !Number.isFinite(op.boardPos.y)) {
          return 'page.move requires a finite boardPos';
        }
        break;
      case 'page.setDoc':
        if (!op.doc || typeof op.doc !== 'object') { return 'page.setDoc requires a doc'; }
        break;
      case 'theme.set':
        if (!op.theme || typeof op.theme !== 'object') { return 'theme.set requires a theme object'; }
        break;
      case 'theme.setToken':
        if (typeof op.path !== 'string' || !op.path) { return 'theme.setToken requires a path'; }
        if (!isSafeTokenPath(op.path)) { return `theme.setToken path is not addressable: ${op.path}`; }
        if (typeof op.value !== 'string') { return 'theme.setToken requires a string value'; }
        break;
      case 'artifact.setFormat':
        if (!op.format || typeof op.format !== 'object') { return 'artifact.setFormat requires a format'; }
        break;
      case 'asset.add':
        if (!op.asset || typeof op.asset !== 'object' || !op.asset.id) { return 'asset.add requires an asset record'; }
        break;
      default:
        break;
    }
    if (ELEMENT_SCOPED_OPS.has(op.op)) {
      const mid = opMid(op);
      if (typeof mid !== 'string' || !mid) { return `${op.op} requires a mid`; }
    }
    return null;
  }

  // ========================================================================
  // Conflict ladder (Plan 22 §3.5)
  // ========================================================================

  /**
   * `'fresh'` — base version matches (or none was supplied).
   * `'rebase'` — page moved, but the target element survived → re-apply.
   * `'stale'`  — the writer's world is gone.
   */
  private _classify(
    artifact: CanvasArtifact,
    op: CanvasOpV2,
    baseVersion: number | undefined,
  ): 'fresh' | 'rebase' | 'stale' {
    if (typeof baseVersion !== 'number') { return 'fresh'; }
    if (ARTIFACT_SCOPED_OPS.has(op.op)) {
      // Artifact-scope ops check `artifact.version`, NOT some page's — the
      // field `_touch` has always maintained and nothing has ever read.
      return artifact.version === baseVersion ? 'fresh' : 'stale';
    }
    const pageId = opPageId(op);
    if (!pageId) { return 'fresh'; }
    const page = this._store.getPage(artifact, pageId);
    if (!page) { return 'stale'; }
    if (page.version === baseVersion) { return 'fresh'; }
    // Semantic rebase: identity survived the intervening edits, so the writer's
    // intent is still expressible against the current document.
    const mid = opMid(op);
    if (mid && findNode(page.doc, mid)) { return 'rebase'; }
    return 'stale';
  }

  private _classifyLegacy(artifact: CanvasArtifact, op: CanvasOp): 'fresh' | 'rebase' | 'stale' {
    if (typeof op.baseVersion !== 'number') { return 'fresh'; }
    if (LEGACY_ARTIFACT_SCOPED.has(op.kind)) {
      return artifact.version === op.baseVersion ? 'fresh' : 'stale';
    }
    if (!op.targetPageId) { return 'fresh'; }
    const page = this._store.getPage(artifact, op.targetPageId);
    if (!page) { return 'fresh'; }
    if (page.version === op.baseVersion) { return 'fresh'; }
    if (op.kind === 'edit_element') {
      const v2 = this._elementOpFor(op);
      const mid = v2 ? opMid(v2) : null;
      if (mid && findNode(page.doc, mid)) { return 'rebase'; }
    }
    return 'stale';
  }

  // ========================================================================
  // Locks
  // ========================================================================

  private _isParked(page: ArtifactPage, op: CanvasOpV2): boolean {
    const locks = this._lockedSubtrees.get(page.id);
    if (!locks || locks.size === 0) { return false; }
    if (locks.has(WHOLE_PAGE_LOCK)) { return true; }
    const mid = opMid(op);
    // A page-scoped op (setDoc/setMeta/move) rewrites or reframes everything,
    // so any live subtree edit on that page parks it.
    if (!mid) { return true; }
    return [...locks].some(lock => intersectsSubtree(page.doc, lock, mid));
  }

  private _isParkedLegacy(page: ArtifactPage, op: CanvasOp): boolean {
    const locks = this._lockedSubtrees.get(page.id);
    if (!locks || locks.size === 0) { return false; }
    if (locks.has(WHOLE_PAGE_LOCK)) { return true; }
    const v2 = op.kind === 'edit_element' ? this._elementOpFor(op) : null;
    if (!v2) { return true; }
    return this._isParked(page, v2);
  }

  // ========================================================================
  // Apply / revert — V2
  // ========================================================================

  private _commitV2(
    artifact: CanvasArtifact,
    record: CanvasJournalEntry,
    jobId: string,
    rebased: boolean,
  ): CanvasOpReceiptV2 {
    let outcome: { pageId?: string; inverse?: CanvasOpV2; newMids?: Record<string, Mid>; restore?: CanvasJournalEntry['restore'] };
    try {
      outcome = this._applyV2(artifact, record.op);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      record.status = isStaleDocPatchError(err) ? 'stale' : 'rejected';
      this._lastSubmitError = detail;
      this._journalPush(artifact, record);
      this._emitLegacy(jobId, record.status === 'stale' ? 'op_staged' : 'op_error', record, detail);
      return this._receipt(artifact, record, { error: detail });
    }

    record.status = 'applied';
    record.inverse = outcome.inverse;
    record.restore = outcome.restore;
    // §3.5 rule 1: a committed HUMAN op takes ownership of the cells it wrote.
    // Written against the NEW tree, after the document was replaced.
    if (record.author === 'user' && outcome.pageId) {
      this._writePins(artifact, outcome.pageId, record.op, record.opId);
    }
    record.committedArtifactVersion = artifact.version;
    if (outcome.pageId) {
      record.committedPageVersion = this._store.getPage(artifact, outcome.pageId)?.version;
    }
    this._journalPush(artifact, record);

    if (record.author === 'agent') {
      console.log(`[Mysti] canvas-op applied: ${record.op.op} page=${outcome.pageId ?? '-'} run=${record.runId}`);
    }
    this._mirrorToOpLog(artifact, record, outcome.pageId);
    this._emitLegacy(jobId, 'op_applied', record);
    if (outcome.pageId) {
      this._router.emit(jobId, { type: 'page_updated', pageId: outcome.pageId });
    }
    return this._receipt(artifact, record, { rebased: rebased || undefined, newMids: outcome.newMids });
  }

  /**
   * Mutate the artifact for one V2 op.
   *
   * Document mutations delegate to the pure {@link applyOp}; everything else is
   * a store primitive with an explicitly-constructed inverse. Nothing here
   * clones a page source.
   */
  private _applyV2(
    artifact: CanvasArtifact,
    op: CanvasOpV2,
  ): { pageId?: string; inverse?: CanvasOpV2; newMids?: Record<string, Mid>; restore?: CanvasJournalEntry['restore'] } {
    if (isDocScopedOp(op)) {
      const pageId = opPageId(op)!;
      const page = this._store.getPage(artifact, pageId);
      if (!page) { return {}; }
      const result = applyOp(page.doc, op);
      this._store.setPageDoc(artifact, pageId, result.doc);
      return { pageId, inverse: result.inverse, newMids: result.newMids };
    }

    switch (op.op) {
      case 'page.add': {
        const spec = op.page;
        const page = this._store.makePage({
          id: spec.id,
          doc: spec.doc,
          actionTitle: spec.actionTitle,
          notes: spec.notes,
          format: spec.format,
          boardPos: spec.boardPos,
          variantGroupId: spec.variantGroupId,
        });
        this._store.insertPage(artifact, page, op.index);
        // Materialize the minted id back onto the op. `page.add` is both a
        // first-class op AND the inverse of `page.remove`, so it gets replayed
        // by redo — and a replay that mints a FRESH id restores the artboard as
        // a stranger: every pin, comment, staged op and selection addressing
        // the old id is orphaned, silently. Recording what actually happened is
        // what makes redo deterministic (this is why `NewPageSpec.id` exists).
        if (!spec.id) { spec.id = page.id; }
        return { pageId: page.id, inverse: { op: 'page.remove', pageId: page.id } };
      }
      case 'page.remove': {
        const index = artifact.pages.findIndex(p => p.id === op.pageId);
        const page = this._store.getPage(artifact, op.pageId);
        if (!page) { return {}; }
        const snapshot = clonePage(page);
        this._store.deletePage(artifact, op.pageId);
        return {
          pageId: op.pageId,
          inverse: {
            op: 'page.add',
            index,
            page: {
              id: snapshot.id,
              doc: snapshot.doc,
              actionTitle: snapshot.actionTitle,
              notes: snapshot.notes,
              format: snapshot.format,
              boardPos: snapshot.boardPos,
              variantGroupId: snapshot.variantGroupId,
            },
          },
          // `NewPageSpec` cannot express an uncompilable legacy source, so a
          // legacy page rides back on the restore hint instead of silently
          // returning as a blank artboard.
          restore: snapshot.legacy ? { page: snapshot, index } : undefined,
        };
      }
      case 'page.duplicate': {
        const index = artifact.pages.findIndex(p => p.id === op.pageId);
        const page = this._store.getPage(artifact, op.pageId);
        if (!page) { return {}; }
        const copy = this._store.makePage({
          // A duplicate must NOT share mids: pins, comments and selection are
          // all mid-addressed, so shared ids would make two artboards one.
          doc: withFreshMids(page.doc),
          actionTitle: page.actionTitle,
          notes: page.notes,
          format: page.format,
          variantGroupId: op.variantOf ?? page.variantGroupId,
          boardPos: boardPosForIndex(artifact.pages.length),
        });
        if (page.legacy) { copy.legacy = { ...page.legacy }; }
        if (page.compileError) { copy.compileError = page.compileError; }
        this._store.insertPage(artifact, copy, index >= 0 ? index + 1 : undefined);
        return { pageId: copy.id, inverse: { op: 'page.remove', pageId: copy.id } };
      }
      case 'page.setMeta': {
        const page = this._store.getPage(artifact, op.pageId);
        if (!page) { return {}; }
        // Applied field-by-field rather than through `updatePage` so an explicit
        // `undefined` means DELETE. Otherwise "give this artboard a title" would
        // have no exact inverse — undo would leave the title behind.
        const before: { actionTitle?: string; notes?: string; format?: CanvasFormatSpec } = {};
        const meta = page as unknown as Record<string, unknown>;
        for (const key of ['actionTitle', 'notes', 'format'] as const) {
          if (!(key in op.patch)) { continue; }
          (before as Record<string, unknown>)[key] = page[key];
          const value = op.patch[key];
          if (value === undefined) { delete meta[key]; } else { meta[key] = value; }
        }
        page.version += 1;
        artifact.version += 1;
        artifact.updatedAt = Date.now();
        return { pageId: op.pageId, inverse: { op: 'page.setMeta', pageId: op.pageId, patch: before } };
      }
      case 'page.move': {
        const page = this._store.getPage(artifact, op.pageId);
        if (!page) { return {}; }
        const before = { ...page.boardPos };
        page.boardPos = { x: op.boardPos.x, y: op.boardPos.y };
        page.version += 1;
        artifact.version += 1;
        artifact.updatedAt = Date.now();
        return { pageId: op.pageId, inverse: { op: 'page.move', pageId: op.pageId, boardPos: before } };
      }
      case 'page.reorder': {
        const before = artifact.pages.map(p => p.id);
        this._store.reorderPages(artifact, op.orderedIds);
        return { inverse: { op: 'page.reorder', orderedIds: before } };
      }
      case 'theme.set': {
        const before = cloneJson(artifact.theme);
        this._store.setTheme(artifact, op.theme);
        return { inverse: { op: 'theme.set', theme: before } };
      }
      case 'theme.setToken': {
        const before = readTokenPath(artifact.theme, op.path);
        writeTokenPath(artifact.theme, op.path, op.value);
        artifact.version += 1;
        artifact.updatedAt = Date.now();
        return {
          inverse: { op: 'theme.setToken', path: op.path, value: typeof before === 'string' ? before : '' },
        };
      }
      case 'artifact.setFormat': {
        const before = cloneJson(artifact.format);
        this._store.setFormat(artifact, op.format);
        return { inverse: { op: 'artifact.setFormat', format: before } };
      }
      case 'asset.add': {
        artifact.assets.push(op.asset);
        artifact.version += 1;
        artifact.updatedAt = Date.now();
        // The algebra has no `asset.remove`; undo rides the restore hint.
        return { pageId: op.asset.sourcePageId, restore: { assetId: op.asset.id } };
      }
      default:
        return {};
    }
  }

  // ========================================================================
  // Apply / revert — legacy kinds
  // ========================================================================

  /** Mutate the artifact for an op; returns the affected page id (if any). */
  private _apply(artifact: CanvasArtifact, op: CanvasOp): string | undefined {
    switch (op.kind) {
      case 'insert_page': {
        // The author supplies page content fields (no canonical id/version);
        // makePage assigns them so insert/undo can address the exact page.
        const raw = (op.proposedValue ?? {}) as PageInit & { index?: number };
        // E-1: a writer-supplied `id` is a HINT, never an authority.
        // `makePage` takes it verbatim, so `insert_page {id: <a live page>,
        // index: 0}` spliced a SECOND page carrying an existing page's id —
        // and `getPage` resolves by FIRST match, so the new page SHADOWED the
        // human's artboard. Every later op, every pin lookup and `deletePage`
        // (which is how undo of this very op works) then hit the agent's copy
        // while the human's pinned page sat on the board, unreachable by id.
        // Re-mint instead, the same way `migrateArtifactPages` re-ids a
        // duplicate it finds on disk.
        const init: PageInit & { index?: number } = { ...raw };
        if (typeof init.id === 'string' && artifact.pages.some(p => p.id === init.id)) {
          console.log(`[Mysti] canvas-op: insert_page reused live page id ${init.id} — minting a fresh one`);
          delete init.id;
        }
        const page = this._store.insertPage(artifact, this._store.makePage(init), init.index);
        op.targetPageId = page.id;
        op.previousValue = null;
        return page.id;
      }
      case 'edit_page': {
        const patch = op.proposedValue as Record<string, unknown>;
        const page = this._store.getPage(artifact, op.targetPageId!);
        const before = page?.doc;
        if (page) { op.previousValue = this._snapshotForPatch(page, patch); }
        this._store.updatePage(artifact, op.targetPageId!, patch);
        // A content patch rebuilds the document from scratch, so a pin that
        // SURVIVED the gate in `submit` (same mid, same tag, same value) would
        // still lose its record — the human's ownership would evaporate even
        // though their value did not. Put the surviving records back.
        const after = page?.doc;
        if (page && before && after && after !== before) {
          regraftPins(before, after);
          // `jsxCache` is emitted WITH pin markers, so it is stale the moment a
          // record is grafted back — and `get_page_jsx` reads the cache, which
          // is how the model learns a cell is owned. NOT for a `legacy`
          // outcome (J-3): there `updatePage` just preserved the verbatim
          // source (or '' for html) as the cache, and an emit of the empty
          // placeholder doc would overwrite the page's only copy of it.
          if (!page.legacy) { refreshJsxCache(page); }
        }
        return op.targetPageId;
      }
      case 'delete_page': {
        const idx = artifact.pages.findIndex(p => p.id === op.targetPageId);
        const page = this._store.getPage(artifact, op.targetPageId!);
        op.previousValue = page ? { page: clonePage(page), index: idx } : null;
        this._store.deletePage(artifact, op.targetPageId!);
        return op.targetPageId;
      }
      case 'reorder': {
        op.previousValue = artifact.pages.map(p => p.id);
        this._store.reorderPages(artifact, op.proposedValue as string[]);
        return undefined;
      }
      case 'set_theme': {
        op.previousValue = cloneJson(artifact.theme);
        this._store.setTheme(artifact, op.proposedValue as DesignTheme);
        return undefined;
      }
      case 'set_format': {
        op.previousValue = cloneJson(artifact.format);
        this._store.setFormat(artifact, op.proposedValue as CanvasFormatSpec);
        return undefined;
      }
      case 'edit_element': {
        // Plan 22 §3.1: an element edit is a first-class document op against a
        // `mid`, not a shadow override keyed by a DOM index path.
        const v2 = this._elementOpFor(op);
        if (!v2) { throw new Error('edit_element requires a mid and exactly one of text/style/prop'); }
        const page = this._store.getPage(artifact, op.targetPageId!);
        if (!page) { return op.targetPageId; }
        const result = applyOp(page.doc, v2);
        this._store.setPageDoc(artifact, page.id, result.doc);
        op.inverse = result.inverse;
        op.previousValue = undefined;
        if (op.author === 'user') { this._writePins(artifact, page.id, v2, op.opId); }
        return op.targetPageId;
      }
      case 'add_asset': {
        const record = op.proposedValue as CanvasAssetRecord;
        artifact.assets.push(record);
        op.previousValue = { assetId: record.id };
        return record.sourcePageId;
      }
    }
    return undefined;
  }

  /**
   * Reverse an applied op using its `restore` hint, else its `inverse`, else
   * its `previousValue`.
   *
   * The hint comes FIRST because it exists precisely for the two ops the
   * algebra cannot invert: `page.remove` of a page whose source does not
   * compile (a `NewPageSpec` has nowhere to put it, so the inverse `page.add`
   * would bring the artboard back empty) and `asset.add` (there is no
   * `asset.remove`). The hint lives on the journal entry, not on the op-log
   * mirror — `_mirrorToOpLog` carries only `inverse` — so undo has to look it
   * up rather than read it off the op it was handed.
   */
  private _revert(artifact: CanvasArtifact, op: CanvasOp): string | undefined {
    const hinted = this._restoreFromHint(artifact, op.opId);
    if (hinted) { return hinted.pageId ?? op.targetPageId; }
    if (op.inverse) {
      try {
        const out = this._applyV2(artifact, op.inverse);
        return out.pageId ?? op.targetPageId;
      } catch (err) {
        console.log('[Mysti] canvas-op: inverse failed, page left as-is:', err);
        return op.targetPageId;
      }
    }
    switch (op.kind) {
      case 'insert_page': {
        if (op.targetPageId) { this._store.deletePage(artifact, op.targetPageId); }
        return op.targetPageId;
      }
      case 'edit_page': {
        if (op.previousValue && op.targetPageId) {
          this._restorePage(artifact, op.targetPageId, op.previousValue as Partial<ArtifactPage>);
        }
        return op.targetPageId;
      }
      case 'delete_page': {
        const prev = op.previousValue as { page: ArtifactPage; index: number } | null;
        if (prev?.page) { this._store.insertPage(artifact, prev.page, prev.index); }
        return prev?.page.id;
      }
      case 'reorder': {
        if (Array.isArray(op.previousValue)) {
          this._store.reorderPages(artifact, op.previousValue as string[]);
        }
        return undefined;
      }
      case 'set_theme': {
        if (op.previousValue) { this._store.setTheme(artifact, op.previousValue as DesignTheme); }
        return undefined;
      }
      case 'set_format': {
        if (op.previousValue) { this._store.setFormat(artifact, op.previousValue as CanvasFormatSpec); }
        return undefined;
      }
      case 'add_asset': {
        const prev = op.previousValue as { assetId: string } | null;
        if (prev) { artifact.assets = artifact.assets.filter(a => a.id !== prev.assetId); }
        return undefined;
      }
      case 'edit_element':
        // Without an inverse there is nothing to restore: the op never applied.
        return op.targetPageId;
    }
    return undefined;
  }

  /**
   * Undo an op through the journal's `restore` hint, or null when it has none.
   *
   * Restoring the page SNAPSHOT rather than replaying the inverse is the whole
   * point: it carries `legacy` (the uncompilable source), `compileError` and
   * `jsxCache`, none of which a `NewPageSpec` can express.
   */
  private _restoreFromHint(artifact: CanvasArtifact, opId: string): { pageId?: string } | null {
    const hint = (this._journal.get(artifact.id) ?? []).find(e => e.opId === opId)?.restore;
    if (!hint) { return null; }
    if (hint.page) {
      if (!this._store.getPage(artifact, hint.page.id)) {
        const index = typeof hint.index === 'number' && hint.index >= 0 ? hint.index : undefined;
        this._store.insertPage(artifact, clonePage(hint.page), index);
      }
      return { pageId: hint.page.id };
    }
    if (hint.assetId) {
      const before = artifact.assets.length;
      artifact.assets = artifact.assets.filter(a => a.id !== hint.assetId);
      if (artifact.assets.length !== before) {
        artifact.version += 1;
        artifact.updatedAt = Date.now();
      }
      return {};
    }
    return null;
  }

  // ========================================================================
  // Pins
  // ========================================================================

  /**
   * Stamp a {@link PinRecord} on every cell a human op just wrote.
   *
   * Run AFTER the document was replaced, against the NEW tree: `applyOp` is
   * pure, so the node in the old tree is not the node anyone will render.
   */
  private _writePins(artifact: CanvasArtifact, pageId: string, op: CanvasOpV2, opId: string): void {
    const cells = opCells(op);
    if (!cells || cells.length === 0) { return; }
    const mid = opMid(op);
    if (!mid) { return; }
    const page = this._store.getPage(artifact, pageId);
    if (!page) { return; }
    const node = findNode(page.doc, mid);
    if (!node) { return; }
    const at = Date.now();
    const pins = { ...(node.pins ?? {}) };
    const before: Record<PinCell, PinRecord | undefined> = {};
    for (const cell of cells) {
      before[cell] = pins[cell];
      pins[cell] = { at, opId };
    }
    node.pins = pins;
    refreshJsxCache(page);
    // Remembered so an undo of THIS op can release exactly the cells it took.
    this._pinWrites.set(opId, { pageId, mid, cells, before });
    if (this._pinWrites.size > MAX_JOURNAL_ENTRIES) {
      const oldest = this._pinWrites.keys().next();
      if (!oldest.done) { this._pinWrites.delete(oldest.value); }
    }
  }

  /**
   * Release the pins an op took, restoring whatever the cells carried before.
   *
   * A cell whose pin now names a DIFFERENT op is left alone: a later human
   * edit owns it, and this op's undo has no business handing that away.
   * Returns the page whose pins changed (so the caller can re-render it).
   */
  private _clearPins(artifact: CanvasArtifact, opId: string): string | undefined {
    const write = this._pinWrites.get(opId);
    if (!write) { return undefined; }
    this._pinWrites.delete(opId);
    const page = this._store.getPage(artifact, write.pageId);
    if (!page) { return undefined; }
    const node = findNode(page.doc, write.mid);
    if (!node || !node.pins) { return undefined; }
    const pins = { ...node.pins };
    let changed = false;
    for (const cell of write.cells) {
      if (pins[cell]?.opId !== opId) { continue; }
      const prior = write.before[cell];
      if (prior) { pins[cell] = prior; } else { delete pins[cell]; }
      changed = true;
    }
    if (!changed) { return undefined; }
    if (Object.keys(pins).length > 0) { node.pins = pins; } else { delete node.pins; }
    refreshJsxCache(page);
    return page.id;
  }

  // ========================================================================
  // Journal + receipts
  // ========================================================================

  private _journalPush(artifact: CanvasArtifact, entry: CanvasJournalEntry): void {
    const list = this._journal.get(artifact.id) ?? [];
    const existing = list.findIndex(e => e.opId === entry.opId);
    if (existing >= 0) { list[existing] = entry; }
    else { list.push(entry); }
    if (list.length > MAX_JOURNAL_ENTRIES) { list.splice(0, list.length - MAX_JOURNAL_ENTRIES); }
    this._journal.set(artifact.id, list);
  }

  /**
   * Mirror an applied legacy op into the journal so `since[]` stays complete.
   *
   * The record is what `CanvasBridge.pushOps` ships to the webview VERBATIM as
   * the `canvas/ops` delta, so it must describe the edit that actually
   * happened. It used to invent `{op:'page.setMeta', patch:{}}` for every
   * non-element kind: an empty patch on an existing page applies cleanly
   * client-side, which means no resync was ever requested while the version
   * arithmetic still lined up — a `delete_page` left the artboard on screen
   * and an `edit_page` left the old content there, forever.
   *
   * When the algebra cannot express what happened (a rewrite of an
   * uncompilable `legacy` page), NOTHING is journalled: the version then moves
   * without a matching record, `pushOps`' gap check fires, and the client asks
   * for a full transfer. An honest resync beats a delta that lies.
   */
  private _journalLegacy(artifact: CanvasArtifact, op: CanvasOp): void {
    const v2 = this._legacyOpAsV2(artifact, op);
    if (!v2) {
      console.log(`[Mysti] canvas-op ${op.kind} has no op-algebra equivalent — client will resync`);
      return;
    }
    const entry: CanvasJournalEntry = {
      opId: op.opId,
      txnId: op.runId,
      runId: op.runId,
      author: op.author,
      actorId: op.author,
      op: v2,
      baseVersion: op.baseVersion,
      inverse: op.inverse,
      status: 'applied',
      ts: op.ts,
      committedArtifactVersion: artifact.version,
      committedPageVersion: op.targetPageId
        ? this._store.getPage(artifact, op.targetPageId)?.version
        : undefined,
    };
    this._journalPush(artifact, entry);
  }

  /**
   * The committed ops a writer at `baseVersion` has not seen.
   *
   * Sliced on the version the op COMMITTED at, not on a count of version bumps:
   * anything that mutates a page outside the op path would otherwise shift the
   * window and hand the agent someone else's edits (or hide its own).
   */
  private _since(
    artifact: CanvasArtifact,
    op: CanvasOpV2 | null,
    baseVersion: number | undefined,
    excludeOpId: string,
  ): CanvasOpRecordV2[] | undefined {
    if (typeof baseVersion !== 'number' || !op) { return undefined; }
    const entries = this._journal.get(artifact.id);
    if (!entries || entries.length === 0) { return undefined; }
    const artifactScoped = ARTIFACT_SCOPED_OPS.has(op.op);
    const pageId = opPageId(op);
    const out: CanvasOpRecordV2[] = [];
    for (const e of entries) {
      if (e.opId === excludeOpId || e.status !== 'applied') { continue; }
      if (artifactScoped || !pageId) {
        if (e.committedArtifactVersion > baseVersion) { out.push(publicRecord(e)); }
        continue;
      }
      if (opPageId(e.op) !== pageId) { continue; }
      if ((e.committedPageVersion ?? 0) > baseVersion) { out.push(publicRecord(e)); }
    }
    if (out.length === 0) { return undefined; }
    return out.slice(-MAX_SINCE_RECORDS);
  }

  private _receipt(
    artifact: CanvasArtifact,
    record: CanvasJournalEntry,
    extra: { error?: string; pinned?: PinCell[]; rebased?: boolean; newMids?: Record<string, Mid> },
  ): CanvasOpReceiptV2 {
    const pageId = opPageId(record.op) ?? undefined;
    const receipt: CanvasOpReceiptV2 = {
      opId: record.opId,
      status: record.status,
      artifactVersion: artifact.version,
    };
    if (pageId) {
      receipt.pageId = pageId;
      const page = this._store.getPage(artifact, pageId);
      if (page) { receipt.pageVersion = page.version; }
    }
    if (extra.rebased) { receipt.rebased = true; }
    if (extra.pinned && extra.pinned.length > 0) { receipt.pinned = extra.pinned; }
    if (extra.newMids && Object.keys(extra.newMids).length > 0) { receipt.newMids = extra.newMids; }
    if (extra.error) { receipt.error = extra.error; }
    const since = this._since(artifact, record.op, record.baseVersion, record.opId);
    if (since) { receipt.since = since; }
    this._lastReceipt = receipt;
    return receipt;
  }

  private _legacyReceipt(
    artifact: CanvasArtifact,
    op: CanvasOp,
    extra: { error?: string; pinned?: PinCell[]; rebased?: boolean },
  ): CanvasOpReceiptV2 {
    const receipt: CanvasOpReceiptV2 = {
      opId: op.opId,
      status: op.status === 'pending' ? 'staged' : (op.status as CanvasOpStatusV2),
      artifactVersion: artifact.version,
    };
    if (op.targetPageId) {
      receipt.pageId = op.targetPageId;
      const page = this._store.getPage(artifact, op.targetPageId);
      if (page) { receipt.pageVersion = page.version; }
    }
    if (extra.rebased) { receipt.rebased = true; }
    if (extra.pinned && extra.pinned.length > 0) { receipt.pinned = extra.pinned; }
    if (extra.error) { receipt.error = extra.error; }
    const probe = this._elementOpFor(op)
      ?? (op.targetPageId
        ? ({ op: 'page.setMeta', pageId: op.targetPageId, patch: {} } as CanvasOpV2)
        : ({ op: 'page.reorder', orderedIds: [] } as CanvasOpV2));
    const since = this._since(artifact, probe, op.baseVersion, op.opId);
    if (since) { receipt.since = since; }
    this._lastReceipt = receipt;
    return receipt;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /**
   * The op-algebra equivalent of an APPLIED legacy op, or null when the
   * algebra cannot express it.
   *
   * Read off the artifact AFTER the op applied, so the record describes the
   * state the client must converge on rather than what the author proposed
   * (a `reorder` whose payload omitted ids, an `edit_page` whose source was
   * recompiled). Null is a real answer — see {@link _journalLegacy}.
   */
  private _legacyOpAsV2(artifact: CanvasArtifact, op: CanvasOp): CanvasOpV2 | null {
    const element = this._elementOpFor(op);
    if (element) { return element; }
    switch (op.kind) {
      case 'insert_page': {
        const page = op.targetPageId ? this._store.getPage(artifact, op.targetPageId) : undefined;
        if (!page) { return null; }
        const index = artifact.pages.findIndex(p => p.id === page.id);
        return {
          op: 'page.add',
          index: index >= 0 ? index : undefined,
          page: {
            id: page.id,
            doc: cloneNode(page.doc),
            actionTitle: page.actionTitle,
            notes: page.notes,
            format: page.format ? cloneJson(page.format) : undefined,
            boardPos: { ...page.boardPos },
            variantGroupId: page.variantGroupId,
          },
        };
      }
      case 'delete_page':
        return op.targetPageId ? { op: 'page.remove', pageId: op.targetPageId } : null;
      case 'reorder':
        return { op: 'page.reorder', orderedIds: artifact.pages.map(p => p.id) };
      case 'set_theme':
        return { op: 'theme.set', theme: cloneJson(artifact.theme) };
      case 'set_format':
        return { op: 'artifact.setFormat', format: cloneJson(artifact.format) };
      case 'add_asset': {
        const asset = op.proposedValue as CanvasAssetRecord | null;
        if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string') { return null; }
        return { op: 'asset.add', asset };
      }
      case 'edit_page':
        return this._legacyPageEditAsV2(artifact, op);
      default:
        return null;
    }
  }

  /** The V2 equivalent of an applied legacy `edit_page` patch, or null. */
  private _legacyPageEditAsV2(artifact: CanvasArtifact, op: CanvasOp): CanvasOpV2 | null {
    const page = op.targetPageId ? this._store.getPage(artifact, op.targetPageId) : undefined;
    if (!page) { return null; }
    const patch = (op.proposedValue ?? {}) as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0) { return null; }
    const rewritesContent = keys.some(k => CONTENT_PATCH_KEYS.has(k));
    const metaKeys = keys.filter(k => META_PATCH_KEYS.has(k));
    if (rewritesContent) {
      // One record per op, so a patch that rewrote content AND metadata cannot
      // be told honestly — and a page whose source never compiled has no
      // document-shaped truth to send at all. Both resync.
      if (metaKeys.length > 0 || keys.some(k => !CONTENT_PATCH_KEYS.has(k))) { return null; }
      if (page.legacy) { return null; }
      // The page WAS uncompilable and now is not: a doc patch would replace the
      // client's tree while leaving its `legacy` source in place, so the board
      // would keep rendering the code the host just replaced.
      const previous = op.previousValue as Partial<ArtifactPage> | null | undefined;
      if (previous && (previous.legacy || previous.compileError)) { return null; }
      return { op: 'page.setDoc', pageId: page.id, doc: cloneNode(page.doc) };
    }
    if (keys.length === 1 && keys[0] === 'boardPos') {
      return { op: 'page.move', pageId: page.id, boardPos: { ...page.boardPos } };
    }
    if (metaKeys.length !== keys.length) { return null; }
    const meta: { actionTitle?: string; notes?: string; format?: CanvasFormatSpec } = {};
    for (const key of metaKeys as ('actionTitle' | 'notes' | 'format')[]) {
      (meta as Record<string, unknown>)[key] = cloneJson(page[key]);
    }
    return { op: 'page.setMeta', pageId: page.id, patch: meta };
  }

  /** The V2 element op a legacy `edit_element` payload denotes, or null. */
  private _elementOpFor(op: CanvasOp): CanvasOpV2 | null {
    if (op.kind !== 'edit_element' || !op.targetPageId) { return null; }
    const v = op.proposedValue as {
      mid?: unknown;
      text?: unknown;
      style?: unknown;
      prop?: { name?: unknown; value?: unknown };
    } | null;
    if (!v || typeof v !== 'object' || typeof v.mid !== 'string' || !v.mid) { return null; }
    if (typeof v.text === 'string') {
      return { op: 'el.setText', pageId: op.targetPageId, mid: v.mid, text: v.text };
    }
    if (v.style && typeof v.style === 'object' && !Array.isArray(v.style)) {
      return {
        op: 'el.setStyle',
        pageId: op.targetPageId,
        mid: v.mid,
        style: v.style as Record<string, string | null>,
      };
    }
    if (v.prop && typeof v.prop === 'object' && typeof v.prop.name === 'string') {
      return {
        op: 'el.setProp',
        pageId: op.targetPageId,
        mid: v.mid,
        name: v.prop.name,
        value: (v.prop.value ?? null) as never,
      };
    }
    return null;
  }

  /**
   * Snapshot exactly what a legacy `edit_page` patch is about to overwrite.
   *
   * A patch that rewrites content takes the whole content triple
   * (`doc`/`jsxCache`/`legacy`) because `updatePage` recompiles it as a unit;
   * a metadata-only patch takes only the keys it names.
   */
  private _snapshotForPatch(page: ArtifactPage, patch: Record<string, unknown>): Partial<ArtifactPage> {
    const snap: Partial<ArtifactPage> = {};
    const rewritesContent = patch.doc !== undefined
      || patch.jsxSource !== undefined
      || patch.htmlSource !== undefined
      || Array.isArray(patch.nodes);
    if (rewritesContent) {
      snap.doc = cloneNode(page.doc);
      snap.jsxCache = page.jsxCache;
      if (page.legacy) { snap.legacy = { ...page.legacy }; }
      if (page.compileError) { snap.compileError = page.compileError; }
    }
    for (const key of ['actionTitle', 'notes', 'source', 'format', 'variantGroupId', 'boardPos'] as const) {
      if (patch[key] !== undefined) {
        (snap as Record<string, unknown>)[key] = cloneJson((page as unknown as Record<string, unknown>)[key]);
      }
    }
    return snap;
  }

  /** Put a page's snapshotted fields back verbatim (no recompilation). */
  private _restorePage(artifact: CanvasArtifact, pageId: string, snapshot: Partial<ArtifactPage>): void {
    const page = this._store.getPage(artifact, pageId);
    if (!page) { return; }
    if (snapshot.doc) { page.doc = snapshot.doc; }
    if ('jsxCache' in snapshot) { page.jsxCache = snapshot.jsxCache; }
    if (snapshot.legacy) { page.legacy = snapshot.legacy; } else if (snapshot.doc) { delete page.legacy; }
    if (snapshot.compileError) { page.compileError = snapshot.compileError; }
    else if (snapshot.doc) { delete page.compileError; }
    for (const key of ['actionTitle', 'notes', 'source', 'format', 'variantGroupId', 'boardPos'] as const) {
      if (snapshot[key] !== undefined) {
        (page as unknown as Record<string, unknown>)[key] = snapshot[key];
      }
    }
    page.version += 1;
    artifact.version += 1;
    artifact.updatedAt = Date.now();
  }

  /** Emit a legacy job event for a V2 record so today's webview still updates. */
  /**
   * Mirror a COMMITTED V2 record into `artifact.opLog`.
   *
   * `CanvasHistory` ingests the op log — it is the only durable, persisted
   * record of what happened — so without this a human's `canvas/submit` and an
   * agent's `el.setText` were both invisible to undo, `canUndo()` never went
   * true, and Plan 22 §3.5's "one shared undo stack" was two stacks, one of
   * them empty.
   *
   * Only APPLIED records are mirrored, and that is load-bearing: a `staged`
   * mirror would land in the log as legacy `'pending'`, and the lock-flush loop
   * in {@link setSubtreeEditing} would then hand a V2 op to the legacy
   * {@link applyOp}, which would try to read a `CanvasOp` as a `proposedValue`.
   * A staged V2 op lives in the journal until it commits, exactly as before.
   *
   * `inverse` rides along because `_revert` prefers it over `previousValue`, so
   * undoing a mirrored element op costs one ~200-byte op rather than a clone of
   * the whole page.
   */
  private _mirrorToOpLog(artifact: CanvasArtifact, record: CanvasJournalEntry, pageId?: string): void {
    if (record.status !== 'applied') { return; }
    if (this._store.findOp(artifact, record.opId)) { return; }
    const mirror: CanvasOp = {
      opId: record.opId,
      runId: record.runId,
      kind: legacyKindFor(record.op.op),
      targetPageId: pageId ?? opPageId(record.op) ?? undefined,
      baseVersion: record.baseVersion,
      proposedValue: record.op,
      inverse: record.inverse,
      status: 'applied',
      author: record.author,
      ts: record.ts,
    };
    this._store.appendOp(artifact, mirror);
  }

  private _emitLegacy(
    jobId: string,
    type: 'op_staged' | 'op_applied' | 'op_error' | 'op_rejected',
    record: CanvasJournalEntry,
    error?: string,
  ): void {
    const legacy: CanvasOp = {
      opId: record.opId,
      runId: record.runId,
      kind: legacyKindFor(record.op.op),
      targetPageId: opPageId(record.op) ?? undefined,
      baseVersion: record.baseVersion,
      proposedValue: record.op,
      status: record.status === 'staged' ? 'pending' : (record.status === 'undone' ? 'rejected' : record.status),
      author: record.author,
      ts: record.ts,
    };
    this._router.emit(jobId, error ? { type, op: legacy, error } : { type, op: legacy });
  }
}

/* ─────────────────────────────── free helpers ─────────────────────────────── */

/** `edit_page` patch keys that rewrite the page's content. */
const CONTENT_PATCH_KEYS: ReadonlySet<string> = new Set(['doc', 'jsxSource', 'htmlSource', 'nodes', 'mode']);
/** `edit_page` patch keys `page.setMeta` can carry. */
const META_PATCH_KEYS: ReadonlySet<string> = new Set(['actionTitle', 'notes', 'format']);

/** Legacy kinds whose staleness is artifact-scoped, not page-scoped. */
const LEGACY_ARTIFACT_SCOPED: ReadonlySet<CanvasOpKind> = new Set<CanvasOpKind>([
  'reorder', 'set_theme', 'set_format', 'add_asset', 'insert_page', 'delete_page',
]);

/** Best-effort mapping so V2 records still render on today's event surface. */
function legacyKindFor(kind: CanvasOpKindV2): CanvasOpKind {
  switch (kind) {
    case 'page.add': case 'page.duplicate': return 'insert_page';
    case 'page.remove': return 'delete_page';
    case 'page.reorder': return 'reorder';
    case 'theme.set': case 'theme.setToken': return 'set_theme';
    case 'artifact.setFormat': return 'set_format';
    case 'asset.add': return 'add_asset';
    case 'page.setMeta': case 'page.move': case 'page.setDoc': return 'edit_page';
    default: return 'edit_element';
  }
}

/** Drop executor-internal bookkeeping before a record reaches a writer. */
function publicRecord(entry: CanvasJournalEntry): CanvasOpRecordV2 {
  const { committedArtifactVersion, committedPageVersion, restore, ...rest } = entry;
  void committedArtifactVersion; void committedPageVersion; void restore;
  return rest;
}

/** Cells an op would write that a human already owns and the writer did not force. */
function pinnedConflicts(page: ArtifactPage, op: CanvasOpV2, force?: PinCell[]): PinCell[] {
  const cells = opCells(op);
  if (!cells || cells.length === 0) { return []; }
  const mid = opMid(op);
  if (!mid) { return []; }
  const node = findNode(page.doc, mid);
  if (!node) { return []; }
  const forced = new Set(force ?? []);
  return cells.filter(cell => isPinned(node, cell) && !forced.has(cell));
}

/**
 * True when a legacy `edit_page` patch replaces the page's CONTENT.
 *
 * Mirrors `ArtifactStore.updatePage`'s own predicate exactly — `mode` alone is
 * not enough there and must not be enough here, or the two would disagree
 * about whether a document is about to be rebuilt.
 */
function patchRewritesContent(patch: Record<string, unknown>): boolean {
  return patch.doc !== undefined
    || patch.jsxSource !== undefined
    || patch.htmlSource !== undefined
    || Array.isArray(patch.nodes);
}

/** Own-property read — a `pins`/`props` key can be `__proto__` on a hostile doc. */
function ownValue(map: Record<string, unknown> | undefined, key: string): unknown {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** The value of one addressed cell, or `undefined` when it is absent. */
function cellValueOf(node: DocNode, cell: PinCell): unknown {
  if (cell === 'text') { return node.text; }
  if (cell.startsWith('style.')) { return ownValue(node.style, cell.slice('style.'.length)); }
  if (cell.startsWith('props.')) { return ownValue(node.props, cell.slice('props.'.length)); }
  return undefined;
}

function cellEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === undefined || b === undefined) { return false; }
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * The human-owned cells a legacy `edit_page` content patch would destroy,
 * as `"<mid>:<cell>"` addresses.
 *
 * Same rule the supported whole-page rewrite uses (`pinsAcrossReplace` in
 * `CanvasToolDispatch`): a pin survives only when the incoming document has a
 * node with the SAME mid AND the same tag — a reused id does not make it the
 * same element — carrying the same value in that cell. Anything else is a
 * destroyed cell, so the op is refused rather than applied.
 *
 * Fails CLOSED: a patch whose document cannot be derived (a compile that
 * throws) is treated as destroying every pin on the page.
 */
function pinsDestroyedByPagePatch(page: ArtifactPage, proposed: unknown): string[] {
  const patch = (proposed ?? {}) as Record<string, unknown>;
  if (!patch || typeof patch !== 'object' || !patchRewritesContent(patch)) { return []; }

  const pinnedNodes = [...walk(page.doc)].filter(n => pinnedCells(n).length > 0);
  if (pinnedNodes.length === 0) { return []; }
  const allCells = () => pinnedAddresses(page);

  let incoming: DocNode;
  try {
    // Exactly what `updatePage` is about to do, so the comparison is against
    // the document that will actually exist.
    incoming = migratePage({
      ...patch,
      id: page.id,
      version: page.version,
      boardPos: page.boardPos,
    }).page.doc;
  } catch {
    return allCells();
  }

  const byMid = new Map<Mid, DocNode>();
  for (const n of walk(incoming)) { if (!byMid.has(n.mid)) { byMid.set(n.mid, n); } }

  const destroyed: string[] = [];
  for (const prev of pinnedNodes) {
    const claimed = byMid.get(prev.mid);
    const next = claimed && claimed.tag === prev.tag ? claimed : undefined;
    for (const cell of pinnedCells(prev)) {
      if (!next || !cellEqual(cellValueOf(prev, cell), cellValueOf(next, cell))) {
        destroyed.push(`${prev.mid}:${cell}`);
      }
    }
  }
  return destroyed;
}

/**
 * Every human-owned cell on a page, as `"<mid>:<cell>"` addresses — what a
 * whole-artboard removal would destroy.
 */
function pinnedAddresses(page: ArtifactPage): string[] {
  return [...walk(page.doc)].flatMap(n => pinnedCells(n).map(cell => `${n.mid}:${cell}`));
}

/**
 * The remedy every whole-artboard refusal points at. `edit_element` is the one
 * element-scoped write BOTH transports accept — the fenced ```canvas-op lane
 * (13 of 14 backends) has no `write_page`, `set_text` or `force`, so a remedy
 * naming only those was unreachable for the lane this refusal mostly reaches.
 */
const PIN_REFUSAL_REMEDY =
  'Leave those cells as they are and change the other elements one at a time with edit_element, '
  + 'addressed by mid — the kind the fenced canvas-op lane and MCP both accept.';

function pageRemovalRefusal(refused: string[]): string {
  return `refused: deleting this artboard would destroy ${refused.length} cell(s) the human owns `
    + `(${refused.join(', ')}). Leave the artboard in place — only the human can remove a page they `
    + `have edited. ${PIN_REFUSAL_REMEDY}`;
}

/**
 * Re-attach the pin records that survived a whole-page rebuild.
 *
 * Matched by mid AND tag AND value — the same identity rule the refusal above
 * uses. A pin records that the human wrote THIS value into THIS cell, so it may
 * land only where the incoming document still carries that value; on any other
 * value it would be a human ownership claim on text the human never wrote
 * (J-2: a staged rewrite accepted after the human retyped the cell, or a
 * staged copy of the cell accepted after the human moved on), which then
 * refuses every later agent edit "on the human's behalf". Only cells that
 * already passed the gate can be here, so this restores ownership rather than
 * granting it.
 */
function regraftPins(prev: DocNode, next: DocNode): void {
  const byMid = new Map<Mid, DocNode>();
  for (const n of walk(next)) { if (!byMid.has(n.mid)) { byMid.set(n.mid, n); } }
  for (const p of walk(prev)) {
    const cells = pinnedCells(p);
    if (cells.length === 0) { continue; }
    const target = byMid.get(p.mid);
    if (!target || target.tag !== p.tag) { continue; }
    const merged: Record<PinCell, PinRecord> = {};
    for (const cell of Object.keys(target.pins ?? {})) {
      const rec = ownValue(target.pins, cell) as PinRecord | undefined;
      if (rec) { putOwn(merged, cell, rec); }
    }
    for (const cell of cells) {
      if (!cellEqual(cellValueOf(p, cell), cellValueOf(target, cell))) { continue; }
      const rec = ownValue(p.pins, cell) as PinRecord | undefined;
      if (rec) { putOwn(merged, cell, rec); }
    }
    if (Object.keys(merged).length > 0) { target.pins = merged; }
  }
}

/**
 * True when a lock on `lockMid` and an edit at `targetMid` touch each other.
 *
 * Both directions matter: an op INSIDE the locked subtree obviously conflicts,
 * and so does an op on an ANCESTOR of it, which could delete or replace the
 * very node the human is typing into.
 */
function intersectsSubtree(doc: DocNode, lockMid: Mid, targetMid: Mid): boolean {
  if (lockMid === targetMid) { return true; }
  const lockNode = findNode(doc, lockMid);
  if (lockNode && findNode(lockNode, targetMid)) { return true; }
  const targetNode = findNode(doc, targetMid);
  if (targetNode && findNode(targetNode, lockMid)) { return true; }
  // A node that is no longer in the tree cannot conflict with anything.
  return false;
}

/** Deep copy of a page (structural for the doc, JSON for the flat metadata). */
function clonePage(page: ArtifactPage): ArtifactPage {
  const out: ArtifactPage = {
    id: page.id,
    version: page.version,
    doc: cloneNode(page.doc),
    boardPos: { ...page.boardPos },
  };
  if (page.jsxCache !== undefined) { out.jsxCache = page.jsxCache; }
  if (page.legacy) { out.legacy = { ...page.legacy }; }
  if (page.compileError !== undefined) { out.compileError = page.compileError; }
  if (page.actionTitle !== undefined) { out.actionTitle = page.actionTitle; }
  if (page.notes !== undefined) { out.notes = page.notes; }
  if (page.source !== undefined) { out.source = page.source; }
  if (page.format !== undefined) { out.format = cloneJson(page.format); }
  if (page.variantGroupId !== undefined) { out.variantGroupId = page.variantGroupId; }
  return out;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Segments that would let a token path reach the prototype chain. */
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isSafeTokenPath(path: string): boolean {
  const parts = path.split('.');
  if (parts.length === 0 || parts.length > 8) { return false; }
  return parts.every(p => p.length > 0 && p.length <= 64 && !UNSAFE_PATH_SEGMENTS.has(p));
}

function readTokenPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') { return undefined; }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function writeTokenPath(root: unknown, path: string, value: string): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> | null = (root && typeof root === 'object') ? root as Record<string, unknown> : null;
  for (let i = 0; i < parts.length - 1 && cur; i++) {
    const next: unknown = cur[parts[i]];
    if (!next || typeof next !== 'object') {
      const created: Record<string, unknown> = {};
      cur[parts[i]] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  if (cur) { cur[parts[parts.length - 1]] = value; }
}
