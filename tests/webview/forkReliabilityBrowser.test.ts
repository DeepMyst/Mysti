import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const question = (id: string, commit?: string) => ({ id, role: 'user', content: 'Review **retry** ' + id,
  checkpoint: commit ? { commit } : undefined });
const answer = { id: 'a1', role: 'assistant', provider: 'openai-codex', model: 'historic-model',
  content: 'Before read.\n\nAfter **read**.', thinking: 'Check ownership.',
  segments: [{ type: 'thinking', content: 'Check ownership.' }, { type: 'text', content: 'Before read.' },
    { type: 'tool', toolCallId: 'read-1' }, { type: 'text', content: 'After **read**.' }],
  toolCalls: [{ id: 'read-1', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'failed', output: 'Stopped by user' }] };
const original = { id: 'original', title: 'Retry review', messages: [question('q1', 'commit-1'), answer, question('q2', 'commit-2'),
  { id: 'tail', role: 'assistant', content: 'Original continuation.' }] };

// Real shipped Chromium scripts, with controlled host deliveries. This proves
// UI actions/state only; fork storage, checkpoint Git mutations and editor
// persistence are covered separately by the manager/host/native journeys.
describe('PC-10 fork and rewind interactions in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = (type: string) => page.evaluate(type => (window as any).__posted.filter((event: any) => event.type === type), type);
  const opener = (id = 'q1') => page.locator('.message-rewind-btn[data-message-id=' + JSON.stringify(id) + ']');
  const item = (action: string) => page.locator('#rewind-menu [data-action=' + JSON.stringify(action) + ']');
  const stage = (name: string) => receive('fileAttachmentSelected', { attachments: [
    { id: name, type: 'file', fileName: name, filePath: '/fixture/' + name, size: 3 },
  ] });
  async function visit(conversation: typeof original): Promise<void> {
    await page.locator('#history-btn').click();
    await receive('conversationHistory', { currentId: conversation.id, conversations: [original, conversation] });
    await page.locator('.history-item[data-conversation-id=' + JSON.stringify(conversation.id) + '] .history-item-info').last().click();
    expect((await posted('switchConversation')).at(-1)?.payload).toEqual({ id: conversation.id });
    await receive('conversationChanged', conversation);
  }

  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 650, height: 900 } });
    page.setDefaultTimeout(3000); page.on('pageerror', error => errors.push(error.message));
    await page.setContent(composeChatHtml());
    await page.addStyleTag({ content: ':root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; }' });
    await receive('initialState', { ...INITIAL_STATE, panelId: 'branch-owner', workspacePath: '/fixture', conversation: original });
    await receive('checkpointAvailability', { available: true });
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });

  for (const [action, type] of [['fork', 'forkConversation'], ['rewind', 'rewindToCheckpoint'], ['fork-rewind', 'forkAndRewind']]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${action} sends the exact owner/message/checkpoint once even if the retained item is clicked twice`, async () => {
      await opener('q2').click();
      await item(action).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      expect(await posted(type)).toEqual([{ type, panelId: 'branch-owner', payload: action === 'fork'
        ? { conversationId: 'original', messageId: 'q2' } : { conversationId: 'original', messageId: 'q2', commit: 'commit-2' } }]);
      expect(await page.locator('#rewind-menu').isVisible()).toBe(false);
      expect(await posted('sendMessage')).toEqual([]);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('a checkpoint arriving while open enables only the matching message and preserves the draft', async () => {
    await receive('conversationChanged', { id: 'pending', messages: [question('waiting')] });
    await page.locator('#message-input').fill('Keep my draft'); await stage('draft.txt'); await opener('waiting').click();
    expect(await item('rewind').isDisabled()).toBe(true); expect(await item('fork').isEnabled()).toBe(true);
    await receive('checkpointCreated', { messageId: 'q1', commit: 'foreign' });
    expect(await item('rewind').isDisabled()).toBe(true);
    await receive('checkpointCreated', { messageId: 'waiting', commit: 'arrived' });
    expect(await item('rewind').isEnabled()).toBe(true); await item('rewind').click();
    expect((await posted('rewindToCheckpoint')).at(-1)?.payload).toEqual({ conversationId: 'pending', messageId: 'waiting', commit: 'arrived' });
    expect(await page.locator('#message-input').inputValue()).toBe('Keep my draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('revoking checkpoint availability immediately disables an already-open destructive action', async () => {
    await opener().click(); expect(await item('rewind').isEnabled()).toBe(true);
    await item('rewind').focus();
    await receive('checkpointAvailability', { available: false });
    expect(await item('rewind').isDisabled()).toBe(true); expect(await item('fork-rewind').isDisabled()).toBe(true);
    expect(await item('fork').evaluate(node => node === document.activeElement)).toBe(true);
    await item('rewind').evaluate(button => (button as HTMLButtonElement).click());
    expect(await posted('rewindToCheckpoint')).toEqual([]);
    await item('fork').click(); expect(await posted('forkConversation')).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('restoring checkpoint availability updates an open menu, including a checkpoint received while unavailable', async () => {
    await receive('conversationChanged', { id: 'pending', messages: [question('waiting')] });
    await receive('checkpointAvailability', { available: false }); await opener('waiting').click();
    await receive('checkpointCreated', { messageId: 'waiting', commit: 'arrived' });
    expect(await item('rewind').isDisabled()).toBe(true);
    await receive('checkpointAvailability', { available: true });
    expect(await item('rewind').isEnabled()).toBe(true); await item('rewind').click();
    expect((await posted('rewindToCheckpoint')).at(-1)?.payload).toEqual({ conversationId: 'pending', messageId: 'waiting', commit: 'arrived' });
  });

  for (const key of ['Enter', 'Space']) it.skipIf(CHROMIUM_UNAVAILABLE)(`keyboard ${key} can open and activate Fork with visible focus`, async () => {
    await page.mouse.move(1, 1); await opener().focus();
    expect(await opener().evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    await page.keyboard.press(key);
    expect(await item('fork').evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press(key); expect(await posted('forkConversation')).toHaveLength(1);
    expect(await opener().evaluate(node => node === document.activeElement)).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape closes the menu and restores its opener without stopping a live reply', async () => {
    await receive('responseStarted', { provider: 'claude-code' }); await opener().click(); await item('rewind').focus();
    await page.keyboard.press('Escape');
    expect(await page.locator('#rewind-menu').isVisible()).toBe(false);
    expect(await opener().evaluate(node => node === document.activeElement)).toBe(true);
    expect(await posted('cancelRequest')).toEqual([]); expect(await posted('rewindToCheckpoint')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('holding Enter to open the menu cannot repeat into an unintended fork', async () => {
    await opener().focus(); await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
    expect(await posted('forkConversation')).toEqual([]);
    expect(await item('fork').evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
    expect(await posted('forkConversation')).toHaveLength(1);
    expect(await page.locator('#rewind-menu').isVisible()).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('arrow navigation skips unavailable code actions and honors an explicit rewind choice', async () => {
    await receive('checkpointAvailability', { available: false }); await opener().focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown'); expect(await item('fork').evaluate(node => node === document.activeElement)).toBe(true);
    await receive('checkpointAvailability', { available: true }); await page.keyboard.press('ArrowDown');
    expect(await item('rewind').evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('End'); expect(await item('fork-rewind').evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    expect((await posted('rewindToCheckpoint')).at(-1)?.payload).toEqual({ conversationId: 'original', messageId: 'q1', commit: 'commit-1' });
    expect(await posted('forkConversation')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a retained menu and late checkpoint cannot act after the source conversation is replaced', async () => {
    await opener().click(); await page.evaluate(() => { (window as any).__savedFork = document.querySelector('#rewind-menu [data-action="fork"]'); });
    await receive('conversationChanged', { id: 'replacement', messages: [question('new-question')] });
    await receive('checkpointCreated', { messageId: 'q1', commit: 'late' });
    await page.evaluate(() => (window as any).__savedFork.click());
    expect(await posted('forkConversation')).toEqual([]); expect(await page.locator('#rewind-menu').isVisible()).toBe(false);
    await opener('new-question').click(); expect(await item('rewind').isDisabled()).toBe(true);
    await item('fork').click(); expect((await posted('forkConversation')).at(-1)?.payload).toEqual({ conversationId: 'replacement', messageId: 'new-question' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a checkpoint from the original cannot stamp an identically named message in its new branch', async () => {
    await receive('conversationChanged', { id: 'branch', messages: [question('q1')] }); await opener().click();
    await receive('checkpointCreated', { conversationId: 'original', messageId: 'q1', commit: 'foreign-original' });
    expect(await item('rewind').isDisabled()).toBe(true);
    await receive('checkpointCreated', { conversationId: 'branch', messageId: 'q1', commit: 'branch-checkpoint' });
    await item('rewind').click();
    expect((await posted('rewindToCheckpoint')).at(-1)?.payload).toEqual({ conversationId: 'branch', messageId: 'q1', commit: 'branch-checkpoint' });
  });

  for (const width of [280, 430]) it.skipIf(CHROMIUM_UNAVAILABLE)(`a ${width}px editor resized while the menu is open keeps every action reachable`, async () => {
    await receive('conversationChanged', { id: 'long', messages: Array.from({ length: 20 }, (_, index) => question('long-' + index, 'commit-' + index)) });
    await opener('long-19').click(); await page.setViewportSize({ width, height: 320 });
    // Chromium queues the resize event after the CDP viewport command returns.
    // Require a bounded real layout response rather than inspecting that gap.
    await expect.poll(async () => {
      if (!(await page.locator('#rewind-menu').isVisible())) { return true; }
      const bounds = await page.locator('#rewind-menu').boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 320;
    }, { timeout: 1000 }).toBe(true);
    if (!(await page.locator('#rewind-menu').isVisible())) await opener('long-19').click();
    const bounds = await page.locator('#rewind-menu').boundingBox(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
    await item('fork-rewind').click(); expect(await posted('forkAndRewind')).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('fork history preserves the selected prefix, historical tools/Copy and independent drafts, files and queues over fifty visits', async () => {
    const branch = { ...original, id: 'branch', title: 'Retry review (fork)', messages: original.messages.slice(0, 3) };
    await receive('responseStarted', { provider: 'claude-code' }); await stage('original-queued.txt');
    await page.locator('#message-input').fill('Held original writer'); await page.locator('#message-input').press('Tab');
    await receive('requestCancelled'); await stage('original-draft.txt'); await page.locator('#message-input').fill('Original draft');
    await opener('q2').click(); await item('fork').click();
    // The host controls the actual stored fork prefix; this delivery includes
    // the selected user turn and its preceding structured answer for replay.
    await receive('conversationChanged', branch);
    expect(await page.locator('#message-input').inputValue()).toBe(''); expect(await page.locator('.queued-chip').count()).toBe(0);
    expect(await page.locator('.attachment-name').count()).toBe(0);
    expect(await page.locator('.message[data-id="tail"]').count()).toBe(0);
    expect(await page.locator('.message[data-id="a1"] .tool-call-header').textContent()).toContain('Read');
    await page.locator('.message[data-id="a1"] .message-copy-btn').click();
    expect((await posted('copyMessageMarkdown')).at(-1)?.payload).toEqual({ messageId: 'a1', conversationId: 'branch', requestId: expect.any(String) });
    await receive('responseStarted', { provider: 'openai-codex' }); await stage('branch-queued.txt');
    await page.locator('#message-input').fill('Held branch writer'); await page.locator('#message-input').press('Tab');
    await receive('requestCancelled'); await stage('branch-draft.txt'); await page.locator('#message-input').fill('Branch draft');
    for (let cycle = 0; cycle < 25; cycle++) {
      for (const target of [original, branch]) {
        await visit(target); const name = target.id === 'original' ? 'Original' : 'Branch';
        expect(await page.locator('#message-input').inputValue()).toBe(name + ' draft');
        expect(await page.locator('.attachment-name').allTextContents()).toEqual([target.id + '-draft.txt']);
        expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Held ' + target.id + ' writer']);
      }
    }
    expect(await posted('sendMessage')).toEqual([]); expect(await posted('switchConversation')).toHaveLength(50);
    expect(await posted('updateSettings')).toEqual([]);
  }, 30_000);
});
