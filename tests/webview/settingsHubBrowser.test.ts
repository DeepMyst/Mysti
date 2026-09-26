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
