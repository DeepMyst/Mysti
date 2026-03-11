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

import type { VisualTestInteraction } from '../types';

// Playwright types — using `any` because playwright is an optional runtime dependency
/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

/**
 * Executes browser interactions (click, type, navigate, etc.) via Playwright.
 * Used by VisualTestManager to perform AI-requested browser actions.
 */
export class BrowserInteractionService {

  /**
   * Execute a single browser interaction on the page.
   */
  async execute(page: Page, interaction: VisualTestInteraction): Promise<void> {
    const timeout = 10000;

    switch (interaction.action) {
      case 'click': {
        if (!interaction.target) { throw new Error('Click action requires a target selector'); }
        await page.locator(interaction.target).first().click({ timeout });
        break;
      }
      case 'type': {
        if (!interaction.target) { throw new Error('Type action requires a target selector'); }
        if (!interaction.value) { throw new Error('Type action requires a value'); }
        await page.locator(interaction.target).first().fill(interaction.value, { timeout });
        break;
      }
      case 'navigate': {
        if (!interaction.value) { throw new Error('Navigate action requires a URL value'); }
        await page.goto(interaction.value, { waitUntil: 'networkidle', timeout: 30000 });
        break;
      }
      case 'scroll': {
        const direction = interaction.value || 'down';
        const amount = 500;
        await page.evaluate(`((dir, amt) => {
          if (dir === 'up') window.scrollBy(0, -amt);
          else if (dir === 'down') window.scrollBy(0, amt);
          else if (dir === 'top') window.scrollTo(0, 0);
          else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        })('${direction}', ${amount})`);
        break;
      }
      case 'hover': {
        if (!interaction.target) { throw new Error('Hover action requires a target selector'); }
        await page.locator(interaction.target).first().hover({ timeout });
        break;
      }
      case 'select': {
        if (!interaction.target) { throw new Error('Select action requires a target selector'); }
        if (!interaction.value) { throw new Error('Select action requires a value'); }
        await page.locator(interaction.target).first().selectOption(interaction.value, { timeout });
        break;
      }
      default:
        throw new Error(`Unknown interaction action: ${interaction.action}`);
    }

    // Brief wait for any transitions/animations
    await page.waitForTimeout(500);
  }

  /**
   * Execute multiple interactions sequentially.
   */
  async executeAll(page: Page, interactions: VisualTestInteraction[]): Promise<void> {
    for (const interaction of interactions) {
      await this.execute(page, interaction);
    }
  }

  /**
   * Returns a structured description of available browser actions for the AI prompt.
   */
  getAvailableActions(): string {
    return `Available browser actions (request as JSON array):
- {"action": "click", "target": "CSS selector"} — Click an element
- {"action": "type", "target": "CSS selector", "value": "text to type"} — Fill an input field
- {"action": "navigate", "value": "URL"} — Navigate to a URL
- {"action": "scroll", "value": "up|down|top|bottom"} — Scroll the page
- {"action": "hover", "target": "CSS selector"} — Hover over an element
- {"action": "select", "target": "CSS selector", "value": "option value"} — Select a dropdown option`;
  }
}
