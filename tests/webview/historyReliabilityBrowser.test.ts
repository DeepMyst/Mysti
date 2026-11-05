import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry);

const TITLES = ['Retry review', 'Retry review', '<img src=x onerror="window.historyInjected=true">', 'مراجعة إعادة المحاولة — 🧪'];
const history = () => Array.from({ length: 20 }, (_, index) => ({
  id: 'task-' + index, title: TITLES[index] || 'Task ' + index,
  updatedAt: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(),
}));
const transcript = (id: string) => ({ id, messages: [
  { id: id + '-question', role: 'user', content: 'Exact **question** for ' + id },
  { id: id + '-answer', role: 'assistant', provider: 'openai-codex', model: 'historic-codex', content: 'Exact answer for ' + id },
] });

// Chromium runs the shipped scripts. Incoming messages below are the controlled
// host boundary; persistence, native reload and actual CLI use are separate tests.
describe('PC-08 history navigation and restored conversations in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = (type: string) => page.evaluate(type => (window as any).__posted.filter((event: any) => event.type === type), type);
  const openHistory = async (rows = history(), currentId = 'task-0') => {
    if (!(await page.locator('#history-menu').isVisible())) await page.locator('#history-btn').click();
    await receive('conversationHistory', { conversations: rows, currentId });
  };
  const stage = (name: string) => receive('fileAttachmentSelected', { attachments: [
    { id: name, type: 'file', fileName: name, filePath: '/fixture/' + name, size: 3 },
  ] });
  const choose = async (id: string, rows = history()) => {
    await openHistory(rows, id);
    await page.locator('.history-item-info').nth(rows.findIndex(row => row.id === id)).click();
    expect((await posted('switchConversation')).at(-1)?.payload).toEqual({ id });
    await receive('conversationChanged', transcript(id));
  };

  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 650, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(composeChatHtml());
    // Restored history still receives the host's current provider capabilities.
    await receive('initialState', { ...INITIAL_STATE, panelId: 'history-owner', workspacePath: '/fixture',
      providerManifest: manifest, conversation: transcript('task-0') });
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('all twenty rows open their exact IDs, including duplicate, HTML and RTL titles', async () => {
    const rows = history();
    await openHistory(rows);
    expect(await page.locator('.history-item-title').allTextContents()).toEqual(rows.map(row => row.title));
    expect(await page.locator('#history-menu img, #history-menu script').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).historyInjected)).toBeUndefined();
    for (let index = 19; index >= 0; index--) {
      await choose(rows[index].id, rows);
      expect(await page.locator('.message').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id'))))
        .toEqual([rows[index].id + '-question', rows[index].id + '-answer']);
      expect(await page.locator('.message.assistant .message-content').textContent()).toContain('Exact answer for ' + rows[index].id);
      expect(await page.locator('#history-menu').isVisible()).toBe(false);
    }
    expect((await posted('switchConversation')).map(event => event.payload.id)).toEqual(rows.map(row => row.id).reverse());
    expect(await posted('sendMessage')).toEqual([]);
  }, 15_000); // Twenty sequential real clicks; this checks identity, not a 5 s performance budget.

  for (const key of ['Enter', 'Space']) it.skipIf(CHROMIUM_UNAVAILABLE)(`keyboard ${key} opens a history row instead of silently reaching Delete`, async () => {
    await openHistory();
    const row = page.locator('.history-item-info').nth(1);
    await row.focus(); await page.keyboard.press(key);
    expect((await posted('switchConversation')).map(event => event.payload.id)).toEqual(['task-1']);
    expect(await posted('deleteConversation')).toEqual([]);
    expect(await page.locator('#history-menu').isVisible()).toBe(false);
    expect(await page.locator('#message-input').evaluate(node => node === document.activeElement)).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keyboard focus makes Delete visible and names the targeted conversation', async () => {
    await openHistory();
    const button = page.locator('.history-item-delete').nth(3);
    await button.focus();
    expect(await button.evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    expect(await button.getAttribute('aria-label')).toContain(TITLES[3]);
    await page.keyboard.press('Enter');
    expect((await posted('deleteConversation')).map(event => event.payload.id)).toEqual(['task-3']);
    expect(await posted('switchConversation')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a late title refresh and reorder preserve the focused delete target by identity', async () => {
    const rows = history(); await openHistory(rows);
    await page.locator('.history-item-delete').nth(1).focus();
    const requests = (await posted('getConversationHistory')).length;
    await receive('titleUpdated', { conversationId: 'task-1', title: 'Renamed task' });
    expect(await posted('getConversationHistory')).toHaveLength(requests + 1);
    const changed = rows.slice().reverse().map(row => row.id === 'task-1' ? { ...row, title: 'Renamed task' } : row);
    await receive('conversationHistory', { conversations: changed, currentId: 'task-0' });
    await page.keyboard.press('Enter');
    expect((await posted('deleteConversation')).map(event => event.payload.id)).toEqual(['task-1']);
    expect(await posted('switchConversation')).toEqual([]);
    expect(await page.locator('.history-item.active .history-item-title').textContent()).toBe('Retry review');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape closes history and returns keyboard focus to its opener; late responses stay closed', async () => {
    await openHistory(); await page.locator('.history-item-delete').first().focus();
    await page.keyboard.press('Escape');
    expect(await page.locator('#history-menu').isVisible()).toBe(false);
    expect(await page.locator('#history-btn').evaluate(node => node === document.activeElement)).toBe(true);
    await receive('conversationHistory', { conversations: history().reverse(), currentId: 'task-0' });
    expect(await page.locator('#history-menu').isVisible()).toBe(false);
    expect(await posted('deleteConversation')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Tab reaches Open before Delete and a deleted focused row falls back to a non-destructive control', async () => {
    await openHistory(); await page.locator('#history-btn').focus(); await page.keyboard.press('Tab');
    expect(await page.locator('.history-item-info').first().evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    expect((await posted('deleteConversation')).map(event => event.payload.id)).toEqual(['task-0']);
    await receive('conversationHistory', { conversations: history().slice(1), currentId: 'task-1' });
    expect(await page.locator('.history-item-info').first().evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    expect((await posted('switchConversation')).map(event => event.payload.id)).toEqual(['task-1']);
    expect(await posted('deleteConversation')).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a focused Open survives a title change and reorder without switching to its former row position', async () => {
    await openHistory(); await page.locator('.history-item-info').nth(3).focus();
    const rows = history().reverse().map(row => row.id === 'task-3' ? { ...row, title: 'Renamed RTL task' } : row);
    await receive('conversationHistory', { conversations: rows, currentId: 'task-0' });
    await page.keyboard.press('Space');
    expect((await posted('switchConversation')).map(event => event.payload.id)).toEqual(['task-3']);
    expect(await posted('deleteConversation')).toEqual([]);
  });

  for (const kind of ['inactive', 'current', 'last']) it.skipIf(CHROMIUM_UNAVAILABLE)(`deleting the ${kind} row never emits a switch or damages surviving rows`, async () => {
    const rows = kind === 'last' ? history().slice(0, 1) : history();
    const index = kind === 'inactive' ? 1 : 0, deleted = rows[index].id;
    await openHistory(rows); await page.locator('.history-item-delete').nth(index).click();
    expect((await posted('deleteConversation')).map(event => event.payload.id)).toEqual([deleted]);
    expect(await posted('switchConversation')).toEqual([]);
    const remaining = rows.filter(row => row.id !== deleted);
    if (kind !== 'inactive') await receive('conversationChanged', remaining.length ? transcript(remaining[0].id) : null);
    await receive('conversationHistory', { conversations: remaining, currentId: kind === 'inactive' ? 'task-0' : remaining[0]?.id });
    expect(await page.locator('.history-item-title').allTextContents()).toEqual(remaining.map(row => row.title));
    if (kind === 'last') expect(await page.locator('.history-empty').textContent()).toBe('No previous chats');
    expect(await posted('sendMessage')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('history replay preserves stopped segments, failed/truncated tools and exact Copy IDs with historical attribution', async () => {
    const saved = {
      id: 'saved-stop', role: 'assistant', provider: 'openai-codex', model: 'historic-codex',
      content: 'Before tool.\n\nAfter tool with **Markdown**.', thinking: 'Check retry ownership.',
      segments: [ { type: 'thinking', content: 'Check retry ownership.' }, { type: 'text', content: 'Before tool.' },
        { type: 'tool', toolCallId: 'read-stop' }, { type: 'text', content: 'After tool with **Markdown**.' } ],
      toolCalls: [{ id: 'read-stop', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'failed',
        output: 'Stopped by user; stored preview', truncated: true }],
    };
    await openHistory(); await page.locator('.history-item-info').nth(19).click();
    await receive('conversationChanged', { id: 'task-19', provider: 'claude-code', model: 'legacy-fallback',
      messages: [{ id: 'saved-question', role: 'user', content: 'Check retry', attachments: [{ type: 'file', fileName: 'retry.ts' }],
        context: [{ id: 'saved-context', type: 'file', path: '/fixture/retry.ts', content: 'original snapshot' }] }, saved] });
    const answer = page.locator('.message[data-id="saved-stop"]');
    expect(await answer.getAttribute('data-provider')).toBe('openai-codex');
    expect(await answer.locator('.message-model-info').textContent()).toBe('Codex · historic codex');
    expect((await answer.locator('.message-content').allTextContents()).map(value => value.trim())).toEqual(['Before tool.', 'After tool with Markdown.']);
    expect(await answer.locator('.message-body').evaluate(body => Array.from(body.children).map(node => node.className)))
      .toEqual([expect.stringContaining('thinking'), 'message-content content-segment-0', 'tool-call failed', 'message-content content-segment-1']);
    expect(await answer.locator('.tool-call-note').textContent()).toBe('truncated');
    expect(await answer.locator('.tool-call-output-content').textContent()).toBe('Stopped by user; stored preview');
    expect(await page.locator('.message-attachment-label').textContent()).toContain('retry.ts');
    expect(await page.locator('.message.streaming, .tool-call.running').count()).toBe(0);
    await answer.locator('.message-copy-btn').click();
    expect((await posted('copyMessageMarkdown')).at(-1)).toEqual({ type: 'copyMessageMarkdown', panelId: 'history-owner', payload: { messageId: 'saved-stop', conversationId: 'task-19', requestId: expect.any(String) } });
    // Historical attribution must not rewrite this panel's selected composer provider.
    await page.locator('#message-input').fill('New explicit request'); await page.locator('#send-btn').click();
    expect((await posted('sendMessage')).at(-1)?.payload.settings.provider).toBe('claude-code');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('twenty A→B→A visits keep draft files and held queues owned, without navigation dispatching queued writers', async () => {
    for (const id of ['task-0', 'task-1']) {
      await choose(id); await receive('responseStarted', { provider: 'claude-code' });
      await stage(id + '-queued.txt'); await page.locator('#message-input').fill('Held writer for ' + id); await page.locator('#message-input').press('Tab');
      await receive('requestCancelled');
      await stage(id + '-draft.txt'); await page.locator('#message-input').fill('Draft for ' + id);
    }
    for (let cycle = 0; cycle < 20; cycle++) {
      for (const id of ['task-0', 'task-1']) {
        await choose(id);
        expect(await page.locator('#message-input').inputValue()).toBe('Draft for ' + id);
        expect(await page.locator('.attachment-name').allTextContents()).toEqual([id + '-draft.txt']);
        expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Held writer for ' + id]);
        expect(await page.locator('#stop-btn').isVisible()).toBe(false);
      }
    }
    expect(await posted('sendMessage')).toEqual([]);
    expect(await posted('switchConversation')).toHaveLength(42);
  }, 30_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('restores each conversation persona and skills without silently saving or changing composer settings', async () => {
    await receive('agentsUpdated', { availablePersonas: [{ id: 'reviewer', name: 'Reviewer', description: 'Review retry ownership' }],
      availableSkills: [{ id: 'retry-tests', name: 'Retry tests', description: 'Test retry bounds' }], availableRoles: [] });
    const configured = { ...transcript('task-0'), agentConfig: { personaId: 'reviewer', enabledSkills: ['retry-tests'] } };
    await receive('conversationChanged', configured);
    expect(await page.locator('#toolbar-persona-name').textContent()).toBe('Reviewer');
    expect(await page.locator('.skill-item[data-skill="retry-tests"]').getAttribute('aria-pressed')).toBe('true');
    await choose('task-1');
    expect(await page.locator('#toolbar-persona-name').textContent()).toBe('No persona');
    expect(await page.locator('.skill-item[data-skill="retry-tests"]').getAttribute('aria-pressed')).toBe('false');
    await openHistory(); await page.locator('.history-item-info').first().click();
    await receive('conversationChanged', configured);
    expect(await page.locator('#toolbar-persona-name').textContent()).toBe('Reviewer');
    expect(await page.locator('.skill-item[data-skill="retry-tests"]').getAttribute('aria-pressed')).toBe('true');
    expect(await posted('updateAgentConfig')).toEqual([]);
    expect(await posted('updateSettings')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('legacy unstamped messages use saved conversation attribution while newer messages retain their exact backend', async () => {
    await openHistory(); await page.locator('.history-item-info').nth(19).click();
    await receive('conversationChanged', { id: 'task-19', provider: 'openai-codex', model: 'legacy-model', messages: [
      { id: 'legacy', role: 'assistant', content: 'Legacy answer' },
      { id: 'newer', role: 'assistant', provider: 'claude-code', model: 'stored-claude', content: 'Newer answer' },
    ] });
    expect(await page.locator('[data-id="legacy"]').getAttribute('data-provider')).toBe('openai-codex');
    expect(await page.locator('[data-id="legacy"] .message-model-info').textContent()).toBe('Codex · legacy model');
    expect(await page.locator('[data-id="newer"]').getAttribute('data-provider')).toBe('claude-code');
    expect(await page.locator('[data-id="newer"] .message-model-info').textContent()).toBe('Claude · stored claude');
  });

  for (const input of [{ file_path: 42 }, { file_path: { raw: '/fixture/retry.ts' } },
    { command: 42 }, { command: { executable: 'node', args: ['retry.ts'] } },
    { prompt: 42 }, { prompt: { task: 'Review retries', constraints: ['No file changes'] } }]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`restored arbitrary tool input ${JSON.stringify(input)} cannot abort neighboring messages or lose the original JSON`, async () => {
      const tool = { id: 'unusual-input', name: 'file_path' in input ? 'Read' : 'command' in input ? 'Bash' : 'Task',
        kind: 'file_path' in input ? 'read' : 'command' in input ? 'execute' : 'other', input, status: 'completed', output: 'Stored result' };
      await receive('conversationChanged', { id: 'task-19', messages: [
        { id: 'tool-owner', role: 'assistant', content: 'Intact response before tool.', provider: 'claude-code', toolCalls: [tool] },
        { id: 'neighbor', role: 'assistant', content: 'Intact response after tool.', provider: 'openai-codex' },
      ] });
      expect(errors).toEqual([]);
      expect(await page.locator('.message').count()).toBe(2);
      expect(await page.locator('[data-id="tool-owner"] .tool-call-content').textContent()).toBe(JSON.stringify(input, null, 2));
      expect(await page.locator('[data-id="neighbor"] .message-content').textContent()).toContain('Intact response after tool.');
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('an actual store-repaired invalid timeline still renders the whole intact canonical answer', async () => {
    const content = 'First acknowledged paragraph.\n\nFinal acknowledged paragraph.';
    const original = { id: 'recovered', title: 'Recovered task', createdAt: 1, updatedAt: 2,
      provider: 'claude-code', model: 'saved-model', mode: 'ask-before-edit', messages: [{
        id: 'recovered-answer', role: 'assistant', timestamp: 2, content,
        toolCalls: [{ id: 'saved-tool', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'completed', output: 'Read succeeded' }],
        segments: [{ type: 'tool', toolCallId: 'saved-tool' }, { type: 'text', content: { malformed: true } }],
      }] };
    const store = new Map<string, unknown>([['mysti.conversations', {
      schemaVersion: 1, conversations: [['recovered', original]], currentId: 'recovered',
    }]]);
    const manager = new ConversationManager({ globalState: {
      get: (key: string) => store.get(key), update: async (key: string, value: unknown) => { store.set(key, value); },
    } } as any);
    await receive('conversationChanged', manager.getConversation('recovered'));
    expect(errors).toEqual([]);
    expect(await page.locator('[data-id="recovered-answer"] .message-content').count()).toBeGreaterThan(0);
    const visibleText = await page.locator('[data-id="recovered-answer"]').textContent();
    expect(visibleText).toContain('First acknowledged paragraph.');
    expect(visibleText).toContain('Final acknowledged paragraph.');
    expect(await page.locator('[data-id="saved-tool"]').count()).toBe(1);
    expect(manager.getConversation('recovered')!.messages[0].content).toBe(content);
  });
});
