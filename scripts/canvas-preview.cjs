/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dev tool: render the canvas engine to standalone preview HTML you can open in
 * a browser — proving the renderer + UI.* primitives + scaffolds + theme presets
 * produce real, on-brand app/web screens, BEFORE the in-extension webview is
 * wired up. Uses the actual TS modules (transpiled on the fly) + the vendored
 * React/Babel runtime in resources/canvas-sandbox/.
 *
 * Usage:  node scripts/canvas-preview.cjs
 * Then:   open resources/canvas-sandbox/preview-*.html
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX = path.join(ROOT, 'resources/canvas-sandbox');

// Transpile a TS module on the fly and load it (CommonJS), resolving relative
// deps from a provided map, everything else via node require.
function load(rel, deps) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: 'commonjs', target: 'es2019', esModuleInterop: true },
  }).outputText;
  const m = { exports: {} };
  const req = (name) => (deps && deps[name]) ? deps[name] : require(name);
  new Function('module', 'exports', 'require', js)(m, m.exports, req);
  return m.exports;
}

const DSM = load('src/managers/DesignSpecManager.ts');
const Sandbox = load('src/managers/CanvasSandbox.ts');
const Formats = load('src/managers/CanvasFormats.ts');
const Scaffolds = load('src/managers/CanvasScaffolds.ts');
const Presets = load('src/managers/CanvasThemePresets.ts', { './DesignSpecManager': DSM });

const COMBOS = [
  { scaffold: 'dashboard', theme: 'midnight', format: 'desktop' },
  { scaffold: 'landing', theme: 'editorial', format: 'web' },
  { scaffold: 'mobile-home', theme: 'clean-saas', format: 'mobile' },
  { scaffold: 'login', theme: 'playful', format: 'mobile' },
  { scaffold: 'settings', theme: 'forest', format: 'mobile' },
];

for (const c of COMBOS) {
  const scaffold = Scaffolds.getScaffold(c.scaffold);
  const preset = Presets.getThemePreset(c.theme);
  const format = Formats.getFormat(c.format);
  const themeVars = Sandbox.buildThemeCssVars(preset.theme);
  const jsx = scaffold.jsx.replace(/<\/script/gi, '<\\/script');

  // Mirrors CanvasSandbox.buildPageDocument, but references the runtime via
  // relative <script src> (fine for a local file; the in-extension iframe
  // inlines them for the no-same-origin sandbox).
  const html = `<!doctype html>
<html lang="en" data-mode="jsx" data-format="${format.formatId}">
<head>
<meta charset="utf-8">
<title>Mysti canvas — ${scaffold.name} · ${preset.name}</title>
<style>
${themeVars}
html, body { margin: 0; }
body { background: #2a2d34; display: flex; justify-content: center; padding: 32px; font-family: var(--theme-font-body); }
* { box-sizing: border-box; }
#__mysti_page {
  width: ${format.width}px; min-height: ${format.height}px;
  background: var(--theme-color-background); color: var(--theme-color-text);
  line-height: var(--theme-line-height); overflow: hidden; position: relative;
  border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.45);
}
</style>
<script src="./react.production.min.js"></script>
<script src="./react-dom.production.min.js"></script>
<script src="./babel.min.js"></script>
<script src="./ui-primitives.js"></script>
</head>
<body>
<div id="__mysti_page"></div>
<script type="text/plain" id="__mysti_page_jsx">${jsx}</script>
<script src="./harness.js"></script>
</body>
</html>`;

  const file = path.join(SANDBOX, `preview-${c.scaffold}-${c.theme}.html`);
  fs.writeFileSync(file, html);
  console.log('wrote', path.relative(ROOT, file), `(${format.formatId}, ${format.width}x${format.height})`);
}

// ── Full three-pane shell preview (the actual media/canvas/ webview) ──
(function buildShellPreview() {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'media/canvas/index.html'), 'utf8');

  const pages = ['dashboard', 'landing', 'mobile-home', 'login', 'settings'].map((id, i) => {
    const s = Scaffolds.getScaffold(id);
    return { id: 'page-' + i, version: 1, mode: 'jsx', jsxSource: s.jsx, actionTitle: s.name };
  });
  const devices = ['desktop', 'web', 'tablet', 'mobile'].map(fid => {
    const f = Formats.getFormat(fid);
    return { formatId: f.formatId, width: f.width, height: f.height, kind: f.kind, label: f.formatId + ' (' + f.width + '×' + f.height + ')' };
  });
  const presets = Presets.THEME_PRESETS.map(p => ({ id: p.id, name: p.name, dark: p.dark, theme: p.theme }));
  const cleanSaas = Presets.getThemePreset('clean-saas');

  const rt = '../../resources/canvas-sandbox/';
  const boot = {
    artifact: {
      id: 'demo', name: 'Sample App (demo)', kind: 'screens',
      format: { formatId: 'desktop', width: 1440, height: 900, kind: 'screen' },
      theme: cleanSaas.theme, pages,
    },
    presets, deviceFormats: devices, activeThemeId: 'clean-saas',
    runtimeSrcs: [rt + 'react.production.min.js', rt + 'react-dom.production.min.js', rt + 'babel.min.js', rt + 'ui-primitives.js'],
    harnessSrc: rt + 'harness.js',
    capabilities: [{ label: 'fal', on: false }, { label: 'Stitch', on: false }, { label: 'Figma', on: false }],
  };

  const out = indexHtml
    .replace('{{cspMeta}}', '')
    .replace('{{cssUri}}', './canvas.css')
    .replace('{{jsUri}}', './canvas.js')
    .replace('{{nonce}}', 'preview')
    .replace('{{boot}}', 'window.__MYSTI_CANVAS_BOOT__ = ' + JSON.stringify(boot) + ';');

  const file = path.join(ROOT, 'media/canvas/preview-shell.html');
  fs.writeFileSync(file, out);
  console.log('wrote', path.relative(ROOT, file), '(the full three-pane shell)');
})();

console.log('\nOpen the full canvas:  open media/canvas/preview-shell.html');
console.log('Or a single screen:    open resources/canvas-sandbox/preview-dashboard-midnight.html');
