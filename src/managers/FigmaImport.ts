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

/**
 * Converts a Figma frame (the well-known Figma REST / Dev-Mode-MCP node shape)
 * into an `html`-mode {@link ArtifactPage} the canvas can render (Plan 05 §9 /
 * Phase 6 — `import_design`). The agent fetches a frame via the connected Figma
 * MCP, then hands the node JSON to `import_design`; this flattens it into
 * absolutely-positioned elements (text, fills) relative to the frame origin —
 * preserving layout, copy, and colors so a real Figma screen lands as a page
 * the designer can refine. Pure + tolerant of the common wrapper shapes.
 *
 * **Plan 20 §3.6 — "importers are transcoders, not formatters".** The payload is
 * third-party data that reached us through a model, so the declared `FigmaNode`
 * types are a *hope*, not a guarantee: every field may be a hostile string. This
 * module therefore never concatenates a payload value into markup. Each value is
 * re-derived through a typed transcoder — numerics via `Number()` + a range
 * clamp, colors via a hex/rgb validator, font families via `/^[\w \-]+$/` — and
 * anything that does not survive is dropped in favour of a safe default. Style
 * declarations are assembled as a `Record<string, string>` of transcoded values,
 * checked once more against a conservative CSS charset, and only then serialized
 * and attribute-escaped. Traversal is bounded in depth and node count so a
 * pathological payload cannot exhaust the stack or the heap.
 */

import type {  } from '../types';

interface FigmaColor { r: number; g: number; b: number; a?: number }
interface FigmaPaint { type?: string; color?: FigmaColor; opacity?: number; visible?: boolean }
interface FigmaBox { x: number; y: number; width: number; height: number }
interface FigmaTextStyle {
  fontSize?: number; fontWeight?: number; fontFamily?: string;
  textAlignHorizontal?: string; lineHeightPx?: number; letterSpacing?: number;
}
export interface FigmaNode {
  id?: string; name?: string; type?: string;
  absoluteBoundingBox?: FigmaBox;
  fills?: FigmaPaint[];
  cornerRadius?: number;
  characters?: string;
  style?: FigmaTextStyle;
  children?: FigmaNode[];
  visible?: boolean;
}

/** A page spec ready for insert_page (mode + html + title + provenance). */
export interface ImportedPageSpec {
  /**
   * Always `'html'`: a Figma frame is transcoded to markup, which is outside
   * the compilable JSX subset, so the page lands as `legacy` content.
   * `ArtifactStore.makePage` normalizes this wire shape — it is deliberately
   * NOT `Pick<ArtifactPage, …>` any more, because `ArtifactPage` no longer
   * STORES a mode or a source (Plan 22 §3.1).
   */
  mode: 'html';
  htmlSource: string;
  actionTitle?: string;
  source?: string;
}

// ── transcoder limits ────────────────────────────────────────────────────
/** Design coordinates: generous, but finite. */
const MAX_COORD = 100_000;
/** Box dimensions. */
const MAX_SIZE = 100_000;
/** Nodes visited per import (a hostile payload can nest/fan out forever). */
const MAX_NODES = 5_000;
/** Traversal depth (guards the recursion against a stack overflow). */
const MAX_DEPTH = 64;
/** Wrapper-unwrapping depth in {@link findFigmaFrame}. */
const MAX_WRAPPER_DEPTH = 32;
/** Text content per node. */
const MAX_TEXT = 5_000;
/** Frame name → page title. */
const MAX_TITLE = 200;

/** Font families are re-derived, never quoted-and-hoped: word chars, space, hyphen. */
const FONT_FAMILY_RE = /^[\w -]+$/;
/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** `rgb(1, 2, 3)` / `rgba(1, 2, 3, 0.5)` — digits, dots and separators only. */
const RGB_COLOR_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,4})\s*)?\)$/;
/**
 * Belt-and-braces gate on the assembled declaration text. Every value here was
 * produced by a transcoder, so this can only ever fire on a bug — and when it
 * does, the element is dropped instead of emitted.
 */
const SAFE_DECL_RE = /^[A-Za-z0-9 \t\-_.,:;#%()"'/]*$/;
/** Control characters, stripped out of any text that reaches the page. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

const TEXT_ALIGN: Record<string, string> = {
  left: 'left', center: 'center', right: 'right', justified: 'justify', justify: 'justify',
};

/** Convert a Figma color (0..1 channels) to an rgba() CSS string. */
export function figmaColorToCss(c: FigmaColor, opacity?: number): string {
  const to255 = (v: unknown) => clamp(Math.round((finite(v) ?? 0) * 255), 0, 255);
  const a = clamp((finite(c?.a) ?? 1) * (finite(opacity) ?? 1), 0, 1);
  return `rgba(${to255(c?.r)}, ${to255(c?.g)}, ${to255(c?.b)}, ${round(a, 3)})`;
}

/** First visible solid fill as a validated CSS color, or null. */
export function fillToCss(fills?: FigmaPaint[]): string | null {
  if (!Array.isArray(fills)) { return null; }
  for (const f of fills) {
    if (f && typeof f === 'object' && f.visible !== false && f.type === 'SOLID' && f.color && typeof f.color === 'object') {
      return cssColor(figmaColorToCss(f.color, f.opacity));
    }
  }
  return null;
}

/** Find a usable frame node inside the common Figma response wrapper shapes. */
export function findFigmaFrame(payload: unknown, depth = 0): FigmaNode | null {
  if (!payload || typeof payload !== 'object' || depth > MAX_WRAPPER_DEPTH) { return null; }
  const p = payload as Record<string, unknown>;
  // Direct node.
  if (typeof p.type === 'string' && p.absoluteBoundingBox) { return p as FigmaNode; }
  // { document: node }
  if (p.document) { return findFigmaFrame(p.document, depth + 1); }
  // { nodes: { "<id>": { document: node } } }  (REST /v1/files/:key/nodes)
  if (p.nodes && typeof p.nodes === 'object') {
    const entries = Array.isArray(p.nodes) ? p.nodes : Object.values(p.nodes as Record<string, unknown>);
    for (const entry of entries) {
      const found = findFigmaFrame(entry, depth + 1);
      if (found) { return found; }
    }
  }
  // { node: ... } / first child with a box
  if (p.node) { return findFigmaFrame(p.node, depth + 1); }
  return null;
}

/** Convert a Figma frame node into an html page spec. */
export function figmaFrameToPageSpec(frame: FigmaNode): ImportedPageSpec {
  const box = frameBox(frame.absoluteBoundingBox);
  const els: string[] = [];

  walk(frame, (node) => {
    if (node === frame || node.visible === false) { return; }
    const nb = node.absoluteBoundingBox;
    if (!nb || typeof nb !== 'object') { return; }
    const x = finite(nb.x), y = finite(nb.y), w = finite(nb.width), h = finite(nb.height);
    if (x === null || y === null || w === null || h === null) { return; }

    const base: Record<string, string> = {
      position: 'absolute',
      left: px(x - box.x, -MAX_COORD, MAX_COORD),
      top: px(y - box.y, -MAX_COORD, MAX_COORD),
      width: px(w, 0, MAX_SIZE),
      height: px(h, 0, MAX_SIZE),
    };

    if (node.type === 'TEXT' && typeof node.characters === 'string' && node.characters) {
      const decls = styleAttr({ ...base, ...textStyle(node) });
      if (decls === null) { return; }
      els.push(`<div style="${decls}">${escapeHtml(node.characters.slice(0, MAX_TEXT))}</div>`);
      return;
    }
    const bg = fillToCss(node.fills);
    if (bg) {
      const radius = finite(node.cornerRadius);
      const decls = styleAttr({
        ...base,
        background: bg,
        ...(radius !== null && radius > 0 ? { 'border-radius': px(radius, 0, MAX_SIZE) } : {}),
      });
      if (decls === null) { return; }
      els.push(`<div style="${decls}"></div>`);
    }
  });

  const frameDecls = styleAttr({
    position: 'relative',
    width: px(box.width, 0, MAX_SIZE),
    height: px(box.height, 0, MAX_SIZE),
    background: fillToCss(frame.fills) ?? '#ffffff',
    overflow: 'hidden',
  }) ?? 'position:relative;overflow:hidden;';

  const html = `<div style="${frameDecls}">${els.join('')}</div>`;

  return { mode: 'html', htmlSource: html, actionTitle: pageTitle(frame.name), source: 'figma' };
}

/** Find + convert a Figma payload to a page spec, or null if no frame found. */
export function importFigmaPayload(payload: unknown): ImportedPageSpec | null {
  const frame = findFigmaFrame(payload);
  return frame ? figmaFrameToPageSpec(frame) : null;
}

// ── transcoders ──────────────────────────────────────────────────────────

/**
 * A finite number, or null. Only numbers and numeric strings are coerced —
 * `Number(null)`/`Number([])`/`Number(true)` all produce a number for values
 * that are plainly not numeric, and silently accepting those is how garbage
 * ends up in a style attribute.
 */
function finite(v: unknown): number | null {
  if (typeof v === 'number') { return Number.isFinite(v) ? v : null; }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) { return lo; }
  return Math.min(hi, Math.max(lo, n));
}

/** A clamped, rounded `<n>px` length. */
function px(n: number, lo: number, hi: number): string {
  return `${Math.round(clamp(n, lo, hi))}px`;
}

/** Validate a CSS color string (hex or rgb/rgba). Anything else is dropped. */
export function cssColor(value: unknown): string | null {
  if (typeof value !== 'string') { return null; }
  const v = value.trim();
  if (v.length > 64) { return null; }
  if (HEX_COLOR_RE.test(v) || RGB_COLOR_RE.test(v)) { return v; }
  return null;
}

/**
 * A CSS `font-family` value derived from an untrusted family name. The name is
 * matched against {@link FONT_FAMILY_RE} — which admits no quote, backslash,
 * semicolon or parenthesis — so the quoted form below cannot break out of the
 * declaration. An unrecognized family falls back to the system stack.
 */
export function cssFontFamily(family: unknown): string {
  const fallback = 'system-ui, sans-serif';
  if (typeof family !== 'string') { return fallback; }
  const name = family.trim();
  if (!name || name.length > 64 || !FONT_FAMILY_RE.test(name)) { return fallback; }
  return `"${name}", ${fallback}`;
}

function frameBox(box: FigmaBox | undefined): { x: number; y: number; width: number; height: number } {
  const x = finite(box?.x) ?? 0;
  const y = finite(box?.y) ?? 0;
  const width = finite(box?.width);
  const height = finite(box?.height);
  return {
    x: clamp(x, -MAX_COORD, MAX_COORD),
    y: clamp(y, -MAX_COORD, MAX_COORD),
    width: width === null ? 1440 : clamp(width, 0, MAX_SIZE),
    height: height === null ? 900 : clamp(height, 0, MAX_SIZE),
  };
}

function textStyle(node: FigmaNode): Record<string, string> {
  const s = (node.style && typeof node.style === 'object' ? node.style : {}) as FigmaTextStyle;
  const alignKey = typeof s.textAlignHorizontal === 'string' ? s.textAlignHorizontal.trim().toLowerCase() : '';
  const lineHeight = finite(s.lineHeightPx);
  const decls: Record<string, string> = {
    'font-size': px(finite(s.fontSize) ?? 16, 1, 1000),
    'font-weight': String(Math.round(clamp(finite(s.fontWeight) ?? 400, 1, 1000))),
    'font-family': cssFontFamily(s.fontFamily),
    color: fillToCss(node.fills) ?? '#111111',
    'text-align': TEXT_ALIGN[alignKey] ?? 'left',
  };
  if (lineHeight !== null && lineHeight > 0) { decls['line-height'] = px(lineHeight, 0, MAX_SIZE); }
  decls.overflow = 'hidden';
  return decls;
}

/**
 * Serialize transcoded declarations into an attribute-safe `style` value, or
 * null when anything unexpected survived (→ the caller drops the element).
 */
function styleAttr(decls: Record<string, string>): string | null {
  const parts: string[] = [];
  for (const [prop, value] of Object.entries(decls)) {
    if (!/^[a-z-]+$/.test(prop) || typeof value !== 'string' || !value) { return null; }
    parts.push(`${prop}:${value}`);
  }
  const css = parts.join(';') + ';';
  if (!SAFE_DECL_RE.test(css)) { return null; }
  return escapeAttr(css);
}

function pageTitle(name: unknown): string {
  if (typeof name !== 'string') { return 'Imported frame'; }
  const clean = name.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return clean || 'Imported frame';
}

// ── helpers ──

/** Depth- and count-bounded traversal (a hostile payload is not a tree we trust). */
function walk(node: FigmaNode, visit: (n: FigmaNode) => void): void {
  let budget = MAX_NODES;
  const step = (n: FigmaNode, depth: number): void => {
    if (budget <= 0 || depth > MAX_DEPTH || !n || typeof n !== 'object') { return; }
    budget--;
    visit(n);
    if (Array.isArray(n.children)) {
      for (const child of n.children) {
        if (budget <= 0) { return; }
        step(child, depth + 1);
      }
    }
  };
  step(node, 0);
}

function escapeHtml(s: string): string {
  return s.replace(CONTROL_RE, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
