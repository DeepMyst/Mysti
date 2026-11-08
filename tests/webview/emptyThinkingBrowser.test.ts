import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
// Claude Code streams redacted thinking (Sonnet 5 / Opus 5.5): thinking_delta
// events with an empty string for the whole thinking phase (~25 s at max effort).
let browser: Browser, page: Page, errors: string[];
const receive = (type: string, payload?: unknown) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
beforeEach(async () => {
  if (CHROMIUM_UNAVAILABLE) return;
  page = await browser.newPage(); errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(composeChatHtml());
  await receive('initialState', { ...INITIAL_STATE, settings: { ...(INITIAL_STATE.settings as object), provider: 'claude-code' } });
  await receive('responseStarted', { provider: 'claude-code' });
});
afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
afterAll(async () => { await browser?.close(); });

it.skipIf(CHROMIUM_UNAVAILABLE)('keeps the waiting dots through empty thinking chunks, then shows the answer', async () => {
  expect(await page.locator('#messages .loading').count()).toBe(1);
  for (let i = 0; i < 3; i++) { await receive('responseChunk', { type: 'thinking', content: '' }); }
  expect(await page.locator('#messages .loading').count()).toBe(1);
  expect(await page.locator('.message.assistant').count()).toBe(0);
  await receive('responseChunk', { type: 'text', content: 'Hi there' });
  expect(await page.locator('#messages .loading').count()).toBe(0);
  expect((await page.locator('.message.assistant .message-content').allTextContents()).map(s => s.trim())).toEqual(['Hi there']);
});

it.skipIf(CHROMIUM_UNAVAILABLE)('keeps thinking progress through empty thinking chunks and clears it for the answer', async () => {
  await receive('responseChunk', { type: 'progress', content: 'Thinking… ~150 tokens' });
  await receive('responseChunk', { type: 'thinking', content: '' });
  await receive('responseChunk', { type: 'progress', content: 'Thinking… ~300 tokens' });
  await receive('responseChunk', { type: 'thinking', content: '' });
  expect(await page.locator('.response-progress').allInnerTexts()).toEqual(['Thinking… ~300 tokens']);
  await receive('responseChunk', { type: 'text', content: 'Hi there' });
  expect(await page.locator('.response-progress').count()).toBe(0);
});
