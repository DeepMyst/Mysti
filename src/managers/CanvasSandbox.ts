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

export interface SandboxRuntime {
  /** Script *contents* inlined into <head> in load order (React, ReactDOM, Recharts, Babel, ui-primitives). */
  headScripts: string[];
  /** The harness script content (runs last in <body>: compile/mount/report/guard). */
  harness: string;
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

  const headScripts = runtime.headScripts.map(inlineScript).join('\n');
  const themeVars = buildThemeCssVars(theme);
  const baseCss = buildBaseCss(format);

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
<meta charset="utf-8">
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
${inlineScript(runtime.harness)}
</body>
</html>`;
}

// ── helpers ──────────────────────────────────────────────────────────────

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
