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
 */

import type { ArtifactPage } from '../types';

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
export type ImportedPageSpec = Pick<ArtifactPage, 'mode' | 'htmlSource' | 'actionTitle' | 'source'>;

/** Convert a Figma color (0..1 channels) to an rgba() CSS string. */
export function figmaColorToCss(c: FigmaColor, opacity?: number): string {
  const to255 = (n: number) => Math.max(0, Math.min(255, Math.round((n ?? 0) * 255)));
  const a = (c.a ?? 1) * (opacity ?? 1);
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${round(a, 3)})`;
}

/** First visible solid fill as a CSS color, or null. */
export function fillToCss(fills?: FigmaPaint[]): string | null {
  if (!Array.isArray(fills)) { return null; }
  for (const f of fills) {
    if (f && f.visible !== false && f.type === 'SOLID' && f.color) {
      return figmaColorToCss(f.color, f.opacity);
    }
  }
  return null;
}

/** Find a usable frame node inside the common Figma response wrapper shapes. */
export function findFigmaFrame(payload: unknown): FigmaNode | null {
  if (!payload || typeof payload !== 'object') { return null; }
  const p = payload as Record<string, unknown>;
  // Direct node.
  if (typeof p.type === 'string' && p.absoluteBoundingBox) { return p as FigmaNode; }
  // { document: node }
  if (p.document) { return findFigmaFrame(p.document); }
  // { nodes: { "<id>": { document: node } } }  (REST /v1/files/:key/nodes)
  if (p.nodes && typeof p.nodes === 'object') {
    const entries = Array.isArray(p.nodes) ? p.nodes : Object.values(p.nodes as Record<string, unknown>);
    for (const entry of entries) {
      const found = findFigmaFrame(entry);
      if (found) { return found; }
    }
  }
  // { node: ... } / first child with a box
  if (p.node) { return findFigmaFrame(p.node); }
  return null;
}

/** Convert a Figma frame node into an html page spec. */
export function figmaFrameToPageSpec(frame: FigmaNode): ImportedPageSpec {
  const box = frame.absoluteBoundingBox ?? { x: 0, y: 0, width: 1440, height: 900 };
  const els: string[] = [];

  walk(frame, (node) => {
    if (node === frame || node.visible === false) { return; }
    const nb = node.absoluteBoundingBox;
    if (!nb) { return; }
    const base =
      `position:absolute;left:${Math.round(nb.x - box.x)}px;top:${Math.round(nb.y - box.y)}px;` +
      `width:${Math.round(nb.width)}px;height:${Math.round(nb.height)}px;`;

    if (node.type === 'TEXT' && node.characters) {
      els.push(`<div style="${base}${textStyle(node)}">${escapeHtml(node.characters)}</div>`);
      return;
    }
    const bg = fillToCss(node.fills);
    if (bg) {
      const radius = node.cornerRadius ? `border-radius:${node.cornerRadius}px;` : '';
      els.push(`<div style="${base}background:${bg};${radius}"></div>`);
    }
  });

  const frameBg = fillToCss(frame.fills) ?? '#ffffff';
  const html =
    `<div style="position:relative;width:${Math.round(box.width)}px;height:${Math.round(box.height)}px;` +
    `background:${frameBg};overflow:hidden">${els.join('')}</div>`;

  return { mode: 'html', htmlSource: html, actionTitle: frame.name || 'Imported frame', source: 'figma' };
}

/** Find + convert a Figma payload to a page spec, or null if no frame found. */
export function importFigmaPayload(payload: unknown): ImportedPageSpec | null {
  const frame = findFigmaFrame(payload);
  return frame ? figmaFrameToPageSpec(frame) : null;
}

// ── helpers ──

function walk(node: FigmaNode, visit: (n: FigmaNode) => void): void {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) { walk(child, visit); }
  }
}

function textStyle(node: FigmaNode): string {
  const s = node.style ?? {};
  const color = fillToCss(node.fills) ?? '#111111';
  const align = (s.textAlignHorizontal || 'LEFT').toLowerCase();
  const parts = [
    `font-size:${Math.round(s.fontSize ?? 16)}px`,
    `font-weight:${s.fontWeight ?? 400}`,
    `font-family:${cssFont(s.fontFamily)}`,
    `color:${color}`,
    `text-align:${align === 'justified' ? 'justify' : align}`,
    s.lineHeightPx ? `line-height:${Math.round(s.lineHeightPx)}px` : '',
    'overflow:hidden',
  ].filter(Boolean);
  return parts.join(';') + ';';
}

function cssFont(family?: string): string {
  if (!family) { return 'system-ui, sans-serif'; }
  return /\s/.test(family) ? `"${family}", system-ui, sans-serif` : `${family}, system-ui, sans-serif`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
