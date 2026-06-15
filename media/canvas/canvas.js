/*
 * Mysti - AI Coding Agent · Copyright (c) 2025 DeepMyst Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Canvas three-pane shell logic. Reads window.__MYSTI_CANVAS_BOOT__ (artifact +
 * runtime script URIs + theme presets + device formats) and renders the pages
 * rail, the live sandboxed page (one iframe), and the inspector. Theme/device
 * switches re-render the page client-side (no extension round-trip), so this
 * works identically in the VS Code webview and a standalone browser preview.
 *
 * The agent/MCP wiring (pages arriving live from chat) is layered on later via
 * postMessage; for now the boot state seeds sample pages.
 */
(function () {
  'use strict';
  var boot = window.__MYSTI_CANVAS_BOOT__ || {};
  var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;

  var state = {
    artifact: boot.artifact || { name: 'Untitled', kind: 'screens', pages: [], theme: null, format: null },
    presets: boot.presets || [],
    devices: boot.deviceFormats || [],
    runtimeSrcs: boot.runtimeSrcs || [],
    harnessSrc: boot.harnessSrc || '',
    // Webview path inlines the runtime as text (inner CSP is script-src
    // 'unsafe-inline'); the standalone preview uses <script src> relative paths.
    runtimeContent: boot.runtimeContent || null,
    harnessContent: boot.harnessContent || null,
    innerCsp: boot.innerCsp || '',
    capabilities: boot.capabilities || [],
    selectedId: null,
    inspTab: 'page',
  };
  if (state.artifact.pages && state.artifact.pages.length) {
    state.selectedId = state.artifact.pages[0].id;
  }

  // ── tiny helpers ──
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function kebab(s) { return String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(); }
  function selectedPage() { return (state.artifact.pages || []).find(function (p) { return p.id === state.selectedId; }); }

  // ── sandbox doc builder (mirrors src/managers/CanvasSandbox.ts) ──
  function buildThemeCssVars(theme) {
    if (!theme) { return ':root {}'; }
    var out = [];
    Object.keys(theme.colors || {}).forEach(function (k) { out.push('--theme-color-' + kebab(k) + ': ' + theme.colors[k] + ';'); });
    var t = theme.typography || {};
    out.push('--theme-font-body: ' + (t.fontFamily || 'system-ui, sans-serif') + ';');
    out.push('--theme-font-heading: ' + (t.headingFamily || t.fontFamily || 'system-ui, sans-serif') + ';');
    out.push('--theme-line-height: ' + (t.lineHeight || 1.5) + ';');
    var w = (t.weights || {});
    out.push('--theme-weight-regular: ' + (w.regular || 400) + ';');
    out.push('--theme-weight-medium: ' + (w.medium || 500) + ';');
    out.push('--theme-weight-bold: ' + (w.bold || 700) + ';');
    Object.keys(theme.radii || {}).forEach(function (k) { var v = theme.radii[k]; out.push('--theme-radius-' + kebab(k) + ': ' + (typeof v === 'number' ? v + 'px' : v) + ';'); });
    Object.keys(theme.shadows || {}).forEach(function (k) { out.push('--theme-shadow-' + kebab(k) + ': ' + theme.shadows[k] + ';'); });
    return ':root {\n  ' + out.join('\n  ') + '\n}';
  }

  function escScript(s) { return String(s).replace(/<\/script/gi, '<\\/script'); }
  function buildPageSrcdoc(page) {
    var theme = state.artifact.theme;
    var format = state.artifact.format || { width: 1440, height: 900, formatId: 'desktop' };
    var isJsx = page.mode === 'jsx';
    var scripts, harness;
    if (state.runtimeContent) {
      // Webview: inline the runtime as <script> text (inner CSP unsafe-inline).
      scripts = state.runtimeContent.map(function (c) { return '<script>' + escScript(c) + '</script>'; }).join('\n');
      harness = state.harnessContent ? '<script>' + escScript(state.harnessContent) + '</script>' : '';
    } else {
      // Standalone preview: load via relative <script src>.
      scripts = state.runtimeSrcs.map(function (s) { return '<script src="' + escAttr(s) + '"></script>'; }).join('\n');
      harness = state.harnessSrc ? '<script src="' + escAttr(state.harnessSrc) + '"></script>' : '';
    }
    var csp = state.innerCsp ? '<meta http-equiv="Content-Security-Policy" content="' + escAttr(state.innerCsp) + '">' : '';
    var body;
    if (isJsx) {
      var jsx = (page.jsxSource || '').replace(/<\/script/gi, '<\\/script');
      body = '<div id="__mysti_page"></div>\n<script type="text/plain" id="__mysti_page_jsx">' + jsx + '</script>';
    } else {
      body = '<div id="__mysti_page">' + (page.htmlSource || '') + '</div>';
    }
    return '<!doctype html><html lang="en" data-mode="' + (isJsx ? 'jsx' : 'html') + '" data-format="' + escAttr(format.formatId) + '">'
      + '<head><meta charset="utf-8">' + csp
      + '<style>' + buildThemeCssVars(theme)
      + 'html,body{margin:0}body{font-family:var(--theme-font-body);line-height:var(--theme-line-height);color:var(--theme-color-text);background:var(--theme-color-background)}*{box-sizing:border-box}'
      + '#__mysti_page{width:' + format.width + 'px;min-height:' + format.height + 'px;overflow:hidden;position:relative}'
      + '</style>' + scripts + '</head><body>' + body + harness + '</body></html>';
  }

  // ── render: top bar ──
  function renderTopbar() {
    el('artifact-name').textContent = state.artifact.name || 'Untitled';

    var dev = el('device-select');
    dev.innerHTML = state.devices.map(function (d) {
      return '<option value="' + escAttr(d.formatId) + '">' + esc(d.label || d.formatId) + '</option>';
    }).join('');
    if (state.artifact.format) { dev.value = state.artifact.format.formatId; }

    var th = el('theme-select');
    th.innerHTML = state.presets.map(function (p) {
      return '<option value="' + escAttr(p.id) + '">' + esc(p.name) + '</option>';
    }).join('');
    if (boot.activeThemeId) { th.value = boot.activeThemeId; }

    el('capability-chips').innerHTML = state.capabilities.map(function (c) {
      return '<span class="chip ' + (c.on ? 'on' : '') + '" title="' + escAttr(c.on ? 'connected' : 'not connected') + '">' + esc(c.label) + '</span>';
    }).join('');
  }

  // ── render: rail ──
  function renderRail() {
    var list = el('rail-list');
    var pages = state.artifact.pages || [];
    if (!pages.length) { list.innerHTML = '<div class="empty-sub" style="padding:8px">No pages yet.</div>'; return; }
    list.innerHTML = pages.map(function (p, i) {
      var bg = (state.artifact.theme && state.artifact.theme.colors.background) || '#fff';
      var fg = (state.artifact.theme && state.artifact.theme.colors.text) || '#000';
      var title = esc(p.actionTitle || ('Page ' + (i + 1)));
      return '<div class="thumb ' + (p.id === state.selectedId ? 'active' : '') + '" data-id="' + escAttr(p.id) + '">'
        + '<div class="thumb-preview" style="background:' + escAttr(bg) + ';color:' + escAttr(fg) + ';display:flex;align-items:center;justify-content:center;font-size:11px;">' + title + '</div>'
        + '<div class="thumb-meta"><span class="thumb-title">' + title + '</span><span class="thumb-badge">' + esc(p.mode) + '</span></div>'
        + '</div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.thumb'), function (node) {
      node.addEventListener('click', function () { selectPage(node.getAttribute('data-id')); });
    });
  }

  // ── render: board (the live page) ──
  function renderBoard() {
    var page = selectedPage();
    var stage = el('page-stage');
    el('board-empty').hidden = !!page;
    if (!page) { stage.innerHTML = ''; return; }

    var format = state.artifact.format || { width: 1440, height: 900 };
    var avail = el('board-scroll').clientWidth - 64;
    var scale = Math.min(1, avail > 0 ? avail / format.width : 1);

    var iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', page.actionTitle || 'page');
    iframe.style.width = format.width + 'px';
    iframe.style.height = format.height + 'px';
    iframe.style.transform = 'scale(' + scale + ')';
    iframe.style.transformOrigin = 'top left';
    iframe.srcdoc = buildPageSrcdoc(page);

    stage.style.width = (format.width * scale) + 'px';
    stage.style.height = (format.height * scale) + 'px';
    stage.innerHTML = '';
    stage.appendChild(iframe);
  }

  // ── render: inspector ──
  function renderInspector() {
    Array.prototype.forEach.call(document.querySelectorAll('.insp-tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === state.inspTab);
    });
    var body = el('insp-body');
    if (state.inspTab === 'theme') {
      var theme = state.artifact.theme || { colors: {} };
      var roles = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'border', 'success', 'error'];
      body.innerHTML = '<div class="insp-group-title">Palette</div><div class="swatches">'
        + roles.map(function (r) {
          var c = theme.colors[r] || '#000';
          return '<div class="swatch"><span class="chip-color" style="background:' + escAttr(c) + '"></span>' + r + '</div>';
        }).join('') + '</div>';
      return;
    }
    var p = selectedPage();
    var fmt = state.artifact.format || {};
    if (!p) { body.innerHTML = '<div class="empty-sub">No page selected.</div>'; return; }
    body.innerHTML = ''
      + row('Title', p.actionTitle || '—')
      + row('Mode', p.mode)
      + row('Version', 'v' + p.version)
      + row('Format', fmt.formatId + ' (' + fmt.width + '×' + fmt.height + ')')
      + row('Page id', shortId(p.id));
    function row(k, v) { return '<div class="insp-row"><span class="k">' + esc(k) + '</span><span class="v" title="' + escAttr(v) + '">' + esc(v) + '</span></div>'; }
  }
  function shortId(id) { return String(id).slice(0, 8) + '…'; }

  // ── interactions ──
  function selectPage(id) { state.selectedId = id; renderRail(); renderBoard(); renderInspector(); }

  function onDeviceChange(formatId) {
    var f = state.devices.find(function (d) { return d.formatId === formatId; });
    if (f) { state.artifact.format = { formatId: f.formatId, width: f.width, height: f.height, kind: f.kind || 'screen' }; renderBoard(); renderInspector(); }
  }
  function onThemeChange(presetId) {
    var p = state.presets.find(function (x) { return x.id === presetId; });
    if (p && p.theme) { state.artifact.theme = p.theme; renderRail(); renderBoard(); renderInspector(); }
  }

  var _activityTimer = null;
  function flashActivity(text) {
    var node = el('agent-activity');
    if (!node) { return; }
    node.textContent = text; node.hidden = false;
    if (_activityTimer) { clearTimeout(_activityTimer); }
    _activityTimer = setTimeout(function () { node.hidden = true; }, 1800);
  }

  function wire() {
    el('device-select').addEventListener('change', function (e) { onDeviceChange(e.target.value); });
    el('theme-select').addEventListener('change', function (e) { onThemeChange(e.target.value); });
    Array.prototype.forEach.call(document.querySelectorAll('.insp-tab'), function (t) {
      t.addEventListener('click', function () { state.inspTab = t.getAttribute('data-tab'); renderInspector(); });
    });
    el('btn-present').addEventListener('click', function () { if (vscode) { vscode.postMessage({ type: 'canvasPresent' }); } });
    el('btn-export').addEventListener('click', function () { if (vscode) { vscode.postMessage({ type: 'canvasExport' }); } });
    window.addEventListener('resize', renderBoard);
    window.addEventListener('message', function (ev) {
      var d = ev.data || {};
      // Page render errors from the iframe harness (future: inline "Fix with AI").
      if (d.source === 'mysti-canvas-page' && d.type === 'page_render_error') {
        console.warn('[Mysti canvas] page render error:', d.message);
        return;
      }
      // Live artifact update from the chat agent (pages added/edited, theme set).
      if (d.type === 'canvasArtifactUpdate' && d.payload) {
        var prev = (state.artifact.pages || []).length;
        state.artifact = Object.assign({}, state.artifact, d.payload);
        var pages = state.artifact.pages || [];
        if (pages.length > prev && pages.length) { state.selectedId = pages[pages.length - 1].id; }
        else if (!selectedPage() && pages.length) { state.selectedId = pages[0].id; }
        renderTopbar(); renderRail(); renderBoard(); renderInspector();
        flashActivity('Updated');
        return;
      }
      // Agent activity (op applied / heartbeat) → the top-bar activity line.
      if (d.type === 'canvasJobEvent' && d.payload) {
        if (d.payload.type === 'op_applied' || d.payload.type === 'started') { flashActivity('Designing…'); }
        return;
      }
      if (d.type === 'canvasOpError') { console.warn('[Mysti canvas] op error:', d.payload && d.payload.error); }
    });
  }

  function init() {
    renderTopbar(); renderRail(); renderBoard(); renderInspector(); wire();
    if (vscode) { vscode.postMessage({ type: 'canvasReady' }); }
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
  else { init(); }
})();
