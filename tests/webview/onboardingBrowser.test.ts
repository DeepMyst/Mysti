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

const PROVIDERS = (installed: string[], ready: string[]) =>
  ['claude-code', 'openai-codex', 'google-gemini', 'ollama', 'openrouter'].map((id) => ({
    providerId: id, installed: installed.includes(id), authenticated: ready.includes(id),
  }));

async function wizard(pg: Page, over: Record<string, unknown> = {}): Promise<void> {
  await send(pg, { type: 'showWizard', payload: {
    panelId: 'sidebar', providers: PROVIDERS([], []), npmAvailable: true, anyReady: false, mystiReady: false, ...over,
  } });
}

const cardIds = (pg: Page, sel: string) =>
  pg.$$eval(sel, (c) => c.map((x) => x.getAttribute('data-provider')));

describe('wizard step 1', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('puts found CLIs first, suggestions next, the rest behind See all', async () => {
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['openai-codex'], []) });
    expect(await cardIds(pg, '#wizard-found-list .provider-card')).toEqual(['openai-codex']);
    expect(await cardIds(pg, '#wizard-recommended .provider-card')).toEqual(['claude-code', 'google-gemini', 'ollama']);
    expect(await pg.$$eval('#wizard-all .provider-card', (c) => c.length)).toBe(11);
    expect(await pg.isVisible('#wizard-found')).toBe(true);
    expect(errors).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('hides the Found section when nothing is installed', async () => {
    const pg = await panel();
    await wizard(pg);
    expect(await pg.isVisible('#wizard-found')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps Continue disabled until an agent is ready, then enables it on DeepMyst sign-in', async () => {
    const pg = await panel();
    await wizard(pg);
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(true);
    expect(await pg.isVisible('#wizard-mysti-status')).toBe(false);
    await send(pg, { type: 'mystiReadyChanged', payload: { ready: true } });
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(false);
    expect(await pg.isVisible('#wizard-mysti-status')).toBe(true);
    expect(await pg.isVisible('#wizard-signin-btn')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a CLI finishing sign-in enables Continue too', async () => {
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['openai-codex'], []) });
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(true);
    await send(pg, { type: 'wizardStatus', payload: { providers: PROVIDERS(['openai-codex'], ['openai-codex']), npmAvailable: true, anyReady: true } });
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('choosing an agent marks it and leaves the wizard open', async () => {
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['claude-code'], ['claude-code']), anyReady: true });
    await pg.click('#wizard-found-list .provider-card[data-provider="claude-code"] .provider-action-btn');
    expect((await posted(pg)).some((m) => m.type === 'selectProvider')).toBe(true);
    await send(pg, { type: 'wizardComplete', payload: { providerId: 'claude-code' } });
    expect(await pg.isVisible('#setup-wizard')).toBe(true);
    expect(await pg.textContent('#wizard-found-list .provider-action-btn')).toBe('Selected');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('filters the full list and hides empty groups', async () => {
    const pg = await panel();
    await wizard(pg);
    await pg.click('#wizard-all > summary');
    await pg.fill('#wizard-filter', 'offline');
    // Ollama moved up to the suggestions; nothing left in the list says offline.
    expect(await cardIds(pg, '#wizard-all .provider-card:not(.hidden)')).toEqual([]);
    expect(await pg.isVisible('#wizard-filter-empty')).toBe(true);
    await pg.fill('#wizard-filter', 'docker');
    expect(await cardIds(pg, '#wizard-all .provider-card:not(.hidden)')).toEqual(['localai']);
    expect(await pg.$$eval('#wizard-all .wizard-group-label:not(.hidden)', (l) => l.map((x) => x.getAttribute('data-group')))).toEqual(['local']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('showing the wizard twice does not double-bind its buttons', async () => {
    // Get Started can re-show an open wizard; a second binding would make one
    // click start two `npm install -g` runs racing on the same prefix.
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['claude-code'], ['claude-code']), anyReady: true });
    await wizard(pg, { providers: PROVIDERS(['claude-code'], ['claude-code']), anyReady: true, step: 'connect' });
    await pg.click('#wizard-found-list .provider-card[data-provider="claude-code"] .provider-action-btn');
    expect((await posted(pg)).filter((m) => m.type === 'selectProvider')).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Skip for now still dismisses for good', async () => {
    const pg = await panel();
    await wizard(pg);
    await pg.click('.wizard-skip-btn');
    expect(await pg.isVisible('#setup-wizard')).toBe(false);
    expect((await posted(pg)).filter((m) => m.type === 'dismissWizard').pop()!.payload).toEqual({ dontShowAgain: true });
  });
});

describe('wizard steps 2 and 3', () => {
  async function atStep(step: string): Promise<Page> {
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['claude-code'], ['claude-code']), anyReady: true, step });
    return pg;
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('opens on the step Get Started asked for', async () => {
    const pg = await atStep('mode');
    expect(await pg.isVisible('.wizard-step[data-step="mode"]')).toBe(true);
    expect(await pg.isVisible('.wizard-step[data-step="connect"]')).toBe(false);
    expect(await pg.getAttribute('.wizard-stepper li[data-step="mode"]', 'aria-current')).toBe('step');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('mode step starts on the current mode and writes the pill pair', async () => {
    const pg = await atStep('mode');
    expect(await pg.isChecked('input[name="wizard-mode"][value="ask"]')).toBe(true);
    expect(await pg.textContent('#wizard-caps-title')).toBe('On Ask, Mysti');
    await pg.check('input[name="wizard-mode"][value="full"]');
    const upd = (await posted(pg)).filter((m) => m.type === 'updateSettings').pop();
    expect(upd!.payload).toEqual({ mode: 'edit-automatically', accessLevel: 'full-access' });
    expect(await pg.isVisible('#wizard-full-warning')).toBe(true);
    expect(await pg.textContent('#wizard-caps-title')).toBe('On Full, Mysti');
    expect(await pg.$$eval('#wizard-caps .wizard-cap dd', (d) => d.map((x) => x.textContent))).toEqual(
      ['Without asking', 'Without asking', 'Without asking', 'Without asking']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Auto edits in the workspace but asks before commands', async () => {
    const pg = await atStep('mode');
    await pg.check('input[name="wizard-mode"][value="auto"]');
    expect(await pg.$$eval('#wizard-caps .wizard-cap dd', (d) => d.map((x) => x.textContent))).toEqual(
      ['Without asking', 'In this workspace', 'Asks you first', 'Asks you first']);
    expect(await pg.isVisible('#wizard-full-warning')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Back and Continue walk the steps; the last button starts chatting', async () => {
    const pg = await atStep('connect');
    await pg.click('#wizard-next-btn');
    expect(await pg.isVisible('.wizard-step[data-step="mode"]')).toBe(true);
    expect(await pg.isVisible('#wizard-back-btn')).toBe(true);
    await pg.click('#wizard-next-btn');
    expect(await pg.textContent('#wizard-next-btn')).toBe('Start chatting');
    await pg.click('#wizard-back-btn');
    expect(await pg.isVisible('.wizard-step[data-step="mode"]')).toBe(true);
    await pg.click('#wizard-next-btn');
    await pg.click('#wizard-next-btn');
    expect(await pg.isVisible('#setup-wizard')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a starter task closes the wizard and sends the task', async () => {
    const pg = await atStep('task');
    expect(await pg.$$eval('#wizard-tasks .welcome-card', (c) => c.length)).toBe(4);
    await pg.click('#wizard-tasks .welcome-card >> nth=0');
    expect(await pg.isVisible('#setup-wizard')).toBe(false);
    expect((await posted(pg)).some((m) => m.type === 'quickActionWithConfig')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a written task closes the wizard and is sent', async () => {
    const pg = await atStep('task');
    await pg.fill('#wizard-task-input', 'Explain the build');
    await pg.click('#wizard-task-send');
    expect(await pg.isVisible('#setup-wizard')).toBe(false);
    expect((await posted(pg)).some((m) => m.type === 'sendMessage' && m.payload.content === 'Explain the build')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the tour button asks the host to open the walkthrough', async () => {
    const pg = await atStep('task');
    await pg.click('#wizard-tour-btn');
    expect((await posted(pg)).some((m) => m.type === 'openWalkthrough')).toBe(true);
  });
});
