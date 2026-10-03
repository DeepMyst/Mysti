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
 * Plan 22 §4 row 4 — inline text editing. Previously: nonexistent.
 *
 * The round trip, and why each half sits where it does:
 *
 * ```
 *  double-click ──▶ handleHit ──▶ beginTextEdit {mid} ──▶ harness marks the node
 *                                    (down the frame port)   contenteditable
 *  Enter / blur ◀── textCommit {mid,text} ◀── harness (Escape sends NOTHING)
 *       │
 *       └──▶ commit(): validate PARENT-side ──▶ el.setText ──▶ CanvasOpExecutor
 * ```
 *
 * **Why there is no source surgery.** Text lives in `DocNode.text`, so a commit
 * is `el.setText` on one mid. The alternative — splicing a string back into
 * `jsxSource` — is ambiguous by construction (which of four identical `"Sign
 * in"` literals did the user edit?), and it is why inline editing never existed
 * on the blob engine rather than merely being unimplemented.
 *
 * **The frame is not trusted.** The harness renders MODEL-AUTHORED content, so
 * everything arriving over the port is data, not fact. `parseFrameUpMessage`
 * (host side, `CanvasSandbox.ts`) has already normalized shape and capped size;
 * this module adds the three checks that need *editor* state to make:
 *
 * 1. **Provenance** — a commit is accepted only for the node the user actually
 *    opened. A page that fabricates `textCommit {mid: someOtherNode}` is
 *    refused, so a prompt-injected design cannot rewrite a *different* element
 *    (and, because a human-authored `el.setText` PINS the cell, cannot use the
 *    human's authority to make that cell agent-proof either).
 * 2. **Editability** — the target must still exist in the doc and must still be
 *    a text leaf; `el.setText` on a container throws in `DocPatch`.
 * 3. **Content** — {@link sanitizeCommittedText} strips invisible characters
 *    (C0/C1 controls, bidi overrides, zero-widths) and caps length. Nothing
 *    interprets the result as markup anywhere: `preview.ts` writes `textContent`
 *    and the harness sets a text node, so the value is inert by construction.
 */

import type { CanvasOp } from '../../canvas/CanvasOps';
import type { DocNode, Mid } from '../../canvas/doc/DocNode';
import { supportsTextEditing } from '../../canvas/UiSchema';
import type { FrameDownMessage } from '../../managers/CanvasSandbox';
import { CONTROL_MAX_TEXT, TxnEmitter, clampControlText, type OpSubmission } from './controls';

/** Hard ceiling on a committed string, independent of the frame's own cap. */
export const TEXT_EDIT_MAX_LENGTH = CONTROL_MAX_TEXT;

/**
 * How many superseded edits still accept a late commit.
 *
 * The harness ends an open edit *before* it opens the next one, so starting a
 * second edit produces a `textCommit` for the FIRST node after `active` has
 * already moved on. Refusing it on provenance grounds would silently discard
 * real typing — so a small, bounded tail of just-closed edits stays acceptable.
 */
const CLOSING_TAIL = 4;

export interface ActiveTextEdit {
  pageId: string;
  mid: Mid;
  startedAt: number;
}

export type TextCommitRefusal =
  /** No edit is open and none just closed. */
  | 'no-active-edit'
  /** A commit for a node the user never opened — a forged or stale frame. */
  | 'foreign-edit'
  /** The mid is not in the doc any more (an agent removed it mid-edit). */
  | 'unknown-node'
  /** The node is a container / a primitive that does not render `text`. */
  | 'not-text'
  | 'not-a-string'
  /** Identical to what is already stored — no op, so no journal entry, no pin. */
  | 'unchanged';

export type TextCommitOutcome =
  | { ok: true; text: string; ops: CanvasOp[] }
  | { ok: false; reason: TextCommitRefusal };

export interface InlineTextEditorOptions {
  /** Post a down-message into that artboard's frame port. */
  sendToFrame(pageId: string, message: FrameDownMessage): void;
  /** Submit ops over `canvas/submit`; the host stamps `author: 'user'`. */
  submit(submission: OpSubmission): void;
  /**
   * Mirror of `canvas/editing`: while a node is being typed into, the executor
   * parks agent ops in that subtree instead of overwriting the caret.
   */
  onEditingChange?(pageId: string, mids: Mid[], editing: boolean): void;
  newTxnId?: () => string;
  now?: () => number;
  maxLength?: number;
  warn?(message: string, ...rest: unknown[]): void;
}

/**
 * The parent half of inline editing. Owns *which* node is being edited and
 * whether a commit may become an op; the caret, the selection and the
 * `contenteditable` attribute live in the frame, where the text actually is.
 */
export class InlineTextEditor {
  private readonly _sendToFrame: (pageId: string, message: FrameDownMessage) => void;
  private readonly _onEditingChange:
  ((pageId: string, mids: Mid[], editing: boolean) => void) | null;
  private readonly _now: () => number;
  private readonly _maxLength: number;
  private readonly _warn: (message: string, ...rest: unknown[]) => void;
  private readonly _txn: TxnEmitter;

  private _active: ActiveTextEdit | null = null;
  /** Recently superseded edits that may still deliver a commit. */
  private _closing: ActiveTextEdit[] = [];

  constructor(opts: InlineTextEditorOptions) {
    this._sendToFrame = opts.sendToFrame;
    this._onEditingChange = opts.onEditingChange ?? null;
    this._now = opts.now ?? (() => Date.now());
    this._maxLength = opts.maxLength ?? TEXT_EDIT_MAX_LENGTH;
    this._warn = opts.warn ?? (() => { /* silent */ });
    this._txn = new TxnEmitter({
      emit: opts.submit,
      newTxnId: opts.newTxnId,
      // A text commit is one discrete edit; there is no gesture to coalesce.
      throttleMs: 0,
      now: this._now,
    });
  }

  get active(): ActiveTextEdit | null { return this._active; }

  /** True when this exact node is the one being typed into. */
  isEditing(pageId: string, mid: Mid): boolean {
    return !!this._active && this._active.pageId === pageId && this._active.mid === mid;
  }

  /**
   * A `hit` from the frame. A double-click on a text leaf opens the editor; a
   * single click is selection and is left to the board.
   *
   * @returns true when this hit started an edit.
   */
  handleHit(pageId: string, mid: Mid, node: DocNode | null, double: boolean): boolean {
    if (!double) { return false; }
    return this.begin(pageId, mid, node);
  }

  /**
   * Open an inline edit. Refuses anything `el.setText` could not commit, rather
   * than putting a caret in a node whose commit will be rejected later.
   */
  begin(pageId: string, mid: Mid, node: DocNode | null): boolean {
    if (typeof pageId !== 'string' || pageId.length === 0) { return false; }
    if (!node || node.mid !== mid) {
      this._warn('canvas: refusing inline edit for an unknown node', pageId, mid);
      return false;
    }
    if (!isTextLeaf(node)) {
      this._warn('canvas: refusing inline edit on a non-text node', node.tag);
      return false;
    }
    if (this.isEditing(pageId, mid)) { return true; }

    // The harness closes the previous edit itself; remember it so the commit it
    // is about to post is still accepted.
    if (this._active) { this._remember(this._active); this._notify(this._active, false); }

    const edit: ActiveTextEdit = { pageId, mid, startedAt: this._now() };
    this._active = edit;
    this._sendToFrame(pageId, { t: 'beginTextEdit', mid });
    this._notify(edit, true);
    return true;
  }

  /**
   * A `textCommit` arriving from the frame.
   *
   * `node` is the doc's current node for `mid` — the caller resolves it from
   * the store, because the store is the authority on what exists, not the page.
   */
  commit(pageId: string, mid: Mid, rawText: unknown, node: DocNode | null): TextCommitOutcome {
    if (typeof rawText !== 'string') { return { ok: false, reason: 'not-a-string' }; }

    const claim = this._claim(pageId, mid);
    if (claim === 'none') { return { ok: false, reason: 'no-active-edit' }; }
    if (claim === 'foreign') {
      this._warn('canvas: dropped a text commit for a node that was never opened', pageId, mid);
      return { ok: false, reason: 'foreign-edit' };
    }

    if (!node || node.mid !== mid) {
      this._close(pageId, mid);
      return { ok: false, reason: 'unknown-node' };
    }
    if (!isTextLeaf(node)) {
      this._close(pageId, mid);
      return { ok: false, reason: 'not-text' };
    }

    const text = sanitizeCommittedText(rawText, this._maxLength);
    if (text === null) {
      this._close(pageId, mid);
      return { ok: false, reason: 'not-a-string' };
    }
    if (text === (node.text ?? '')) {
      this._close(pageId, mid);
      return { ok: false, reason: 'unchanged' };
    }

    const ops: CanvasOp[] = [{ op: 'el.setText', pageId, mid, text }];
    this._close(pageId, mid);
    this._txn.commit(ops);
    return { ok: true, text, ops };
  }

  /**
   * Abandon the open edit without committing — Escape (the frame restores the
   * original text itself and posts nothing), a selection change, or an artboard
   * that stopped being live.
   */
  cancel(): void {
    const active = this._active;
    if (!active) { return; }
    this._active = null;
    this._closing = [];
    this._notify(active, false);
  }

  /* ------------------------------ internals ------------------------------ */

  private _claim(pageId: string, mid: Mid): 'active' | 'closing' | 'foreign' | 'none' {
    if (this._active) {
      if (this._active.pageId === pageId && this._active.mid === mid) { return 'active'; }
    }
    if (this._closing.some(e => e.pageId === pageId && e.mid === mid)) { return 'closing'; }
    return this._active || this._closing.length > 0 ? 'foreign' : 'none';
  }

  private _remember(edit: ActiveTextEdit): void {
    this._closing.push(edit);
    if (this._closing.length > CLOSING_TAIL) { this._closing.shift(); }
  }

  private _close(pageId: string, mid: Mid): void {
    this._closing = this._closing.filter(e => !(e.pageId === pageId && e.mid === mid));
    const active = this._active;
    if (active && active.pageId === pageId && active.mid === mid) {
      this._active = null;
      this._notify(active, false);
    }
  }

  private _notify(edit: ActiveTextEdit, editing: boolean): void {
    this._onEditingChange?.(edit.pageId, [edit.mid], editing);
  }
}

/* ------------------------------ validation ------------------------------ */

/** A node whose content is a text leaf, i.e. something `el.setText` can write. */
export function isTextLeaf(node: DocNode | null | undefined): boolean {
  if (!node || typeof node.tag !== 'string') { return false; }
  if (node.children && node.children.length > 0) { return false; }
  return supportsTextEditing(node.tag);
}

/**
 * Normalize a string that came out of a sandboxed frame.
 *
 * `contenteditable` produces `\r\n` on some platforms and can carry invisible
 * characters that were pasted in; both are normalized away. The result is never
 * parsed as markup by anything downstream, so escaping is neither needed nor
 * attempted — the value is stored verbatim and painted with `textContent`.
 *
 * @returns the text to write, or `null` when the input is not a string at all.
 */
export function sanitizeCommittedText(
  raw: unknown,
  max: number = TEXT_EDIT_MAX_LENGTH,
): string | null {
  if (typeof raw !== 'string') { return null; }
  const normalized = raw.replace(/\r\n?/g, '\n');
  return clampControlText(normalized, max);
}
