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
 * Plan 22 Phase 6 / parity row 7 — **Present**.
 *
 * `#btn-present` has posted `canvas/present` into the void since Plan 05; the
 * protocol declares the message and no handler existed. This module is the
 * other half, and it is deliberately thin: Present is *the exported viewer,
 * full-bleed*, so it shares one builder with the export bundle
 * ({@link buildViewerDocument}) and one page builder with the board
 * (`buildPageDocument`). The only things that are genuinely Present's own are
 * the deck order, the paging arithmetic and the fit-to-screen scale — all pure,
 * all tested here.
 *
 * Two differences from the bundle, both forced by where it runs:
 *
 * 1. **No files.** A webview panel has no `pages/page-0.html` to point at, so
 *    each artboard travels as a `srcdoc` document inside the deck manifest.
 * 2. **CSP inheritance.** An `about:srcdoc` frame inherits the embedder's
 *    policy *on top of* its own, so a legacy (Babel-compiled) artboard renders
 *    blank unless the Present document itself allows `'unsafe-eval'`.
 *    {@link presentNeedsEval} decides that from the deck, not from a guess.
 *
 * What Present does NOT do: talk to the host. The document is self-contained
 * and posts nothing, so the same bytes work from `file:` and from a webview,
 * and a model-authored artboard has no channel to reach for.
 */

import {
  buildExportPageDocument,
  buildViewerDocument,
  exportPageFormat,
  type HtmlBundleOptions,
  type ViewerFrame,
} from '../services/CanvasExportService';
import { pageRenderMode } from '../managers/CanvasSandbox';
import type { ArtifactPage, CanvasArtifact, CanvasFormatSpec } from '../types';

/** Never shrink an artboard past this, however small the window. */
export const PRESENT_MIN_SCALE = 0.05;
/** Never blow one up past this, however large. */
export const PRESENT_MAX_SCALE = 2;
/** Breathing room around the artboard, in CSS px. */
export const PRESENT_PADDING_PX = 48;

/**
 * The fit-scale formula, as JavaScript source.
 *
 * The Present document has to compute this in the browser on every resize, and
 * {@link presentFitScale} has to compute it host-side for layout decisions and
 * tests. Rather than write it twice and let the two drift — the exact failure
 * mode §2.9 names — the *expression* is exported once, injected into the
 * document by {@link buildViewerDocument}, and asserted equivalent to the TS
 * implementation by a test that evaluates this string.
 *
 * Free variables: `w`, `h` (artboard, design px), `vw`, `vh` (available
 * viewport, CSS px), `min`, `max`.
 */
export const PRESENT_FIT_SCALE_JS = 'Math.max(min, Math.min(max, Math.min(vw / w, vh / h)))';

export interface PresentViewport {
  width: number;
  height: number;
}

export interface PresentFitOptions {
  padding?: number;
  min?: number;
  max?: number;
}

/**
 * Scale that fits an artboard inside the viewport, padding included.
 *
 * Upscaling is allowed (bounded by {@link PRESENT_MAX_SCALE}): an artboard is
 * live DOM scaled by a CSS transform, not a bitmap, so a 390 px phone screen
 * blown up on a 4K display stays crisp — which is the whole reason Present is
 * worth having over a PNG.
 */
export function presentFitScale(
  artboard: { width: number; height: number },
  viewport: PresentViewport,
  opts: PresentFitOptions = {},
): number {
  const w = positive(artboard?.width, 1);
  const h = positive(artboard?.height, 1);
  const pad = Math.max(0, numberOr(opts.padding, PRESENT_PADDING_PX));
  const vw = Math.max(1, numberOr(viewport?.width, 0) - pad * 2);
  const vh = Math.max(1, numberOr(viewport?.height, 0) - pad * 2);
  const min = numberOr(opts.min, PRESENT_MIN_SCALE);
  const max = numberOr(opts.max, PRESENT_MAX_SCALE);
  return Math.max(min, Math.min(max, Math.min(vw / w, vh / h)));
}

/** The artboards Present pages through, in board order. */
export function presentPages(artifact: Pick<CanvasArtifact, 'pages'>): ArtifactPage[] {
  return [...(artifact.pages ?? [])];
}

/** Index of the artboard to open on — the selected one, else the first. */
export function presentStartIndex(pages: readonly ArtifactPage[], startPageId?: string): number {
  if (!startPageId) { return 0; }
  const i = pages.findIndex(p => p.id === startPageId);
  return i >= 0 ? i : 0;
}

/**
 * Arrow paging. Clamps at the ends by default rather than wrapping: in a design
 * review, silently looping from the last artboard back to the first reads as
 * "nothing happened", which is worse than a hard stop.
 */
export function presentStep(index: number, delta: number, count: number, wrap = false): number {
  if (!Number.isFinite(count) || count <= 0) { return 0; }
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const next = i + d;
  if (wrap) { return ((next % count) + count) % count; }
  return Math.max(0, Math.min(count - 1, next));
}

/** True when some artboard in the deck still needs a JSX compiler in its frame. */
export function presentNeedsEval(pages: readonly ArtifactPage[]): boolean {
  return pages.some(p => pageRenderMode(p) === 'jsx');
}

export interface PresentDocOptions {
  artifact: CanvasArtifact;
  /** Inlined sandbox runtime — the same bag the export bundle uses. */
  runtime: HtmlBundleOptions;
  /** Open on this artboard (the selection when Present was invoked). */
  startPageId?: string;
  padding?: number;
}

/**
 * Build the full-bleed Present document: one sandboxed frame, the deck as
 * `srcdoc` documents, arrow/space paging, fit-to-screen on resize.
 */
export function buildPresentDocument(opts: PresentDocOptions): string {
  const { artifact, runtime } = opts;
  const pages = presentPages(artifact);
  const frames: ViewerFrame[] = pages.map((page, i) => {
    const format: CanvasFormatSpec = exportPageFormat(artifact, page);
    return {
      title: page.actionTitle || `Page ${i + 1}`,
      width: format.width,
      height: format.height,
      doc: buildExportPageDocument(artifact, page, runtime),
    };
  });

  return buildViewerDocument({
    title: artifact.name,
    frames,
    layout: 'present',
    startIndex: presentStartIndex(pages, opts.startPageId),
    allowEval: presentNeedsEval(pages),
    fitScaleJs: PRESENT_FIT_SCALE_JS,
    padding: opts.padding ?? PRESENT_PADDING_PX,
  });
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function positive(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n > 0 ? n : fallback;
}
