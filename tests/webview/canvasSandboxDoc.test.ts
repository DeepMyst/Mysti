/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §2.9 — ONE sandbox-document builder.
 *
 * `media/canvas/canvas.js` carried a hand-written JS mirror of
 * `CanvasSandbox.ts` that had drifted three ways (no `asset://` resolution, no
 * `--theme-space-unit`, no page size). These tests pin the properties that
 * mirror kept losing, against the compiled webview's adapter — which now
 * *imports* `buildPageDocument` and `themeTokenMap` rather than re-deriving
 * either. The last assertion is the interesting one: it checks the parent-side
 * theme vars are derived from the same token map the frame is baked from, so
 * the two renderers cannot disagree about what a token means.
 */
import { describe, it, expect } from 'vitest';
import { buildFrameDocument, needsBabel, frameRenderMode, themeCssVars } from '../../src/webview/canvas/sandboxDoc';
import { themeTokenMap, DOC_SANDBOX_INNER_CSP } from '../../src/managers/CanvasSandbox';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import type { ArtifactPage, DesignTheme } from '../../src/types';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;
const MOBILE = getFormat('mobile')!;

function docPage(): ArtifactPage {
  return {
    id: 'p1', version: 3, boardPos: { x: 0, y: 0 }, actionTitle: 'Login',
    doc: { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Welcome' }] },
  };
}

function legacyPage(): ArtifactPage {
  return { ...docPage(), legacy: { mode: 'jsx', source: 'function Page(){ return <div/>; }' }, compileError: 'nope' };
}

const runtime = { scripts: ['/*react*/'], harness: '/*harness*/', babel: '/*BABEL_SENTINEL*/' };

describe('the one builder', () => {
  it('emits a complete document with theme vars, page box and a CSP', () => {
    const html = buildFrameDocument({ page: docPage(), theme: THEME, format: MOBILE, runtime });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain(DOC_SANDBOX_INNER_CSP);
    // The three cells the JS mirror had lost.
    expect(html).toContain('--theme-space-unit');
    expect(html).toContain('width: 390px');
    expect(html).toContain('min-height: 844px');
  });

  it('rewrites asset:// tokens through the injected resolver', () => {
    const page = docPage();
    page.doc.children![0].text = 'see asset://abc.png';
    const html = buildFrameDocument({
      page, theme: THEME, format: MOBILE, runtime,
      resolveAsset: ref => `https://res.test/${ref.slice(8)}`,
    });
    expect(html).toContain('https://res.test/abc.png');
    expect(html).not.toContain('asset://abc.png');
  });

  it('widens the hardened doc img-src for the webview asset origin', () => {
    const html = buildFrameDocument({
      page: docPage(), theme: THEME, format: MOBILE, runtime,
      imgSources: ['vscode-webview://0a1b2c3d'],
    });
    expect(html).toContain('vscode-webview://0a1b2c3d');
    // ...and a caller cannot append a whole directive through that seam.
    const injected = buildFrameDocument({
      page: docPage(), theme: THEME, format: MOBILE, runtime,
      imgSources: ["'none'; script-src *"],
    });
    expect(injected).not.toContain('script-src *');
  });

  it('ships the page tree so the harness never has to compile', () => {
    const html = buildFrameDocument({ page: docPage(), theme: THEME, format: MOBILE, runtime });
    expect(html).toContain('__mysti_page_doc');
    expect(html).toContain('"tag":"UI.Heading"');
    expect(html).toContain('data-mode="doc"');
  });
});

describe('Babel is lazy and legacy-only', () => {
  it('is absent from a document-model frame', () => {
    expect(frameRenderMode(docPage())).toBe('doc');
    expect(needsBabel(docPage())).toBe(false);
    const html = buildFrameDocument({ page: docPage(), theme: THEME, format: MOBILE, runtime });
    expect(html).not.toContain('BABEL_SENTINEL');
  });

  it('is injected into a legacy frame that still needs a compiler', () => {
    expect(needsBabel(legacyPage())).toBe(true);
    const html = buildFrameDocument({ page: legacyPage(), theme: THEME, format: MOBILE, runtime });
    expect(html).toContain('BABEL_SENTINEL');
  });

  it('degrades honestly when a legacy page needs Babel and none was fetched', () => {
    const html = buildFrameDocument({
      page: legacyPage(), theme: THEME, format: MOBILE,
      runtime: { scripts: [], harness: '' },
    });
    expect(html).toContain('<!doctype html>');   // still a document, not a throw
  });
});

describe('theme vars for the parent-side preview', () => {
  it('derives from themeTokenMap, so the two renderers cannot disagree', () => {
    const vars = themeCssVars(THEME);
    for (const [token, value] of Object.entries(themeTokenMap(THEME))) {
      expect(vars[`--theme-${token}`]).toBe(value);
    }
    expect(vars['--theme-space-unit']).toBe(`${THEME.spacing.unit}px`);
  });

  it('refuses a hostile token that would launder url() into an allowlisted property', () => {
    const hostile: DesignTheme = JSON.parse(JSON.stringify(THEME));
    hostile.colors.primary = 'url(https://evil/?leak=1)';
    hostile.colors.accent = 'red; background: url(https://evil)';
    const vars = themeCssVars(hostile);
    // `background: var(--theme-color-primary)` is allowlisted, so an unchecked
    // token value would fire a GET from the PARENT document.
    expect(vars['--theme-color-primary']).toBeUndefined();
    expect(vars['--theme-color-accent']).toBeUndefined();
    expect(vars['--theme-color-surface']).toBe(THEME.colors.surface);
  });
});

describe('script-embedded payloads', () => {
  it('neutralizes a </script> smuggled through page text', () => {
    const page = docPage();
    page.doc.children![0].text = '</script><script>alert(1)</script>';
    const html = buildFrameDocument({ page, theme: THEME, format: MOBILE, runtime });
    expect(html).not.toMatch(/<\/script><script>alert\(1\)/);
  });
});
