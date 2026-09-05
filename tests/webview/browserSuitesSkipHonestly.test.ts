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
 * Plan 27 lane M (§21.6c #8) — a browser suite that cannot launch Chromium
 * must report SKIPPED, never a false pass.
 *
 * Every `*Browser*.test.ts` suite guarded its bodies with
 * `if (unavailable) { console.warn(...); return; }` — a green tick with zero
 * assertions executed. On this machine Playwright 1.58 wants
 * `chromium_headless_shell-1208` and the cache holds 1234, so 9 files / 64
 * tests were passing without a browser (see fixes4/M-trust-ui.md).
 *
 * The contract now: availability is probed SYNCHRONOUSLY at module load
 * (tests/webview/chromiumAvailability.ts) and each browser test is declared
 * with `it.skipIf(CHROMIUM_UNAVAILABLE)`, so vitest counts it as skipped.
 * A present binary that then fails to launch is a real failure and throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { expectedHeadlessShellDir } from './chromiumAvailability';

const DIR = __dirname;
const SUITES = fs.readdirSync(DIR).filter(f => /Browser\.test\.ts$/.test(f)).sort();

describe('browser suites skip honestly (static)', () => {
  it('finds the browser suites', () => {
    expect(SUITES.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of SUITES) {
    describe(file, () => {
      const src = fs.readFileSync(path.join(DIR, file), 'utf8');

      it('has no warn-and-return guard inside a test body', () => {
        expect(src).not.toMatch(/if \(unavailable\)[^\n]*return;/);
        expect(src).not.toMatch(/if \(!art\)[^\n]*return;/);
        expect(src).not.toContain("console.warn('[Mysti] skipping");
      });

      it('imports the synchronous availability probe and declares browser tests with it.skipIf', () => {
        expect(src).toMatch(/import \{[^}]*CHROMIUM_UNAVAILABLE[^}]*\} from '\.\/chromiumAvailability';/);
        // `it.skipIf(CHROMIUM_UNAVAILABLE)(` or a compound `it.skipIf(CHROMIUM_UNAVAILABLE || <fixture check>)(`.
        expect((src.match(/\bit\.skipIf\(CHROMIUM_UNAVAILABLE\b/g) || []).length).toBeGreaterThan(0);
      });

      it('never launches when the probe says unavailable, and never swallows a launch failure', () => {
        // Every beforeAll that boots a browser returns early on the probe...
        const launches = (src.match(/chromium\.launch\(/g) || []).length;
        expect(launches).toBeGreaterThan(0);
        expect(src).toContain('if (CHROMIUM_UNAVAILABLE) { return; }');
        // ...and no longer catches the launch into a silent variable.
        expect(src).not.toMatch(/catch \(err\) \{\s*unavailable =/);
      });
    });
  }
});

describe('chromiumAvailability probe helpers', () => {
  it('derives the headless-shell directory Playwright launches by default from the full-Chromium path', () => {
    // https://playwright.dev/docs/browsers#chromium-headless-shell — "Playwright
    // ships a regular Chromium build for headed operations and a separate
    // chromium headless shell for headless mode." Both live beside each other
    // in the browsers cache as chromium-<rev> / chromium_headless_shell-<rev>.
    const exe = '/Users/x/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    expect(expectedHeadlessShellDir(exe)).toBe('/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1208');
  });

  it('returns null for a layout it does not recognise (falls back to the executable check)', () => {
    expect(expectedHeadlessShellDir('/opt/custom/chrome')).toBeNull();
    expect(expectedHeadlessShellDir('')).toBeNull();
  });
});
