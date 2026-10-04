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
 * Plan 45: the Manage Plugins tab, in headless Chromium, under its REAL
 * Content-Security-Policy (the nonce'd scripts are injected, nothing else is
 * allowed). The host sends `state`; the page renders it and posts the user's
 * clicks back. Marketplace text is untrusted and must render as text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let browser: Browser | undefined;
const dirs: string[] = [];
const pageErrors: string[] = [];

function composeHtml(): string {
  const stub = `<script nonce="n">
    window.__posted = [];
    window.acquireVsCodeApi = function () {
      return { postMessage: function (m) { window.__posted.push(m); }, getState: function () {}, setState: function () {} };
    };
  </script>`;
  const tag = '<script nonce="{{nonce}}" src="{{scriptUri}}"></script>';
  const html = read('media/plugins/index.html');
  if (!html.includes(tag)) { throw new Error('script tag not found: harness is out of date with index.html'); }
  return html
    .replace(tag, () => `${stub}<script nonce="n">${read('media/plugins/plugins.js')}</script>`)
    .replace('<link rel="stylesheet" href="{{styleUri}}" />', () => `<style>${read('media/plugins/plugins.css')}</style>`)
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace(/\{\{cspSource\}\}/g, "'self'");
}

const BACKENDS = [
  { id: 'claude-code', name: 'Claude Code', status: 'ok', version: '2.1.278' },
  { id: 'openai-codex', name: 'Codex', status: 'note', note: 'Manage Codex plugins with /plugins inside Codex.' },
  { id: 'hermes', name: 'Hermes', status: 'missing' },
  { id: 'continue', name: 'Continue', status: 'none' },
];

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backends: BACKENDS,
    selected: 'claude-code',
    scopes: ['user', 'project', 'local'],
    can: { toggle: true, update: true, uninstall: true, details: true, marketplaces: true, search: false },
    trusted: true,
    loading: false,
    listing: {
      installed: [
        { id: 'superpowers@claude-plugins-official', name: 'superpowers', marketplace: 'claude-plugins-official', version: '6.4.1', scope: 'user', enabled: true },
        { id: 'playwright@claude-plugins-official', name: 'playwright', marketplace: 'claude-plugins-official', scope: 'user', enabled: false },
      ],
      available: [
        { id: 'context7@claude-plugins-official', name: 'context7', marketplace: 'claude-plugins-official', description: 'Docs lookup', installCount: 454347 },
        { id: 'commit-commands@claude-plugins-official', name: 'commit-commands', marketplace: 'claude-plugins-official', description: 'Commit workflows' },
      ],
    },
    markets: [{ name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official' }, { name: 'core', source: 'built in', builtin: true }],
    busy: {},
    rowErrors: {},
    ...over,
  };
}

async function send(pg: Page, s: Record<string, unknown>): Promise<void> {
  await pg.evaluate((st) => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: st } })); }, s);
}

async function posted(pg: Page): Promise<Array<Record<string, unknown>>> {
  return pg.evaluate(() => (window as unknown as { __posted: Array<Record<string, unknown>> }).__posted);
}

async function openPage(s: Record<string, unknown> = state()): Promise<Page> {
  const ctx = await browser!.newContext();
  const pg = await ctx.newPage();
  pg.on('pageerror', (err) => pageErrors.push(String(err)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-plugins-'));
  dirs.push(dir);
  const file = path.join(dir, 'plugins.html');
  fs.writeFileSync(file, composeHtml(), 'utf8');
  await pg.setViewportSize({ width: 1000, height: 800 });
  await pg.goto(`file://${file}`, { waitUntil: 'load' });
  await send(pg, s);
  return pg;
}

const ids = (pg: Page, list: string) => pg.$$eval(`#${list} > li`, (lis) => lis.map((li) => (li as HTMLElement).dataset.id));

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
  for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
});

describe('Plan 45 — Manage Plugins tab', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('says it is ready, then renders what the host sent', async () => {
    const pg = await openPage();
    expect((await posted(pg))[0]).toEqual({ type: 'ready' });
    expect(await ids(pg, 'installed')).toEqual(['superpowers@claude-plugins-official', 'playwright@claude-plugins-official']);
    expect(await ids(pg, 'available')).toEqual(['context7@claude-plugins-official', 'commit-commands@claude-plugins-official']);
    expect(await pg.$eval('#backend', (s) => (s as HTMLSelectElement).value)).toBe('claude-code');
    expect(pageErrors).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('lists every backend, says why one cannot be used, and posts a switch', async () => {
    const pg = await openPage();
    const options = await pg.$$eval('#backend option', (os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent, (o as HTMLOptionElement).disabled]));
    expect(options.find((o) => o[0] === 'continue')).toEqual(['continue', expect.stringContaining('no plugin system'), true]);
    expect(options.find((o) => o[0] === 'hermes')?.[1]).toContain('CLI not found');
    await pg.selectOption('#backend', 'openai-codex');
    expect((await posted(pg)).pop()).toEqual({ type: 'select', backend: 'openai-codex' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows only the note for a backend Mysti cannot drive', async () => {
    const pg = await openPage(state({ selected: 'openai-codex', note: 'Manage Codex plugins with /plugins inside Codex.', listing: undefined, markets: undefined, can: {}, scopes: [] }));
    expect(await pg.$eval('#note', (n) => n.textContent)).toContain('/plugins inside Codex');
    expect(await pg.$eval('#main', (m) => (m as HTMLElement).hidden)).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('search filters both lists', async () => {
    const pg = await openPage();
    await pg.fill('#search', 'play');
    expect(await ids(pg, 'installed')).toEqual(['playwright@claude-plugins-official']);
    expect(await ids(pg, 'available')).toEqual([]);
    await pg.fill('#search', 'commit');
    expect(await ids(pg, 'available')).toEqual(['commit-commands@claude-plugins-official']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('renders at most 100 rows and says how many more there are', async () => {
    const available = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}@m`, name: `p${i}`, marketplace: 'm' }));
    const pg = await openPage(state({ listing: { installed: [], available } }));
    expect(await pg.$$eval('#available > li', (l) => l.length)).toBe(100);
    expect(await pg.$eval('#more', (m) => m.textContent)).toContain('50 more');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('renders marketplace text as text, never as markup', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const pg = await openPage(state({ listing: { installed: [], available: [{ id: 'x@m', name: evil, marketplace: 'm', description: evil }] } }));
    expect(await pg.$$eval('#available img', (i) => i.length)).toBe(0);
    expect(await pg.$eval('#available > li', (li) => li.textContent)).toContain('<img src=x');
    expect(await pg.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('asks where to install, with project scopes off in an untrusted workspace', async () => {
    const pg = await openPage(state({ trusted: false }));
    await pg.click('#available > li[data-id="context7@claude-plugins-official"] [data-action="install"]');
    const scopes = await pg.$$eval('#available [data-scope]', (bs) => bs.map((b) => [(b as HTMLElement).dataset.scope, (b as HTMLButtonElement).disabled]));
    expect(scopes).toEqual([['user', false], ['project', true], ['local', true]]);
    await pg.click('#available [data-scope="user"]');
    expect((await posted(pg)).pop()).toEqual({ type: 'install', id: 'context7@claude-plugins-official', scope: 'user' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('installs straight away when there is only one scope', async () => {
    const pg = await openPage(state({ scopes: ['user'] }));
    await pg.click('#available > li[data-id="commit-commands@claude-plugins-official"] [data-action="install"]');
    expect((await posted(pg)).pop()).toEqual({ type: 'install', id: 'commit-commands@claude-plugins-official', scope: 'user' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the switch turns a plugin off', async () => {
    const pg = await openPage();
    const sw = '#installed > li[data-id="superpowers@claude-plugins-official"] [role="switch"]';
    expect(await pg.$eval(sw, (b) => b.getAttribute('aria-checked'))).toBe('true');
    await pg.click(sw);
    expect((await posted(pg)).pop()).toEqual({ type: 'setEnabled', id: 'superpowers@claude-plugins-official', scope: 'user', on: false });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows a row busy, a row error, the banner and a panel error', async () => {
    const pg = await openPage(state({
      busy: { 'superpowers@claude-plugins-official': 'Updating…' },
      rowErrors: { 'context7@claude-plugins-official': 'Plugin "context7" not found' },
      banner: 'Installed x for you. It applies from your next message in Claude Code chats.',
      error: "Couldn't read Claude Code's plugin list.",
    }));
    expect(await pg.$eval('#installed > li[data-id="superpowers@claude-plugins-official"]', (li) => li.textContent)).toContain('Updating…');
    expect(await pg.$eval('#available > li[data-id="context7@claude-plugins-official"] .row-error', (e) => e.textContent)).toContain('not found');
    expect(await pg.$eval('#banner', (b) => b.textContent)).toContain('next message');
    expect(await pg.$eval('#error', (e) => e.textContent)).toContain("Couldn't read");
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('manages marketplaces, never offering to remove a built-in one', async () => {
    const pg = await openPage();
    await pg.click('[role="tab"][data-tab="marketplaces"]');
    expect(await pg.$$eval('#markets > li[data-name="core"] [data-action="remove"]', (b) => b.length)).toBe(0);
    await pg.click('#markets > li[data-name="claude-plugins-official"] [data-action="refresh"]');
    expect((await posted(pg)).pop()).toEqual({ type: 'refreshMarketplace', name: 'claude-plugins-official' });
    await pg.fill('#mkt-source', 'owner/repo');
    await pg.click('#mkt-add');
    expect((await posted(pg)).pop()).toEqual({ type: 'addMarketplace', source: 'owner/repo' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('asks the host to search when the catalog only answers a query', async () => {
    const pg = await openPage(state({ can: { toggle: true, search: true }, listing: { installed: [] } }));
    await pg.fill('#search', 'memory');
    await pg.waitForFunction(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted.some((m) => m.type === 'search'));
    expect((await posted(pg)).filter((m) => m.type === 'search').pop()).toEqual({ type: 'search', query: 'memory' });
    await send(pg, state({ can: { toggle: true, search: true }, listing: { installed: [] }, search: { query: 'memory', results: [{ id: 'clawhub:mem', name: 'Memory', marketplace: 'ClawHub' }] } }));
    expect(await ids(pg, 'available')).toEqual(['clawhub:mem']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows details text the host returned', async () => {
    const pg = await openPage(state({ details: { id: 'superpowers@claude-plugins-official', text: 'Skills (15)\nHooks (1)' } }));
    expect(await pg.$eval('#installed > li[data-id="superpowers@claude-plugins-official"] pre', (p) => p.textContent)).toContain('Skills (15)');
    await pg.click('#installed > li[data-id="playwright@claude-plugins-official"] summary');
    await pg.click('#installed > li[data-id="playwright@claude-plugins-official"] [data-action="details"]');
    expect((await posted(pg)).pop()).toEqual({ type: 'details', id: 'playwright@claude-plugins-official', scope: 'user' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('does not offer a search result that is already installed under its runtime id (review M5)', async () => {
    const listing = { installed: [{ id: 'memory-lancedb', name: 'Memory LanceDB', scope: 'user', enabled: true }] };
    const results = [{ id: 'clawhub:@openclaw/memory-lancedb', name: 'Memory LanceDB', installedAs: 'memory-lancedb' }, { id: 'clawhub:other', name: 'Other' }];
    const pg = await openPage(state({ can: { toggle: true, search: true }, listing, search: { query: 'memory', results } }));
    await pg.fill('#search', 'memory');
    expect(await ids(pg, 'available')).toEqual(['clawhub:other']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('does not claim there are no marketplaces when they could not be read (review M8)', async () => {
    const pg = await openPage(state({ markets: undefined, error: "Couldn't read the marketplaces: offline" }));
    await pg.click('[role="tab"][data-tab="marketplaces"]');
    expect(await pg.$eval('#markets-empty', (e) => (e as HTMLElement).hidden)).toBe(true);
    expect(await pg.$eval('#error', (e) => e.textContent)).toContain('offline');
  });

  // ── Phase 2 ──────────────────────────────────────────────────────────────

  const sourceState = (over: Record<string, unknown> = {}) => state({
    can: { toggle: true, update: true, uninstall: true, list: true, install: false, installSource: true },
    scopes: ['user', 'project'],
    sourceHint: { label: 'Git repository URL or local path', placeholder: 'https://github.com/owner/extension' },
    listing: { installed: [] },
    markets: undefined,
    ...over,
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('installs from a typed source, asking where when there are two scopes', async () => {
    const pg = await openPage(sourceState());
    expect(await pg.$eval('#source-label', (l) => l.textContent)).toBe('Git repository URL or local path');
    expect(await pg.$eval('#source-input', (i) => (i as HTMLInputElement).placeholder)).toBe('https://github.com/owner/extension');
    await pg.fill('#source-input', 'https://github.com/o/ext');
    await pg.click('#source-install');
    const scopes = await pg.$$eval('#source-scopes [data-scope]', (bs) => bs.map((b) => (b as HTMLElement).dataset.scope));
    expect(scopes).toEqual(['user', 'project']);
    await pg.click('#source-scopes [data-scope="project"]');
    expect((await posted(pg)).pop()).toEqual({ type: 'installSource', source: 'https://github.com/o/ext', scope: 'project' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('installs a typed source straight away when there is one scope', async () => {
    const pg = await openPage(sourceState({ scopes: ['user'] }));
    await pg.fill('#source-input', 'my-plugin');
    await pg.click('#source-install');
    expect((await posted(pg)).pop()).toEqual({ type: 'installSource', source: 'my-plugin', scope: 'user' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows no catalog section when the backend has no catalog, and no Install buttons when it cannot install', async () => {
    const pg = await openPage(sourceState());
    expect(await pg.$eval('#available-h', (h) => (h as HTMLElement).hidden)).toBe(true);
    const noInstall = await openPage(state({ can: { toggle: true, list: true, install: false } }));
    expect(await noInstall.$$eval('#available [data-action="install"]', (b) => b.length)).toBe(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('never says "Nothing installed" for a backend that cannot list its plugins', async () => {
    const pg = await openPage(state({ can: { marketplaces: true, list: false, install: false }, listing: undefined, note: 'Install plugins with /plugin inside Cursor.' }));
    expect(await pg.$eval('#panel-plugins', (p) => p.textContent)).not.toMatch(/Nothing installed/);
    expect(await pg.$eval('#search', (i) => (i.closest('label') as HTMLElement).hidden)).toBe(true);
    expect(await pg.$eval('#note', (n) => n.textContent)).toContain('/plugin inside Cursor');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows the installed list again after visiting a backend that cannot list', async () => {
    const pg = await openPage(state({ can: { marketplaces: true, list: false, install: false }, listing: undefined }));
    await send(pg, state());
    expect(await pg.$eval('#installed', (u) => (u as HTMLElement).hidden)).toBe(false);
    expect(await ids(pg, 'installed')).toHaveLength(2);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows no switch for an administrator-managed plugin (review M4)', async () => {
    const listing = { installed: [{ id: 'org@m', name: 'org', scope: 'managed', enabled: true }], available: [] };
    const pg = await openPage(state({ listing }));
    expect(await pg.$$eval('#installed [role="switch"]', (b) => b.length)).toBe(0);
    expect(await pg.$eval('#installed > li', (li) => li.textContent)).toContain('Managed');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps keyboard focus on the control you used after the list re-renders (review M9)', async () => {
    const pg = await openPage();
    const sw = '#installed > li[data-id="superpowers@claude-plugins-official"] [role="switch"]';
    await pg.focus(sw);
    await send(pg, state({ busy: {} }));
    expect(await pg.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.closest('li')?.getAttribute('data-id')}|${a.getAttribute('role')}` : 'none';
    })).toBe('superpowers@claude-plugins-official|switch');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('greys out project scopes when no folder is open (review P2-I1)', async () => {
    const pg = await openPage(state({ projectOk: false }));
    await pg.click('#available > li[data-id="context7@claude-plugins-official"] [data-action="install"]');
    const scopes = await pg.$$eval('#available [data-scope]', (bs) => bs.map((b) => [(b as HTMLElement).dataset.scope, (b as HTMLButtonElement).disabled, b.textContent]));
    expect(scopes.map((x) => x.slice(0, 2))).toEqual([['user', false], ['project', true], ['local', true]]);
    expect(String(scopes[1][2])).toMatch(/Open a folder/);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('puts focus back on the switch after its own busy state clears (review P2-m4)', async () => {
    const pg = await openPage();
    const sw = '#installed > li[data-id="superpowers@claude-plugins-official"] [role="switch"]';
    await pg.focus(sw);
    await send(pg, state({ busy: { 'superpowers@claude-plugins-official': 'Turning off…' } }));
    await send(pg, state({ busy: {} }));
    expect(await pg.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.closest('li')?.getAttribute('data-id')}|${a.getAttribute('role')}` : 'none';
    })).toBe('superpowers@claude-plugins-official|switch');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('does not claim "On" when the on/off state is unknown (review P2-m6)', async () => {
    const listing = { installed: [{ id: '/p/x', name: 'x', scope: 'user' }] };
    const pg = await openPage(state({ can: { list: true, toggle: false }, listing }));
    const side = await pg.$$eval('#installed > li .row-side > *', (els) => els.map((e) => e.textContent));
    expect(side).not.toContain('On');
    expect(side).not.toContain('Off');
  });
});
