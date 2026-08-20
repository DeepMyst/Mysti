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
 * Plan 22 §4 rows 5 and 6 — undo/redo in the UI, and the version timeline.
 *
 * ## One shared stack. This is a design commitment, not an implementation detail.
 *
 * Cmd+Z means "undo the last thing that happened", whoever did it. There is no
 * "my changes" stack and no "the agent's changes" stack, because in a co-edited
 * document those two orders are not independent — an agent edit to a node a
 * human then moved cannot be reverted without the move, and any UI that offers
 * to try is lying about what it will do. So: one cursor, in
 * {@link CanvasHistory}, over one op log, fed by every transport.
 *
 * Grouping follows from the same commitment. One human drag is one restore
 * point (the gesture opens a transaction). **One agent turn is one restore
 * point**, keyed by `runId` — so Cmd+Z after a bad design pass reverts the
 * whole pass, not the last of its forty element ops.
 *
 * ## The agent deliberately gets no undo tool
 *
 * An agent that can revert the human's work is a hazard: undo is not scoped to
 * the agent's own edits (see above — it cannot be), so an "undo" tool call is
 * an unbounded revert of whatever happened most recently, triggerable by a
 * prompt injection in a page the model just read. The agent corrects by editing
 * FORWARD. Nothing in this module sends an op on the agent's behalf, and
 * nothing here should ever be reachable from a tool dispatch.
 *
 * ## Why the button states come from the host
 *
 * `canUndo()`/`canRedo()` are decided by `CanvasHistory`, over the real op log,
 * and pushed here as a {@link CanvasHistoryStatus}. The webview keeps NO mirror
 * of the undo stack: it never sees ops that arrive over MCP from a CLI backend,
 * over a `<canvas:NONCE>` directive, or from a detached background job, so a
 * client-side cursor would be confidently wrong in exactly the state a user
 * reaches for Cmd+Z in.
 */

import type {
  CanvasHistoryStatus,
  CanvasHistoryTxnView,
  CanvasVersionView,
} from '../../canvas/CanvasHistory';
import type { CanvasOpKind } from '../../types';
import type { CanvasEnv, DomElement } from './dom';
import { drawPreview } from './preview';
import type { CanvasClientBody } from './protocolClient';

/* ------------------------------- shortcuts ------------------------------- */

export type HistoryAction = 'undo' | 'redo';
export type HistoryPlatform = 'mac' | 'other';

/** The slice of a `KeyboardEvent` this module reads. */
export interface KeyLikeEvent {
  key?: unknown;
  /** Layout-independent fallback: a Dvorak/AZERTY user still gets Cmd+Z. */
  code?: unknown;
  metaKey?: unknown;
  ctrlKey?: unknown;
  shiftKey?: unknown;
  altKey?: unknown;
  target?: unknown;
  preventDefault?: unknown;
  stopPropagation?: unknown;
}

/**
 * Which modifier means "application command" on this machine.
 *
 * Read from `navigator`, injected rather than sniffed at import time so the
 * mapping is testable on both platforms from one process.
 */
export function detectPlatform(nav: { platform?: unknown; userAgent?: unknown } | null | undefined): HistoryPlatform {
  const text = `${typeof nav?.platform === 'string' ? nav.platform : ''} ${typeof nav?.userAgent === 'string' ? nav.userAgent : ''}`;
  return /\bMac|iPhone|iPad|iPod/i.test(text) ? 'mac' : 'other';
}

/** Element names whose own undo stack must win over the canvas's. */
const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * True when the key event is going to a text field or an inline text edit.
 *
 * Inline artboard editing is `contenteditable` (§4 row 4), and a Cmd+Z there
 * must undo the typing — not silently revert the agent's last design pass
 * because the canvas grabbed the chord first.
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') { return false; }
  const el = target as { tagName?: unknown; isContentEditable?: unknown; contentEditable?: unknown };
  if (el.isContentEditable === true) { return true; }
  if (typeof el.contentEditable === 'string' && el.contentEditable.toLowerCase() === 'true') { return true; }
  return typeof el.tagName === 'string' && EDITABLE_TAGS.has(el.tagName.toUpperCase());
}

/** A Latin letter the user actually produced — `key` is authoritative for these. */
const LATIN_LETTER = /^[a-z]$/;

function isLetterKey(ev: KeyLikeEvent, letter: 'z' | 'y', code: 'KeyZ' | 'KeyY'): boolean {
  const key = typeof ev.key === 'string' ? ev.key.toLowerCase() : '';
  if (key === letter) { return true; }
  // A DIFFERENT Latin letter means a deliberate remap — honouring `code` there
  // would fire undo on whatever key happens to sit in the physical Z position.
  if (LATIN_LETTER.test(key)) { return false; }
  // Non-Latin layout (Cyrillic, Greek, …) or a dead key: `code` is all there is.
  return ev.code === code;
}

function isZ(ev: KeyLikeEvent): boolean { return isLetterKey(ev, 'z', 'KeyZ'); }

function isY(ev: KeyLikeEvent): boolean { return isLetterKey(ev, 'y', 'KeyY'); }

/**
 * Map a keydown to an undo/redo intent, or `null`.
 *
 * Platform-exact rather than permissive: on macOS the command modifier is Meta
 * and Ctrl+Z is NOT undo (it is the terminal's suspend chord, and honouring it
 * inside a design surface surprises people); on Windows/Linux the modifier is
 * Ctrl and Meta is the OS key, which must not trigger a document mutation.
 * `Alt` disqualifies everywhere — Alt chords belong to the OS and to IME.
 */
export function matchHistoryShortcut(ev: KeyLikeEvent, platform: HistoryPlatform): HistoryAction | null {
  if (ev.altKey === true) { return null; }
  if (isEditableTarget(ev.target)) { return null; }
  const meta = ev.metaKey === true;
  const ctrl = ev.ctrlKey === true;
  const shift = ev.shiftKey === true;

  if (platform === 'mac') {
    if (!meta || ctrl) { return null; }
    if (!isZ(ev)) { return null; }
    return shift ? 'redo' : 'undo';
  }
  if (!ctrl || meta) { return null; }
  // Ctrl+Y is the Windows redo chord; it carries no shift.
  if (isY(ev)) { return shift ? null : 'redo'; }
  if (!isZ(ev)) { return null; }
  return shift ? 'redo' : 'undo';
}

/** The typed client message an intent produces. The ONLY two this module sends. */
export function historyMessageFor(action: HistoryAction): CanvasClientBody {
  return action === 'undo' ? { t: 'canvas/undo' } : { t: 'canvas/redo' };
}

/** Human-readable chord, for button tooltips. */
export function shortcutChord(action: HistoryAction, platform: HistoryPlatform): string {
  if (platform === 'mac') { return action === 'undo' ? '⌘Z' : '⇧⌘Z'; }
  return action === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
}

/* --------------------------------- labels --------------------------------- */

/**
 * Op vocabulary → UI copy. Declared as a total `Record` so a new op kind is a
 * `tsc` failure here rather than an empty string in a tooltip.
 */
const KIND_VERBS: Readonly<Record<CanvasOpKind, string>> = {
  insert_page: 'added an artboard',
  edit_page: 'edited an artboard',
  delete_page: 'deleted an artboard',
  reorder: 'reordered artboards',
  set_theme: 'changed the theme',
  set_format: 'changed the format',
  edit_element: 'edited an element',
  add_asset: 'added an asset',
};

export function kindsSummary(kinds: readonly CanvasOpKind[]): string {
  if (kinds.length === 0) { return 'made a change'; }
  const head = KIND_VERBS[kinds[0]] ?? 'made a change';
  return kinds.length > 1 ? `${head} +${kinds.length - 1} more` : head;
}

/** One undo step, as a sentence: `Mysti · edited an artboard · 4 ops`. */
export function txnSummary(txn: CanvasHistoryTxnView | undefined): string {
  if (!txn) { return ''; }
  const actor = txn.author === 'agent' ? 'Mysti' : 'You';
  const label = typeof txn.label === 'string' ? txn.label.trim() : '';
  const what = label || kindsSummary(txn.kinds);
  const count = txn.opCount > 1 ? ` · ${txn.opCount} ops` : '';
  return `${actor} · ${what}${count}`;
}

export interface HistoryButtonState {
  undoDisabled: boolean;
  redoDisabled: boolean;
  undoTitle: string;
  redoTitle: string;
}

/**
 * "What just happened, and who did it" — the persistent attribution line.
 *
 * The undo stack's TOP entry is, by construction, the last thing that landed on
 * this design from any transport, so it is also the cheapest honest answer to
 * "did Mysti just change something?". One agent turn is one transaction
 * (`runId` grouping), so this reads `Mysti · redesigned the settings screen ·
 * 12 ops` rather than naming the last of forty element ops.
 *
 * Returns `null` when there is nothing to attribute — the caller hides the row
 * rather than printing an empty one.
 */
export function lastChangeSummary(status: CanvasHistoryStatus | null): { text: string; author: string } | null {
  const txn = status?.undo;
  if (!txn) { return null; }
  const summary = txnSummary(txn);
  if (!summary) { return null; }
  return { text: summary, author: txn.author === 'agent' ? 'agent' : 'user' };
}

/**
 * Button state from the host's snapshot.
 *
 * A `null` status (before the first push) disables both buttons: an enabled
 * button that does nothing is a worse lie than a disabled one that lights up a
 * moment later. The KEY BINDING deliberately does not follow that rule — see
 * {@link HistoryUi}.
 */
export function historyButtonState(
  status: CanvasHistoryStatus | null,
  platform: HistoryPlatform,
): HistoryButtonState {
  const undoChord = shortcutChord('undo', platform);
  const redoChord = shortcutChord('redo', platform);
  const canUndo = status?.canUndo === true;
  const canRedo = status?.canRedo === true;
  return {
    undoDisabled: !canUndo,
    redoDisabled: !canRedo,
    undoTitle: canUndo ? `Undo ${txnSummary(status?.undo)} (${undoChord})` : `Nothing to undo (${undoChord})`,
    redoTitle: canRedo ? `Redo ${txnSummary(status?.redo)} (${redoChord})` : `Nothing to redo (${redoChord})`,
  };
}

/** Compact relative age for a version row. */
export function formatAge(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) { return 'just now'; }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) { return `${minutes}m ago`; }
  const hours = Math.round(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }
  return `${Math.round(hours / 24)}d ago`;
}

/** The default name for a checkpoint the user did not name. */
export function defaultVersionLabel(count: number): string {
  return `Version ${count + 1}`;
}

/* ------------------------------- controller ------------------------------- */

export interface HistoryUiOptions {
  env: CanvasEnv;
  /** The only outbound path — `CanvasProtocolClient.send`. */
  send: (body: CanvasClientBody) => void;
  /** Host for the undo / redo / save-version buttons. */
  toolbar?: DomElement | null;
  /** Host for the version timeline. */
  timeline?: DomElement | null;
  platform?: HistoryPlatform;
  resolveAsset?: (ref: string) => string | null;
  thumbWidth?: number;
  /**
   * Ask the human to name a checkpoint. Returning `null` cancels the save.
   * Injected because a webview has no `window.prompt` worth using and because
   * the naming affordance belongs to the shell, not to this controller.
   */
  requestLabel?: (suggestion: string) => string | null;
}

/** Version timeline thumbnails render at this width. */
export const VERSION_THUMB_WIDTH = 108;

export class HistoryUi {
  private readonly _env: CanvasEnv;
  private readonly _send: (body: CanvasClientBody) => void;
  private readonly _toolbar: DomElement | null;
  private readonly _timeline: DomElement | null;
  private readonly _platform: HistoryPlatform;
  private readonly _resolveAsset: (ref: string) => string | null;
  private readonly _thumbWidth: number;
  private readonly _requestLabel: (suggestion: string) => string | null;

  private _status: CanvasHistoryStatus | null = null;
  private _undoBtn: DomElement | null = null;
  private _redoBtn: DomElement | null = null;
  private _saveBtn: DomElement | null = null;
  /** "Mysti · edited an artboard · 4 ops" — persistent, not a toast. */
  private _lastEl: DomElement | null = null;
  private _disposed = false;

  constructor(opts: HistoryUiOptions) {
    this._env = opts.env;
    this._send = opts.send;
    this._toolbar = opts.toolbar ?? null;
    this._timeline = opts.timeline ?? null;
    this._platform = opts.platform ?? 'other';
    this._resolveAsset = opts.resolveAsset ?? (() => null);
    this._thumbWidth = opts.thumbWidth ?? VERSION_THUMB_WIDTH;
    this._requestLabel = opts.requestLabel ?? (suggestion => suggestion);

    this._buildToolbar();
    this._env.self.addEventListener('keydown', ev => this.handleKey(ev as KeyLikeEvent));
    this._render();
  }

  /** The last status the host pushed. */
  status(): CanvasHistoryStatus | null { return this._status; }

  /** `canvas/history` (or any host push carrying the snapshot) lands here. */
  setStatus(status: CanvasHistoryStatus | null): void {
    this._status = status;
    this._render();
  }

  /**
   * Keydown front door.
   *
   * @returns the action taken, or `null` when the event was not ours.
   *
   * Note the asymmetry with the buttons: an unknown status (no push yet) still
   * SENDS. A keybinding that silently swallows Cmd+Z during the first seconds
   * after a reload is indistinguishable from a broken undo, whereas an
   * unnecessary `canvas/undo` is a host-side no-op that costs one message.
   */
  handleKey(ev: KeyLikeEvent): HistoryAction | null {
    if (this._disposed) { return null; }
    const action = matchHistoryShortcut(ev, this._platform);
    if (!action) { return null; }
    if (this._status && !(action === 'undo' ? this._status.canUndo : this._status.canRedo)) {
      // Known-empty stack: still consume the chord so the webview does not fall
      // through to a host default that would undo something else entirely.
      preventDefault(ev);
      return null;
    }
    preventDefault(ev);
    this._send(historyMessageFor(action));
    return action;
  }

  /** Save a named checkpoint. Exposed so the shell can bind its own control. */
  saveVersion(): void {
    const suggestion = defaultVersionLabel(this._status?.versions.length ?? 0);
    const label = this._requestLabel(suggestion);
    if (label === null) { return; }
    const trimmed = label.trim().slice(0, 120) || suggestion;
    this._send({ t: 'canvas/checkpoint', label: trimmed });
  }

  /**
   * Restore a checkpoint.
   *
   * The host answers by EMITTING OPS through the executor rather than by
   * assigning the snapshot back onto the artifact — so the restore lands in the
   * op log, re-renders through the same delta path as any other edit, and is
   * itself one undoable transaction. "Restore" is not an escape from history;
   * it is a move within it.
   */
  restore(ref: string): void {
    if (typeof ref !== 'string' || ref.length === 0) { return; }
    this._send({ t: 'canvas/restore', ref });
  }

  dispose(): void {
    this._disposed = true;
  }

  /* ------------------------------- rendering ------------------------------- */

  private _buildToolbar(): void {
    const host = this._toolbar;
    if (!host) { return; }
    host.replaceChildren();
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'History');
    this._undoBtn = this._button('Undo', 'history-btn undo', 'undo', () => {
      if (this._status && !this._status.canUndo) { return; }
      this._send(historyMessageFor('undo'));
    });
    this._undoBtn.setAttribute('aria-keyshortcuts', this._platform === 'mac' ? 'Meta+Z' : 'Control+Z');
    this._redoBtn = this._button('Redo', 'history-btn redo', 'redo', () => {
      if (this._status && !this._status.canRedo) { return; }
      this._send(historyMessageFor('redo'));
    });
    this._redoBtn.setAttribute(
      'aria-keyshortcuts', this._platform === 'mac' ? 'Meta+Shift+Z' : 'Control+Shift+Z',
    );
    this._saveBtn = this._button('Save version', 'history-btn save', 'save', () => this.saveVersion());
    host.appendChild(this._undoBtn);
    host.appendChild(this._redoBtn);
    host.appendChild(this._saveBtn);

    // Persistent attribution: what landed last, and whether it was Mysti.
    this._lastEl = this._env.doc.createElement('span');
    this._lastEl.className = 'history-last';
    this._lastEl.hidden = true;
    host.appendChild(this._lastEl);
  }

  /**
   * One toolbar control.
   *
   * The visible word lives in a `.btn-label` span and the button carries a
   * `data-icon`, so a stylesheet can draw a real icon and hide the word — while
   * a shell that has not styled it yet still shows a readable, operable button
   * instead of an empty square. The `aria-label` is set unconditionally,
   * because "accessible only when the CSS happens to be text" is not
   * accessible.
   */
  private _button(label: string, className: string, icon: string, onClick: () => void): DomElement {
    const button = this._env.doc.createElement('button');
    button.className = className;
    button.setAttribute('type', 'button');
    button.setAttribute('data-icon', icon);
    button.setAttribute('aria-label', label);
    const text = this._env.doc.createElement('span');
    text.className = 'btn-label';
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener('click', () => { if (!this._disposed) { onClick(); } });
    return button;
  }

  private _render(): void {
    const state = historyButtonState(this._status, this._platform);
    applyDisabled(this._undoBtn, state.undoDisabled, state.undoTitle);
    applyDisabled(this._redoBtn, state.redoDisabled, state.redoTitle);
    if (this._saveBtn) { this._saveBtn.setAttribute('title', 'Save a named version you can restore later'); }
    const last = lastChangeSummary(this._status);
    if (this._lastEl) {
      this._lastEl.hidden = last === null;
      this._lastEl.textContent = last ? last.text : '';
      if (last) {
        this._lastEl.setAttribute('data-author', last.author);
        this._lastEl.setAttribute('title', `Last change · ${last.text}`);
      } else {
        this._lastEl.removeAttribute('data-author');
      }
    }
    this._renderTimeline();
  }

  private _renderTimeline(): void {
    const host = this._timeline;
    if (!host) { return; }
    host.replaceChildren();
    host.setAttribute('role', 'list');
    host.setAttribute('aria-label', 'Saved versions');
    const versions = this._status?.versions ?? [];
    if (versions.length === 0) {
      const empty = this._env.doc.createElement('div');
      empty.className = 'version-empty';
      empty.setAttribute('role', 'listitem');
      empty.textContent = 'No saved versions yet. Save one before a big design pass.';
      host.appendChild(empty);
      return;
    }
    // Newest first: the version a human wants is almost always the last one.
    for (let i = versions.length - 1; i >= 0; i--) {
      host.appendChild(this._renderVersion(versions[i], i));
    }
  }

  private _renderVersion(version: CanvasVersionView, index: number): DomElement {
    const doc = this._env.doc;
    const row = doc.createElement('div');
    row.className = 'version-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-ref', version.id);

    const frame = doc.createElement('div');
    frame.className = 'version-thumb';
    const format = version.thumbFormat;
    if (version.thumbDoc && format && format.width > 0) {
      const scale = this._thumbWidth / format.width;
      frame.style.setProperty('width', `${this._thumbWidth}px`);
      frame.style.setProperty('height', `${Math.round(format.height * scale)}px`);
      frame.style.setProperty('overflow', 'hidden');
      const tile = doc.createElement('div');
      tile.style.setProperty('width', `${format.width}px`);
      tile.style.setProperty('height', `${format.height}px`);
      tile.style.setProperty('transform', `scale(${scale.toFixed(4)})`);
      tile.style.setProperty('transform-origin', 'top left');
      // Same parent-side renderer as the rail: no iframe, no scripts, and a
      // past version of a prompt-injected artboard is exactly as inert as a
      // current one.
      drawPreview(tile, version.thumbDoc, doc, { resolveAsset: this._resolveAsset });
      frame.appendChild(tile);
    } else {
      frame.className = 'version-thumb empty';
      frame.textContent = '—';
    }
    row.appendChild(frame);

    const meta = doc.createElement('div');
    meta.className = 'version-meta';
    const label = doc.createElement('span');
    label.className = 'version-label';
    label.textContent = version.label;
    meta.appendChild(label);
    const sub = doc.createElement('span');
    sub.className = 'version-sub';
    const pages = version.pageCount === 1 ? '1 artboard' : `${version.pageCount} artboards`;
    sub.textContent = `${pages} · ${formatAge(version.ts, this._env.now())}`;
    meta.appendChild(sub);
    row.appendChild(meta);

    const restore = doc.createElement('button');
    restore.className = 'version-restore';
    restore.setAttribute('type', 'button');
    restore.textContent = 'Restore';
    restore.setAttribute('title', `Restore "${version.label}" — itself undoable`);
    restore.setAttribute('aria-label', `Restore version "${version.label}"`);
    restore.setAttribute('data-index', String(index));
    restore.addEventListener('click', () => this.restore(version.id));
    row.appendChild(restore);
    return row;
  }
}

/* -------------------------------- helpers -------------------------------- */

function applyDisabled(button: DomElement | null, disabled: boolean, title: string): void {
  if (!button) { return; }
  if (disabled) { button.setAttribute('disabled', 'true'); } else { button.removeAttribute('disabled'); }
  button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  button.setAttribute('title', title);
}

function preventDefault(ev: KeyLikeEvent): void {
  if (typeof ev.preventDefault === 'function') { (ev.preventDefault as () => void).call(ev); }
}
