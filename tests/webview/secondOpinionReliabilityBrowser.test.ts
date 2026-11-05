import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

// Ordinary composer sends require the same known capabilities supplied by the host.
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);

describe('PC-06 original question and draft ownership', () => {
  let browser: Browser, page: Page;
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const sends = () => page.evaluate(() => (window as any).__posted.filter((m: any) => m.type === 'sendMessage'));
  const originalFile = { id: 'original-file', type: 'file', fileName: 'original.txt', filePath: '/fixture/original.txt', size: 20 };
  const draftFile = { id: 'draft-file', type: 'file', fileName: 'draft.txt', filePath: '/fixture/draft.txt', size: 21 };
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, conversation: { id: 'original-chat', messages: [] },
      providers: registry.getAll().map(entry => entry.config), providerManifest: buildProviderManifestPayload(registry),
    });
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  async function answer(content: string, attachments?: unknown[]) {
    await receive('messageAdded', { id: 'original-question', role: 'user', content, attachments });
    await receive('responseComplete', { message: { id: 'original-answer', role: 'assistant', content: 'Review complete.', provider: 'claude-code' }, usage: { input_tokens: 10, output_tokens: 5 } });
  }
  async function chooseOpinion() {
    await page.locator('[data-id="original-answer"] [data-second-opinion]').click();
    await page.locator('.second-opinion-item[data-agent="openai-codex"]').click();
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('resends exact source Markdown with one explicit respondent without parsing an old agent assignment again', async () => {
    const source = '@claude Review **retryDelay**.\n\n```js\nconst label = "@claude";\nreturn base * 2 ** n;\n```\n\n| n | expected |\n|---|---|\n| 0 | 73 |';
    await answer(source);
    await page.locator('#message-input').fill('An independent unfinished draft');
    await chooseOpinion();
    const requests = await sends();
    expect(requests).toHaveLength(1);
    expect(requests[0].payload.content).toBe(source);
    expect(requests[0].payload.secondOpinion).toEqual({ provider: 'openai-codex', messageId: 'original-question' });
    expect(await page.locator('#message-input').inputValue()).toBe('An independent unfinished draft');
  });

  for (const busy of [false, true]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`uses the original attachment and preserves the draft attachment (${busy ? 'queued' : 'idle'})`, async () => {
      await answer('Review the attached retry requirements.', [originalFile]);
      if (busy) await receive('responseStarted', { provider: 'claude-code' });
      await page.locator('#message-input').fill('My next task');
      await receive('fileAttachmentSelected', { attachments: [draftFile] });
      await chooseOpinion();
      if (busy) {
        expect(await sends()).toHaveLength(0);
        await receive('responseComplete', { message: { id: 'other-answer', role: 'assistant', content: 'Done.', provider: 'claude-code' } });
      }
      const requests = await sends();
      expect(requests).toHaveLength(1);
      expect(requests[0].payload.attachments).toEqual([originalFile]);
      expect(requests[0].payload.secondOpinion).toEqual({ provider: 'openai-codex', messageId: 'original-question' });
      expect(await page.locator('#message-input').inputValue()).toBe('My next task');
      expect(await page.locator('.attachment-preview-item').textContent()).toContain('draft.txt');
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('dismisses an original-chat second-opinion menu when navigating to another conversation', async () => {
    await answer('Question belonging only to original-chat');
    await page.locator('[data-id="original-answer"] [data-second-opinion]').click();
    expect(await page.locator('#second-opinion-menu').isVisible()).toBe(true);
    await receive('conversationChanged', { id: 'another-chat', messages: [] });
    expect(await page.locator('#second-opinion-menu').count()).toBe(0);
    expect(await sends()).toHaveLength(0);
  });

  for (const restored of [false, true]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`offers another opinion on an answer without token usage (${restored ? 'restored' : 'final-only'})`, async () => {
      const question = { id: 'original-question', role: 'user', content: 'Review the retry cap.' };
      const response = { id: 'original-answer', role: 'assistant', provider: 'claude-code', content: 'Use exponential backoff.' };
      if (restored) {
        await receive('conversationChanged', { id: 'saved-chat', messages: [question, response] });
      } else {
        await receive('messageAdded', question);
        await receive('responseComplete', { message: response });
      }
      expect(await page.locator('[data-id="original-answer"] [data-second-opinion]').count()).toBe(1);
      await chooseOpinion();
      expect((await sends())[0].payload).toMatchObject({ content: question.content,
        secondOpinion: { provider: 'openai-codex', messageId: question.id } });
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps unsent text and files with their originating conversation in this webview', async () => {
    await page.locator('#message-input').fill('Original chat draft');
    await receive('fileAttachmentSelected', { attachments: [draftFile] });
    await receive('conversationChanged', { id: 'another-chat', messages: [] });
    expect(await page.locator('#message-input').inputValue()).toBe('');
    expect(await page.locator('.attachment-preview-item').count()).toBe(0);
    await page.locator('#message-input').fill('Another chat task');
    await page.locator('#send-btn').click();
    expect((await sends())[0].payload.attachments).toBeUndefined();
    await receive('conversationChanged', { id: 'original-chat', messages: [] });
    expect(await page.locator('#message-input').inputValue()).toBe('Original chat draft');
    expect(await page.locator('.attachment-preview-item').textContent()).toContain('draft.txt');
  });
});
