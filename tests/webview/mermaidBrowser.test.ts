/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'media/chat/index.html'), 'utf8');
const csp = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0]
  .replaceAll('{{cspSource}}', "'self'").replaceAll('{{nonce}}', 'mermaid-test');
if (!csp) { throw new Error('Cannot find the shipped chat CSP'); }

let browser: Browser | undefined;

async function render(code: string): Promise<Page> {
  const page = await browser!.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
  await page.route('https://mysti.test/**', async route => {
    if (new URL(route.request().url()).pathname === '/mermaid.js') {
      await route.fulfill({ contentType: 'application/javascript',
        body: fs.readFileSync(path.join(root, 'resources/mermaid.min.js')) });
      return;
    }
    if (new URL(route.request().url()).pathname === '/markdownRenderer.js') {
      await route.fulfill({ contentType: 'application/javascript',
        body: fs.readFileSync(path.join(root, 'media/chat/markdownRenderer.js')) });
      return;
    }
    if (new URL(route.request().url()).pathname !== '/') { await route.abort(); return; }
    // The real chat template declares UTF-8. Without it Chromium decodes the
    // generated vendor's Unicode identifiers as Windows-1252 before parsing JS.
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8">${csp}</head>
      <body><div id="diagram" class="mermaid-pending"></div>
      <script nonce="mermaid-test" src="/markdownRenderer.js"></script>
      <script nonce="mermaid-test">window.renderer = window.MystiMarkdownRenderer.create({
        document, mermaidUri: '/mermaid.js', getMermaid: () => window.mermaid
      });</script></body></html>` });
  });
  await page.goto('https://mysti.test/');
  await page.evaluate(source => {
    document.getElementById('diagram')!.textContent = source;
    (window as unknown as { renderer: { renderDiagrams(): Promise<void> } }).renderer.renderDiagrams();
  }, code);
  try {
    await page.waitForSelector('#diagram.mermaid-rendered svg', { timeout: 20_000 });
  } catch (error) {
    await page.close();
    throw new Error(`Shipped Mermaid did not render: ${errors.join('\n')}`, { cause: error });
  }
  return page;
}

describe('shipped Mermaid in the chat renderer', () => {
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  });
  afterAll(async () => { await browser?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('lazy loads and renders a flowchart under the shipped CSP', async () => {
    const page = await render('flowchart LR\n  Input --> Validate\n  Validate --> Save');
    try {
      const diagram = await page.locator('#diagram svg').textContent();
      expect(diagram).toContain('Input');
      expect(diagram).toContain('Validate');
      expect(diagram).toContain('Save');
      expect(await page.locator('#diagram .mermaid-error').count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps sequence diagram rendering available after a vendor update', async () => {
    const page = await render('sequenceDiagram\n  User->>Mysti: Review changes\n  Mysti-->>User: Ready');
    try {
      const diagram = await page.locator('#diagram svg').textContent();
      expect(diagram).toContain('Review changes');
      expect(diagram).toContain('Ready');
    } finally { await page.close(); }
  }, 30_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('sanitizes HTML labels before inserting the returned SVG', async () => {
    const page = await render('flowchart LR\n  A["<img src=x onerror=window.__mermaidInjected=true>"] --> B["<a href=javascript:alert(1)>Continue</a>"]');
    try {
      const unsafeAttributes = await page.locator('#diagram').evaluate(element =>
        [...element.querySelectorAll('*')].flatMap(child => [...child.attributes]
          .filter(attribute => /^on/i.test(attribute.name)
            || /^(?:href|xlink:href)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value))
          .map(attribute => `${attribute.name}=${attribute.value}`)));
      expect(unsafeAttributes).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __mermaidInjected?: boolean }).__mermaidInjected))
        .toBeUndefined();
      expect(await page.locator('#diagram script').count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);
});
