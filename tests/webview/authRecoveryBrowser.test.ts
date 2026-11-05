import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

/** PC-03: shipped browser UI with controlled host replies, never account mutations. */
describe('authentication failure and recovery in the shipped chat', () => {
  let browser: Browser, page: Page;
  let pageErrors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as Array<{ type: string; payload?: any; panelId?: string }>);
  const failure = { providerId: 'openai-codex', providerName: 'Codex', authCommand: 'codex login', error: 'Authentication expired' };

  beforeAll(async () => { if (!CHROMIUM_UNAVAILABLE) { browser = await chromium.launch(); } });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    pageErrors = [];
    page = await browser.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent(composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'editor-auth', conversation: { id: 'auth-task', messages: [] } });
    await receive('messageAdded', { id: 'healthy-sibling', role: 'assistant', provider: 'claude-code', content: 'Claude review: keep the retry cap at 1000ms.' });
    await page.locator('#message-input').fill('Unsent follow-up about the retry cap');
    await receive('fileAttachmentSelected', { attachments: [{ name: 'retry-notes.txt', type: 'text', content: 'Keep this draft attachment.' }] });
  });
  afterEach(async () => { await page?.close(); if (pageErrors) { expect(pageErrors).toEqual([]); } });
  afterAll(async () => { await browser?.close(); });

  for (const apiKeySetup of [false, true]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${apiKeySetup ? 'API-key' : 'CLI'} auth recovery sends one scoped action and preserves the draft and sibling result`, async () => {
      await receive('authError', { ...failure, apiKeySetup });
      await page.locator('#auth-terminal-btn').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      expect((await posted()).filter(message => message.type === 'authConfirm')).toEqual([
        { type: 'authConfirm', payload: { providerId: 'openai-codex' }, panelId: 'editor-auth' },
      ]);
      expect((await posted()).some(message => ['sendMessage', 'openTerminal'].includes(message.type))).toBe(false);
      expect(await page.locator('#message-input').inputValue()).toBe('Unsent follow-up about the retry cap');
      expect(await page.locator('.attachment-preview-item').count()).toBe(1);
      expect(await page.locator('[data-id="healthy-sibling"]').innerText()).toContain('Claude review: keep the retry cap at 1000ms.');
    });
  }

  for (const route of ['prompt-later', 'prompt-wait', 'error-card-wait']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${route}: an actual exit dismisses authentication and stale replies cannot reopen it`, async () => {
      if (route === 'error-card-wait') {
        await receive('authError', failure);
        await page.locator('#auth-terminal-btn').click();
      } else {
        await receive('authPrompt', { providerId: 'openai-codex', message: 'Sign in to Codex' });
        if (route === 'prompt-wait') await page.locator('#auth-confirm-btn').click();
      }
      const exitsBefore = (await posted()).filter(message => ['skipSetup', 'authSkip'].includes(message.type)).length;
      await page.locator(route === 'prompt-later' ? '#auth-skip-btn' : '#auth-wait-skip-btn').click();
      expect(await page.locator('#setup-overlay').isVisible()).toBe(false);
      const exits = (await posted()).filter(message => ['skipSetup', 'authSkip'].includes(message.type)).slice(exitsBefore);
      expect(exits).toEqual([route === 'prompt-later'
        ? { type: 'authSkip', payload: { providerId: 'openai-codex' }, panelId: 'editor-auth' }
        : { type: 'skipSetup', panelId: 'editor-auth' }]);
      await receive('setupFailed', { providerId: 'openai-codex', error: 'Late authentication timeout', canRetry: true });
      await receive('authPrompt', { providerId: 'openai-codex', message: 'Late authentication prompt' });
      expect(await page.locator('#setup-overlay').isVisible()).toBe(false);
      expect(await page.locator('#message-input').isEditable()).toBe(true);
      expect(await page.locator('#message-input').inputValue()).toBe('Unsent follow-up about the retry cap');
      expect(await page.locator('.attachment-preview-item').count()).toBe(1);
      expect(await page.locator('[data-id="healthy-sibling"]').count()).toBe(1);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('reopens authentication after Later and keeps cancellation recoverable', async () => {
    await receive('authPrompt', { providerId: 'openai-codex', message: 'Sign in to Codex' });
    await page.locator('#auth-skip-btn').click();
    await receive('authError', failure);
    await page.locator('#auth-terminal-btn').click();
    await receive('setupProgress', { providerId: 'openai-codex', step: 'authenticating', message: 'Opening authentication...', progress: 80 });
    expect(await page.locator('#setup-overlay').isVisible()).toBe(true);
    await receive('setupFailed', { providerId: 'openai-codex', error: 'Authentication cancelled.', canRetry: true });
    expect(await page.locator('#auth-retry-btn').isEnabled()).toBe(true);
    await page.locator('#auth-error-close-btn').click();
    expect(await page.locator('#setup-overlay').isVisible()).toBe(false);
    expect(await page.locator('#auth-terminal-btn').isEnabled()).toBe(true);
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent follow-up about the retry cap');
    expect(await page.locator('.attachment-preview-item').count()).toBe(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('twenty repeated auth failures leave one actionable provider card without automatic sends', async () => {
    for (let attempt = 0; attempt < 20; attempt++) { await receive('authError', failure); }
    expect(await page.locator('.auth-error').count()).toBe(1);
    expect(await page.locator('#auth-terminal-btn').isEnabled()).toBe(true);
    expect((await posted()).some(message => ['sendMessage', 'authConfirm', 'openTerminal'].includes(message.type))).toBe(false);
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent follow-up about the retry cap');
    expect(await page.locator('[data-id="healthy-sibling"]').count()).toBe(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('retains the failed partial answer when a healthy provider answers the next turn', async () => {
    await receive('responseStarted', { provider: 'openai-codex', model: 'codex-test' });
    await receive('responseChunk', { type: 'text', content: 'Codex partial: the first retry is 100ms.' });
    await receive('authError', { ...failure, message: { id: 'failed-partial', role: 'assistant', provider: 'openai-codex', model: 'codex-test', content: 'Codex partial: the first retry is 100ms.' } });
    expect(await page.locator('.message.assistant.streaming').count()).toBe(0);
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    await receive('responseStarted', { provider: 'claude-code', model: 'claude-test' });
    await receive('responseChunk', { type: 'text', content: 'Claude recovery: cap later attempts at 1000ms.' });
    await receive('responseComplete', { message: { id: 'recovered-turn', role: 'assistant', provider: 'claude-code', model: 'claude-test', content: 'Claude recovery: cap later attempts at 1000ms.' } });
    expect(await page.locator('.message.assistant').count()).toBe(3);
    const partial = page.locator('.message.assistant').filter({ hasText: 'Codex partial: the first retry is 100ms.' });
    expect(await partial.count()).toBe(1);
    expect(await partial.getAttribute('data-provider')).toBe('openai-codex');
    expect(await page.locator('[data-id="recovered-turn"]').innerText()).toContain('Claude recovery: cap later attempts at 1000ms.');
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent follow-up about the retry cap');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('finalizes the host partial message without draining queued follow-ups or replacing an unsent draft', async () => {
    await receive('responseStarted', { provider: 'openai-codex', model: 'codex-test' });
    await receive('responseChunk', { type: 'text', content: 'Partial retry analysis.' });
    await page.locator('#message-input').fill('Queued: also verify the cap');
    await page.locator('#message-input').press('Tab');
    await page.locator('#message-input').fill('Separate unsent draft');
    await receive('authError', { ...failure, message: { id: 'partial-auth-turn', role: 'assistant', provider: 'openai-codex', model: 'codex-test', content: 'Partial retry analysis.' } });
    expect(await page.locator('[data-id="partial-auth-turn"]').innerText()).toContain('Partial retry analysis.');
    expect(await page.locator('.message.assistant.streaming').count()).toBe(0);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Queued: also verify the cap']);
    expect(await page.locator('#message-input').inputValue()).toBe('Separate unsent draft');
    expect((await posted()).filter(message => message.type === 'sendMessage')).toEqual([]);
    await page.locator('#auth-terminal-btn').click();
    await page.locator('#auth-wait-skip-btn').click();
    expect(await page.locator('#auth-terminal-btn').isEnabled()).toBe(true);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Queued: also verify the cap']);
    expect(await page.locator('#message-input').inputValue()).toBe('Separate unsent draft');
    expect((await posted()).filter(message => message.type === 'sendMessage')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('settles a running tool as failed when authentication interrupts the turn', async () => {
    const tool = { id: 'auth-interrupted-read', name: 'Read', input: { file_path: 'retry.ts' }, status: 'running' };
    await receive('responseStarted', { provider: 'openai-codex', model: 'codex-test' });
    await receive('toolUse', tool);
    expect(await page.locator('.tool-call.running').count()).toBe(1);
    await receive('authError', { ...failure, message: { id: 'partial-tool-turn', role: 'assistant', provider: 'openai-codex', model: 'codex-test', content: '',
      toolCalls: [{ ...tool, status: 'failed', output: 'Authentication required before the tool could finish.' }] } });
    expect(await page.locator('.tool-call.running, .tool-call.pending').count()).toBe(0);
    expect(await page.locator('.tool-call.failed .tool-call-status').innerText()).toBe('failed');
    expect(await page.locator('.tool-call-output-content').innerText()).toBe('Authentication required before the tool could finish.');
    expect(await page.locator('.message.assistant.streaming').count()).toBe(0);
    expect((await posted()).filter(message => message.type === 'sendMessage')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('labels detected credentials as requiring verification and never sends the queued request automatically', async () => {
    await page.clock.install();
    await receive('responseStarted', { provider: 'openai-codex' });
    await page.locator('#message-input').fill('Queued retry after sign-in');
    await page.locator('#message-input').press('Tab');
    await page.locator('#message-input').fill('Separate unsent draft');
    await receive('authError', failure);
    await page.locator('#auth-terminal-btn').click();
    await receive('setupComplete', { providerId: 'openai-codex', requiresVerification: true });
    expect(await page.locator('.auth-error').innerText()).toContain('Credentials detected. Retry your request to verify sign-in.');
    expect(await page.locator('#auth-terminal-btn').isEnabled()).toBe(true);
    await page.clock.fastForward(1100);
    expect(await page.locator('#setup-overlay').isVisible()).toBe(false);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Queued retry after sign-in']);
    expect(await page.locator('#message-input').inputValue()).toBe('Separate unsent draft');
    expect((await posted()).filter(message => message.type === 'sendMessage')).toEqual([]);
  });
});
