import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

let browser: Browser, page: Page, errors: string[];
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });

beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
beforeEach(async () => {
  if (CHROMIUM_UNAVAILABLE) return;
  errors = []; page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(composeChatHtml());
  await receive('initialState', { ...INITIAL_STATE, settings: { ...(INITIAL_STATE.settings as object),
    provider: 'opencode', mode: 'edit-automatically', accessLevel: 'full-access' } });
  await receive('responseStarted', { provider: 'opencode', model: 'owned/fixture' });
});
afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
afterAll(async () => { await browser?.close(); });

// The native CLI can send only a terminal tool part. The provider announces that
// terminal state before its result; exercise the shipped UI and history renderer.
for (const status of ['completed', 'failed'] as const) {
  it.skipIf(CHROMIUM_UNAVAILABLE)(`keeps one ${status} OpenCode tool card through completion and history restore`, async () => {
    const tool = { id: 'owned-terminal', name: status === 'completed' ? 'Bash' : 'Read',
      input: status === 'completed' ? { command: 'owned-command' } : { filePath: '/owned/missing.txt' },
      output: status === 'completed' ? '(no output)' : 'File not found: /owned/missing.txt', status };
    const card = page.locator('.tool-call[data-id="owned-terminal"]');
    async function assertCard() {
      expect(await card.count()).toBe(1);
      expect(await card.getAttribute('class')).toContain(status);
      expect(await card.locator('.tool-call-output-content').textContent()).toBe(tool.output);
      expect(await page.locator('.tool-call.running, .tool-call.pending').count()).toBe(0);
    }
    await receive('toolUse', tool); await receive('toolResult', tool); await assertCard();
    const message = { id: 'owned-answer', role: 'assistant', provider: 'opencode', content: 'Recovered answer.',
      toolCalls: [tool], segments: [{ type: 'tool', toolCallId: tool.id }, { type: 'text', content: 'Recovered answer.' }] };
    await receive('responseComplete', { message }); await assertCard();
    await receive('conversationChanged', { id: 'restored-owned', messages: [message] }); await assertCard();
  });
}
