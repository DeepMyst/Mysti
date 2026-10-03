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
 * The agent menu must stay REACHABLE at every panel height.
 *
 * The menu is anchored to its bottom (`bottom: 80px`) and grows upward, so it
 * gets taller with every backend added. At 15 providers plus Mysti and
 * Brainstorm it outgrew a normal sidebar, and because the rule was
 * `overflow: hidden` with no `max-height`, the overflowing rows were CLIPPED —
 * the "Select Agent" header and the Mysti entry were painted above the top of
 * the window with no scrollbar and no way to reach them.
 *
 * A stylesheet substring assertion cannot catch that: `overflow: hidden` and
 * `max-height` are both perfectly valid strings. Only a real box model shows
 * that the first item's top edge landed at a negative y. So this measures, in
 * headless Chromium, against the REAL index.html + chat.css:
 *   1. the menu's top edge is on screen,
 *   2. the first and last items are both inside the scrollable viewport,
 *   3. every item is reachable by scrolling.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Panel heights to straddle. 300 is a deliberately cruel sidebar (a user with a
 * short window or a split editor); 1400 is a maximised tab where the menu fits
 * outright and must NOT gain a pointless scrollbar.
 */
const HEIGHTS = [300, 400, 500, 600, 700, 900, 1400];

let browser: Browser | undefined;
let page: Page | undefined;

async function boot(): Promise<void> {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  page = await browser.newPage();
  let html = fs.readFileSync(path.join(ROOT, 'media/chat/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'media/chat/chat.css'), 'utf8');
  // Inline the stylesheet; drop every script and templated URI so the page is
  // pure layout (chat.js needs an acquireVsCodeApi host that does not exist here).
  html = html
    .replace('<link rel="stylesheet" href="{{chatCssUri}}">', `<style>${css}</style>`)
    .replace('<link rel="stylesheet" href="{{deskCssUri}}">', '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace(/\{\{cspSource\}\}/g, '')
    .replace(/\{\{resourceBase\}\}/g, '.')
    .replace(/\{\{version\}\}/g, '0.0.0');
  await page.setContent(html, { waitUntil: 'load' });
  await page.addStyleTag({ content: '*, *::before, *::after { transition-duration: 0s !important; }' });
}

/** Open the menu at a given panel height and measure its geometry. */
async function measure(height: number) {
  await page!.setViewportSize({ width: 400, height });
  return page!.evaluate(() => {
    const menu = document.getElementById('agent-menu')!;
    menu.classList.remove('hidden');
    const box = menu.getBoundingClientRect();
    const items = Array.from(menu.querySelectorAll('.agent-menu-item'));
    const first = items[0].getBoundingClientRect();
    const last = items[items.length - 1].getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      height: box.height,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      overflowY: getComputedStyle(menu).overflowY,
      itemCount: items.length,
      // Offsets INSIDE the scroll container: what scrolling can reach.
      firstOffsetTop: first.top - box.top + menu.scrollTop,
      lastOffsetBottom: last.bottom - box.top + menu.scrollTop,
      // VIEWPORT coordinates. These are the ones that expose the clipping:
      // when the box overflows upward the whole menu moves off-screen, so the
      // in-container offsets above stay happily positive while the row is
      // painted above the window edge.
      firstViewportTop: first.top,
      headerViewportTop: menu.querySelector('.agent-menu-header')!.getBoundingClientRect().top,
    };
  });
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  await boot();
}, 120_000);
afterAll(async () => { await browser?.close(); });

describe('agent menu layout (real browser)', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('renders every agent that the manifest ships', async () => {
    const m = await measure(900);
    // Mysti + 15 backends + Brainstorm. If a provider is added without this
    // number moving, the static bootstrap markup was missed.
    expect(m.itemCount).toBe(17);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('never places its top edge off the top of the panel', async () => {
    for (const h of HEIGHTS) {
      const m = await measure(h);
      expect(m.top, `menu top is off-screen at panel height ${h}`).toBeGreaterThanOrEqual(0);
    }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps the first agent ON SCREEN — the exact symptom of the clipping bug', async () => {
    for (const h of HEIGHTS) {
      const m = await measure(h);
      // Measured against the VIEWPORT, not the menu box. Under the old
      // `overflow: hidden` with no max-height this went negative: the Mysti row
      // and the "Select Agent" header were painted above the top of the window
      // with no scrollbar, which is exactly what the screenshot showed.
      expect(m.firstViewportTop, `first agent painted off-screen at panel height ${h}`)
        .toBeGreaterThanOrEqual(0);
      expect(m.headerViewportTop, `menu header painted off-screen at panel height ${h}`)
        .toBeGreaterThanOrEqual(0);
      // And it must still sit inside the container, not merely be positioned.
      expect(m.firstOffsetTop).toBeGreaterThanOrEqual(0);
    }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('reaches the last item by scrolling at every height', async () => {
    for (const h of HEIGHTS) {
      const m = await measure(h);
      expect(
        m.lastOffsetBottom,
        `last item unreachable at panel height ${h} (scrollHeight ${m.scrollHeight})`,
      ).toBeLessThanOrEqual(m.scrollHeight + 1);
    }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('scrolls rather than clips when it does not fit', async () => {
    const m = await measure(400);
    expect(m.scrollHeight, 'expected the menu to overflow at 400px').toBeGreaterThan(m.clientHeight);
    expect(m.overflowY, 'an overflowing menu must scroll, not hide').toBe('auto');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('does not scroll when there is room for it', async () => {
    const m = await measure(1400);
    // scrollHeight === clientHeight means no hidden content: a tall window
    // shows the whole list with no scrollbar.
    expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight + 1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps the "Select Agent" header visible while the list scrolls', async () => {
    await page!.setViewportSize({ width: 400, height: 400 });
    const headerTop = await page!.evaluate(() => {
      const menu = document.getElementById('agent-menu')!;
      menu.classList.remove('hidden');
      menu.scrollTop = menu.scrollHeight; // scroll to the bottom
      if (menu.scrollTop === 0) { return -1; } // not scrollable => test is vacuous
      const header = menu.querySelector('.agent-menu-header')!;
      return header.getBoundingClientRect().top - menu.getBoundingClientRect().top;
    });
    // Sticky: pinned to the container's top edge even after scrolling to the
    // bottom. Only meaningful because the container actually overflows at 400px
    // (asserted above), so a non-sticky header would have scrolled away.
    expect(Math.round(headerTop)).toBe(0);
  });
});
