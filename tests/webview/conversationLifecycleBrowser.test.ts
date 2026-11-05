import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

// These lifecycle cases start after the host supplies known provider permissions.
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const READY_STATE = { ...INITIAL_STATE, providers: registry.getAll().map(entry => entry.config),
  providerManifest: buildProviderManifestPayload(registry) };

async function receive(page: Page, type: string, payload?: unknown) {
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
}

async function sends(page: Page) {
  return page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'sendMessage'));
}

describe('daily conversation lifecycle in the shipped chat', () => {
  let browser: Browser;
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  for (const chunkType of ['text', 'thinking']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`keeps Stop and the follow-up queue available after the first ${chunkType} chunk`, async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(composeChatHtml());
        await receive(page, 'initialState', READY_STATE);
        await page.locator('#message-input').fill('Ask Claude to implement the cache');
        await page.locator('#send-btn').click();
        await receive(page, 'responseStarted', { provider: 'claude-code', model: 'claude-test' });
        await receive(page, 'responseChunk', { type: chunkType, content: 'Checking cache invalidation.' });

        expect(await page.locator('#stop-btn').isVisible()).toBe(true);
        expect(await page.locator('#send-btn').isVisible()).toBe(false);
        expect(await page.locator('#message-input').isDisabled()).toBe(false);
        await page.locator('#message-input').fill('@codex review the cache for races');
        await page.locator('#message-input').press('Enter');
        expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['@codex review the cache for races']);
        expect(await sends(page)).toHaveLength(1);

        await receive(page, 'responseComplete', {
          message: { id: 'claude-answer', role: 'assistant', content: 'Cache implemented.', provider: 'claude-code' },
        });
        expect(await page.locator('.message.assistant').textContent()).toContain('Cache implemented.');
        const sent = await sends(page);
        expect(sent).toHaveLength(2);
        expect(sent[1].payload.content).toBe('@codex review the cache for races');
        expect(await page.locator('.queued-chip').count()).toBe(0);
        expect(await page.locator('#stop-btn').isVisible()).toBe(true);
      } finally { await page.close(); }
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('stops a partial answer without sending queued work and starts a clean follow-up', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(composeChatHtml());
      await receive(page, 'initialState', READY_STATE);
      await receive(page, 'responseStarted', { provider: 'claude-code' });
      await page.locator('#message-input').fill('@codex review after Claude finishes');
      await page.locator('#message-input').press('Tab');
      await receive(page, 'responseChunk', { type: 'text', content: 'Incomplete Claude answer.' });
      await receive(page, 'requestCancelled');

      expect(await page.locator('.message.assistant.streaming').count()).toBe(0);
      expect(await page.locator('.message.assistant').textContent()).toContain('Incomplete Claude answer.');
      expect(await page.locator('.queued-chip').count()).toBe(1);
      expect(await sends(page)).toHaveLength(0);
      expect(await page.locator('#stop-btn').isVisible()).toBe(false);

      await page.locator('.queued-chip-remove').click();
      await receive(page, 'responseStarted', { provider: 'openai-codex' });
      await receive(page, 'responseChunk', { type: 'text', content: 'Independent Codex answer.' });
      await receive(page, 'responseComplete', {
        message: { id: 'codex-answer', role: 'assistant', content: 'Independent Codex answer.', provider: 'openai-codex' },
      });
      expect(await page.locator('.message.assistant').count()).toBe(2);
      expect(await page.locator('.message.assistant').last().textContent()).not.toContain('Incomplete Claude');
      expect(await page.locator('.message.assistant').last().getAttribute('data-provider')).toBe('openai-codex');
    } finally { await page.close(); }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('shows and restores a completed multi-agent review without incremental text', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(composeChatHtml());
      await receive(page, 'initialState', READY_STATE);
      await receive(page, 'responseStarted', { provider: 'review', model: 'Claude Code, Codex' });
      await receive(page, 'sessionEvent', {
        type: 'session_started', runId: 'review-run', shape: 'review', lanes: [
          { collaboratorId: 'claude', agentId: 'claude-code', status: 'running' },
          { collaboratorId: 'codex', agentId: 'openai-codex', status: 'running' },
        ],
      });
      expect(await page.locator('#session-card').count()).toBe(1);
      await receive(page, 'sessionEvent', { type: 'session_complete', runId: 'review-run', markdown: 'No races found.' });
      const message = { id: 'final-only', role: 'assistant', content: 'No races found.', provider: 'review', model: 'Claude Code, Codex' };
      await receive(page, 'responseComplete', { message });
      expect(await page.locator('#session-card').count()).toBe(0);
      expect(await page.locator('.message.assistant').count()).toBe(1);
      expect(await page.locator('.message.assistant').textContent()).toContain('No races found.');
      expect(await page.locator('.message.assistant').getAttribute('data-provider')).toBe('review');
      expect(await page.locator('#stop-btn').isVisible()).toBe(false);
      await receive(page, 'conversationChanged', { id: 'saved-review', messages: [message] });
      expect(await page.locator('.message.assistant').count()).toBe(1);
      expect(await page.locator('.message.assistant').textContent()).toContain('No races found.');
      expect(await page.locator('.message-model-info').textContent()).toContain('Claude Code, Codex');
    } finally { await page.close(); }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps queued follow-ups with their conversation when switching away and back', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(composeChatHtml());
      const original = { id: 'cache-work', messages: [] };
      await receive(page, 'initialState', { ...READY_STATE, conversation: original });
      await receive(page, 'responseStarted', { provider: 'claude-code' });
      await page.locator('#message-input').fill('@codex review the cache changes');
      await page.locator('#message-input').press('Tab');
      await receive(page, 'conversationChanged', { id: 'billing-work', messages: [] });

      expect(await page.locator('#stop-btn').isVisible()).toBe(false);
      expect(await page.locator('.queued-chip').count()).toBe(0);
      await page.locator('#message-input').fill('Explain the billing retry policy');
      await page.locator('#send-btn').click();
      await receive(page, 'responseStarted', { provider: 'openai-codex' });
      await receive(page, 'responseComplete', {
        message: { id: 'billing-answer', role: 'assistant', content: 'Use idempotency keys.', provider: 'openai-codex' },
      });
      expect((await sends(page)).map((message: any) => message.payload.content)).toEqual(['Explain the billing retry policy']);

      await receive(page, 'conversationChanged', original);
      expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['@codex review the cache changes']);
      expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  for (const busy of [false, true]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`preserves the draft and its files when requesting a second opinion ${busy ? 'during another turn' : 'after a turn'}`, async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(composeChatHtml());
        await receive(page, 'initialState', READY_STATE);
        await receive(page, 'messageAdded', { id: 'question', role: 'user', content: 'How should we invalidate the cache?' });
        await receive(page, 'responseStarted', { provider: 'claude-code' });
        await receive(page, 'responseChunk', { type: 'text', content: 'Use a versioned key.' });
        await receive(page, 'responseComplete', {
          message: { id: 'answer', role: 'assistant', content: 'Use a versioned key.', provider: 'claude-code' },
          usage: { input_tokens: 20, output_tokens: 8 },
        });
        if (busy) { await receive(page, 'responseStarted', { provider: 'claude-code' }); }
        await page.locator('#message-input').fill('My unfinished follow-up');
        await receive(page, 'fileAttachmentSelected', { attachments: [{ name: 'draft-only.png', type: 'image', dataUrl: 'data:,' }] });
        await page.locator('[data-id="answer"] [data-second-opinion]').click();
        await page.locator('.second-opinion-item[data-agent="openai-codex"]').click();

        expect(await page.locator('#message-input').inputValue()).toBe('My unfinished follow-up');
        expect(await page.locator('.attachment-preview-item').count()).toBe(1);
        if (busy) {
          expect(await sends(page)).toHaveLength(0);
          expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['How should we invalidate the cache?']);
          await receive(page, 'responseComplete', { message: { id: 'other-answer', role: 'assistant', content: 'Done.', provider: 'claude-code' } });
        }
        const sent = await sends(page);
        expect(sent).toHaveLength(1);
        expect(sent[0].payload.content).toBe('How should we invalidate the cache?');
        expect(sent[0].payload.secondOpinion).toEqual({ provider: 'openai-codex', messageId: 'question' });
        expect(sent[0].payload.attachments).toBeUndefined();
        expect(await page.locator('#message-input').inputValue()).toBe('My unfinished follow-up');
      } finally { await page.close(); }
    });
  }
});
