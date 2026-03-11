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
import * as path from 'path';
import { VISUAL_TEST_SCREENSHOT_WAIT_MS } from '../constants';
import type { VisualTestScreenshot, VisualTestConfig } from '../types';

// Playwright types — using `any` because playwright is an optional runtime dependency
/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

export interface ScreenshotOptions {
  mode: VisualTestConfig['screenshotMode'];
  elementSelector?: string;
  iteration: number;
  label: string;
  outputDir: string;
}

/**
 * Captures screenshots and DOM snapshots from Playwright pages.
 */
export class ScreenshotService {
  private _counter = 0;

  /**
   * Capture a screenshot of the current page state.
   */
  async capture(page: Page, options: ScreenshotOptions): Promise<VisualTestScreenshot> {
    // Wait for page to settle
    await page.waitForTimeout(VISUAL_TEST_SCREENSHOT_WAIT_MS);

    // Ensure output directory exists
    fs.mkdirSync(options.outputDir, { recursive: true });

    const id = `screenshot-${++this._counter}-${Date.now()}`;
    const fileName = `${options.label.replace(/[^a-z0-9]/gi, '-')}-iter${options.iteration}-${this._counter}.png`;
    const filePath = path.join(options.outputDir, fileName);

    let screenshotBuffer: Buffer;

    if (options.mode === 'element' && options.elementSelector) {
      const element = await page.$(options.elementSelector);
      if (!element) {
        throw new Error(`Element not found: ${options.elementSelector}`);
      }
      screenshotBuffer = await element.screenshot({ type: 'png' });
    } else if (options.mode === 'full-page') {
      screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
    } else {
      // viewport mode (default)
      screenshotBuffer = await page.screenshot({ fullPage: false, type: 'png' });
    }

    fs.writeFileSync(filePath, screenshotBuffer);
    const base64Data = screenshotBuffer.toString('base64');

    return {
      id,
      iteration: options.iteration,
      timestamp: Date.now(),
      filePath,
      base64Data,
      label: options.label,
      url: page.url()
    };
  }

  /**
   * Capture before and after screenshots around an action.
   */
  async captureBeforeAfter(
    page: Page,
    action: () => Promise<void>,
    options: ScreenshotOptions
  ): Promise<{ before: VisualTestScreenshot; after: VisualTestScreenshot }> {
    const before = await this.capture(page, { ...options, label: `${options.label}-before` });
    await action();
    const after = await this.capture(page, { ...options, label: `${options.label}-after` });
    return { before, after };
  }

  /**
   * Get a simplified DOM snapshot for AI context.
   * Extracts tag names, classes, text content, and key attributes.
   * Capped at ~4000 tokens to fit in prompt.
   */
  async getDomSnapshot(page: Page): Promise<string> {
    // This function is serialized and executed in the browser context via Playwright.
    // We pass it as a string to avoid TypeScript DOM type issues (node target has no DOM lib).
    const snapshot: string = await page.evaluate(`(() => {
      var MAX_DEPTH = 6, MAX_TEXT_LENGTH = 80, MAX_NODES = 200, nodeCount = 0;
      function simplify(el, depth) {
        if (nodeCount >= MAX_NODES || depth > MAX_DEPTH) return '';
        nodeCount++;
        var tag = el.tagName.toLowerCase();
        var indent = '  '.repeat(depth);
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return '';
        if (['script','style','noscript','link','meta'].indexOf(tag) >= 0) return '';
        var attrs = [];
        if (el.id) attrs.push('id="' + el.id + '"');
        if (el.className && typeof el.className === 'string') {
          var cls = el.className.trim().split(/\\s+/).slice(0,3).join(' ');
          if (cls) attrs.push('class="' + cls + '"');
        }
        if (el.href) attrs.push('href="' + el.href + '"');
        if (el.type) attrs.push('type="' + el.type + '"');
        if (el.placeholder) attrs.push('placeholder="' + el.placeholder + '"');
        var role = el.getAttribute('role');
        if (role) attrs.push('role="' + role + '"');
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) attrs.push('aria-label="' + ariaLabel + '"');
        var attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
        var textParts = [];
        for (var i = 0; i < el.childNodes.length; i++) {
          var n = el.childNodes[i];
          if (n.nodeType === 3 && n.textContent && n.textContent.trim()) {
            textParts.push(n.textContent.trim().slice(0, MAX_TEXT_LENGTH));
          }
        }
        var text = textParts.join(' ').trim();
        var childParts = [];
        for (var j = 0; j < el.children.length; j++) {
          var c = simplify(el.children[j], depth + 1);
          if (c) childParts.push(c);
        }
        var children = childParts.join('\\n');
        if (!children && !text) return indent + '<' + tag + attrStr + ' />';
        if (!children) return indent + '<' + tag + attrStr + '>' + text + '</' + tag + '>';
        return indent + '<' + tag + attrStr + '>' + (text ? ' ' + text : '') + '\\n' + children + '\\n' + indent + '</' + tag + '>';
      }
      return simplify(document.body, 0);
    })()`);

    // Cap at ~4000 tokens (~16000 chars)
    if (snapshot.length > 16000) {
      return snapshot.slice(0, 16000) + '\n... (truncated)';
    }
    return snapshot;
  }
}
