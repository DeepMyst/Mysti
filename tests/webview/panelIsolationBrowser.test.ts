import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry);
const providers = ['claude-code', 'openai-codex', 'google-gemini'];
const models = providers.map((provider, index) => ({ id: 'owned-model-' + index, name: 'Owned model ' + index }));
const context = (index: number) => [{ id: 'same-context-id', type: 'file', path: '/fixture/panel-' + index + '.ts', content: 'private-context-' + index }];
const question = (index: number, id = 'same-native-question') => ({ toolCallId: id, questions: [
  { header: 'Choice', question: 'Which owner for panel ' + index + '?', options: [{ label: 'Owner ' + index }, { label: 'Alternate ' + index }], multiSelect: false },
] });

// Three independent documents run the shipped scripts. Incoming messages are
// controlled, addressed host deliveries; these tests prove UI state and outgoing
// owner identity, not the host router, VS Code processes, or disk persistence.
describe('PC-09 three-panel isolation in the shipped browser', () => {
  let browser: Browser, pages: Page[], errors: string[];
  const receive = (index: number, type: string, payload?: unknown) => pages[index].evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = (index: number, type: string) => pages[index].evaluate(type =>
    (window as any).__posted.filter((event: any) => event.type === type), type);
  async function boot(index: number): Promise<void> {
    await pages[index].setContent(composeChatHtml());
    await pages[index].addStyleTag({ content: ':root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; }' });
    await receive(index, 'initialState', { ...INITIAL_STATE, panelId: 'panel-' + index, workspacePath: '/fixture',
      conversation: { id: 'conversation-' + index, messages: [] }, context: context(index),
      providers: registry.getAll().map(entry => ({ ...entry.config, models: [models[providers.indexOf(entry.id)] || { id: 'other', name: 'Other' }] })),
      providerManifest: manifest, providerAvailability: Object.fromEntries(manifest.providers.map(entry => [entry.id, { available: true }])),
      settings: { ...(INITIAL_STATE.settings as object), provider: providers[index], model: models[index].id, effortLevel: index === 0 ? 'low' : 'high',
        // Gemini has no native Ask bridge; this panel has explicitly saved Plan.
        ...(providers[index] === 'google-gemini' ? { mode: 'quick-plan', accessLevel: 'read-only' } : {}),
      },
    });
  }
  const stageFile = (index: number, suffix = 'draft') => receive(index, 'fileAttachmentSelected', { attachments: [
    { id: index + '-' + suffix, type: 'file', fileName: 'panel-' + index + '-' + suffix + '.txt', filePath: '/fixture/panel-' + index + '-' + suffix + '.txt', size: 3 },
  ] });
  const permission = (index: number) => receive(index, 'permissionRequest', { id: 'same-native-permission', toolName: 'Edit', expiresAt: 0,
    details: { filePath: '/fixture/panel-' + index + '-canary.txt', oldContent: 'untouched', newContent: 'owner ' + index } });
  async function ask(index: number, id?: string): Promise<void> {
    await receive(index, 'messageAdded', { id: 'question-owner-' + index, role: 'assistant', provider: providers[index], content: 'Panel ' + index + ' needs a choice.' });
    await receive(index, 'askUserQuestion', question(index, id));
  }
  async function assertDraft(index: number): Promise<void> {
    expect(await pages[index].locator('#message-input').inputValue()).toBe('Unsent draft ' + index);
    expect(await pages[index].locator('.attachment-name').allTextContents()).toEqual(['panel-' + index + '-draft.txt']);
    expect(await pages[index].locator('.context-item-path').allTextContents()).toEqual(['panel-' + index + '.ts']);
  }

  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; pages = [];
    for (let index = 0; index < 3; index++) {
      pages.push(await browser.newPage({ viewport: { width: 430, height: 900 } }));
      pages[index].on('pageerror', error => errors.push('panel-' + index + ': ' + error.message));
      await boot(index);
    }
  });
  afterEach(async () => { await Promise.all((pages || []).map(page => page.close())); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('three distinct providers, models, drafts, files and context remain owned through shared catalogues and actual sends', async () => {
    for (let index = 0; index < 3; index++) { await stageFile(index); await pages[index].locator('#message-input').fill('Unsent draft ' + index); }
    await pages[0].locator('#model-menu-btn').click(); await pages[0].locator('#model-menu input[type="range"]').focus();
    await pages[0].keyboard.press('End'); await pages[0].keyboard.press('Escape');
    expect((await posted(0, 'updateSettings')).at(-1)).toMatchObject({ panelId: 'panel-0', payload: { effortLevel: 'max' } });
    for (let index = 0; index < 3; index++) {
      for (const provider of providers) await receive(index, 'modelsUpdated', { provider, models: [{ id: 'shared', name: 'Discovered ' + provider }] });
      await assertDraft(index);
      expect(await pages[index].locator('#model-select-inline').inputValue()).toBe(models[index].id);
      if (index) expect(await posted(index, 'updateSettings')).toEqual([]);
      await pages[index].locator('#send-btn').click();
      expect(await posted(index, 'sendMessage')).toEqual([expect.objectContaining({ panelId: 'panel-' + index, payload: expect.objectContaining({
        content: 'Unsent draft ' + index, settings: expect.objectContaining({ provider: providers[index], model: models[index].id }),
        context: context(index), attachments: [expect.objectContaining({ fileName: 'panel-' + index + '-draft.txt' })],
      }) })]);
    }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('equal context IDs in separate panels toggle and remove only the originating owner', async () => {
    await pages[0].locator('.context-item-toggle').click();
    await pages[1].locator('.context-item-remove').click();
    expect(await posted(0, 'setContextItemEnabled')).toEqual([{ type: 'setContextItemEnabled', panelId: 'panel-0', payload: { id: 'same-context-id', enabled: false } }]);
    expect(await posted(1, 'removeFromContext')).toEqual([{ type: 'removeFromContext', panelId: 'panel-1', payload: 'same-context-id' }]);
    await receive(0, 'contextUpdated', [{ ...context(0)[0], enabled: false }]); await receive(1, 'contextUpdated', []);
    expect(await pages[0].locator('.context-item-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(await pages[1].locator('.context-item').count()).toBe(0);
    expect(await pages[2].locator('.context-item-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(await posted(2, 'setContextItemEnabled')).toEqual([]); expect(await posted(2, 'removeFromContext')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('same-ID approvals can independently allow once, deny and remain pending in three documents', async () => {
    for (let index = 0; index < 3; index++) await permission(index);
    await pages[0].locator('.permission-card [data-action="approve"]').click();
    await pages[1].locator('.permission-card [data-action="deny"]').click();
    expect(await posted(0, 'permissionResponse')).toEqual([{ type: 'permissionResponse', panelId: 'panel-0', payload: { requestId: 'same-native-permission', decision: 'approve', scope: 'this-action' } }]);
    expect(await posted(1, 'permissionResponse')).toEqual([{ type: 'permissionResponse', panelId: 'panel-1', payload: { requestId: 'same-native-permission', decision: 'deny', scope: 'this-action' } }]);
    expect(await pages[2].locator('.permission-card.pending').count()).toBe(1); expect(await posted(2, 'permissionResponse')).toEqual([]);
    await receive(0, 'permissionDismissed', { requestIds: ['same-native-permission'] });
    expect(await pages[2].locator('.permission-card.pending').count()).toBe(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('same-ID questions independently submit, skip and remain unanswered without consuming sibling choices', async () => {
    for (let index = 0; index < 3; index++) await ask(index);
    await pages[0].locator('.auq-option').first().click(); await pages[0].locator('.auq-submit-btn').click();
    await pages[1].locator('.auq-skip-btn').click();
    expect(await posted(0, 'askUserQuestionResponse')).toEqual([{ type: 'askUserQuestionResponse', panelId: 'panel-0', payload: { toolCallId: 'same-native-question', answers: { Choice: 'Owner 0' } } }]);
    expect(await posted(1, 'askUserQuestionSkipped')).toEqual([{ type: 'askUserQuestionSkipped', panelId: 'panel-1', payload: { toolCallId: 'same-native-question' } }]);
    expect(await pages[2].locator('.auq-submit-btn').isDisabled()).toBe(true);
    expect(await pages[2].locator('.auq-question-text').innerText()).toContain('panel 2');
    expect(await posted(2, 'askUserQuestionResponse')).toEqual([]); expect(await posted(2, 'askUserQuestionSkipped')).toEqual([]);
  });

  for (const action of ['submit', 'skip']) it.skipIf(CHROMIUM_UNAVAILABLE)(`a removed question's saved ${action} control cannot answer a replacement conversation`, async () => {
    await ask(0); await pages[0].locator('.auq-option').first().click();
    await pages[0].evaluate(action => { (window as any).__oldQuestionButton = document.querySelector('.auq-' + action + '-btn'); }, action);
    await receive(0, 'conversationChanged', { id: 'replacement-0', messages: [] }); await ask(0);
    await pages[0].evaluate(() => (window as any).__oldQuestionButton.click());
    expect(await posted(0, 'askUserQuestionResponse')).toEqual([]); expect(await posted(0, 'askUserQuestionSkipped')).toEqual([]);
    expect(await pages[0].locator('.auq-submit-btn').isDisabled()).toBe(true);
    await pages[0].locator('.auq-option').nth(1).click(); await pages[0].locator('.auq-submit-btn').click();
    expect((await posted(0, 'askUserQuestionResponse')).at(-1)?.payload.answers).toEqual({ Choice: 'Alternate 0' });
  });

  for (const action of ['submit', 'skip']) it.skipIf(CHROMIUM_UNAVAILABLE)(`one question ${action} settles once when a retained button is activated twice`, async () => {
    await ask(0); await pages[0].locator('.auq-option').first().click();
    await pages[0].evaluate(action => { const button = document.querySelector<HTMLButtonElement>('.auq-' + action + '-btn')!; button.click(); button.click(); }, action);
    expect(await posted(0, action === 'submit' ? 'askUserQuestionResponse' : 'askUserQuestionSkipped')).toHaveLength(1);
  });

  for (const action of ['submit', 'skip']) it.skipIf(CHROMIUM_UNAVAILABLE)(`a timed AI answer makes its saved ${action} callback inert while the sibling question remains usable`, async () => {
    await ask(0); await ask(1); await pages[0].locator('.auq-option').first().click();
    await pages[0].evaluate(action => { (window as any).__oldQuestionButton = document.querySelector('.auq-' + action + '-btn'); }, action);
    await receive(0, 'semiAutonomousDecision', { targetType: 'question', requestId: 'same-native-question', approved: true, reasoning: 'Timed choice for panel 0' });
    expect(await pages[0].locator('.ask-user-question-container.submitted').textContent()).toContain('AI answered on your behalf');
    await pages[0].evaluate(() => (window as any).__oldQuestionButton.click());
    expect(await posted(0, 'askUserQuestionResponse')).toEqual([]); expect(await posted(0, 'askUserQuestionSkipped')).toEqual([]);
    expect(await pages[0].locator('.ask-user-question-container.submitted').textContent()).toContain('Timed choice for panel 0');
    await pages[1].locator('.auq-option').nth(1).click(); await pages[1].locator('.auq-submit-btn').click();
    expect(await posted(1, 'askUserQuestionResponse')).toEqual([{ type: 'askUserQuestionResponse', panelId: 'panel-1',
      payload: { toolCallId: 'same-native-question', answers: { Choice: 'Alternate 1' } } }]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('number and Enter shortcuts answer only the focused document and keep sibling drafts intact', async () => {
    for (let index = 0; index < 3; index++) {
      await ask(index); await stageFile(index); await pages[index].locator('#message-input').fill('Unsent draft ' + index);
    }
    await pages[1].bringToFront(); await pages[1].locator('.auq-question-text').click();
    await pages[1].keyboard.press('2'); await pages[1].keyboard.press('Enter');
    expect(await posted(1, 'askUserQuestionResponse')).toEqual([{ type: 'askUserQuestionResponse', panelId: 'panel-1',
      payload: { toolCallId: 'same-native-question', answers: { Choice: 'Alternate 1' } } }]);
    for (const index of [0, 2]) { expect(await posted(index, 'askUserQuestionResponse')).toEqual([]); expect(await pages[index].locator('.auq-submit-btn').isDisabled()).toBe(true); }
    for (let index = 0; index < 3; index++) await assertDraft(index);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Stop in A holds its queue and draft while B finishes and C continues editing', async () => {
    for (const index of [0, 1]) {
      await pages[index].locator('#message-input').fill('Running task ' + index); await pages[index].locator('#send-btn').click();
      await receive(index, 'responseStarted', { provider: providers[index] });
      await receive(index, 'responseChunk', { type: 'text', content: 'Owner ' + index + ' partial.' });
      await pages[index].locator('#message-input').fill('Held task ' + index); await pages[index].locator('#message-input').press('Tab');
    }
    for (let index = 0; index < 3; index++) { await stageFile(index); await pages[index].locator('#message-input').fill('Unsent draft ' + index); }
    await pages[0].locator('#stop-btn').click(); await receive(0, 'requestCancelled');
    expect(await pages[1].locator('#stop-btn').isVisible()).toBe(true);
    await receive(1, 'responseComplete', { message: { id: 'b-answer', role: 'assistant', provider: providers[1], content: 'Owner 1 final.' } });
    expect((await posted(1, 'sendMessage')).map(event => event.payload.content)).toEqual(['Running task 1', 'Held task 1']);
    expect((await posted(0, 'sendMessage')).map(event => event.payload.content)).toEqual(['Running task 0']);
    expect(await pages[0].locator('.queued-chip-text').allTextContents()).toEqual(['Held task 0']);
    expect(await posted(2, 'sendMessage')).toEqual([]);
    for (let index = 0; index < 3; index++) await assertDraft(index);
    expect((await posted(0, 'cancelRequest')).at(-1)?.panelId).toBe('panel-0');
    expect(await posted(1, 'cancelRequest')).toEqual([]); expect(await posted(2, 'cancelRequest')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('100 focus changes and 30 replaced third documents preserve the two surviving panel drafts and transcript owners', async () => {
    for (const index of [0, 1]) {
      await stageFile(index); await pages[index].locator('#message-input').fill('Unsent draft ' + index);
      await receive(index, 'messageAdded', { id: 'retained-' + index, role: 'assistant', provider: providers[index], content: 'Only panel ' + index });
    }
    for (let cycle = 0; cycle < 100; cycle++) {
      const index = cycle % 3; await pages[index].bringToFront(); await pages[index].locator('#message-input').focus();
      if (cycle < 30) {
        await pages[2].close(); pages[2] = await browser.newPage({ viewport: { width: 430, height: 900 } });
        pages[2].on('pageerror', error => errors.push('replacement-2: ' + error.message)); await boot(2);
        expect(await pages[2].locator('#message-input').inputValue()).toBe('');
      }
      for (const survivor of [0, 1]) await assertDraft(survivor);
    }
    for (const index of [0, 1]) {
      expect(await pages[index].locator('.message').getAttribute('data-id')).toBe('retained-' + index);
      expect(await posted(index, 'sendMessage')).toEqual([]);
    }
  }, 60_000);

  for (const width of [280, 320, 430]) it.skipIf(CHROMIUM_UNAVAILABLE)(`${width}px panel keeps composer and visible action controls inside the viewport after focus and a long model label`, async () => {
    const page = pages[0]; await page.setViewportSize({ width, height: 900 });
    await receive(0, 'modelsUpdated', { provider: providers[0], models: [{ id: models[0].id, name: 'An unusually long enterprise model deployment label ' + 'x'.repeat(100) }] });
    await stageFile(0); await page.locator('#message-input').fill('Visible start of the independent draft');
    await page.locator('#model-menu-btn').click(); await page.keyboard.press('Escape');
    await page.locator('#message-input').focus();
    const bounds = await page.evaluate(() => ({ scrollX, width: innerWidth, elements: ['#message-input', '#send-btn', '#model-menu-btn', '#tools-menu-btn'].map(selector => {
      const element = document.querySelector(selector)!, box = element.getBoundingClientRect();
      return { selector, left: box.left, right: box.right, width: box.width };
    }) }));
    expect(bounds.scrollX).toBe(0);
    for (const box of bounds.elements) { expect(box.left, box.selector).toBeGreaterThanOrEqual(0); expect(box.right, box.selector).toBeLessThanOrEqual(width); expect(box.width).toBeGreaterThan(0); }
    expect(await page.locator('#message-input').inputValue()).toBe('Visible start of the independent draft');
    expect(await posted(0, 'sendMessage')).toEqual([]);
  });
});
