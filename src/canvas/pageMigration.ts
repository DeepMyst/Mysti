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
 * Plan 22 §3.1 — upgrading persisted artifacts to the document model.
 *
 * Every design saved before Phase 2 stores a page as one opaque blob:
 * `{ mode: 'jsx', jsxSource }` or `{ mode: 'html', htmlSource }`. This module
 * is the one place that turns those into `{ doc, jsxCache, legacy? }`, and the
 * one place a transport that still needs a *source view* of a page gets one.
 *
 * Three rules, all tested:
 *
 * 1. **It never loses a page.** A page that cannot be compiled is not dropped
 *    and not emptied — its source is preserved verbatim under `legacy` with
 *    `compileError` naming the reason, so it still renders and can still be
 *    read back byte-for-byte. Even a page whose object is structurally junk
 *    yields a real page with a fresh id rather than a hole in the rail.
 * 2. **It is idempotent.** Migrating an already-migrated artifact is a no-op:
 *    the recompile is skipped when `doc` is already a well-formed tree, so mids
 *    (and therefore pins, comments and selection) survive every reload.
 * 3. **It never throws.** Load-time migration runs before the user can see the
 *    design; an exception here would turn "one bad page" into "no design".
 */

import { compile } from './doc/PageCompiler';
import { emit } from './doc/DocEmitter';
import { mintMid, type DocNode, type JsonValue } from './doc/DocNode';
import type { ArtifactPage, CanvasArtifact, DesignNode, LegacyPageSource } from '../types';

/* ─────────────────────────────── board layout ─────────────────────────────── */

/** Horizontal pitch between artboards on the board, in design px. */
export const BOARD_COLUMN_PITCH = 1600;
/** Vertical pitch between artboard rows, in design px. */
export const BOARD_ROW_PITCH = 1200;
/** Artboards per board row before wrapping. */
export const BOARD_COLUMNS = 4;

/** Default board position for the page at `index`, laid out left-to-right. */
export function boardPosForIndex(index: number): { x: number; y: number } {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return {
    x: (i % BOARD_COLUMNS) * BOARD_COLUMN_PITCH,
    y: Math.floor(i / BOARD_COLUMNS) * BOARD_ROW_PITCH,
  };
}

/* ──────────────────────────────── doc helpers ──────────────────────────────── */

/** The placeholder document a `legacy` page carries so `doc` is never absent. */
export function emptyDoc(rand?: () => number): DocNode {
  return { mid: mintMid(rand), tag: 'UI.Screen' };
}

/**
 * Structural guard for a `DocNode` that arrived from disk.
 *
 * Deliberately shallow-but-recursive on shape only: a persisted doc is data we
 * wrote, so this is a corruption check, not a validator. Anything that fails
 * is re-derived from the page's source rather than half-trusted.
 */
export function isDocNode(value: unknown, depth = 0): value is DocNode {
  if (depth > 512) { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const n = value as Partial<DocNode>;
  if (typeof n.mid !== 'string' || n.mid.length === 0) { return false; }
  if (typeof n.tag !== 'string' || n.tag.length === 0) { return false; }
  if (n.text !== undefined && typeof n.text !== 'string') { return false; }
  if (n.children !== undefined) {
    if (!Array.isArray(n.children)) { return false; }
    for (const c of n.children) { if (!isDocNode(c, depth + 1)) { return false; } }
  }
  if (n.slots !== undefined) {
    if (!n.slots || typeof n.slots !== 'object' || Array.isArray(n.slots)) { return false; }
    for (const list of Object.values(n.slots)) {
      if (!Array.isArray(list)) { return false; }
      for (const c of list) { if (!isDocNode(c, depth + 1)) { return false; } }
    }
  }
  return true;
}

/** Compile page JSX into a document, never throwing. */
export function docFromJsx(
  source: string,
  opts: { rand?: () => number } = {},
): { doc: DocNode; error?: string } {
  try {
    const res = compile(source, { rand: opts.rand });
    if (res.ok) { return { doc: res.doc }; }
    return { doc: emptyDoc(opts.rand), error: res.error };
  } catch (err) {
    return { doc: emptyDoc(opts.rand), error: err instanceof Error ? err.message : String(err) };
  }
}

/** The mid-annotated JSX for a page — what `read_page` returns. */
export function renderJsxCache(doc: DocNode): string {
  try {
    return emit(doc, { mids: true, pins: true });
  } catch (err) {
    console.log('[Mysti] pageMigration: emit failed (non-fatal):', err);
    return '';
  }
}

/** Recompute `jsxCache` from `doc`. Mutates and returns the page. */
export function refreshJsxCache(page: ArtifactPage): ArtifactPage {
  page.jsxCache = renderJsxCache(page.doc);
  return page;
}

/* ────────────────────────── structured-mode transcoding ────────────────────────── */

/** Depth guard for the (defensive) structured-node transcoder. */
const STRUCTURED_MAX_DEPTH = 64;

/**
 * Transcode a pre-doc-model `nodes: DesignNode[]` page into a document.
 *
 * Structured mode was never produced by a shipped code path, but a hand-edited
 * or very old `artifact.json` may still carry one, and "never lose a page"
 * means transcoding it rather than blanking it. Numerics are `Number()`-coerced
 * and clamped and text is carried verbatim — no string is ever concatenated
 * into a `style` attribute (§3.6, "importers are transcoders").
 */
export function docFromDesignNodes(nodes: DesignNode[], rand?: () => number): DocNode {
  const root = emptyDoc(rand);
  const kids = nodes.map(n => designNodeToDoc(n, rand, 0)).filter((n): n is DocNode => !!n);
  if (kids.length > 0) { root.children = kids; }
  return root;
}

function designNodeToDoc(node: DesignNode, rand: (() => number) | undefined, depth: number): DocNode | null {
  if (depth > STRUCTURED_MAX_DEPTH || !node || typeof node !== 'object') { return null; }
  const out: DocNode = { mid: mintMid(rand), tag: 'div' };
  const style: Record<string, string> = {};
  const px = (v: unknown): string | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) { return null; }
    return `${Math.max(-100000, Math.min(100000, Math.round(n)))}px`;
  };
  const w = px(node.width); if (w) { style.width = w; }
  const h = px(node.height); if (h) { style.height = h; }
  const bg = node.style?.background;
  if (typeof bg === 'string' && /^[\w#(),.\s%-]{1,64}$/.test(bg)) { style.background = bg; }
  if (Object.keys(style).length > 0) { out.style = style; }
  if (typeof node.name === 'string' && node.name) {
    out.props = { 'data-name': node.name as JsonValue };
  }
  const children = Array.isArray(node.children)
    ? node.children.map(c => designNodeToDoc(c, rand, depth + 1)).filter((n): n is DocNode => !!n)
    : [];
  if (children.length > 0) { out.children = children; }
  else if (typeof node.text === 'string' && node.text.length > 0) { out.text = node.text; }
  return out;
}

/* ──────────────────────────────── migration ──────────────────────────────── */

/** The pre-Phase-2 page fields a persisted (or hand-written) page may carry. */
export interface LegacyPageFields {
  mode?: 'html' | 'jsx' | 'structured';
  htmlSource?: string;
  jsxSource?: string;
  nodes?: DesignNode[];
  /** Deleted concepts, accepted on input so old payloads still load. */
  elementOverrides?: unknown;
  droppedAssets?: unknown;
  previewAsset?: unknown;
  stitchRef?: unknown;
}

export interface MigratePageOptions {
  /** Index on the board, used only when the page has no `boardPos`. */
  index?: number;
  /** Injectable RNG so tests can mint deterministic mids. */
  rand?: () => number;
  /** Id source for a page whose own id is missing/unsafe. */
  newId?: () => string;
}

/** What {@link migrateArtifactPages} did, for a `[Mysti]` log line and tests. */
export interface MigrationReport {
  /** Pages that were already document-first — untouched. */
  alreadyDocFirst: number;
  /** Pages compiled from JSX into a real document. */
  compiled: number;
  /** Pages parked as {@link LegacyPageSource} (html, or JSX outside the subset). */
  legacy: number;
  /** Pages whose stored object was unusable and had to be rebuilt. */
  repaired: number;
  /** Compile errors, `pageId → message`. */
  errors: Record<string, string>;
}

function emptyReport(): MigrationReport {
  return { alreadyDocFirst: 0, compiled: 0, legacy: 0, repaired: 0, errors: {} };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function readBoardPos(v: unknown): { x: number; y: number } | null {
  if (!v || typeof v !== 'object') { return null; }
  const p = v as { x?: unknown; y?: unknown };
  if (!Number.isFinite(p.x as number) || !Number.isFinite(p.y as number)) { return null; }
  return { x: p.x as number, y: p.y as number };
}

function readLegacy(v: unknown): LegacyPageSource | undefined {
  if (!v || typeof v !== 'object') { return undefined; }
  const l = v as { mode?: unknown; source?: unknown };
  if ((l.mode !== 'jsx' && l.mode !== 'html') || typeof l.source !== 'string') { return undefined; }
  return { mode: l.mode, source: l.source };
}

/**
 * Upgrade one persisted page object to the document-first shape.
 *
 * Accepts anything: a current page (returned as-is, only filling in derived
 * fields), a pre-Phase-2 page, or a corrupt object. Never throws, never
 * returns null — the caller always gets a page it can render.
 */
export function migratePage(raw: unknown, opts: MigratePageOptions = {}): { page: ArtifactPage; outcome: keyof Omit<MigrationReport, 'errors'> } {
  const mintId = opts.newId ?? (() => `page-${mintMid(opts.rand)}`);
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const legacyIn = src as LegacyPageFields;

  const id = str(src.id) || mintId();
  const version = Number.isFinite(src.version as number) && (src.version as number) >= 1
    ? Math.floor(src.version as number)
    : 1;
  const boardPos = readBoardPos(src.boardPos) ?? boardPosForIndex(opts.index ?? 0);

  const page: ArtifactPage = { id, version, doc: emptyDoc(opts.rand), boardPos };
  const actionTitle = str(src.actionTitle); if (actionTitle !== undefined) { page.actionTitle = actionTitle; }
  const notes = str(src.notes); if (notes !== undefined) { page.notes = notes; }
  const source = str(src.source); if (source !== undefined) { page.source = source; }
  if (src.format && typeof src.format === 'object') { page.format = src.format as ArtifactPage['format']; }
  const variantGroupId = str(src.variantGroupId); if (variantGroupId !== undefined) { page.variantGroupId = variantGroupId; }

  // ── already document-first ────────────────────────────────────────────
  if (isDocNode(src.doc)) {
    page.doc = src.doc as DocNode;
    const carried = readLegacy(src.legacy);
    if (carried) { page.legacy = carried; }
    const err = str(src.compileError); if (err) { page.compileError = err; }
    const cache = str(src.jsxCache);
    page.jsxCache = cache !== undefined ? cache : renderJsxCache(page.doc);
    const outcome = raw && typeof raw === 'object' && str((raw as Record<string, unknown>).id)
      ? 'alreadyDocFirst' as const
      : 'repaired' as const;
    return { page, outcome };
  }

  const jsx = str(legacyIn.jsxSource);
  const html = str(legacyIn.htmlSource);
  const mode = legacyIn.mode;

  // ── jsx: the compilable path ──────────────────────────────────────────
  if (jsx !== undefined && jsx.trim().length > 0 && mode !== 'html') {
    const { doc, error } = docFromJsx(jsx, { rand: opts.rand });
    page.doc = doc;
    if (error) {
      // Not compilable → keep the source verbatim and say why. The page still
      // renders (Babel is injected into that frame) and is badged in the rail.
      page.legacy = { mode: 'jsx', source: jsx };
      page.compileError = error;
      page.jsxCache = jsx;
      return { page, outcome: 'legacy' };
    }
    page.jsxCache = renderJsxCache(page.doc);
    return { page, outcome: 'compiled' };
  }

  // ── html: outside the JSX subset by construction ──────────────────────
  // An EMPTY html source is not content — it falls through so a structured
  // page carrying `nodes` is transcoded rather than parked as a blank page.
  if (html !== undefined && html.trim().length > 0 && mode !== 'jsx') {
    page.legacy = { mode: 'html', source: html };
    page.jsxCache = '';
    return { page, outcome: 'legacy' };
  }

  // ── structured: transcode the node tree ───────────────────────────────
  if (Array.isArray(legacyIn.nodes) && legacyIn.nodes.length > 0) {
    page.doc = docFromDesignNodes(legacyIn.nodes as DesignNode[], opts.rand);
    page.jsxCache = renderJsxCache(page.doc);
    return { page, outcome: 'compiled' };
  }

  // ── nothing usable: an empty artboard, not a hole in the rail ─────────
  if (jsx !== undefined) { page.legacy = { mode: 'jsx', source: jsx }; }
  else if (html !== undefined) { page.legacy = { mode: 'html', source: html }; }
  page.jsxCache = page.legacy ? page.legacy.source : renderJsxCache(page.doc);
  return { page, outcome: str(src.id) && (src.doc === undefined) ? 'legacy' : 'repaired' };
}

/**
 * Upgrade every page of a loaded artifact in place.
 *
 * Idempotent and total: calling it twice changes nothing, and a page array
 * containing junk still comes back the same length.
 */
export function migrateArtifactPages(artifact: CanvasArtifact, opts: { rand?: () => number } = {}): MigrationReport {
  const report = emptyReport();
  if (!artifact || !Array.isArray(artifact.pages)) {
    if (artifact) { artifact.pages = []; }
    return report;
  }
  const migrated: ArtifactPage[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < artifact.pages.length; i++) {
    const { page, outcome } = migratePage(artifact.pages[i], { index: i, rand: opts.rand });
    // A duplicate id would make two artboards address the same page; re-id the
    // later one rather than dropping it.
    if (seen.has(page.id)) { page.id = `page-${mintMid(opts.rand)}`; }
    seen.add(page.id);
    report[outcome] += 1;
    if (page.compileError) { report.errors[page.id] = page.compileError; }
    migrated.push(page);
  }
  artifact.pages = migrated;
  if (report.compiled || report.legacy || report.repaired) {
    console.log(
      `[Mysti] pageMigration: ${artifact.id} — ${report.compiled} compiled, `
      + `${report.legacy} legacy, ${report.repaired} repaired, ${report.alreadyDocFirst} unchanged`,
    );
  }
  return report;
}

/* ───────────────────────── compatibility accessors ───────────────────────── */

/**
 * How a page must be rendered today.
 *
 * `'html'` only for a legacy html page; everything else — including a legacy
 * JSX page the compiler rejected — is JSX.
 */
export function pageMode(page: ArtifactPage): 'jsx' | 'html' {
  return page.legacy?.mode === 'html' ? 'html' : 'jsx';
}

/** True when the page renders from {@link ArtifactPage.legacy}, not from `doc`. */
export function isLegacyPage(page: ArtifactPage): boolean {
  return !!page.legacy;
}

/** The JSX source for a page, or `''` for a legacy html page. */
export function pageJsx(page: ArtifactPage): string {
  if (page.legacy) { return page.legacy.mode === 'jsx' ? page.legacy.source : ''; }
  if (typeof page.jsxCache === 'string' && page.jsxCache.length > 0) { return page.jsxCache; }
  return renderJsxCache(page.doc);
}

/** The HTML source for a legacy html page, else `undefined`. */
export function pageHtml(page: ArtifactPage): string | undefined {
  return page.legacy?.mode === 'html' ? page.legacy.source : undefined;
}

/** Whatever source a validator/exporter should read — jsx or html. */
export function pageSource(page: ArtifactPage): string {
  return pageHtml(page) ?? pageJsx(page);
}

/**
 * The page shape the webview boot payload and the sandbox builder still speak.
 *
 * This is the "small compatibility accessor" Plan 22 sanctions: `mode` /
 * `jsxSource` / `htmlSource` remain *readable* while ceasing to be *stored*,
 * so the renderer rewrite is a separate, independently-landable change.
 */
export interface PageWireView {
  id: string;
  version: number;
  mode: 'jsx' | 'html';
  jsxSource?: string;
  htmlSource?: string;
  actionTitle?: string;
  boardPos: { x: number; y: number };
  legacy: boolean;
  compileError?: string;
}

export function pageWire(page: ArtifactPage): PageWireView {
  const mode = pageMode(page);
  const view: PageWireView = {
    id: page.id,
    version: page.version,
    mode,
    boardPos: page.boardPos,
    legacy: !!page.legacy,
  };
  if (mode === 'jsx') { view.jsxSource = pageJsx(page); }
  else { view.htmlSource = pageHtml(page) ?? ''; }
  if (page.actionTitle !== undefined) { view.actionTitle = page.actionTitle; }
  if (page.compileError !== undefined) { view.compileError = page.compileError; }
  return view;
}
