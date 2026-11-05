import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

// Ordinary composer sends require the same known capabilities supplied by the host.
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);

describe('PC-06 composer ownership and submission in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  const sends = async () => (await posted()).filter(event => ['sendMessage', 'sendBrainstormMessage', 'executeSlashCommand'].includes(event.type));
  const stage = async (name: string) => receive('fileAttachmentSelected', { attachments: [
    { id: name, type: 'file', fileName: name, mimeType: 'text/plain', base64Data: Buffer.from(name).toString('base64') },
  ] });
  const finish = (id: string) => receive('responseComplete', { message: { id, role: 'assistant', provider: 'claude-code', content: 'Controlled completion ' + id } });
  const queue = async (text: string) => { await page.locator('#message-input').fill(text); await page.locator('#message-input').press('Tab'); };
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 600, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'composer-owner', conversation: { id: 'original', messages: [] },
      providers: registry.getAll().map(entry => entry.config), providerManifest: buildProviderManifestPayload(registry),
    });
    await page.waitForFunction(() => (window as any).__posted.some((event: any) => event.type === 'uiReady'));
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Qwen reported model updates the live and stopped attribution without changing the composer', async () => {
    await receive('responseStarted', { provider: 'qwen-code', model: 'qwen3-coder' });
    await receive('responseChunk', { type: 'model_info', provider: 'qwen-code', model: 'coder-model', requestedModel: 'qwen3-coder' });
    expect(await page.locator('.message.assistant').count()).toBe(0);
    await receive('responseChunk', { type: 'text', content: 'Retained model response.' });
    await queue('Held follow-up'); await page.locator('#message-input').fill('Unsent draft');
    const before = await posted(), selected = await page.locator('#model-select').inputValue();
    await receive('responseChunk', { type: 'model_info', provider: 'qwen-code', model: 'fallback-model', requestedModel: 'qwen3-coder' });
    expect(await page.locator('.message.streaming .message-model-info').textContent()).toBe('Qwen · fallback model (requested Qwen3 Coder)');
    expect(await page.locator('.message.streaming .message-body').innerText()).toBe('Retained model response.');
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent draft');
    expect(await page.locator('.queued-chip').count()).toBe(1);
    expect(await page.locator('#model-select').inputValue()).toBe(selected);
    expect(await posted()).toEqual(before);
    await receive('requestCancelled', { message: { id: 'reported-partial', role: 'assistant', provider: 'qwen-code',
      model: 'fallback-model', requestedModel: 'qwen3-coder', content: 'Retained model response.' } });
    expect(await page.locator('[data-id="reported-partial"] .message-model-info').textContent()).toBe('Qwen · fallback model (requested Qwen3 Coder)');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Qwen reported model renders restored attribution and resets the next turn without a report', async () => {
    await receive('initialState', { ...INITIAL_STATE, panelId: 'composer-owner',
      providers: registry.getAll().map(entry => entry.config), providerManifest: buildProviderManifestPayload(registry),
      conversation: { id: 'restored-model', messages: [{ id: 'restored', role: 'assistant', provider: 'qwen-code',
        model: 'coder-model', requestedModel: 'qwen3-coder', content: 'Restored answer.' }] } });
    expect(await page.locator('[data-id="restored"] .message-model-info').textContent()).toBe('Qwen · Qwen Coder (OAuth) (requested Qwen3 Coder)');
    await receive('responseStarted', { provider: 'qwen-code', model: 'qwen3-coder' });
    await receive('responseChunk', { type: 'text', content: 'Fresh answer.' });
    expect(await page.locator('.message.streaming .message-model-info').textContent()).toBe('Qwen · Qwen3 Coder');
    await receive('responseComplete', { message: { id: 'fresh-model', role: 'assistant', provider: 'qwen-code', model: 'qwen3-coder', content: 'Fresh answer.' } });
    expect(await page.locator('[data-id="fresh-model"] .message-model-info').textContent()).toBe('Qwen · Qwen3 Coder');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('D05: labels plain diagnostics without duplicating a provider Error prefix', async () => {
    const nativeError = 'Error: Model "gpt-6-luna" from --model flag is not available.';
    const before = (await posted()).length;
    await receive('error', 'The response was interrupted.');
    await receive('error', nativeError);
    expect(await page.locator('.message.error .message-content').allTextContents()).toEqual([
      'Error: The response was interrupted.', nativeError,
    ]);
    expect((await posted()).slice(before)).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('D05: keeps a partial answer and escapes an already-prefixed error', async () => {
    await receive('responseStarted', { provider: 'claude-code', model: 'partial-model' });
    await receive('responseChunk', { type: 'text', content: 'Retained partial answer.' });
    const message = { id: 'd05-partial', role: 'assistant', provider: 'claude-code', model: 'partial-model',
      content: 'Retained partial answer.', segments: [{ type: 'text', content: 'Retained partial answer.' }] };
    const diagnostic = 'Error: Provider rejected <img src=x onerror="throw 1">.';
    await receive('error', { error: diagnostic, message });
    expect(await page.locator('.message.assistant[data-id="d05-partial"] .message-body').innerText()).toBe(message.content);
    expect(await page.locator('.message.error .message-content').textContent()).toBe(diagnostic);
    expect(await page.locator('.message.error img').count()).toBe(0);
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    expect(await sends()).toEqual([]);
  });

  for (const mode of ['idle', 'busy', 'autocomplete']) for (const key of ['Enter', 'Tab', 'legacy229']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${mode}: ${key} confirms IME composition without sending, queueing or accepting ghost text`, async () => {
      if (mode === 'busy') await receive('responseStarted', { provider: 'claude-code' });
      await page.locator('#message-input').fill('日本語の候補');
      if (mode === 'autocomplete') await receive('autocompleteSuggestion', { suggestion: ' unwanted autocomplete' });
      const before = (await posted()).length;
      await page.locator('#message-input').evaluate((input, kind) => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候補' }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true,
          key: kind === 'legacy229' ? 'Enter' : kind, isComposing: kind !== 'legacy229', keyCode: kind === 'legacy229' ? 229 : 0 }));
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候補' }));
      }, key);
      expect(await page.locator('#message-input').inputValue()).toBe('日本語の候補');
      expect(await page.locator('.queued-chip').count()).toBe(0);
      expect((await posted()).slice(before).filter(event => ['sendMessage', 'executeSlashCommand', 'requestAutocomplete'].includes(event.type))).toEqual([]);
    });
  }

  for (const busy of [false, true]) it.skipIf(CHROMIUM_UNAVAILABLE)(`Shift+Enter creates one newline ${busy ? 'while busy' : 'while idle'} and held Enter cannot submit a new draft`, async () => {
    if (busy) await receive('responseStarted', { provider: 'claude-code' });
    await page.locator('#message-input').fill('first line');
    await page.locator('#message-input').press('Shift+Enter');
    expect(await page.locator('#message-input').inputValue()).toBe('first line\n');
    expect(await sends()).toHaveLength(0);
    await page.locator('#message-input').fill('new draft while Enter is held');
    await page.locator('#message-input').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })));
    expect(await page.locator('#message-input').inputValue()).toBe('new draft while Enter is held');
    expect(await sends()).toHaveLength(0); expect(await page.locator('.queued-chip').count()).toBe(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('three queued amendments retain FIFO and owned files after removing the middle item', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    for (const name of ['first', 'removed', 'last']) { await stage(name + '.txt'); await queue(name); }
    await page.locator('.queued-chip').filter({ hasText: 'removed' }).locator('.queued-chip-remove').click();
    await page.locator('#message-input').fill('unfinished draft'); await stage('draft-only.txt');
    await finish('parent');
    expect((await sends()).map(event => ({ text: event.payload.content, files: event.payload.attachments?.map((file: any) => file.fileName) })))
      .toEqual([{ text: 'first', files: ['first.txt'] }]);
    await finish('first');
    expect((await sends()).map(event => ({ text: event.payload.content, files: event.payload.attachments?.map((file: any) => file.fileName) })))
      .toEqual([{ text: 'first', files: ['first.txt'] }, { text: 'last', files: ['last.txt'] }]);
    expect(await page.locator('#message-input').inputValue()).toBe('unfinished draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft-only.txt']);
    expect(await page.locator('.queued-chip').count()).toBe(0);
  });

  for (const stop of ['button', 'Escape', 'stall-stop', 'stall-handoff']) it.skipIf(CHROMIUM_UNAVAILABLE)(`${stop}: completion in transit after Stop holds queued files until an explicit new send`, async () => {
    if (stop.startsWith('stall-')) await page.clock.install();
    await page.locator('#message-input').fill('Original request'); await page.locator('#send-btn').click();
    await receive('messageAdded', { id: 'original-question', role: 'user', content: 'Original request' });
    await receive('responseStarted', { provider: 'claude-code' });
    await receive('responseChunk', { type: 'text', content: 'Partial before Stop.' });
    await stage('queued-write.txt'); await queue('Retained queued writer');
    await stage('removed-write.txt'); await queue('Remove before recovery');
    await page.locator('#message-input').fill('Independent recovery draft'); await stage('draft.txt');
    if (stop.startsWith('stall-')) {
      await page.clock.fastForward('02:00');
      await page.locator(`.stall-btn[data-stall="${stop === 'stall-stop' ? 'stop' : 'hand'}"]`).click();
    } else if (stop === 'Escape') await page.locator('#message-input').press('Escape');
    else await page.locator('#stop-btn').click();
    expect((await posted()).filter(event => event.type === 'cancelRequest')).toHaveLength(1);

    // The host posted completion before it handled cancelRequest. Deliver that
    // already-in-transit event before the cancellation acknowledgement.
    await finish('completed-before-cancel-ack');
    expect((await sends()).map(event => event.payload.content)).toEqual(['Original request']);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Retained queued writer', 'Remove before recovery']);
    expect(await page.locator('.queued-chip-att').count()).toBe(2);
    expect(await page.locator('#message-input').inputValue()).toBe('Independent recovery draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    await receive('requestCancelled');
    if (stop === 'stall-handoff') {
      expect(await page.locator('#second-opinion-menu').count()).toBe(1);
      await page.keyboard.press('Escape');
    }
    await finish('late-completion-after-cancel-ack');
    expect(await sends()).toHaveLength(1);

    // Public removal must stay effective; the other held item intentionally
    // resumes only after an accepted explicit request finishes.
    await page.locator('.queued-chip').filter({ hasText: 'Remove before recovery' }).locator('.queued-chip-remove').click();
    await page.locator('#send-btn').click();
    expect((await sends())[1]).toMatchObject({ payload: { content: 'Independent recovery draft', attachments: [{ fileName: 'draft.txt' }] } });
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Retained queued writer']);
    await finish('explicit-recovery');
    expect((await sends()).map(event => event.payload.content)).toEqual(['Original request', 'Independent recovery draft', 'Retained queued writer']);
    expect((await sends())[2].payload.attachments.map((file: any) => file.fileName)).toEqual(['queued-write.txt']);
    expect(await page.locator('.queued-chip').count()).toBe(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Stop queue hold belongs to its conversation across navigation and public removal before recovery', async () => {
    await page.locator('#message-input').fill('Original request'); await page.locator('#send-btn').click();
    await receive('responseStarted', { provider: 'claude-code' });
    await stage('held-writer.txt'); await queue('Held writer');
    await page.locator('#stop-btn').click(); await receive('requestCancelled');
    await receive('conversationChanged', { id: 'other', messages: [] });
    // An unrelated incoming turn has its own queue, without an explicit local
    // send that could otherwise hide an accidentally inherited pause.
    await receive('responseStarted', { provider: 'claude-code' }); await queue('Other follow-up');
    await finish('other-parent'); await finish('other-follow-up');
    expect((await sends()).map(event => event.payload.content)).toEqual(['Original request', 'Other follow-up']);
    await receive('conversationChanged', { id: 'original', messages: [] });
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Held writer']);
    await finish('old-completion-after-navigation');
    expect(await sends()).toHaveLength(2);
    await page.locator('.queued-chip-remove').click();
    await page.locator('#message-input').fill('Fresh recovery'); await page.locator('#send-btn').click();
    await finish('fresh-recovery');
    expect((await sends()).map(event => event.payload.content)).toEqual(['Original request', 'Other follow-up', 'Fresh recovery']);
    expect((await sends())[2].payload.attachments).toBeUndefined();
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('attachment-only input can be queued while busy and never leaks into the later draft', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await stage('only-attachment.txt'); await page.locator('#message-input').press('Enter');
    expect(await page.locator('.queued-chip').count()).toBe(1);
    expect(await page.locator('.attachment-preview-item').count()).toBe(0);
    await page.locator('#message-input').fill('keep draft'); await stage('draft.txt');
    await finish('parent');
    expect((await sends())[0]).toMatchObject({ type: 'sendMessage', payload: { content: '', attachments: [{ fileName: 'only-attachment.txt' }] } });
    expect(await page.locator('#message-input').inputValue()).toBe('keep draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('draining an already queued message during dictation neither drops it nor finishes speech intended for the draft', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await stage('queued.txt'); await queue('already queued');
    await page.locator('#message-input').fill('dictated draft'); await stage('draft.txt');
    await page.locator('#dictation-btn').click();
    const requestId = (await posted()).filter(event => event.type === 'startDictation').at(-1).payload.requestId;
    await receive('dictationState', { requestId, state: 'active' });
    await finish('parent');
    expect((await sends()).map(event => event.payload.content)).toEqual(['already queued']);
    expect((await sends())[0].payload.attachments.map((file: any) => file.fileName)).toEqual(['queued.txt']);
    expect((await posted()).filter(event => event.type === 'finishDictation')).toHaveLength(0);
    expect(await page.locator('#message-input').inputValue()).toBe('dictated draft');
    await receive('dictationState', { requestId, state: 'complete', text: 'spoken continuation' });
    expect(await page.locator('#message-input').inputValue()).toBe('dictated draft spoken continuation');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    expect(await sends()).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('queued native slash submission latches, carries its files and ignores the late ack after the next turn starts', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await stage('native.txt'); await queue('/native-review retry'); await queue('next amendment');
    await page.locator('#message-input').fill('unfinished draft'); await stage('draft.txt');
    await finish('parent');
    const command = (await sends())[0];
    expect(command).toMatchObject({ type: 'executeSlashCommand', payload: { command: 'native-review', args: 'retry', attachments: [{ fileName: 'native.txt' }] } });
    expect(command.payload.requestId).toEqual(expect.any(String));
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
    expect(await page.locator('#message-input').inputValue()).toBe('unfinished draft');
    await receive('responseStarted', { provider: 'claude-code' }); await finish('native');
    expect((await sends()).map(event => event.type)).toEqual(['executeSlashCommand', 'sendMessage']);
    await receive('slashCommandCompleted', { requestId: command.payload.requestId, kind: 'turn', success: true });
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
    expect(await sends()).toHaveLength(2);
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a queued local slash action continues FIFO only after its own acknowledgement and restores unused files', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await stage('unused-for-help.txt'); await queue('/help'); await queue('after help');
    await page.locator('#message-input').fill('personal draft'); await stage('draft.txt');
    await finish('parent');
    const command = (await sends())[0]; expect(command.payload.requestId).toEqual(expect.any(String));
    await receive('slashCommandCompleted', { requestId: 'stale-command', kind: 'action', success: true });
    expect(await sends()).toHaveLength(1); expect(await page.locator('#stop-btn').isVisible()).toBe(true);
    await receive('slashCommandResult', { command: 'help', result: 'Local help text' });
    expect(await sends()).toHaveLength(1);
    await receive('slashCommandCompleted', { requestId: command.payload.requestId, kind: 'action', success: true });
    expect((await sends()).map(event => event.payload.content || '/' + event.payload.command)).toEqual(['/help', 'after help']);
    expect((await sends())[1].payload.attachments).toBeUndefined();
    expect(await page.locator('#message-input').inputValue()).toBe('personal draft');
    expect((await page.locator('.attachment-name').allTextContents()).sort()).toEqual(['draft.txt', 'unused-for-help.txt']);
  });

  for (const busy of [false, true]) it.skipIf(CHROMIUM_UNAVAILABLE)(`native slash menu ${busy ? 'queues behind the active turn' : 'submits once'} with the selected command identity and files`, async () => {
    const context = [{ id: 'retry-source', type: 'file', path: '/fixture/retry.ts', name: 'retry.ts', content: 'export const retryBase = 73;', language: 'typescript' }];
    await receive('contextUpdated', context);
    if (busy) await receive('responseStarted', { provider: 'claude-code' });
    await stage('menu-command.txt');
    await page.locator('#message-input').fill('/');
    await receive('slashCommandMenu', { commands: [{ id: 'native:claude-code:review', nativeName: 'review',
      label: '/review', description: 'Review a change', section: 'native' }], sections: [{ id: 'native', label: 'Agent commands', order: 1 }] });
    await page.locator('.slash-menu-item[data-command-id="native:claude-code:review"]').click();
    if (busy) {
      expect(await sends()).toHaveLength(0);
      expect(await page.locator('.queued-chip').count()).toBe(1);
      await page.locator('#message-input').fill('independent draft');
      await finish('parent');
      expect(await page.locator('#message-input').inputValue()).toBe('independent draft');
    }
    expect(await sends()).toHaveLength(1);
    expect((await sends())[0]).toMatchObject({ type: 'executeSlashCommand', payload: {
      commandId: 'native:claude-code:review', command: 'review', args: '', requestId: expect.any(String), attachments: [{ fileName: 'menu-command.txt' }],
    } });
    expect((await sends())[0].payload.settings).toMatchObject(INITIAL_STATE.settings);
    expect((await sends())[0].payload.context).toEqual(context);
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
  });

  for (const draft of ['', 'independently typed draft']) it.skipIf(CHROMIUM_UNAVAILABLE)(`slash prefill restores unused files and pauses the queue with ${draft ? 'a newer draft preserved' : 'editable required arguments'}`, async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await stage('prefill.txt'); await queue('/review'); await queue('next amendment');
    await finish('parent');
    const command = (await sends())[0];
    await page.locator('#message-input').fill(draft); await stage('new-draft.txt');
    await receive('slashCommandCompleted', { requestId: command.payload.requestId, kind: 'prefill', success: true, prefill: '/review <change>' });
    expect(await page.locator('#message-input').inputValue()).toBe(draft || '/review <change>');
    if (draft) expect(await page.locator('#messages').textContent()).toContain('/review <change>');
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    expect(await page.locator('.queued-chip').count()).toBe(1);
    expect(await sends()).toHaveLength(1);
    expect((await page.locator('.attachment-name').allTextContents()).sort()).toEqual(['new-draft.txt', 'prefill.txt']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a failed slash command exposes its error, restores files, and keeps queued work for an explicit next send', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await stage('failed-command.txt'); await queue('/deleted-command'); await queue('do not automatically send');
    await page.locator('#message-input').fill('working draft'); await finish('parent');
    const command = (await sends())[0];
    await receive('slashCommandCompleted', { requestId: command.payload.requestId, kind: 'error', success: false,
      error: '/deleted-command is no longer available for this agent.' });
    expect(await page.locator('#messages').textContent()).toContain('/deleted-command is no longer available for this agent.');
    expect(await page.locator('#message-input').inputValue()).toBe('working draft');
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    expect(await page.locator('.queued-chip').count()).toBe(1); expect(await sends()).toHaveLength(1);
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['failed-command.txt']);
    await receive('slashCommandCompleted', { requestId: command.payload.requestId, kind: 'action', success: true });
    expect(await sends()).toHaveLength(1);
  });

  for (const busy of [false, true]) it.skipIf(CHROMIUM_UNAVAILABLE)(`a ${busy ? 'queued' : 'direct'} second opinion keeps its explicit respondent and leaves the dictation draft active`, async () => {
    const source = '@claude Review **this source** exactly.';
    await receive('messageAdded', { id: 'original-question', role: 'user', content: source });
    await receive('responseComplete', { message: { id: 'answer-with-opinion', role: 'assistant', provider: 'claude-code', content: 'Initial review.' }, usage: { input_tokens: 10, output_tokens: 5 } });
    if (busy) await receive('responseStarted', { provider: 'claude-code' });
    await page.locator('#message-input').fill('voice draft');
    await page.locator('#dictation-btn').click();
    const requestId = (await posted()).filter(event => event.type === 'startDictation').at(-1).payload.requestId;
    await receive('dictationState', { requestId, state: 'active' });
    await page.locator('[data-id="answer-with-opinion"] [data-second-opinion]').click({ timeout: 1000 });
    await page.locator('.second-opinion-item[data-agent="openai-codex"]').click({ timeout: 1000 });
    if (busy) {
      expect(await page.locator('.queued-chip-text').textContent()).toBe(source);
      expect(await page.locator('.queued-chip-target').count()).toBe(1);
      expect(await page.locator('.queued-chip-target').textContent()).toMatch(/codex/i);
      expect(await sends()).toHaveLength(0);
      await finish('intervening-turn');
    }
    expect(await sends()).toHaveLength(1);
    expect((await sends())[0]).toMatchObject({ type: 'sendMessage', payload: { content: source,
      secondOpinion: { provider: 'openai-codex', messageId: 'original-question' } } });
    expect((await posted()).filter(event => event.type === 'finishDictation')).toHaveLength(0);
    await receive('dictationState', { requestId, state: 'complete', text: 'continuation' });
    expect(await page.locator('#message-input').inputValue()).toBe('voice draft continuation');
  });

  for (const streamed of [false, true]) it.skipIf(CHROMIUM_UNAVAILABLE)(`stalled ${streamed ? 'partial' : 'pre-token'} handoff waits for Stop acknowledgement, then resends the real source before the retained queue`, async () => {
    await page.clock.install();
    const source = '@claude Review **the original retry requirement**.';
    await stage('original.txt');
    await page.locator('#message-input').fill(source); await page.locator('#send-btn').click();
    const original = (await sends())[0].payload;
    await receive('messageAdded', { id: 'stalled-question', role: 'user', content: source, attachments: original.attachments });
    await receive('responseStarted', { provider: 'claude-code' });
    if (streamed) await receive('responseChunk', { type: 'text', content: 'Partial analysis before silence.' });
    await queue('retain this queued follow-up');
    await page.locator('#message-input').fill('independent draft'); await stage('draft.txt');
    await page.clock.fastForward('02:00');
    await page.locator('.stall-btn[data-stall="hand"]').click();
    expect((await posted()).filter(event => event.type === 'cancelRequest')).toHaveLength(1);
    expect(await page.locator('#second-opinion-menu').count()).toBe(0);
    expect(await sends()).toHaveLength(1);
    await receive('requestCancelled');
    expect(await page.locator('#second-opinion-menu').count()).toBe(1);
    expect(await page.locator('.second-opinion-item[data-agent="claude-code"]').count()).toBe(0);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['retain this queued follow-up']);
    await page.locator('.second-opinion-item[data-agent="openai-codex"]').click();
    expect(await sends()).toHaveLength(2);
    expect((await sends())[1]).toMatchObject({ type: 'sendMessage', payload: { content: source,
      attachments: original.attachments, secondOpinion: { provider: 'openai-codex', messageId: 'stalled-question' } } });
    expect(await page.locator('#message-input').inputValue()).toBe('independent draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['retain this queued follow-up']);
    expect(await page.locator('.message.user').count()).toBe(1);
    expect(await page.locator('.message.assistant').count()).toBe(streamed ? 1 : 0);
    await finish('handoff-answer');
    expect((await sends()).map(event => event.payload.content)).toEqual([source, source, 'retain this queued follow-up']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('navigation dismisses a pending stalled handoff before its delayed cancellation acknowledgement', async () => {
    await page.clock.install();
    await page.locator('#message-input').fill('Owned stalled question'); await page.locator('#send-btn').click();
    await receive('messageAdded', { id: 'stalled-question', role: 'user', content: 'Owned stalled question' });
    await receive('responseStarted', { provider: 'claude-code' });
    await page.clock.fastForward('02:00'); await page.locator('.stall-btn[data-stall="hand"]').click();
    await receive('conversationChanged', { id: 'successor', messages: [] });
    await page.locator('#message-input').fill('successor draft'); await receive('requestCancelled');
    expect(await page.locator('#second-opinion-menu').count()).toBe(0);
    expect(await sends()).toHaveLength(1);
    expect(await page.locator('#message-input').inputValue()).toBe('successor draft');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('100 draft edits and 50 three-item bursts preserve FIFO, cancellation and the unsent draft', async () => {
    const started = Date.now();
    for (let index = 0; index < 50; index++) {
      await receive('responseStarted', { provider: 'claude-code' });
      await queue(`first-${index}`); await queue(`remove-${index}`); await queue(`last-${index}`);
      await page.locator('.queued-chip').filter({ hasText: `remove-${index}` }).locator('.queued-chip-remove').click();
      await page.locator('#message-input').fill(`draft-${index}-one`);
      await page.locator('#message-input').fill(`draft-${index}-two`);
      await finish(`parent-${index}`); await finish(`first-${index}`); await finish(`last-${index}`);
      expect(await page.locator('#message-input').inputValue()).toBe(`draft-${index}-two`);
      expect(await page.locator('.queued-chip').count()).toBe(0);
    }
    expect((await sends()).map(event => event.payload.content)).toEqual(Array.from({ length: 50 }, (_, index) => [`first-${index}`, `last-${index}`]).flat());
    const evidence = { draftEdits: 100, threeItemBursts: 50, removedItems: 50, dispatchedItems: 100,
      elapsedMs: Date.now() - started, scope: 'Controlled browser replies; not live provider calls or an elapsed 8-hour workday.' };
    if (process.env.MYSTI_PC06_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.MYSTI_PC06_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MYSTI_PC06_ARTIFACT_DIR, 'composer-load.json'), JSON.stringify(evidence, null, 2));
    }
  }, 30_000);
});
