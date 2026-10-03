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
 * Plan 22 §4 row 3 — the properties panel, as DATA.
 *
 * Everything in this module is pure: `UiSchema` + the selected `DocNode`s + the
 * artifact theme in, a control model / a read value / a `CanvasOp[]` out. No
 * DOM, no `postMessage`, no state. `inspector.ts` is the thin DOM shell that
 * materializes what this file decides, which is what makes the interesting half
 * of a properties panel unit-testable in a repo with no jsdom.
 *
 * Four invariants this module exists to hold:
 *
 * 1. **Controls are GENERATED, never hand-written.** A control exists because
 *    `UiSchema` declares the cell editable — so a control cannot exist for a
 *    prop the primitive never reads (precisely how `elementOverrides` became a
 *    side-band with zero renderers), and a new primitive gets a panel for free.
 * 2. **A control emits the op an agent tool emits.** {@link controlOps} returns
 *    `el.setProp` / `el.setStyle` / `el.setText` from `src/canvas/CanvasOps.ts`
 *    — the same records `set_prop`/`set_style`/`set_text` produce, down the same
 *    `CanvasOpExecutor.submit` chokepoint. A control that mutated local state
 *    instead would be a bug, so no control here can: the only thing this module
 *    can produce is an op.
 * 3. **Tokens first, raw as the escape hatch.** Anything a theme token can
 *    express is offered as `var(--theme-…)`, and a raw value that happens to
 *    equal a token's resolved value is SNAPPED back to the token
 *    ({@link snapToToken}). A design stays on-brand because the editor is
 *    on-brand, not because the user is disciplined.
 * 4. **A drag is ONE transaction.** {@link TxnEmitter} keeps every intermediate
 *    frame of a slider drag under a single `txnId`, so Cmd+Z undoes the drag and
 *    not its 60th step.
 */

import type { DesignTheme } from '../../types';
import type { CanvasOp } from '../../canvas/CanvasOps';
import type { DocNode, JsonValue, Mid, PinCell } from '../../canvas/doc/DocNode';
import { pinnedCells, walk } from '../../canvas/doc/DocNode';
import {
  THEME_TOKENS,
  propsForTag,
  stylesForTag,
  supportsTextEditing,
  themeTokenValue,
  type UiControl,
  type UiPropSpec,
  type UiStyleSpec,
  type UiTokenGroup,
} from '../../canvas/UiSchema';
import { themeTokenMap } from '../../managers/CanvasSandbox';
// The style sanitizer is IMPORTED, not restated: the panel must not be able to
// write a declaration the parent-side renderer would silently drop (§2.9).
import { normalizeStyleProp, sanitizeStyleValue } from './preview';

/* ────────────────────────────── control model ────────────────────────────── */

/** Which cell of a node a control writes. */
export type ControlTarget =
  | { kind: 'text' }
  | { kind: 'prop'; name: string }
  | { kind: 'style'; prop: string };

/**
 * One generated control. Everything the DOM shell needs, and nothing it could
 * use to invent a write the schema did not authorize.
 */
export interface ControlDescriptor {
  /** `'text'` | `'prop:label'` | `'style:background'`. Stable, DOM-safe, testable. */
  id: string;
  target: ControlTarget;
  label: string;
  control: UiControl;
  /** The pin cell this control owns: `'text'` | `'props.label'` | `'style.background'`. */
  cell: PinCell;
  options?: readonly string[];
  tokenGroup?: UiTokenGroup;
  units?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** The primitive's own fallback. Shown as a placeholder — NEVER written. */
  default?: JsonValue;
  description?: string;
}

export type ControlSectionId = 'content' | 'props' | 'styles';

export interface ControlSection {
  id: ControlSectionId;
  title: string;
  controls: ControlDescriptor[];
}

export interface ControlModel {
  /** Distinct tags in the selection, in selection order. */
  tags: string[];
  /** True when the selection spans more than one tag — the panel says so. */
  mixedTags: boolean;
  sections: ControlSection[];
  /**
   * Slot-valued props common to the selection (`AppShell.sidebar`,
   * `ListRow.trailing`). Deliberately NOT controls: a subtree is edited on the
   * canvas, and pretending it is a string field is how a properties panel
   * starts corrupting documents.
   */
  slots: string[];
}

const EMPTY_MODEL: ControlModel = Object.freeze({
  tags: [], mixedTags: false, sections: [], slots: [],
}) as ControlModel;

/** A control is only offered when every selected node agrees on its meaning. */
function propCompatible(a: UiPropSpec, b: UiPropSpec): boolean {
  return a.control === b.control
    && a.tokenGroup === b.tokenGroup
    && sameList(a.options, b.options);
}

function styleCompatible(a: UiStyleSpec, b: UiStyleSpec): boolean {
  return a.control === b.control
    && a.tokenGroup === b.tokenGroup
    && sameList(a.options, b.options)
    && sameList(a.units, b.units);
}

function sameList(a?: readonly string[], b?: readonly string[]): boolean {
  if (!a && !b) { return true; }
  if (!a || !b || a.length !== b.length) { return false; }
  return a.every((v, i) => v === b[i]);
}

function fromProp(spec: UiPropSpec): ControlDescriptor {
  const d: ControlDescriptor = {
    id: `prop:${spec.name}`,
    target: { kind: 'prop', name: spec.name },
    label: spec.label,
    control: spec.control,
    cell: `props.${spec.name}`,
  };
  if (spec.options) { d.options = spec.options; }
  if (spec.tokenGroup) { d.tokenGroup = spec.tokenGroup; }
  if (spec.min !== undefined) { d.min = spec.min; }
  if (spec.max !== undefined) { d.max = spec.max; }
  if (spec.step !== undefined) { d.step = spec.step; }
  if (spec.placeholder !== undefined) { d.placeholder = spec.placeholder; }
  if (spec.default !== undefined) { d.default = spec.default; }
  if (spec.description !== undefined) { d.description = spec.description; }
  return d;
}

function fromStyle(spec: UiStyleSpec): ControlDescriptor {
  const d: ControlDescriptor = {
    id: `style:${spec.prop}`,
    target: { kind: 'style', prop: spec.prop },
    label: spec.label,
    control: spec.control,
    cell: `style.${spec.prop}`,
  };
  if (spec.options) { d.options = spec.options; }
  if (spec.tokenGroup) { d.tokenGroup = spec.tokenGroup; }
  if (spec.units) { d.units = spec.units; }
  if (spec.min !== undefined) { d.min = spec.min; }
  if (spec.max !== undefined) { d.max = spec.max; }
  if (spec.step !== undefined) { d.step = spec.step; }
  return d;
}

/** The inline-text control, offered only where `DocNode.text` is meaningful. */
export const TEXT_CONTROL: ControlDescriptor = Object.freeze({
  id: 'text',
  target: Object.freeze({ kind: 'text' }) as ControlTarget,
  label: 'Text',
  control: 'textarea' as UiControl,
  cell: 'text',
  placeholder: 'Text content',
}) as ControlDescriptor;

/**
 * Generate the panel for a selection.
 *
 * Multi-selection shows the INTERSECTION: a control survives only if every
 * selected node's schema declares it with the same meaning. Two nodes whose
 * `size` prop is a number on one and an enum on the other therefore contribute
 * no `size` control at all, rather than one control that writes nonsense into
 * half the selection.
 */
export function buildControlModel(nodes: readonly DocNode[]): ControlModel {
  if (!Array.isArray(nodes) || nodes.length === 0) { return EMPTY_MODEL; }

  const tags: string[] = [];
  for (const node of nodes) {
    if (!node || typeof node.tag !== 'string') { return EMPTY_MODEL; }
    if (!tags.includes(node.tag)) { tags.push(node.tag); }
  }

  // ── content ──
  const textEditable = nodes.every(n =>
    supportsTextEditing(n.tag) && !(n.children && n.children.length > 0));
  const content: ControlDescriptor[] = textEditable ? [TEXT_CONTROL] : [];

  // ── props (intersection) ──
  const slots: string[] = [];
  let props: UiPropSpec[] = propsForTag(tags[0]).slice();
  for (const tag of tags.slice(1)) {
    const other = propsForTag(tag);
    props = props.filter(spec => {
      const match = other.find(o => o.name === spec.name);
      return !!match && propCompatible(spec, match);
    });
  }
  const propControls: ControlDescriptor[] = [];
  for (const spec of props) {
    if (spec.slot === true || spec.control === 'slot' || spec.control === 'slotList') {
      slots.push(spec.name);
      continue;
    }
    propControls.push(fromProp(spec));
  }

  // ── styles (intersection) ──
  let styles: UiStyleSpec[] = stylesForTag(tags[0]).slice();
  for (const tag of tags.slice(1)) {
    const other = stylesForTag(tag);
    styles = styles.filter(spec => {
      const match = other.find(o => o.prop === spec.prop);
      return !!match && styleCompatible(spec, match);
    });
  }
  const styleControls = styles.map(fromStyle);

  const sections: ControlSection[] = [];
  if (content.length > 0) { sections.push({ id: 'content', title: 'Content', controls: content }); }
  if (propControls.length > 0) { sections.push({ id: 'props', title: 'Properties', controls: propControls }); }
  if (styleControls.length > 0) { sections.push({ id: 'styles', title: 'Style', controls: styleControls }); }

  return { tags, mixedTags: tags.length > 1, sections, slots };
}

/** Every control in the model, flattened — the order the panel renders. */
export function allControls(model: ControlModel): ControlDescriptor[] {
  const out: ControlDescriptor[] = [];
  for (const section of model.sections) { out.push(...section.controls); }
  return out;
}

/** Look a control up by {@link ControlDescriptor.id}. */
export function findControl(model: ControlModel, id: string): ControlDescriptor | null {
  for (const section of model.sections) {
    for (const control of section.controls) { if (control.id === id) { return control; } }
  }
  return null;
}

/* ────────────────────────────── reading values ────────────────────────────── */

export type ControlValue =
  /** Every selected node carries the same value. */
  | { state: 'uniform'; value: JsonValue }
  /** The nodes disagree — render "Mixed" and write ONLY on an explicit change. */
  | { state: 'mixed' }
  /** No node sets it — the primitive's own default applies. Never written. */
  | { state: 'unset' };

function ownValue(node: DocNode, target: ControlTarget): JsonValue | undefined {
  switch (target.kind) {
    case 'text':
      return node.text;
    case 'prop': {
      const props = node.props;
      if (!props || !Object.prototype.hasOwnProperty.call(props, target.name)) { return undefined; }
      return props[target.name];
    }
    case 'style': {
      const style = node.style;
      if (!style || !Object.prototype.hasOwnProperty.call(style, target.prop)) { return undefined; }
      return style[target.prop];
    }
    default: {
      const never: never = target;
      void never;
      return undefined;
    }
  }
}

/** Structural equality over JSON values. Key ORDER is deliberately irrelevant. */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) { return true; }
  if (a === null || b === null || a === undefined || b === undefined) { return false; }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { return false; }
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) { return false; }
    return ka.every(k => jsonEqual(
      (a as Record<string, JsonValue>)[k],
      (b as Record<string, JsonValue>)[k],
    ));
  }
  return false;
}

/**
 * The value a control shows for a selection.
 *
 * `mixed` is load-bearing: a panel that showed the first node's value and wrote
 * it back on any interaction would silently flatten a multi-selection, which is
 * the single most destructive bug a properties panel can have.
 */
export function readControlValue(
  nodes: readonly DocNode[],
  control: ControlDescriptor,
): ControlValue {
  if (nodes.length === 0) { return { state: 'unset' }; }
  const first = ownValue(nodes[0], control.target);
  let anySet = first !== undefined;
  let allSame = true;
  for (const node of nodes.slice(1)) {
    const value = ownValue(node, control.target);
    if (value !== undefined) { anySet = true; }
    if (!jsonEqual(first, value)) { allSame = false; }
  }
  if (!anySet) { return { state: 'unset' }; }
  if (!allSame || first === undefined) { return { state: 'mixed' }; }
  return { state: 'uniform', value: first };
}

/* ──────────────────────────────── theme tokens ──────────────────────────────── */

export interface TokenOption {
  /** `'color-primary'` — the key in `themeTokenMap`. */
  token: string;
  /** `'var(--theme-color-primary)'` — what the control writes. */
  value: string;
  label: string;
  /** The theme's concrete value, for a swatch. Absent when no theme was given. */
  resolved?: string;
}

const GROUP_PREFIX: Readonly<Record<UiTokenGroup, string>> = {
  color: 'color-', radius: 'radius-', shadow: 'shadow-',
  font: 'font-', weight: 'weight-', space: 'space-',
};

/** `'color-text-secondary'` → `'Text secondary'`. */
function humanizeToken(token: string, group: UiTokenGroup): string {
  const prefix = GROUP_PREFIX[group];
  const bare = token.startsWith(prefix) ? token.slice(prefix.length) : token;
  const spaced = bare.replace(/-/g, ' ').trim();
  return spaced.length === 0 ? token : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The tokens a control offers, THEME FIRST.
 *
 * The declared set comes from `UiSchema.THEME_TOKENS`; a live theme may define
 * extra colors (`DesignTheme.colors` has an index signature), and those are
 * appended so a brand's own token is offered rather than forcing a raw hex —
 * exactly the case the plan's "no raw hex where a token exists" rule is about.
 */
export function tokenOptions(group: UiTokenGroup, theme?: DesignTheme | null): TokenOption[] {
  const resolved = theme ? themeTokenMap(theme) : null;
  const declared = THEME_TOKENS[group] ?? [];
  const out: TokenOption[] = [];
  const seen = new Set<string>();
  for (const token of declared) {
    seen.add(token);
    const option: TokenOption = {
      token, value: themeTokenValue(token), label: humanizeToken(token, group),
    };
    const value = resolved && Object.prototype.hasOwnProperty.call(resolved, token)
      ? resolved[token] : undefined;
    if (typeof value === 'string') { option.resolved = value; }
    out.push(option);
  }
  if (resolved) {
    const extras = Object.keys(resolved)
      .filter(k => k.startsWith(GROUP_PREFIX[group]) && !seen.has(k))
      .sort();
    for (const token of extras) {
      out.push({
        token,
        value: themeTokenValue(token),
        label: humanizeToken(token, group),
        resolved: resolved[token],
      });
    }
  }
  return out;
}

/** `var(--theme-color-primary)` and nothing else. */
export function isThemeTokenValue(value: unknown): value is string {
  return typeof value === 'string' && /^var\(--theme-[a-z0-9]+(-[a-z0-9]+)*\)$/.test(value.trim());
}

/** `#ABC` → `#aabbcc`; everything else lowercased and whitespace-collapsed. */
export function normalizeColorValue(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) { return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`; }
  return value;
}

/**
 * A raw value that a theme token already expresses becomes that token.
 *
 * This is what makes "tokens first" a property of the DOCUMENT rather than a
 * property of the UI: however the user got a value in (typed hex, colour picker,
 * paste), if the theme has a name for it the doc stores the name — so a later
 * `theme.set` restyles it instead of leaving an orphan hex behind.
 */
export function snapToToken(
  raw: string,
  group: UiTokenGroup,
  theme?: DesignTheme | null,
): string | null {
  if (typeof raw !== 'string' || !theme) { return null; }
  const target = normalizeColorValue(raw);
  if (target.length === 0) { return null; }
  for (const option of tokenOptions(group, theme)) {
    if (option.resolved !== undefined && normalizeColorValue(option.resolved) === target) {
      return option.value;
    }
  }
  return null;
}

/* ─────────────────────────────── value coercion ─────────────────────────────── */

/** Longest string a control may write into a prop or into `DocNode.text`. */
export const CONTROL_MAX_TEXT = 5000;
/** Longest serialized JSON a `json` control may write. */
export const CONTROL_MAX_JSON = 20000;

/**
 * Refusal is `undefined`; `null` means CLEAR the cell (the algebra's delete).
 * A cleared cell falls back to the primitive's own default, which is why the
 * schema `default` is a placeholder and never a written value.
 */
export type CoercedValue = JsonValue | null | undefined;

export interface CoerceOptions {
  theme?: DesignTheme | null;
  /** Unit for a `length` control when the raw input is a bare number. */
  unit?: string;
}

const LENGTH_RE = /^-?\d+(\.\d+)?(px|%|rem|em|vh|vw|ch|fr|deg|s|ms)?$/;
const KEYWORD_RE = /^[a-z][a-z0-9-]{0,32}$/i;

/** Invisible characters: C0/C1 controls plus bidi overrides and zero-widths. */
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F'
  + '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'g',
);

/**
 * Turn a raw control input into the value to write, or refuse it.
 *
 * Refusing is not cosmetic: a value that fails here is a value the renderer's
 * sanitizer would have dropped at paint time — i.e. a control that silently did
 * nothing, which is the exact failure mode this whole row exists to end.
 */
export function coerceControlInput(
  control: ControlDescriptor,
  raw: string | boolean | number | null,
  opts: CoerceOptions = {},
): CoercedValue {
  if (raw === null) { return null; }

  switch (control.control) {
    case 'boolean':
      if (typeof raw === 'boolean') { return raw; }
      if (raw === 'true') { return true; }
      if (raw === 'false') { return false; }
      return undefined;

    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) { return undefined; }
      const min = control.min ?? -Number.MAX_SAFE_INTEGER;
      const max = control.max ?? Number.MAX_SAFE_INTEGER;
      return Math.min(max, Math.max(min, n));
    }

    case 'select': {
      const value = String(raw);
      if (!control.options || !control.options.includes(value)) { return undefined; }
      return value;
    }

    case 'token': {
      const value = String(raw).trim();
      if (value.length === 0) { return null; }
      if (isThemeTokenValue(value)) { return value; }
      if (control.tokenGroup) {
        const snapped = snapToToken(value, control.tokenGroup, opts.theme);
        if (snapped) { return snapped; }
      }
      // Raw escape hatch — allowed, but only through the style sanitizer.
      return sanitizeRawStyleish(control, value);
    }

    case 'color': {
      const value = String(raw).trim();
      if (value.length === 0) { return null; }
      if (isThemeTokenValue(value)) { return value; }
      const snapped = control.tokenGroup ? snapToToken(value, control.tokenGroup, opts.theme) : null;
      if (snapped) { return snapped; }
      return sanitizeRawStyleish(control, value);
    }

    case 'length': {
      const value = String(raw).trim();
      if (value.length === 0) { return null; }
      if (isThemeTokenValue(value)) { return value; }
      const bare = /^-?\d+(\.\d+)?$/.test(value);
      const composed = bare && opts.unit ? `${value}${opts.unit}` : value;
      if (!LENGTH_RE.test(composed) && !KEYWORD_RE.test(composed)) { return undefined; }
      return sanitizeRawStyleish(control, composed);
    }

    case 'json': {
      const value = String(raw).trim();
      if (value.length === 0) { return null; }
      if (value.length > CONTROL_MAX_JSON) { return undefined; }
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return undefined; }
      if (!isJsonValue(parsed)) { return undefined; }
      return parsed;
    }

    case 'text':
    case 'textarea': {
      const value = clampControlText(String(raw));
      if (control.target.kind === 'text') { return value; }
      return value.length === 0 ? null : value;
    }

    // A subtree is not a value. Refuse rather than stringify a document.
    case 'slot':
    case 'slotList':
      return undefined;

    default: {
      const never: never = control.control;
      void never;
      return undefined;
    }
  }
}

/**
 * A raw (non-token) value bound for a style cell must survive the renderer's
 * own sanitizer; a style-ish PROP (`background`) gets the same check, because
 * the primitives translate those straight into CSS.
 */
function sanitizeRawStyleish(control: ControlDescriptor, value: string): string | undefined {
  const prop = control.target.kind === 'style' ? control.target.prop : 'background';
  return sanitizeStyleValue(prop, value) ?? undefined;
}

/** Strip invisible characters and cap length. Exported for the text-edit lane. */
export function clampControlText(raw: string, max: number = CONTROL_MAX_TEXT): string {
  const clean = String(raw).replace(INVISIBLE_RE, '');
  return clean.length > max ? clean.slice(0, max) : clean;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 12) { return false; }
  if (value === null) { return true; }
  const t = typeof value;
  if (t === 'string' || t === 'boolean') { return true; }
  if (t === 'number') { return Number.isFinite(value as number); }
  if (Array.isArray(value)) { return value.every(v => isJsonValue(v, depth + 1)); }
  if (t === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .every(([k, v]) => k !== '__proto__' && isJsonValue(v, depth + 1));
  }
  return false;
}

/* ──────────────────────────── op construction ──────────────────────────── */

/**
 * The ops a control's new value produces — one per selected element.
 *
 * THE claim of Plan 22 §4 row 3 lives here: these are byte-for-byte the records
 * `set_text` / `set_prop` / `set_style` produce for an agent. Nothing about a
 * human gesture is special except `author`, which the HOST stamps from the
 * arriving channel and which is what makes the executor pin these cells.
 */
export function controlOps(
  pageId: string,
  mids: readonly Mid[],
  control: ControlDescriptor,
  value: CoercedValue,
): CanvasOp[] {
  if (value === undefined) { return []; }
  if (typeof pageId !== 'string' || pageId.length === 0 || mids.length === 0) { return []; }

  const ops: CanvasOp[] = [];
  switch (control.target.kind) {
    case 'text': {
      // `el.setText` has no "unset"; clearing means empty text.
      const text = value === null ? '' : clampControlText(String(value));
      for (const mid of mids) { ops.push({ op: 'el.setText', pageId, mid, text }); }
      return ops;
    }
    case 'prop': {
      const name = control.target.name;
      for (const mid of mids) { ops.push({ op: 'el.setProp', pageId, mid, name, value }); }
      return ops;
    }
    case 'style': {
      const prop = normalizeStyleProp(control.target.prop);
      if (!prop) { return []; }
      if (value === null) {
        for (const mid of mids) { ops.push({ op: 'el.setStyle', pageId, mid, style: { [prop]: null } }); }
        return ops;
      }
      const declared = sanitizeStyleValue(prop, String(value));
      if (declared === null) { return []; }
      for (const mid of mids) { ops.push({ op: 'el.setStyle', pageId, mid, style: { [prop]: declared } }); }
      return ops;
    }
    default: {
      const never: never = control.target;
      void never;
      return [];
    }
  }
}

/* ──────────────────────────────── pins ──────────────────────────────── */

export interface PinTarget { mid: Mid; cells: PinCell[] }

/** What the human is asking to hand back to the agent. */
export interface UnpinIntent {
  pageId: string;
  targets: PinTarget[];
  /** `'cell'` one control · `'node'` the selection · `'page-styles'`/`'page-all'` bulk. */
  scope: 'cell' | 'node' | 'page-styles' | 'page-all';
}

/** The selected nodes that have this control's cell pinned. */
export function pinnedTargetsForControl(
  nodes: readonly DocNode[],
  control: ControlDescriptor,
): PinTarget[] {
  const out: PinTarget[] = [];
  for (const node of nodes) {
    if (node.pins && Object.prototype.hasOwnProperty.call(node.pins, control.cell)) {
      out.push({ mid: node.mid, cells: [control.cell] });
    }
  }
  return out;
}

/** Every pinned cell across the selection. */
export function pinnedTargetsForNodes(nodes: readonly DocNode[]): PinTarget[] {
  const out: PinTarget[] = [];
  for (const node of nodes) {
    const cells = pinnedCells(node);
    if (cells.length > 0) { out.push({ mid: node.mid, cells }); }
  }
  return out;
}

/**
 * Every pin in an artboard, optionally only the style ones.
 *
 * `'style'` is the "let the agent restyle everything" case from §3.5.5: it
 * releases appearance while KEEPING the human's copy — because a rebrand should
 * not silently rewrite the words someone chose.
 */
export function pinnedTargetsInDoc(doc: DocNode, filter: 'style' | 'all' = 'all'): PinTarget[] {
  const out: PinTarget[] = [];
  for (const node of walk(doc)) {
    const cells = pinnedCells(node).filter(c => filter === 'all' || c.startsWith('style.'));
    if (cells.length > 0) { out.push({ mid: node.mid, cells }); }
  }
  return out;
}

/** Total pinned cells across a list of targets. */
export function countPinnedCells(targets: readonly PinTarget[]): number {
  let n = 0;
  for (const t of targets) { n += t.cells.length; }
  return n;
}

/* ──────────────────── transactions (one drag = one undo) ──────────────────── */

/** One `canvas/submit` payload: ops that Cmd+Z must undo together. */
export interface OpSubmission {
  txnId: string;
  ops: CanvasOp[];
}

export interface TxnEmitterOptions {
  emit(submission: OpSubmission): void;
  /** Injectable so tests get deterministic ids. */
  newTxnId?: () => string;
  /** Minimum ms between mid-gesture emissions. `0` emits every update. */
  throttleMs?: number;
  now?: () => number;
}

/** Default mid-drag emission interval: fast enough to look live, cheap enough. */
export const DEFAULT_DRAG_THROTTLE_MS = 80;

/**
 * Coalesces a gesture into ONE transaction.
 *
 * A slider drag emits ~60 values a second. Each one is a real op — the document
 * must actually change or the drag would not be live — but all of them carry a
 * single `txnId`, which is what `CanvasHistory` groups on. So Cmd+Z after a drag
 * restores the value the human started from, not its penultimate frame.
 *
 * `end()` always flushes the final value even when the throttle just fired, and
 * never re-emits a value that was already sent — so the last frame of a drag is
 * committed exactly once.
 */
export class TxnEmitter {
  private readonly _emit: (submission: OpSubmission) => void;
  private readonly _newId: () => string;
  private readonly _throttleMs: number;
  private readonly _now: () => number;

  private _txnId: string | null = null;
  private _pending: CanvasOp[] | null = null;
  private _lastEmitAt = Number.NEGATIVE_INFINITY;
  private _lastEmitted: string | null = null;
  private _seq = 0;

  constructor(opts: TxnEmitterOptions) {
    this._emit = opts.emit;
    this._throttleMs = opts.throttleMs ?? DEFAULT_DRAG_THROTTLE_MS;
    this._now = opts.now ?? (() => Date.now());
    this._newId = opts.newTxnId
      ?? (() => `txn-${this._now().toString(36)}-${(this._seq++).toString(36)}`);
  }

  /** The open gesture's transaction id, or null when none is open. */
  get txnId(): string | null { return this._txnId; }
  get active(): boolean { return this._txnId !== null; }

  /** Open a coalesced gesture (pointer-down on a slider). */
  begin(): string {
    if (this._txnId) { this.end(); }
    this._txnId = this._newId();
    this._pending = null;
    this._lastEmitAt = Number.NEGATIVE_INFINITY;
    this._lastEmitted = null;
    return this._txnId;
  }

  /** A mid-gesture value. Throttled; the newest value always wins. */
  update(ops: CanvasOp[]): void {
    if (!this._txnId) { this.begin(); }
    this._pending = ops;
    if (this._now() - this._lastEmitAt >= this._throttleMs) { this._flush(); }
  }

  /** Pointer-up. Flushes the final value and closes the transaction. */
  end(ops?: CanvasOp[]): void {
    if (ops) { this._pending = ops; }
    this._flush();
    this._txnId = null;
    this._pending = null;
    this._lastEmitted = null;
  }

  /** Abandon a gesture without emitting whatever was pending (Escape). */
  cancel(): void {
    this._txnId = null;
    this._pending = null;
    this._lastEmitted = null;
  }

  /**
   * A discrete edit (a select, a toggle, a typed field). Rides an open gesture
   * when there is one, so a click inside a drag cannot split the undo step, and
   * otherwise mints its own single-op transaction.
   */
  commit(ops: CanvasOp[]): void {
    if (ops.length === 0) { return; }
    if (this._txnId) { this._pending = ops; this._flush(); return; }
    this._emit({ txnId: this._newId(), ops });
  }

  private _flush(): void {
    const ops = this._pending;
    const txnId = this._txnId;
    if (!ops || ops.length === 0 || !txnId) { return; }
    const fingerprint = JSON.stringify(ops);
    if (fingerprint === this._lastEmitted) { this._pending = null; return; }
    this._lastEmitted = fingerprint;
    this._lastEmitAt = this._now();
    this._pending = null;
    this._emit({ txnId, ops });
  }
}
