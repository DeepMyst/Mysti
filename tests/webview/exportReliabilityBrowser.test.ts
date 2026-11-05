import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';

const code = 'const café = "مرحبا 👩🏽‍💻 <retry> & ready";\n\treturn café;';
const original = { id: 'original', title: 'Review retries', messages: [
  { id: 'q1', role: 'user', content: 'Review this retry.' },
  { id: 'a1', role: 'assistant', provider: 'openai-codex', model: 'saved-model', content: '**Exact Markdown**\n\n```js\n' + code + '\n```',
    toolCalls: [{ id: 'read-1', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'completed', output: 'Owned read result.' }] },
] };

// Real Chromium and shipped scripts. Incoming acknowledgements/dialog outcomes
// are controlled host boundaries, not real clipboard, filesystem, or URI proof.
describe('PC-11 public conversation transfers and honest copy feedback', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = (type: string) => page.evaluate(type => (window as any).__posted.filter((event: any) => event.type === type), type);
  const toast = () => page.locator('#export-toast');
  const toastShowing = () => toast().evaluate(node => getComputedStyle(node).opacity !== '0');
  const acknowledge = (request: any, extra: any = {}) => receive('exportResult', {
    requestId: request.payload.requestId, conversationId: request.payload.conversationId, operation: 'copy', success: true, ...extra,
  });
  const copy = () => page.locator('[data-id="a1"] .message-copy-btn');
  const copyCode = () => page.locator('[data-id="a1"] .message-code-copy');
  const stage = (name: string) => receive('fileAttachmentSelected', { attachments: [
    { id: name, type: 'file', fileName: name, filePath: '/fixture/' + name, size: 3 },
  ] });
  async function action(id: string): Promise<void> {
    if (!(await page.locator('#tools-menu').isVisible())) { await page.locator('#tools-menu-btn').click(); }
    expect(await page.locator('#' + id).count()).toBe(1);
    await page.locator('#' + id).click();
  }
  function owned(request: any): void {
    expect(request.panelId).toBe('transfer-owner');
    expect(request.payload).toMatchObject({ conversationId: 'original', requestId: expect.any(String) });
    expect(request.payload.requestId.length).toBeGreaterThan(0);
  }

  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 600, height: 900 } });
    page.setDefaultTimeout(2000); page.on('pageerror', error => errors.push(error.message));
    await page.setContent(composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'transfer-owner', conversation: original });
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the existing clipboard action is labelled Copy rather than implying a file dialog', async () => {
    await page.locator('#tools-menu-btn').click();
    expect(await page.locator('[data-composer-action="export-conversation-btn"]').textContent()).toBe('Copy conversation as Markdown');
    await page.locator('[data-composer-action="export-conversation-btn"]').click();
    const request = (await posted('exportConversation')).at(-1); owned(request);
    expect(await toastShowing()).toBe(false); await acknowledge(request);
    expect(await toast().textContent()).toBe('Copied to clipboard!');
  });

  for (const format of ['json', 'markdown']) it.skipIf(CHROMIUM_UNAVAILABLE)(`Actions exposes a real ${format} file export request without consuming the draft`, async () => {
    await page.locator('#message-input').fill('Unsent draft'); await stage('draft.txt');
    await action('export-' + format + '-btn');
    const request = (await posted('exportToFile')).at(-1); owned(request);
    expect(request.payload.format).toBe(format); expect(await page.locator('#tools-menu').isVisible()).toBe(false);
    await acknowledge(request, { operation: 'file', format });
    expect(await toast().textContent()).toContain('saved'); expect(await toast().textContent()).not.toContain('clipboard');
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
  });

  for (const [command, trigger, type] of [['export', 'triggerExport', 'exportConversation'], ['import', 'triggerImport', 'importFromFile'], ['share', 'triggerShareLink', 'triggerShareLink']]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`typed /${command} reaches its owned host operation once`, async () => {
      // Conversation transfers are local host actions. Even a real provider
      // whose current mode is unavailable must leave them usable.
      const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
      try {
        await receive('initialState', { ...INITIAL_STATE, panelId: 'transfer-owner', conversation: original,
          providerManifest: buildProviderManifestPayload(registry),
          settings: { ...(INITIAL_STATE.settings as object), provider: 'cline' },
        });
      } finally { registry.dispose(); }
      expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
      await page.locator('#message-input').fill('/' + command); await page.locator('#message-input').press('Enter');
      const slash = (await posted('executeSlashCommand')).at(-1);
      expect(slash.payload.command).toBe(command);
      await receive(trigger, { conversationId: 'original' });
      const request = (await posted(type)).at(-1); owned(request);
      expect(await posted(type)).toHaveLength(1);
      await receive('slashCommandCompleted', { requestId: slash.payload.requestId, kind: 'action', success: true });
      await acknowledge(request, { operation: command === 'import' ? 'import' : command === 'share' ? 'share' : 'copy', cancelled: command === 'import' });
      expect(await posted('sendMessage')).toEqual([]);
      expect(await posted('updateSettings')).toEqual([]);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('message Copy waits for host success and a failed clipboard write can be retried', async () => {
    await copy().click();
    expect(await copy().evaluate(node => node.classList.contains('copied'))).toBe(false);
    const first = (await posted('copyMessageMarkdown')).at(-1); owned(first);
    await acknowledge(first, { success: false, error: 'Clipboard denied' });
    expect(await copy().isEnabled()).toBe(true); expect(await toast().textContent()).toBe('Clipboard denied');
    await copy().click(); const retry = (await posted('copyMessageMarkdown')).at(-1);
    expect(retry.payload.requestId).not.toBe(first.payload.requestId); await acknowledge(retry);
    expect(await copy().evaluate(node => node.classList.contains('copied'))).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('code Copy preserves exact Unicode bytes and acknowledges only completed clipboard writes', async () => {
    await copyCode().click(); expect(await copyCode().textContent()).toBe('Copy code');
    const request = (await posted('copyToClipboard')).at(-1); owned(request); expect(request.payload.text).toBe(code);
    await acknowledge(request); expect(await copyCode().textContent()).toBe('Copied!');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a retained Copy button cannot enqueue duplicate pending clipboard writes', async () => {
    await copy().evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    expect(await posted('copyMessageMarkdown')).toHaveLength(1);
    const request = (await posted('copyMessageMarkdown'))[0]; await acknowledge(request);
    expect(await copy().isEnabled()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('late and duplicated clipboard acknowledgements cannot change a replacement conversation', async () => {
    await copy().click(); const request = (await posted('copyMessageMarkdown')).at(-1);
    await receive('conversationChanged', { ...original, id: 'replacement' });
    await acknowledge(request); await acknowledge(request, { success: false, error: 'Old failure' });
    expect(await toastShowing()).toBe(false); expect(await copy().evaluate(node => node.classList.contains('copied'))).toBe(false);
    expect(await copy().isEnabled()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an unknown acknowledgement cannot report a copy that was never requested', async () => {
    await receive('exportResult', { requestId: 'unknown', conversationId: 'original', success: true, operation: 'copy' });
    expect(await toastShowing()).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a mismatched owner acknowledgement cannot consume the real pending clipboard operation', async () => {
    await copy().click(); const request = (await posted('copyMessageMarkdown')).at(-1);
    await acknowledge(request, { conversationId: 'foreign' });
    expect(await copy().isDisabled()).toBe(true); expect(await toastShowing()).toBe(false);
    await acknowledge(request); expect(await copy().isEnabled()).toBe(true);
    expect(await copy().evaluate(node => node.classList.contains('copied'))).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('tool-summary Copy also waits for its own acknowledgement', async () => {
    const button = page.locator('.tool-call[data-id="read-1"] .tool-call-copy'); await button.click();
    expect(await button.evaluate(node => node.classList.contains('copied'))).toBe(false);
    const request = (await posted('copyToClipboard')).at(-1); owned(request);
    expect(request.payload.text).toContain('retry.ts'); await acknowledge(request);
    expect(await button.evaluate(node => node.classList.contains('copied'))).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('edit-card Copy path cannot report success before the host clipboard write', async () => {
    const tool = { id: 'edit-copy', name: 'Edit', input: { file_path: '/fixture/café.ts', old_string: 'old', new_string: 'new' }, status: 'completed', output: 'Changed' };
    await receive('responseStarted', { provider: 'claude-code' }); await receive('toolUse', { ...tool, status: 'running' }); await receive('toolResult', tool);
    const button = page.locator('.edit-report-card[data-tool-id="edit-copy"] .edit-report-btn-copy'); await button.click();
    expect(await button.textContent()).toBe('Copy path');
    const request = (await posted('copyToClipboard')).at(-1); owned(request); expect(request.payload.text).toBe('/fixture/café.ts');
    await acknowledge(request, { success: false, error: 'Clipboard denied' }); expect(await button.textContent()).toBe('Copy path');
    await button.click(); await acknowledge((await posted('copyToClipboard')).at(-1)); expect(await button.textContent()).toBe('Copied!');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('out-of-order copy results update their controls without replacing the newest operation feedback', async () => {
    await copy().click(); const first = (await posted('copyMessageMarkdown')).at(-1);
    await copyCode().click(); const second = (await posted('copyToClipboard')).at(-1);
    await acknowledge(second, { success: false, error: 'Latest code copy failed' }); await acknowledge(first);
    expect(await toast().textContent()).toBe('Latest code copy failed');
    expect(await copy().evaluate(node => node.classList.contains('copied'))).toBe(true);
    expect(await copyCode().textContent()).toBe('Copy code');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('cancelled Save restores its control without falsely reporting a clipboard copy or error', async () => {
    await action('export-json-btn'); const request = (await posted('exportToFile')).at(-1);
    await acknowledge(request, { operation: 'file', success: false, cancelled: true });
    expect(await toastShowing()).toBe(false); expect(await page.locator('#export-json-btn').isEnabled()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('share-format notices and malicious error text are rendered honestly as text', async () => {
    await receive('triggerShareLink', { conversationId: 'original' }); const request = (await posted('triggerShareLink')).at(-1);
    await acknowledge(request, { operation: 'share', format: 'json', notice: 'Full JSON copied because this conversation exceeds link limits.' });
    expect(await toast().textContent()).toContain('Full JSON copied');
    await copy().click(); const next = (await posted('copyMessageMarkdown')).at(-1);
    const error = '<img src=x onerror="window.transferInjected=true">';
    await acknowledge(next, { success: false, error });
    expect(await toast().textContent()).toBe(error); expect(await toast().locator('img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).transferInjected)).toBeUndefined();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a stale slash trigger and detached saved Copy control cannot act on a new chat', async () => {
    await copy().evaluate(button => { (window as any).__oldCopy = button; });
    await receive('conversationChanged', { ...original, id: 'replacement' });
    await receive('triggerExport', { conversationId: 'original' }); await receive('triggerImport', { conversationId: 'original' });
    await receive('triggerShareLink', { conversationId: 'original' }); await page.evaluate(() => (window as any).__oldCopy.click());
    for (const type of ['exportConversation', 'importFromFile', 'triggerShareLink', 'copyMessageMarkdown']) expect(await posted(type)).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an imported view does not inherit or drain the old draft, files and held queue', async () => {
    await receive('responseStarted', { provider: 'claude-code' }); await stage('queued.txt');
    await page.locator('#message-input').fill('Held old writer'); await page.locator('#message-input').press('Tab');
    await stage('draft.txt'); await page.locator('#message-input').fill('Old draft');
    await receive('triggerImport', { conversationId: 'original' }); const request = (await posted('importFromFile')).at(-1);
    await receive('conversationChanged', { id: 'imported', messages: [{ id: 'imported-answer', role: 'assistant', content: '**Imported** <script>window.transferInjected=true</script>' }] });
    await acknowledge(request, { operation: 'import' });
    expect(await page.locator('#message-input').inputValue()).toBe(''); expect(await page.locator('.attachment-name').count()).toBe(0);
    expect(await page.locator('.queued-chip').count()).toBe(0); expect(await toastShowing()).toBe(false);
    expect(await page.evaluate(() => (window as any).transferInjected)).toBeUndefined();
    await page.locator('#history-btn').click(); await receive('conversationHistory', { currentId: 'imported', conversations: [original] });
    await page.locator('.history-item[data-conversation-id="original"] .history-item-info').click(); await receive('conversationChanged', original);
    expect(await page.locator('#message-input').inputValue()).toBe('Old draft'); expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Held old writer']); expect(await posted('sendMessage')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('fifty actual Copy interactions settle independently without stale feedback locking the control', async () => {
    const ids = new Set<string>();
    for (let index = 0; index < 50; index++) {
      await copyCode().click(); const request = (await posted('copyToClipboard')).at(-1); owned(request);
      expect(request.payload.text).toBe(code); expect(ids.has(request.payload.requestId)).toBe(false); ids.add(request.payload.requestId);
      await acknowledge(request); expect(await copyCode().isEnabled()).toBe(true);
    }
    expect(await posted('copyToClipboard')).toHaveLength(50); expect(await posted('sendMessage')).toEqual([]);
  }, 30_000);

  it.skipIf(CHROMIUM_UNAVAILABLE)('Import in Actions immediately opens its host request during an active reply without silently sending the draft', async () => {
    await receive('responseStarted', { provider: 'claude-code' }); await page.locator('#message-input').fill('Unsent during import');
    await action('import-conversation-btn'); const request = (await posted('importFromFile')).at(-1); owned(request);
    expect(await posted('sendMessage')).toEqual([]); expect(await page.locator('#message-input').inputValue()).toBe('Unsent during import');
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
    await acknowledge(request, { operation: 'import', cancelled: true });
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
    expect(await page.locator('#import-conversation-btn').isEnabled()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('imported edits preserve original Input/Output without granting Revert, while a fresh live Edit remains usable', async () => {
    const historic = { id: 'imported-edit', name: 'Edit', input: { file_path: '/fixture/retry.ts', old_string: 'old value', new_string: 'new value' },
      status: 'completed', output: 'Imported tool result.', historicalOnly: true };
    await receive('conversationChanged', { id: 'imported', messages: [{ id: 'imported-answer', role: 'assistant', content: 'Imported edit.', toolCalls: [historic] }] });
    expect(await page.locator('.tool-call[data-id="imported-edit"] .tool-call-content').textContent()).toBe(JSON.stringify(historic.input, null, 2));
    expect(await page.locator('.tool-call[data-id="imported-edit"] .tool-call-output-content').textContent()).toBe(historic.output);
    expect(await page.locator('.edit-report-btn-revert:not(:disabled), .file-edit-revert:not(:disabled)').count()).toBe(0);
    const fresh = { ...historic, id: 'fresh-edit', historicalOnly: false };
    await receive('responseStarted', { provider: 'claude-code' }); await receive('toolUse', { ...fresh, status: 'running' }); await receive('toolResult', fresh);
    expect(await page.locator('.edit-report-card[data-tool-id="fresh-edit"] .edit-report-btn-revert').isEnabled()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a marked historical tool result cannot create a live Revert affordance during result rendering', async () => {
    const historic = { id: 'imported-edit', name: 'Edit', input: { file_path: '/fixture/retry.ts', old_string: 'old value', new_string: 'new value' },
      status: 'completed', output: 'Imported tool result.', historicalOnly: true };
    await receive('conversationChanged', { id: 'imported', messages: [{ id: 'imported-answer', role: 'assistant', content: 'Imported edit.', toolCalls: [historic] }] });
    await receive('toolResult', historic);
    const revert = page.locator('.edit-report-card[data-tool-id="imported-edit"] .edit-report-btn-revert');
    expect(await revert.isDisabled()).toBe(true); expect(await revert.getAttribute('title')).toBe('Imported history cannot revert workspace files');
    expect(await page.locator('.edit-report-card[data-tool-id="imported-edit"] .edit-report-diff').textContent()).toContain('new value');
    await revert.evaluate(button => (button as HTMLButtonElement).click()); expect(await posted('revertFileEdit')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('actual JSON import repairs invalid tool status and the renderer also keeps unvalidated status inert', async () => {
    const status = 'completed"><img src=x onerror="window.transferInjected=true">';
    const input = { file_path: '/fixture/retry.ts', detail: '<script>literal input</script>' };
    const store = new Map<string, unknown>();
    const manager = new ConversationManager({ globalState: {
      get: (key: string, fallback: unknown) => store.has(key) ? store.get(key) : fallback,
      update: async (key: string, value: unknown) => { store.set(key, value); },
    } } as any);
    const imported = manager.importFromContent(JSON.stringify({ messages: [
      { role: 'assistant', content: 'Imported tool owner.', toolCalls: [{ id: 'untrusted-tool', name: 'Read', input, output: 'Original output', status }] },
      { role: 'assistant', content: 'Neighbor still renders.' },
    ] }), 'untrusted.json')!;
    expect(imported).not.toBeNull(); expect(imported.messages[0].toolCalls![0].status).toBe('failed');
    expect(manager.getLastImportDiagnostic()).toContain('An invalid tool status was replaced with failed');
    await receive('conversationChanged', imported);
    const tool = page.locator('.tool-call[data-id="untrusted-tool"]');
    expect(await tool.locator('img, script').count()).toBe(0);
    expect(await tool.locator('.tool-call-status').textContent()).toBe('failed');
    expect(await tool.locator('.tool-call-content').textContent()).toBe(JSON.stringify(input, null, 2));
    expect(await page.locator('.message.assistant').count()).toBe(2);
    // The browser must also defend live or older host boundaries that have
    // not passed through the current importer. Keep their raw data literal.
    const unvalidated = JSON.parse(JSON.stringify(imported));
    unvalidated.messages[0].toolCalls[0].status = status;
    await receive('conversationChanged', unvalidated);
    expect(await tool.locator('.tool-call-status').textContent()).toBe(status);
    expect(await tool.locator('.tool-call-status').getAttribute('class')).toBe('tool-call-status unknown');
    await receive('toolResult', unvalidated.messages[0].toolCalls[0]);
    expect(await tool.locator('.tool-call-output-content').textContent()).toBe('Original output');
    expect(await tool.locator('img, script').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).transferInjected)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('the completed import sequence shows restrictions in the new conversation after clearing the old view', async () => {
    await action('import-conversation-btn'); const request = (await posted('importFromFile')).at(-1);
    await acknowledge(request, { operation: 'import' });
    expect(await page.locator('#import-conversation-btn').isEnabled()).toBe(true);
    await receive('conversationChanged', { id: 'imported', messages: [] });
    await receive('sessionCleared');
    const notice = 'Attachment cards were kept without embedded file data. Imported tool calls cannot undo local files.';
    await receive('conversationImportNotice', { conversationId: 'imported', notice });
    expect(await toast().textContent()).toBe(notice);
    expect(await toast().evaluate(node => node.classList.contains('visible'))).toBe(true);
    await receive('conversationImportNotice', { conversationId: 'original', notice: 'Late old warning' });
    await receive('conversationImportNotice', { notice: 'Missing owner warning' });
    expect(await toast().textContent()).toBe(notice);
    await receive('conversationChanged', original);
    await receive('conversationImportNotice', { conversationId: 'imported', notice: 'Detached warning' });
    expect(await toast().evaluate(node => node.classList.contains('visible'))).toBe(false);
  });
});
