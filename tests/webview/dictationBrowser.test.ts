import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';

describe('composer dictation', () => {
  let browser: Browser, page: Page, dir: string;
  const fire = (type: string, payload: unknown) => page.evaluate(m => window.dispatchEvent(new MessageEvent('message', { data: m })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  async function start(draft = '') {
    await page.fill('#message-input', draft); await page.click('#dictation-btn');
    return (await posted()).findLast(m => m.type === 'startDictation').payload.requestId;
  }
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    browser = await chromium.launch(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-voice-'));
    fs.writeFileSync(path.join(dir, 'chat.html'), composeChatHtml());
  });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 390, height: 850 } });
    await page.goto(`file://${path.join(dir, 'chat.html')}`);
    await fire('initialState', { ...INITIAL_STATE, panelId: 'voice-panel' });
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  it.skipIf(CHROMIUM_UNAVAILABLE)('is available for every provider and never posts a prompt automatically', async () => {
    const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
    for (const provider of [...registry.getAll().map(p => p.id), 'mysti', 'brainstorm']) {
      await fire('settingsSync', { provider });
      const requestId = await start();
      await fire('dictationState', { requestId, state: 'active', text: 'Please review my code' });
      expect(await page.locator('#dictation-preview').textContent()).toBe('Please review my code');
      await page.click('#dictation-finish');
      expect((await posted()).findLast(m => m.type === 'finishDictation')).toMatchObject({ type: 'finishDictation', panelId: 'voice-panel', payload: { requestId } });
      await fire('dictationState', { requestId, state: 'complete', text: 'Please review my code' });
      expect(await page.inputValue('#message-input')).toBe('Please review my code');
      expect(await page.locator('#dictation-panel').isVisible()).toBe(false);
    }
    expect((await posted()).some(m => m.type === 'sendMessage')).toBe(false);
    registry.dispose();
  }, 30_000);
  it.skipIf(CHROMIUM_UNAVAILABLE)('replaces the selection and preserves edits made during speech', async () => {
    await page.fill('#message-input', 'Review old code');
    await page.locator('#message-input').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 10));
    await page.click('#dictation-btn');
    let requestId = (await posted()).findLast(m => m.type === 'startDictation').payload.requestId;
    await fire('dictationState', { requestId, state: 'complete', text: 'new' });
    expect(await page.inputValue('#message-input')).toBe('Review new code');
    requestId = await start('Draft');
    await page.fill('#message-input', 'Edited draft');
    await fire('dictationState', { requestId, state: 'complete', text: 'dictated addition' });
    expect(await page.inputValue('#message-input')).toBe('Edited draft dictated addition');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape discards speech without cancelling an agent and ignores late replies', async () => {
    const requestId = await start('Keep draft');
    await page.keyboard.press('Escape');
    expect((await posted()).findLast(m => m.type === 'cancelDictation')).toMatchObject({ type: 'cancelDictation' });
    expect((await posted()).some(m => m.type === 'cancelRequest')).toBe(false);
    await fire('dictationState', { requestId, state: 'complete', text: 'stale' });
    expect(await page.inputValue('#message-input')).toBe('Keep draft');
    const next = await start('New draft');
    await fire('conversationChanged', { id: 'another-thread', messages: [] });
    await fire('dictationState', { requestId: next, state: 'complete', text: 'wrong conversation' });
    expect(await page.inputValue('#message-input')).not.toContain('wrong conversation');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('offers setup and retry after failure, preserves partial text, and Send only finishes speech', async () => {
    let requestId = await start('Draft');
    await fire('dictationState', { requestId, state: 'error', error: 'Enable editor voice', needsSetup: true });
    expect(await page.inputValue('#message-input')).toBe('Draft');
    await page.click('#dictation-setup');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'installDictationSupport' }));
    await page.click('#dictation-settings');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'dictationSettings' }));
    requestId = await start('Draft');
    await fire('dictationState', { requestId, state: 'active' });
    await page.click('#send-btn');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'finishDictation' }));
    await fire('dictationState', { requestId, state: 'error', error: 'Voice stopped', text: 'partial text' });
    expect(await page.inputValue('#message-input')).toBe('Draft partial text');
    expect((await posted()).some(m => m.type === 'sendMessage')).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
