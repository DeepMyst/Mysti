import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser } from 'playwright';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const root = path.resolve(__dirname, '../..');
const template = fs.readFileSync(path.join(root, 'media/chat/index.html'), 'utf8');
const chat = fs.readFileSync(path.join(root, 'media/chat/chat.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'media/chat/toolCards.js'), 'utf8');
const csp = template.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0]
  .replaceAll('{{cspSource}}', "'self'").replaceAll('{{nonce}}', 'tool-test');
if (!csp) { throw new Error('Missing shipped chat CSP'); }
function block(start: string, end: string): string {
  const a = chat.indexOf(start); const b = chat.indexOf(end, a);
  if (a < 0 || b < a) { throw new Error('Missing shipped tool-card click handler'); }
  return chat.slice(a, b);
}
// Exercise the shipped delegated copy/details handlers without the unrelated
// provider/settings shell. Neither block is reimplemented in this fixture.
const clicks = block('        // Handle copy button click\n', '        // Handle message copy button click')
  + block('        // Handle tool call expand/collapse\n', '        // File Edit Card: Show more button');
let browser: Browser | undefined;

describe('main tool cards under the shipped chat CSP', () => {
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  });
  afterAll(async () => { await browser?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps live/restored details and copy working while hostile IDs/status/markup stay inert', async () => {
    const page = await browser!.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    const violations: string[] = [];
    await page.exposeFunction('reportViolation', (value: string) => { violations.push(value); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mysti.test') { await route.abort(); return; }
      if (url.pathname === '/toolCards.js') {
        await route.fulfill({ contentType: 'application/javascript', body: source }); return;
      }
      if (url.pathname !== '/') { await route.abort(); return; }
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="UTF-8">${csp}</head><body>
        <div id="messages"><div class="message-body"></div></div>
        <script nonce="tool-test" src="/toolCards.js"></script>
        <script nonce="tool-test">
          window.sent = [];
          function postMessageWithPanelId(message) { window.sent.push(message); }
          document.addEventListener('securitypolicyviolation', event => window.reportViolation(event.violatedDirective));
          const messages = document.getElementById('messages');
          window.cards = window.MystiToolCards.create({ document,
            getMessagesElement: () => messages,
            getStreamingBody: () => messages.querySelector('.message-body'),
            cleanPathsInString: value => value, makeRelativePath: value => value,
            onResult: () => {}, scroll: () => {}
          });
          window.cards.begin();
          messages.addEventListener('click', function(e) { ${clicks} });
        </script></body></html>` });
    });
    try {
      await page.goto('https://mysti.test/');
      await page.evaluate(() => {
        const win = window as unknown as { cards: { use(tool: unknown): void; result(tool: unknown): void; build(tool: unknown): HTMLElement } };
        const id = 'x"] .tool-call, [data-id="other';
        const payload = '<img src=x onerror="window.injected=true">';
        win.cards.use({ id, name: payload, input: { path: 'copy this path' }, status: payload });
        win.cards.result({ id, output: payload, status: payload });
        document.querySelector('.message-body')!.appendChild(win.cards.build({ id, name: 'Read', input: { path: 'restored path' }, output: 'restored output', status: 'completed' }));
      });
      expect(await page.locator('.tool-call').count()).toBe(2);
      expect(await page.locator('.tool-call').first().getAttribute('class')).toBe('tool-call failed');
      expect(await page.locator('img, [onerror]').count()).toBe(0);
      for (const index of [0, 1]) {
        const card = page.locator('.tool-call').nth(index);
        await card.locator('.tool-call-header').click();
        expect(await card.getAttribute('class')).toContain('expanded');
        await card.locator('.tool-call-copy').click();
        expect(await card.getAttribute('class')).toContain('expanded');
        await card.locator('.tool-call-header').click();
        expect(await card.getAttribute('class')).not.toContain('expanded');
      }
      expect(await page.evaluate(() => (window as unknown as { sent: unknown[] }).sent)).toEqual([
        { type: 'copyToClipboard', payload: 'copy this path' },
        { type: 'copyToClipboard', payload: 'restored path' },
      ]);
      expect(errors).toEqual([]);
      expect(violations).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
    } finally { await page.close(); }
  }, 30_000);
});
