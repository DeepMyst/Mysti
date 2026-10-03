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
 * Plan 22 3.4 - the parent-side static artboard renderer.
 *
 * Because the PARENT holds the `DocNode` tree, it can draw any artboard
 * directly into webview DOM with **no iframe and no scripts**. One renderer
 * then serves rail thumbnails, offscreen board tiles, zoomed-out views and
 * staged before/after previews - always fresh, never rasterized. (Rasterizing
 * the live frame was never on the table: `sandbox="allow-scripts"` without
 * `allow-same-origin` denies the parent pixel access, so every "just snapshot
 * the iframe" design in this subsystem was dead on arrival.)
 *
 * ## The threat model this file exists to survive
 *
 * A `DocNode` tree is **model-authored, prompt-injectable content**, and unlike
 * the live frame it is rendered in the *parent* document - the one holding the
 * `viewToken` and the `acquireVsCodeApi()` handle. A single `innerHTML` here
 * would be a full webview compromise. So:
 *
 * 1. **Text is `textContent`, always.** {@link DomElement} does not even declare
 *    `innerHTML`, so an injection is a compile error rather than a review miss.
 * 2. **Tags come from an allowlist**, mapped to inert presentational elements -
 *    no `a[href]`, no `form`, no `script`/`style`/`iframe`/`object`, and no
 *    event-handler attributes anywhere (only four attribute names can be set).
 * 3. **Styles are allowlisted by property AND value**, written through
 *    `style.setProperty` - never concatenated into a `style="..."` attribute, so
 *    declaration breakout is structurally impossible. `url(` is refused
 *    outright, which closes the CSS GET-beacon exfil channel in the parent.
 * 4. **`img` resolves only `asset://`**, through the injected resolver, and the
 *    resolved URL must still pass a scheme allowlist.
 * 5. **Bounded work.** Node and depth caps keep a hostile (or merely enormous)
 *    doc from hanging the webview - the board renders N of these per frame.
 *
 * ## Two-stage by design
 *
 * {@link renderPreview} is pure: `DocNode` to a normalized {@link PreviewNode}
 * tree of already-sanitized primitives. {@link mountPreview} materializes it.
 * That split is what makes the security properties assertable in a unit test
 * with no DOM at all, and it lets the board diff/cache preview trees later.
 */

import type { DocNode, JsonValue, Mid } from '../../canvas/doc/DocNode';
import type { DomDocument, DomElement } from './dom';

/* ------------------------------ output shape ------------------------------ */

export interface PreviewNode {
  /** Always a real, inert HTML tag drawn from {@link SAFE_TAGS}. */
  tag: string;
  /** Only ever `data-mid`, `data-ui`, `alt`, `src`. Never `on*`, never `style`. */
  attrs: Record<string, string>;
  /** Applied via `style.setProperty`; never serialized into an attribute. */
  style: Record<string, string>;
  /** Leaf content. Mounted with `textContent` and nothing else. */
  text?: string;
  children: PreviewNode[];
}

export interface PreviewStats {
  nodes: number;
  /** True when a cap tripped - the board badges the tile as partial. */
  truncated: boolean;
  /** Values a sanitizer refused. Surfaced in dev, never rendered. */
  dropped: number;
}

export interface PreviewResult {
  root: PreviewNode;
  stats: PreviewStats;
}

export interface PreviewOptions {
  /**
   * An `asset://...` ref to a URL this webview may load, or `null` to refuse.
   * Anything that is not an `asset://` ref never reaches the resolver.
   */
  resolveAsset?: (ref: string) => string | null;
  /** Stamp `data-mid` so the parent overlay can hit-test the preview. */
  markMids?: boolean;
  maxNodes?: number;
  maxDepth?: number;
  maxTextLength?: number;
}

export const PREVIEW_MAX_NODES = 4000;
export const PREVIEW_MAX_DEPTH = 64;
export const PREVIEW_MAX_TEXT = 5000;

/* ------------------------------- allowlists ------------------------------- */

/**
 * HTML tags a doc may name. Everything maps to an inert element: `a` and
 * `button` become `span`/`div` so a preview can neither navigate nor submit,
 * and unknown tags degrade to `div` rather than being dropped (a missing
 * container silently reflows the whole tile).
 */
const TAG_MAP: Readonly<Record<string, string>> = {
  div: 'div', span: 'span', p: 'p', section: 'section', article: 'section',
  header: 'header', footer: 'footer', nav: 'nav', main: 'main', aside: 'aside',
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  ul: 'ul', ol: 'ol', li: 'li', dl: 'div', dt: 'div', dd: 'div',
  strong: 'strong', em: 'em', b: 'strong', i: 'em', small: 'small',
  hr: 'hr', br: 'br', figure: 'figure', figcaption: 'figcaption',
  blockquote: 'blockquote', pre: 'pre', code: 'code', label: 'span',
  table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', td: 'td', th: 'th',
  img: 'img',
  // Interactive tags render as inert boxes - a preview must never navigate.
  a: 'span', button: 'div', input: 'div', textarea: 'div', select: 'div',
  form: 'div', option: 'div', video: 'div', audio: 'div', canvas: 'div',
};

/** The only tags that may ever be produced, whatever the doc says. */
export const SAFE_TAGS: ReadonlySet<string> = new Set(Object.values(TAG_MAP));

/** Void elements - appending children to them is a DOM error in some engines. */
const VOID_TAGS: ReadonlySet<string> = new Set(['img', 'hr', 'br']);

/** The only attribute names {@link mountPreview} will ever set. */
export const PREVIEW_ATTRS: ReadonlySet<string> = new Set(['data-mid', 'data-ui', 'alt', 'src']);

const STYLE_PROPS: ReadonlySet<string> = new Set([
  'display', 'flex-direction', 'flex-wrap', 'align-items', 'align-self', 'align-content',
  'justify-content', 'justify-self', 'justify-items', 'gap', 'row-gap', 'column-gap',
  'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-area',
  'grid-column', 'grid-row', 'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'background', 'background-color', 'color', 'opacity',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'box-shadow', 'box-sizing',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'text-transform', 'text-decoration',
  'text-overflow', 'white-space', 'word-break', 'overflow', 'overflow-x', 'overflow-y',
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'object-fit', 'object-position', 'list-style', 'vertical-align', 'cursor',
]);

/** `fixed`/`sticky` escape the tile's clip; only in-flow positioning is allowed. */
const SAFE_POSITIONS: ReadonlySet<string> = new Set(['static', 'relative', 'absolute']);

const STYLE_VALUE_OK = /^[a-zA-Z0-9\s#%.,:()\-_/'"+*!]+$/;
/**
 * A backslash is refused because a CSS escape can spell `url` past a naive
 * substring check; refusing them outright is cheaper than parsing CSS.
 */
const STYLE_VALUE_BAD = /url\s*\(|expression\s*\(|image-set\s*\(|-moz-binding|javascript\s*:|@import|\\/i;
const STYLE_VALUE_MAX = 240;

/** Schemes an `img[src]` may end up with after the resolver has run. */
const SAFE_IMG_SCHEME = /^(https:|blob:|data:image\/|vscode-resource:|vscode-webview-resource:|vscode-webview:)/i;

/**
 * `asset://` refs are content-addressed names, never paths. Traversal segments
 * are refused HERE as well as in `boot.ts`'s resolver: two independent gates,
 * because a ref reaches this function straight out of model-authored `props`.
 */
const ASSET_REF = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._\-/]{0,255}$/;

/**
 * Control characters that must never reach a text node. Matching them is the
 * entire point, so the lint rule that forbids them in a pattern is disabled
 * here rather than worked around.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

/* --------------------- UI.* primitive approximations --------------------- */

interface PrimitiveSpec {
  tag: string;
  style: Record<string, string>;
  /** String props rendered as leading text children, in order. */
  textProps?: readonly string[];
  /** Array-of-object prop whose `{label}` entries render as text children. */
  itemsProp?: string;
  /**
   * The real component renders `p.<textProp> || p.children`, so a populated
   * text prop is the WHOLE content: it beats `DocNode.text` (which
   * `harness.js renderChildren` hands the component as its children) and beats
   * real children too.
   *
   * Only `UI.Button` and `UI.SidebarItem` do this. Every other primitive either
   * renders children/`text` alone or prefers them, so `text` wins there - which
   * is the default. Getting this backwards made a double-click text edit on a
   * button read one thing in every preview and another in the live frame the
   * human was looking at (Plan 22 risk 3, the two renderers drifting).
   */
  textPropWins?: boolean;
}

/**
 * A theme token reference, WITH a fallback.
 *
 * These custom properties live on whatever host mounts the preview, and an
 * undefined one makes the whole declaration invalid at computed-value time -
 * `background` falls back to `transparent`, `border`/`box-shadow`/`radius`
 * collapse to nothing, and `color` inherits the SHELL's foreground, so in a
 * dark editor the design was its own text at ~1.6:1 on white. The rail stamps
 * `themeCssVars` on its tiles for exactly this reason, but a renderer used by
 * four hosts cannot depend on all four remembering: the fallback keeps a design
 * legible and structurally intact wherever it is drawn, and is unused the
 * moment the host supplies the real token.
 */
const V = (token: string): string => {
  const fallback = TOKEN_FALLBACKS[token];
  return fallback ? `var(--theme-${token}, ${fallback})` : `var(--theme-${token})`;
};

/** Neutral last resort per token - never a substitute for the real theme. */
const TOKEN_FALLBACKS: Readonly<Record<string, string>> = {
  'color-background': '#ffffff',
  'color-surface': '#f8fafc',
  'color-border': '#e2e8f0',
  'color-text': '#0f172a',
  'color-text-secondary': '#64748b',
  'color-primary': '#2563eb',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-full': '999px',
  'shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.06)',
  'font-heading': 'inherit',
  'weight-bold': '700',
};

/**
 * The 22 `window.UI` primitives, approximated with the *same* CSS the real
 * components emit (`resources/canvas-sandbox/ui-primitives.js`) so the preview
 * and the live frame agree on geometry. Plan 22 risk 3 is explicit that these
 * two renderers can drift; keeping the declarations literally parallel is the
 * mitigation, and a primitive missing from this table degrades to a plain box
 * rather than vanishing.
 */
const PRIMITIVES: Readonly<Record<string, PrimitiveSpec>> = {
  Screen: { tag: 'div', style: { width: '100%', 'min-height': '100%', display: 'flex', 'flex-direction': 'column', background: V('color-background') } },
  Stack: { tag: 'div', style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } },
  Row: { tag: 'div', style: { display: 'flex', 'flex-direction': 'row', gap: '12px', 'align-items': 'center' } },
  AppShell: { tag: 'div', style: { display: 'flex', 'flex-direction': 'column', width: '100%', 'min-height': '100%', background: V('color-background') } },
  Sidebar: { tag: 'aside', style: { height: '100%', background: V('color-surface'), 'border-right': `1px solid ${V('color-border')}`, padding: '16px 12px', display: 'flex', 'flex-direction': 'column', gap: '4px' }, textProps: ['brand'] },
  SidebarItem: { tag: 'span', style: { display: 'flex', 'align-items': 'center', gap: '10px', padding: '9px 10px', 'border-radius': V('radius-md'), color: V('color-text'), 'font-size': '14px' }, textProps: ['label'], textPropWins: true },
  TopBar: { tag: 'header', style: { height: '56px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '0 20px', background: V('color-surface'), 'border-bottom': `1px solid ${V('color-border')}` }, textProps: ['title'] },
  StatusBar: { tag: 'div', style: { height: '44px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '0 18px', 'font-size': '13px', color: V('color-text') }, textProps: ['time', 'right'] },
  TabBar: { tag: 'nav', style: { display: 'flex', 'justify-content': 'space-around', 'align-items': 'center', height: '64px', 'border-top': `1px solid ${V('color-border')}`, background: V('color-surface') }, itemsProp: 'items' },
  Card: { tag: 'div', style: { background: V('color-surface'), border: `1px solid ${V('color-border')}`, 'border-radius': V('radius-lg'), 'box-shadow': V('shadow-sm'), padding: '16px' } },
  Section: { tag: 'section', style: { padding: '64px 48px' }, textProps: ['title', 'subtitle'] },
  Hero: { tag: 'section', style: { padding: '96px 48px', display: 'flex', 'flex-direction': 'column', gap: '16px', background: V('color-surface') }, textProps: ['eyebrow', 'title', 'subtitle'] },
  Button: { tag: 'div', style: { display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', gap: '8px', padding: '10px 16px', 'border-radius': V('radius-md'), background: V('color-primary'), color: '#fff', 'font-size': '14px' }, textProps: ['label'], textPropWins: true },
  Field: { tag: 'div', style: { display: 'flex', 'flex-direction': 'column', gap: '6px' }, textProps: ['label', 'placeholder'] },
  Badge: { tag: 'span', style: { display: 'inline-flex', 'align-items': 'center', padding: '2px 8px', 'border-radius': V('radius-full'), background: V('color-surface'), 'font-size': '12px' }, textProps: ['label'] },
  Avatar: { tag: 'span', style: { display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', width: '32px', height: '32px', 'border-radius': V('radius-full'), background: V('color-border'), 'font-size': '13px' }, textProps: ['initials'] },
  ListRow: { tag: 'div', style: { display: 'flex', 'align-items': 'center', gap: '12px', padding: '12px 16px', 'border-bottom': `1px solid ${V('color-border')}` }, textProps: ['title', 'subtitle'] },
  StatCard: { tag: 'div', style: { display: 'flex', 'flex-direction': 'column', gap: '4px', padding: '16px', background: V('color-surface'), border: `1px solid ${V('color-border')}`, 'border-radius': V('radius-lg') }, textProps: ['label', 'value', 'delta'] },
  EmptyState: { tag: 'div', style: { display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '8px', padding: '48px 24px', color: V('color-text-secondary') }, textProps: ['title', 'subtitle'] },
  Chart: { tag: 'div', style: { display: 'flex', 'align-items': 'flex-end', gap: '6px', height: '160px', padding: '12px', background: V('color-surface'), 'border-radius': V('radius-lg') }, itemsProp: 'data' },
  Heading: { tag: 'h2', style: { 'font-family': V('font-heading'), 'font-weight': V('weight-bold'), margin: '0' } },
  Text: { tag: 'p', style: { color: V('color-text'), margin: '0' } },
};

/** Props the primitives translate into layout CSS (`gap={20}` to `gap:20px`). */
const PROP_TO_STYLE: Readonly<Record<string, string>> = {
  gap: 'gap', padding: 'padding', width: 'width', height: 'height',
  align: 'align-items', justify: 'justify-content', background: 'background',
};

/* -------------------------------- render -------------------------------- */

/** `DocNode` to a sanitized {@link PreviewNode} tree. Pure: no DOM, no I/O. */
export function renderPreview(doc: DocNode, opts: PreviewOptions = {}): PreviewResult {
  const stats: PreviewStats = { nodes: 0, truncated: false, dropped: 0 };
  const ctx: RenderCtx = {
    opts,
    stats,
    maxNodes: opts.maxNodes ?? PREVIEW_MAX_NODES,
    maxDepth: opts.maxDepth ?? PREVIEW_MAX_DEPTH,
    maxText: opts.maxTextLength ?? PREVIEW_MAX_TEXT,
  };
  const root = renderNode(doc, ctx, 0) ?? emptyNode();
  return { root, stats };
}

interface RenderCtx {
  opts: PreviewOptions;
  stats: PreviewStats;
  maxNodes: number;
  maxDepth: number;
  maxText: number;
}

function emptyNode(): PreviewNode {
  return { tag: 'div', attrs: {}, style: {}, children: [] };
}

function renderNode(node: DocNode, ctx: RenderCtx, depth: number): PreviewNode | null {
  if (!node || typeof node !== 'object' || typeof node.tag !== 'string') { return null; }
  if (depth > ctx.maxDepth || ctx.stats.nodes >= ctx.maxNodes) {
    ctx.stats.truncated = true;
    return null;
  }
  ctx.stats.nodes++;

  const primitive = primitiveSpecFor(node.tag);
  const tag = primitive?.tag ?? ownGet(TAG_MAP, node.tag.toLowerCase()) ?? 'div';
  const out: PreviewNode = {
    tag,
    attrs: {},
    style: primitive ? { ...primitive.style } : {},
    children: [],
  };

  if (primitive) { out.attrs['data-ui'] = uiName(node.tag); }
  if (ctx.opts.markMids && isSafeMid(node.mid)) { out.attrs['data-mid'] = node.mid; }

  applyPropStyles(node.props, out, ctx);
  applyStyle(node.style, out, ctx);

  if (tag === 'img') {
    const src = resolveImage(node.props, ctx);
    if (src) { out.attrs.src = src; }
    const alt = stringProp(node.props, 'alt');
    out.attrs.alt = alt !== null ? clampText(alt, 200) : '';
    return out;                                   // void element: no children
  }
  if (VOID_TAGS.has(tag)) { return out; }

  // Primitive text props first (they are the component's own chrome), then
  // `text`, then real children/slots - matching the primitives' child order.
  let textPropWon = false;
  if (primitive) {
    for (const prop of primitive.textProps ?? []) {
      const value = stringProp(node.props, prop);
      if (value !== null && value !== '') {
        out.children.push(textLeaf(clampText(value, ctx.maxText), ctx));
        if (primitive.textPropWins && truthyProp(node.props?.[prop])) { textPropWon = true; }
      }
    }
    if (primitive.itemsProp) {
      for (const label of itemLabels(node.props?.[primitive.itemsProp])) {
        if (ctx.stats.nodes >= ctx.maxNodes) { ctx.stats.truncated = true; break; }
        out.children.push(textLeaf(clampText(label, 120), ctx));
      }
    }
  }

  // `p.label || p.children`: the component never looks past a populated label,
  // so neither may this renderer. See {@link PrimitiveSpec.textPropWins}.
  if (textPropWon) { return out; }

  if (typeof node.text === 'string' && node.text.length > 0) {
    out.text = clampText(node.text, ctx.maxText);
    // `text` and `children` are mutually exclusive in the model; if a malformed
    // doc carries both, text wins and children are ignored so the mount stays a
    // single unambiguous `textContent` assignment.
    return out;
  }

  for (const child of node.children ?? []) {
    const rendered = renderNode(child, ctx, depth + 1);
    if (rendered) { out.children.push(rendered); }
  }
  for (const slotName of Object.keys(node.slots ?? {}).sort()) {
    for (const child of node.slots?.[slotName] ?? []) {
      const rendered = renderNode(child, ctx, depth + 1);
      if (rendered) { out.children.push(rendered); }
    }
  }
  return out;
}

function textLeaf(text: string, ctx: RenderCtx): PreviewNode {
  ctx.stats.nodes++;
  return { tag: 'span', attrs: {}, style: {}, text, children: [] };
}

function primitiveSpecFor(tag: string): PrimitiveSpec | null {
  if (!tag.startsWith('UI.')) { return null; }
  return ownGet(PRIMITIVES, tag.slice(3)) ?? { tag: 'div', style: {} };
}

/**
 * Table lookup by a MODEL-AUTHORED key, own properties only.
 *
 * `TAG_MAP['constructor']` is `Object` and `PRIMITIVES['__proto__']` is
 * `Object.prototype` - both truthy, so a plain index handed this renderer a
 * function (or a spec whose `tag` is `undefined`) where its own types promise a
 * string. It is the `__proto__` class the theme-token path already refuses,
 * arriving through the DOM side instead.
 */
function ownGet<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** JS truthiness of a prop, as the component's own `p.x || …` sees it. */
function truthyProp(raw: JsonValue | undefined): boolean {
  if (typeof raw === 'string') { return raw.length > 0; }
  if (typeof raw === 'number') { return Number.isFinite(raw) && raw !== 0; }
  return false;
}

function uiName(tag: string): string {
  const name = tag.slice(3);
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name) ? name : 'Unknown';
}

function isSafeMid(mid: Mid | undefined): mid is Mid {
  return typeof mid === 'string' && /^[a-z2-7]{1,32}$/.test(mid);
}

function stringProp(props: Record<string, JsonValue> | undefined, name: string): string | null {
  const v = props?.[name];
  if (typeof v === 'string') { return v; }
  if (typeof v === 'number' && Number.isFinite(v)) { return String(v); }
  return null;
}

function itemLabels(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) { return []; }
  const out: string[] = [];
  for (const entry of value.slice(0, 24)) {
    if (typeof entry === 'string') { out.push(entry); continue; }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const rec = entry as { [k: string]: JsonValue };
      const label = rec.label ?? rec.name ?? rec.title;
      if (typeof label === 'string') { out.push(label); }
      else if (typeof label === 'number') { out.push(String(label)); }
    }
  }
  return out;
}

function applyPropStyles(props: Record<string, JsonValue> | undefined, out: PreviewNode, ctx: RenderCtx): void {
  if (!props) { return; }
  for (const [prop, cssProp] of Object.entries(PROP_TO_STYLE)) {
    const raw = props[prop];
    if (raw === undefined || raw === null) { continue; }
    const value = typeof raw === 'number' && Number.isFinite(raw)
      ? `${raw}px`
      : (typeof raw === 'string' ? raw : null);
    if (value === null) { continue; }
    const clean = sanitizeStyleValue(cssProp, value);
    if (clean === null) { ctx.stats.dropped++; continue; }
    out.style[cssProp] = clean;
  }
}

function applyStyle(style: Record<string, string> | undefined, out: PreviewNode, ctx: RenderCtx): void {
  if (!style) { return; }
  for (const [rawProp, rawValue] of Object.entries(style)) {
    const prop = normalizeStyleProp(rawProp);
    if (prop === null || !STYLE_PROPS.has(prop)) { ctx.stats.dropped++; continue; }
    if (typeof rawValue !== 'string') { ctx.stats.dropped++; continue; }
    const value = sanitizeStyleValue(prop, rawValue);
    if (value === null) { ctx.stats.dropped++; continue; }
    out.style[prop] = value;
  }
}

/** `backgroundColor` and `background-color` are the same cell. */
export function normalizeStyleProp(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) { return null; }
  const kebab = raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(kebab) ? kebab : null;
}

/** Returns the value to write, or `null` to refuse it. */
export function sanitizeStyleValue(prop: string, raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > STYLE_VALUE_MAX) { return null; }
  if (STYLE_VALUE_BAD.test(value)) { return null; }
  if (!STYLE_VALUE_OK.test(value)) { return null; }
  if (prop === 'position' && !SAFE_POSITIONS.has(value.toLowerCase())) { return null; }
  return value;
}

function resolveImage(props: Record<string, JsonValue> | undefined, ctx: RenderCtx): string | null {
  const src = stringProp(props, 'src');
  if (src === null) { return null; }
  if (!ASSET_REF.test(src) || src.includes('..')) { ctx.stats.dropped++; return null; }
  const resolved = ctx.opts.resolveAsset?.(src) ?? null;
  if (typeof resolved !== 'string' || resolved.length === 0 || resolved.length > 2048) {
    ctx.stats.dropped++;
    return null;
  }
  if (!SAFE_IMG_SCHEME.test(resolved)) { ctx.stats.dropped++; return null; }
  return resolved;
}

function clampText(text: string, max: number): string {
  const clean = text.replace(CONTROL_CHARS, '');
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/* -------------------------------- mount -------------------------------- */

/**
 * Materialize a {@link PreviewNode} tree into `host`, replacing its children.
 *
 * Every content write is `textContent`; every style write is `setProperty`;
 * every attribute is checked against {@link PREVIEW_ATTRS} at the last possible
 * moment, so even a future caller that hand-builds a `PreviewNode` cannot
 * smuggle `onclick` through.
 */
export function mountPreview(host: DomElement, node: PreviewNode, doc: DomDocument): void {
  host.replaceChildren();
  host.appendChild(materialize(node, doc));
}

function materialize(node: PreviewNode, doc: DomDocument): DomElement {
  const tag = SAFE_TAGS.has(node.tag) ? node.tag : 'div';
  const el = doc.createElement(tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!PREVIEW_ATTRS.has(name)) { continue; }
    el.setAttribute(name, value);
  }
  for (const [prop, value] of Object.entries(node.style)) {
    el.style.setProperty(prop, value);
  }
  if (node.text !== undefined) {
    el.textContent = node.text;
    return el;
  }
  for (const child of node.children) {
    el.appendChild(materialize(child, doc));
  }
  return el;
}

/** Convenience: render + mount in one call. */
export function drawPreview(
  host: DomElement,
  doc: DocNode,
  domDoc: DomDocument,
  opts: PreviewOptions = {},
): PreviewStats {
  const { root, stats } = renderPreview(doc, opts);
  mountPreview(host, root, domDoc);
  return stats;
}
