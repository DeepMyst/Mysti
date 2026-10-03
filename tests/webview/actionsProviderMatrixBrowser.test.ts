import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry);
const providers = registry.getAll().map(p => ({ name: p.id, models: p.config.models }));
describe('actions menu across the real provider catalog', () => {
  let browser: Browser, page: Page, dir: string, errors: string[];
  const fire = (type: string, payload: unknown) => page.evaluate(m => window.dispatchEvent(new MessageEvent('message', { data: m })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as any[]);
  const menu = () => page.click('#tools-menu-btn');
  async function boot(id: string) {
    await fire('initialState', { ...INITIAL_STATE, panelId: 'menu-panel', providers, providerManifest: manifest,
      providerAvailability: Object.fromEntries(providers.map(p => [p.name, { available: true }])),
      settings: { ...(INITIAL_STATE.settings as object), provider: id, model: registry.get(id)?.config.defaultModel || '' } });
    await fire('agentsUpdated', { availablePersonas: [{ id: 'test-persona', name: 'Reviewer', description: 'Review carefully' }], availableSkills: [] });
  }
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    browser = await chromium.launch(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-actions-'));
    fs.writeFileSync(path.join(dir, 'chat.html'), composeChatHtml());
  });
  beforeEach(async () => {
    errors = []; page = await browser.newPage({ viewport: { width: 400, height: 850 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`file://${path.join(dir, 'chat.html')}`);
  });
  afterEach(async () => { await page?.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  for (const entry of manifest.providers) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${entry.id}: every menu action routes and capability controls match`, async () => {
      await boot(entry.id); await menu();
      const attachment = page.locator('[data-composer-action="attach-btn"]');
      const supportsAttachments = !!(entry.capabilities.supportsImages || entry.capabilities.supportsFileAttachments);
      expect(await attachment.isEnabled()).toBe(supportsAttachments);
      if (supportsAttachments) {
        await attachment.click();
        expect(await posted()).toContainEqual(expect.objectContaining({ type: 'requestFileAttachment', panelId: 'menu-panel' }));
        await menu();
      } else { expect(await attachment.getAttribute('title')).toContain('Context'); }
      await page.click('[data-composer-action="export-conversation-btn"]');
      expect((await posted()).at(-1)).toMatchObject({ type: 'exportConversation', panelId: 'menu-panel' });
      await fire('exportResult', { success: false, error: 'There is no conversation to export yet.' });
      expect(await page.locator('#export-toast').textContent()).toContain('no conversation');
      for (const [button, type] of [['visual-test-btn', 'openVisualTestDashboard'], ['canvas-btn', 'openCanvas']]) {
        await menu(); await page.click('#' + button);
        expect((await posted()).at(-1)).toMatchObject({ type, panelId: 'menu-panel' });
        expect(await page.locator('#tools-menu').isVisible()).toBe(false);
      }
      await menu(); await page.click('#toolbar-persona-btn');
      await page.focus('.recommendation-chip[data-agent-id="test-persona"]'); await page.keyboard.press('Enter');
      expect((await posted()).at(-1)).toMatchObject({ type: 'updateAgentConfig', payload: { personaId: 'test-persona' } });
      await menu(); expect(await page.locator('#toolbar-persona-name').textContent()).toBe('Reviewer');
      await page.click('#toolbar-persona-clear');
      expect((await posted()).at(-1)).toMatchObject({ type: 'updateAgentConfig', payload: { personaId: null } });
      const levels = entry.capabilities.effortLevels || [];
      expect(await page.locator('#tools-menu [data-effort-control]').isVisible()).toBe(levels.length > 0);
      if (levels.length > 1) {
        await page.locator('#tools-menu input[type="range"]').focus(); await page.keyboard.press('Home'); await page.keyboard.press('End');
        expect((await posted()).at(-1)).toMatchObject({ type: 'updateSettings', payload: { effortLevel: levels.at(-1) } });
      }
      expect(await page.locator('#tools-menu [data-ultracode-control]').isVisible()).toBe(!!entry.capabilities.supportsUltracode);
      if (entry.capabilities.supportsUltracode) {
        await page.click('#tools-menu [data-ultracode-toggle]');
        expect((await posted()).at(-1)).toMatchObject({ type: 'updateSettings', payload: { ultracode: true } });
      }
      if (entry.capabilities.modelSelection === 'none') {
        expect(await page.locator('#actions-model-btn').isDisabled()).toBe(true);
        expect(await page.locator('#actions-model-btn').textContent()).toContain('configured in CLI');
        await page.keyboard.press('Escape');
      } else {
      await page.click('#actions-model-btn');
      expect(await page.locator('#model-menu').isVisible()).toBe(true);
      const target = entry.models.find(m => m.id !== entry.defaultModel) || entry.models[0];
      if (target && entry.capabilities.modelSelection === 'full') {
        await page.locator('#model-menu [data-model]').filter({ has: page.locator('.composer-model-name', { hasText: target.name }) }).first().click();
        expect((await posted()).at(-1)).toMatchObject({ type: 'updateSettings', payload: { model: target.id, customModel: '' } });
        await page.click('#model-menu-btn');
      }
      await page.click('#model-menu [data-model="__custom__"]');
      expect((await posted()).at(-1)).toMatchObject({ type: 'requestCustomModel', panelId: 'menu-panel' });
      }
      await page.fill('#message-input', 'Improve the error handling'); await menu(); await page.click('#enhance-btn');
      const req = (await posted()).findLast(m => m.type === 'enhancePrompt');
      expect(req).toMatchObject({ panelId: 'menu-panel', payload: { prompt: 'Improve the error handling' } });
      await fire('promptEnhanced', { requestId: req.payload.requestId, prompt: 'Handle errors and preserve retries.', changed: true });
      expect(await page.inputValue('#message-input')).toBe('Handle errors and preserve retries.');
      if (supportsAttachments) {
        const attachment = { id: 'attachment-test', type: 'file', fileName: 'notes.txt', mimeType: 'text/plain', base64Data: 'aGVsbG8=', size: 5 };
        await fire('fileAttachmentSelected', { attachments: [attachment] });
        expect(await page.locator('.attachment-preview-item').count()).toBe(1);
        await page.click('.attachment-remove');
        expect(await page.locator('.attachment-preview-item').count()).toBe(0);
        await fire('fileAttachmentSelected', { attachments: [attachment] });
        await page.click('#send-btn');
        expect((await posted()).findLast(m => m.type === 'sendMessage')).toMatchObject({ payload: { attachments: [attachment] } });
      }

    }, 20000);
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves edited drafts and ignores results from a timed-out request after retry', async () => {
    await boot('claude-code'); await page.clock.install();
    await page.fill('#message-input', 'Original'); await menu(); await page.click('#enhance-btn');
    const first = (await posted()).findLast(m => m.type === 'enhancePrompt').payload;
    await page.fill('#message-input', 'My newer text');
    await fire('promptEnhanced', { requestId: first.requestId, prompt: 'Old rewrite', changed: true });
    expect(await page.inputValue('#message-input')).toBe('My newer text');
    await menu(); await page.click('#enhance-btn');
    const expired = (await posted()).findLast(m => m.type === 'enhancePrompt').payload;
    await page.clock.fastForward(31000); await menu(); await page.click('#enhance-btn');
    const latest = (await posted()).findLast(m => m.type === 'enhancePrompt').payload;
    await fire('promptEnhanced', { requestId: expired.requestId, prompt: 'Expired rewrite', changed: true });
    expect(await page.inputValue('#message-input')).toBe('My newer text');
    await fire('promptEnhanced', { requestId: latest.requestId, prompt: 'Current rewrite', changed: true });
    expect(await page.inputValue('#message-input')).toBe('Current rewrite');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('persona selection works while drafting without a recommendations request and can be cleared by keyboard', async () => {
    await boot('claude-code'); await page.fill('#message-input', 'A meaningful draft');
    await menu(); await page.click('#toolbar-persona-btn');
    await page.focus('.recommendation-chip[data-agent-id="test-persona"]'); await page.keyboard.press('Enter');
    await menu(); await page.click('#toolbar-persona-btn');
    await page.focus('.recommendation-chip[data-agent-id=""]'); await page.keyboard.press('Enter');
    expect((await posted()).at(-1)).toMatchObject({ type: 'updateAgentConfig', payload: { personaId: null } });
    expect(await page.inputValue('#message-input')).toBe('A meaningful draft');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('switching providers cancels enhancement ownership and ignores its late result', async () => {
    await boot('claude-code'); await page.fill('#message-input', 'Draft'); await menu(); await page.click('#enhance-btn');
    const request = (await posted()).findLast(m => m.type === 'enhancePrompt').payload;
    await fire('settingsSync', { provider: 'openai-codex' });
    await fire('promptEnhanced', { requestId: request.requestId, prompt: 'Wrong provider rewrite', changed: true });
    expect(await page.inputValue('#message-input')).toBe('Draft');
    expect(await page.locator('#enhance-btn').evaluate(el => el.classList.contains('enhancing'))).toBe(false);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Mysti routes model selection to the coordinator picker and hides unsupported attachments and Ultracode', async () => {
    await boot('mysti'); await menu();
    expect(await page.locator('[data-composer-action="attach-btn"]').isDisabled()).toBe(true);
    expect(await page.locator('#tools-menu [data-ultracode-control]').isVisible()).toBe(false);
    await page.click('#actions-model-btn'); await page.click('[data-model="__coordinator__"]');
    expect((await posted()).at(-1)).toMatchObject({ type: 'setCoordinatorModel', panelId: 'menu-panel' });
  });
});
