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

import { buildPageDocument } from '../managers/CanvasSandbox';
import type { CanvasArtifact } from '../types';

/**
 * Exports a canvas artifact to distributable artifacts (Plan 05 §8 / Phase 5).
 * The **HTML bundle** is a self-contained, openable folder — a viewer page that
 * lists the screens with a live iframe of each — so a user can share their design
 * with no Mysti/VS Code needed. It's pure (just file contents), so it's fully
 * testable; the caller writes the files (or zips them). PNG export is also
 * supported via an injected Playwright capture, so the orchestration stays
 * testable without a browser.
 */

export interface ExportFile {
  path: string;
  /** utf8 text, or base64 for binary (PNG). */
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface ExportRuntimeFile {
  name: string;
  content: string;
}

export interface HtmlBundleOptions {
  /** Vendor + ui-primitives scripts, in load order (react, react-dom, babel, ui-primitives). */
  headRuntime: ExportRuntimeFile[];
  /** The harness script (runs last). */
  harness: ExportRuntimeFile;
}

/**
 * Build a self-contained HTML bundle: `index.html` (viewer) + `pages/page-N.html`
 * (each rendered through the same sandbox) + a shared `runtime/` dir. Relative
 * paths only, so it works opened from disk or any static host.
 */
export function exportHtmlBundle(artifact: CanvasArtifact, opts: HtmlBundleOptions): ExportFile[] {
  const headSrcs = opts.headRuntime.map(f => `../runtime/${f.name}`);
  const harnessSrc = `../runtime/${opts.harness.name}`;

  const pageFiles: ExportFile[] = artifact.pages.map((page, i) => ({
    path: `pages/page-${i}.html`,
    encoding: 'utf8',
    content: buildPageDocument({
      page, theme: artifact.theme, format: artifact.format,
      runtime: { headScriptSrcs: headSrcs, harnessSrc },
    }),
  }));

  const runtimeFiles: ExportFile[] = [...opts.headRuntime, opts.harness].map(f => ({
    path: `runtime/${f.name}`,
    content: f.content,
    encoding: 'utf8',
  }));

  return [
    { path: 'index.html', content: buildViewerHtml(artifact), encoding: 'utf8' },
    ...pageFiles,
    ...runtimeFiles,
  ];
}

export type CapturePng = (html: string, dims: { width: number; height: number }) => Promise<string>;

/** Export each page to a 2× PNG via an injected Playwright capture. */
export async function exportPng(
  artifact: CanvasArtifact,
  opts: HtmlBundleOptions & { capture: CapturePng },
): Promise<ExportFile[]> {
  const headSrcs = opts.headRuntime.map(f => `data:text/javascript;base64,${b64(f.content)}`);
  const harnessSrc = `data:text/javascript;base64,${b64(opts.harness.content)}`;
  const out: ExportFile[] = [];
  for (let i = 0; i < artifact.pages.length; i++) {
    const html = buildPageDocument({
      page: artifact.pages[i], theme: artifact.theme, format: artifact.format,
      runtime: { headScriptSrcs: headSrcs, harnessSrc },
    });
    const png = await opts.capture(html, { width: artifact.format.width, height: artifact.format.height });
    out.push({ path: `page-${i}.png`, content: png, encoding: 'base64' });
  }
  return out;
}

// ── viewer ──

function buildViewerHtml(artifact: CanvasArtifact): string {
  const items = artifact.pages.map((p, i) =>
    `<li><button data-i="${i}"${i === 0 ? ' class="active"' : ''}>${escapeHtml(p.actionTitle || `Page ${i + 1}`)}</button></li>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(artifact.name)}</title>
<style>
  :root { color-scheme: light dark; }
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
  iframe { border: 0; background: #fff; box-shadow: 0 10px 40px #0006; border-radius: 8px; }
</style>
</head>
<body>
  <div class="app">
    <header>${escapeHtml(artifact.name)}</header>
    <nav><ul>${items}</ul></nav>
    <main><iframe id="frame" width="${artifact.format.width}" height="${artifact.format.height}" src="pages/page-0.html"></iframe></main>
  </div>
  <script>
    var frame = document.getElementById('frame');
    var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'));
    function show(i) {
      frame.src = 'pages/page-' + i + '.html';
      btns.forEach(function (b, j) { b.classList.toggle('active', j === i); });
    }
    btns.forEach(function (b) { b.addEventListener('click', function () { show(+b.getAttribute('data-i')); }); });
    document.addEventListener('keydown', function (e) {
      var i = btns.findIndex(function (b) { return b.classList.contains('active'); });
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { show(Math.min(btns.length - 1, i + 1)); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { show(Math.max(0, i - 1)); }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
