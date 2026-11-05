import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { SlashCommandManager } from '../../src/managers/SlashCommandManager';
import type { ProviderType } from '../../src/types';

// Normal Stop/recovery sends have the same known permissions the host supplies.
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);

// Build the shipped universal/session/native catalog. Hand-picking only
// cmd:clear hides the earlier Context section that caused the native failure.
function fullSlashCatalog(provider: ProviderType = 'openai-codex') {
  const manager = new SlashCommandManager({
    providerManager: { getProviderInstance: () => undefined } as any,
    contextManager: {} as any, conversationManager: {} as any,
    compactionManager: {} as any, memoryManager: {} as any, brainstormManager: {} as any,
  });
  return manager.getCommands('stop-owner', provider, {
    postToPanel: () => {}, updateSettings: async () => {}, getPanelProvider: () => provider,
    getPanelModel: () => '', getModelsForProvider: () => [], executeManualCompaction: async () => {},
  });
}

describe('PC-07 Stop and session recovery in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  let loadProgress: { startedAt: number; completedCycles: number; step: string; cycleMs: number[] } | undefined;
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  const sends = async () => (await posted()).filter(event => event.type === 'sendMessage');
  const stage = (name: string) => receive('fileAttachmentSelected', { attachments: [{ id: name, type: 'file', fileName: name, filePath: '/fixture/' + name, size: 3 }] });
  const finish = (id: string) => receive('responseComplete', { message: { id, role: 'assistant', provider: 'claude-code', content: 'Finished ' + id } });
  const lifecycle = (type: string, extra?: object) => receive('lifecycleEvent', { type, panelId: 'stop-owner', providerId: 'claude-code', ...extra });
  const label = async () => (await page.locator('#session-indicator').textContent())?.trim();
  const permission = (id: string) => receive('permissionRequest', { id, toolName: 'Edit', expiresAt: 0,
    details: { filePath: '/fixture/canary.txt', oldContent: 'untouched', newContent: 'changed' } });

  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; loadProgress = undefined; page = await browser.newPage({ viewport: { width: 620, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'stop-owner', conversation: { id: 'original-chat', messages: [] },
      providers: registry.getAll().map(entry => entry.config), providerManifest: buildProviderManifestPayload(registry),
    });
  });
  afterEach(async () => {
    // Retain progress even when the deadline interrupts a browser action.
    if (loadProgress && process.env.MYSTI_PC07_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.MYSTI_PC07_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MYSTI_PC07_ARTIFACT_DIR, 'stop-browser-progress.json'),
        JSON.stringify({ ...loadProgress, elapsedMs: Date.now() - loadProgress.startedAt }, null, 2));
    }
    await page?.close(); if (errors) expect(errors).toEqual([]);
  });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  for (const control of ['button', 'Escape']) for (const phase of ['pre-token', 'text', 'thinking', 'tool']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${control} stops ${phase} without sending queued work or losing the draft, then permits one explicit new send`, async () => {
      await page.locator('#message-input').fill('Analyze retry ownership'); await page.locator('#send-btn').click();
      await receive('messageAdded', { id: 'question', role: 'user', content: 'Analyze retry ownership' });
      await receive('responseStarted', { provider: 'claude-code' });
      if (phase === 'text' || phase === 'tool') await receive('responseChunk', { type: 'text', content: 'Partial useful analysis.' });
      if (phase === 'thinking') await receive('responseChunk', { type: 'thinking', content: 'Examining ownership.' });
      if (phase === 'tool') await receive('toolUse', { id: 'running-read', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'running' });
      await stage('queued-writer.txt'); await page.locator('#message-input').fill('Create queued-canary.txt'); await page.locator('#message-input').press('Tab');
      await stage('draft.txt'); await page.locator('#message-input').fill('My next independent task');
      if (control === 'button') await page.locator('#stop-btn').click();
      else await page.locator('#message-input').press('Escape');
      expect((await posted()).filter(event => event.type === 'cancelRequest')).toEqual([{ type: 'cancelRequest', panelId: 'stop-owner' }]);
      expect(await sends()).toHaveLength(1);
      await receive('requestCancelled');
      expect(await page.locator('#stop-btn').isVisible()).toBe(false);
      expect(await page.locator('.message.streaming, .streaming-thinking, .tool-call.running, .tool-call.pending').count()).toBe(0);
      if (phase === 'tool') expect(await page.locator('.tool-call-status').textContent()).toBe('stopped');
      if (phase === 'text' || phase === 'tool') expect(await page.locator('.message.assistant').textContent()).toContain('Partial useful analysis.');
      expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Create queued-canary.txt']);
      expect(await page.locator('#message-input').inputValue()).toBe('My next independent task');
      expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
      await page.locator('#send-btn').click();
      expect(await sends()).toHaveLength(2);
      expect((await sends())[1].payload).toMatchObject({ content: 'My next independent task', attachments: [{ fileName: 'draft.txt' }] });
      expect(await page.locator('.queued-chip').count()).toBe(1);
      await page.locator('.queued-chip-remove').click();
      await receive('responseStarted', { provider: 'claude-code' }); await finish('recovered');
      expect(await sends()).toHaveLength(2);
      expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    });
  }

  for (const control of ['button', 'Escape']) it.skipIf(CHROMIUM_UNAVAILABLE)(`${control} Stop dismisses only its approval and makes both visible controls and saved callbacks unable to approve it later`, async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await permission('foreground'); await permission('independent-job');
    await page.locator('#message-input').fill('retained draft');
    await page.evaluate(() => { (window as any).__staleApprove = document.querySelector('.permission-card[data-id="foreground"] [data-action="approve"]'); });
    if (control === 'button') await page.locator('#stop-btn').click();
    else await page.locator('#message-input').press('Escape');
    expect((await posted()).filter(event => event.type === 'cancelRequest')).toHaveLength(1);
    await receive('permissionDismissed', { requestIds: ['foreground'] }); await receive('requestCancelled');
    const stopped = page.locator('.permission-card[data-id="foreground"]');
    expect(await stopped.locator('.permission-option:visible:not(:disabled)').count()).toBe(0);
    expect(await stopped.textContent()).toContain('Cancelled');
    expect(await page.locator('.permission-card[data-id="independent-job"].pending').count()).toBe(1);
    await page.evaluate(() => { (window as any).__staleApprove.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect((await posted()).filter(event => event.type === 'permissionResponse')).toHaveLength(0);
    expect(await stopped.getAttribute('class')).not.toContain('approved');
    await receive('permissionDismissed', { requestIds: [] });
    expect(await page.locator('.permission-card[data-id="independent-job"].pending').count()).toBe(1);
    await page.locator('.permission-card[data-id="independent-job"] [data-action="deny"]').click();
    expect((await posted()).filter(event => event.type === 'permissionResponse').map(event => event.payload)).toEqual([
      { requestId: 'independent-job', decision: 'deny', scope: 'this-action' },
    ]);
    expect(await page.locator('#message-input').inputValue()).toBe('retained draft');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a permission decision settles once even if its saved button fires again before removal', async () => {
    await permission('approve-once');
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('.permission-card[data-id="approve-once"] [data-action="approve"]')!;
      button.click(); button.click();
    });
    expect((await posted()).filter(event => event.type === 'permissionResponse')).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Stop finalizes a persisted partial snapshot with stable Copy identity, ordered segments and failed tools without draining', async () => {
    const question = { id: 'partial-question', role: 'user', content: 'Inspect retry ownership' };
    const tool = { id: 'partial-read', name: 'read_file', kind: 'read', input: { path: 'retry.ts' }, status: 'running' };
    await receive('messageAdded', question); await receive('responseStarted', { provider: 'claude-code' });
    await receive('responseChunk', { type: 'text', content: 'Before the read.' }); await receive('toolUse', tool);
    await page.locator('#message-input').fill('Queued writer must stay held'); await page.locator('#message-input').press('Tab');
    await page.locator('#message-input').fill('Independent draft'); await stage('draft.txt');
    await page.locator('#stop-btn').click();
    const saved = { id: 'saved-stop-partial', role: 'assistant', provider: 'claude-code', content: 'Before the read.\n\nThe cap still needs verification.',
      toolCalls: [{ ...tool, status: 'failed', output: 'Stopped by user' }],
      segments: [{ type: 'text', content: 'Before the read.' }, { type: 'tool', toolCallId: tool.id },
        { type: 'text', content: 'The cap still needs verification.' }] };
    await receive('requestCancelled', { message: saved });
    const partial = page.locator('[data-id="saved-stop-partial"]');
    expect(await partial.count()).toBe(1);
    expect((await partial.locator('.message-content').allTextContents()).map(text => text.trim())).toEqual(['Before the read.', 'The cap still needs verification.']);
    expect(await partial.locator('.tool-call.failed').count()).toBe(1);
    expect(await page.locator('.message.streaming, .tool-call.running, .loading').count()).toBe(0);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Queued writer must stay held']);
    expect(await page.locator('#message-input').inputValue()).toBe('Independent draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    await partial.locator('.message-copy-btn').click();
    expect((await posted()).filter(event => event.type === 'copyMessageMarkdown').at(-1))
      .toEqual({ type: 'copyMessageMarkdown', panelId: 'stop-owner', payload: { messageId: saved.id, conversationId: 'original-chat', requestId: expect.any(String) } });
    expect(await sends()).toHaveLength(0);
    await receive('conversationChanged', { id: 'original-chat', messages: [question, saved] });
    expect((await partial.locator('.message-content').allTextContents()).map(text => text.trim())).toEqual(['Before the read.', 'The cap still needs verification.']);
    expect(await partial.locator('.tool-call.failed').count()).toBe(1);
    expect(await page.locator('.message.assistant').count()).toBe(1);
    expect(await sends()).toHaveLength(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('child status is truthful when children appear, disappear, and a new session starts', async () => {
    await lifecycle('session-started'); await lifecycle('session-idle');
    await lifecycle('children-detected', { childPids: [21, 22] });
    expect(await label()).toBe('Active (2 processes)');
    await lifecycle('shutdown-blocked', { childPids: [21, 22], detail: 'Active child processes detected' });
    await lifecycle('children-cleared');
    expect(await label()).toBe('Idle');
    await lifecycle('shutdown-blocked', { childPids: [23], detail: 'Active child process detected' });
    await lifecycle('session-shutdown'); await lifecycle('session-started');
    expect(await label()).toBe('Session');
    expect(await page.locator('#session-indicator').isVisible()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a busy shutdown refusal never invents zero child processes or declares an active turn idle', async () => {
    await lifecycle('session-started'); await receive('responseStarted', { provider: 'claude-code' });
    await page.locator('#stop-agent-btn').click();
    expect((await posted()).filter(event => event.type === 'shutdownAgent')).toEqual([{ type: 'shutdownAgent', panelId: 'stop-owner', payload: { force: false } }]);
    await lifecycle('shutdown-blocked', { detail: 'Agent is busy. Stop the current request first.', childPids: [] });
    expect(await label()).toBe('Active');
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
    expect(await page.locator('#messages').textContent()).toContain('Stop the current request first.');
    await lifecycle('children-cleared');
    expect(await label()).toBe('Active');
    expect((await posted()).filter(event => event.type === 'cancelRequest')).toHaveLength(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('visible idle session shutdown preserves transcript, draft, files and held queue; the next explicit request remains usable', async () => {
    await receive('messageAdded', { id: 'original-question', role: 'user', content: 'Original transcript question' });
    await receive('responseStarted', { provider: 'claude-code' });
    await page.locator('#message-input').fill('Held queued task'); await page.locator('#message-input').press('Tab');
    await receive('requestCancelled');
    await stage('draft.txt'); await page.locator('#message-input').fill('Independent draft');
    await lifecycle('session-started'); await lifecycle('session-idle');
    await page.locator('#stop-agent-btn').click();
    await lifecycle('session-shutdown'); await receive('sessionCleared', { message: 'Agent session shut down', reason: 'shutdown' });
    expect(await page.locator('#session-indicator').isVisible()).toBe(false);
    expect(await page.locator('.message.user').textContent()).toContain('Original transcript question');
    expect(await page.locator('#message-input').inputValue()).toBe('Independent draft');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual(['Held queued task']);
    expect(await sends()).toHaveLength(0);
    await page.locator('#send-btn').click();
    expect(await sends()).toHaveLength(1);
    await receive('sessionActive');
    expect(await label()).toBe('Session');
  });

  for (const route of ['typed', 'menu']) it.skipIf(CHROMIUM_UNAVAILABLE)(`public /clear ${route} producer and host navigation contract leave a fresh chat while old history and draft can be restored`, async () => {
    const oldMessages = [{ id: 'history-question', role: 'user', content: 'Preserve old history' }, { id: 'history-answer', role: 'assistant', provider: 'claude-code', content: 'Old answer' }];
    for (const message of oldMessages) await receive('messageAdded', message);
    if (route === 'typed') { await page.locator('#message-input').fill('/clear'); await page.locator('#send-btn').click(); }
    else {
      await page.locator('#slash-cmd-btn').click();
      await receive('slashCommandMenu', { commands: [{ id: 'cmd:clear', label: '/clear', description: 'Clear conversation and session', section: 'commands' }], sections: [{ id: 'commands', label: 'Commands', order: 1 }] });
      await page.locator('.slash-menu-item[data-command-id="cmd:clear"]').click();
    }
    const request = (await posted()).filter(event => event.type === 'executeSlashCommand').at(-1);
    expect(request.panelId).toBe('stop-owner'); expect(request.payload.requestId).toEqual(expect.any(String));
    expect(route === 'typed' ? request.payload.command : request.payload.commandId).toBe(route === 'typed' ? 'clear' : 'cmd:clear');
    // Controlled host boundary: host integration tests prove the actual new-chat routing.
    await page.locator('#message-input').fill('Old chat draft while clear completes'); await stage('old-draft.txt');
    await receive('conversationChanged', { id: 'fresh-chat', messages: [] }); await receive('sessionCleared', { message: 'Session cleared' });
    expect(await page.locator('.message').count()).toBe(0);
    expect(await page.locator('#message-input').inputValue()).toBe('');
    expect(await page.locator('.attachment-preview-item').count()).toBe(0);
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    await receive('slashCommandCompleted', { requestId: request.payload.requestId, kind: 'action', success: true });
    expect(await sends()).toHaveLength(0);
    await receive('conversationChanged', { id: 'original-chat', messages: oldMessages });
    expect(await page.locator('.message').count()).toBe(2);
    expect(await page.locator('#message-input').inputValue()).toBe('Old chat draft while clear completes');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['old-draft.txt']);
  });

  for (const provider of ['claude-code', 'openai-codex'] as const) for (const key of ['Enter', 'Tab']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`full ${provider} slash catalog defaults exact /clear to new conversation with ${key}`, async () => {
      await page.locator('#message-input').fill('/clear');
      const catalog = fullSlashCatalog(provider);
      expect(catalog.commands.some(command => command.id === 'context:clear')).toBe(true);
      expect(catalog.commands.some(command => command.id === 'cmd:clear')).toBe(true);
      await receive('slashCommandMenu', catalog);
      expect(await page.locator('.slash-menu-item').first().getAttribute('data-command-id')).toBe('context:clear');
      expect(await page.locator('.slash-menu-item.selected').getAttribute('data-command-id')).toBe('cmd:clear');
      await page.locator('#message-input').press(key);
      const commands = (await posted()).filter(event => event.type === 'executeSlashCommand');
      expect(commands).toHaveLength(1);
      expect(commands[0].payload.commandId).toBe('cmd:clear');
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('explicit arrow selection overrides the exact slash default and survives a catalog refresh', async () => {
    await page.locator('#message-input').fill('/clear'); await receive('slashCommandMenu', fullSlashCatalog());
    expect(await page.locator('.slash-menu-item.selected').getAttribute('data-command-id')).toBe('cmd:clear');
    await page.locator('#message-input').press('ArrowUp');
    expect(await page.locator('.slash-menu-item.selected').getAttribute('data-command-id')).toBe('context:clear');
    await receive('slashCommandMenu', fullSlashCatalog());
    expect(await page.locator('.slash-menu-item.selected').getAttribute('data-command-id')).toBe('context:clear');
    await page.locator('#message-input').press('Enter');
    expect((await posted()).filter(event => event.type === 'executeSlashCommand').map(event => event.payload.commandId)).toEqual(['context:clear']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an explicit Clear context click still chooses that action instead of the exact /clear default', async () => {
    await page.locator('#message-input').fill('/clear'); await receive('slashCommandMenu', fullSlashCatalog());
    await page.locator('.slash-menu-item[data-command-id="context:clear"]').click();
    expect((await posted()).filter(event => event.type === 'executeSlashCommand').map(event => event.payload.commandId)).toEqual(['context:clear']);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('editing a slash query cannot execute the previous query while the next catalog is pending', async () => {
    await page.locator('#message-input').fill('/help'); await receive('slashCommandMenu', fullSlashCatalog());
    await page.locator('#message-input').fill('/clear');
    await page.locator('#message-input').press('Enter');
    const commands = (await posted()).filter(event => event.type === 'executeSlashCommand');
    expect(commands).toHaveLength(1);
    expect(commands[0].payload.command).toBe('clear');
    expect(commands[0].payload.commandId).toBeUndefined();
    await receive('slashCommandMenu', fullSlashCatalog());
    expect(await page.locator('#slash-menu').isVisible()).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('50 Stop and recovery cycles keep every queued writer held until removed and dispatch only explicit recovery messages', async () => {
    const started = Date.now();
    loadProgress = { startedAt: started, completedCycles: 0, step: 'starting', cycleMs: [] };
    for (let index = 0; index < 50; index++) {
      const cycleStarted = Date.now();
      loadProgress.step = 'send start';
      await page.locator('#message-input').fill('Start ' + index); await page.locator('#send-btn').click();
      loadProgress.step = 'receive partial';
      await receive('responseStarted', { provider: 'claude-code' });
      await receive('responseChunk', { type: 'text', content: 'Partial ' + index });
      loadProgress.step = 'queue writer';
      await page.locator('#message-input').fill('Queued writer ' + index); await page.locator('#message-input').press('Tab');
      loadProgress.step = 'stop';
      await page.locator('#message-input').fill('Recovery ' + index); await page.locator('#stop-btn').click(); await receive('requestCancelled');
      expect(await page.locator('.queued-chip').count()).toBe(1);
      loadProgress.step = 'remove queue and recover';
      await page.locator('.queued-chip-remove').click(); await page.locator('#send-btn').click();
      loadProgress.step = 'complete recovery';
      await receive('responseStarted', { provider: 'claude-code' }); await finish('recovery-' + index);
      loadProgress.completedCycles++;
      loadProgress.cycleMs.push(Date.now() - cycleStarted);
    }
    loadProgress.step = 'assert final state';
    expect((await sends()).map(event => event.payload.content)).toEqual(Array.from({ length: 50 }, (_, index) => ['Start ' + index, 'Recovery ' + index]).flat());
    expect((await posted()).filter(event => event.type === 'cancelRequest')).toHaveLength(50);
    expect(await page.locator('.message.streaming, .queued-chip').count()).toBe(0);
    loadProgress.step = 'complete';
    if (process.env.MYSTI_PC07_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.MYSTI_PC07_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MYSTI_PC07_ARTIFACT_DIR, 'stop-browser-load.json'), JSON.stringify({ cycles: 50,
        explicitSends: 100, cancelledRequests: 50, queuedWritersDispatched: 0, elapsedMs: Date.now() - started,
        scope: 'Controlled Chromium host boundary; not real CLI cancellation, filesystem proof, or an elapsed 8-hour workday.' }, null, 2));
    }
  }, 30_000);
});
