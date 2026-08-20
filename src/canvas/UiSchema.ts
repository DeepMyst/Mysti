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
 * Plan 22 §4 row 3 — the schema the properties panel is GENERATED from.
 *
 * Today the inspector is five static `<span>` rows and nine inert swatches
 * (`media/canvas/canvas.js:181-206`) and the op it would write had zero
 * renderers. The fix is not "add inputs": it is to declare, once, what is
 * editable on each of the 22 `UI.*` primitives, so Phase 3 renders controls
 * from data instead of hand-writing a panel per primitive — and so a control
 * cannot exist for a prop the primitive never reads.
 *
 * Two rules the shape enforces:
 *
 * 1. **Token-valued, not free-form.** Anything a theme token can express
 *    (`color`, `radius`, `shadow`, font family, font weight, the spacing unit)
 *    is declared `control: 'token'` with a {@link UiTokenGroup}, so the panel
 *    offers `var(--theme-color-primary)` rather than a raw hex field. A design
 *    stays on-brand because the *editor* is on-brand, not because the user is
 *    disciplined.
 * 2. **Grounded in the runtime.** Every prop declared here is a prop
 *    `resources/canvas-sandbox/ui-primitives.js` actually reads. A prop that
 *    drifts out of the primitive is a prop whose control silently does nothing,
 *    which is the exact failure mode `elementOverrides` already demonstrated —
 *    so `tests/canvas/uiSchema.test.ts` parses the primitive source and fails
 *    on any primitive this file misses or invents.
 *
 * Emits DATA ONLY: no VS Code imports, no DOM. The webview bundle, the host
 * validator and the agent tool-descriptor generator all read the same table.
 */

import type { JsonValue } from './doc/DocNode';

/* ────────────────────────────── token groups ────────────────────────────── */

/**
 * A family of `--theme-*` custom properties a control can offer as its values.
 * Mirrors the shape of `DesignTheme` as flattened by
 * `CanvasSandbox.themeTokenMap`.
 */
export type UiTokenGroup = 'color' | 'radius' | 'shadow' | 'font' | 'weight' | 'space';

/**
 * The concrete token names in each group, WITHOUT the `--theme-` prefix — the
 * same keys `themeTokenMap()` emits. Colors carry the ten guaranteed
 * `DesignTheme.colors` members; a theme may add more (the type has an index
 * signature), so consumers should treat this as the *offered* set, not a
 * closed one.
 */
export const THEME_TOKENS: Readonly<Record<UiTokenGroup, readonly string[]>> = Object.freeze({
  color: Object.freeze([
    'color-primary', 'color-secondary', 'color-accent', 'color-background', 'color-surface',
    'color-text', 'color-text-secondary', 'color-border', 'color-error', 'color-success',
  ]),
  radius: Object.freeze(['radius-sm', 'radius-md', 'radius-lg', 'radius-full']),
  shadow: Object.freeze(['shadow-sm', 'shadow-md', 'shadow-lg']),
  font: Object.freeze(['font-body', 'font-heading']),
  weight: Object.freeze(['weight-regular', 'weight-medium', 'weight-bold']),
  space: Object.freeze(['space-unit']),
}) as Readonly<Record<UiTokenGroup, readonly string[]>>;

/** `'color-primary'` → `'var(--theme-color-primary)'` — the value a control writes. */
export function themeTokenValue(token: string): string {
  return `var(--theme-${token})`;
}

/** Every offered token value across all groups, as `var(--theme-…)` strings. */
export function allThemeTokenValues(): string[] {
  const out: string[] = [];
  for (const group of Object.keys(THEME_TOKENS) as UiTokenGroup[]) {
    for (const token of THEME_TOKENS[group]) { out.push(themeTokenValue(token)); }
  }
  return out;
}

/* ─────────────────────────────── control kinds ─────────────────────────────── */

/**
 * What widget the inspector renders.
 *
 * `slot` / `slotList` are NOT text inputs: they name a `DocNode.slots` entry,
 * so the panel offers "insert element here" rather than pretending a subtree is
 * a string.
 */
export type UiControl =
  | 'text'      // single-line string
  | 'textarea'  // multi-line string
  | 'number'
  | 'boolean'
  | 'select'    // one of `options`
  | 'token'     // one of `THEME_TOKENS[tokenGroup]`, written as var(--theme-…)
  | 'length'    // CSS length: number + unit, or a token when tokenGroup is set
  | 'color'     // free-form color — only where no token can express it
  | 'json'      // structured literal (Chart.data, TabBar.items)
  | 'slot'      // one DocNode subtree, via DocNode.slots
  | 'slotList'; // an ordered list of DocNode subtrees, via DocNode.slots

/** An editable literal prop on a primitive (`DocNode.props[name]`). */
export interface UiPropSpec {
  /** Prop name as the primitive reads it, and as it is keyed in `DocNode.props`. */
  name: string;
  label: string;
  control: UiControl;
  /** Allowed values for `select`. */
  options?: readonly string[];
  /** Token family for `token` / `length` controls. */
  tokenGroup?: UiTokenGroup;
  /** The primitive's own fallback when the prop is absent — shown as placeholder, never written. */
  default?: JsonValue;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Set on `slot`/`slotList` controls: the `DocNode.slots` key they edit. */
  slot?: boolean;
  description?: string;
}

/** An editable CSS declaration (`DocNode.style[prop]`, kebab-cased). */
export interface UiStyleSpec {
  /** Kebab-case CSS property — the exact key `PageCompiler` writes into `DocNode.style`. */
  prop: string;
  label: string;
  control: UiControl;
  tokenGroup?: UiTokenGroup;
  options?: readonly string[];
  /** Offered units for a `length` control. */
  units?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
}

/** Broad grouping for inspector section headers and the insert palette. */
export type UiPrimitiveGroup = 'layout' | 'surface' | 'control' | 'data' | 'typography';

/** How a primitive consumes `DocNode.text` / `DocNode.children`. */
export type UiContentKind = 'none' | 'elements' | 'text';

export interface UiPrimitiveSchema {
  /** Fully qualified `DocNode.tag`, e.g. `'UI.Card'`. */
  tag: string;
  /** Bare name as exported on `window.UI`. */
  name: string;
  group: UiPrimitiveGroup;
  description: string;
  /** `'text'` → inline-editable leaf; `'elements'` → accepts children; `'none'` → configured by props only. */
  content: UiContentKind;
  props: readonly UiPropSpec[];
  /** JSX-valued props, stored under `DocNode.slots`. */
  slots: readonly string[];
  /** Fully resolved style controls (common box styles already merged in). */
  styles: readonly UiStyleSpec[];
}

/* ───────────────────────────── style vocabularies ───────────────────────────── */

const LENGTH_UNITS = Object.freeze(['px', '%', 'rem', 'em', 'vh', 'vw']);

const DISPLAY_OPTIONS = Object.freeze(['block', 'inline-block', 'flex', 'inline-flex', 'grid', 'none']);
const ALIGN_OPTIONS = Object.freeze(['flex-start', 'center', 'flex-end', 'stretch', 'baseline']);
const JUSTIFY_OPTIONS = Object.freeze(['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']);
const DIRECTION_OPTIONS = Object.freeze(['row', 'column', 'row-reverse', 'column-reverse']);
const TEXT_ALIGN_OPTIONS = Object.freeze(['left', 'center', 'right', 'justify']);
const TEXT_TRANSFORM_OPTIONS = Object.freeze(['none', 'uppercase', 'lowercase', 'capitalize']);
const OVERFLOW_OPTIONS = Object.freeze(['visible', 'hidden', 'auto', 'scroll']);
const BORDER_STYLE_OPTIONS = Object.freeze(['none', 'solid', 'dashed', 'dotted']);
const HEADING_TAGS = Object.freeze(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div']);

/**
 * Styles every primitive honors, because every primitive merges `p.style` last
 * (`cx(base, p.style)` in `ui-primitives.js`). Ordered as the inspector shows
 * them: size, spacing, then paint.
 */
export const UI_COMMON_STYLES: readonly UiStyleSpec[] = Object.freeze([
  { prop: 'width', label: 'Width', control: 'length', units: LENGTH_UNITS },
  { prop: 'height', label: 'Height', control: 'length', units: LENGTH_UNITS },
  { prop: 'min-width', label: 'Min width', control: 'length', units: LENGTH_UNITS },
  { prop: 'min-height', label: 'Min height', control: 'length', units: LENGTH_UNITS },
  { prop: 'max-width', label: 'Max width', control: 'length', units: LENGTH_UNITS },
  { prop: 'margin', label: 'Margin', control: 'length', units: LENGTH_UNITS },
  { prop: 'padding', label: 'Padding', control: 'length', units: LENGTH_UNITS },
  { prop: 'background', label: 'Background', control: 'token', tokenGroup: 'color' },
  { prop: 'border-color', label: 'Border color', control: 'token', tokenGroup: 'color' },
  { prop: 'border-width', label: 'Border width', control: 'length', units: LENGTH_UNITS },
  { prop: 'border-style', label: 'Border style', control: 'select', options: BORDER_STYLE_OPTIONS },
  { prop: 'border-radius', label: 'Corner radius', control: 'token', tokenGroup: 'radius' },
  { prop: 'box-shadow', label: 'Shadow', control: 'token', tokenGroup: 'shadow' },
  { prop: 'opacity', label: 'Opacity', control: 'number', min: 0, max: 1, step: 0.05 },
  { prop: 'display', label: 'Display', control: 'select', options: DISPLAY_OPTIONS },
  { prop: 'flex', label: 'Flex', control: 'text' },
  { prop: 'align-self', label: 'Align self', control: 'select', options: ALIGN_OPTIONS },
  { prop: 'overflow', label: 'Overflow', control: 'select', options: OVERFLOW_OPTIONS },
]) as readonly UiStyleSpec[];

/** Typographic controls — only on primitives that actually render text. */
export const UI_TEXT_STYLES: readonly UiStyleSpec[] = Object.freeze([
  { prop: 'color', label: 'Text color', control: 'token', tokenGroup: 'color' },
  { prop: 'font-family', label: 'Font', control: 'token', tokenGroup: 'font' },
  { prop: 'font-size', label: 'Font size', control: 'length', units: LENGTH_UNITS },
  { prop: 'font-weight', label: 'Weight', control: 'token', tokenGroup: 'weight' },
  { prop: 'line-height', label: 'Line height', control: 'number', min: 0.8, max: 3, step: 0.05 },
  { prop: 'letter-spacing', label: 'Letter spacing', control: 'length', units: LENGTH_UNITS },
  { prop: 'text-align', label: 'Align', control: 'select', options: TEXT_ALIGN_OPTIONS },
  { prop: 'text-transform', label: 'Case', control: 'select', options: TEXT_TRANSFORM_OPTIONS },
]) as readonly UiStyleSpec[];

/** Flex-container controls — only on primitives that lay children out. */
export const UI_FLEX_STYLES: readonly UiStyleSpec[] = Object.freeze([
  { prop: 'gap', label: 'Gap', control: 'length', units: LENGTH_UNITS },
  { prop: 'flex-direction', label: 'Direction', control: 'select', options: DIRECTION_OPTIONS },
  { prop: 'align-items', label: 'Align items', control: 'select', options: ALIGN_OPTIONS },
  { prop: 'justify-content', label: 'Justify', control: 'select', options: JUSTIFY_OPTIONS },
  { prop: 'flex-wrap', label: 'Wrap', control: 'select', options: Object.freeze(['nowrap', 'wrap']) },
]) as readonly UiStyleSpec[];

/**
 * The style set offered on a plain HTML tag (`div`, `h1`, `img`, …), which has
 * no primitive schema but is still a first-class `DocNode`.
 */
export const HTML_TAG_STYLES: readonly UiStyleSpec[] =
  Object.freeze([...UI_COMMON_STYLES, ...UI_FLEX_STYLES, ...UI_TEXT_STYLES]) as readonly UiStyleSpec[];

/* ────────────────────────────── the 22 primitives ────────────────────────────── */

interface PrimitiveDraft {
  name: string;
  group: UiPrimitiveGroup;
  description: string;
  content: UiContentKind;
  props?: readonly UiPropSpec[];
  /** Extra style groups merged after {@link UI_COMMON_STYLES}. */
  extraStyles?: readonly UiStyleSpec[];
}

function build(draft: PrimitiveDraft): UiPrimitiveSchema {
  const props = draft.props ?? [];
  const styles: UiStyleSpec[] = [];
  const seen = new Set<string>();
  for (const spec of [...UI_COMMON_STYLES, ...(draft.extraStyles ?? [])]) {
    if (seen.has(spec.prop)) { continue; }
    seen.add(spec.prop);
    styles.push(spec);
  }
  return Object.freeze({
    tag: `UI.${draft.name}`,
    name: draft.name,
    group: draft.group,
    description: draft.description,
    content: draft.content,
    props: Object.freeze(props) as readonly UiPropSpec[],
    slots: Object.freeze(props.filter(p => p.slot === true).map(p => p.name)) as readonly string[],
    styles: Object.freeze(styles) as readonly UiStyleSpec[],
  });
}

const DRAFTS: readonly PrimitiveDraft[] = [
  // ── layout ──
  {
    name: 'Screen', group: 'layout', content: 'elements',
    description: 'Full-bleed artboard root: a column that fills the device frame.',
    props: [
      { name: 'background', label: 'Background', control: 'token', tokenGroup: 'color', default: 'var(--theme-color-background)' },
    ],
    extraStyles: UI_FLEX_STYLES,
  },
  {
    name: 'Stack', group: 'layout', content: 'elements',
    description: 'Vertical flex column with a gap.',
    props: [
      { name: 'gap', label: 'Gap', control: 'number', default: 12, min: 0, max: 160, step: 1 },
      { name: 'padding', label: 'Padding', control: 'number', min: 0, max: 160, step: 1 },
      { name: 'align', label: 'Align items', control: 'select', options: ALIGN_OPTIONS },
    ],
    extraStyles: UI_FLEX_STYLES,
  },
  {
    name: 'Row', group: 'layout', content: 'elements',
    description: 'Horizontal flex row with a gap.',
    props: [
      { name: 'gap', label: 'Gap', control: 'number', default: 12, min: 0, max: 160, step: 1 },
      { name: 'align', label: 'Align items', control: 'select', options: ALIGN_OPTIONS, default: 'center' },
      { name: 'justify', label: 'Justify', control: 'select', options: JUSTIFY_OPTIONS },
    ],
    extraStyles: UI_FLEX_STYLES,
  },
  {
    name: 'AppShell', group: 'layout', content: 'elements',
    description: 'Desktop app frame: optional sidebar + top bar around a scrolling main area.',
    props: [
      { name: 'sidebar', label: 'Sidebar', control: 'slot', slot: true, description: 'A UI.Sidebar subtree.' },
      { name: 'topBar', label: 'Top bar', control: 'slot', slot: true, description: 'A UI.TopBar subtree.' },
      { name: 'sidebarWidth', label: 'Sidebar width', control: 'number', default: 248, min: 120, max: 480, step: 4 },
      { name: 'padding', label: 'Content padding', control: 'number', default: 24, min: 0, max: 160, step: 1 },
    ],
  },
  {
    name: 'Sidebar', group: 'layout', content: 'elements',
    description: 'Vertical nav column with an optional brand row.',
    props: [
      { name: 'brand', label: 'Brand', control: 'text', placeholder: '◆ Acme' },
    ],
    extraStyles: UI_FLEX_STYLES,
  },
  {
    name: 'SidebarItem', group: 'layout', content: 'text',
    description: 'One nav row inside a UI.Sidebar.',
    props: [
      { name: 'label', label: 'Label', control: 'text' },
      { name: 'icon', label: 'Icon', control: 'text', placeholder: '◆' },
      { name: 'active', label: 'Active', control: 'boolean', default: false },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'TopBar', group: 'layout', content: 'none',
    description: 'App header: title on the left, action elements on the right.',
    props: [
      { name: 'title', label: 'Title', control: 'text' },
      { name: 'actions', label: 'Actions', control: 'slotList', slot: true, description: 'Buttons / avatars rendered at the right.' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'StatusBar', group: 'layout', content: 'none',
    description: 'Mobile status bar: clock on the left, indicators on the right.',
    props: [
      { name: 'time', label: 'Time', control: 'text', default: '9:41' },
      { name: 'right', label: 'Indicators', control: 'text', default: '●●● ◢ ▭' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'TabBar', group: 'layout', content: 'none',
    description: 'Mobile bottom tab bar driven by an items array.',
    props: [
      {
        name: 'items', label: 'Tabs', control: 'json',
        default: [], description: 'Array of { label, icon?, active? }.',
      },
    ],
  },

  // ── surfaces ──
  {
    name: 'Card', group: 'surface', content: 'elements',
    description: 'Elevated surface with border, radius and shadow.',
    props: [
      { name: 'padding', label: 'Padding', control: 'number', default: 16, min: 0, max: 96, step: 1 },
    ],
  },
  {
    name: 'Section', group: 'surface', content: 'elements',
    description: 'Marketing section with an optional title and subtitle.',
    props: [
      { name: 'title', label: 'Title', control: 'text' },
      { name: 'subtitle', label: 'Subtitle', control: 'textarea' },
      { name: 'padding', label: 'Padding', control: 'text', default: '64px 48px' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'Hero', group: 'surface', content: 'elements',
    description: 'Above-the-fold hero with eyebrow, headline, subtitle and CTA children.',
    props: [
      { name: 'eyebrow', label: 'Eyebrow', control: 'text' },
      { name: 'title', label: 'Headline', control: 'textarea' },
      { name: 'subtitle', label: 'Subtitle', control: 'textarea' },
      { name: 'align', label: 'Align', control: 'select', options: Object.freeze(['center', 'left']), default: 'center' },
      { name: 'background', label: 'Background', control: 'token', tokenGroup: 'color', default: 'var(--theme-color-surface)' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },

  // ── controls ──
  {
    name: 'Button', group: 'control', content: 'text',
    description: 'Primary / secondary / ghost action button.',
    props: [
      { name: 'label', label: 'Label', control: 'text' },
      { name: 'variant', label: 'Variant', control: 'select', options: Object.freeze(['primary', 'secondary', 'ghost']), default: 'primary' },
      { name: 'size', label: 'Size', control: 'select', options: Object.freeze(['md', 'lg']), default: 'md' },
      { name: 'icon', label: 'Icon', control: 'text' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'Field', group: 'control', content: 'none',
    description: 'Labelled text input.',
    props: [
      { name: 'label', label: 'Label', control: 'text' },
      { name: 'placeholder', label: 'Placeholder', control: 'text' },
      { name: 'value', label: 'Value', control: 'text' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'Badge', group: 'control', content: 'text',
    description: 'Small status pill.',
    props: [
      { name: 'label', label: 'Label', control: 'text' },
      { name: 'tone', label: 'Tone', control: 'select', options: Object.freeze(['neutral', 'success', 'error', 'primary']), default: 'neutral' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'Avatar', group: 'control', content: 'none',
    description: 'Circular user avatar — image when `src` is set, otherwise initials.',
    props: [
      { name: 'initials', label: 'Initials', control: 'text', default: '?' },
      { name: 'src', label: 'Image', control: 'text', placeholder: 'asset://…' },
      { name: 'size', label: 'Size', control: 'number', default: 36, min: 16, max: 200, step: 2 },
    ],
  },

  // ── data ──
  {
    name: 'ListRow', group: 'data', content: 'none',
    description: 'List item with leading/trailing slots and a two-line label.',
    props: [
      { name: 'title', label: 'Title', control: 'text' },
      { name: 'subtitle', label: 'Subtitle', control: 'text' },
      { name: 'leading', label: 'Leading', control: 'slot', slot: true },
      { name: 'trailing', label: 'Trailing', control: 'slot', slot: true },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'StatCard', group: 'data', content: 'none',
    description: 'KPI tile: label, big value and a delta line.',
    props: [
      { name: 'label', label: 'Label', control: 'text' },
      { name: 'value', label: 'Value', control: 'text' },
      { name: 'delta', label: 'Delta', control: 'text', placeholder: '▲ 12.4% MoM' },
      { name: 'deltaUp', label: 'Delta is positive', control: 'boolean', default: true },
    ],
  },
  {
    name: 'EmptyState', group: 'data', content: 'none',
    description: 'Centered empty / zero-data state with an optional action.',
    props: [
      { name: 'title', label: 'Title', control: 'text' },
      { name: 'description', label: 'Description', control: 'textarea' },
      { name: 'icon', label: 'Icon', control: 'text' },
      { name: 'action', label: 'Action', control: 'slot', slot: true },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'Chart', group: 'data', content: 'none',
    description: 'Bar chart over a literal { label, value } series.',
    props: [
      { name: 'type', label: 'Type', control: 'select', options: Object.freeze(['bar']), default: 'bar' },
      { name: 'data', label: 'Series', control: 'json', default: [], description: 'Array of { label, value }.' },
      { name: 'height', label: 'Height', control: 'number', default: 180, min: 60, max: 720, step: 10 },
    ],
  },

  // ── typography ──
  {
    name: 'Heading', group: 'typography', content: 'text',
    description: 'Heading text in the theme heading family.',
    props: [
      { name: 'as', label: 'Level', control: 'select', options: HEADING_TAGS, default: 'h2' },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
  {
    name: 'Text', group: 'typography', content: 'text',
    description: 'Body copy; `muted` switches to the secondary text color.',
    props: [
      { name: 'muted', label: 'Muted', control: 'boolean', default: false },
    ],
    extraStyles: UI_TEXT_STYLES,
  },
];

/** Every primitive schema, keyed by fully qualified `DocNode.tag` (`'UI.Card'`). */
export const UI_SCHEMA: Readonly<Record<string, UiPrimitiveSchema>> = Object.freeze(
  DRAFTS.reduce<Record<string, UiPrimitiveSchema>>((acc, draft) => {
    const schema = build(draft);
    acc[schema.tag] = schema;
    return acc;
  }, {}),
);

/** Fully qualified tags, in palette order. */
export const UI_PRIMITIVE_TAGS: readonly string[] = Object.freeze(DRAFTS.map(d => `UI.${d.name}`));

/** Bare `window.UI` export names, in palette order. */
export const UI_PRIMITIVE_NAMES: readonly string[] = Object.freeze(DRAFTS.map(d => d.name));

/* ─────────────────────────────── lookup helpers ─────────────────────────────── */

/** True for a tag naming one of the 22 primitives (`'UI.Card'`, not `'Card'`). */
export function isUiTag(tag: string): boolean {
  return Object.prototype.hasOwnProperty.call(UI_SCHEMA, tag);
}

/**
 * Schema for a tag. Accepts both `'UI.Card'` and the bare `'Card'` so callers
 * holding either form (wire tag vs. `window.UI` key) don't each roll their own
 * normalization. Returns `undefined` for HTML tags and unknown primitives —
 * never a partially-populated stand-in, because a fake schema is how an
 * inspector grows controls for props nothing reads.
 */
export function uiSchemaFor(tag: string | undefined | null): UiPrimitiveSchema | undefined {
  if (typeof tag !== 'string' || tag.length === 0) { return undefined; }
  const qualified = tag.startsWith('UI.') ? tag : `UI.${tag}`;
  return Object.prototype.hasOwnProperty.call(UI_SCHEMA, qualified) ? UI_SCHEMA[qualified] : undefined;
}

/** The prop spec for `name` on `tag`, or `undefined` when the prop is not editable. */
export function uiPropSpec(tag: string, name: string): UiPropSpec | undefined {
  return uiSchemaFor(tag)?.props.find(p => p.name === name);
}

/** The style spec for a kebab-case CSS property on `tag`, or `undefined`. */
export function uiStyleSpec(tag: string, prop: string): UiStyleSpec | undefined {
  return stylesForTag(tag).find(s => s.prop === prop);
}

/**
 * Style controls for any `DocNode.tag` — the primitive's resolved set, or the
 * generic HTML set for allowlisted plain tags. This is the ONE function the
 * inspector calls, so a plain `<div>` and a `UI.Card` cannot diverge into two
 * code paths.
 */
export function stylesForTag(tag: string | undefined | null): readonly UiStyleSpec[] {
  return uiSchemaFor(tag)?.styles ?? HTML_TAG_STYLES;
}

/** Prop controls for any tag; empty for HTML tags (their props are attributes, edited elsewhere). */
export function propsForTag(tag: string | undefined | null): readonly UiPropSpec[] {
  return uiSchemaFor(tag)?.props ?? [];
}

/** True when a tag renders `DocNode.text`, i.e. inline text editing is meaningful. */
export function supportsTextEditing(tag: string | undefined | null): boolean {
  const schema = uiSchemaFor(tag);
  if (schema) { return schema.content === 'text'; }
  return typeof tag === 'string' && TEXTUAL_HTML_TAGS.has(tag);
}

/** True when a tag accepts child elements. */
export function supportsChildren(tag: string | undefined | null): boolean {
  const schema = uiSchemaFor(tag);
  if (schema) { return schema.content === 'elements'; }
  return typeof tag === 'string' && !VOID_HTML_TAGS.has(tag);
}

/** HTML tags whose whole content is text — inline editing targets. */
export const TEXTUAL_HTML_TAGS: ReadonlySet<string> = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'small',
  'label', 'li', 'a', 'button', 'code', 'blockquote', 'figcaption', 'td', 'th',
]);

/** HTML tags that take no children. */
export const VOID_HTML_TAGS: ReadonlySet<string> = new Set(['img', 'br', 'hr', 'input']);
