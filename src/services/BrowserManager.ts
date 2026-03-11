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

import type { VisualTestConfig } from '../types';

// Playwright types — using `any` because playwright is an optional runtime dependency
// that is dynamically required (not bundled). TypeScript compilation targets Node, not browser.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Browser = any;
type Page = any;
type BrowserType = any;

interface BrowserSession {
  browser: Browser;
  page: Page;
}

/**
 * Manages Playwright browser lifecycle for visual testing.
 * One browser + page per panel (isolated).
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
      // Dynamic require — Playwright is an optional dependency, not bundled
      this._playwright = require('playwright');
      return this._playwright!;
    } catch {
      throw new Error(
        'Playwright is required for visual testing but is not installed.\n\n' +
        'Install it with:\n' +
        '  npm install playwright\n' +
        '  npx playwright install chromium\n\n' +
        'Playwright is used to capture screenshots and interact with your app.'
      );
    }
  }

  /**
   * Launch a browser and navigate to the test URL.
   */
  async launch(panelId: string, config: VisualTestConfig): Promise<Page> {
    // Close existing session for this panel
    await this.close(panelId);

    const pw = await this.ensurePlaywright();

    const browserType: BrowserType = config.browser === 'firefox'
      ? pw.firefox
      : config.browser === 'webkit'
        ? pw.webkit
        : pw.chromium;

    const browser = await browserType.launch({
      headless: config.headless
    });

    const page = await browser.newPage({
      viewport: {
        width: config.viewportWidth,
        height: config.viewportHeight
      }
    });

    // Navigate to the URL
    await page.goto(config.url, {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Optional: wait for specific selector
    if (config.waitForSelector) {
      await page.waitForSelector(config.waitForSelector, {
        timeout: config.waitForTimeout || 10000
      });
    }

    this._sessions.set(panelId, { browser, page });
    return page;
  }

  /**
   * Get the page for a panel.
   */
  getPage(panelId: string): Page | null {
    return this._sessions.get(panelId)?.page || null;
  }

  /**
   * Navigate to a new URL on the existing page.
   */
  async navigate(panelId: string, url: string): Promise<void> {
    const page = this.getPage(panelId);
    if (!page) { throw new Error(`No browser session for panel ${panelId}`); }
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  }

  /**
   * Reload the current page (useful after code changes + hot reload).
   */
  async reload(panelId: string): Promise<void> {
    const page = this.getPage(panelId);
    if (!page) { return; }
    await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
  }

  /**
   * Close the browser session for a panel.
   */
  async close(panelId: string): Promise<void> {
    const session = this._sessions.get(panelId);
    if (!session) { return; }

    try {
      await session.browser.close();
    } catch {
      // Browser may already be closed
    }
    this._sessions.delete(panelId);
  }

  /**
   * Dispose all browser sessions.
   */
  async dispose(): Promise<void> {
    const closes = Array.from(this._sessions.keys()).map(id => this.close(id));
    await Promise.all(closes);
  }
}
