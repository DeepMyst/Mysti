import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry);
const models = {
  'claude-code': [{ id: 'claude-old', name: 'Claude previous' }, { id: 'shared', name: 'Claude shared ID' }, { id: 'claude-new', name: 'Claude new' }],
  'openai-codex': [{ id: 'codex-old', name: 'Codex previous' }, { id: 'shared', name: 'Codex shared ID' }],
};

describe('PC-04 model and reasoning controls in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  const modelChoices = () => page.locator('#model-menu-options [data-model]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-model')));
  async function boot(provider = 'claude-code', hub = false): Promise<void> {
    // A new document is required when changing surfaces: document.write alone
    // retains the previous window and its chat-script globals/listeners.
    await page.goto('about:blank');
    await page.setContent(hub ? composeChatHtml().replace(/<body>\s*<div/, '<body class="view-hub"><div') : composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'settings-panel-owner',
      providers: registry.getAll().map(entry => ({ ...entry.config, models: models[entry.id as keyof typeof models] || entry.config.models })),
      providerManifest: manifest, providerAvailability: Object.fromEntries(manifest.providers.map(entry => [entry.id, { available: true }])),
      settings: { ...(INITIAL_STATE.settings as object), provider, model: models[provider as keyof typeof models]?.[0].id || registry.get(provider)?.config.defaultModel, effortLevel: 'high' },
    });
    if (hub) {
      await receive('hubShow', { section: 'settings', chatTitle: 'Retry review' });
      expect(await page.locator('body').getAttribute('class')).toContain('view-hub');
      expect(await page.locator('#settings-panel').getAttribute('class')).toContain('hub-active');
    }
    else await page.locator('#message-input').fill('Unsent retry review draft');
  }
  beforeAll(async () => { if (!CHROMIUM_UNAVAILABLE) browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 430, height: 950 } });
    page.on('pageerror', error => errors.push(error.message));
    await boot();
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('D06: names the acknowledged unlisted Copilot model beside Low effort without changing its override', async () => {
    await boot('github-copilot');
    await receive('modelsUpdated', { provider: 'github-copilot', models: [{ id: 'auto', name: 'Auto' }] });
    const before = (await posted()).length;
    await receive('modelChanged', { provider: 'github-copilot', model: 'gpt-6-luna', customModel: 'gpt-6-luna' });
    await receive('settingsSync', { effortLevel: 'low' });
    expect(await page.locator('#model-menu-label').textContent()).toBe('gpt-6-luna');
    expect(await page.locator('#actions-model-label').textContent()).toBe('gpt-6-luna');
    expect(await page.locator('#model-menu-effort').textContent()).toBe('Low');
    expect(await page.locator('#model-select').inputValue()).toBe('__custom__');
    expect(await page.locator('#custom-model-input').inputValue()).toBe('gpt-6-luna');
    expect((await posted()).slice(before).filter(message => message.type === 'updateSettings')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('D06: preserves listed friendly labels and clears a custom footer when the override is removed', async () => {
    await receive('modelChanged', { provider: 'claude-code', model: 'claude-old', customModel: 'claude-new' });
    expect(await page.locator('#model-menu-label').textContent()).toBe('Claude new');
    await receive('modelChanged', { provider: 'claude-code', model: 'claude-old', customModel: 'team/unlisted' });
    expect(await page.locator('#model-menu-label').textContent()).toBe('team/unlisted');
    await receive('modelChanged', { provider: 'claude-code', model: 'claude-old', customModel: '' });
    expect(await page.locator('#model-menu-label').textContent()).toBe('Claude previous');
    expect(await page.locator('#actions-model-label').textContent()).toBe('Claude previous');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('D06: renders a custom footer as text and retains it across late catalogues without posting settings', async () => {
    const customModel = 'team/<img src=x onerror="throw 1">';
    const before = (await posted()).length;
    await receive('modelChanged', { provider: 'claude-code', model: 'claude-old', customModel });
    await receive('modelsUpdated', { provider: 'claude-code', models: [] });
    await receive('modelsUpdated', { provider: 'openai-codex', models: [{ id: customModel, name: 'Other provider label' }] });
    expect(await page.locator('#model-menu-label').textContent()).toBe(customModel);
    expect(await page.locator('#actions-model-label').textContent()).toBe(customModel);
    expect(await page.locator('#model-menu-label img, #actions-model-label img').count()).toBe(0);
    expect(await page.locator('#model-select').inputValue()).toBe('__custom__');
    expect((await posted()).slice(before).filter(message => message.type === 'updateSettings')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps keyboard model selection focused when a catalogue arrives during a pending answer', async () => {
    await receive('responseStarted', { provider: 'claude-code', model: 'claude-old' });
    await page.locator('#model-menu-btn').click();
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('#model-menu [data-model="shared"]').evaluate(element => element === document.activeElement)).toBe(true);
    await receive('modelsUpdated', { provider: 'claude-code', models: [...models['claude-code'], { id: 'later', name: 'Discovered later' }] });
    expect(await page.locator('#model-menu [data-model="shared"]').evaluate(element => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    expect((await posted()).filter(message => message.type === 'updateSettings').at(-1)).toMatchObject({ payload: { model: 'shared', customModel: '' }, panelId: 'settings-panel-owner' });
    expect(await page.locator('#stop-btn').isVisible()).toBe(true);
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent retry review draft');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps same-ID models and late catalogues isolated by provider while preserving a custom override', async () => {
    await page.locator('#agent-select-btn').click();
    await page.locator('.agent-menu-item[data-agent="openai-codex"]').click();
    await receive('modelChanged', { provider: 'openai-codex', model: 'shared', customModel: '' });
    await receive('modelsUpdated', { provider: 'claude-code', models: [{ id: 'shared', name: 'Late Claude label' }] });
    expect(await page.locator('#model-menu-label').innerText()).toBe('Codex shared ID');
    await page.locator('#model-menu-btn').click();
    await page.locator('#model-menu [data-model="__custom__"]').click();
    expect((await posted()).at(-1)).toMatchObject({ type: 'requestCustomModel', panelId: 'settings-panel-owner' });
    await receive('modelChanged', { provider: 'openai-codex', model: 'team/custom-model', customModel: 'team/custom-model' });
    const count = (await posted()).length;
    await receive('modelsUpdated', { provider: 'openai-codex', models: [] });
    await receive('modelsUpdated', { provider: 'claude-code', models: [{ id: 'team/custom-model', name: 'Wrong provider name' }] });
    expect(await page.locator('#model-select').inputValue()).toBe('__custom__');
    expect(await page.locator('#custom-model-input').inputValue()).toBe('team/custom-model');
    expect((await posted()).slice(count).some(message => message.type === 'updateSettings')).toBe(false);
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent retry review draft');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('ignores malformed model rows and duplicate identities without losing the selected model', async () => {
    await receive('modelsUpdated', { provider: 'claude-code', models: [null, {}, { id: 3 },
      { id: 'shared', name: 'First supported label' }, { id: 'shared', name: 'Duplicate label' },
      { id: '__custom__', name: 'Reserved pseudo-model' }, { id: 'safe', name: '<img src=x onerror="throw 1">' }] });
    await page.locator('#model-menu-btn').click();
    expect(await modelChoices()).toEqual(['shared', 'safe', 'claude-old', '__custom__']);
    expect(await page.locator('#model-select-inline').inputValue()).toBe('claude-old');
    expect(await page.locator('#model-menu img').count()).toBe(0);
    expect(await page.locator('#model-menu [data-model="safe"]').innerText()).toContain('<img src=x');
    expect((await posted()).some(message => message.type === 'updateSettings')).toBe(false);
  });

  for (const provider of ['hermes', 'openclaw']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${provider}: settings hub cannot offer a model selector that its backend does not honor`, async () => {
      await boot(provider, true);
      expect(manifest.providers.find(entry => entry.id === provider)!.capabilities.modelSelection).toBe('none');
      expect(await page.locator('#model-select').isVisible()).toBe(false);
      expect(await page.locator('#custom-model-input').isVisible()).toBe(false);
      expect(await page.locator('#model-cli-managed-hint').innerText()).toContain('configured in');
      expect(await page.locator('#model-cli-managed-hint').isVisible()).toBe(true);
      expect((await posted()).some(message => message.type === 'updateSettings')).toBe(false);
    });
  }

  it.skipIf(CHROMIUM_UNAVAILABLE)('a custom-only provider offers an editable model ID in the settings hub and no stock-model dropdown', async () => {
    await boot('ollama', true);
    expect(await page.locator('#model-select').isVisible()).toBe(false);
    expect(await page.locator('#custom-model-input').isVisible()).toBe(true);
    await page.locator('#custom-model-input').fill('team/retry-model:latest');
    await page.locator('#custom-model-input').press('Tab');
    expect((await posted()).filter(message => message.type === 'updateSettings').at(-1))
      .toMatchObject({ payload: { customModel: 'team/retry-model:latest' }, panelId: 'settings-panel-owner' });
    await receive('settingsSync', { provider: 'claude-code', model: 'claude-old', customModel: '' });
    expect(await page.locator('#model-select').isVisible()).toBe(true);
    expect(await page.locator('#custom-model-input').isVisible()).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Cline keeps the custom model through discovered modern and legacy capability changes', async () => {
    const cline = registry.get('cline') as unknown as { _cachedCliVersion: string | null };
    const priorVersion = cline._cachedCliVersion;
    try {
      await boot('cline', true);
      expect(await page.locator('#model-select').isVisible()).toBe(false);
      expect(await page.locator('#custom-model-input').isVisible()).toBe(true);
      await page.locator('#custom-model-input').fill('account/review-model');
      await page.locator('#custom-model-input').press('Tab');
      expect((await posted()).filter(message => message.type === 'updateSettings').at(-1))
        .toMatchObject({ payload: { customModel: 'account/review-model' }, panelId: 'settings-panel-owner' });
      await receive('modelChanged', { provider: 'cline', model: 'account/review-model', customModel: 'account/review-model' });
      const count = (await posted()).filter(message => message.type === 'updateSettings').length;
      cline._cachedCliVersion = '1.0.8';
      await receive('manifestUpdated', buildProviderManifestPayload(registry));
      expect(await page.locator('#custom-model-input').isVisible()).toBe(false);
      expect(await page.locator('#model-cli-managed-hint').isVisible()).toBe(true);
      cline._cachedCliVersion = '3.0.61';
      await receive('manifestUpdated', buildProviderManifestPayload(registry));
      expect(await page.locator('#model-select').isVisible()).toBe(false);
      expect(await page.locator('#custom-model-input').isVisible()).toBe(true);
      expect(await page.locator('#custom-model-input').inputValue()).toBe('account/review-model');
      expect((await posted()).filter(message => message.type === 'updateSettings')).toHaveLength(count);
    } finally {
      cline._cachedCliVersion = priorVersion;
    }
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('settings thinking and effort controls reflect effective, advisory and absent capabilities', async () => {
    await boot('claude-code', true);
    expect(await page.locator('#thinking-select').isVisible()).toBe(true);
    expect(await page.locator('#thinking-advisory-hint').isVisible()).toBe(false);
    const thinkingOffset = (await posted()).length;
    await page.locator('#thinking-select').selectOption('high');
    // The initial render's uiReady can arrive after this control's update.
    expect((await posted()).slice(thinkingOffset).filter(message => message.type === 'updateSettings'))
      .toEqual([{ type: 'updateSettings', payload: { thinkingLevel: 'high' }, panelId: 'settings-panel-owner' }]);
    await receive('settingsSync', { provider: 'openai-codex', model: 'codex-old' });
    expect(await page.locator('#thinking-advisory-hint').isVisible()).toBe(true);
    expect(await page.locator('#thinking-advisory-hint').innerText()).toContain('does not enforce');
    const levels = manifest.providers.find(entry => entry.id === 'openai-codex')!.capabilities.effortLevels;
    expect(await page.locator('#effort-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(levels);
    await receive('settingsSync', { provider: 'cline', model: registry.get('cline')!.config.defaultModel });
    expect(await page.locator('#thinking-select').isVisible()).toBe(true);
    expect(await page.locator('#thinking-advisory-hint').isVisible()).toBe(true);
    expect(await page.locator('#effort-select').isVisible()).toBe(false);
    expect(await page.locator('#model-select').isVisible()).toBe(false);
    await receive('settingsSync', { provider: 'google-gemini', model: registry.get('google-gemini')!.config.defaultModel });
    expect(await page.locator('#thinking-select').isVisible()).toBe(false);
    expect(await page.locator('#effort-select').isVisible()).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves a draft through 100 effort changes, 20 catalogues and 30 pending-turn transitions', async () => {
    const before = (await posted()).filter(message => message.type === 'updateSettings').length;
    for (let change = 0; change < 100; change++) {
      if (change < 30) await receive('responseStarted', { provider: 'claude-code', model: 'claude-old' });
      const kind = change % 2 ? 'tools' : 'model';
      await page.locator(`#${kind}-menu-btn`).click();
      await page.locator(`#${kind}-menu input[type="range"]`).focus();
      await page.keyboard.press(change % 2 ? 'Home' : 'End');
      await page.keyboard.press('Escape');
      if (change % 5 === 0) await receive('modelsUpdated', { provider: 'claude-code', models: models['claude-code'] });
      if (change < 30) await receive('responseComplete', { message: { id: `bounded-${change}`, role: 'assistant', provider: 'claude-code', model: 'claude-old', content: `Controlled browser reply ${change}` } });
      expect(await page.locator('#message-input').inputValue()).toBe('Unsent retry review draft');
    }
    const updates = (await posted()).filter(message => message.type === 'updateSettings').slice(before);
    expect(updates).toHaveLength(100);
    expect(updates.every((message, index) => message.payload.effortLevel === (index % 2 ? 'low' : 'max'))).toBe(true);
    expect((await posted()).some(message => message.type === 'sendMessage')).toBe(false);
    expect(await page.locator('#effort-select-inline').inputValue()).toBe('low');
    expect(await page.locator('#messages .message.assistant').count()).toBe(30);
    // This is a 100-interaction state-preservation scenario. Allow the full
    // suite's parallel Chromium workers without imposing a 5s aggregate
    // performance gate on all clicks, catalogues and response transitions.
  }, 30_000);
});
