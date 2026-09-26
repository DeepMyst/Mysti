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

describe('getting started card', () => {
  const gs = (items: Record<string, boolean>) =>
    ({ onboarding: { tips: { enabled: true, seen: [] }, gettingStarted: { items } } });
  const FRESH = { connect: true, mode: false, task: false, mention: false };

  it.skipIf(CHROMIUM_UNAVAILABLE)('renders in the empty chat with the right count', async () => {
    const pg = await panel(gs(FRESH));
    expect(await pg.textContent('#getting-started .gs-count')).toBe('1 of 4 done');
    expect(await pg.$$eval('#getting-started .gs-item.done', (e) => e.length)).toBe(1);
    expect(await pg.textContent('#getting-started .gs-item.done .gs-item-sub')).toMatch(/ is ready$/);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('is absent when the host says null', async () => {
    const pg = await panel({ onboarding: { tips: { enabled: true, seen: [] }, gettingStarted: null } });
    expect(await pg.$('#getting-started')).toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('comes back on a new empty chat until hidden', async () => {
    const pg = await panel(gs(FRESH));
    await send(pg, { type: 'conversationChanged', payload: { messages: [] } });
    expect(await pg.$('#getting-started')).not.toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Hide removes it, tells the host, and it stays gone on a new chat', async () => {
    const pg = await panel(gs(FRESH));
    await pg.click('#getting-started .gs-hide');
    expect(await pg.$('#getting-started')).toBeNull();
    expect((await posted(pg)).some((m) => m.type === 'hideGettingStarted')).toBe(true);
    await send(pg, { type: 'conversationChanged', payload: { messages: [] } });
    expect(await pg.$('#getting-started')).toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Change opens the mode picker', async () => {
    const pg = await panel(gs(FRESH));
    await pg.click('#getting-started .gs-action[data-action="mode"]');
    expect(await pg.isVisible('#behavior-popup')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Connect asks the host to open the wizard', async () => {
    const pg = await panel(gs({ connect: false, mode: false, task: false, mention: false }));
    await pg.click('#getting-started .gs-action[data-action="connect"]');
    const req = (await posted(pg)).filter((m) => m.type === 'requestOnboarding').pop();
    expect(req!.payload).toEqual({ step: 'connect' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('finishing the wizard lands on the card', async () => {
    const pg = await panel(gs(FRESH));
    await wizard(pg, { providers: PROVIDERS(['claude-code'], ['claude-code']), anyReady: true, step: 'task' });
    await pg.click('#wizard-next-btn');
    expect(await pg.isVisible('#getting-started')).toBe(true);
  });
});

describe('once-only tips', () => {
  const on = (seen: string[] = []) => ({ onboarding: { tips: { enabled: true, seen }, gettingStarted: null } });
  const perm = (id: string) => ({ type: 'permissionRequest', payload: {
    id, toolName: 'Bash', actionType: 'bash-command', expiresAt: 0, details: { command: 'npm test' } } });
  const compacted = { type: 'compactionStatus', payload: { status: 'complete', beforeTokens: 142000, afterTokens: 18000 } };

  it.skipIf(CHROMIUM_UNAVAILABLE)('the first permission card gets a tip, marked seen on show, and never a second', async () => {
    const pg = await panel(on());
    await send(pg, perm('p1'));
    expect(await pg.$$eval('.mysti-tip[data-tip="permission"]', (e) => e.length)).toBe(1);
    expect(await pg.textContent('.mysti-tip[data-tip="permission"]')).toContain('you’re on Ask');
    expect((await posted(pg)).filter((m) => m.type === 'tipSeen').map((m) => m.payload)).toEqual([{ id: 'permission' }]);
    await send(pg, perm('p2'));
    expect(await pg.$$eval('.mysti-tip', (e) => e.length)).toBe(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a tip already seen, or tips turned off, shows nothing', async () => {
    const seen = await panel(on(['permission']));
    await send(seen, perm('p1'));
    expect(await seen.$('.mysti-tip')).toBeNull();
    const off = await panel({ onboarding: { tips: { enabled: false, seen: [] }, gettingStarted: null } });
    await send(off, perm('p1'));
    expect(await off.$('.mysti-tip')).toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('no tips before the host has said anything about them', async () => {
    const pg = await panel();
    await send(pg, perm('p1'));
    expect(await pg.$('.mysti-tip')).toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('only one tip per session', async () => {
    const pg = await panel(on());
    await send(pg, perm('p1'));
    await send(pg, compacted);
    expect(await pg.$('.mysti-tip[data-tip="compaction"]')).toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the compaction tip offers a new chat; Turn off tips removes it and tells the host', async () => {
    const pg = await panel(on());
    await send(pg, compacted);
    expect(await pg.isVisible('.mysti-tip[data-tip="compaction"] .mysti-tip-extra')).toBe(true);
    await pg.click('.mysti-tip .mysti-tip-off');
    expect(await pg.$('.mysti-tip')).toBeNull();
    expect((await posted(pg)).some((m) => m.type === 'tipsOff')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Got it just closes the tip', async () => {
    const pg = await panel(on());
    await send(pg, compacted);
    await pg.click('.mysti-tip .mysti-tip-ok');
    expect(await pg.$('.mysti-tip')).toBeNull();
    expect((await posted(pg)).some((m) => m.type === 'tipsOff')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the mention menu carries its tip and drops it on close', async () => {
    const pg = await panel(on());
    await send(pg, { type: 'workspaceFiles', payload: ['/w/src/config.ts'] });
    await pg.click('#message-input');
    await pg.keyboard.type('@c');
    expect(await pg.$('#mention-menu .mysti-tip[data-tip="mention"]')).not.toBeNull();
    await pg.keyboard.press('Escape');
    expect(await pg.$('#mention-menu .mysti-tip')).toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('switching to Brainstorm offers the strategy inline', async () => {
    const pg = await panel(on());
    await send(pg, { type: 'agentChanged', payload: { agent: 'brainstorm' } });
    expect(await pg.isChecked('.bs-strategies input[value="quick"]')).toBe(true);
    await pg.check('.bs-strategies input[value="debate"]');
    const upd = (await posted(pg)).filter((m) => m.type === 'updateSettings').pop();
    expect(upd!.payload).toEqual({ 'brainstorm.strategy': 'debate' });
  });
});

describe('rewind tip', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('follows the first turn that edited a file, once', async () => {
    const pg = await panel({ onboarding: { tips: { enabled: true, seen: [] }, gettingStarted: null } });
    async function editTurn(n: number) {
      await send(pg, { type: 'responseStarted', payload: {} });
      await send(pg, { type: 'responseChunk', payload: { type: 'text', content: 'Renaming.' } });
      await send(pg, { type: 'toolUse', payload: { id: `t${n}`, name: 'Edit', status: 'running',
        input: { file_path: '/w/src/config.ts', old_string: 'loadConfig', new_string: 'loadSettings' } } });
      await send(pg, { type: 'toolResult', payload: { id: `t${n}`, status: 'completed', output: 'ok' } });
      await send(pg, { type: 'responseComplete', payload: { message: { id: `m${n}`, role: 'assistant', content: 'Renamed.', timestamp: Date.now() } } });
    }
    await editTurn(1);
    expect(await pg.$$eval('.edit-report-card', (e) => e.length)).toBeGreaterThan(0);
    expect(await pg.$$eval('.mysti-tip[data-tip="rewind"]', (e) => e.length)).toBe(1);
    await editTurn(2);
    expect(await pg.$$eval('.mysti-tip[data-tip="rewind"]', (e) => e.length)).toBe(1);
  });
});

describe('composer and Brainstorm copy', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('the composer teaches @ and /', async () => {
    const pg = await panel();
    expect(await pg.getAttribute('#message-input', 'placeholder')).toBe('Ask anything — @ to mention an agent or file, / for commands');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Brainstorm strategies are described in plain words', async () => {
    const pg = await panel({ onboarding: { tips: { enabled: true, seen: [] }, gettingStarted: null } });
    await send(pg, { type: 'agentChanged', payload: { agent: 'brainstorm' } });
    const text = await pg.textContent('.bs-strategies');
    expect(text).toContain('Both answer, then one merged reply. Fastest.');
    expect(text).not.toMatch(/Facilitator-mediated|iterative convergence/);
    expect(await pg.textContent('#brainstorm-strategy-hint')).toBe('Both answer, then one merged reply. Fastest.');
  });
});

describe('final-review fixes', () => {
  const ON = { onboarding: { tips: { enabled: true, seen: [] }, gettingStarted: null } };

  it.skipIf(CHROMIUM_UNAVAILABLE)('a host mode change reaches the next turn and stands unattended down', async () => {
    const pg = await panel({ autonomyLevel: 'semi-autonomous', settings: {
      provider: 'claude-code', model: '', mode: 'edit-automatically', thinkingLevel: 'none', effortLevel: 'high',
      accessLevel: 'full-access', contextMode: 'auto', autonomousMode: false } });
    await send(pg, { type: 'modeChanged', payload: { mode: 'quick-plan', accessLevel: 'read-only' } });
    expect((await posted(pg)).filter((m) => m.type === 'autonomyLevelChanged').pop()!.payload).toEqual({ level: 'manual' });
    await pg.fill('#message-input', 'hello');
    await pg.click('#send-btn');
    const sent = (await posted(pg)).filter((m) => m.type === 'sendMessage').pop();
    expect(sent!.payload.settings).toMatchObject({ mode: 'quick-plan', accessLevel: 'read-only' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an installed but signed-out CLI does not enable Continue', async () => {
    const pg = await panel();
    // What the host really sends: anyReady counts INSTALLED CLIs.
    await wizard(pg, { providers: PROVIDERS(['openai-codex'], []), anyReady: true });
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('finishing sign-in inside the wizard enables Continue and asks for fresh status', async () => {
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['openai-codex'], []), anyReady: true });
    await send(pg, { type: 'providerSetupStep', payload: { providerId: 'openai-codex', step: 'complete', progress: 100 } });
    expect(await pg.isDisabled('#wizard-next-btn')).toBe(false);
    await send(pg, { type: 'setupComplete', payload: { providerId: 'openai-codex' } });
    expect((await posted(pg)).some((m) => m.type === 'requestWizardStatus')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Continue switches to a ready agent when the chat is on one that is not', async () => {
    const pg = await panel({ settings: { ...(INITIAL_STATE.settings as object), provider: 'mysti' } });
    await wizard(pg, { providers: PROVIDERS(['openai-codex'], ['openai-codex']), anyReady: true, mystiReady: false });
    await pg.click('#wizard-next-btn');
    expect((await posted(pg)).filter((m) => m.type === 'selectProvider').pop()!.payload).toEqual({ providerId: 'openai-codex' });
    expect(await pg.isVisible('.wizard-step[data-step="mode"]')).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Continue leaves a ready chat agent alone', async () => {
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['claude-code', 'openai-codex'], ['claude-code', 'openai-codex']), anyReady: true });
    await pg.click('#wizard-next-btn');
    expect((await posted(pg)).some((m) => m.type === 'selectProvider')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a second initialState replaces the conversation instead of appending it', async () => {
    const conversation = { id: 'c1', messages: [
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', timestamp: 2 },
    ] };
    const pg = await panel({ conversation });
    const before = await pg.$$eval('#messages .message', (m) => m.length);
    await send(pg, { type: 'initialState', payload: { ...INITIAL_STATE, conversation } });
    expect(await pg.$$eval('#messages .message', (m) => m.length)).toBe(before);
    expect(before).toBeGreaterThan(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the card after the wizard reflects what the wizard just did', async () => {
    const pg = await panel({ onboarding: { tips: { enabled: true, seen: [] },
      gettingStarted: { items: { connect: false, mode: false, task: false, mention: false } } } });
    await wizard(pg, { providers: PROVIDERS([], []), anyReady: false, mystiReady: false });
    await send(pg, { type: 'mystiReadyChanged', payload: { ready: true } });
    await pg.click('#wizard-next-btn');
    await pg.click('#wizard-next-btn'); // accept the mode shown
    expect((await posted(pg)).filter((m) => m.type === 'updateSettings').pop()!.payload)
      .toEqual({ mode: 'ask-before-edit', accessLevel: 'ask-permission' });
    await pg.click('#wizard-next-btn');
    expect(await pg.textContent('#getting-started .gs-count')).toBe('2 of 4 done');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape inside a wizard field does not dismiss the wizard', async () => {
    const pg = await panel();
    await wizard(pg);
    await pg.click('#wizard-all > summary');
    await pg.click('#wizard-filter');
    await pg.keyboard.press('Escape');
    expect(await pg.isVisible('#setup-wizard')).toBe(true);
    expect((await posted(pg)).some((m) => m.type === 'dismissWizard')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the permission tip does not blame the mode for a card that always asks', async () => {
    const pg = await panel(ON);
    await send(pg, { type: 'permissionRequest', payload: {
      id: 'f1', toolName: 'mcp', actionType: 'web-request', expiresAt: 0, forceInteractive: true, details: {} } });
    const text = await pg.textContent('.mysti-tip[data-tip="permission"]');
    expect(text).not.toContain('because you’re on');
    expect(text).toContain('always asks');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Start chatting puts the keyboard in the composer', async () => {
    const pg = await panel();
    await wizard(pg, { providers: PROVIDERS(['claude-code'], ['claude-code']), anyReady: true, step: 'task' });
    await pg.click('#wizard-next-btn');
    expect(await pg.evaluate(() => document.activeElement && document.activeElement.id)).toBe('message-input');
  });
});
