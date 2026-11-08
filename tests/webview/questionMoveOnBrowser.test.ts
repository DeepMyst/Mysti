import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';

// Ordinary composer sends require the known capabilities supplied by the host.
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);

/** A native question holds the agent's turn open. Skipping it, or sending a new
 * message instead, must end that turn (Esc in Claude Code) — never leave the
 * turn waiting or send a message on the user's behalf. */
describe('moving on from a question the agent is waiting on', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = (type: string) => page.evaluate(type => (window as any).__posted.filter((entry: any) => entry.type === type), type);
  const question = { toolCallId: 'delivery-q', source: 'tool', questions: [{ question: 'Red or blue?', header: 'Color', multiSelect: false,
    options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] };
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 680, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'owner', conversation: { id: 'chat', messages: [] },
      providers: registry.getAll().map(entry => entry.config), providerManifest: buildProviderManifestPayload(registry) });
    await page.waitForFunction(() => (window as any).__posted.some((event: any) => event.type === 'uiReady'));
  });
  afterEach(async () => { await page?.close(); if (errors) { expect(errors).toEqual([]); } });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Skip ends the waiting turn and sends no message', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await receive('responseChunk', { type: 'text', content: 'Let me check one thing.' });
    await receive('askUserQuestion', question);
    expect(await page.locator('.auq-footer').innerText()).toContain('send a message to move on');
    await page.locator('.auq-skip-btn').click();
    expect(await posted('askUserQuestionSkipped')).toHaveLength(1);
    expect(await posted('cancelRequest')).toHaveLength(1);
    expect(await posted('sendMessage')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a message sent while the question waits ends that turn, then is sent', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await receive('responseChunk', { type: 'text', content: 'Let me check one thing.' });
    await receive('askUserQuestion', question);
    await page.locator('#message-input').fill('switch to something else');
    await page.locator('#message-input').press('Enter');
    expect(await posted('askUserQuestionSkipped')).toHaveLength(1);
    expect(await posted('cancelRequest')).toHaveLength(1);
    expect(await page.locator('.ask-user-question-container').count()).toBe(0);
    expect(await posted('sendMessage')).toEqual([]);
    await receive('requestCancelled');
    const sent = await posted('sendMessage');
    expect(sent).toHaveLength(1); expect(sent[0].payload.content).toBe('switch to something else');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a question card shown after the turn ended only dismisses on Skip', async () => {
    await receive('messageAdded', { id: 'a1', role: 'assistant', provider: 'claude-code', content: 'Red or blue?' });
    await receive('askUserQuestion', { ...question, source: 'detected' });
    await page.locator('.auq-skip-btn').click();
    expect(await posted('askUserQuestionSkipped')).toHaveLength(1);
    expect(await posted('cancelRequest')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an ordinary Stop still holds queued messages', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await page.locator('#message-input').fill('queued while streaming');
    await page.locator('#message-input').press('Enter');
    await page.locator('#stop-btn').click();
    await receive('requestCancelled');
    expect(await posted('sendMessage')).toEqual([]);
  });
});
