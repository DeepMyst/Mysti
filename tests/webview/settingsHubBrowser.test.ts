/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 31, in a real browser: the ⋯ menu, the Mysti tab (body.view-hub) and
 * settingsSync, against the REAL index.html + chat.css + chat.js with the
 * boot contract the extension provides. Harness follows
 * chatComposerBrowser.test.ts — read its NOTE on replacer functions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../..');
let browser: Browser | undefined;
const dirs: string[] = [];
const pageErrors: string[] = [];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function bootPayload(): Record<string, unknown> {
  const boot: Record<string, unknown> = { mermaidUri: '', logoUri: '', version: '0.0.0-test', iconUris: {}, manifestSchemaVersion: 1 };
  for (const k of ['claude', 'gemini', 'cline', 'copilot', 'cursor', 'openclaw', 'opencode', 'ollama',
    'localai', 'qwen', 'hermes', 'continue', 'openrouter', 'kimi']) { boot[`${k}LogoUri`] = ''; }
  boot.openaiLogoLightUri = '';
  boot.openaiLogoDarkUri = '';
  return boot;
}

function composeHtml(view: 'chat' | 'hub'): string {
  let html = read('media/chat/index.html');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '');
  html = html
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace(/\{\{cspSource\}\}/g, "'self'")
    .replace(/\{\{resourceBase\}\}/g, '')
    .replace(/\{\{version\}\}/g, '0.0.0-test')
    .replace('<link rel="stylesheet" href="{{chatCssUri}}">', () => `<style>${read('media/chat/chat.css')}</style>`)
    .replace('<link rel="stylesheet" href="{{deskCssUri}}">', () => `<style>${read('media/chat/desk.css')}</style>`)
    .replace('{{bootJson}}', () => JSON.stringify(bootPayload()))
    .replace('</head>', () => '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>');
  if (view === 'hub') { html = html.replace('<body>', () => '<body class="view-hub">'); }
  for (const [tag, file] of [
    ['<script nonce="n" src="/dompurify.min.js"></script>', 'resources/dompurify.min.js'],
    ['<script nonce="n" src="/marked.min.js"></script>', 'resources/marked.min.js'],
    ['<script nonce="n" src="/prism-bundle.js"></script>', 'resources/prism-bundle.js'],
  ] as const) {
    html = html.replace(tag, () => `<script>${read(file)}</script>`);
  }
  const stub = `<script>
    window.__posted = [];
    window.acquireVsCodeApi = function () {
      return { postMessage: function (m) { window.__posted.push(m); }, getState: function () {}, setState: function () {} };
    };
  </script>`;
  const bootTag = '<script nonce="n">window.__MYSTI_BOOT__';
  if (!html.includes(bootTag)) { throw new Error('boot script tag not found — harness is out of date with index.html'); }
  html = html.replace(bootTag, () => `${stub}${bootTag}`);
  return html
    .replace('<script nonce="n" src="{{markdownRendererJsUri}}"></script>', () => `<script>${read('media/chat/markdownRenderer.js')}</script>`)
    .replace('<script nonce="n" src="{{subAgentCardsJsUri}}"></script>', () => `<script>${read('media/chat/subAgentCards.js')}</script>`)
    .replace('<script nonce="n" src="{{chatJsUri}}"></script>', () => `<script>${read('media/chat/chat.js')}</script>`)
    .replace('<script nonce="n" src="{{deskJsUri}}"></script>', () => `<script>${read('media/chat/desk.js')}</script>`);
}

const INITIAL_SETTINGS = {
  provider: 'claude-code', model: '', mode: 'ask-before-edit', thinkingLevel: 'none',
  effortLevel: 'high', accessLevel: 'ask-permission', contextMode: 'auto', autonomousMode: false,
};

async function send(pg: Page, msg: Record<string, unknown>): Promise<void> {
  await pg.evaluate((m) => { window.dispatchEvent(new MessageEvent('message', { data: m })); }, msg);
}

async function posted(pg: Page): Promise<Array<Record<string, unknown>>> {
  return pg.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
}

async function clearPosted(pg: Page): Promise<void> {
  await pg.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
}

/** A fresh page in the chat view or the Mysti tab view, after initialState. */
async function openPage(view: 'chat' | 'hub', extra: Record<string, unknown> = {}): Promise<Page> {
  const ctx = await browser!.newContext();
  const pg = await ctx.newPage();
  pg.on('pageerror', (err) => pageErrors.push(`${view}: ${String(err)}`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-hub-'));
  dirs.push(dir);
  const file = path.join(dir, 'chat.html');
  fs.writeFileSync(file, composeHtml(view), 'utf8');
  await pg.setViewportSize({ width: 900, height: 700 });
  await pg.goto(`file://${file}`, { waitUntil: 'load' });
  await send(pg, { type: 'initialState', payload: { settings: { ...INITIAL_SETTINGS }, messages: [], context: [], conversations: [], ...extra } });
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

describe('Plan 31 — the ⋯ menu says what each item is', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('every item has a visible, non-empty label', async () => {
    const pg = await openPage('chat');
    try {
      await pg.click('#overflow-btn');
      const labels = await pg.$$eval('#overflow-menu > button', (btns) => btns
        .filter((b) => getComputedStyle(b).display !== 'none')
        .map((b) => {
          const l = b.querySelector('.overflow-label') as HTMLElement | null;
          return l && l.offsetWidth > 0 ? (l.textContent || '').trim() : '';
        }));
      expect(labels.length).toBeGreaterThanOrEqual(7);
      expect(labels.every((t) => t.length > 0)).toBe(true);
    } finally { await pg.context().close(); }
  }, 30000);
});

const SECTIONS: Array<[string, string, string]> = [
  ['settings-btn', 'settings', 'settings-panel'],
  ['agent-config-btn', 'agents', 'agent-config-panel'],
  ['badges-btn', 'badges', 'badges-panel'],
  ['about-btn', 'about', 'about-panel'],
];

describe('Plan 31 — in the chat, the four items open the Mysti tab', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('each posts openSettingsHub and nothing opens inline', async () => {
    const pg = await openPage('chat');
    try {
      for (const [btn, section, panel] of SECTIONS) {
        await clearPosted(pg);
        await pg.click('#overflow-btn');
        await pg.click(`#${btn}`);
        expect((await posted(pg)).filter((m) => m.type === 'openSettingsHub')).toEqual([
          { type: 'openSettingsHub', payload: { section }, panelId: null },
        ]);
        expect(await pg.$eval(`#${panel}`, (el) => getComputedStyle(el).display)).toBe('none');
      }
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the chat never shows the tab chrome', async () => {
    const pg = await openPage('chat');
    try {
      expect(await pg.$eval('#hub-nav', (el) => getComputedStyle(el).display)).toBe('none');
      expect(await pg.$eval('#hub-binding', (el) => getComputedStyle(el).display)).toBe('none');
    } finally { await pg.context().close(); }
  }, 30000);
});

describe('Plan 31 — the Mysti tab', () => {
  const visiblePanels = (pg: Page) => pg.$$eval('#settings-panel, #agent-config-panel, #badges-panel, #about-panel',
    (els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id));

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows the nav and exactly one section, and none of the chat', async () => {
    const pg = await openPage('hub');
    try {
      expect(await pg.$eval('#hub-nav', (el) => getComputedStyle(el).display)).not.toBe('none');
      expect(await visiblePanels(pg)).toEqual(['settings-panel']);
      for (const sel of ['.header', '#workarea', '.input-area', '#overflow-menu', '#init-loading-overlay']) {
        expect(await pg.$eval(sel, (el) => getComputedStyle(el).display), sel).toBe('none');
      }
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('hubShow picks the section and names the chat', async () => {
    const pg = await openPage('hub');
    try {
      await clearPosted(pg);
      await send(pg, { type: 'hubShow', payload: { section: 'badges', chatTitle: 'Fix login' } });
      expect(await visiblePanels(pg)).toEqual(['badges-panel']);
      expect(await pg.textContent('#hub-binding')).toBe('Configuring: Fix login');
      expect((await posted(pg)).map((m) => m.type)).toContain('requestBadges');
      expect(await pg.$eval('.hub-nav-item.active', (el) => el.getAttribute('data-hub-section'))).toBe('badges');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('nav clicks switch sections; Connections opens its own tab', async () => {
    const pg = await openPage('hub');
    try {
      await pg.click('.hub-nav-item[data-hub-section="agents"]');
      expect(await visiblePanels(pg)).toEqual(['agent-config-panel']);
      await clearPosted(pg);
      await pg.click('.hub-nav-item[data-hub-connections]');
      expect((await posted(pg)).map((m) => m.type)).toContain('openConnections');
      expect(await visiblePanels(pg)).toEqual(['agent-config-panel']);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('when its chat closes it keeps the section, says so, and turns edits off', async () => {
    const pg = await openPage('hub');
    try {
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
      await send(pg, { type: 'hubShow', payload: { section: null, chatTitle: null } });
      expect(await visiblePanels(pg)).toEqual(['settings-panel']);
      expect(await pg.textContent('#hub-binding')).toMatch(/^No chat selected/);
      expect(await pg.$eval('#settings-panel', (el) => getComputedStyle(el).pointerEvents)).toBe('none');
      expect(await pg.$eval('#agent-config-panel', (el) => getComputedStyle(el).pointerEvents)).toBe('none');
      await send(pg, { type: 'hubShow', payload: { section: 'about', chatTitle: 'Refactor' } });
      expect(await pg.$eval('body', (el) => el.classList.contains('hub-unbound'))).toBe(false);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('stacks the nav above the section in a narrow tab', async () => {
    const pg = await openPage('hub');
    try {
      await pg.setViewportSize({ width: 400, height: 700 });
      const nav = await pg.$eval('#hub-nav', (el) => el.getBoundingClientRect().bottom);
      const panel = await pg.$eval('#settings-panel', (el) => el.getBoundingClientRect().top);
      expect(panel).toBeGreaterThanOrEqual(nav);
      expect(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('unbound, Settings and Personas are out of keyboard reach too', async () => {
    const pg = await openPage('hub');
    try {
      const canFocus = (sel: string) => pg.$eval(sel, (el) => {
        const c = el.querySelector('select, input, button') as HTMLElement;
        c.focus();
        const ok = document.activeElement === c;
        c.blur();
        return ok;
      });
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: null } });
      expect(await canFocus('#settings-panel')).toBe(false);
      await pg.click('.hub-nav-item[data-hub-section="agents"]');
      expect(await canFocus('#agent-config-panel')).toBe(false);
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
      expect(await canFocus('#settings-panel')).toBe(true);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows the feedback the host mirrors to it (settingsError, badgeShareCopied)', async () => {
    const pg = await openPage('hub');
    try {
      const shown = (text: string) => pg.evaluate((t) => Array.from(document.querySelectorAll('body *'))
        .some((el) => el.children.length === 0 && (el.textContent || '').includes(t) && el.getClientRects().length > 0), text);
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
      await send(pg, { type: 'settingsError', payload: { error: 'Invalid Codex profile name' } });
      expect(await shown('Invalid Codex profile name')).toBe(true);
      await send(pg, { type: 'badgeShareCopied' });
      expect(await shown('Badge share text copied')).toBe(true);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('boots both views without throwing', async () => {
    expect(pageErrors).toEqual([]);
  });
});
