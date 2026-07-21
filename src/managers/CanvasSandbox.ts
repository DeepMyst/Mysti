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

import type { ArtifactPage, DesignTheme, CanvasFormatSpec } from '../types';

/**
 * Builds the self-contained HTML document for a page's sandboxed iframe (Plan 05
 * M1 / §5). The iframe runs with `sandbox="allow-scripts"` only — **no**
 * `allow-same-origin` (fixes F-6) — so every script is inlined as text; nothing
 * loads over the network. The document injects the theme as CSS custom
 * properties, sizes a fixed design-px page box from the format (real device px
 * for app/web screens), and either renders raw `html` or compiles a
 * `function Page()` JSX component via the harness.
 *
 * Pure + testable: the actual vendor runtime (React/Recharts/Babel UMD) and the
 * local `ui-primitives.js`/`harness.js` are passed in as inlined script text by
 * the webview, so this builder is exercised without bundling React.
 */

export const PAGE_ROOT_ID = '__mysti_page';
export const PAGE_JSX_SCRIPT_ID = '__mysti_page_jsx';

/**
 * Default inner CSP for the built page document (Plan 18 W4 6.2: export-bundle
 * pages previously shipped with NO CSP). MIRROR: this string must stay in sync
 * with `SANDBOX_INNER_CSP` in src/webview/canvasContent.ts, which injects the
 * same policy into the JS mirror builder `buildPageSrcdoc` in
 * media/canvas/canvas.js — the TS and JS builders are mirrors of each other.
 * The webview path inlines the runtime as text, so no script source-list
 * entries are needed there; `buildPageDocument` widens `script-src` only when
 * the runtime arrives via `<script src>` (see `defaultCspFor`).
 */
export const SANDBOX_INNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; connect-src 'none';";

export interface SandboxRuntime {
  /**
   * Script *contents* inlined into <head> in load order (React, ReactDOM,
   * Recharts, Babel, ui-primitives). Required for the no-same-origin iframe
   * srcdoc (nothing loads over the network).
   */
  headScripts?: string[];
  /**
   * Alternative to `headScripts`: load the runtime via `<script src>` URLs
   * (webview `asWebviewUri` or relative paths for a standalone preview) instead
   * of inlining. Use when the host CSP permits the source.
   */
  headScriptSrcs?: string[];
  /** The harness script content (runs last in <body>: compile/mount/report/guard). */
  harness?: string;
  /** Alternative: load the harness via `<script src>`. */
  harnessSrc?: string;
  /** Optional extra stylesheet (utility classes). */
  css?: string;
}

export interface BuildPageDocOptions {
  page: ArtifactPage;
  theme: DesignTheme;
  format: CanvasFormatSpec;
  runtime: SandboxRuntime;
  /** Resolve an `asset://…` ref to a URL the iframe can load (webview/asset URI). */
  resolveAsset?: (ref: string) => string;
  /**
   * Content-Security-Policy meta for the document. Defaults to
   * {@link SANDBOX_INNER_CSP}, widened with `'self'`/`data:` script sources
   * when the runtime is `<script src>`-loaded (export bundle / PNG capture).
   * Pass a string to override, or `false` to omit the meta entirely (only for
   * consumers whose host already enforces a stricter policy).
   */
  csp?: string | false;
}

const ASSET_REF_RE = /asset:\/\/[^\s"'`)<>]+/g;

/** Emit the theme as `--theme-*` CSS custom properties on `:root`. */
export function buildThemeCssVars(theme: DesignTheme): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(theme.colors)) {
    lines.push(`--theme-color-${kebab(name)}: ${value};`);
  }
  lines.push(`--theme-font-body: ${theme.typography.fontFamily};`);
  lines.push(`--theme-font-heading: ${theme.typography.headingFamily ?? theme.typography.fontFamily};`);
  lines.push(`--theme-line-height: ${theme.typography.lineHeight};`);
  lines.push(`--theme-weight-regular: ${theme.typography.weights.regular};`);
  lines.push(`--theme-weight-medium: ${theme.typography.weights.medium};`);
  lines.push(`--theme-weight-bold: ${theme.typography.weights.bold};`);
  lines.push(`--theme-space-unit: ${theme.spacing.unit}px;`);
  for (const [k, v] of Object.entries(theme.radii)) {
    lines.push(`--theme-radius-${kebab(k)}: ${typeof v === 'number' ? `${v}px` : v};`);
  }
  for (const [k, v] of Object.entries(theme.shadows)) {
    lines.push(`--theme-shadow-${kebab(k)}: ${v};`);
  }
  return `:root {\n  ${lines.join('\n  ')}\n}`;
}

/** Replace `asset://…` tokens in a source string using the resolver. */
export function rewriteAssetTokens(source: string, resolve?: (ref: string) => string): string {
  if (!resolve) { return source; }
  return source.replace(ASSET_REF_RE, ref => resolve(ref));
}

/** Assemble the full iframe document for a page. */
export function buildPageDocument(opts: BuildPageDocOptions): string {
  const { page, theme, format, runtime, resolveAsset } = opts;
  const isJsx = page.mode === 'jsx';

  const inlined = (runtime.headScripts ?? []).map(inlineScript);
  const sourced = (runtime.headScriptSrcs ?? []).map(srcScript);
  const headScripts = [...sourced, ...inlined].join('\n');
  const harness = runtime.harnessSrc ? srcScript(runtime.harnessSrc)
    : runtime.harness ? inlineScript(runtime.harness) : '';
  const themeVars = buildThemeCssVars(theme);
  const baseCss = buildBaseCss(format);
  // 6.2: pages are self-contained + potentially model-authored — always carry a
  // CSP (no network beyond the whitelisted image/font sources) unless the
  // caller explicitly opts out. Mirrors the webview's inner CSP (canvas.js).
  const cspContent = opts.csp === false ? '' : (opts.csp ?? defaultCspFor(runtime));
  const cspMeta = cspContent
    ? `\n<meta http-equiv="Content-Security-Policy" content="${escapeAttr(cspContent)}">`
    : '';

  let body: string;
  if (isJsx) {
    const jsx = rewriteAssetTokens(page.jsxSource ?? '', resolveAsset);
    body =
      `<div id="${PAGE_ROOT_ID}"></div>\n` +
      `<script type="text/plain" id="${PAGE_JSX_SCRIPT_ID}">${escapeForScript(jsx)}</script>`;
  } else {
    const html = rewriteAssetTokens(page.htmlSource ?? '', resolveAsset);
    body = `<div id="${PAGE_ROOT_ID}">${html}</div>`;
  }

  return `<!doctype html>
<html lang="en" data-mode="${isJsx ? 'jsx' : 'html'}" data-format="${escapeAttr(format.formatId)}">
<head>
<meta charset="utf-8">${cspMeta}
<meta name="viewport" content="width=${format.width}, initial-scale=1">
<style>
${themeVars}
${baseCss}
${runtime.css ?? ''}
</style>
${headScripts}
</head>
<body>
${body}
${harness}
</body>
</html>`;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * The default CSP for a runtime delivery mode: inlined runtime → the exact
 * webview mirror policy; `<script src>` runtime → `script-src` additionally
 * allows `'self'` (bundle-relative runtime files) and/or `data:` (the PNG
 * capture path inlines the runtime as data: URIs). Everything else (no
 * connect-src, no frames, restricted img/font sources) stays identical.
 */
function defaultCspFor(runtime: SandboxRuntime): string {
  const srcs = [...(runtime.headScriptSrcs ?? []), ...(runtime.harnessSrc ? [runtime.harnessSrc] : [])];
  const extras: string[] = [];
  if (srcs.some(s => s.startsWith('data:'))) { extras.push('data:'); }
  if (srcs.some(s => !s.startsWith('data:'))) {
    // W4 review: exported bundles with relative <script src> are opened from
    // DISK — Chromium gives file:// pages an opaque origin where 'self' does
    // not match, so the runtime scripts would be blocked. `file:` keeps the
    // export working while still blocking all network script sources.
    extras.push("'self'", 'file:');
  }
  if (extras.length === 0) { return SANDBOX_INNER_CSP; }
  let csp = SANDBOX_INNER_CSP.replace(
    "script-src 'unsafe-inline' 'unsafe-eval'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${extras.join(' ')}`,
  );
  if (extras.includes("'self'")) {
    // Same file://-origin problem for relative image assets in the export.
    csp = csp.replace('img-src data: blob: https:', 'img-src data: blob: https: file:');
  }
  return csp;
}

function buildBaseCss(format: CanvasFormatSpec): string {
  return [
    `html, body { margin: 0; padding: 0; }`,
    `body { font-family: var(--theme-font-body); line-height: var(--theme-line-height); color: var(--theme-color-text); background: var(--theme-color-background); }`,
    `* { box-sizing: border-box; }`,
    // Fixed design-px page box; the parent scales the iframe via CSS transform.
    `#${PAGE_ROOT_ID} { width: ${format.width}px; min-height: ${format.height}px; overflow: hidden; position: relative; }`,
  ].join('\n');
}

function inlineScript(content: string): string {
  return `<script>${escapeForScript(content)}</script>`;
}

function srcScript(src: string): string {
  return `<script src="${escapeAttr(src)}"></script>`;
}

/** Neutralize a closing-script sequence so embedded code can't break out. */
function escapeForScript(s: string): string {
  return s.replace(/<\/script/gi, '<\\/script');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
