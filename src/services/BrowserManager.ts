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
import { assertVisualOperation, awaitVisualOperation, awaitVisualCleanup, VisualOperationCancelled, type VisualOperationControl } from './VisualOperation';

// Playwright types — using `any` because playwright is an optional runtime dependency
// that is dynamically required (not bundled). TypeScript compilation targets Node, not browser.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Browser = any;
type Page = any;
type BrowserType = any;

interface BrowserSession {
  key: string;
  browser: Browser;
  context: any;
  page: Page;
  allowedOrigins: string[];
  closing?: Promise<void>;
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
  /** Exact handles awaiting confirmed cleanup, never eligible for warm reuse. */
  private _pendingCleanup = new Set<BrowserSession>();
  private _pendingLaunches = new Set<{ key: string }>();

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
  async launch(panelId: string, config: VisualTestConfig, allowedOrigins: string[] = VISUAL_DEFAULT_ALLOWED_ORIGINS, control?: VisualOperationControl): Promise<Page> {
    assertVisualOperation(control);
    // Close existing session for this panel
    const previous = this._sessions.get(panelId);
    if (previous) { await this._closeCaptured(panelId, previous); }
    assertVisualOperation(control);

    if (!isAllowedOrigin(config.url, allowedOrigins)) {
      throw new Error(`Refusing to open "${config.url}" — it is outside the allowed origins (${allowedOrigins.join(', ')}).`);
    }

    const pw = await awaitVisualOperation(control, () => this.ensurePlaywright());

    const browserType: BrowserType = config.browser === 'firefox'
      ? pw.firefox
      : config.browser === 'webkit'
        ? pw.webkit
        : pw.chromium;

    const pendingLaunch = { key: panelId };
    let browser: Browser;
    try {
      browser = await awaitVisualOperation(control, () => {
        this._pendingLaunches.add(pendingLaunch);
        return Promise.resolve().then(() => { assertVisualOperation(control); return browserType.launch({ headless: config.headless }) as Promise<Browser>; })
          .catch(error => { this._pendingLaunches.delete(pendingLaunch); throw error; });
      }, late => {
        this._pendingLaunches.delete(pendingLaunch);
        return this._closeCaptured(panelId, { key: panelId, browser: late, context: null, page: null, allowedOrigins });
      });
    } catch (error) {
      // Playwright does not expose a cancellation handle before launch returns.
      // The observed late-result disposer remains responsible for that handle.
      if (this._pendingLaunches.has(pendingLaunch) && error instanceof VisualOperationCancelled) {
        throw new VisualOperationCancelled(true);
      }
      throw error;
    }
    this._pendingLaunches.delete(pendingLaunch);

    // Registered BEFORE any further await, so every later failure is cleanable.
    const session: BrowserSession = { key: panelId, browser, context: null, page: null, allowedOrigins };
    this._sessions.set(panelId, session);

    const closeOwned = () => this._closeCaptured(panelId, session);
    let abortCleanup: Promise<void> | undefined;
    const abort = () => { abortCleanup ??= closeOwned(); void abortCleanup.catch(() => {}); };
    control?.signal.addEventListener('abort', abort, { once: true });
    try {
      assertVisualOperation(control);
      const context = await awaitVisualOperation<any>(control, () => browser.newContext({
        viewport: { width: config.viewportWidth, height: config.viewportHeight },
        acceptDownloads: false,
      }));
      session.context = context;

      // The last line of origin defence: a redirect chain, a `<meta refresh>` or
      // an in-page `location =` cannot leave the allowlist, because every single
      // request is checked here rather than only the URLs we hand to `goto`.
      await awaitVisualOperation(control, () => context.route('**/*', (route: any) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
          return route.continue();
        }
        if (isAllowedOrigin(url, allowedOrigins)) { return route.continue(); }
        return route.abort('blockedbyclient');
      }));

      const page = await awaitVisualOperation<any>(control, () => context.newPage());
      session.page = page;
      // A popup would escape both the viewport and our observation plumbing.
      page.on('popup', (p: any) => { void p.close().catch(() => { /* already gone */ }); });

      await awaitVisualOperation(control, () => this._goto(page, config.url));

      if (config.waitForSelector) {
        await awaitVisualOperation(control, () => page.waitForSelector(config.waitForSelector, {
          timeout: config.waitForTimeout || 10000
        }));
      }

      assertVisualOperation(control);
      return page;
    } catch (err) {
      // Close only the exact browser this call launched, never a successor.
      try { await (abortCleanup ?? closeOwned()); }
      catch (cleanupError) {
        if (control?.signal.aborted || err instanceof VisualOperationCancelled) { throw new VisualOperationCancelled(true); }
        throw cleanupError;
      }
      throw err;
    } finally {
      control?.signal.removeEventListener('abort', abort);
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
    const sessions = new Set([...this._pendingCleanup].filter(session => session.key === panelId));
    const active = this._sessions.get(panelId);
    if (active) { sessions.add(active); }
    await Promise.all([...sessions].map(session => this._closeCaptured(panelId, session)));
    if ([...this._pendingLaunches].some(launch => launch.key === panelId)) {
      throw new Error('Visual browser cleanup incomplete: an owned launch has not returned its browser handle.');
    }
  }

  private _closeCaptured(panelId: string, session: BrowserSession): Promise<void> {
    if (session.closing) { return session.closing; }
    if (this._sessions.get(panelId) === session) { this._sessions.delete(panelId); }
    this._pendingCleanup.add(session);
    const attempt = awaitVisualCleanup(Promise.resolve().then(() => session.browser.close()), 'Visual browser');
    session.closing = attempt.then(() => {
      this._pendingCleanup.delete(session);
    }, error => {
      // Retain the actual browser, not its reusable logical key. A later retry
      // must never look up and close a replacement browser under that key.
      session.closing = undefined;
      throw error;
    });
    return session.closing;
  }

  /** Dispose active and previously failed exact browser handles. */
  async dispose(): Promise<void> {
    const sessions = new Set([...this._sessions.values(), ...this._pendingCleanup]);
    await Promise.all([...sessions].map(session => this._closeCaptured(session.key, session)));
    if (this._pendingLaunches.size) {
      throw new Error('Visual browser cleanup incomplete: an owned launch has not returned its browser handle.');
    }
  }
}
