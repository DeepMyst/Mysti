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
 * Plan 05 Phase 0 — Canvas v2 webview stabilization (canvasContent.ts).
 *
 * Two complementary strategies, both grounded in the REAL shipped artifact so
 * they cannot drift:
 *   1. Function-extraction (the wizardPanelId.test.ts pattern): pull pure
 *      helpers out of the generated webview script by brace-matching and run
 *      them — here `_buildStandaloneHtml` (F-6 sandbox HTML builder).
 *   2. Source-presence guards: assert the security/coordinate fixes are wired
 *      into the generated content (F-1/F-2/F-6/F-12/F-13/F-18).
 * Pure math/parse logic (crop bounds, actionType parse) is re-implemented from
 * the source and cross-checked against the extension-side parser.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getCanvasContent } from '../../src/webview/canvasContent';
import { CanvasManager } from '../../src/managers/CanvasManager';

const repoRoot = path.resolve(__dirname, '..', '..');

function makeWebview() {
  return {
    cspSource: 'vscode-resource://test',
    asWebviewUri: (uri: { fsPath: string }) => ({
      toString: () => 'vscode-resource://authority' + uri.fsPath,
    }),
  } as any;
}

const extensionUri = { fsPath: repoRoot, path: repoRoot } as any;

/** Extract a top-level `function name(...) { ... }` by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in canvas webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) { return source.slice(start, i + 1); }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

let html: string;

beforeAll(() => {
  html = getCanvasContent(makeWebview(), extensionUri, '1.2.3');
});

// ---------------------------------------------------------------------------
// Sanity: the generated inner webview script is syntactically valid JS.
// Catches template-literal escape corruption introduced by the edits (e.g. a
// stray `${}` or unbalanced backtick) that webpack would not flag because the
// content is a string until it runs in the browser.
// ---------------------------------------------------------------------------
describe('generated webview script is parseable JS', () => {
  it('the main IIFE script body parses with new Function', () => {
    // The main app script is the last nonce'd inline <script> block (the one
    // that opens with the IIFE). Grab from the IIFE start to its closing tag.
    const iifeStart = html.indexOf('(function() {');
    expect(iifeStart).toBeGreaterThan(-1);
    const scriptEnd = html.indexOf('</script>', iifeStart);
    expect(scriptEnd).toBeGreaterThan(iifeStart);
    const body = html.slice(iifeStart, scriptEnd);
    // Should not throw a SyntaxError. We do NOT execute it (no DOM); new
    // Function only parses the body.
    expect(() => new Function(body)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F-6 — Sandbox hardening: the bundled runtime ships and is wired in
// ---------------------------------------------------------------------------
describe('canvas-sandbox bundled runtime (F-6)', () => {
  const sandboxDir = path.join(repoRoot, 'resources', 'canvas-sandbox');

  it('ships React, ReactDOM and Babel locally (no unpkg dependency)', () => {
    expect(fs.existsSync(path.join(sandboxDir, 'react.production.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(sandboxDir, 'react-dom.production.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(sandboxDir, 'babel.min.js'))).toBe(true);
  });

  it('bundled files are non-trivial and contain their license header', () => {
    const react = fs.readFileSync(path.join(sandboxDir, 'react.production.min.js'), 'utf8');
    const babel = fs.readFileSync(path.join(sandboxDir, 'babel.min.js'), 'utf8');
    expect(react.length).toBeGreaterThan(5000);
    expect(react).toContain('@license React');
    expect(babel.length).toBeGreaterThan(100000); // standalone Babel is large
  });

  it('the generated webview references the bundled sandbox URIs, not unpkg', () => {
    expect(html).not.toContain('unpkg.com');
    expect(html).toContain('canvas-sandbox/react.production.min.js');
    expect(html).toContain('canvas-sandbox/react-dom.production.min.js');
    expect(html).toContain('canvas-sandbox/babel.min.js');
  });
});

describe('sandbox iframe hardening (F-6)', () => {
  it('iframes drop allow-same-origin (allow-scripts only)', () => {
    expect(html).not.toContain('allow-scripts allow-same-origin');
    expect(html).toContain("setAttribute('sandbox', 'allow-scripts')");
  });

  it('iframes use srcdoc, not Blob URLs (Blob inherits the webview origin)', () => {
    expect(html).not.toContain('URL.createObjectURL');
    expect(html).not.toContain('new Blob(');
    expect(html).toContain("setAttribute('srcdoc'");
  });

  it('the document.write reload path is gone, replaced by srcdoc recreation', () => {
    expect(html).not.toContain('document.write');
    expect(html).not.toContain('mysti-reload');
  });

  it('bridges the parent<->iframe over a MessageChannel port', () => {
    expect(html).toContain('new MessageChannel()');
    expect(html).toContain("'mysti-port'");
    expect(html).toContain('channel.port2');
  });
});

// ---------------------------------------------------------------------------
// F-6 — _buildStandaloneHtml builds a self-contained, CSP-locked page
// (function extraction: run the REAL builder from the shipped script)
// ---------------------------------------------------------------------------
describe('_buildStandaloneHtml (F-6 function extraction)', () => {
  function runBuild(code: string, name: string, framework: string, runtime: any): string {
    const cspSrc = extractFunction(html, '_buildStandaloneHtml');
    // _SANDBOX_INNER_CSP is a sibling const inside the IIFE; supply it.
    const run = new Function(
      '_SANDBOX_INNER_CSP', 'code', 'componentName', 'framework', 'runtime',
      `${cspSrc}\nreturn _buildStandaloneHtml(code, componentName, framework, runtime);`
    );
    return run("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';", code, name, framework, runtime);
  }

  it('inlines the provided runtime as <script> text for react (no external src)', () => {
    const out = runBuild(
      'function Page(){return React.createElement("div",null,"hi");}',
      'Page', 'react',
      { react: 'REACT_BUNDLE_X', reactDom: 'REACTDOM_BUNDLE_Y', babel: 'BABEL_BUNDLE_Z' }
    );
    expect(out).toContain('REACT_BUNDLE_X');
    expect(out).toContain('REACTDOM_BUNDLE_Y');
    expect(out).toContain('BABEL_BUNDLE_Z');
    // No external script src — runtime is inlined.
    expect(out).not.toMatch(/<script[^>]+src=/);
    // Carries an inner CSP meta (opaque-origin sandbox lock).
    expect(out).toContain('Content-Security-Policy');
  });

  it('html mode embeds the code verbatim with no runtime needed', () => {
    const out = runBuild('<h1>raw</h1>', '', 'html', null);
    expect(out).toContain('<h1>raw</h1>');
    expect(out).toContain('Content-Security-Policy');
    expect(out).not.toContain('text/babel');
  });
});

// ---------------------------------------------------------------------------
// F-1 — crop bounds world->screen conversion math
// (re-implemented from source; the source-presence guard pins the real code)
// ---------------------------------------------------------------------------
describe('region crop world->screen conversion (F-1)', () => {
  // Mirrors the conversion the webview now performs before toDataURL.
  function worldCropToScreen(
    crop: { left: number; top: number; width: number; height: number },
    zoom: number,
    vpt: number[]
  ) {
    return {
      left: crop.left * zoom + vpt[4],
      top: crop.top * zoom + vpt[5],
      width: crop.width * zoom,
      height: crop.height * zoom,
      multiplier: zoom > 0 ? 1 / zoom : 1,
    };
  }

  it('is identity at zoom=1, pan=(0,0)', () => {
    const s = worldCropToScreen({ left: 100, top: 50, width: 200, height: 120 }, 1, [1, 0, 0, 1, 0, 0]);
    expect(s).toEqual({ left: 100, top: 50, width: 200, height: 120, multiplier: 1 });
  });

  it('applies zoom to size and pan offset to position when zoomed/panned', () => {
    // zoom 2x, panned by (+300, -80)
    const s = worldCropToScreen({ left: 100, top: 50, width: 200, height: 120 }, 2, [2, 0, 0, 2, 300, -80]);
    expect(s.left).toBe(100 * 2 + 300); // 500
    expect(s.top).toBe(50 * 2 + -80);   // 20
    expect(s.width).toBe(400);
    expect(s.height).toBe(240);
    expect(s.multiplier).toBe(0.5); // 1/zoom restores native resolution
  });

  it('the generated webview wires this conversion into the snapshot crop', () => {
    expect(html).toContain('cropLeft * cropZoom + cropVpt[4]');
    expect(html).toContain('cropTop * cropZoom + cropVpt[5]');
    expect(html).toContain('multiplier: cropZoom > 0 ? 1 / cropZoom : 1');
  });

  it('the full-scene capture resets viewportTransform to identity around toDataURL', () => {
    expect(html).toContain('canvas.setViewportTransform([1, 0, 0, 1, 0, 0])');
    expect(html).toContain('canvas.setViewportTransform(fullCaptureVpt)');
  });
});

// ---------------------------------------------------------------------------
// F-4 — webview actionType vocabulary matches the extension parser
// ---------------------------------------------------------------------------
describe('actionType parse alignment with CanvasManager.parseUnifiedPrompt (F-4)', () => {
  // The webview's slash-command -> actionType map (mirrors sendUnifiedPrompt).
  function webviewActionType(text: string): string {
    if (text.startsWith('/design-dna')) { return 'design-dna'; }
    if (text.startsWith('/design')) { return 'page'; }
    if (text.startsWith('/image')) { return 'generate'; }
    if (text.startsWith('/video')) { return 'video'; }
    if (text.startsWith('/website')) { return 'website'; }
    if (text.startsWith('/svg')) { return 'svg'; }
    if (text.startsWith('/code')) { return 'code'; }
    if (text.startsWith('/theme')) { return 'theme'; }
    if (text.startsWith('/render')) { return 'render'; }
    if (text.startsWith('/edit-element')) { return 'edit-element'; }
    if (text.startsWith('/edit-layout')) { return 'edit-layout'; }
    if (text.startsWith('/edit')) { return 'stitch-edit'; }
    if (text.startsWith('/variants')) { return 'stitch-variants'; }
    if (text.startsWith('/html')) { return 'stitch-html'; }
    return 'prompt';
  }

  const commands = [
    '/design-dna', '/design x', '/image cat', '/video clip', '/website shop',
    '/svg', '/code', '/theme dark', '/render http://x', '/edit-element',
    '/edit-layout', '/edit', '/variants', '/html', 'no slash here',
  ];

  it('every slash command yields the same action name as the extension parser', () => {
    for (const cmd of commands) {
      const fromExtension = CanvasManager.parseUnifiedPrompt(cmd).action;
      const fromWebview = webviewActionType(cmd);
      expect(fromWebview, `mismatch for "${cmd}"`).toBe(fromExtension);
    }
  });

  it('/design maps to "page" (NOT the old "design"), which used to leak the spinner', () => {
    expect(webviewActionType('/design login screen')).toBe('page');
    expect(CanvasManager.parseUnifiedPrompt('/design login screen').action).toBe('page');
  });
});

// ---------------------------------------------------------------------------
// F-4 — every job is cleared on canvas_error; F-3 sends stitchScreenRef
// ---------------------------------------------------------------------------
describe('job leak + stitch ref guards (F-3, F-4)', () => {
  it('canvas_error tears down ALL jobs via genJobClearAll', () => {
    expect(html).toContain('function genJobClearAll()');
    // The error handler calls it.
    const errIdx = html.indexOf("case 'canvas_error':");
    expect(errIdx).toBeGreaterThan(-1);
    const errBlock = html.slice(errIdx, errIdx + 600);
    expect(errBlock).toContain('genJobClearAll()');
  });

  it('a _pendingMiscJob slot tracks the otherwise-untracked action types', () => {
    expect(html).toContain('_pendingMiscJob');
  });

  it('sendUnifiedPrompt attaches stitchScreenRef from the active object (F-3)', () => {
    expect(html).toContain('_activeForRef._stitchScreenRef');
    expect(html).toContain('stitchScreenRef: stitchScreenRef');
  });
});

// ---------------------------------------------------------------------------
// F-2 / F-12 — undo/redo use v6 promise loadFromJSON; first undo works
// ---------------------------------------------------------------------------
describe('undo/redo v6 + off-by-one (F-2, F-12)', () => {
  it('restores via promise-based loadFromJSON (no v5 reviver callback)', () => {
    expect(html).toContain('canvas.loadFromJSON(parsed).then(function()');
    expect(html).toContain('isUndoRedoing = false;');
  });

  it('undo requires >= 2 stack entries (current + previous) so first undo works', () => {
    expect(html).toContain('if (undoStack.length < 2) return;');
    expect(html).toContain('undoStack.length < 2'); // also gates the button
  });
});

// ---------------------------------------------------------------------------
// F-13 / F-18 — scene coords + scaled sizing
// ---------------------------------------------------------------------------
describe('coordinate + sizing fixes (F-13, F-18)', () => {
  it('uses getScenePoint for placement + cursor readout (not getViewportPoint)', () => {
    expect(html).not.toContain('canvas.getViewportPoint(opt.e)');
    expect(html).toContain('canvas.getScenePoint(opt.e)');
  });

  it('uses getScaledWidth()/getScaledHeight() for frame-targeted media', () => {
    expect(html).toContain('targetObject.getScaledWidth()');
    expect(html).toContain('targetObject.getScaledHeight()');
  });
});

// ---------------------------------------------------------------------------
// F-7 — Apply props sends real source; F-26 default _designSpec
// ---------------------------------------------------------------------------
describe('apply-props source + theme defaults (F-7, F-26)', () => {
  it('Apply props sends real svgMarkup and currentSource (not an empty SVG)', () => {
    expect(html).toContain('svgMarkup: propsSvgMarkup');
    expect(html).toContain('currentSource: propsCurrentSource');
    expect(html).not.toContain("svgMarkup: '',");
  });

  it('canvas_theme_complete creates a default _designSpec when none exists', () => {
    const idx = html.indexOf("case 'canvas_theme_complete':");
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 800);
    expect(block).toContain('if (chunk.designTheme && !_designSpec)');
    expect(block).toContain("name: 'Untitled'");
  });
});
