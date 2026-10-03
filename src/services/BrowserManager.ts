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

import * as fs from 'fs';
import type { VisualTestConfig } from '../types';
import { VISUAL_SETTLE_TIMEOUT_MS, VISUAL_DEFAULT_ALLOWED_ORIGINS } from '../constants';
import { isAllowedOrigin } from './visualTestPolicy';

// Playwright types — using `any` because playwright is an optional runtime dependency
// that is dynamically required (not bundled). TypeScript compilation targets Node, not browser.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Browser = any;
type Page = any;
type BrowserType = any;

interface BrowserSession {
  browser: Browser;
  context: any;
  page: Page;
  allowedOrigins: string[];
}

/** What `probe()` found — the two failure modes are very different for the user. */
export interface PlaywrightProbe {
  /** The `playwright` node module resolves. */
  module: boolean;
  /** A browser binary for the requested engine exists on disk. */
  browser: boolean;
  /** User-actionable message when something is missing. */
  hint?: string;
}

/**
 * Manages Playwright browser lifecycle for visual testing.
 * One browser + page per session (isolated).
 */
export class BrowserManager {
  private _sessions: Map<string, BrowserSession> = new Map();
  private _playwright: any = null;

  /**
   * Dynamically require Playwright. Throws a user-friendly error if not installed.
   */
  async ensurePlaywright(): Promise<any> {
    if (this._playwright) { return this._playwright; }

    try {
      // Dynamic require — Playwright is a webpack external, resolved at runtime
      // from node_modules (which `.vscodeignore` explicitly un-ignores for the
      // playwright packages so a packaged VSIX can still find it).
      this._playwright = require('playwright');
      return this._playwright!;
    } catch {
      throw new Error(
        'The Playwright module could not be loaded, so Mysti cannot open a browser. ' +
        'This is an installation problem with the extension itself — please reinstall Mysti.'
      );
    }
  }

  /**
   * Check whether visual testing can actually run, WITHOUT launching anything.
   *
   * Callers probe before spawning a dev server, so a missing browser binary never
   * leaves a server running behind a failure. The module and the browser binaries
   * are separate installs — the binaries are hundreds of MB and are not shipped.
   */
  async probe(browser: VisualTestConfig['browser'] = 'chromium'): Promise<PlaywrightProbe> {
    let pw: any;
    try {
      pw = await this.ensurePlaywright();
    } catch {
      return { module: false, browser: false, hint: 'The Playwright module is missing from the extension install. Reinstall Mysti.' };
    }
    try {
      const type: BrowserType = pw[browser] ?? pw.chromium;
      const exe = type.executablePath();
      if (exe && fs.existsSync(exe)) { return { module: true, browser: true }; }
      return {
        module: true,
        browser: false,
        hint: `The ${browser} browser is not installed. Run: npx playwright install ${browser}`,
      };
    } catch {
      return {
        module: true,
        browser: false,
        hint: `The ${browser} browser is not installed. Run: npx playwright install ${browser}`,
      };
    }
  }

  /**
   * Launch a browser and navigate to the test URL.
   *
   * The session is registered as soon as the browser exists, and anything that
   * throws afterwards closes it — otherwise a failed `goto` orphans a live
   * Chromium with no handle to kill it, which a warm session makes routine.
   */
  async launch(panelId: string, config: VisualTestConfig, allowedOrigins: string[] = VISUAL_DEFAULT_ALLOWED_ORIGINS): Promise<Page> {
    // Close existing session for this panel
    await this.close(panelId);

    if (!isAllowedOrigin(config.url, allowedOrigins)) {
      throw new Error(`Refusing to open "${config.url}" — it is outside the allowed origins (${allowedOrigins.join(', ')}).`);
    }

    const pw = await this.ensurePlaywright();

    const browserType: BrowserType = config.browser === 'firefox'
      ? pw.firefox
      : config.browser === 'webkit'
        ? pw.webkit
        : pw.chromium;

    const browser = await browserType.launch({ headless: config.headless });

    // Registered BEFORE any further await, so every later failure is cleanable.
    const session: BrowserSession = { browser, context: null, page: null, allowedOrigins };
    this._sessions.set(panelId, session);

    try {
      const context = await browser.newContext({
        viewport: { width: config.viewportWidth, height: config.viewportHeight },
        acceptDownloads: false,
      });
      session.context = context;

      // The last line of origin defence: a redirect chain, a `<meta refresh>` or
      // an in-page `location =` cannot leave the allowlist, because every single
      // request is checked here rather than only the URLs we hand to `goto`.
      await context.route('**/*', (route: any) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
          return route.continue();
        }
        if (isAllowedOrigin(url, allowedOrigins)) { return route.continue(); }
        return route.abort('blockedbyclient');
      });

      const page = await context.newPage();
      session.page = page;
      // A popup would escape both the viewport and our observation plumbing.
      page.on('popup', (p: any) => { void p.close().catch(() => { /* already gone */ }); });

      await this._goto(page, config.url);

      if (config.waitForSelector) {
        await page.waitForSelector(config.waitForSelector, {
          timeout: config.waitForTimeout || 10000
        });
      }

      return page;
    } catch (err) {
      // Never leave a browser we launched running.
      await this.close(panelId);
      throw err;
    }
  }

  /**
   * Navigate + settle.
   *
   * `waitUntil: 'networkidle'` is deliberately NOT used: Vite and Next hold an
   * HMR socket open forever, so networkidle never fires against exactly the dev
   * servers this feature exists to test. We wait for `load`, then give the network
   * a BOUNDED chance to go quiet and move on regardless.
   */
  private async _goto(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: VISUAL_SETTLE_TIMEOUT_MS }).catch(() => { /* HMR keeps a socket open; proceed */ });
  }

  /**
   * Get the page for a panel.
   */
  getPage(panelId: string): Page | null {
    return this._sessions.get(panelId)?.page || null;
  }

  /** The origins this session's browser is allowed to reach. */
  getAllowedOrigins(panelId: string): string[] {
    return this._sessions.get(panelId)?.allowedOrigins || VISUAL_DEFAULT_ALLOWED_ORIGINS;
  }

  /**
   * Navigate to a new URL on the existing page. Re-checks the allowlist even
   * though `context.route` would also block it — a refusal we can explain beats
   * a blank page the caller has to diagnose.
   */
  async navigate(panelId: string, url: string): Promise<void> {
    const session = this._sessions.get(panelId);
    if (!session?.page) { throw new Error(`No browser session for panel ${panelId}`); }
    if (!isAllowedOrigin(url, session.allowedOrigins)) {
      throw new Error(`Refusing to navigate to "${url}" — it is outside the allowed origins.`);
    }
    await this._goto(session.page, url);
  }

  /**
   * Reload the current page (used after code changes so the verify half of the
   * loop compares against the rebuilt app, not the render captured minutes ago).
   */
  async reload(panelId: string): Promise<void> {
    const page = this.getPage(panelId);
    if (!page) { return; }
    await page.reload({ waitUntil: 'load', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: VISUAL_SETTLE_TIMEOUT_MS }).catch(() => { /* HMR */ });
  }

  /** True when a live session exists for this panel. */
  isOpen(panelId: string): boolean {
    return !!this._sessions.get(panelId)?.page;
  }

  /**
   * Close the browser session for a panel.
   */
  async close(panelId: string): Promise<void> {
    const session = this._sessions.get(panelId);
    if (!session) { return; }
    // Delete first: a concurrent close must not double-close, and a throw below
    // must not leave a dead session in the map forever.
    this._sessions.delete(panelId);

    try {
      await session.browser.close();
    } catch {
      // Browser may already be closed
    }
  }

  /**
   * Dispose all browser sessions.
   */
  async dispose(): Promise<void> {
    const closes = Array.from(this._sessions.keys()).map(id => this.close(id));
    await Promise.all(closes);
  }
}
