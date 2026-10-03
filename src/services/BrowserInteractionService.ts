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
import { VISUAL_MAX_TYPE_LENGTH, VISUAL_MAX_SELECTOR_LENGTH } from '../constants';
import { isAllowedOrigin, validatePath, type InteractionPolicy } from './visualTestPolicy';

// Playwright types — using `any` because playwright is an optional runtime dependency
/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

// The `page.evaluate` callback below runs in the BROWSER, not in the extension
// host. This project's tsconfig targets Node and has no `dom` lib, so the few
// browser globals it touches are declared locally; Playwright serialises the
// function and executes it in the page, where they genuinely exist.
declare const window: any;
declare const document: any;

/** The only action names that will ever be executed. */
export const VISUAL_ACTIONS = ['click', 'type', 'navigate', 'scroll', 'hover', 'select'] as const;
export type VisualAction = (typeof VISUAL_ACTIONS)[number];

/** Actions permitted at interaction policy `safe`. `navigate` is same-origin only. */
const SAFE_ACTIONS = new Set<VisualAction>(['click', 'type', 'navigate', 'scroll', 'hover', 'select']);

const SCROLL_DIRECTIONS = ['up', 'down', 'top', 'bottom'] as const;
const SCROLL_AMOUNT_PX = 500;

export interface InteractionContext {
  /** How much this caller may touch the page. */
  policy: InteractionPolicy;
  /** Origins the page may be navigated to. */
  allowedOrigins: string[];
  /** The session's pinned base URL — `navigate` resolves paths against this. */
  baseUrl: string;
}

/**
 * Validate and normalize a raw, model-supplied interaction object.
 *
 * The parse boundary is here so no unvalidated `action` string ever reaches
 * `execute()`. Returns null for anything not on the allowlist — callers report
 * the rejection back to the model rather than silently dropping it.
 */
export function normalizeInteraction(raw: unknown): VisualTestInteraction | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const o = raw as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action.trim().toLowerCase() : '';
  if (!(VISUAL_ACTIONS as readonly string[]).includes(action)) { return null; }

  const target = typeof o.target === 'string' ? o.target.trim().slice(0, VISUAL_MAX_SELECTOR_LENGTH) : undefined;
  const value = typeof o.value === 'string' ? o.value.slice(0, VISUAL_MAX_TYPE_LENGTH) : undefined;

  return {
    action: action as VisualAction,
    target: target || undefined,
    value: value ?? undefined,
    timestamp: Date.now(),
  };
}

/**
 * Executes browser interactions (click, type, navigate, …) via Playwright.
 *
 * Security notes:
 *  - NOTHING caller-supplied is ever concatenated into `page.evaluate` source.
 *    The scroll handler used to build its script by string interpolation, which
 *    let a model's `value` run arbitrary JS in the app's own origin. Playwright
 *    marshals arguments separately; that is the only safe form.
 *  - `navigate` accepts a PATH, resolved against the session's pinned origin and
 *    re-checked against the allowlist. A caller cannot move the browser off-origin.
 */
export class BrowserInteractionService {

  /**
   * Execute a single browser interaction on the page.
   */
  async execute(page: Page, interaction: VisualTestInteraction, ctx?: InteractionContext): Promise<void> {
    const timeout = 10000;
    const policy: InteractionPolicy = ctx?.policy ?? 'full';

    if (policy === 'off') {
      throw new Error('Interactions are disabled for this session.');
    }
    if (policy === 'safe' && !SAFE_ACTIONS.has(interaction.action as VisualAction)) {
      throw new Error(`Action "${interaction.action}" is not permitted at the "safe" interaction level.`);
    }

    switch (interaction.action) {
      case 'click': {
        if (!interaction.target) { throw new Error('Click action requires a target selector'); }
        await page.locator(interaction.target).first().click({ timeout });
        break;
      }
      case 'type': {
        if (!interaction.target) { throw new Error('Type action requires a target selector'); }
        if (interaction.value === undefined || interaction.value === null) { throw new Error('Type action requires a value'); }
        await page.locator(interaction.target).first()
          .fill(String(interaction.value).slice(0, VISUAL_MAX_TYPE_LENGTH), { timeout });
        break;
      }
      case 'navigate': {
        if (!interaction.value) { throw new Error('Navigate action requires a path value'); }
        const url = this._resolveNavigation(interaction.value, ctx);
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        break;
      }
      case 'scroll': {
        // Whitelist the direction, then pass it as an ARGUMENT — never as source.
        const requested = (interaction.value || 'down').trim().toLowerCase();
        const dir = (SCROLL_DIRECTIONS as readonly string[]).includes(requested) ? requested : 'down';
        await page.evaluate(
          ([d, amt]: [string, number]) => {
            if (d === 'up') { window.scrollBy(0, -amt); }
            else if (d === 'down') { window.scrollBy(0, amt); }
            else if (d === 'top') { window.scrollTo(0, 0); }
            else { window.scrollTo(0, document.body.scrollHeight); }
          },
          [dir, SCROLL_AMOUNT_PX]
        );
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
   * Resolve a navigation target to an allowed absolute URL, or throw.
   *
   * Without a context (the legacy human-driven path) an absolute URL is accepted
   * as-is; with one, only a same-origin path is.
   */
  private _resolveNavigation(value: string, ctx?: InteractionContext): string {
    if (!ctx) { return value; }
    const asPath = validatePath(value);
    if (asPath) {
      const resolved = new URL(asPath, ctx.baseUrl).toString();
      if (!isAllowedOrigin(resolved, ctx.allowedOrigins)) {
        throw new Error(`Navigation to "${resolved}" is outside the allowed origins.`);
      }
      return resolved;
    }
    // Not a path — only accept it if it is an explicitly allowed absolute URL.
    if (isAllowedOrigin(value, ctx.allowedOrigins)) { return value; }
    throw new Error(`Navigation target "${value.slice(0, 80)}" is not an app-relative path and is outside the allowed origins.`);
  }

  /**
   * Execute multiple interactions sequentially.
   */
  async executeAll(page: Page, interactions: VisualTestInteraction[], ctx?: InteractionContext): Promise<void> {
    for (const interaction of interactions) {
      await this.execute(page, interaction, ctx);
    }
  }

  /**
   * Returns a structured description of available browser actions for the AI prompt.
   */
  getAvailableActions(): string {
    return `Available browser actions (request as JSON array):
- {"action": "click", "target": "CSS selector"} — Click an element
- {"action": "type", "target": "CSS selector", "value": "text to type"} — Fill an input field
- {"action": "navigate", "value": "/path"} — Go to another page of the app (app-relative path)
- {"action": "scroll", "value": "up|down|top|bottom"} — Scroll the page
- {"action": "hover", "target": "CSS selector"} — Hover over an element
- {"action": "select", "target": "CSS selector", "value": "option value"} — Select a dropdown option`;
  }
}
