import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

describe('agent assignment cards in the shipped chat', () => {
  let browser: Browser;
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps concurrent agents and repeated roles separate; rejects stale output and unsafe markup', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent(composeChatHtml());
    const fire = (type: string, payload: any) => page.evaluate(m => window.dispatchEvent(new MessageEvent('message', { data: m })), { type, payload });
    await fire('initialState', INITIAL_STATE);
    await fire('responseStarted', { provider: 'mysti', participants: ['claude-code', 'openai-codex'] });
    await fire('collaborationStarted', { runId: 'one', collaborators: [{ agentId: 'claude-code' }, { agentId: 'openai-codex' }] });
    for (const [collaboratorId, agentId, label] of [['c', 'claude-code', 'Claude Code'], ['o', 'openai-codex', 'Codex']]) {
      await fire('collaborator', { runId: 'one', collaboratorId, agentId, label, type: 'collab_started' });
    }
    expect(await page.locator('.collaboration-status[data-state="running"]').count()).toBe(2);
    await fire('collaborator', { runId: 'one', collaboratorId: 'o', agentId: 'openai-codex', type: 'collab_text', content: 'Codex opinion' });
    await fire('collaborator', { runId: 'one', collaboratorId: 'c', agentId: 'claude-code', type: 'collab_text', content: 'Claude opinion <img src=x onerror="alert(1)">' });
    expect(await page.locator('.collaboration-card').nth(0).textContent()).toContain('Claude opinion');
    expect(await page.locator('.collaboration-card').nth(1).textContent()).toContain('Codex opinion');
    expect(await page.locator('.collaboration-output [onerror]').count()).toBe(0);
    await fire('collaborator', { runId: 'one', collaboratorId: 'c', agentId: 'claude-code', type: 'collab_complete', responseText: 'Claude final' });
    await fire('collaborator', { runId: 'one', collaboratorId: 'o', agentId: 'openai-codex', type: 'collab_error', failure: 'timeout' });
    expect(await page.locator('.collaboration-status[data-state="error"]').textContent()).toContain('timeout');
    await fire('collaborationComplete', { runId: 'one' });
    await fire('collaborator', { runId: 'one', collaboratorId: 'c', agentId: 'claude-code', type: 'collab_text', content: 'STALE OUTPUT' });
    expect(await page.locator('.collaboration-group').textContent()).not.toContain('STALE OUTPUT');
    await fire('responseChunk', { type: 'text', content: '## Claude Code\n\nClaude final\n\n## Codex\n\nUnavailable' });
    await fire('responseComplete', { message: { id: 'saved', role: 'assistant', content: '## Claude Code\n\nClaude final\n\n## Codex\n\nUnavailable', participants: ['claude-code', 'openai-codex'] } });
    expect(await page.locator('.message.assistant .message-model-info').last().textContent()).toContain('assigned responses');
    expect(await page.locator('.message.assistant').last().textContent()).toContain('Claude final');
    expect(await page.locator('.collaboration-card[open]').count()).toBe(0);
    await fire('collaborationStarted', { runId: 'two' });
    await fire('collaborator', { runId: 'two', collaboratorId: 'c', agentId: 'claude-code', label: 'Claude · Reviewer', type: 'collab_started' });
    await fire('requestCancelled', {});
    expect(await page.locator('.collaboration-group').nth(1).textContent()).toContain('Stopped');
    expect(await page.locator('.collaboration-status[data-state="running"]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});
