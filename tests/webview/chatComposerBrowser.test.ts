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
 * Plan 28 Phases 1-2, measured in a real browser.
 *
 * Every other test of these phases reads `chat.js` as TEXT. That catches drift
 * between the webview's hand-copy of the trust ladder and the TS module, but it
 * cannot catch the class of defect these phases actually risk: Phase 1 DELETED
 * three elements (`mode-select`, `access-select`, `autonomy-select`) whose
 * listeners were bound UNGUARDED. Shipping that without removing the listeners
 * would have thrown at load and bricked the panel — and no string assertion
 * would have noticed.
 *
 * So this boots the real `media/chat/index.html` + `chat.css` + `chat.js` in
 * Chromium with the same boot contract the extension provides
 * (`window.__MYSTI_BOOT__`, a stubbed `acquireVsCodeApi`), and drives it. The
 * FIRST test is that the asset loads with no uncaught exception; the rest
 * exercise the two phases through real clicks and keystrokes.
 *
 * This is not a substitute for the F5 pass — nothing here proves the extension
 * host wiring. It is the part of that gate a machine can hold.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../..');
let browser: Browser | undefined;
let page: Page | undefined;
let tmpDir: string | undefined;
/** Uncaught page errors seen during boot and every test after it. */
const pageErrors: string[] = [];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/*
 * NOTE FOR ANYONE EDITING THE HARNESS: every `.replace()` that injects file
 * content below passes a FUNCTION, never a string. `String.prototype.replace`
 * treats `$&`, `$'`, '$`' and `$n` in a STRING replacement as substitution
 * patterns, and minified libraries are full of `$`. The first version of this
 * file used strings: `$'` spliced the remainder of the document back in, so the
 * page rendered three times over and all three vendor libraries arrived as
 * SyntaxErrors. A replacer function has no such semantics.
 */

/** The same payload `webviewContent.ts` emits, with the URIs stubbed. */
function bootPayload(): Record<string, unknown> {
  const logo = ['claude', 'openaiLight', 'openaiDark', 'gemini', 'cline', 'copilot', 'cursor',
    'openclaw', 'opencode', 'ollama', 'localai', 'qwen', 'hermes', 'continue', 'openrouter', 'kimi'];
  const boot: Record<string, unknown> = {
    mermaidUri: '', logoUri: '', version: '0.0.0-test', iconUris: {}, manifestSchemaVersion: 1,
  };
  for (const k of logo) { boot[`${k}LogoUri`] = ''; }
  boot.openaiLogoLightUri = '';
  boot.openaiLogoDarkUri = '';
  return boot;
}

async function boot(): Promise<void> {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  let html = read('media/chat/index.html');
  // CSP is another suite's subject; strip it so inline injection is not the
  // thing under test here.
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '');
  html = html
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace(/\{\{cspSource\}\}/g, "'self'")
    .replace(/\{\{resourceBase\}\}/g, '')
    .replace(/\{\{version\}\}/g, '0.0.0-test')
    .replace('<link rel="stylesheet" href="{{chatCssUri}}">', () => `<style>${read('media/chat/chat.css')}</style>`)
    .replace('<link rel="stylesheet" href="{{deskCssUri}}">', () => `<style>${read('media/chat/desk.css')}</style>`)
    .replace('{{bootJson}}', () => JSON.stringify(bootPayload()))
    // Determinism: the panel has pulsing dots and fade/slide transitions, and
    // Playwright waits for an element's box to be STABLE before acting on it.
    // With the animations live, opening the pill took twelve seconds. Nothing
    // under test here is an animation.
    .replace('</head>', () => '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>');

  // Vendor libraries chat.js expects on the global object — the REAL files, so
  // markdown rendering behaves as it does in the panel.
  for (const [tag, file] of [
    ['<script nonce="n" src="/dompurify.min.js"></script>', 'resources/dompurify.min.js'],
    ['<script nonce="n" src="/marked.min.js"></script>', 'resources/marked.min.js'],
    ['<script nonce="n" src="/prism-bundle.js"></script>', 'resources/prism-bundle.js'],
  ] as const) {
    html = html.replace(tag, () => `<script>${read(file)}</script>`);
  }

  // The host API, stubbed. Everything the webview posts is captured so a test
  // can assert on what the extension WOULD have been told.
  const stub = `<script>
    window.__posted = [];
    window.acquireVsCodeApi = function () {
      return {
        postMessage: function (m) { window.__posted.push(m); },
        getState: function () { return undefined; },
        setState: function () {}
      };
    };
  </script>`;
  const bootTag = '<script nonce="n">window.__MYSTI_BOOT__';
  if (!html.includes(bootTag)) { throw new Error('boot script tag not found — harness is out of date with index.html'); }
  html = html.replace(bootTag, () => `${stub}${bootTag}`);
  html = html
    .replace('<script nonce="n" src="{{chatJsUri}}"></script>', () => `<script>${read('media/chat/chat.js')}</script>`)
    .replace('<script nonce="n" src="{{deskJsUri}}"></script>', () => `<script>${read('media/chat/desk.js')}</script>`);

  // NOT `setContent`: Playwright implements it with `document.write`, which
  // re-parses the inlined libraries and chokes on their regex literals and
  // `</script>` sequences — it wrote the document three times before failing.
  // A real file URL is both correct and closer to how the panel loads.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-chat-'));
  const file = path.join(tmpDir, 'chat.html');
  fs.writeFileSync(file, html, 'utf8');
  await page.goto(`file://${file}`, { waitUntil: 'load' });

  // The panel always receives `initialState`, and it is what dismisses the
  // "Preparing your workspace…" overlay. Without it, chat.js falls back to its
  // 12-SECOND safety net (chat.js: `setTimeout(dismissInitLoading, 12000)`) and
  // the overlay swallows pointer events until then — the first click on the
  // pill took 12.2s, every later one 64ms.
  await send({
    type: 'initialState',
    payload: {
      settings: {
        provider: 'claude-code', model: '', mode: 'ask-before-edit',
        thinkingLevel: 'none', effortLevel: 'high', accessLevel: 'ask-permission',
        contextMode: 'auto', autonomousMode: false,
      },
      messages: [], context: [], conversations: [],
    },
  });
  await page.waitForSelector('#init-loading-overlay.hidden', { state: 'attached' });
}

/** Drive the webview the way the extension does. */
async function send(msg: Record<string, unknown>): Promise<void> {
  await page!.evaluate((m) => {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
  }, msg);
}

async function posted(): Promise<Array<Record<string, unknown>>> {
  return page!.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
}

async function clearPosted(): Promise<void> {
  await page!.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
}

/** Choose a rung the way a user does: open the pill, click, popup closes. */
async function setRung(id: string): Promise<void> {
  await page!.click('#behavior-indicator');
  await page!.waitForSelector('#behavior-popup:not(.hidden)');
  await page!.click(`#behavior-popup .mode-option[data-mode="${id}"]`);
  // applyChatMode closes it; if it stayed open it would overlay the composer.
  // `state: 'attached'` matters: the default is 'visible', and `.hidden` is
  // display:none — waiting for a hidden element to become visible never returns.
  await page!.waitForSelector('#behavior-popup.hidden', { state: 'attached' });
}

/** Put the panel into the "a turn is running" state. */
async function startTurn(): Promise<void> {
  await send({ type: 'responseStarted' });
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  await boot();
}, 60000);

afterAll(async () => {
  await browser?.close();
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

describe('chat webview boots', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('loads chat.js with no uncaught exception', async () => {
    // Phase 1 removed three elements whose listeners were bound unguarded.
    // This is the assertion that would have caught shipping that half-done.
    expect(pageErrors).toEqual([]);
    expect(await page!.$('#app')).not.toBeNull();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('has no element the removed policy selects left behind', async () => {
    for (const id of ['mode-select', 'access-select', 'autonomy-select']) {
      expect(await page!.$(`#${id}`), id).toBeNull();
    }
    expect(await page!.$('#popup-autonomy-select')).not.toBeNull();
  });
});

describe('Plan 28 Phase 1 — the trust pill drives everything', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('offers exactly the four rungs', async () => {
    const modes = await page!.$$eval('#behavior-popup .mode-option',
      (els) => els.map((e) => e.getAttribute('data-mode')));
    expect(modes).toEqual(['plan', 'ask', 'auto', 'full']);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('writes both halves of the authority pair on one click', async () => {
    await clearPosted();
    await setRung('auto');
    const updates = (await posted()).filter((m) => m.type === 'updateSettings');
    expect(updates.length).toBe(1);
    expect(updates[0].payload).toMatchObject({ mode: 'edit-automatically', accessLevel: 'ask-permission' });
    expect(await page!.textContent('#behavior-indicator')).toContain('Auto');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('cycles the rung on Shift+Tab from the composer', async () => {
    await setRung('auto');
    await page!.focus('#message-input');
    await page!.keyboard.press('Shift+Tab');
    expect(await page!.textContent('#behavior-indicator')).toContain('Full');
    await page!.keyboard.press('Shift+Tab');   // wraps
    expect(await page!.textContent('#behavior-indicator')).toContain('Plan');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('offers unattended only on the rungs that can act alone', async () => {
    const disabled = () => page!.$eval('#popup-autonomy-select', (e) => (e as HTMLSelectElement).disabled);
    await setRung('plan');
    expect(await disabled(), 'plan').toBe(true);
    await setRung('full');
    expect(await disabled(), 'full').toBe(false);
    await setRung('auto');
    expect(await disabled(), 'auto').toBe(false);
    await setRung('ask');
    expect(await disabled(), 'ask').toBe(true);
  }, 20000);
});

describe('Plan 28 Phase 2 — the composer stays live', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('never disables the input while a turn runs', async () => {
    await startTurn();
    expect(await page!.$eval('#message-input', (e) => (e as HTMLTextAreaElement).disabled)).toBe(false);
    expect(await page!.$eval('#stop-btn', (e) => getComputedStyle(e).display)).not.toBe('none');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('queues on Tab and on Enter, and clears the input', async () => {
    await page!.focus('#message-input');
    await page!.fill('#message-input', 'run the suite');
    await page!.keyboard.press('Tab');
    await page!.fill('#message-input', 'update the changelog');
    await page!.keyboard.press('Enter');

    const chips = await page!.$$eval('.queued-chip .queued-chip-text', (els) => els.map((e) => e.textContent));
    expect(chips).toEqual(['run the suite', 'update the changelog']);
    expect(await page!.$eval('#message-input', (e) => (e as HTMLTextAreaElement).value)).toBe('');
    // Neither keystroke may reach the backend as a send while a turn is running.
    expect((await posted()).filter((m) => m.type === 'sendMessage').length).toBe(0);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drops a queued message on its x', async () => {
    await page!.click('.queued-chip .queued-chip-remove');
    const chips = await page!.$$eval('.queued-chip .queued-chip-text', (els) => els.map((e) => e.textContent));
    expect(chips).toEqual(['update the changelog']);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('does NOT drain on cancel — Escape meant stop', async () => {
    await clearPosted();
    await send({ type: 'requestCancelled' });
    const chips = await page!.$$eval('.queued-chip', (els) => els.length);
    expect(chips).toBe(1);
    expect((await posted()).filter((m) => m.type === 'sendMessage').length).toBe(0);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drains when the turn lands', async () => {
    await clearPosted();
    await startTurn();
    await send({ type: 'responseComplete', payload: { message: { role: 'assistant', content: 'ok' } } });
    expect(await page!.$$eval('.queued-chip', (els) => els.length)).toBe(0);
    const sends = (await posted()).filter((m) => m.type === 'sendMessage');
    expect(sends.length).toBe(1);
    expect((sends[0].payload as { content: string }).content).toBe('update the changelog');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('boots and drives without ever throwing', async () => {
    expect(pageErrors).toEqual([]);
  });
});

describe('Plan 28 Phase 3 — the Runs dock', () => {
  const rows = () => page!.$$eval('#runs-list .runs-row',
    (els) => els.map((e) => ({
      title: e.querySelector('.runs-row-title')?.textContent ?? '',
      state: e.getAttribute('data-state'),
    })));
  const badge = () => page!.$eval('#runs-badge',
    (e) => ({ hidden: e.classList.contains('hidden'), text: e.textContent }));

  it.skipIf(CHROMIUM_UNAVAILABLE)('starts closed, with no badge', async () => {
    expect(await page!.$eval('#runs-dock', (e) => e.classList.contains('hidden'))).toBe(true);
    expect((await badge()).hidden).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('lists work from four different producers at once', async () => {
    await send({ type: 'responseStarted' });
    await send({ type: 'jobStarted', payload: { jobId: 'j1', title: 'full test suite' } });
    await send({ type: 'subAgentStarted', payload: { agentId: 'openai-codex' } });
    await send({ type: 'brainstormStarted', payload: { agents: ['claude-code', 'openai-codex'], strategy: 'red-team' } });

    await page!.click('#runs-btn');
    expect(await page!.$eval('#runs-dock', (e) => e.classList.contains('hidden'))).toBe(false);
    // Opens on Working, because nothing needs a human yet.
    expect(await page!.$eval('.runs-tab.active', (e) => e.getAttribute('data-runs-tab'))).toBe('working');
    const titles = (await rows()).map((r) => r.title);
    expect(titles).toContain('This turn');
    expect(titles).toContain('full test suite');
    expect(titles).toContain('Brainstorm');
    expect(titles.length).toBeGreaterThanOrEqual(4);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('swaps in for the transcript at sidebar width', async () => {
    await page!.setViewportSize({ width: 420, height: 900 });
    expect(await page!.$eval('#messages', (e) => getComputedStyle(e).display)).toBe('none');
    expect(await page!.$eval('#runs-dock', (e) => getComputedStyle(e).display)).not.toBe('none');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('sits BESIDE the conversation in an editor tab', async () => {
    await page!.setViewportSize({ width: 1280, height: 900 });
    // Same markup, one layout rule — the transcript is not replaced here.
    expect(await page!.$eval('#messages', (e) => getComputedStyle(e).display)).not.toBe('none');
    const boxes = await page!.evaluate(() => {
      const m = document.getElementById('messages')!.getBoundingClientRect();
      const d = document.getElementById('runs-dock')!.getBoundingClientRect();
      return { mRight: m.right, dLeft: d.left, mTop: m.top, dTop: d.top };
    });
    expect(boxes.dLeft).toBeGreaterThanOrEqual(boxes.mRight - 1);   // to the right of it
    expect(Math.abs(boxes.dTop - boxes.mTop)).toBeLessThan(2);      // on the same row
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('badges the header the moment something needs a human', async () => {
    await send({ type: 'permissionRequest', payload: {
      id: 'perm_1', toolName: 'Bash', expiresAt: 0, details: { command: 'rm -rf build' } } });
    const b = await badge();
    expect(b.hidden).toBe(false);
    expect(b.text).toBe('1');
    await page!.click('.runs-tab[data-runs-tab="needs"]');
    const needs = await rows();
    expect(needs.length).toBe(1);
    expect(needs[0].state).toBe('needs');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('clears it when the permission is answered', async () => {
    await send({ type: 'permissionResult', payload: { id: 'perm_1' } });
    expect((await badge()).hidden).toBe(true);
    expect(await rows()).toEqual([]);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('moves finished work to Done with an outcome', async () => {
    await send({ type: 'jobComplete', payload: { jobId: 'j1' } });
    await send({ type: 'subAgentComplete', payload: { agentId: 'openai-codex', hasError: true } });
    await page!.click('.runs-tab[data-runs-tab="done"]');
    const done = await rows();
    expect(done.map((r) => r.title)).toContain('full test suite');
    expect(await page!.$$eval('#runs-list .runs-row-mark.ok', (e) => e.length)).toBeGreaterThanOrEqual(1);
    expect(await page!.$$eval('#runs-list .runs-row-mark.bad', (e) => e.length)).toBeGreaterThanOrEqual(1);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('Ctrl+Shift+R opens on whatever needs you', async () => {
    await page!.keyboard.press('Escape');                     // close
    expect(await page!.$eval('#runs-dock', (e) => e.classList.contains('hidden'))).toBe(true);
    await send({ type: 'askUserQuestion', payload: {
      toolCallId: 'q1', questions: [{ question: 'Per-request or per-session?' }] } });
    await page!.keyboard.press('Control+Shift+R');
    expect(await page!.$eval('#runs-dock', (e) => e.classList.contains('hidden'))).toBe(false);
    // Not Working — it opened on the tab that has something waiting.
    expect(await page!.$eval('.runs-tab.active', (e) => e.getAttribute('data-runs-tab'))).toBe('needs');
    expect((await rows())[0].title).toBe('A question for you');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a landed turn clears the question it was blocked on', async () => {
    await send({ type: 'responseComplete', payload: { message: { role: 'assistant', content: 'ok' } } });
    expect((await badge()).hidden).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape closes the dock and restores the transcript', async () => {
    await page!.setViewportSize({ width: 420, height: 900 });
    await page!.keyboard.press('Escape');
    expect(await page!.$eval('#runs-dock', (e) => e.classList.contains('hidden'))).toBe(true);
    expect(await page!.$eval('#messages', (e) => getComputedStyle(e).display)).not.toBe('none');
    await page!.setViewportSize({ width: 1280, height: 900 });
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('Plan 28 Phase 4 — the Changes dock', () => {
  const rowsOf = () => page!.$$eval('#changes-list .change-row',
    (els) => els.map((e) => ({
      path: e.getAttribute('data-path'),
      mine: e.getAttribute('data-mine'),
      by: e.querySelector('.change-by')?.textContent ?? '',
    })));

  it.skipIf(CHROMIUM_UNAVAILABLE)('asks the extension what actually changed', async () => {
    await clearPosted();
    await page!.keyboard.press('Control+Shift+A');
    expect(await page!.$eval('#changes-dock', (e) => e.classList.contains('hidden'))).toBe(false);
    expect((await posted()).some((m) => m.type === 'requestSessionChanges')).toBe(true);
    // Only one dock at a time.
    expect(await page!.$eval('#runs-dock', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('separates agent edits from edits nothing claimed', async () => {
    // One file an agent was seen editing...
    await send({ type: 'toolUse', payload: { id: 't1', name: 'Edit', input: { file_path: 'src/a.ts' } } });
    // ...and git reports that one plus a second nobody touched through a tool.
    await send({ type: 'sessionChanges', payload: { available: true, files: [
      { path: 'src/a.ts', added: 9, removed: 2, status: 'M' },
      { path: 'webpack.config.js', added: 1, removed: 1, status: 'M' },
    ] } });

    const rows = await rowsOf();
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath['src/a.ts'].mine).toBe('0');
    expect(byPath['src/a.ts'].by).toBeTruthy();
    // The one no tool call claimed is the user's, and is marked as such.
    expect(byPath['webpack.config.js'].mine).toBe('1');
    expect(byPath['webpack.config.js'].by).toBe('');

    const groups = await page!.$$eval('.changes-group', (els) => els.map((e) => e.textContent));
    expect(groups.some((g) => /agent/i.test(g ?? ''))).toBe(true);
    expect(groups.some((g) => /no agent behind it/i.test(g ?? ''))).toBe(true);
    expect(await page!.textContent('.changes-note')).toContain('Nothing here is offered for revert');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('totals the diff and badges the header', async () => {
    expect(await page!.textContent('#changes-summary')).toContain('2 files');
    expect(await page!.textContent('#changes-summary')).toContain('+10');
    expect(await page!.textContent('#changes-summary')).toContain('3');
    expect(await page!.$eval('#changes-badge', (e) => e.textContent)).toBe('2');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('never invents a line count for a binary file', async () => {
    await send({ type: 'sessionChanges', payload: { available: true, files: [
      { path: 'resources/logo.png', added: -1, removed: -1, status: 'A' },
    ] } });
    expect(await page!.textContent('#changes-list')).toContain('binary');
    expect(await page!.textContent('#changes-list')).not.toContain('-1');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('opens the file when a row is clicked', async () => {
    await clearPosted();
    await page!.click('.change-row');
    const opens = (await posted()).filter((m) => m.type === 'openFile');
    expect(opens.length).toBe(1);
    expect((opens[0].payload as { path: string }).path).toBe('resources/logo.png');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('says so plainly when there is nothing to compare against', async () => {
    await send({ type: 'sessionChanges', payload: { available: false, files: [], reason: 'no-checkpoint' } });
    expect(await page!.$eval('#changes-empty', (e) => e.classList.contains('hidden'))).toBe(false);
    expect(await page!.textContent('#changes-empty')).toContain('Checkpoints are off');
    expect(await page!.$eval('#changes-badge', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape closes it and restores the transcript', async () => {
    await page!.keyboard.press('Escape');
    expect(await page!.$eval('#changes-dock', (e) => e.classList.contains('hidden'))).toBe(true);
    expect(await page!.$eval('#messages', (e) => getComputedStyle(e).display)).not.toBe('none');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('Plan 28 Phase 5 — the chrome diet and the palette', () => {
  const visible = (sel: string) => page!.$$eval(sel,
    (els) => els.filter((e) => getComputedStyle(e).display !== 'none').length);

  it.skipIf(CHROMIUM_UNAVAILABLE)('leaves three buttons on the right of the header', async () => {
    expect(await visible('.header-right > .icon-btn')).toBe(3);
    for (const id of ['runs-btn', 'changes-btn', 'overflow-btn']) {
      expect(await page!.$(`.header-right > #${id}`), id).not.toBeNull();
    }
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('moves the rest into the overflow without deleting one of them', async () => {
    // Same ids, so every handler and every other test that binds them still works.
    for (const id of ['new-tab-btn', 'export-conversation-btn', 'active-mode-btn',
      'agent-config-btn', 'badges-btn', 'about-btn', 'connections-btn', 'settings-btn']) {
      expect(await page!.$(`#overflow-menu > #${id}`), id).not.toBeNull();
    }
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows four segments under the composer, not ten', async () => {
    // Four SLOTS: agent · model, trust, context, spend. Spend is correctly
    // absent until there is a saving to report, so three show at rest.
    expect(await visible('.input-status-line > *:not(.status-spacer)')).toBe(3);
    for (const id of ['agent-select-btn', 'context-usage', 'behavior-indicator']) {
      expect(await page!.$eval(`#${id}`, (e) => getComputedStyle(e).display), id).not.toBe('none');
    }
    for (const id of ['slash-cmd-btn', 'tools-menu-btn', 'model-select-inline', 'effort-select-inline']) {
      expect(await page!.$(`#${id}`), id).not.toBeNull();     // still in the DOM
      expect(await page!.$eval(`#${id}`, (e) => getComputedStyle(e).display), id).toBe('none');
    }
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('opens on Cmd/Ctrl+K without covering the conversation', async () => {
    await page!.focus('#message-input');
    await page!.keyboard.press('Control+k');
    expect(await page!.$eval('#palette', (e) => e.classList.contains('hidden'))).toBe(false);
    // The transcript is still rendered behind it — that is the whole rule.
    expect(await page!.$eval('#messages', (e) => getComputedStyle(e).display)).not.toBe('none');
    expect(await page!.$eval('#palette-input', (e) => e === document.activeElement)).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('routes to controls that already exist', async () => {
    const groups = await page!.$$eval('.palette-group', (els) => els.map((e) => e.textContent));
    expect(groups).toContain('Trust');
    expect(groups).toContain('Agent');
    expect(groups).toContain('Do');
    // One entry per rung, sourced from the same CHAT_MODES the pill uses.
    const trust = await page!.$$eval('.palette-item',
      (els) => els.map((e) => e.querySelector('.palette-label')?.textContent));
    for (const rung of ['Plan', 'Ask', 'Auto', 'Full']) { expect(trust).toContain(rung); }
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('filters as you type and applies on Enter', async () => {
    await page!.fill('#palette-input', 'full');
    const labels = await page!.$$eval('.palette-item .palette-label', (els) => els.map((e) => e.textContent));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((l) => l === 'Full')).toBe(true);

    await clearPosted();
    await page!.fill('#palette-input', 'Full');
    await page!.keyboard.press('Enter');
    expect(await page!.$eval('#palette', (e) => e.classList.contains('hidden'))).toBe(true);
    // It drove the real trust control, not a copy of it.
    const updates = (await posted()).filter((m) => m.type === 'updateSettings');
    expect(updates.length).toBe(1);
    expect(updates[0].payload).toMatchObject({ mode: 'edit-automatically', accessLevel: 'full-access' });
    expect(await page!.textContent('#behavior-indicator')).toContain('Full');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('closes on Escape', async () => {
    await page!.keyboard.press('Control+k');
    expect(await page!.$eval('#palette', (e) => e.classList.contains('hidden'))).toBe(false);
    await page!.keyboard.press('Escape');
    expect(await page!.$eval('#palette', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('Plan 28 Phase 6 — a team is a verb', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('finds the question an answer was answering', async () => {
    await page!.evaluate(() => {
      document.getElementById('messages')!.insertAdjacentHTML('beforeend',
        '<div class="message user"><div class="message-content">is the retry budget per-request?</div></div>' +
        '<div class="message assistant" data-provider="claude-code" id="probe-answer">' +
        '<div class="message-content">Per session.</div></div>');
    });
    expect(await page!.$('#probe-answer')).not.toBeNull();
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('asks a DIFFERENT agent the same question, through the mention path', async () => {
    // Build the footer action directly on the probe answer — renderMessageFooter
    // is what responseComplete calls, and it always appends this action now.
    await page!.evaluate(() => {
      const el = document.getElementById('probe-answer')!;
      el.insertAdjacentHTML('beforeend',
        '<div class="message-footer"><span class="message-footer-action" data-second-opinion="1">Second opinion</span></div>');
    });
    await page!.click('#probe-answer .message-footer-action');
    const menu = await page!.$('#second-opinion-menu');
    expect(menu).not.toBeNull();

    // The agent that already answered is not offered again.
    const offered = await page!.$$eval('.second-opinion-item', (els) => els.map((e) => e.getAttribute('data-agent')));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain('claude-code');
    expect(offered).not.toContain('brainstorm');

    // It says plainly that it does not merge the answers.
    expect(await page!.textContent('.second-opinion-note')).toContain('does not merge');

    await clearPosted();
    await page!.click('.second-opinion-item');
    const sends = (await posted()).filter((m) => m.type === 'sendMessage');
    expect(sends.length).toBe(1);
    const content = (sends[0].payload as { content: string }).content;
    // Straight down the existing @-mention route, carrying the original question.
    expect(content.startsWith('@')).toBe(true);
    expect(content).toContain('is the retry budget per-request?');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});
