import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

async function receive(page: Page, type: string, payload: unknown) {
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
}

describe('PC-05 owned file edit actions in the browser', () => {
  let browser: Browser;
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('reverts only the identified edit and scopes its receipt even when another edit uses the same quoted path', async () => {
    const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setContent(composeChatHtml()); await receive(page, 'initialState', { ...INITIAL_STATE, panelId: 'review-panel', conversation: { id: 'review-conversation', title: 'Review', messages: [], provider: 'claude-code', model: 'sonnet' } });
      await receive(page, 'responseStarted', { provider: 'claude-code' });
      const file = '/workspace/retry"review.ts';
      for (const id of ['first-edit', 'second-edit']) {
        await receive(page, 'toolUse', { id, name: 'Edit', input: { file_path: file, old_string: 'before', new_string: 'after' }, status: 'running' });
        await receive(page, 'toolResult', { id, status: 'completed', output: 'Updated successfully.' });
      }
      const first = page.locator('.edit-report-card[data-tool-id="first-edit"] .edit-report-btn-revert');
      const second = page.locator('.edit-report-card[data-tool-id="second-edit"] .edit-report-btn-revert');
      const secondCard = page.locator('.edit-report-card[data-tool-id="second-edit"]');
      await secondCard.locator('.edit-report-btn-copy').click();
      expect(await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'copyToClipboard').at(-1)))
        .toMatchObject({ payload: { text: file, conversationId: 'review-conversation', requestId: expect.any(String) } });
      await second.click();
      expect(await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'revertFileEdit')))
        .toEqual([{ type: 'revertFileEdit', panelId: 'review-panel', payload: { path: file, toolCallId: 'second-edit' } }]);
      await receive(page, 'fileReverted', { path: file, toolCallId: 'second-edit', success: true });
      expect(await second.innerText()).toBe('Reverted'); expect(await second.isDisabled()).toBe(true);
      expect(await first.innerText()).toBe('Revert'); expect(await first.isEnabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('locates the inserted text and opens each edit at its own returned line', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(composeChatHtml()); await receive(page, 'initialState', INITIAL_STATE);
      await receive(page, 'responseStarted', { provider: 'claude-code' });
      const file = '/workspace/retry"review.ts';
      for (const id of ['one', 'two']) {
        await receive(page, 'toolUse', { id, name: 'Edit', input: { file_path: file, old_string: 'removed', new_string: `inserted-${id}` }, status: 'running' });
        await receive(page, 'toolResult', { id, status: 'completed', output: 'Updated.' });
      }
      const requests = await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'getFileLineNumber'));
      expect(requests.map((message: any) => [message.toolCallId, message.searchText])).toEqual([['one', 'inserted-one'], ['two', 'inserted-two']]);
      await receive(page, 'fileLineNumber', { filePath: file, toolCallId: 'one', lineNumber: 3 });
      await receive(page, 'fileLineNumber', { filePath: file, toolCallId: 'two', lineNumber: 8 });
      for (const id of ['one', 'two']) await page.locator(`.edit-report-card[data-tool-id="${id}"] .edit-report-btn-open`).click();
      const opened = await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'openFile'));
      expect(opened.map((message: any) => message.payload)).toEqual([{ path: file, line: 2 }, { path: file, line: 7 }]);
    } finally { await page.close(); }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('does not offer a destructive revert for writes, failed edits or deletion-only edits', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(composeChatHtml()); await receive(page, 'initialState', INITIAL_STATE);
      await receive(page, 'responseStarted', { provider: 'claude-code' });
      for (const [id, name, input, status] of [
        ['write', 'Write', { file_path: '/workspace/retry.ts', content: 'new file' }, 'completed'],
        ['failed', 'Edit', { file_path: '/workspace/retry.ts', old_string: 'before', new_string: 'after' }, 'failed'],
        ['deletion', 'Edit', { file_path: '/workspace/retry.ts', old_string: 'before', new_string: '' }, 'completed'],
      ] as const) {
        await receive(page, 'toolUse', { id, name, input, status: 'running' });
        await receive(page, 'toolResult', { id, status, output: status === 'failed' ? 'Permission denied' : 'Updated.' });
        const revert = page.locator(`.edit-report-card[data-tool-id="${id}"] .edit-report-btn-revert`);
        expect(await revert.count()).toBe(1); expect(await revert.isDisabled()).toBe(true);
        expect(await revert.getAttribute('title')).toMatch(/cannot|unavailable|only/i);
      }
      expect(await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'revertFileEdit'))).toEqual([]);
    } finally { await page.close(); }
  });
});
