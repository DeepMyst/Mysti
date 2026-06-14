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
import type { ArtifactStore } from './ArtifactStore';
import type { CanvasJobRouter } from './CanvasJobRouter';
import type {
  CanvasArtifact,
  ArtifactPage,
  CanvasOp,
  CanvasOpKind,
  CanvasAssetRecord,
  DesignTheme,
  CanvasFormatSpec,
  ElementOverride,
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
}

/**
 * The single executor every transport (MCP tools, fenced `canvas-op` fallback,
 * prompt-bar commands) routes through (Plan 05 Phase 2). It validates writes
 * against the artifact, enforces the version/lock/supersession conflict rules,
 * stages or auto-applies per the approval mode, records `previousValue` for
 * artifact-wide op-log undo, and emits {@link CanvasJobEvent}s so the canvas
 * re-renders the affected page mid-turn.
 *
 * Canvas ops deliberately bypass the SafetyClassifier — they only ever touch
 * `.mysti/canvas/`, never the workspace or a shell.
 */
export class CanvasOpExecutor {
  private _store: ArtifactStore;
  private _router: CanvasJobRouter;
  /** Pages currently locked by an in-progress inline edit. */
  private _lockedPages = new Set<string>();
  /** Auto-mode ops queued behind a page lock, replayed on unlock. */
  private _queuedByPage = new Map<string, string[]>();
  /** Reason the most recent submit() was rejected by validation (else null). */
  private _lastSubmitError: string | null = null;

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

  // ========================================================================
  // Submission
  // ========================================================================

  /**
   * Validate and stage (or, in `auto` mode, apply) an op. Always appends to the
   * artifact op log for audit. Returns the resulting op, or null when the op is
   * structurally invalid (an `op_error` event is emitted in that case).
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
    const invalid = this._validate(artifact, op);
    if (invalid) {
      this._lastSubmitError = invalid;
      op.status = 'rejected';
      this._store.appendOp(artifact, op);
      this._router.emit(jobId, { type: 'op_error', op, error: invalid });
      return null;
    }

    // Base-version mismatch → stale; surfaced for "re-read & retry", never applied.
    if (this._isStale(artifact, op)) {
      op.status = 'stale';
      this._store.appendOp(artifact, op);
      this._router.emit(jobId, { type: 'op_staged', op });
      return op;
    }

    this._store.appendOp(artifact, op);

    // A locked page parks even auto-mode ops until the user blurs the edit.
    if (op.targetPageId && this._lockedPages.has(op.targetPageId)) {
      this._router.emit(jobId, { type: 'op_staged', op });
      if (mode === 'auto') {
        const q = this._queuedByPage.get(op.targetPageId) ?? [];
        q.push(op.opId);
        this._queuedByPage.set(op.targetPageId, q);
      }
      return op;
    }

    if (mode === 'auto') {
      return this.applyOp(artifact, op.opId, jobId) ?? op;
    }
    this._router.emit(jobId, { type: 'op_staged', op });
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
    if (this._isStale(artifact, op)) {
      op.status = 'stale';
      this._router.emit(jobId, { type: 'op_staged', op });
      return op;
    }

    const affectedPageId = this._apply(artifact, op);
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
    return op;
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
   * `previousValue`. The op's status flips to `rejected` (= no longer applied)
   * so a subsequent undo targets the next applied op. Returns the undone op.
   */
  undoLastApplied(artifact: CanvasArtifact, jobId: string): CanvasOp | undefined {
    for (let i = artifact.opLog.length - 1; i >= 0; i--) {
      const op = artifact.opLog[i];
      if (op.status === 'applied') {
        const affectedPageId = this._revert(artifact, op);
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
  // Page edit locks (conflict rules)
  // ========================================================================

  isPageLocked(pageId: string): boolean {
    return this._lockedPages.has(pageId);
  }

  /**
   * Toggle a page's inline-edit lock. Unlocking flushes any auto-mode ops that
   * queued behind it (in submission order).
   */
  setPageEditing(artifact: CanvasArtifact, pageId: string, editing: boolean, jobId: string): void {
    if (editing) {
      this._lockedPages.add(pageId);
      return;
    }
    this._lockedPages.delete(pageId);
    const queued = this._queuedByPage.get(pageId);
    this._queuedByPage.delete(pageId);
    if (!queued) { return; }
    for (const opId of queued) {
      const op = this._store.findOp(artifact, opId);
      if (op && op.status === 'pending') {
        this.applyOp(artifact, opId, jobId);
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
      case 'insert_page':
        if (!op.proposedValue || typeof op.proposedValue !== 'object') {
          return 'insert_page requires a page object';
        }
        if (!(op.proposedValue as ArtifactPage).mode) {
          return 'insert_page page requires a mode';
        }
        break;
      case 'reorder':
        if (!Array.isArray(op.proposedValue)) { return 'reorder requires an array of page ids'; }
        break;
      case 'set_theme':
      case 'set_format':
      case 'edit_page':
      case 'edit_element':
      case 'add_asset':
        if (!op.proposedValue || typeof op.proposedValue !== 'object') {
          return `${op.kind} requires an object payload`;
        }
        break;
    }
    return null;
  }

  private _isStale(artifact: CanvasArtifact, op: CanvasOp): boolean {
    if (typeof op.baseVersion !== 'number' || !op.targetPageId) { return false; }
    const page = this._store.getPage(artifact, op.targetPageId);
    if (!page) { return false; }
    return page.version !== op.baseVersion;
  }

  // ========================================================================
  // Apply / revert — capture previousValue for undo
  // ========================================================================

  /** Mutate the artifact for an op; returns the affected page id (if any). */
  private _apply(artifact: CanvasArtifact, op: CanvasOp): string | undefined {
    switch (op.kind) {
      case 'insert_page': {
        // The author supplies page content fields (no canonical id/version);
        // makePage assigns them so insert/undo can address the exact page.
        const raw = op.proposedValue as Partial<ArtifactPage> & { mode: ArtifactPage['mode']; index?: number };
        const page = this._store.insertPage(artifact, this._store.makePage(raw), raw.index);
        op.targetPageId = page.id;
        op.previousValue = null;
        return page.id;
      }
      case 'edit_page': {
        const patch = op.proposedValue as Partial<ArtifactPage>;
        const page = this._store.getPage(artifact, op.targetPageId!);
        if (page) {
          op.previousValue = this._snapshotKeys(page, patch);
        }
        this._store.updatePage(artifact, op.targetPageId!, patch);
        return op.targetPageId;
      }
      case 'delete_page': {
        const idx = artifact.pages.findIndex(p => p.id === op.targetPageId);
        const page = this._store.getPage(artifact, op.targetPageId!);
        op.previousValue = page ? { page: this._clone(page), index: idx } : null;
        this._store.deletePage(artifact, op.targetPageId!);
        return op.targetPageId;
      }
      case 'reorder': {
        op.previousValue = artifact.pages.map(p => p.id);
        this._store.reorderPages(artifact, op.proposedValue as string[]);
        return undefined;
      }
      case 'set_theme': {
        op.previousValue = this._clone(artifact.theme);
        this._store.setTheme(artifact, op.proposedValue as DesignTheme);
        return undefined;
      }
      case 'set_format': {
        op.previousValue = this._clone(artifact.format);
        this._store.setFormat(artifact, op.proposedValue as CanvasFormatSpec);
        return undefined;
      }
      case 'edit_element': {
        const { path, override } = op.proposedValue as { path: string; override: ElementOverride };
        const page = this._store.getPage(artifact, op.targetPageId!);
        const overrides = { ...(page?.elementOverrides ?? {}) };
        op.previousValue = { path, override: overrides[path] ?? null };
        overrides[path] = override;
        this._store.updatePage(artifact, op.targetPageId!, { elementOverrides: overrides });
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

  /** Reverse an applied op using its captured previousValue. */
  private _revert(artifact: CanvasArtifact, op: CanvasOp): string | undefined {
    switch (op.kind) {
      case 'insert_page': {
        if (op.targetPageId) { this._store.deletePage(artifact, op.targetPageId); }
        return op.targetPageId;
      }
      case 'edit_page': {
        if (op.previousValue && op.targetPageId) {
          this._store.updatePage(artifact, op.targetPageId, op.previousValue as Partial<ArtifactPage>);
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
      case 'edit_element': {
        const prev = op.previousValue as { path: string; override: ElementOverride | null } | null;
        const page = op.targetPageId ? this._store.getPage(artifact, op.targetPageId) : undefined;
        if (prev && page) {
          const overrides = { ...(page.elementOverrides ?? {}) };
          if (prev.override === null) { delete overrides[prev.path]; }
          else { overrides[prev.path] = prev.override; }
          this._store.updatePage(artifact, op.targetPageId!, { elementOverrides: overrides });
        }
        return op.targetPageId;
      }
      case 'add_asset': {
        const prev = op.previousValue as { assetId: string } | null;
        if (prev) { artifact.assets = artifact.assets.filter(a => a.id !== prev.assetId); }
        return undefined;
      }
    }
    return undefined;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /** Snapshot only the keys a patch touches, for a precise undo. */
  private _snapshotKeys(page: ArtifactPage, patch: Partial<ArtifactPage>): Partial<ArtifactPage> {
    const snap: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      if (key === 'id' || key === 'version') { continue; }
      snap[key] = this._clone((page as unknown as Record<string, unknown>)[key]);
    }
    return snap as Partial<ArtifactPage>;
  }

  private _clone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }
}
