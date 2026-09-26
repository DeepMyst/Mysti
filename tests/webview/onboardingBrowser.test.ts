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
 * Plan 32 — onboarding, driven in a real browser: the three-step wizard, the
 * Getting-started card, the once-only tips and the /help card. Each test gets
 * its own panel page, because tips are once-per-session by design and a
 * shared page would make every later test depend on the order they ran in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';

let browser: Browser | undefined;
const dirs: string[] = [];
const errors: string[] = [];

async function send(pg: Page, m: Record<string, unknown>): Promise<void> {
  await pg.evaluate((msg) => window.dispatchEvent(new MessageEvent('message', { data: msg })), m);
}

async function posted(pg: Page): Promise<Array<Record<string, any>>> {
  return pg.evaluate(() => (window as any).__posted);
}

/** A fresh panel that has received `initialState` (merged with `initial`). */
async function panel(initial: Record<string, unknown> = {}): Promise<Page> {
  const pg = await (await browser!.newContext()).newPage();
  pg.on('pageerror', (e) => errors.push(String(e)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-onb-'));
  dirs.push(dir);
  const file = path.join(dir, 'chat.html');
  fs.writeFileSync(file, composeChatHtml(), 'utf8');
  await pg.goto(`file://${file}`, { waitUntil: 'load' });
  await send(pg, { type: 'initialState', payload: { ...INITIAL_STATE, ...initial } });
  await pg.waitForSelector('#init-loading-overlay.hidden', { state: 'attached' });
  return pg;
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
  for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
});

describe('/help card', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('showHelp renders a searchable card with aliases', async () => {
    const pg = await panel();
    await send(pg, { type: 'showHelp' });
    expect(await pg.$$eval('.help-card .help-row', (r) => r.length)).toBe(13);
    await pg.fill('.help-card .help-search', 'undo');
    expect(await pg.$$eval('.help-card .help-row dt', (r) => r.map((x) => x.textContent))).toEqual(['↺ on a message']);
    await pg.fill('.help-card .help-search', 'zzz');
    expect(await pg.isVisible('.help-card .help-empty')).toBe(true);
    expect(errors).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the tour button asks the host to open the walkthrough', async () => {
    const pg = await panel();
    await send(pg, { type: 'showHelp' });
    await pg.click('.help-card .help-tour');
    expect((await posted(pg)).some((m) => m.type === 'openWalkthrough')).toBe(true);
  });
});
