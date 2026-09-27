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

function composeHtml(): string {
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
    .replace('<script nonce="n" src="{{markdownRendererJsUri}}"></script>', () => `<script>${read('media/chat/markdownRenderer.js')}</script>`)
    .replace('<script nonce="n" src="{{subAgentCardsJsUri}}"></script>', () => `<script>${read('media/chat/subAgentCards.js')}</script>`)
    .replace('<script nonce="n" src="{{agentMapJsUri}}"></script>', () => `<script>${read('media/chat/agentMap.js')}</script>`)
    .replace('<script nonce="n" src="{{chatJsUri}}"></script>', () => `<script>${read('media/chat/chat.js')}</script>`)
    .replace('<script nonce="n" src="{{deskJsUri}}"></script>', () => `<script>${read('media/chat/desk.js')}</script>`);

  return html;
}

async function boot(): Promise<void> {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  const html = composeHtml();

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

/**
 * A brand-new panel page. The setup screens destroy `.setup-content` and latch
 * `dismissedByUser`, and nothing in the product clears that except a
 * user-requested setup action — so sharing one page with the rest of the file
 * left every later test running against a permanently-dismissed panel. A
 * helper that "reset" it by replaying `setupStatus` did not work either:
 * `handleSetupStatus` never touches that flag. Its own page is the honest fix.
 */
const spawnedDirs: string[] = [];
async function newPanelPage(): Promise<import('playwright').Page> {
  const ctx = await browser!.newContext({ permissions: ['clipboard-write'] });
  const pg = await ctx.newPage();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-panel-'));
  spawnedDirs.push(dir);
  const file = path.join(dir, 'chat.html');
  fs.writeFileSync(file, composeHtml(), 'utf8');
  await pg.goto(`file://${file}`, { waitUntil: 'load' });
  await pg.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'initialState', payload: {
      settings: { provider: 'claude-code', model: '', mode: 'ask-before-edit', thinkingLevel: 'none',
        effortLevel: 'high', accessLevel: 'ask-permission', contextMode: 'auto', autonomousMode: false },
      messages: [], context: [], conversations: [],
    } } }));
  });
  return pg;
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
  // Each fresh panel page brought its own multi-MB document; without this they
  // accumulated one per test, every run.
  for (const d of spawnedDirs) { fs.rmSync(d, { recursive: true, force: true }); }
});

describe('chat webview boots', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('shows the actual timeout denial when a forced card overrides auto-accept', async () => {
    const pg = await newPanelPage();
    try {
      await pg.evaluate(() => {
        const receive = (type: string, payload: unknown) => window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
        receive('permissionRequest', {
          id: 'native-timeout', actionType: 'file-edit', title: 'Write', description: 'Write a file',
          details: {}, expiresAt: Date.now() + 30000, forceInteractive: true,
        });
        receive('permissionExpired', { requestId: 'native-timeout', behavior: 'auto-accept', approved: false });
      });
      expect(await pg.locator('.permission-card[data-id="native-timeout"] .permission-footer').textContent()).toContain('Auto-denied (timeout)');
    } finally { await pg.context().close(); }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a forced native permission supports approve or deny without a hidden session-grant shortcut', async () => {
    const pg = await newPanelPage();
    try {
      await pg.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'permissionRequest', payload: {
          id: 'native-card', actionType: 'file-edit', title: 'Write', description: 'Write a file',
          details: {}, expiresAt: 0, forceInteractive: true,
        },
      } })));
      const card = pg.locator('.permission-card[data-id="native-card"]');
      expect(await card.locator('[data-action="always-allow"]').count()).toBe(0);
      await card.focus();
      await pg.keyboard.press('2');
      const replies = () => pg.evaluate(() => (window as unknown as { __posted: Array<{ type: string; payload?: unknown }> }).__posted
        .filter(message => message.type === 'permissionResponse'));
      expect(await replies()).toEqual([]);
      await pg.keyboard.press('3');
      expect(await replies()).toMatchObject([{ payload: { requestId: 'native-card', decision: 'deny', scope: 'this-action' } }]);
    } finally { await pg.context().close(); }
  });

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
    // The extension's `permissionResult` carries {action, allowed} and never
    // says WHICH request — so the dock learns from the click, where the id is
    // known. This test used to send a made-up {id} and pass for the wrong
    // reason; a review caught that the real reply cannot clear anything.
    await page!.evaluate(() => {
      document.querySelector('.permission-card[data-id="perm_1"] .permission-option[data-action="deny"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await send({ type: 'permissionResult', payload: { action: 'Bash', allowed: false } });
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
    // absent until there is a saving to report, so three show at rest. The
    // agent map pill is not at rest on this page: the Runs dock tests above
    // left a background job and an @openai-codex sub-agent in this chat, which
    // it rightly counts. A quiet chat, and one where the main agent works
    // alone, keep it hidden; Plan 32's block asserts that on its own page.
    expect(await visible('.input-status-line > *:not(.status-spacer):not(#agent-map-pill)')).toBe(3);
    for (const id of ['agent-select-btn', 'context-usage', 'behavior-indicator']) {
      expect(await page!.$eval(`#${id}`, (e) => getComputedStyle(e).display), id).not.toBe('none');
    }
    // Model + effort are back as one pill (tested below); with no model list
    // on this page it hides itself, which is why the count above is still 3.
    for (const id of ['slash-cmd-btn', 'tools-menu-btn']) {
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
    // A not-installed agent would only answer with an install card.
    await page!.evaluate(() => {
      document.querySelector('#agent-menu .agent-menu-item[data-agent="cursor"]')?.classList.add('disabled');
    });
    await page!.click('#probe-answer .message-footer-action');
    const menu = await page!.$('#second-opinion-menu');
    expect(menu).not.toBeNull();

    // The agent that already answered is not offered again.
    const offered = await page!.$$eval('.second-opinion-item', (els) => els.map((e) => e.getAttribute('data-agent')));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain('claude-code');
    expect(offered).not.toContain('brainstorm');
    expect(offered).not.toContain('cursor');

    // The list was clipped by the panel edge: it must sit inside the window and
    // scroll whatever does not fit.
    const box = await page!.$eval('#second-opinion-menu', (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight, open: el.matches(':popover-open'),
        overflowY: getComputedStyle(el).overflowY };
    });
    expect(box.open).toBe(true);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.vh);
    expect(box.overflowY).toBe('auto');

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

describe('a compaction reads as a divider, not a wall of text', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('folds the markdown summary under a one-line divider', async () => {
    await send({ type: 'compactionStatus', payload: {
      status: 'complete', strategy: 'native-cli', beforeTokens: 49210, contextWindow: 200000, threshold: 75,
      summary: '1. Primary Request and Intent:\n   None yet.\n\n2. Pending Tasks:\n   - wait for a request',
    } });
    const card = await page!.$eval('.compaction-divider:last-of-type', (el) => ({
      tag: el.tagName,
      open: (el as HTMLDetailsElement).open,
      label: el.querySelector('.compaction-divider-label')!.textContent,
      // Rendered, not escaped: the numbered sections are a real list.
      listItems: el.querySelectorAll('.compaction-summary ol > li').length,
    }));
    expect(card.tag).toBe('DETAILS');
    expect(card.open).toBe(false);
    expect(card.label).toBe('Conversation compacted · was 49.2k tokens');
    expect(card.listItems).toBe(2);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows before → after only when the context actually shrank', async () => {
    await send({ type: 'compactionStatus', payload: {
      status: 'complete', strategy: 'client-summarize', beforeTokens: 60000, afterTokens: 3000,
      contextWindow: 200000, threshold: 75, summary: 'Short summary.',
    } });
    expect(await page!.$eval('.compaction-divider:last-of-type .compaction-divider-label', (el) => el.textContent))
      .toBe('Conversation compacted · 60.0k → 3.0k tokens');
  }, 20000);
});

describe('Plan 28 Phase 7 — context rows carry their own cost', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('shows what each row adds, and strikes it through when off', async () => {
    await send({ type: 'contextUpdated', payload: [
      { id: 'c1', type: 'file', path: '/repo/src/big.ts', content: 'x'.repeat(8000), enabled: true },
      { id: 'c2', type: 'file', path: '/repo/src/off.ts', content: 'y'.repeat(400), enabled: false },
    ] });
    const costs = await page!.$$eval('.context-item-cost', (els) => els.map((e) => e.textContent));
    expect(costs).toContain('~2.0k');   // 8000 chars / 4
    expect(costs).toContain('~100');
    // The disabled row still shows what it WOULD cost, struck through.
    const offStruck = await page!.$eval('.context-item.off .context-item-cost',
      (e) => getComputedStyle(e).textDecorationLine);
    expect(offStruck).toContain('line-through');
  }, 20000);
});

describe('Plan 28 Phase 7 — a silent backend says so', () => {
  let page2: import('playwright').Page | undefined;

  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    // Its own page, under a mocked clock: the threshold is 90 real seconds, and
    // putting every other test in this file under a fake clock would break the
    // ones that read real timestamps.
    page2 = await browser!.newPage();
    await page2.clock.install();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-stall-'));
    const file = path.join(dir, 'chat.html');
    fs.writeFileSync(file, composeHtml(), 'utf8');
    await page2.goto(`file://${file}`, { waitUntil: 'load' });
  }, 60000);

  afterAll(async () => { await page2?.close(); });

  const fire = (m: Record<string, unknown>) =>
    page2!.evaluate((x) => { window.dispatchEvent(new MessageEvent('message', { data: x })); }, m);

  it.skipIf(CHROMIUM_UNAVAILABLE)('stays quiet while the backend is producing', async () => {
    await fire({ type: 'responseStarted' });
    await page2!.clock.fastForward('01:00');
    await fire({ type: 'responseChunk', payload: { content: 'still going' } });
    await page2!.clock.fastForward('01:00');
    expect(await page2!.$('#stall-card')).toBeNull();
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('counts a long THINKING pass as alive', async () => {
    // The case a stall detector must not get wrong: a model reasoning for two
    // minutes streams `thinking` and nothing else. The first draft listed a
    // type name that never existed, so this would have false-alarmed.
    await fire({ type: 'thinking', payload: { content: 'still reasoning' } });
    await page2!.clock.fastForward('01:00');
    expect(await page2!.$('#stall-card')).toBeNull();
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('speaks up after ninety seconds of silence', async () => {
    await page2!.clock.fastForward('02:00');
    const card = await page2!.$('#stall-card');
    expect(card).not.toBeNull();
    const text = await page2!.textContent('#stall-card');
    // It says a long think looks the same — it has not decided the turn is dead.
    expect(text).toContain('A long think looks like this too');
    expect(text).toContain('nothing has been cancelled');
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('offers keep-waiting, stop, and a hand-off', async () => {
    const actions = await page2!.$$eval('.stall-btn', (els) => els.map((e) => e.getAttribute('data-stall')));
    expect(actions).toEqual(['wait', 'stop', 'hand']);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('keep-waiting dismisses it and restarts the clock', async () => {
    await page2!.click('.stall-btn[data-stall="wait"]');
    expect(await page2!.$('#stall-card')).toBeNull();
    await page2!.clock.fastForward('00:30');
    expect(await page2!.$('#stall-card')).toBeNull();   // clock was reset
    await page2!.clock.fastForward('02:00');
    expect(await page2!.$('#stall-card')).not.toBeNull();
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('stop asks the extension to cancel, and nothing else does', async () => {
    await page2!.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
    await page2!.click('.stall-btn[data-stall="stop"]');
    const posted = await page2!.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted);
    expect(posted.filter((m) => m.type === 'cancelRequest').length).toBe(1);
    expect(await page2!.$('#stall-card')).toBeNull();
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('disappears when the turn ends', async () => {
    await fire({ type: 'responseStarted' });
    await page2!.clock.fastForward('02:00');
    expect(await page2!.$('#stall-card')).not.toBeNull();
    await fire({ type: 'responseComplete', payload: { message: { role: 'assistant', content: 'done' } } });
    expect(await page2!.$('#stall-card')).toBeNull();
  }, 30000);
});

describe('the composer shows model, effort and prompt cache the way Claude does', () => {
  let pg: import('playwright').Page | undefined;
  const fire = (m: Record<string, unknown>) =>
    pg!.evaluate((x) => { window.dispatchEvent(new MessageEvent('message', { data: x })); }, m);
  const turn = (extra: Record<string, unknown> = {}) =>
    fire({ type: 'responseComplete', payload: { message: { role: 'assistant', content: 'ok' }, ...extra } });
  const chip = () => pg!.$eval('#cache-indicator', (e) => ({
    shown: getComputedStyle(e).display !== 'none',
    text: (e.textContent || '').trim(),
    title: e.getAttribute('title'),
    cold: e.classList.contains('cold'),
  }));
  const pickModel = (id: string) => pg!.evaluate((v) => {
    const el = document.getElementById('model-select-inline') as HTMLSelectElement;
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, id);

  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    // Its own page under a mocked clock: the cache TTL is an hour of wall time.
    pg = await browser!.newPage();
    await pg.clock.install();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cache-'));
    spawnedDirs.push(dir);
    const file = path.join(dir, 'chat.html');
    fs.writeFileSync(file, composeHtml(), 'utf8');
    await pg.goto(`file://${file}`, { waitUntil: 'load' });
    await fire({ type: 'initialState', payload: {
      settings: { provider: 'claude-code', model: 'claude-opus-5-5', mode: 'ask-before-edit', thinkingLevel: 'none',
        effortLevel: 'xhigh', accessLevel: 'ask-permission', contextMode: 'auto', autonomousMode: false },
      providers: [{ name: 'claude-code', models: [
        { id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-sonnet-5', name: 'Sonnet 5' }] }],
      providerManifest: { schemaVersion: 1, providers: [{ id: 'claude-code',
        capabilities: { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortDefault: 'high' } }] },
      messages: [], context: [], conversations: [],
    } });
  }, 60000);

  afterAll(async () => { await pg?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows the model and its effort as one pill', async () => {
    expect(await pg!.$eval('#model-pill', (e) => getComputedStyle(e).display)).not.toBe('none');
    expect(await pg!.$eval('#model-select-inline', (e) => (e as HTMLSelectElement).selectedOptions[0]?.text)).toBe('Opus 5.5');
    expect(await pg!.$eval('#effort-select-inline', (e) => (e as HTMLSelectElement).selectedOptions[0]?.text)).toBe('Extra High');
    // The coordinator's button is Mysti's half, not Claude's.
    expect(await pg!.$eval('#mysti-model-btn', (e) => getComputedStyle(e).display)).toBe('none');
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('names a listed model saved as the custom model, and says Custom… only for an unlisted one', async () => {
    const shown = () => pg!.$eval('#model-select-inline', (e) => (e as HTMLSelectElement).selectedOptions[0]?.text);
    // mysti.claudeCodeModel = claude-opus-5-5 outranks the picker, and it is a listed model.
    await fire({ type: 'modelChanged', payload: { model: 'claude-sonnet-5', customModel: 'claude-opus-5-5' } });
    expect(await shown()).toBe('Opus 5.5');
    await fire({ type: 'modelChanged', payload: { model: 'claude-sonnet-5', customModel: 'my-org/finetune-7' } });
    expect(await shown()).toBe('Custom…');
    await fire({ type: 'modelChanged', payload: { model: 'claude-opus-5-5', customModel: '' } });
    expect(await shown()).toBe('Opus 5.5');
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('says nothing about the cache until a turn touches it', async () => {
    await turn();
    expect((await chip()).shown).toBe(false);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('counts down while warm, then says cold', async () => {
    await turn({ promptCache: { ttlMs: 60 * 60 * 1000 } });
    expect(await chip()).toEqual({ shown: true, text: '60m', cold: false, title: 'Prompt cache warm, about 60 min left.' });
    await pg!.clock.fastForward('20:00');
    expect((await chip()).text).toBe('40m');
    // A turn that touched no cache does not restart the clock.
    await turn();
    await pg!.clock.fastForward('41:00');
    const cold = await chip();
    expect(cold).toMatchObject({ shown: true, text: 'cold', cold: true });
    expect(cold.title).toContain('last turn 61 min ago');
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('belongs to the model that wrote it', async () => {
    await turn({ promptCache: { ttlMs: 5 * 60 * 1000 } });
    expect((await chip()).text).toBe('5m');
    await pickModel('claude-sonnet-5');
    expect((await chip()).shown).toBe(false);
    await pickModel('claude-opus-5-5');
    expect((await chip()).text).toBe('5m');
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('clears with the conversation', async () => {
    await fire({ type: 'conversationChanged', payload: null });
    expect((await chip()).shown).toBe(false);
  }, 30000);
});

describe('Plan 28 Phase 7 — where a persona or skill came from', () => {
  const badges = () => page!.$$eval('#skills-list .skill-item',
    (els) => els.map((e) => ({
      name: e.querySelector('.skill-name')?.textContent ?? '',
      origin: e.querySelector('.agent-origin')?.textContent ?? null,
      danger: !!e.querySelector('.agent-origin.danger'),
    })));

  it.skipIf(CHROMIUM_UNAVAILABLE)('says nothing about a bundled file that is unchanged', async () => {
    await send({ type: 'agentsUpdated', payload: {
      availablePersonas: [],
      availableSkills: [
        { id: 'core-ok', name: 'Threat modelling', description: '', instructions: '', source: 'core', trusted: true, warnings: 0 },
      ],
      availableRoles: [],
    } });
    const rows = await badges();
    expect(rows.find((r) => r.name === 'Threat modelling')?.origin).toBeNull();
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('marks a bundled file that no longer matches what shipped', async () => {
    await send({ type: 'agentsUpdated', payload: {
      availablePersonas: [],
      availableSkills: [
        { id: 'core-bad', name: 'Tampered', description: '', instructions: '', source: 'core', trusted: false, warnings: 0 },
      ],
      availableRoles: [],
    } });
    const row = (await badges()).find((r) => r.name === 'Tampered');
    expect(row?.origin).toBe('changed since it shipped');
    expect(row?.danger).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('names the origin of anything not bundled, with its findings', async () => {
    await send({ type: 'agentsUpdated', payload: {
      availablePersonas: [],
      availableSkills: [
        { id: 'mine', name: 'Mine', description: '', instructions: '', source: 'user', trusted: false, warnings: 0 },
        { id: 'repo', name: 'Repo', description: '', instructions: '', source: 'workspace', trusted: false, warnings: 0 },
        { id: 'imported', name: 'Imported', description: '', instructions: '', source: 'plugin', trusted: false, warnings: 2 },
      ],
      availableRoles: [],
    } });
    const rows = await badges();
    const by = Object.fromEntries(rows.map((r) => [r.name, r.origin]));
    expect(by['Mine']).toBe('yours');
    expect(by['Repo']).toBe('this repo');
    expect(by['Imported']).toBe('imported · 2 findings');
    // Provenance, not a verdict — none of these shouts.
    expect(rows.filter((r) => r.danger).length).toBe(0);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('every control in the panel actually does something', () => {
  /*
   * A static reference check says each id appears somewhere in chat.js. It does
   * NOT say a handler is bound, and "revive all eight dead slash-menu entries"
   * is a real commit in this repo's history. So this clicks every button in the
   * panel on a FRESH page and asserts that none of them throws — the cheapest
   * true statement about whether the UI is wired.
   */
  let page3: import('playwright').Page | undefined;
  const errors: string[] = [];

  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    // Clipboard write is a real thing several of these buttons do; headless
    // Chromium denies it unless the context is granted the permission, and a
    // denial is an environment artifact rather than a product defect.
    const ctx = await browser!.newContext({ permissions: ['clipboard-write'] });
    page3 = await ctx.newPage();
    page3.on('pageerror', (e) => errors.push(String(e)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-clickall-'));
    const file = path.join(dir, 'chat.html');
    fs.writeFileSync(file, composeHtml(), 'utf8');
    await page3.goto(`file://${file}`, { waitUntil: 'load' });
    await page3.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'initialState', payload: {
        settings: { provider: 'claude-code', model: '', mode: 'ask-before-edit', thinkingLevel: 'none',
          effortLevel: 'high', accessLevel: 'ask-permission', contextMode: 'auto', autonomousMode: false },
        messages: [], context: [], conversations: [],
      } } }));
    });
  }, 60000);

  afterAll(async () => { await page3?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('finds a substantial number of buttons to try', async () => {
    const n = await page3!.$$eval('button[id]', (els) => els.length);
    expect(n).toBeGreaterThanOrEqual(30);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('clicks every one of them without a single uncaught error', async () => {
    const ids = await page3!.$$eval('button[id]', (els) => els.map((e) => e.id));
    const clicked: string[] = [];
    for (const id of ids) {
      // Dispatch rather than page.click: many are inside collapsed panels, and
      // what is under test is the HANDLER, not whether the element is on screen.
      const ok = await page3!.evaluate((btnId) => {
        const el = document.getElementById(btnId);
        if (!el) { return false; }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }, id);
      if (ok) { clicked.push(id); }
      // Close anything a click may have opened, so the next one is reachable.
      await page3!.evaluate(() => {
        document.querySelectorAll('.palette, #overflow-menu, #agent-menu, #behavior-popup, #slash-menu, #mention-menu')
          .forEach((e) => e.classList.add('hidden'));
        document.getElementById('second-opinion-menu')?.remove();
      });
    }
    expect(clicked.length).toBe(ids.length);
    expect(errors, `uncaught errors while clicking: ${errors.join(' | ')}`).toEqual([]);
  }, 60000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('every select changes without throwing', async () => {
    const ids = await page3!.$$eval('select[id]', (els) => els.map((e) => e.id));
    for (const id of ids) {
      await page3!.evaluate((selId) => {
        const el = document.getElementById(selId) as HTMLSelectElement | null;
        if (!el) { return; }
        if (el.options.length > 1) { el.selectedIndex = el.options.length - 1; }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, id);
    }
    expect(errors, `uncaught errors while changing selects: ${errors.join(' | ')}`).toEqual([]);
  }, 60000);
});

describe('every panel still opens after the header diet', () => {
  /*
   * Phase 5 moved eight buttons out of the header and into an overflow menu.
   * They kept their ids so their handlers still bind — but "the handler binds"
   * and "the panel opens" are different claims, and this is the one that
   * matters. Each button is clicked and the panel it owns must open.
   * Plan 31: "open" now means the Mysti tab on that section — the button asks
   * the host for it, and nothing un-hides inline over the transcript.
   */
  const PANELS: Array<[string, string, string]> = [
    ['settings-btn', 'settings', 'settings-panel'],
    ['about-btn', 'about', 'about-panel'],
    ['badges-btn', 'badges', 'badges-panel'],
    ['agent-config-btn', 'agents', 'agent-config-panel'],
  ];

  it.skipIf(CHROMIUM_UNAVAILABLE)('opens each panel its button owns', async () => {
    for (const [btn, section, panel] of PANELS) {
      await clearPosted();
      await page!.evaluate((id) => document.getElementById(id)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })), btn);
      const asks = (await posted()).filter((m) => m.type === 'openSettingsHub');
      expect(asks.map((m) => m.payload), `${btn} did not open the ${section} section`).toEqual([{ section }]);
      const inline = await page!.$eval(`#${panel}`, (e) => !e.classList.contains('hidden'));
      expect(inline, `${btn} opened #${panel} inline`).toBe(false);
    }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the overflow menu reveals and then hides itself', async () => {
    await page!.evaluate(() => document.getElementById('overflow-menu')!.classList.add('hidden'));
    await page!.click('#overflow-btn');
    expect(await page!.$eval('#overflow-menu', (e) => e.classList.contains('hidden'))).toBe(false);
    // Choosing anything from it closes it.
    await page!.evaluate(() => document.getElementById('about-btn')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(await page!.$eval('#overflow-menu', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the eight relocated controls are all still reachable', async () => {
    for (const id of ['new-tab-btn', 'export-conversation-btn', 'active-mode-btn', 'agent-config-btn',
      'badges-btn', 'about-btn', 'connections-btn', 'settings-btn']) {
      const inOverflow = await page!.$eval(`#${id}`,
        (e) => !!e.closest('#overflow-menu'));
      expect(inOverflow, id).toBe(true);
    }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 30000);
});

describe('the first-run screens have a second exit', () => {
  /*
   * Both are position:fixed full-screen at z-index 100000, and a Skip BUTTON
   * was the only way out of either. That is the D-1 shape this codebase already
   * shipped once: when the single exit is unreachable, the panel is a wall.
   */
  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape leaves the wizard, and the dismissal sticks', async () => {
    await page!.evaluate(() => document.getElementById('setup-wizard')!.classList.remove('hidden'));
    await clearPosted();
    await page!.keyboard.press('Escape');

    const dismiss = (await posted()).filter((m) => m.type === 'dismissWizard');
    expect(dismiss.length).toBe(1);
    // It must go through the skip button's own path, so it persists.
    expect((dismiss[0].payload as { dontShowAgain: boolean }).dontShowAgain).toBe(true);
    expect(await page!.$eval('#setup-wizard', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape leaves the setup overlay too', async () => {
    await page!.evaluate(() => document.getElementById('setup-overlay')!.classList.remove('hidden'));
    await clearPosted();
    await page!.keyboard.press('Escape');
    expect((await posted()).some((m) => m.type === 'skipSetup')).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('and does not fire when neither is up', async () => {
    await page!.evaluate(() => {
      document.getElementById('setup-wizard')!.classList.add('hidden');
      document.getElementById('setup-overlay')!.classList.add('hidden');
    });
    await clearPosted();
    await page!.keyboard.press('Escape');
    const p2 = await posted();
    expect(p2.some((m) => m.type === 'dismissWizard' || m.type === 'skipSetup')).toBe(false);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('review round: the nine findings stay fixed', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('answering a permission clears Needs-you (it has no id on the way back)', async () => {
    await send({ type: 'permissionRequest', payload: {
      id: 'perm_r1', actionType: 'bash-command', toolName: 'Bash', expiresAt: 0,
      details: { toolName: 'Bash', command: 'ls' } } });
    expect(await page!.$eval('#runs-badge', (e) => e.textContent)).toBe('1');

    // The extension answers with {action, allowed} — no request id at all — so
    // the dock has to learn about it from the click, not the reply.
    await page!.evaluate(() => {
      document.querySelector('.permission-card[data-id="perm_r1"] .permission-option[data-action="approve"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await send({ type: 'permissionResult', payload: { action: 'Bash', allowed: true } });
    expect(await page!.$eval('#runs-badge', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a superseded gate is dropped by requestIds', async () => {
    await send({ type: 'permissionRequest', payload: {
      id: 'perm_r2', actionType: 'bash-command', toolName: 'Bash', expiresAt: 0,
      details: { toolName: 'Bash', command: 'ls' } } });
    expect(await page!.$eval('#runs-badge', (e) => e.classList.contains('hidden'))).toBe(false);
    await send({ type: 'permissionDismissed', payload: { requestIds: ['perm_r2'] } });
    expect(await page!.$eval('#runs-badge', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('draining a queued message does not eat a half-typed draft', async () => {
    await send({ type: 'responseStarted' });
    await page!.fill('#message-input', 'queue this one');
    await page!.keyboard.press('Tab');
    await page!.fill('#message-input', 'a draft I was still writing');
    await send({ type: 'responseComplete', payload: { message: { role: 'assistant', content: 'ok' } } });
    expect(await page!.$eval('#message-input', (e) => (e as HTMLTextAreaElement).value))
      .toBe('a draft I was still writing');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the Changes badge counts before the dock is ever opened', async () => {
    await page!.evaluate(() => document.getElementById('changes-dock')!.classList.add('hidden'));
    await send({ type: 'sessionChanges', payload: { available: true, files: [
      { path: 'a.ts', added: 1, removed: 0, status: 'M' },
      { path: 'b.ts', added: 2, removed: 0, status: 'A' },
    ] } });
    expect(await page!.$eval('#changes-badge', (e) => e.textContent)).toBe('2');
    expect(await page!.$eval('#changes-badge', (e) => e.classList.contains('hidden'))).toBe(false);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a deleted file is not offered for opening', async () => {
    await send({ type: 'sessionChanges', payload: { available: true, files: [
      { path: 'gone.ts', added: 0, removed: 12, status: 'D' },
    ] } });
    await clearPosted();
    await page!.evaluate(() => document.querySelector('.change-row')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect((await posted()).filter((m) => m.type === 'openFile').length).toBe(0);
    expect(await page!.$eval('.change-row', (e) => e.getAttribute('data-openable'))).toBe('0');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the autonomous feed goes above the work area, not into its row', async () => {
    await send({ type: 'autonomousDecision', payload: { safetyLevel: 'safe', description: 'read a file' } });
    const parentId = await page!.$eval('#autonomous-decision-feed', (e) => e.parentElement?.id ?? '');
    expect(parentId).toBe('app');
    const before = await page!.evaluate(() => {
      const feed = document.getElementById('autonomous-decision-feed')!;
      const wa = document.getElementById('workarea')!;
      return feed.compareDocumentPosition(wa) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(before).toBeTruthy();
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('review round two: the fixes did not introduce their own bugs', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('a semi-autonomous decision clears the card it answered', async () => {
    await send({ type: 'permissionRequest', payload: {
      id: 'perm_sa', actionType: 'bash-command', toolName: 'Bash', expiresAt: 0,
      details: { toolName: 'Bash', command: 'ls' } } });
    expect(await page!.$eval('#runs-badge', (e) => e.classList.contains('hidden'))).toBe(false);
    await send({ type: 'semiAutonomousDecision', payload: {
      requestId: 'perm_sa', targetType: 'permission', approved: true } });
    // Otherwise it sits in `needs` forever — which since round one also
    // permanently disarms the stall card.
    expect(await page!.$eval('#runs-badge', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape leaves the overlay even when the skip button is gone', async () => {
    await page!.evaluate(() => {
      const o = document.getElementById('setup-overlay')!;
      o.classList.remove('hidden');
      // Exactly what showAuthPromptUI does: replace the body, taking the only
      // control with it.
      const c = o.querySelector('.setup-content');
      if (c) { c.innerHTML = '<div>Waiting for authentication…</div>'; }
    });
    expect(await page!.$('#setup-skip-btn')).toBeNull();
    await clearPosted();
    await page!.keyboard.press('Escape');
    expect((await posted()).some((m) => m.type === 'skipSetup')).toBe(true);
    expect(await page!.$eval('#setup-overlay', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('attachments belong to the message they were staged for', async () => {
    // The first version of this test sent the wrong payload shape, staged
    // nothing, and asserted 0 === 0 — it passed with the fix reverted. The
    // handler wants `{ attachments: [...] }`.
    const stage = (name: string) => send({ type: 'fileAttachmentSelected',
      payload: { attachments: [{ name, type: 'image', dataUrl: 'data:,' }] } });

    await send({ type: 'responseStarted' });
    await stage('for-the-queued-one.png');
    await page!.fill('#message-input', 'queued');
    await page!.keyboard.press('Tab');
    // Queueing takes the staged file WITH the queued message.
    expect(await page!.$$eval('.attachment-preview-item', (e) => e.length)).toBe(0);

    await page!.fill('#message-input', 'draft');
    await stage('for-the-draft.png');
    expect(await page!.$$eval('.attachment-preview-item', (e) => e.length)).toBe(1);

    await clearPosted();
    await send({ type: 'responseComplete', payload: { message: { role: 'assistant', content: 'ok' } } });

    // The queued message went out carrying ITS file...
    const sends = (await posted()).filter((m) => m.type === 'sendMessage');
    expect(sends.length).toBe(1);
    const sent = sends[0].payload as { content: string; attachments?: Array<{ name: string }> };
    expect(sent.content).toBe('queued');
    expect((sent.attachments ?? []).map((a) => a.name)).toEqual(['for-the-queued-one.png']);

    // ...and the draft kept its own text and its own file.
    expect(await page!.$eval('#message-input', (e) => (e as HTMLTextAreaElement).value)).toBe('draft');
    expect(await page!.$$eval('.attachment-preview-item', (e) => e.length)).toBe(1);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('cancelling autonomous activation tells the extension the level reverted', async () => {
    await clearPosted();
    await page!.evaluate(() => document.getElementById('autonomous-cancel-btn')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const posts = await posted();
    // The extension is the authority for semi-autonomous behaviour; without
    // this it kept treating the panel as autonomous.
    expect(posts.some((m) => m.type === 'autonomyLevelChanged')).toBe(true);
    expect(posts.some((m) => m.type === 'cancelAutonomousActivation')).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a deleted row looks unclickable, not just behaves that way', async () => {
    await send({ type: 'sessionChanges', payload: { available: true, files: [
      { path: 'gone.ts', added: 0, removed: 3, status: 'D' } ] } });
    expect(await page!.$eval('.change-row.not-openable', (e) => getComputedStyle(e).cursor)).toBe('default');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('review round three', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('an auto-answered QUESTION clears too, not just a permission', async () => {
    await send({ type: 'askUserQuestion', payload: {
      toolCallId: 'q_r3', questions: [{ question: 'Which one?' }] } });
    expect(await page!.$eval('#runs-badge', (e) => e.classList.contains('hidden'))).toBe(false);
    // The extension puts the TOOL-CALL id in `requestId` for a question. The
    // first fix read `toolCallId`, which is never sent, so this branch was dead
    // and only the permission half was covered.
    await send({ type: 'semiAutonomousDecision', payload: {
      requestId: 'q_r3', targetType: 'question', approved: true } });
    expect(await page!.$eval('#runs-badge', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the confirm modal records the level it was opened from', async () => {
    // Reach semi-autonomous, then open the modal the way Ctrl+Shift+A does.
    await page!.evaluate(() => {
      const sel = document.getElementById('popup-autonomy-select') as HTMLSelectElement;
      sel.disabled = false;
      sel.value = 'semi-autonomous';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await send({ type: 'showAutonomousConfirm', payload: {} });
    await clearPosted();
    await page!.evaluate(() => document.getElementById('autonomous-cancel-btn')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const levels = (await posted()).filter((m) => m.type === 'autonomyLevelChanged')
      .map((m) => (m.payload as { level: string }).level);
    // Cancelling must put the backend back where it actually was, not wherever
    // `previousAutonomyLevel` happened to be left by an earlier flow.
    expect(levels).toEqual(['semi-autonomous']);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a hand-made dismissal is not undone by a later setup failure', async () => {
    await page!.evaluate(() => {
      const o = document.getElementById('setup-overlay')!;
      o.classList.remove('hidden');
      const c = o.querySelector('.setup-content');
      if (c) { c.innerHTML = '<div>Waiting for authentication…</div>'; }
    });
    await page!.keyboard.press('Escape');
    expect(await page!.$eval('#setup-overlay', (e) => e.classList.contains('hidden'))).toBe(true);
    // skipSetup does not cancel the extension's auth poll, so this arrives
    // anyway — and by now the overlay has no buttons left in it.
    await send({ type: 'setupFailed', payload: { providerId: 'claude-code', error: 'timed out' } });
    expect(await page!.$eval('#setup-overlay', (e) => e.classList.contains('hidden'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('review round four', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('declining autonomous does not leave you autonomous', async () => {
    // The popup path records the level it came FROM before switching. Round
    // three then overwrote that with the CURRENT level, so Cancel "reverted"
    // into the very mode the user had just declined.
    await page!.evaluate(() => {
      const sel = document.getElementById('popup-autonomy-select') as HTMLSelectElement;
      sel.disabled = false;
      sel.value = 'manual';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.value = 'autonomous';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await send({ type: 'showAutonomousConfirm', payload: {} });
    await clearPosted();
    await page!.evaluate(() => document.getElementById('autonomous-cancel-btn')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const levels = (await posted()).filter((m) => m.type === 'autonomyLevelChanged')
      .map((m) => (m.payload as { level: string }).level);
    expect(levels).toEqual(['manual']);
    expect(await page!.$eval('#popup-autonomy-select', (e) => (e as HTMLSelectElement).value)).toBe('manual');
  }, 20000);



  it.skipIf(CHROMIUM_UNAVAILABLE)('a queued chip says how many files ride with it', async () => {
    await send({ type: 'responseStarted' });
    await send({ type: 'fileAttachmentSelected',
      payload: { attachments: [{ name: 'a.png', type: 'image', dataUrl: 'data:,' }] } });
    // Whatever is staged right now is what must ride with the queued message —
    // asserting a hardcoded 1 would just be asserting test isolation.
    const staged = await page!.$$eval('.attachment-preview-item', (e) => e.length);
    expect(staged).toBeGreaterThan(0);
    await page!.fill('#message-input', 'with a file');
    await page!.keyboard.press('Tab');
    expect(await page!.textContent('.queued-chip-att')).toContain(String(staged));
    // Queueing takes them off the composer.
    expect(await page!.$$eval('.attachment-preview-item', (e) => e.length)).toBe(0);
    await send({ type: 'requestCancelled' });
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe('the setup overlay, on a pristine page each time', () => {
  /*
   * `dismissedByUser` latches, and only a user-requested setup action clears
   * it — so these need a panel nobody has dismissed yet. Each test gets one.
   */
  let pg: import('playwright').Page | undefined;
  const errs: string[] = [];

  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    pg = await newPanelPage();
    pg.on('pageerror', (e) => errs.push(String(e)));
  }, 60000);
  afterEach(async () => {
    // Close the CONTEXT, not just the page — a leaked context per test is a
    // leaked browser process's worth of state.
    const ctx = pg?.context();
    await pg?.close();
    await ctx?.close();
    pg = undefined;
  });

  const fire = (m: Record<string, unknown>) =>
    pg!.evaluate((x) => { window.dispatchEvent(new MessageEvent('message', { data: x })); }, m);
  const sent = () => pg!.evaluate(() =>
    (window as unknown as { __posted: Array<{ type: string }> }).__posted);
  const show = () => pg!.evaluate(() =>
    document.getElementById('setup-overlay')!.classList.remove('hidden'));
  const hidden = () => pg!.$eval('#setup-overlay', (e) => e.classList.contains('hidden'));

  it.skipIf(CHROMIUM_UNAVAILABLE)('a stale setupFailed cannot re-raise a dismissed wall', async () => {
    await show();
    await pg!.keyboard.press('Escape');
    expect(await hidden()).toBe(true);
    // skipSetup does not cancel the extension's auth poll, so this arrives anyway.
    await fire({ type: 'setupFailed', payload: { providerId: 'claude-code', error: 'timed out' } });
    expect(await hidden()).toBe(true);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('nor can a stale authPrompt', async () => {
    await show();
    await pg!.keyboard.press('Escape');
    await fire({ type: 'authPrompt', payload: { providerId: 'claude-code', message: 'Sign in' } });
    expect(await hidden()).toBe(true);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('signing in does NOT re-arm it', async () => {
    // `#wizard-signin-btn` runs `mysti.deepmyst.signIn` and can never produce a
    // setup message. Re-arming there would only let an unrelated in-flight
    // auto-setup re-raise the wall the user had already left.
    await show();
    await pg!.keyboard.press('Escape');
    await pg!.evaluate(() => document.getElementById('wizard-signin-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await fire({ type: 'authPrompt', payload: { providerId: 'claude-code', message: 'Sign in' } });
    expect(await hidden()).toBe(true);
  }, 30000);



  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape works when the auth state has destroyed the skip button', async () => {
    await show();
    await pg!.evaluate(() => {
      const c = document.getElementById('setup-overlay')!.querySelector('.setup-content');
      if (c) { c.innerHTML = '<div>Waiting for authentication…</div>'; }
    });
    expect(await pg!.$('#setup-skip-btn')).toBeNull();
    await pg!.keyboard.press('Escape');
    expect((await sent()).some((m) => m.type === 'skipSetup')).toBe(true);
    expect(await hidden()).toBe(true);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the auth prompt offers a way out, and so does the waiting state', async () => {
    // The ROOT CAUSE of every guard in this area: signing in replaced the
    // content with a waiting state that had no controls at all, on a
    // full-screen overlay.
    await fire({ type: 'authPrompt', payload: { providerId: 'claude-code', message: 'Sign in to continue' } });
    expect(await hidden()).toBe(false);
    expect(await pg!.$('#auth-skip-btn')).not.toBeNull();

    await pg!.click('#auth-confirm-btn');
    expect(await pg!.textContent('#setup-overlay')).toContain('Waiting for authentication');
    const out = await pg!.$('#auth-wait-skip-btn');
    expect(out, 'the waiting state must keep an exit').not.toBeNull();

    await pg!.click('#auth-wait-skip-btn');
    expect(await hidden()).toBe(true);
    expect((await sent()).some((m) => m.type === 'skipSetup')).toBe(true);
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a provider error message cannot inject markup', async () => {
    await fire({ type: 'authPrompt', payload: {
      providerId: 'claude-code', message: '<img src=x onerror="window.__pwned=1">' } });
    expect(await pg!.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await pg!.textContent('#setup-overlay')).toContain('<img src=x');
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(errs).toEqual([]);
  }, 30000);
});

describe('an availability blip cannot rewrite the saved agent', () => {
  /*
   * "The chat keeps switching back." The webview's availability fallback used
   * to post `updateSettings { provider }`, which the extension persists to the
   * GLOBAL `mysti.defaultAgent`. So a CLI probe that had not finished, or a
   * backend briefly unreachable, quietly overwrote the agent the user chose —
   * and the panel then came back on the substitute for good.
   */
  it.skipIf(CHROMIUM_UNAVAILABLE)('switches the panel for the session but persists nothing', async () => {
    const pg = await newPanelPage();
    try {
      await pg.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'initialState', payload: {
          settings: { provider: 'openai-codex', model: '', mode: 'ask-before-edit', thinkingLevel: 'none',
            effortLevel: 'high', accessLevel: 'ask-permission', contextMode: 'auto', autonomousMode: false },
          messages: [], context: [], conversations: [],
          providerManifest: { schemaVersion: 1, providers: [
            { id: 'claude-code', shortId: 'claude', displayName: 'Claude Code', color: '#d97757', capabilities: {} },
            { id: 'openai-codex', shortId: 'codex', displayName: 'Codex', color: '#a1a1a1', capabilities: {} },
          ] },
        } } }));
      });
      expect(await pg.$eval('#agent-name', (e) => e.textContent)).toContain('Codex');

      await pg.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
      // Codex momentarily reports unavailable; Claude is installed.
      await pg.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'providerAvailability', payload: {
          providerAvailability: {
            'openai-codex': { available: false },
            'claude-code': { available: true },
          },
        } } }));
      });

      // The panel becomes usable...
      expect(await pg.$eval('#agent-name', (e) => e.textContent)).toContain('Claude');
      // ...but nothing was saved. Persisting here is what made the switch stick.
      const posted = await pg.evaluate(() =>
        (window as unknown as { __posted: Array<{ type: string; payload?: { provider?: string } }> }).__posted);
      const persisted = posted.filter((m) => m.type === 'updateSettings' && m.payload && 'provider' in m.payload);
      expect(persisted, `an availability blip must not persist an agent: ${JSON.stringify(persisted)}`)
        .toEqual([]);
    } finally {
      const ctx = pg.context();
      await pg.close();
      await ctx.close();
    }
  }, 30000);
});

describe('sub-agent cards through the shipped chat message boundary', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('retry and conversation change discard old rendering state', async () => {
    const pg = await newPanelPage();
    const errors: string[] = [];
    pg.on('pageerror', error => errors.push(String(error)));
    try {
      await pg.evaluate(() => {
        const receive = (type: string, payload?: unknown) => window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
        receive('subAgentStarted', { agentId: 'openai-codex' });
        receive('subAgentChunk', { agentId: 'openai-codex', chunkType: 'text', content: 'old attempt' });
        receive('subAgentRetry', { agentId: 'openai-codex' });
        receive('subAgentChunk', { agentId: 'openai-codex', chunkType: 'text', content: '**new attempt**' });
        receive('subAgentComplete', { agentId: 'openai-codex' });
      });
      expect(await pg.locator('.subagent-text-output strong').textContent()).toBe('new attempt');
      expect(await pg.locator('.subagent-card').textContent()).not.toContain('old attempt');
      await pg.evaluate(() => {
        const receive = (type: string, payload?: unknown) => window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
        receive('subAgentStarted', { agentId: 'openai-codex' });
        receive('subAgentChunk', { agentId: 'openai-codex', chunkType: 'text', content: 'old conversation' });
        receive('conversationChanged', { messages: [] });
        receive('subAgentStarted', { agentId: 'openai-codex' });
        receive('subAgentChunk', { agentId: 'openai-codex', chunkType: 'text', content: 'new conversation' });
        receive('subAgentComplete', { agentId: 'openai-codex' });
      });
      expect(await pg.locator('.subagent-card').count()).toBe(1);
      expect((await pg.locator('.subagent-text-output').textContent())?.trim()).toBe('new conversation');
      expect(errors).toEqual([]);
    } finally { await pg.context().close(); }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('simultaneous real question controls keep separate selections and stop invalidates saved callbacks', async () => {
    const pg = await newPanelPage();
    const errors: string[] = [];
    pg.on('pageerror', error => errors.push(String(error)));
    try {
      await pg.evaluate(() => {
        const receive = (type: string, payload?: unknown) => window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
        for (const agentId of ['openai-codex', 'claude-code']) {
          receive('subAgentStarted', { agentId });
          receive('subAgentAskUserQuestion', { agentId, questionData: {
            toolCallId: agentId + '-delivery', questions: [{ question: 'Continue?', header: 'Choice', options: [{ label: 'Yes' }, { label: 'No' }] }],
          } });
        }
      });
      const cards = pg.locator('.subagent-card');
      await cards.nth(0).locator('input[type="radio"][value="Yes"]').check();
      await cards.nth(1).locator('input[type="radio"][value="No"]').check();
      expect(await cards.nth(0).locator('input[type="radio"][value="Yes"]').isChecked()).toBe(true);
      await cards.nth(0).locator('.auq-submit-btn').click();
      const replies = await pg.evaluate(() => (window as unknown as { __posted: Array<{ type: string; payload?: unknown }> }).__posted
        .filter(message => message.type === 'subAgentQuestionResponse'));
      expect(replies).toEqual([{ type: 'subAgentQuestionResponse', panelId: null, payload: {
        agentId: 'openai-codex', toolCallId: 'openai-codex-delivery', answers: { Choice: 'Yes' },
      } }]);
      await pg.evaluate(() => {
        const submit = document.querySelector<HTMLButtonElement>('.subagent-card[data-agent-id="claude-code"] .auq-submit-btn')!;
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'requestCancelled' } }));
        submit.click();
      });
      expect(await pg.locator('.ask-user-question-container').count()).toBe(0);
      expect(await pg.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted
        .filter(message => message.type === 'subAgentQuestionResponse').length)).toBe(1);
      expect(errors).toEqual([]);
    } finally { await pg.context().close(); }
  });
});

describe('Plan 32 — the agent map', () => {
  /*
   * Its own page: the shared one already holds a background job and a
   * sub-agent from the Runs dock tests, and "hidden at rest" is a statement
   * about a chat where the main agent is alone.
   */
  let pg: import('playwright').Page | undefined;
  const errors: string[] = [];
  const receive = (m: Record<string, unknown>) => pg!.evaluate((msg) => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  }, m);
  const pill = () => pg!.$eval('#agent-map-pill',
    (e) => ({ display: getComputedStyle(e).display, text: e.textContent ?? '' }));
  const mapOpen = () => pg!.$eval('#agent-map', (e) => !e.classList.contains('hidden'));
  const postedTypes = () => pg!.evaluate(() =>
    (window as unknown as { __posted: Array<{ type: string }> }).__posted.map((m) => m.type));

  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    pg = await newPanelPage();
    pg.on('pageerror', (e) => errors.push(String(e)));
    await pg.waitForSelector('#init-loading-overlay.hidden', { state: 'attached' });
  }, 60000);

  afterAll(async () => { await pg?.context().close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps the pill hidden at rest and through a plain turn, so the status line keeps three segments', async () => {
    const segments = () => pg!.$$eval('.input-status-line > *:not(.status-spacer)',
      (els) => els.filter((e) => getComputedStyle(e).display !== 'none').length);
    expect((await pill()).display).toBe('none');
    expect(await segments()).toBe(3);
    // The main agent alone is an ordinary chat, working or done.
    await receive({ type: 'responseStarted', payload: { provider: 'claude-code' } });
    expect((await pill()).display).toBe('none');
    await receive({ type: 'responseComplete', payload: { message: { role: 'assistant', content: 'ok' } } });
    expect((await pill()).display).toBe('none');
    expect(await segments()).toBe(3);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows the pill after a delegation, and the pill opens the map', async () => {
    await receive({ type: 'responseStarted', payload: { provider: 'claude-code' } });
    await receive({ type: 'toolUse', payload: {
      id: 'toolu_1', name: 'delegate', input: { agent: 'openai-codex', task: 'Fix the flaky test' } } });
    const shown = await pill();
    expect(shown.display).not.toBe('none');
    expect(shown.text).toContain('agents');
    await pg!.click('#agent-map-pill');
    expect(await mapOpen()).toBe(true);
    expect(await pg!.locator('#agent-map .agent-map-node', { hasText: 'Fix the flaky test' }).count()).toBe(1);
    // Opening moved focus into the map.
    expect(await pg!.evaluate(() => !!document.activeElement?.closest('#agent-map'))).toBe(true);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('lays out as a sidebar list at 420px and as a graph at 1280px', async () => {
    // The layout follows `resize`, which lands after the viewport change resolves.
    const layoutIs = (cls: string) => pg!.waitForFunction(
      (c) => document.getElementById('agent-map')!.classList.contains(c), cls, { timeout: 5000 });
    await pg!.setViewportSize({ width: 420, height: 900 });
    await layoutIs('agent-map--narrow');
    await pg!.setViewportSize({ width: 1280, height: 900 });
    await layoutIs('agent-map--graph');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape inside the map closes it and never answers a pending card', async () => {
    await pg!.keyboard.press('Escape');
    await receive({ type: 'permissionRequest', payload: {
      id: 'perm_map', toolName: 'Bash', expiresAt: 0, details: { command: 'rm -rf build' } } });
    expect((await pill()).text).toContain('needs you');
    await pg!.click('#agent-map-pill');
    expect(await mapOpen()).toBe(true);
    await pg!.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
    // Escape is also the permission card's deny key and the composer's stop key.
    await pg!.keyboard.press('Escape');
    expect(await mapOpen()).toBe(false);
    expect(await pg!.$eval('.permission-card[data-id="perm_map"]', (e) => e.classList.contains('pending'))).toBe(true);
    const types = await postedTypes();
    expect(types).not.toContain('permissionResponse');
    expect(types).not.toContain('cancelRequest');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('clears a need when the card itself is answered', async () => {
    await pg!.click('.permission-card[data-id="perm_map"] .permission-option[data-action="deny"]');
    expect((await pill()).text).not.toContain('needs you');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('clears a sub-agent question when it is answered in its card', async () => {
    await receive({ type: 'subAgentStarted', payload: { agentId: 'openai-codex' } });
    await receive({ type: 'subAgentAskUserQuestion', payload: { agentId: 'openai-codex', questionData: {
      toolCallId: 'q_map', questions: [{ question: 'Continue?', header: 'Choice', options: [{ label: 'Yes' }, { label: 'No' }] }],
    } } });
    expect((await pill()).text).toContain('needs you');
    await pg!.locator('.subagent-card .auq-skip-btn').click();
    expect((await pill()).text).not.toContain('needs you');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps the workflow stepper on Execute through the verify phase', async () => {
    await receive({ type: 'mystiStarted', payload: { sessionId: 'wf-map' } });
    await receive({ type: 'mystiEvent', payload: { type: 'orch_status', phase: 'execute', content: 'Running' } });
    await receive({ type: 'mystiEvent', payload: { type: 'orch_status', phase: 'verify', content: 'Checking' } });
    expect(await pg!.$eval('#mysti-stepper .brainstorm-step.active', (e) => e.getAttribute('data-phase'))).toBe('execute');
    await receive({ type: 'mystiEvent', payload: { type: 'orch_status', phase: 'synthesize', content: 'Writing' } });
    expect(await pg!.$eval('#mysti-stepper .brainstorm-step.active', (e) => e.getAttribute('data-phase'))).toBe('synthesize');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('refreshes jobs silently: the map\'s own jobsList adds no system message', async () => {
    const systemMessages = () => pg!.locator('#messages .message.system').count();
    const before = await systemMessages();
    await receive({ type: 'jobsList', payload: { jobs: [], source: 'agentMap' } });
    expect(await systemMessages()).toBe(before);
    // The user's own /jobs still answers.
    await receive({ type: 'jobsList', payload: { jobs: [] } });
    expect(await systemMessages()).toBe(before + 1);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('asks another installed agent through the mention path the composer parses', async () => {
    await receive({ type: 'initialState', payload: {
      settings: { provider: 'claude-code', model: '', mode: 'ask-before-edit', thinkingLevel: 'none',
        effortLevel: 'high', accessLevel: 'ask-permission', contextMode: 'auto', autonomousMode: false },
      messages: [], context: [], conversations: [],
      providerManifest: { schemaVersion: 1, providers: [
        { id: 'claude-code', shortId: 'claude', displayName: 'Claude Code', color: '#d97757', capabilities: {} },
        { id: 'openai-codex', shortId: 'codex', displayName: 'Codex', color: '#a1a1a1', capabilities: {} },
        { id: 'google-gemini', shortId: 'gemini', displayName: 'Gemini', color: '#4285f4', capabilities: {} },
      ] },
    } });
    await receive({ type: 'providerAvailability', payload: {
      providerAvailability: { 'google-gemini': { available: false } } } });
    await receive({ type: 'toolResult', payload: { id: 'toolu_1', status: 'success', output: 'Fixed.' } });
    await pg!.click('#agent-map-pill');
    await pg!.locator('#agent-map .agent-map-node', { hasText: 'Fix the flaky test' }).click();
    await pg!.locator('#agent-map .agent-map-action', { hasText: 'Ask another agent' }).click();
    // Not the backend that did it, and not one that is not installed.
    expect(await pg!.locator('#agent-map .agent-map-ask-item').allTextContents()).toEqual(['Claude Code']);
    await pg!.locator('#agent-map .agent-map-ask-item').click();
    expect(await mapOpen()).toBe(false);
    expect(await pg!.$eval('#message-input', (e) => (e as HTMLTextAreaElement).value)).toBe('@claude Fix the flaky test');
    expect(await pg!.evaluate(() => document.activeElement?.id)).toBe('message-input');
  }, 20000);

  describe('no key typed at the open map answers a card behind it', () => {
    const permissionResponses = () => pg!.evaluate(() =>
      (window as unknown as { __posted: Array<{ type: string }> }).__posted.filter((m) => m.type === 'permissionResponse'));
    const focusInMap = () => pg!.evaluate(() => !!document.activeElement?.closest('#agent-map'));
    const permission = (id: string) => receive({ type: 'permissionRequest', payload: {
      id, toolName: 'Bash', expiresAt: 0, details: { command: 'rm -rf /tmp/x' } } });

    it.skipIf(CHROMIUM_UNAVAILABLE)('a card that arrives while the map is open does not take focus, and Escape only closes', async () => {
      await permission('perm_k1');
      await pg!.click('#agent-map-pill');
      expect(await mapOpen()).toBe(true);
      await permission('perm_k2');
      expect(await focusInMap()).toBe(true);
      await pg!.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
      await pg!.keyboard.press('Escape');
      expect(await mapOpen()).toBe(false);
      expect(await permissionResponses()).toEqual([]);
      expect(await pg!.$$eval('.permission-card.pending', (els) => els.length)).toBeGreaterThanOrEqual(2);
    }, 20000);

    it.skipIf(CHROMIUM_UNAVAILABLE)('a click on plain text keeps focus in the map, and Enter there approves nothing', async () => {
      await pg!.click('#agent-map-pill');
      await pg!.locator('#agent-map .agent-map-node', { hasText: 'Main agent' }).click();
      await pg!.click('#agent-map .agent-map-inspector-title');
      expect(await focusInMap()).toBe(true);
      await pg!.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
      await pg!.keyboard.press('Enter');
      await pg!.keyboard.press('1');
      expect(await permissionResponses()).toEqual([]);
      expect(await mapOpen()).toBe(true);
      await pg!.keyboard.press('Escape');
    }, 20000);

    it.skipIf(CHROMIUM_UNAVAILABLE)('a host message that fills the composer leaves focus in the open map', async () => {
      await pg!.click('#agent-map-pill');
      for (const m of [{ type: 'insertPrompt', payload: 'x' }, { type: 'setInputValue', payload: { value: 'y' } },
        { type: 'promptEnhanced', payload: { prompt: 'z', changed: true, fallback: false, enhancedBy: '' } }]) {
        await receive(m);
        expect(await focusInMap()).toBe(true);
      }
      await pg!.keyboard.press('Escape');
      expect(await mapOpen()).toBe(false);
    }, 20000);

    it.skipIf(CHROMIUM_UNAVAILABLE)('Enter on the pill opens the map instead of approving', async () => {
      await pg!.focus('#agent-map-pill');
      await pg!.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
      await pg!.keyboard.press('Enter');
      expect(await mapOpen()).toBe(true);
      expect(await permissionResponses()).toEqual([]);
      await pg!.keyboard.press('Escape');
      expect(await mapOpen()).toBe(false);
    }, 20000);

    it.skipIf(CHROMIUM_UNAVAILABLE)('on the pill with the map closed, 3 still answers the waiting card', async () => {
      await pg!.focus('#agent-map-pill');
      await pg!.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
      await pg!.keyboard.press('3');
      expect(await mapOpen()).toBe(false);
      expect((await permissionResponses()).map((m) => (m as { payload: { decision: string } }).payload.decision)).toEqual(['deny']);
    }, 20000);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a delegate progress ping draws nothing in the chat', async () => {
    await receive({ type: 'mystiDelegateTrace', payload: { parentId: 'toolu_1', chunk: { type: 'progress' } } });
    expect(await pg!.$$eval('.tool-call[data-id="toolu_1"] .mysti-node-activity', (els) => els.length)).toBe(0);
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('stopping the agent session keeps the map; clearing the session resets it', async () => {
    expect((await pill()).display).not.toBe('none');
    await receive({ type: 'sessionCleared', payload: { message: 'Agent session shut down', reason: 'shutdown' } });
    expect((await pill()).display).not.toBe('none');
    await receive({ type: 'sessionCleared', payload: { message: 'Session cleared' } });
    expect((await pill()).display).toBe('none');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('lane cards stay inside their columns and a long tool name leaves room for its summary', async () => {
    await receive({ type: 'responseStarted', payload: { provider: 'mysti' } });
    await receive({ type: 'toolUse', payload: { id: 'mcp_1', name: 'mcp__trello-composio__COMPOSIO_MULTI_EXECUTE_TOOL', input: { query: 'open cards' } } });
    await receive({ type: 'toolUse', payload: { id: 'dg_1', name: 'delegate', input: { agent: 'openai-codex', task: 'Fix the flaky login test' } } });
    await receive({ type: 'toolUse', payload: { id: 'dg_2', name: 'delegate', input: { agent: 'google-gemini', task: 'Review the migration plan' } } });
    await receive({ type: 'toolResult', payload: { id: 'dg_2', status: 'failed', output: '(failed: crashed — exit 1)' } });
    await receive({ type: 'mentionTaskStarted', payload: { agentId: 'claude-code', task: 'Write the release notes' } });
    await receive({ type: 'subAgentStarted', payload: { agentId: 'claude-code' } });
    await receive({ type: 'mystiStarted', payload: { brief: 'Ship the settings page' } });
    const ev = (e: Record<string, unknown>) => receive({ type: 'mystiEvent', payload: { runId: 'wf1', ...e } });
    await ev({ type: 'orch_status', phase: 'decompose' });
    await ev({ type: 'orch_plan', plan: { nodes: [
      { id: 'schema', task: 'Design the settings schema', dependsOn: [] },
      { id: 'api', task: 'Build the settings API endpoints', dependsOn: ['schema'] },
      { id: 'ui', task: 'Build the settings UI against the API', dependsOn: ['schema', 'api'] }] } });
    await ev({ type: 'orch_status', phase: 'execute' });
    await ev({ type: 'orch_node_start', nodeId: 'schema', nodeBackend: 'claude-code' });
    await ev({ type: 'orch_node_done', nodeId: 'schema', hasError: false });
    await ev({ type: 'orch_node_start', nodeId: 'api', nodeBackend: 'openai-codex' });
    await receive({ type: 'permissionRequest', payload: {
      id: 'perm_layout', toolName: 'Bash', expiresAt: 0, toolCallId: 'dg_1', details: { command: 'npm test' } } });
    await pg!.setViewportSize({ width: 1280, height: 900 });
    await pg!.click('#agent-map-pill');
    await pg!.waitForFunction(() => document.getElementById('agent-map')!.classList.contains('agent-map--graph'));
    const overflow = await pg!.$$eval('#agent-map .agent-map-wf-col', (cols) => cols.map((col) => {
      const right = col.getBoundingClientRect().right;
      return Math.max(0, ...[...col.querySelectorAll('.agent-map-node')].map((n) => n.getBoundingClientRect().right - right));
    }));
    expect(overflow.length).toBe(4);
    expect(Math.max(...overflow)).toBeLessThanOrEqual(0.5);
    // The main agent's row is joined to its children's trunk, and a lane's task wraps before it is cut.
    expect(await pg!.$eval('#agent-map .agent-map-tree > .agent-map-item > .agent-map-group',
      (e) => getComputedStyle(e, '::before').width)).toBe('12px');
    const title = await pg!.locator('#agent-map .agent-map-wf .agent-map-title', { hasText: 'Design the settings schema' })
      .evaluate((e) => ({ height: e.getBoundingClientRect().height, line: parseFloat(getComputedStyle(e).lineHeight) || 15 }));
    expect(title.height).toBeGreaterThan(title.line * 1.5);
    // A rebuild keeps the tree's scroll even though the focused row is now scrolled out of view.
    await pg!.setViewportSize({ width: 1280, height: 360 });
    await pg!.locator('#agent-map .agent-map-node', { hasText: 'Main agent' }).focus();
    // One round-trip per read: $eval queries and evaluates in two, and a rebuild
    // in between would hand it a detached pane that always reads 0.
    const treeScroll = () => pg!.evaluate(() => document.querySelector('#agent-map .agent-map-main')!.scrollTop);
    const scrolled = await pg!.evaluate(() => {
      const e = document.querySelector('#agent-map .agent-map-main')!;
      e.scrollTop = e.scrollHeight;
      return e.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(40);
    await receive({ type: 'toolUse', payload: { id: 'read_1', name: 'Read', input: { file_path: 'src/settings.ts' } } });
    expect(await treeScroll()).toBe(scrolled);
    expect(await pg!.evaluate(() => document.activeElement?.textContent ?? '')).toContain('Main agent');
    await pg!.setViewportSize({ width: 800, height: 900 });
    await pg!.waitForFunction(() => document.getElementById('agent-map')!.classList.contains('agent-map--outline'));
    await pg!.locator('#agent-map .agent-map-node', { hasText: 'Main agent' }).click();
    const inspector = await pg!.$eval('#agent-map .agent-map-inspector', (e) => ({
      spill: e.scrollWidth - e.clientWidth,
      summary: e.querySelector('.agent-map-tool-summary')!.getBoundingClientRect().width,
    }));
    expect(inspector.spill).toBeLessThanOrEqual(0);
    expect(inspector.summary).toBeGreaterThan(20);
    await pg!.keyboard.press('Escape');
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a wide workflow keeps readable columns, visible connectors and the close button in its corner', async () => {
    // Dark Modern's panel border and foreground; the harness defines no theme otherwise.
    await pg!.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-panel-border', '#2b2b2b');
      document.documentElement.style.setProperty('--vscode-foreground', '#cccccc');
    });
    // A failure here must not leave the map open over the next test on this shared page.
    try {
      await pg!.setViewportSize({ width: 1100, height: 900 });
      await pg!.click('#agent-map-pill');
      await pg!.waitForFunction(() => document.getElementById('agent-map')!.classList.contains('agent-map--graph'));
      // Columns keep a floor and the tree pane scrolls sideways rather than squeezing words apart.
      const widths = await pg!.$$eval('#agent-map .agent-map-wf-col', (cols) => cols.map((c) => c.getBoundingClientRect().width));
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(150);
      // Connector lines are drawn in a colour that differs from the panel border (nearly the surface in dark themes).
      // In the graph the lines are the items' ::before trunks, not the group's own border.
      const lines = await pg!.$eval('#agent-map .agent-map-group > .agent-map-item', (item) => ({
        line: getComputedStyle(item, '::before').borderLeftColor,
        border: getComputedStyle(document.querySelector('#agent-map .agent-map-header')!).borderBottomColor,
      }));
      expect(lines.line).not.toBe(lines.border);
      await pg!.keyboard.press('Escape');
      // At sidebar width the chips may wrap, but the close button stays in the top-right corner.
      await pg!.setViewportSize({ width: 420, height: 900 });
      await pg!.click('#agent-map-pill');
      await pg!.waitForFunction(() => document.getElementById('agent-map')!.classList.contains('agent-map--narrow'));
      const corner = await pg!.$eval('#agent-map .agent-map-close', (b) => {
        const box = b.getBoundingClientRect();
        const head = b.closest('.agent-map-header')!.getBoundingClientRect();
        return { right: head.right - box.right, top: box.top - head.top };
      });
      expect(corner.right).toBeLessThanOrEqual(16);
      expect(corner.top).toBeLessThanOrEqual(12);
    } finally {
      if (await pg!.evaluate(() => !document.getElementById('agent-map')!.classList.contains('hidden'))) {
        await pg!.keyboard.press('Escape');
      }
    }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('names the pseudo agents the way the agent button does', async () => {
    const rootTitle = () => pg!.$eval('#agent-map .agent-map-kind--root .agent-map-title', (e) => e.textContent);
    await receive({ type: 'responseStarted', payload: { provider: 'mysti' } });
    await pg!.click('#agent-map-pill');
    expect(await rootTitle()).toBe('Mysti');
    await receive({ type: 'responseStarted', payload: { provider: 'brainstorm' } });
    expect(await rootTitle()).toBe('Brainstorm');
    await receive({ type: 'responseStarted', payload: { provider: 'claude-code' } });
    expect(await rootTitle()).toBe('Claude Code');
    await pg!.keyboard.press('Escape');
  }, 20000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('drove all of that without throwing', async () => {
    expect(errors).toEqual([]);
  }, 20000);
});
