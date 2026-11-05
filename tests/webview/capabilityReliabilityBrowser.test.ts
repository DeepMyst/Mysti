import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = () => buildProviderManifestPayload(registry);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Real shipped scripts in Chromium with actual registry capability records.
// Host messages are controlled boundaries; this is not native backend proof
// or an eight-hour session, even when the 160-interaction target is exercised.
describe('PC-12 capability truthfulness and manifest recovery', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  async function boot(provider = 'claude-code', model?: string, incoming: any = manifest(), hub = false): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(hub ? composeChatHtml().replace(/<body>\s*<div/, '<body class="view-hub"><div') : composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'capability-owner',
      conversation: { id: 'capability-chat', messages: [{ id: 'question', role: 'user', content: 'Explain retries without executing anything.' }] },
      providers: registry.getAll().map(entry => entry.config), providerManifest: incoming,
      providerAvailability: Object.fromEntries(registry.getAll().map(entry => [entry.id, { available: true }])),
      settings: { ...(INITIAL_STATE.settings as object), provider, model: model || registry.get(provider)?.config.defaultModel || 'unknown-model', effortLevel: 'high' },
    });
    if (hub) { await receive('hubShow', { section: 'settings', chatTitle: 'Capability test' }); }
    else { await page.locator('#message-input').fill('Unsent capability draft'); }
  }
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    clearMockConfig(); errors = []; page = await browser.newPage({ viewport: { width: 500, height: 950 } });
    page.setDefaultTimeout(2000); page.on('pageerror', error => errors.push(error.message)); await boot();
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); clearMockConfig(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Copilot Auto hides effort in both composer menus while an explicit model restores it', async () => {
    await boot('github-copilot', 'auto');
    await page.locator('#model-menu-btn').click();
    expect(await page.locator('#model-menu [data-effort-control]').isVisible()).toBe(false);
    await page.keyboard.press('Escape'); await page.locator('#tools-menu-btn').click();
    expect(await page.locator('#tools-menu [data-effort-control]').isVisible()).toBe(false);
    await receive('modelChanged', { provider: 'github-copilot', model: 'gpt-5.4', customModel: '' });
    expect(await page.locator('#tools-menu [data-effort-control]').isVisible()).toBe(true);
    await receive('modelChanged', { provider: 'github-copilot', model: 'auto', customModel: 'auto' });
    expect(await page.locator('#tools-menu [data-effort-control]').isVisible()).toBe(false);
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent capability draft');
    expect((await posted()).filter(message => message.type === 'updateSettings')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Copilot settings effort tracks effective custom model and a late manifest refresh without rewriting preferences', async () => {
    await boot('github-copilot', 'auto', manifest(), true);
    expect(await page.locator('#effort-select').isVisible()).toBe(false);
    await receive('settingsSync', { provider: 'github-copilot', model: 'gpt-5.4', customModel: 'gpt-5.4' });
    expect(await page.locator('#effort-select').isVisible()).toBe(true);
    await receive('settingsSync', { provider: 'github-copilot', model: 'gpt-5.4', customModel: 'auto' });
    await receive('manifestUpdated', manifest());
    expect(await page.locator('#effort-select').isVisible()).toBe(false);
    expect((await posted()).filter(message => message.type === 'updateSettings')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a custom Copilot acknowledgement outranks its fallback picker model and enables explicit-model effort', async () => {
    await boot('github-copilot', 'auto');
    await page.locator('#model-menu-btn').click();
    await page.locator('#model-menu-options [data-model="__custom__"]').click();
    expect((await posted()).at(-1)).toMatchObject({ type: 'requestCustomModel', panelId: 'capability-owner' });
    // The host retains the explicit override even when catalog ownership makes
    // the generic picker resolve this ID to the provider's default Auto.
    await receive('modelChanged', { provider: 'github-copilot', model: 'auto', customModel: 'gpt-5.4' });
    expect(await page.locator('#model-select-inline').inputValue()).toBe('__custom__');
    expect(await page.locator('#custom-model-input').inputValue()).toBe('gpt-5.4');
    await page.locator('#model-menu-btn').click();
    expect(await page.locator('#model-menu [data-effort-control]').isVisible()).toBe(true);
    expect(await page.locator('#effort-select-inline option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toContain('low');
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent capability draft');
    expect((await posted()).filter(message => message.type === 'updateSettings' || message.type === 'sendMessage')).toEqual([]);
  });

  for (const [label, payload] of [
    ['non-array providers', { schemaVersion: 1, providers: {} }],
    ['null row', { schemaVersion: 1, providers: [null] }],
    ['wrong schema', { schemaVersion: 999, providers: [] }],
  ] as const) it.skipIf(CHROMIUM_UNAVAILABLE)(`an invalid ${label} refresh cannot crash or replace the last usable manifest`, async () => {
    const before = await page.locator('#provider-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    await receive('manifestUpdated', payload);
    expect(errors).toEqual([]);
    expect(await page.locator('#provider-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(before);
    await page.locator('#message-input').fill('Still editable after invalid refresh');
    expect(await page.locator('#model-menu-btn').isVisible()).toBe(true);
    expect((await posted()).some(message => message.type === 'sendMessage')).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an unknown selected backend offers no unsupported model, thinking or attachment controls', async () => {
    await boot('future-backend', 'future-model', manifest(), true);
    expect(await page.locator('#thinking-select').isVisible()).toBe(false);
    expect(await page.locator('#effort-select').isVisible()).toBe(false);
    expect(await page.locator('#model-select').isVisible()).toBe(false);
    expect(await page.locator('#custom-model-input').isVisible()).toBe(false);
    expect(await page.locator('#attach-btn').isDisabled()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('an old initial manifest disables unsupported controls until a current manifest arrives', async () => {
    await boot('claude-code', 'sonnet', { schemaVersion: 0, providers: manifest().providers }, true);
    expect(await page.locator('#thinking-select').isVisible()).toBe(false);
    expect(await page.locator('#model-select').isVisible()).toBe(false);
    expect(await page.locator('#attach-btn').isDisabled()).toBe(true);
    await receive('manifestUpdated', manifest());
    expect(await page.locator('#thinking-select').isVisible()).toBe(true);
    expect(await page.locator('#model-select').isVisible()).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('partial and malformed capability fields cannot fabricate controls or inject menu HTML', async () => {
    const payload: any = clone(manifest());
    const entry = payload.providers.find((value: any) => value.id === 'claude-code');
    entry.capabilities = { effortLevels: ['high', '<img src=x onerror="window.capabilityInjected=true">', 'high'],
      thinkingStyle: {}, supportsImages: 'false', supportsFileAttachments: 'true', modelSelection: 42 };
    entry.settingsSections = [{ id: 'test-section', type: 'select', options: {} }, null];
    await boot('claude-code', 'sonnet', payload, true);
    expect(errors).toEqual([]);
    expect(await page.locator('#thinking-select').isVisible()).toBe(false);
    expect(await page.locator('#model-select').isVisible()).toBe(false);
    expect(await page.locator('#attach-btn').isDisabled()).toBe(true);
    expect(await page.locator('#effort-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['high']);
    expect(await page.locator('#effort-section img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).capabilityInjected)).toBeUndefined();
    await receive('manifestUpdated', manifest());
    expect(await page.locator('#model-select').isVisible()).toBe(true);
  });

  for (const provider of ['ollama', 'localai']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${provider} proposals never become executed edits or receive Revert even if a result claims completed`, async () => {
      await boot(provider);
      const tool = { id: 'proposed-edit', name: 'Edit', input: { file_path: '/fixture/retry.ts', old_string: 'old', new_string: 'new' }, status: 'running', proposalOnly: true };
      await receive('responseStarted', { provider }); await receive('toolUse', tool);
      await receive('toolResult', { ...tool, status: 'completed', output: 'Proposed changes only' });
      await receive('responseComplete', { message: { id: 'proposal-answer', role: 'assistant', provider, content: 'Proposed edit.', toolCalls: [{ ...tool, status: 'proposed' }] } });
      const card = page.locator('.tool-call[data-id="proposed-edit"]');
      expect(await card.locator('.tool-call-status').textContent()).toBe('proposed');
      expect(await card.locator('.tool-call-note').allTextContents()).toContain('Not executed');
      expect(await card.evaluate(node => node.classList.contains('completed') || node.classList.contains('running'))).toBe(false);
      expect(await page.locator('.edit-report-btn-revert:not(:disabled), .file-edit-revert:not(:disabled)').count()).toBe(0);
      expect((await posted()).some(message => message.type === 'permissionResponse')).toBe(false);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('legacy proposal-backend history is honest while genuinely completed native tool receipts stay completed', async () => {
    const tool = { id: 'historic-proposal', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'completed' };
    await receive('conversationChanged', { id: 'history', messages: [
      { id: 'old-proposal', role: 'assistant', provider: 'ollama', content: 'Historical proposal.', toolCalls: [tool] },
      { id: 'native-receipt', role: 'assistant', provider: 'claude-code', content: 'Actual completed read.', toolCalls: [{ ...tool, id: 'native-read', output: 'Read result' }] },
    ] });
    expect(await page.locator('[data-id="historic-proposal"] .tool-call-status').textContent()).toBe('proposed');
    expect(await page.locator('[data-id="native-read"] .tool-call-status').textContent()).toBe('completed');
    expect(await page.locator('[data-id="native-read"] .tool-call-output-content').textContent()).toBe('Read result');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a finished turn with an unresolved tool displays unavailable result instead of success or a spinner', async () => {
    await boot('github-copilot', 'auto');
    const tool = { id: 'unconfirmed-tool', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'running' };
    await receive('responseStarted', { provider: 'github-copilot' }); await receive('toolUse', tool);
    await receive('responseComplete', { message: { id: 'answer', role: 'assistant', provider: 'github-copilot', content: 'No result was returned.', toolCalls: [{ ...tool, status: 'unconfirmed' }] } });
    const card = page.locator('.tool-call[data-id="unconfirmed-tool"]');
    expect(await card.locator('.tool-call-status').textContent()).toBe('result unavailable');
    expect(await card.evaluate(node => node.classList.contains('completed') || node.classList.contains('running'))).toBe(false);
  });

  for (const provider of ['claude-code', 'openai-codex']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${provider} reconciles a missing streamed tool result from the persisted terminal snapshot`, async () => {
      await boot(provider);
      expect(manifest().providers.find(entry => entry.id === provider)!.capabilities.emitsToolResults).toBe(true);
      const tool = { id: 'native-missing-result', name: 'Read', input: { file_path: '/fixture/retry.ts' }, status: 'running' };
      await receive('responseStarted', { provider });
      await receive('toolUse', tool);
      const card = page.locator('.tool-call[data-id="native-missing-result"]');
      await card.locator('.tool-call-header').click();
      const expandedClass = await card.getAttribute('class');
      expect(expandedClass).toContain('expanded');
      await receive('responseComplete', { message: { id: 'native-final', role: 'assistant', provider,
        content: 'The backend did not report a result.', toolCalls: [{ ...tool, status: 'unconfirmed' }],
        segments: [{ type: 'tool', toolCallId: tool.id }, { type: 'text', content: 'The backend did not report a result.' }] } });
      expect(await card.locator('.tool-call-status').textContent()).toBe('result unavailable');
      expect(await card.evaluate(node => node.classList.contains('running') || node.classList.contains('completed'))).toBe(false);
      expect(await card.getAttribute('class')).toContain('expanded');
      expect(await page.locator('.message.assistant[data-id="native-final"] .tool-call').count()).toBe(1);
      expect(await card.locator('.tool-call-content').textContent()).toContain('/fixture/retry.ts');
      expect(await page.locator('#stop-btn').isVisible()).toBe(false);
    });
  }

  for (const route of ['collaborator', 'delegate', 'legacy']) {
    for (const proposal of [true, false]) {
      it.skipIf(CHROMIUM_UNAVAILABLE)(`${route} traces preserve ${proposal ? 'unexecuted proposals' : 'unconfirmed native notifications'} through parent completion`, async () => {
        const agentId = proposal ? 'ollama' : 'openai-codex';
        const tool = { id: 'child-tool', name: 'Edit', input: { file_path: '/fixture/source.ts', old_string: 'old', new_string: 'new' },
          status: proposal ? 'proposed' : 'running', ...(proposal ? { proposalOnly: true } : {}) };
        await receive('responseStarted', { provider: 'claude-code' });
        if (route === 'collaborator') {
          await receive('collaborationStarted', { runId: 'trace-run' });
          await receive('collaborator', { runId: 'trace-run', collaboratorId: 'child', agentId, type: 'collab_tool_use', toolCall: tool });
        } else if (route === 'delegate') {
          await receive('toolUse', { id: 'parent', name: 'delegate', input: { agent: agentId }, status: 'running' });
          await receive('mystiDelegateTrace', { parentId: 'parent', chunk: { type: 'tool_use', toolCall: tool } });
        } else {
          await receive('subAgentStarted', { agentId });
          // Old saved/forwarded local events have no flag: capability fallback
          // must still prevent their proposals being labelled as executed.
          await receive('subAgentToolUse', { agentId, toolCall: { ...tool, status: 'running', proposalOnly: undefined } });
        }
        const card = page.locator('.subagent-tool-call[data-id="child-tool"]');
        if (proposal) {
          expect(await card.evaluate(node => node.classList.contains('proposed'))).toBe(true);
          expect(await card.textContent()).toContain('Not executed');
          const result = { id: tool.id, status: 'completed', output: 'A proposed edit, not execution.' };
          if (route === 'collaborator') { await receive('collaborator', { runId: 'trace-run', collaboratorId: 'child', agentId, type: 'collab_tool_result', toolCall: result }); }
          else if (route === 'delegate') { await receive('mystiDelegateTrace', { parentId: 'parent', chunk: { type: 'tool_result', toolCall: result } }); }
          else { await receive('subAgentToolResult', { agentId, toolCall: result }); }
        }
        if (route === 'collaborator') {
          await receive('collaborator', { runId: 'trace-run', collaboratorId: 'child', agentId, type: 'collab_complete', responseText: 'Child finished.' });
          await receive('collaborationComplete', { runId: 'trace-run' });
        } else if (route === 'legacy') { await receive('subAgentComplete', { agentId }); }
        await receive('responseComplete', { message: { id: 'trace-answer', role: 'assistant', provider: 'claude-code', content: 'Parent finished.' } });
        expect(await card.evaluate(node => node.classList.contains('completed') || node.classList.contains('running'))).toBe(false);
        expect(await card.textContent()).toContain(proposal ? 'Not executed' : 'result unavailable');
        expect(await card.locator('.subagent-tool-spinner, .subagent-tool-icon.completed').count()).toBe(0);
        expect(await card.locator('.subagent-tool-detail-code').first().textContent()).toContain('old_string');
      });
    }
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('Copilot cannot offer Ask or partial Auto but switching providers never grants Full Access', async () => {
    await boot('github-copilot', 'auto');
    await page.locator('#behavior-indicator').click();
    expect(await page.locator('.mode-option[data-mode="ask"]').isDisabled()).toBe(true);
    expect(await page.locator('.mode-option[data-mode="auto"]').isDisabled()).toBe(true);
    expect(await page.locator('.mode-option[data-mode="plan"]').isEnabled()).toBe(true);
    expect(await page.locator('.mode-option[data-mode="full"]').isEnabled()).toBe(true);
    expect(await page.locator('#mode-capability-hint').textContent()).toContain('cannot pause tools for approval');
    expect(await page.locator('#behavior-indicator').textContent()).toContain('Ask');
    expect((await posted()).filter(message => message.type === 'updateSettings')).toEqual([]);
    await page.locator('.mode-option[data-mode="ask"]').evaluate(button => (button as HTMLButtonElement).click());
    expect((await posted()).filter(message => message.type === 'updateSettings')).toEqual([]);
    await page.locator('.mode-option[data-mode="plan"]').click();
    expect((await posted()).filter(message => message.type === 'updateSettings').at(-1)).toMatchObject({ payload: { mode: 'quick-plan', accessLevel: 'read-only' } });
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent capability draft');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('OpenClaw does not offer a read-only mode its gateway cannot enforce', async () => {
    await boot('openclaw'); await page.locator('#behavior-indicator').click();
    for (const id of ['plan', 'ask', 'auto']) { expect(await page.locator(`.mode-option[data-mode="${id}"]`).isDisabled()).toBe(true); }
    expect(await page.locator('.mode-option[data-mode="full"]').isEnabled()).toBe(true);
    expect((await posted()).filter(message => message.type === 'updateSettings')).toEqual([]);
  });

  for (const [label, capabilities] of [
    ['empty capabilities', {}],
    ['malformed authority flags', { ...manifest().providers[0].capabilities, supportsAskPermission: 'false', supportsReadOnly: 'true' }],
  ] as const) it.skipIf(CHROMIUM_UNAVAILABLE)(`${label} cannot offer approval or Read Only without an actual capability`, async () => {
    const payload: any = clone(manifest());
    payload.providers.find((entry: any) => entry.id === 'claude-code').capabilities = capabilities;
    await boot('claude-code', 'sonnet', payload);
    await page.locator('#behavior-indicator').click();
    for (const id of ['plan', 'ask', 'auto']) {
      expect(await page.locator(`.mode-option[data-mode="${id}"]`).isDisabled()).toBe(true);
    }
    if (label === 'empty capabilities') {
      expect(await page.locator('.mode-option[data-mode="full"]').isDisabled()).toBe(true);
    }
    expect(await page.locator('#behavior-hint').textContent()).not.toContain('asks before every write');
    expect((await posted()).filter(message => message.type === 'updateSettings')).toEqual([]);
    await receive('manifestUpdated', manifest());
    for (const id of ['plan', 'ask', 'auto', 'full']) {
      expect(await page.locator(`.mode-option[data-mode="${id}"]`).isEnabled()).toBe(true);
    }
  });

  for (const provider of registry.getAll().map(entry => entry.id)) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${provider}: real registry drives model, effort, thinking and attachment controls`, async () => {
      const entry = manifest().providers.find(value => value.id === provider)!;
      await boot(provider, entry.defaultModel, manifest(), true);
      const caps = entry.capabilities;
      expect(await page.locator('#thinking-select').isVisible()).toBe(caps.thinkingStyle !== 'none');
      expect(await page.locator('#thinking-advisory-hint').isVisible()).toBe(caps.thinkingStyle !== 'none' && !caps.thinkingLevelEffective);
      expect(await page.locator('#model-select').isVisible()).toBe(caps.modelSelection === 'full');
      expect(await page.locator('#custom-model-input').isVisible()).toBe(caps.modelSelection === 'custom-only');
      expect(await page.locator('#attach-btn').isEnabled()).toBe(!!(caps.supportsImages || caps.supportsFileAttachments));
      const levels = (caps as any).effortLevelsByModel?.[entry.defaultModel] ?? caps.effortLevels ?? [];
      expect(await page.locator('#effort-select').isVisible()).toBe(levels.length > 0);
      expect(await page.locator('#provider-select option[value="manus"]').count()).toBe(0);
      // API/proposal backends have no native executor to pause. All current
      // adapters except OpenClaw provide a safe Read Only path.
      expect(await page.locator('.mode-option[data-mode="plan"]').isEnabled()).toBe(caps.supportsReadOnly !== false);
      expect(await page.locator('.mode-option[data-mode="ask"]').isEnabled()).toBe(caps.supportsAskPermission !== false);
      expect(await page.locator('.mode-option[data-mode="auto"]').isEnabled()).toBe(caps.supportsAskPermission !== false);
      expect(await page.locator('.mode-option[data-mode="full"]').isEnabled()).toBe(true);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('160 public provider switches retain draft and files while OpenCode transport refreshes change actual controls', async () => {
    const ids = registry.getAll().map(entry => entry.id); expect(ids).toHaveLength(16);
    await receive('fileAttachmentSelected', { attachments: [{ id: 'owned', fileName: 'owned.txt', type: 'file', filePath: '/fixture/owned.txt' }] });
    for (let index = 0; index < 160; index++) {
      const id = ids[index % ids.length];
      setMockConfig('opencodeEndpoint', Math.floor(index / ids.length) % 2 ? 'http://127.0.0.1:4096' : '');
      const payload = manifest(); await receive('manifestUpdated', payload);
      await page.locator('#agent-select-btn').click();
      await page.locator(`#agent-menu .agent-menu-item[data-agent="${id}"]`).click();
      const entry = payload.providers.find(value => value.id === id)!;
      await receive('modelChanged', { provider: id, model: entry.defaultModel, customModel: '' });
      expect(await page.locator('#attach-btn').isEnabled()).toBe(!!(entry.capabilities.supportsImages || entry.capabilities.supportsFileAttachments));
      expect(await page.locator('#message-input').inputValue()).toBe('Unsent capability draft');
      expect(await page.locator('.attachment-name').allTextContents()).toEqual(['owned.txt']);
      if (id === 'opencode') {
        expect(await page.locator('.mode-option[data-mode="ask"]').isEnabled()).toBe(entry.capabilities.supportsAskPermission === true);
        expect(await page.locator('.mode-option[data-mode="auto"]').isEnabled()).toBe(entry.capabilities.supportsAskPermission === true);
        await page.locator('#model-menu-btn').click();
        const values = await page.locator('#model-menu-options [data-model]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.model));
        if (entry.capabilities.modelSelection === 'custom-only') { expect(values).toEqual(['__custom__']); }
        else { expect(values.length).toBeGreaterThan(1); }
        await page.keyboard.press('Escape');
      }
    }
    expect((await posted()).filter(message => message.type === 'updateSettings' && message.payload.provider)).toHaveLength(160);
    expect((await posted()).some(message => message.type === 'sendMessage')).toBe(false);
  }, 45_000);
});
