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
    .replace('<script nonce="n" src="{{agentMapJsUri}}"></script>', () => `<script>${read('media/chat/agentMap.js')}</script>`)
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
  // Boot ends with uiReady, posted in the NEXT animation frame. Under load that
  // frame can land after a test's clearPosted and read as a post of its own.
  await pg.waitForFunction(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted
    .some((m) => m.type === 'uiReady'));
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
      // Before the host's first hubShow, the label claims nothing either way.
      expect(await pg.textContent('#hub-binding')).toBe('');
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
      expect(await pg.$$eval('.hub-nav-item[aria-current="page"]', (els) => els.map((e) => e.getAttribute('data-hub-section'))))
        .toEqual(['badges']);
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
      // Plan 39: Plugins, like Connections, is its own tab.
      await clearPosted(pg);
      await pg.click('.hub-nav-item[data-hub-plugins]');
      expect((await posted(pg)).map((m) => m.type)).toContain('openPlugins');
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
      expect(await pg.$eval('#settings-panel select', (el) => getComputedStyle(el).pointerEvents)).toBe('none');
      expect(await pg.$eval('#agent-config-panel button', (el) => getComputedStyle(el).pointerEvents)).toBe('none');
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

  it.skipIf(CHROMIUM_UNAVAILABLE)('unbound, a long section still scrolls — read-only, not cut off', async () => {
    const pg = await openPage('hub');
    try {
      await pg.setViewportSize({ width: 900, height: 300 });
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: null } });
      const dims = await pg.$eval('#settings-panel', (el) => [el.scrollHeight, el.clientHeight]);
      expect(dims[0]).toBeGreaterThan(dims[1]);
      const box = (await pg.$eval('#settings-panel', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }));
      await pg.mouse.move(box.x, box.y);
      await pg.mouse.wheel(0, 400);
      await pg.waitForFunction(() => document.getElementById('settings-panel')!.scrollTop > 0, undefined, { timeout: 2000 });
      expect(await pg.$eval('#settings-panel', (el) => el.scrollTop)).toBeGreaterThan(0);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('unbound with nothing cached, Badges says why instead of spinning', async () => {
    const pg = await openPage('hub');
    try {
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: null } });
      await clearPosted(pg);
      await pg.click('.hub-nav-item[data-hub-section="badges"]');
      expect(await pg.$eval('#badges-spinner', (el) => getComputedStyle(el).display)).toBe('none');
      expect(await pg.textContent('#badges-grid')).toMatch(/Open this tab from a chat/);
      expect((await posted(pg)).map((m) => m.type)).not.toContain('requestBadges');
      // Cached from an earlier chat: readable, and sharing says why it can't.
      await send(pg, { type: 'badgesUpdate', payload: { badges: [{ id: 'b1', name: 'First', icon: '*', tier: 'bronze', unlocked: true, unlockedAt: 0 }], counts: { unlocked: 1, total: 1 } } });
      await clearPosted(pg);
      await pg.click('#badges-grid .badge-item');
      expect((await posted(pg)).map((m) => m.type)).not.toContain('getBadgeShareText');
      expect(await pg.$$eval('.mysti-toast', (els) => els.map((e) => e.textContent))).toContain('Open this tab from a chat to share a badge');
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

  it.skipIf(CHROMIUM_UNAVAILABLE)("Shift+Tab never changes its chat's trust level", async () => {
    // The tab has no trust pill: the chat's Shift+Tab rung cycle would change
    // mode/access (up to full-access) with nothing on screen to show it.
    const pg = await openPage('hub', { settings: { ...INITIAL_SETTINGS, mode: 'edit-automatically' } });
    try {
      await send(pg, { type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
      await pg.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
      await clearPosted(pg);
      await pg.keyboard.press('Shift+Tab');
      expect(await posted(pg)).toEqual([]);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a chat with no personas or skills configured clears the previous chat’s', async () => {
    const lists = {
      availablePersonas: [{ id: 'architect', name: 'Architect', description: '' }],
      availableSkills: [{ id: 'tdd', name: 'TDD', description: '' }],
    };
    const pg = await openPage('hub', { ...lists, agentConfig: { personaId: 'architect', enabledSkills: ['tdd'] } });
    try {
      const shown = () => pg.$$eval('#persona-grid .persona-card.selected, #skills-list .skill-item.active',
        (els) => els.map((e) => (e as HTMLElement).dataset.persona || (e as HTMLElement).dataset.skill));
      expect(await shown()).toEqual(['architect', 'tdd']);
      // Rebound (or followed) to a conversation never configured: the host's
      // `agentConfig: undefined` does not survive JSON, so the key is absent.
      await send(pg, { type: 'initialState', payload: { settings: { ...INITIAL_SETTINGS }, context: [], ...lists } });
      expect(await shown()).toEqual([]);
      await send(pg, { type: 'hubShow', payload: { section: 'agents', chatTitle: 'Refactor' } });
      await clearPosted(pg);
      await pg.click('#skills-list .skill-item');
      expect((await posted(pg)).filter((m) => m.type === 'updateAgentConfig')).toEqual([
        expect.objectContaining({ payload: { personaId: null, enabledSkills: ['tdd'] } }),
      ]);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('personas, skills and badges work from the keyboard', async () => {
    const pg = await openPage('hub', {
      availablePersonas: [{ id: 'architect', name: 'Architect', description: '' }],
      availableSkills: [{ id: 'tdd', name: 'TDD', description: '' }],
    });
    try {
      await send(pg, { type: 'hubShow', payload: { section: 'agents', chatTitle: 'Fix login' } });
      const card = '#persona-grid .persona-card';
      const skill = '#skills-list .skill-item';
      expect(await pg.$eval(card, (el) => [el.getAttribute('role'), el.getAttribute('aria-pressed')])).toEqual(['button', 'false']);
      await pg.focus(card);
      await pg.keyboard.press('Enter');
      expect(await pg.$eval(card, (el) => el.getAttribute('aria-pressed'))).toBe('true');
      await pg.focus(skill);
      await pg.keyboard.press(' ');
      expect(await pg.$eval(skill, (el) => el.getAttribute('aria-pressed'))).toBe('true');
      await send(pg, { type: 'hubShow', payload: { section: 'badges', chatTitle: 'Fix login' } });
      await send(pg, { type: 'badgesUpdate', payload: { badges: [{ id: 'b1', name: 'First', icon: '*', tier: 'bronze', unlocked: true, unlockedAt: 0 }], counts: { unlocked: 1, total: 1 } } });
      await clearPosted(pg);
      await pg.focus('#badges-grid .badge-item');
      await pg.keyboard.press('Enter');
      expect((await posted(pg)).map((m) => m.type)).toContain('getBadgeShareText');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('the agent map lives in the chat only, never in the tab', async () => {
    const delegation = { type: 'toolUse', payload: { id: 'd1', name: 'delegate', input: { agent: 'openai-codex', task: 'Fix it' } } };
    const pillShown = (pg: Page) => pg.$eval('#agent-map-pill', (e) => getComputedStyle(e).display !== 'none');
    const chat = await openPage('chat');
    await send(chat, { type: 'responseStarted', payload: { provider: 'mysti' } });
    await send(chat, delegation);
    expect(await pillShown(chat)).toBe(true);
    const hub = await openPage('hub');
    await send(hub, { type: 'responseStarted', payload: { provider: 'mysti' } });
    await send(hub, delegation);
    expect(await pillShown(hub)).toBe(false);
    expect((await posted(hub)).some((m) => m.type === 'requestJobs')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('boots both views without throwing', async () => {
    expect(pageErrors).toEqual([]);
  });
});

describe('Plan 31 — settingsSync keeps the chat and the tab in step', () => {
  async function sendFromComposer(pg: Page, text: string): Promise<Record<string, unknown>> {
    await clearPosted(pg);
    await pg.fill('#message-input', text);
    await pg.keyboard.press('Enter');
    const sends = (await posted(pg)).filter((m) => m.type === 'sendMessage');
    expect(sends).toHaveLength(1);
    return (sends[0].payload as { settings: Record<string, unknown> }).settings;
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)("a change made in the tab rides the chat's next send", async () => {
    const pg = await openPage('chat');
    try {
      await send(pg, { type: 'settingsSync', payload: {
        thinkingLevel: 'high', mode: 'default', accessLevel: 'full-access', effortLevel: 'low', contextMode: 'manual',
      } });
      expect(await pg.$eval('#thinking-select', (el) => (el as HTMLSelectElement).value)).toBe('high');
      const settings = await sendFromComposer(pg, 'hello');
      expect(settings).toMatchObject({
        thinkingLevel: 'high', mode: 'default', accessLevel: 'full-access', effortLevel: 'low', contextMode: 'manual',
      });
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('an agent chosen in the tab becomes the chat agent', async () => {
    const pg = await openPage('chat');
    try {
      await send(pg, { type: 'settingsSync', payload: { provider: 'openai-codex' } });
      const settings = await sendFromComposer(pg, 'hello');
      expect(settings.provider).toBe('openai-codex');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('updates the nested rows, and applying it posts nothing back', async () => {
    const pg = await openPage('hub', {
      permissionSettings: { timeoutBehavior: 'auto-reject', semiAutonomousTimeout: 60 },
      brainstormStrategy: 'quick',
    });
    try {
      await clearPosted(pg);
      await send(pg, { type: 'settingsSync', payload: {
        'permission.timeoutBehavior': 'auto-accept', 'semiAutonomous.timeout': 90, 'brainstorm.strategy': 'debate',
      } });
      expect(await pg.$eval('#timeout-behavior-select', (el) => (el as HTMLSelectElement).value)).toBe('auto-accept');
      expect(await pg.$eval('#semi-auto-timeout-input', (el) => (el as HTMLInputElement).value)).toBe('90');
      expect(await pg.$eval('#brainstorm-strategy-select', (el) => (el as HTMLSelectElement).value)).toBe('debate');
      expect(await posted(pg)).toEqual([]);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('initialState still reports the autonomy level exactly once', async () => {
    const pg = await openPage('chat', { permissionSettings: { timeoutBehavior: 'auto-reject', semiAutonomousTimeout: 60 } });
    try {
      expect((await posted(pg)).filter((m) => m.type === 'autonomyLevelChanged')).toHaveLength(1);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('ignores a malformed payload', async () => {
    const pg = await openPage('chat');
    try {
      await send(pg, { type: 'settingsSync', payload: null });
      await send(pg, { type: 'settingsSync', payload: 'thinkingLevel' });
      const settings = await sendFromComposer(pg, 'hello');
      expect(settings.thinkingLevel).toBe('none');
    } finally { await pg.context().close(); }
  }, 30000);

  const CATALOG = { providers: [{ name: 'claude-code', models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }] }] };
  const pickers = (pg: Page): Promise<string[]> => pg.$$eval(['#model-select', '#model-select-inline'].join(','),
    (els) => els.map((el) => (el as HTMLSelectElement).value));

  it.skipIf(CHROMIUM_UNAVAILABLE)("a model picked on the other side is the one the chat's next send carries", async () => {
    const pg = await openPage('chat', { ...CATALOG, settings: { ...INITIAL_SETTINGS, model: 'sonnet' } });
    try {
      await send(pg, { type: 'settingsSync', payload: { model: 'opus', customModel: '' } });
      expect(await pickers(pg)).toEqual(['opus', 'opus']);
      expect((await sendFromComposer(pg, 'hello')).model).toBe('opus');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('an unrelated sync keeps a settled model that is not in the catalog', async () => {
    const pg = await openPage('chat', { ...CATALOG, settings: { ...INITIAL_SETTINGS, model: 'sonnet' } });
    try {
      await send(pg, { type: 'modelChanged', payload: { model: 'claude-special-1' } });
      expect(await pickers(pg)).toEqual(['claude-special-1', 'claude-special-1']);
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'high' } });
      expect(await pickers(pg)).toEqual(['claude-special-1', 'claude-special-1']);
      expect((await sendFromComposer(pg, 'hello')).model).toBe('claude-special-1');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a custom model cleared on the other side leaves Custom…', async () => {
    const pg = await openPage('chat', { ...CATALOG, settings: { ...INITIAL_SETTINGS, model: 'opus' },
      providerSettings: { customModel: 'bar', codexProfile: '' } });
    try {
      expect(await pg.$eval('#model-select', (el) => (el as HTMLSelectElement).value)).toBe('__custom__');
      await send(pg, { type: 'settingsSync', payload: { customModel: '' } });
      expect(await pg.$eval('#model-select', (el) => (el as HTMLSelectElement).value)).toBe('opus');
      expect(await pg.$eval('#custom-model-section', (el) => el.classList.contains('hidden'))).toBe(true);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a custom model typed here is not repainted back by a later sync', async () => {
    const pg = await openPage('chat', { ...CATALOG, providerSettings: { customModel: 'bar', codexProfile: '' } });
    try {
      await pg.$eval('#custom-model-input', (el) => {
        (el as HTMLInputElement).value = 'foo';
        el.dispatchEvent(new Event('change'));
      });
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'high' } });
      expect(await pg.$eval('#custom-model-input', (el) => (el as HTMLInputElement).value)).toBe('foo');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a stock model picked here is not flipped back to Custom… by a later sync', async () => {
    const pg = await openPage('chat', { ...CATALOG, providerSettings: { customModel: 'bar', codexProfile: '' } });
    try {
      await pg.$eval('#model-select', (el) => {
        (el as HTMLSelectElement).value = 'opus';
        el.dispatchEvent(new Event('change'));
      });
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'high' } });
      expect(await pickers(pg)).toEqual(['opus', 'opus']);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)("a provider setting changed on the other side repaints the provider's section", async () => {
    const pg = await openPage('chat', {
      settings: { ...INITIAL_SETTINGS, provider: 'openai-codex' },
      providerManifest: { schemaVersion: 1, providers: [{ id: 'openai-codex',
        settingsSections: [{ id: 'profile', label: 'Profile', type: 'text', settingKey: 'codexProfile' }] }] },
      providerSettings: { customModel: '', codexProfile: 'old' },
    });
    try {
      expect(await pg.$eval('#provider-settings-sections input', (el) => (el as HTMLInputElement).value)).toBe('old');
      await send(pg, { type: 'settingsSync', payload: { codexProfile: 'work' } });
      expect(await pg.$eval('#provider-settings-sections input', (el) => (el as HTMLInputElement).value)).toBe('work');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('timeout, semi-auto timeout and token limit changed here survive an unrelated sync', async () => {
    const pg = await openPage('hub', {
      permissionSettings: { timeoutBehavior: 'auto-reject', semiAutonomousTimeout: 60 },
      agentSettings: { autoSuggest: true, maxTokenBudget: 4000, showSuggestions: true },
    });
    try {
      await pg.$eval('#timeout-behavior-select', (el) => {
        (el as HTMLSelectElement).value = 'auto-accept';
        el.dispatchEvent(new Event('change'));
      });
      await pg.$eval('#semi-auto-timeout-input', (el) => {
        (el as HTMLInputElement).value = '120';
        el.dispatchEvent(new Event('change'));
      });
      await clearPosted(pg);
      await pg.click('#token-limit-toggle');
      expect(await posted(pg)).toEqual([expect.objectContaining({ payload: { 'agents.maxTokenBudget': 0 } })]);
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'high' } });
      expect(await pg.$eval('#timeout-behavior-select', (el) => (el as HTMLSelectElement).value)).toBe('auto-accept');
      expect(await pg.$eval('#semi-auto-timeout-input', (el) => (el as HTMLInputElement).value)).toBe('120');
      expect(await pg.$eval('#token-limit-toggle', (el) => el.classList.contains('active'))).toBe(false);
      // Turning the limit back on still restores the budget it had.
      await clearPosted(pg);
      await pg.click('#token-limit-toggle');
      expect(await posted(pg)).toEqual([expect.objectContaining({ payload: { 'agents.maxTokenBudget': 4000 } })]);
    } finally { await pg.context().close(); }
  }, 30000);

  const autonomyRows = (pg: Page): Promise<boolean[]> => pg.$$eval(['#manual-timeout-section', '#semi-auto-settings'].join(','),
    (els) => els.map((el) => !el.classList.contains('hidden')));

  it.skipIf(CHROMIUM_UNAVAILABLE)('the tab offers the semi-autonomous row, not the manual one, while the chat runs semi-autonomous', async () => {
    const visible = autonomyRows;
    const pg = await openPage('hub', {
      permissionSettings: { timeoutBehavior: 'semi-autonomous', semiAutonomousTimeout: 60 }, autonomyLevel: 'semi-autonomous',
    });
    try {
      expect(await visible(pg)).toEqual([false, true]);
      await send(pg, { type: 'settingsSync', payload: { 'permission.timeoutBehavior': 'auto-reject' } });
      expect(await visible(pg)).toEqual([true, false]);
      await send(pg, { type: 'settingsSync', payload: { 'permission.timeoutBehavior': 'semi-autonomous' } });
      expect(await visible(pg)).toEqual([false, true]);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('a half-finished custom model edit survives an unrelated sync', async () => {
    const pg = await openPage('hub', { ...CATALOG, settings: { ...INITIAL_SETTINGS, model: 'sonnet' } });
    try {
      await pg.$eval('#model-select', (el) => {
        (el as HTMLSelectElement).value = '__custom__';
        el.dispatchEvent(new Event('change'));
      });
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'high' } });
      expect(await pg.$eval('#model-select', (el) => (el as HTMLSelectElement).value)).toBe('__custom__');
      expect(await pg.$eval('#custom-model-section', (el) => el.classList.contains('hidden'))).toBe(false);
      await pg.fill('#custom-model-input', 'my-mod');
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'low' } });
      expect(await pg.$eval('#custom-model-input', (el) => (el as HTMLInputElement).value)).toBe('my-mod');
      expect(await pg.evaluate(() => document.activeElement && document.activeElement.id)).toBe('custom-model-input');
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)("the tab shows its chat's own autonomy level, not the global config's", async () => {
    // Config still says semi-autonomous (set by another chat, or before a
    // reload), but the chat this tab acts for boots manual.
    const pg = await openPage('hub', {
      permissionSettings: { timeoutBehavior: 'semi-autonomous', semiAutonomousTimeout: 60 }, autonomyLevel: 'manual',
    });
    try {
      expect(await autonomyRows(pg)).toEqual([true, false]);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('an unrelated sync keeps edits not yet committed here', async () => {
    const pg = await openPage('hub', {
      settings: { ...INITIAL_SETTINGS, provider: 'openai-codex' },
      providerManifest: { schemaVersion: 1, providers: [
        { id: 'claude-code', displayName: 'Claude Code', color: '#000' },
        { id: 'openai-codex', displayName: 'Codex', color: '#000',
          settingsSections: [{ id: 'profile', label: 'Profile', type: 'text', settingKey: 'codexProfile' }] },
      ] },
      providerSettings: { customModel: '', codexProfile: 'old' },
      brainstormAgents: ['claude-code', 'openai-codex'],
      permissionSettings: { timeoutBehavior: 'semi-autonomous', semiAutonomousTimeout: 60 }, autonomyLevel: 'semi-autonomous',
    });
    try {
      // Typed but not committed: no change event yet (a second fill would blur, and commit, the first).
      await pg.$eval('#provider-settings-sections input', (el) => { (el as HTMLInputElement).value = 'half'; });
      await pg.$eval('#semi-auto-timeout-input', (el) => { (el as HTMLInputElement).value = '12'; });
      // One box unticked on the way to picking another — not posted until two are ticked.
      await pg.$eval('input[name="brainstorm-agent"][value="claude-code"]', (el) => {
        (el as HTMLInputElement).checked = false;
        el.dispatchEvent(new Event('change'));
      });
      await send(pg, { type: 'settingsSync', payload: { thinkingLevel: 'high' } });
      expect(await pg.$eval('#provider-settings-sections input', (el) => (el as HTMLInputElement).value)).toBe('half');
      expect(await pg.$eval('#semi-auto-timeout-input', (el) => (el as HTMLInputElement).value)).toBe('12');
      expect(await pg.$eval('input[name="brainstorm-agent"][value="claude-code"]', (el) => (el as HTMLInputElement).checked)).toBe(false);
    } finally { await pg.context().close(); }
  }, 30000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('still boots both views without throwing', async () => {
    expect(pageErrors).toEqual([]);
  });
});
