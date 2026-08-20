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
 * Plan 22 §4 row 3 — the properties panel.
 *
 * What this replaces: five static `<span>` rows and nine inert swatches
 * (`media/canvas/canvas.js:181-206`) — **zero `<input>` elements in the entire
 * shell** — writing an op (`edit_element` → `elementOverrides`) that had zero
 * renderers. Reading a value out of a design and never being able to change it
 * is not a properties panel; it is a caption.
 *
 * This file is deliberately the THIN half. Every decision — which controls
 * exist, what a multi-selection shows, what a value coerces to, which op is
 * emitted, how a drag becomes one undo step — lives in `controls.ts` as pure
 * functions over `UiSchema`. Here there is only DOM: create the widget the
 * descriptor names, read what the user did, hand it back.
 *
 * Three properties worth stating plainly:
 *
 * - **No raw CSS field exists.** You cannot type `position: fixed` into this
 *   panel, because no control is generated for a property `UiSchema` does not
 *   declare, and every value still passes the renderer's own sanitizer on the
 *   way out (`controlOps`). The panel's vocabulary is the schema's vocabulary.
 * - **Every write is an op.** There is no local mutation path at all: the only
 *   thing a handler can do is call {@link InspectorCallbacks.submit} with the
 *   same `el.setProp`/`el.setStyle`/`el.setText` an agent tool produces. Those
 *   arrive over `canvas/submit`, where the host stamps `author: 'user'` — which
 *   is what makes the executor PIN the cells the human touched, and is why the
 *   next whole-page agent rewrite cannot revert them.
 * - **Pins are visible and reversible.** A pinned cell shows a dot with an
 *   unpin affordance, and the header carries the bulk "let the agent restyle
 *   everything" release, because a rule the user cannot see or undo is a trap
 *   (§3.5.5, risk 3).
 *
 * `DomElement` has no `innerHTML` — see `dom.ts`. Nothing here parses a string
 * into DOM; labels and values are `textContent` and attributes only.
 */

import type { DesignTheme } from '../../types';
import type { DocNode, JsonValue, Mid, PinCell } from '../../canvas/doc/DocNode';
import { asValueElement, type CanvasEnv, type DomElement, type DomValueElement } from './dom';
import { sanitizeStyleValue } from './preview';
import {
  DEFAULT_DRAG_THROTTLE_MS,
  TxnEmitter,
  buildControlModel,
  coerceControlInput,
  controlOps,
  countPinnedCells,
  pinnedTargetsForControl,
  pinnedTargetsForNodes,
  pinnedTargetsInDoc,
  readControlValue,
  tokenOptions,
  type CoercedValue,
  type ControlDescriptor,
  type ControlModel,
  type ControlValue,
  type OpSubmission,
  type UnpinIntent,
} from './controls';

/**
 * Document-unique ids for the label/widget association.
 *
 * Deliberately NOT derived from `control.id`: control ids come from the schema
 * keyed by a MODEL-authored prop name, and an id that a document can influence
 * is an id a document can collide (or `__proto__`) with. A counter cannot be
 * steered, and the label only ever needs the widget next to it.
 */
let controlUid = 0;
function nextControlId(): string { return `insp-ctl-${++controlUid}`; }

/** Chosen in a `<select>` to mean "leave the primitive's own default". */
export const UNSET_SENTINEL = '__mysti_unset__';
/** Present only while a value is mixed; selecting it writes nothing. */
export const MIXED_SENTINEL = '__mysti_mixed__';
/** Reveals the raw escape hatch next to a token control. */
export const CUSTOM_SENTINEL = '__mysti_custom__';

export interface InspectorSelection {
  /** The artboard the selection lives on. `null` disables every write. */
  pageId: string | null;
  mids: Mid[];
  /** The selected nodes, resolved from the store by the caller. */
  nodes: DocNode[];
  /** The page's root doc — only needed for the bulk unpin actions. */
  doc?: DocNode | null;
  /** The artifact theme, so colour controls can offer real tokens. */
  theme?: DesignTheme | null;
  /** A `legacy` page has no addressable nodes; the panel says so instead of lying. */
  legacy?: boolean;
}

export interface InspectorCallbacks {
  /** One `canvas/submit`. The host stamps `author`, `runId` and `actorId`. */
  submit(submission: OpSubmission): void;
  /**
   * Release pins the human no longer wants to own.
   *
   * Pins are written by the EXECUTOR when it commits a `author:'user'` op, and
   * the op algebra has no inverse for that, so this is an intent the host
   * fulfils — not an op this panel can mint. See the module note in the plan
   * §3.5.5 ("unpinning is a human act").
   */
  unpin(intent: UnpinIntent): void;
  /** Put the caret in the node on the canvas rather than in the panel. */
  beginTextEdit?(pageId: string, mid: Mid): void;
  /**
   * Hand this element to the steering composer ("ask Mysti to change this").
   *
   * Optional, and the affordance is drawn ONLY when it is supplied — a button
   * that does nothing is worse than no button. Wiring it to
   * `LivenessLayer.focusComment` is what makes "click an element and say what
   * you want changed" reach the running agent through `canvas/comment`, where
   * the text stays DATA (per-run inbox, fenced on the way into the model).
   */
  comment?(pageId: string, mid: Mid, label: string): void;
}

export interface InspectorOptions {
  env: CanvasEnv;
  /** The panel's mount point in the shell. Its children are owned by this class. */
  host: DomElement;
  callbacks: InspectorCallbacks;
  /** Mid-drag emission interval; see {@link TxnEmitter}. */
  throttleMs?: number;
  newTxnId?: () => string;
}

const EMPTY_SELECTION: InspectorSelection = { pageId: null, mids: [], nodes: [] };

/**
 * The generated properties panel.
 *
 * `render` is a full rebuild: the panel is small, the source of truth is the
 * store, and rebuilding removes a whole class of "the input still shows the old
 * value" bugs. The one exception is a gesture in flight — rebuilding then would
 * yank the slider out from under the pointer — so a render arriving mid-drag is
 * deferred until the transaction closes.
 */
export class InspectorPanel {
  private readonly _env: CanvasEnv;
  private readonly _host: DomElement;
  private readonly _callbacks: InspectorCallbacks;
  private readonly _txn: TxnEmitter;

  private _selection: InspectorSelection = EMPTY_SELECTION;
  private _model: ControlModel = buildControlModel([]);
  private _deferred: InspectorSelection | null = null;
  private _disposed = false;

  constructor(opts: InspectorOptions) {
    this._env = opts.env;
    this._host = opts.host;
    this._callbacks = opts.callbacks;
    this._txn = new TxnEmitter({
      emit: submission => this._callbacks.submit(submission),
      newTxnId: opts.newTxnId,
      throttleMs: opts.throttleMs ?? DEFAULT_DRAG_THROTTLE_MS,
      now: () => this._env.now(),
    });
  }

  /** The controls currently generated. Exposed for tests and for the board. */
  get model(): ControlModel { return this._model; }
  /** True while a slider drag is coalescing into one transaction. */
  get gestureActive(): boolean { return this._txn.active; }

  render(selection: InspectorSelection): void {
    if (this._disposed) { return; }
    if (this._txn.active) { this._deferred = selection; return; }
    this._selection = selection;
    this._model = buildControlModel(selection.nodes);
    this._paint();
  }

  dispose(): void {
    this._disposed = true;
    this._txn.cancel();
    this._host.replaceChildren();
  }

  /* -------------------------------- painting -------------------------------- */

  private _el(tag: string, className?: string, text?: string): DomElement {
    const node = this._env.doc.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    // A bare <button> inside a webview defaults to type="submit"; one stray
    // <form> ancestor then turns every inspector control into a navigation.
    if (tag === 'button') { node.setAttribute('type', 'button'); }
    return node;
  }

  /** An icon-only control: the glyph is decorative, the name is not optional. */
  private _iconButton(className: string, glyph: string, name: string, title: string): DomElement {
    const node = this._el('button', className);
    node.setAttribute('type', 'button');
    node.setAttribute('aria-label', name);
    node.setAttribute('title', title);
    const mark = this._el('span', 'btn-glyph', glyph);
    mark.setAttribute('aria-hidden', 'true');
    node.appendChild(mark);
    return node;
  }

  private _paint(): void {
    const host = this._host;
    host.replaceChildren();

    const selection = this._selection;
    if (selection.legacy) {
      host.setAttribute('data-empty', 'legacy');
      const note = this._el('div', 'insp-empty',
        'Code page — not directly editable. Ask Mysti in chat to rewrite it as components.');
      note.setAttribute('role', 'note');
      host.appendChild(note);
      return;
    }
    if (selection.nodes.length === 0 || !selection.pageId) {
      host.setAttribute('data-empty', 'no-selection');
      const note = this._el('div', 'insp-empty', 'Select an element on the canvas to edit it.');
      note.setAttribute('role', 'note');
      host.appendChild(note);
      return;
    }
    host.removeAttribute('data-empty');

    host.appendChild(this._header());
    for (const section of this._model.sections) {
      const block = this._el('section', 'insp-section');
      block.setAttribute('data-section', section.id);
      block.appendChild(this._el('h3', 'insp-section-title', section.title));
      for (const control of section.controls) { block.appendChild(this._row(control)); }
      host.appendChild(block);
    }
    if (this._model.slots.length > 0) {
      const note = this._el('div', 'insp-slots',
        `Slots: ${this._model.slots.join(', ')} — edit these on the canvas.`);
      host.appendChild(note);
    }
  }

  private _header(): DomElement {
    const selection = this._selection;
    const head = this._el('div', 'insp-head');
    const title = this._model.mixedTags
      ? `${selection.nodes.length} elements`
      : (this._model.tags[0] ?? 'Element');
    head.appendChild(this._el('span', 'insp-title', title));
    if (!this._model.mixedTags && selection.nodes.length > 1) {
      head.appendChild(this._el('span', 'insp-sub', `${selection.nodes.length} selected`));
    }

    // The other half of "the agent is legible": a way to answer it. One
    // element, one sentence, straight into the running turn's inbox.
    const askFor = this._callbacks.comment;
    if (askFor && selection.pageId && selection.mids.length === 1) {
      const pageId = selection.pageId;
      const mid = selection.mids[0];
      const ask = this._el('button', 'insp-ask', 'Ask Mysti');
      ask.setAttribute('aria-label', `Ask Mysti to change this ${title}`);
      ask.setAttribute('title', 'Tell Mysti what to change about this element');
      ask.addEventListener('click', () => askFor(pageId, mid, title));
      head.appendChild(ask);
    }

    const pinned = pinnedTargetsForNodes(selection.nodes);
    if (pinned.length > 0) {
      const count = countPinnedCells(pinned);
      const chip = this._el('button', 'insp-unpin-node',
        `${count} pinned ${count === 1 ? 'change' : 'changes'} — release`);
      chip.setAttribute('title', 'Your edits here are protected from agent rewrites. Release them.');
      chip.setAttribute('aria-label',
        `Release ${count} pinned ${count === 1 ? 'change' : 'changes'} on this element`);
      chip.addEventListener('click', () => this._unpin(pinned, 'node'));
      head.appendChild(chip);
    }

    const doc = selection.doc;
    if (doc) {
      const stylePins = pinnedTargetsInDoc(doc, 'style');
      if (stylePins.length > 0) {
        const bulk = this._el('button', 'insp-restyle', 'Let the agent restyle everything');
        bulk.setAttribute('aria-label',
          `Release ${countPinnedCells(stylePins)} pinned style changes on this artboard`);
        bulk.setAttribute('title',
          `Releases ${countPinnedCells(stylePins)} pinned style changes on this artboard. Your text stays pinned.`);
        bulk.addEventListener('click', () => this._unpin(stylePins, 'page-styles'));
        head.appendChild(bulk);
      }
    }
    return head;
  }

  private _row(control: ControlDescriptor): DomElement {
    const value = readControlValue(this._selection.nodes, control);
    const row = this._el('div', 'ctl');
    row.setAttribute('data-control', control.id);
    row.setAttribute('data-state', value.state);

    // The label was a SIBLING of the widget (which sits one level deeper, in
    // `.ctl-body`), so there was neither an implicit nor an explicit
    // association: every control announced as "edit text, blank" / "slider, 16"
    // / "button, Off", and clicking a label focused nothing. `for`/`id` binds
    // them; `<button>`, `<select>`, `<input>` and `<textarea>` are all labelable.
    const inputId = nextControlId();
    const label = this._el('label', 'ctl-label', control.label);
    if (isLabelable(control)) { label.setAttribute('for', inputId); }
    row.appendChild(label);

    const pins = pinnedTargetsForControl(this._selection.nodes, control);
    if (pins.length > 0) {
      row.setAttribute('data-pinned', 'true');
      const dot = this._iconButton(
        'ctl-pin', '•',
        `Unpin ${control.label}`,
        'You set this — the agent cannot overwrite it. Click to unpin.',
      );
      dot.setAttribute('data-cell', control.cell);
      dot.addEventListener('click', () => this._unpin(pins, 'cell'));
      row.appendChild(dot);
    }

    const body = this._el('div', 'ctl-body');
    body.appendChild(this._widget(control, value, row, inputId));
    row.appendChild(body);

    if (control.target.kind === 'text' && this._callbacks.beginTextEdit && this._selection.mids.length === 1) {
      const onCanvas = this._el('button', 'ctl-edit-canvas', 'Edit on canvas');
      onCanvas.setAttribute('aria-label', `Edit ${control.label} directly on the canvas`);
      onCanvas.addEventListener('click', () => {
        const pageId = this._selection.pageId;
        const mid = this._selection.mids[0];
        if (pageId && mid) { this._callbacks.beginTextEdit?.(pageId, mid); }
      });
      row.appendChild(onCanvas);
    }

    if (value.state !== 'unset') {
      const clear = this._iconButton(
        'ctl-clear', '×', `Reset ${control.label} to the default`, 'Reset to the default',
      );
      clear.addEventListener('click', () => this._write(control, null));
      row.appendChild(clear);
    }
    return row;
  }

  /* -------------------------------- widgets -------------------------------- */

  private _widget(
    control: ControlDescriptor,
    value: ControlValue,
    row: DomElement,
    inputId: string,
  ): DomElement {
    switch (control.control) {
      case 'boolean': return this._booleanWidget(control, value, inputId);
      case 'number': return this._numberWidget(control, value, inputId);
      case 'select': return this._selectWidget(control, value, inputId);
      case 'token':
      case 'color': return this._tokenWidget(control, value, inputId);
      case 'json': return this._jsonWidget(control, value, row, inputId);
      case 'textarea': return this._textWidget(control, value, 'textarea', inputId);
      case 'length':
      case 'text': return this._textWidget(control, value, 'input', inputId);
      // Slot controls never reach the model; render an inert note if one does.
      case 'slot':
      case 'slotList': return this._el('span', 'ctl-note', 'Edit on the canvas');
      default: {
        const never: never = control.control;
        void never;
        return this._el('span', 'ctl-note', '');
      }
    }
  }

  private _input(tag: 'input' | 'textarea' | 'select', type?: string): DomValueElement {
    const node = asValueElement(this._env.doc.createElement(tag));
    node.className = `ctl-input ctl-${type ?? tag}`;
    if (type) { node.setAttribute('type', type); }
    return node;
  }

  private _textWidget(
    control: ControlDescriptor,
    value: ControlValue,
    tag: 'input' | 'textarea',
    inputId: string,
  ): DomElement {
    const input = this._input(tag, tag === 'input' ? 'text' : undefined);
    input.setAttribute('id', inputId);
    input.setAttribute('placeholder', placeholderFor(control, value));
    if (value.state === 'uniform') { input.value = String(value.value ?? ''); }
    input.addEventListener('change', () => this._write(control, input.value));
    return input;
  }

  private _booleanWidget(control: ControlDescriptor, value: ControlValue, inputId: string): DomElement {
    const state: boolean | null = value.state === 'uniform'
      ? value.value === true
      : value.state === 'mixed' ? null : (control.default === true);
    const button = this._el('button', 'ctl-toggle', state === null ? 'Mixed' : state ? 'On' : 'Off');
    button.setAttribute('id', inputId);
    // On/Off/Mixed is the STATE. Three toggles all named "Off" are
    // indistinguishable, so the property owns the name and `aria-pressed`
    // (plus the visible word) carries the value.
    button.setAttribute('aria-label', control.label);
    button.setAttribute('aria-pressed', state === true ? 'true' : 'false');
    button.addEventListener('click', () => this._write(control, state === null ? true : !state));
    return button;
  }

  /**
   * A slider when the schema bounds the value, a number field otherwise.
   *
   * `input` fires ~60×/s while dragging and `change` fires once on pointer-up,
   * so the drag opens a transaction, streams throttled updates into it, and
   * closes it at the end — one Cmd+Z for the whole drag (§3.5).
   */
  private _numberWidget(control: ControlDescriptor, value: ControlValue, inputId: string): DomElement {
    const ranged = control.min !== undefined && control.max !== undefined;
    const input = this._input('input', ranged ? 'range' : 'number');
    input.setAttribute('id', inputId);
    if (control.min !== undefined) { input.setAttribute('min', String(control.min)); }
    if (control.max !== undefined) { input.setAttribute('max', String(control.max)); }
    if (control.step !== undefined) { input.setAttribute('step', String(control.step)); }

    const current = value.state === 'uniform' && typeof value.value === 'number'
      ? value.value
      : numberDefault(control);
    input.value = String(current);
    if (value.state !== 'uniform') { input.setAttribute('data-placeholder', placeholderFor(control, value)); }

    if (!ranged) {
      input.addEventListener('change', () => this._write(control, input.value));
      return input;
    }

    const wrap = this._el('div', 'ctl-range');
    const readout = this._el('span', 'ctl-readout',
      value.state === 'uniform' ? String(current) : placeholderFor(control, value));
    input.addEventListener('input', () => {
      readout.textContent = input.value;
      const ops = this._opsFor(control, input.value);
      if (ops.length === 0) { return; }
      if (!this._txn.active) { this._txn.begin(); }
      this._txn.update(ops);
    });
    input.addEventListener('change', () => {
      readout.textContent = input.value;
      const ops = this._opsFor(control, input.value);
      if (this._txn.active) { this._txn.end(ops.length > 0 ? ops : undefined); } else { this._txn.commit(ops); }
      this._flushDeferred();
    });
    wrap.appendChild(input);
    wrap.appendChild(readout);
    return wrap;
  }

  private _selectWidget(control: ControlDescriptor, value: ControlValue, inputId: string): DomElement {
    const select = this._input('select');
    select.setAttribute('id', inputId);
    const options: Array<{ value: string; label: string }> = [];
    if (value.state === 'mixed') { options.push({ value: MIXED_SENTINEL, label: 'Mixed' }); }
    options.push({ value: UNSET_SENTINEL, label: defaultLabel(control) });
    for (const option of control.options ?? []) { options.push({ value: option, label: option }); }
    // A doc written by an agent (or by an older schema) can carry a value the
    // enum no longer lists. Surfacing it keeps the control HONEST: a select
    // whose `value` matches no option reads as blank in a real DOM, which would
    // show "unset" for a cell that is very much set.
    if (value.state === 'uniform') {
      const current = String(value.value);
      if (!(control.options ?? []).includes(current)) {
        options.push({ value: current, label: `${current} (not in this version)` });
      }
    }
    this._fill(select, options);
    select.value = value.state === 'mixed'
      ? MIXED_SENTINEL
      : value.state === 'uniform' ? String(value.value) : UNSET_SENTINEL;
    select.addEventListener('change', () => this._writeSentinel(control, select.value));
    return select;
  }

  /**
   * Theme tokens FIRST, raw as the escape hatch (§3.5 / plan risk: "no raw hex
   * where a token exists"). Picking "Custom…" reveals a text field whose value
   * is snapped back to a token when the theme already names it.
   */
  private _tokenWidget(control: ControlDescriptor, value: ControlValue, inputId: string): DomElement {
    const wrap = this._el('div', 'ctl-token');
    const select = this._input('select');
    select.setAttribute('id', inputId);
    const tokens = control.tokenGroup ? tokenOptions(control.tokenGroup, this._selection.theme) : [];
    const current = value.state === 'uniform' ? String(value.value) : null;
    const isToken = current !== null && tokens.some(t => t.value === current);

    const options: Array<{ value: string; label: string }> = [];
    if (value.state === 'mixed') { options.push({ value: MIXED_SENTINEL, label: 'Mixed' }); }
    options.push({ value: UNSET_SENTINEL, label: defaultLabel(control) });
    for (const token of tokens) { options.push({ value: token.value, label: token.label }); }
    options.push({ value: CUSTOM_SENTINEL, label: 'Custom…' });
    this._fill(select, options);
    select.value = value.state === 'mixed'
      ? MIXED_SENTINEL
      : isToken ? String(current) : current !== null ? CUSTOM_SENTINEL : UNSET_SENTINEL;

    const swatch = this._el('span', 'ctl-swatch');
    const paint = (token: string | null): void => {
      const match = tokens.find(t => t.value === token);
      const resolved = match?.resolved;
      // The theme is artifact data and therefore model-influenced: its value
      // goes through the same sanitizer any style value does before it is
      // written into the parent document.
      const safe = resolved ? sanitizeStyleValue('background', resolved) : null;
      if (safe) { swatch.style.setProperty('background', safe); } else { swatch.style.removeProperty('background'); }
    };
    paint(isToken ? current : null);

    const raw = this._input('input', 'text');
    raw.className = 'ctl-input ctl-raw';
    // A second control in the same row, so the `<label for>` cannot reach it.
    raw.setAttribute('aria-label', `${control.label} — custom value`);
    raw.setAttribute('placeholder', 'e.g. #1f2937');
    raw.hidden = !(current !== null && !isToken);
    if (current !== null && !isToken) { raw.value = current; }
    raw.addEventListener('change', () => this._write(control, raw.value));

    select.addEventListener('change', () => {
      const chosen = select.value;
      if (chosen === CUSTOM_SENTINEL) { raw.hidden = false; paint(null); return; }
      raw.hidden = true;
      paint(chosen === UNSET_SENTINEL || chosen === MIXED_SENTINEL ? null : chosen);
      this._writeSentinel(control, chosen);
    });

    wrap.appendChild(swatch);
    wrap.appendChild(select);
    wrap.appendChild(raw);
    return wrap;
  }

  private _jsonWidget(
    control: ControlDescriptor,
    value: ControlValue,
    row: DomElement,
    inputId: string,
  ): DomElement {
    const input = this._input('textarea');
    input.setAttribute('id', inputId);
    input.setAttribute('placeholder', placeholderFor(control, value));
    if (value.state === 'uniform') {
      try { input.value = JSON.stringify(value.value, null, 2) ?? ''; } catch { input.value = ''; }
    }
    input.addEventListener('change', () => {
      const coerced = coerceControlInput(control, input.value, { theme: this._selection.theme });
      if (coerced === undefined) { row.setAttribute('data-invalid', 'true'); return; }
      row.removeAttribute('data-invalid');
      this._writeCoerced(control, coerced);
    });
    return input;
  }

  private _fill(select: DomValueElement, items: Array<{ value: string; label: string }>): void {
    select.replaceChildren();
    for (const item of items) {
      const option = asValueElement(this._env.doc.createElement('option'));
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    }
  }

  /* -------------------------------- writing -------------------------------- */

  /** A sentinel choice: "Mixed" writes nothing, "Default" clears the cell. */
  private _writeSentinel(control: ControlDescriptor, chosen: string): void {
    if (chosen === MIXED_SENTINEL) { return; }
    if (chosen === UNSET_SENTINEL) { this._write(control, null); return; }
    this._write(control, chosen);
  }

  private _opsFor(control: ControlDescriptor, raw: string | boolean | number | null) {
    const pageId = this._selection.pageId;
    if (!pageId) { return []; }
    const coerced = coerceControlInput(control, raw, {
      theme: this._selection.theme,
      unit: control.units?.[0] ?? 'px',
    });
    return controlOps(pageId, this._selection.mids, control, coerced);
  }

  private _write(control: ControlDescriptor, raw: string | boolean | number | null): void {
    const ops = this._opsFor(control, raw);
    if (ops.length === 0) { return; }
    this._txn.commit(ops);
    this._flushDeferred();
  }

  private _writeCoerced(control: ControlDescriptor, coerced: CoercedValue): void {
    const pageId = this._selection.pageId;
    if (!pageId) { return; }
    const ops = controlOps(pageId, this._selection.mids, control, coerced);
    if (ops.length === 0) { return; }
    this._txn.commit(ops);
    this._flushDeferred();
  }

  private _unpin(targets: Array<{ mid: Mid; cells: PinCell[] }>, scope: UnpinIntent['scope']): void {
    const pageId = this._selection.pageId;
    if (!pageId || targets.length === 0) { return; }
    this._callbacks.unpin({ pageId, targets, scope });
  }

  /** A render that arrived mid-gesture is applied as soon as the drag ends. */
  private _flushDeferred(): void {
    if (this._txn.active || !this._deferred) { return; }
    const next = this._deferred;
    this._deferred = null;
    this.render(next);
  }
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Does this control render a labelable element for the `<label for>` to reach?
 *
 * Slots are rendered as an inert note ("edit this on the canvas"), and a `for`
 * pointing at nothing is worse than no `for` at all.
 */
function isLabelable(control: ControlDescriptor): boolean {
  return control.control !== 'slot' && control.control !== 'slotList';
}

function placeholderFor(control: ControlDescriptor, value: ControlValue): string {
  if (value.state === 'mixed') { return 'Mixed'; }
  if (control.placeholder) { return control.placeholder; }
  if (control.default !== undefined) { return String(jsonLabel(control.default)); }
  return 'Default';
}

function defaultLabel(control: ControlDescriptor): string {
  return control.default !== undefined ? `Default (${jsonLabel(control.default)})` : 'Default';
}

function jsonLabel(value: JsonValue): string {
  if (value === null) { return 'none'; }
  if (typeof value === 'object') { return Array.isArray(value) ? `${value.length} items` : 'object'; }
  return String(value);
}

function numberDefault(control: ControlDescriptor): number {
  if (typeof control.default === 'number') { return control.default; }
  if (control.min !== undefined) { return control.min; }
  return 0;
}
