import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = () => buildProviderManifestPayload(registry);
const draftFile = { id: 'mode-draft', type: 'file', fileName: 'draft.txt', filePath: '/fixture/draft.txt', size: 7 };
const modes = [
  { label: 'Ask', mode: 'ask-before-edit', accessLevel: 'ask-permission' },
  { label: 'Auto', mode: 'edit-automatically', accessLevel: 'ask-permission' },
] as const;

// Exercise the shipped composer and real registry manifest in Chromium. The VS Code
// host is a controlled message boundary: these are UI tests, not native CLI runs.
describe('provider mode recovery preserves drafts and requires an explicit supported choice', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  const sends = async () => (await posted()).filter(message =>
    ['sendMessage', 'sendBrainstormMessage', 'executeSlashCommand'].includes(message.type));
  const settingsWrites = async () => (await posted()).filter(message => message.type === 'updateSettings');
  const authorityWrites = async () => (await settingsWrites()).filter(message =>
    Object.hasOwn(message.payload || {}, 'mode') || Object.hasOwn(message.payload || {}, 'accessLevel'));

  async function boot(provider: string, mode: { label: string; mode: string; accessLevel: string } = modes[0], incoming: unknown = manifest()) {
    await page.setContent(composeChatHtml());
    // VS Code supplies these theme variables; retain the shipped layout and visibility rules.
    await page.addStyleTag({ content: ':root { --vscode-font-family: Arial, sans-serif; --vscode-font-size: 13px; --vscode-sideBar-background: #181818; --vscode-editor-background: #1f1f1f; --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d; --vscode-panel-border: #3c3c3c; --vscode-focusBorder: #007fd4; --vscode-input-background: #313131; --vscode-input-foreground: #cccccc; --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #3c3c3c; }' });
    await receive('initialState', {
      ...INITIAL_STATE, panelId: 'provider-mode-panel', conversation: { id: 'mode-chat', messages: [] },
      providers: registry.getAll().map(entry => entry.config), providerManifest: incoming,
      providerAvailability: Object.fromEntries(registry.getAll().map(entry => [entry.id, { available: true }])),
      settings: { ...(INITIAL_STATE.settings as object), provider,
        model: registry.get(provider)?.config.defaultModel || 'unknown-model', mode: mode.mode, accessLevel: mode.accessLevel },
    });
  }
  async function stageDraft() {
    await page.locator('#message-input').fill('hi');
    await receive('fileAttachmentSelected', { attachments: [draftFile] });
  }
  async function draftIntact(content = 'hi') {
    expect(await page.locator('#message-input').inputValue()).toBe(content);
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    expect(await page.locator('#message-input').isEnabled()).toBe(true);
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    expect(await page.locator('.queued-chip').count()).toBe(0);
    expect(await sends()).toEqual([]);
  }
  async function blockedClickAndEnter(content = 'hi') {
    await page.locator('#send-btn').click(); await draftIntact(content);
    await page.locator('#message-input').press('Enter'); await draftIntact(content);
  }
  async function switchProvider(provider: string) {
    await page.locator('#agent-select-btn').click();
    await page.locator(`#agent-menu .agent-menu-item[data-agent="${provider}"]`).click();
  }
  async function captureNotice(label: string) {
    const directory = path.resolve('out-test/provider-mode-recovery-20261013');
    fs.mkdirSync(directory, { recursive: true });
    for (const width of [500, 390]) {
      await page.setViewportSize({ width, height: 950 });
      const bounds = await page.locator('#composer-mode-notice').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      let screenshot = path.join(directory, `${label}-${width}.png`), version = 1;
      while (fs.existsSync(screenshot)) screenshot = path.join(directory, `${label}-${width}-${++version}.png`);
      await page.screenshot({ path: screenshot });
    }
    await page.setViewportSize({ width: 500, height: 950 });
  }
  async function explicitSend(provider: string, mode: string, accessLevel: string) {
    await page.locator('#send-btn').click();
    const sent = await sends(); expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'sendMessage', panelId: 'provider-mode-panel', payload: {
      content: 'hi', attachments: [draftFile], settings: { provider, mode, accessLevel },
    } });
    expect(await page.locator('#message-input').inputValue()).toBe('');
    expect(await page.locator('.attachment-preview-item').count()).toBe(0);
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
  }

  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) return;
    clearMockConfig(); errors = []; page = await browser.newPage({ viewport: { width: 500, height: 950 } });
    page.setDefaultTimeout(2500); page.on('pageerror', error => errors.push(error.message));
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); clearMockConfig(); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  for (const provider of ['github-copilot', 'google-gemini']) {
    for (const mode of modes) {
      it.skipIf(CHROMIUM_UNAVAILABLE)(`${provider} ${mode.label}: startup warning, blocked Send/Enter, explicit Plan then one Send`, async () => {
        const entry = manifest().providers.find(value => value.id === provider)!;
        expect(entry.capabilities.supportsAskPermission).toBe(false);
        expect(entry.capabilities.supportsReadOnly).not.toBe(false);
        await boot(provider, mode);
        expect(await page.locator('#behavior-indicator').getAttribute('title')).toContain('Choose Read Only or Full Access, or switch agents.');
        expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
        expect(await page.locator('#composer-mode-text').textContent()).toContain('cannot use ' + mode.label + ' mode');
        expect(await page.locator('#behavior-indicator').textContent()).toContain(mode.label);
        expect(await page.locator('#composer-mode-plan').isVisible()).toBe(true);
        expect(await settingsWrites()).toEqual([]);
        await stageDraft();
        if (provider === 'github-copilot' && mode.label === 'Auto') await captureNotice('copilot-auto-before-choice');
        await blockedClickAndEnter();
        expect(await settingsWrites()).toEqual([]);
        await page.locator('#composer-mode-plan').click();
        expect(await authorityWrites()).toEqual([expect.objectContaining({ type: 'updateSettings', panelId: 'provider-mode-panel',
          payload: { mode: 'quick-plan', accessLevel: 'read-only' } })]);
        expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
        expect(await page.locator('#behavior-indicator').textContent()).toContain('Plan');
        await draftIntact();
        await explicitSend(provider, 'quick-plan', 'read-only');
      });
    }
  }

  for (const provider of ['openclaw', 'cline', 'opencode', 'qwen-code', 'kimi-code']) for (const mode of provider !== 'openclaw'
    ? [...modes, { label: 'Plan', mode: 'quick-plan', accessLevel: 'read-only' }]
    : modes) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${provider} ${mode.label}: only explicit Full is offered and choosing it never sends automatically`, async () => {
      const entry = manifest().providers.find(value => value.id === provider)!;
      expect(entry.capabilities.supportsReadOnly).toBe(false);
      await boot(provider, mode); await stageDraft();
      expect(await page.locator('#behavior-indicator').getAttribute('title')).toContain('Choose Full Access or switch agents.');
      expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
      expect(await page.locator('#composer-mode-plan').isVisible()).toBe(false);
      expect(await settingsWrites()).toEqual([]);
      if (mode.label === 'Ask' || mode.label === 'Plan') await captureNotice(provider + '-' + mode.label.toLowerCase() + '-before-choice');
      await blockedClickAndEnter();
      await page.locator('#composer-mode-choose').click();
      expect(await page.locator('#behavior-popup').isVisible()).toBe(true);
      expect(await page.locator('#mode-capability-hint').innerText()).toContain('Choose Full Access or switch agents.');
      expect(await page.locator('#behavior-popup .mode-option:enabled').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('data-mode')))).toEqual(['full']);
      expect(await settingsWrites()).toEqual([]); await draftIntact();
      await page.locator('#behavior-popup .mode-option[data-mode="full"]').click();
      expect(await authorityWrites()).toEqual([expect.objectContaining({ payload: { mode: 'edit-automatically', accessLevel: 'full-access' } })]);
      expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
      expect(await page.locator('#behavior-popup').isVisible()).toBe(false);
      await draftIntact(); await explicitSend(provider, 'edit-automatically', 'full-access');
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('provider switches and live OpenCode transport manifests update the warning without changing authority or sending', async () => {
    await boot('claude-code'); await stageDraft();
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
    await switchProvider('opencode');
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
    await blockedClickAndEnter(); expect(await authorityWrites()).toEqual([]);
    setMockConfig('opencodeEndpoint', 'http://127.0.0.1:4096');
    const connected = manifest();
    expect(connected.providers.find(entry => entry.id === 'opencode')!.capabilities.supportsAskPermission).toBe(true);
    await receive('manifestUpdated', connected);
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
    await draftIntact(); expect(await authorityWrites()).toEqual([]);
    setMockConfig('opencodeEndpoint', ''); await receive('manifestUpdated', manifest());
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
    await switchProvider('claude-code');
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
    await switchProvider('github-copilot');
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
    expect(await page.locator('#behavior-indicator').textContent()).toContain('Ask');
    expect(await authorityWrites()).toEqual([]); await draftIntact();
    expect((await settingsWrites()).filter(message => message.payload.provider).map(message => message.payload.provider))
      .toEqual(['opencode', 'claude-code', 'github-copilot']);
  });

  for (const mode of [modes[0], { label: 'Plan', mode: 'quick-plan', accessLevel: 'read-only' }]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`OpenCode local → remote → local preserves ${mode.label} draft without authority writes`, async () => {
      await boot('opencode', mode); await stageDraft(); await blockedClickAndEnter();
      expect(await page.locator('#composer-mode-plan').isVisible()).toBe(false);
      setMockConfig('opencodeEndpoint', 'http://127.0.0.1:4096');
      const connected = manifest();
      expect(connected.providers.find(entry => entry.id === 'opencode')!.capabilities).toMatchObject({
        supportsReadOnly: true, supportsAskPermission: true, supportsNativeApproval: true, planMode: 'detected',
      });
      await receive('manifestUpdated', connected);
      expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
      expect(await page.locator('#behavior-indicator').textContent()).toContain(mode.label);
      await draftIntact(); expect(await authorityWrites()).toEqual([]);
      setMockConfig('opencodeEndpoint', ''); await receive('manifestUpdated', manifest());
      expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
      expect(await page.locator('#composer-mode-plan').isVisible()).toBe(false);
      expect(await page.locator('#behavior-indicator').textContent()).toContain(mode.label);
      await blockedClickAndEnter(); expect(await authorityWrites()).toEqual([]);
    });
  }

  for (const unknown of ['unknown-provider', 'unknown-manifest']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${unknown} blocks normal sending and offers no authority elevation`, async () => {
      await boot(unknown === 'unknown-provider' ? 'future-backend' : 'claude-code', modes[0],
        unknown === 'unknown-manifest' ? { schemaVersion: 0, providers: manifest().providers } : manifest());
      expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
      expect(await page.locator('#composer-mode-text').textContent()).toContain('Refresh provider detection or switch agents');
      expect(await page.locator('#composer-mode-plan').isVisible()).toBe(false);
      await stageDraft(); await blockedClickAndEnter();
      await page.locator('#composer-mode-choose').click();
      expect(await page.locator('#behavior-popup .mode-option:enabled').count()).toBe(0);
      expect(await settingsWrites()).toEqual([]); await draftIntact();
    });
  }

  for (const mode of modes) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`supported Claude ${mode.label} keeps normal explicit sending unchanged`, async () => {
      await boot('claude-code', mode); await stageDraft();
      expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
      expect(await settingsWrites()).toEqual([]);
      await explicitSend('claude-code', mode.mode, mode.accessLevel);
      expect(await settingsWrites()).toEqual([]);
    });
  }

  for (const command of ['/native-review retry', '/unregistered-provider-command retry']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${command}: an incompatible provider cannot bypass the guard through typed slash text`, async () => {
      await boot('opencode'); await stageDraft(); await page.locator('#message-input').fill(command);
      await blockedClickAndEnter(command);
      expect(await page.locator('#behavior-popup').isVisible()).toBe(true);
      expect(await settingsWrites()).toEqual([]);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('a native menu command named mode is blocked by its native identity and retains its text and file', async () => {
    await boot('opencode'); await stageDraft(); await page.locator('#message-input').fill('/');
    await receive('slashCommandMenu', { commands: [{ id: 'native:opencode:mode', nativeName: 'mode',
      label: '/mode', description: 'Native provider command', section: 'native' }], sections: [{ id: 'native', label: 'Agent commands', order: 1 }] });
    await page.locator('.slash-menu-item[data-command-id="native:opencode:mode"]').click();
    await draftIntact('/mode'); expect(await settingsWrites()).toEqual([]);
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
    expect(await page.locator('#behavior-popup').isVisible()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('typed local mode recovery remains usable and its acknowledgement never submits the next draft', async () => {
    await boot('github-copilot'); await stageDraft(); await page.locator('#message-input').fill('/mode plan');
    await page.locator('#send-btn').click();
    const commands = await sends(); expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'executeSlashCommand', payload: { command: 'mode', args: 'plan',
      requestId: expect.any(String), attachments: [draftFile] } });
    expect(await settingsWrites()).toEqual([]);
    await receive('modeChanged', { mode: 'quick-plan', accessLevel: 'read-only' });
    await receive('slashCommandCompleted', { requestId: commands[0].payload.requestId, kind: 'action', success: true });
    expect(await page.locator('#composer-mode-notice').isVisible()).toBe(false);
    expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    expect(await sends()).toHaveLength(1);
    await page.locator('#message-input').fill('hi'); await page.locator('#send-btn').click();
    const messages = (await sends()).filter(message => message.type === 'sendMessage'); expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ payload: { content: 'hi', attachments: [draftFile],
      settings: { provider: 'github-copilot', mode: 'quick-plan', accessLevel: 'read-only' } } });
    expect(await settingsWrites()).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a blocked welcome action leaves its recovery popup open and needs another explicit action after Plan', async () => {
    await boot('github-copilot'); await stageDraft();
    const action = page.locator('#welcome-suggestions .welcome-card').filter({ hasText: 'Understand Project' });
    await action.click();
    expect(await page.locator('#behavior-popup').isVisible()).toBe(true);
    expect((await posted()).filter(message => message.type === 'quickActionWithConfig')).toEqual([]);
    expect(await settingsWrites()).toEqual([]); await draftIntact();
    await page.locator('#composer-mode-plan').click();
    expect((await posted()).filter(message => message.type === 'quickActionWithConfig')).toEqual([]);
    await draftIntact(); await action.click();
    const actions = (await posted()).filter(message => message.type === 'quickActionWithConfig'); expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ payload: { content: expect.any(String), settings: {
      provider: 'github-copilot', mode: 'quick-plan', accessLevel: 'read-only',
    } } });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an explicit second opinion bypasses the incompatible main provider while preserving its unsent draft and files', async () => {
    await boot('opencode');
    const originalFile = { ...draftFile, id: 'question-file', fileName: 'question.txt', filePath: '/fixture/question.txt' };
    await receive('messageAdded', { id: 'original-question', role: 'user', content: 'Review the retry cap.', attachments: [originalFile] });
    await receive('responseComplete', { message: { id: 'original-answer', role: 'assistant', provider: 'opencode', content: 'First opinion.' } });
    await stageDraft(); expect(await page.locator('#composer-mode-notice').isVisible()).toBe(true);
    await page.locator('[data-id="original-answer"] [data-second-opinion]').click();
    await page.locator('.second-opinion-item[data-agent="claude-code"]').click();
    const sent = await sends(); expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'sendMessage', payload: {
      content: 'Review the retry cap.', attachments: [originalFile], secondOpinion: { provider: 'claude-code', messageId: 'original-question' },
    } });
    expect(await page.locator('#message-input').inputValue()).toBe('hi');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']);
    expect(await settingsWrites()).toEqual([]);
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
  });
});
