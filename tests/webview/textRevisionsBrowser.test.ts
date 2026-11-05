import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { appendFileSync, readFileSync } from 'node:fs';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
let browser: Browser, page: Page, errors: string[];
const receive = (type: string, payload?: unknown) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const tool = { id: 'revision-read', name: 'Read', input: { file_path: 'owned.txt' }, status: 'running', kind: 'read' };
const body = () => page.locator('.message.assistant .message-body');
const contents = () => body().locator(':scope > .message-content').allTextContents();
beforeAll(async () => { if (!CHROMIUM_UNAVAILABLE) browser = await chromium.launch(); });
beforeEach(async () => {
  if (CHROMIUM_UNAVAILABLE) return;
  page = await browser.newPage({ viewport: { width: 700, height: 1000 } }); errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let html = composeChatHtml();
  if (process.env.PB07_REVISION_BASELINE) html = html.replace(readFileSync('media/chat/chat.js', 'utf8'),
    () => readFileSync('out-test/openclaw-text-revisions-20261103/media__chat__chat.js.before', 'utf8'));
  await page.setContent(html);
  await page.addStyleTag({ content: ':root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; --vscode-editor-background: #181818; --vscode-editor-foreground: #ddd; --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-sideBar-background: #202020; }' });
  await receive('initialState', { ...INITIAL_STATE, settings: { ...(INITIAL_STATE.settings as object), provider: 'openclaw', mode: 'edit-automatically', accessLevel: 'full-access' } });
  await receive('responseStarted', { provider: 'openclaw' });
});
afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
afterAll(async () => { await browser?.close(); if (process.env.PB07_REVISION_BROWSER_RECEIPT) appendFileSync(process.env.PB07_REVISION_BROWSER_RECEIPT,
  JSON.stringify({ browserClosed: !browser?.isConnected(), nativeProviderRequests: 0, paidRequests: 0 }) + '\n'); });

it.skipIf(CHROMIUM_UNAVAILABLE)('revises live text on both sides of tools, retains the tool DOM and appends to the corrected tail', async () => {
  await receive('responseChunk', { type: 'text', content: 'Old prefix' }); await receive('toolUse', tool);
  await receive('responseChunk', { type: 'thinking', content: 'Old thought' }); await receive('responseChunk', { type: 'text', content: 'Old tail' });
  await page.locator('.tool-call').evaluate((el: any) => { el.ownedIdentity = true; el.classList.add('expanded'); });
  await receive('responseChunk', { type: 'text', content: 'unused delta', revision: { thinking: 'Correct thought', segments: [
    { type: 'text', content: 'Correct **prefix**' }, { type: 'tool', toolCallId: tool.id }, { type: 'thinking', content: 'Correct thought' }, { type: 'text', content: 'Correct tail' },
  ] } });
  expect((await contents()).map(s => s.trim())).toEqual(['Correct prefix', 'Correct tail']);
  expect(await page.locator('.tool-call').evaluate((el: any) => el.ownedIdentity && el.classList.contains('expanded'))).toBe(true);
  expect(await page.locator('.thinking-zone').innerText()).toContain('Correct thought'); expect(await body().innerText()).not.toContain('Old');
  await receive('responseChunk', { type: 'text', content: '!' });
  expect((await contents()).map(s => s.trim())).toEqual(['Correct prefix', 'Correct tail!']);
  await receive('toolResult', { ...tool, status: 'completed', output: 'Owned evidence retained' });
  expect(await page.locator('.tool-call.completed').count()).toBe(1);
  if (process.env.PB07_REVISION_SCREENSHOT) await body().screenshot({ path: process.env.PB07_REVISION_SCREENSHOT });
});

it.skipIf(CHROMIUM_UNAVAILABLE)('removes all retracted text without losing tools or contaminating subsequent text', async () => {
  await receive('responseChunk', { type: 'text', content: 'Remove me' }); await receive('toolUse', tool);
  await receive('responseChunk', { type: 'text', content: '', revision: { thinking: '', segments: [{ type: 'tool', toolCallId: tool.id }] } });
  expect(await contents()).toEqual([]); expect(await page.locator('.tool-call').count()).toBe(1);
  await receive('responseChunk', { type: 'text', content: 'Fresh text' }); expect((await contents()).map(s => s.trim())).toEqual(['Fresh text']);
});

it.skipIf(CHROMIUM_UNAVAILABLE)('retracts thinking without removing the answer and supports later reasoning', async () => {
  await receive('responseChunk', { type: 'thinking', content: 'Old thinking.' }); await receive('responseChunk', { type: 'text', content: 'Answer' });
  await receive('responseChunk', { type: 'thinking', content: '', revision: { thinking: '', segments: [{ type: 'text', content: 'Answer' }] } });
  expect(await page.locator('.thinking-zone').count()).toBe(0); expect((await contents()).map(s => s.trim())).toEqual(['Answer']);
  await receive('responseChunk', { type: 'thinking', content: 'New thinking' }); expect(await page.locator('.thinking-zone').innerText()).toContain('New thinking');
});

it.skipIf(CHROMIUM_UNAVAILABLE)('renders the corrected final and restored transcript identically without reviving old text', async () => {
  await receive('responseChunk', { type: 'text', content: 'Obsolete answer' });
  const segments = [{ type: 'text', content: 'Corrected 🙂 answer' }];
  await receive('responseChunk', { type: 'text', content: '', revision: { thinking: '', segments } });
  const message = { id: 'corrected', role: 'assistant', provider: 'openclaw', content: 'Corrected 🙂 answer', segments };
  await receive('responseComplete', { message });
  expect((await contents()).map(s => s.trim())).toEqual(['Corrected 🙂 answer']);
  await receive('conversationChanged', { id: 'restored', messages: [message] });
  expect((await contents()).map(s => s.trim())).toEqual(['Corrected 🙂 answer']); expect(await body().innerText()).not.toContain('Obsolete');
});
