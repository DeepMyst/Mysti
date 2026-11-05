import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { appendFileSync, readFileSync } from 'node:fs';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
let browser: Browser, page: Page, errors: string[];
const receive = (type: string, payload?: unknown) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const tool = { id: 'progress-read', name: 'Read', input: { file_path: 'owned.txt' }, status: 'running', kind: 'read' };
const body = () => page.locator('.message.assistant .message-body');
const contents = () => body().locator(':scope > .message-content').allTextContents();
beforeAll(async () => { if (!CHROMIUM_UNAVAILABLE) browser = await chromium.launch(); });
beforeEach(async () => {
  if (CHROMIUM_UNAVAILABLE) return;
  page = await browser.newPage({ viewport: { width: 700, height: 1000 } }); errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let html = composeChatHtml();
  if (process.env.PB07_PROGRESS_BASELINE) html = html.replace(readFileSync('media/chat/chat.js', 'utf8'),
    () => readFileSync('out-test/openclaw-commentary-20261103/media__chat__chat.js.before', 'utf8'));
  await page.setContent(html);
  await page.addStyleTag({ content: ':root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; --vscode-editor-background: #181818; --vscode-editor-foreground: #ddd; --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-sideBar-background: #202020; }' });
  await receive('initialState', { ...INITIAL_STATE, settings: { ...(INITIAL_STATE.settings as object), provider: 'openclaw', mode: 'edit-automatically', accessLevel: 'full-access' } });
  await receive('responseStarted', { provider: 'openclaw' });
});
afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
afterAll(async () => { await browser?.close(); if (process.env.PB07_PROGRESS_BROWSER_RECEIPT) appendFileSync(process.env.PB07_PROGRESS_BROWSER_RECEIPT,
  JSON.stringify({ browserClosed: !browser?.isConnected(), nativeProviderRequests: 0, paidRequests: 0 }) + '\n'); });

it.skipIf(CHROMIUM_UNAVAILABLE)('shows temporary progress as plain text with Stop available, then replaces it with the answer', async () => {
  const status = page.locator('.response-progress');
  await receive('responseChunk', { type: 'progress', content: '<img src=x onerror=alert(1)> Checking files' });
  expect(await status.innerText({ timeout: 1200 })).toBe('<img src=x onerror=alert(1)> Checking files');
  expect(await status.locator('img').count()).toBe(0);
  expect(await page.locator('.message.assistant, .thinking-zone, .tool-call').count()).toBe(0);
  expect(await page.locator('#stop-btn').isVisible()).toBe(true);
  await receive('responseChunk', { type: 'progress', content: 'Checking tests' });
  expect(await status.count()).toBe(1); expect(await status.innerText()).toBe('Checking tests');
  if (process.env.PB07_PROGRESS_SCREENSHOT) await page.locator('#messages').screenshot({ path: process.env.PB07_PROGRESS_SCREENSHOT });
  await receive('responseChunk', { type: 'text', content: 'Actual answer' });
  expect(await status.count()).toBe(0); expect((await contents()).map(s => s.trim())).toEqual(['Actual answer']);
  await receive('responseComplete', { message: { id: 'progress-answer', role: 'assistant', content: 'Actual answer' } });
  expect(await page.locator('#stop-btn').isVisible()).toBe(false);
});

it.skipIf(CHROMIUM_UNAVAILABLE).each(['error', 'requestCancelled', 'authError', 'responseComplete'])('removes progress after %s and ignores late progress', async terminal => {
  await receive('responseChunk', { type: 'progress', content: 'Checking files' });
  expect(await page.locator('.response-progress').count()).toBe(1);
  await receive(terminal, terminal === 'responseComplete' ? { message: { id: 'empty', role: 'assistant', content: '' } }
    : terminal === 'authError' ? { message: 'Owned authentication failure', provider: 'openclaw' } : 'Owned failure');
  expect(await page.locator('.response-progress').count()).toBe(0);
  await receive('responseChunk', { type: 'progress', content: 'Late status' });
  expect(await page.locator('.response-progress').count()).toBe(0);
});

it.skipIf(CHROMIUM_UNAVAILABLE)('removes progress on a tool, a new turn and conversation navigation', async () => {
  await receive('responseChunk', { type: 'progress', content: 'Before tool' }); await receive('toolUse', tool);
  expect(await page.locator('.response-progress').count()).toBe(0); expect(await page.locator('.tool-call').count()).toBe(1);
  await receive('responseChunk', { type: 'progress', content: 'Before next' }); await receive('responseStarted', { provider: 'openclaw' });
  expect(await page.locator('.response-progress').count()).toBe(0);
  await receive('responseChunk', { type: 'progress', content: 'Before navigation' }); await receive('conversationChanged', { id: 'other', messages: [] });
  expect(await page.locator('.response-progress').count()).toBe(0);
});
