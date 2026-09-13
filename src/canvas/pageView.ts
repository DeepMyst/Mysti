/** Mysti — SPDX-License-Identifier: Apache-2.0
 * Read a page for display without loading the migration/compiler pipeline.
 */
import { emit } from './doc/DocEmitter';
import type { DocNode } from './doc/DocNode';
import type { ArtifactPage } from '../types';

/** The mid-annotated JSX for a page — what `read_page` returns. */
export function renderJsxCache(doc: DocNode): string {
  try {
    return emit(doc, { mids: true, pins: true });
  } catch (err) {
    console.log('[Mysti] pageMigration: emit failed (non-fatal):', err);
    return '';
  }
}

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
