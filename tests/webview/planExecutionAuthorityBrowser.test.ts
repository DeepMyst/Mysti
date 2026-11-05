import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry);
const option = { id: 'option', title: 'Bounded change', summary: 'Only fixture.txt', approach: 'Edit fixture.txt', pros: [], cons: [], complexity: 'low' };

describe('plan cards offer compatible execution authority in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload: unknown) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = (type: string) => page.evaluate(type => (window as any).__posted.filter((event: any) => event.type === type), type);
  async function boot(provider = 'cline') {
    await receive('initialState', { ...INITIAL_STATE, panelId: 'owner', providerManifest: manifest,
      settings: { ...(INITIAL_STATE.settings as object), provider, mode: 'quick-plan', accessLevel: 'read-only' },
      conversation: { id: 'conversation', messages: [] } });
    await receive('messageAdded', { id: 'message', role: 'assistant', provider, content: 'The proposed plan.' });
    await receive('planOptions', { provider, conversationId: 'conversation', messageId: 'message', syntheticPlanId: 'delivery', originalQuery: 'Original task', options: [option] });
    await page.locator('.plan-option-header').click();
  }
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 500, height: 900 } });
    page.on('pageerror', error => errors.push(error.message)); await page.setContent(composeChatHtml());
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Cline requires an explicit Full choice and second execution click without losing the draft or card', async () => {
    await boot(); await page.locator('#message-input').fill('Independent draft');
    expect(await page.locator('.plan-execute-btn.ask-first').isDisabled()).toBe(true);
    await page.locator('.plan-execute-btn.edit-auto').click();
    expect(await posted('planOptionSelected')).toEqual([]); expect(await posted('updateSettings')).toEqual([]);
    expect(await page.locator('#behavior-popup').isVisible()).toBe(true);
    expect(await page.locator('.plan-execution-hint').textContent()).toMatch(/Full Access.*commands.*network/);
    await page.locator('#behavior-popup .mode-option[data-mode="full"]').click();
    expect((await posted('updateSettings')).at(-1)?.payload).toEqual({ mode: 'edit-automatically', accessLevel: 'full-access' });
    expect(await posted('planOptionSelected')).toEqual([]);
    expect(await page.locator('.plan-execute-btn.edit-auto').textContent()).toBe('Execute with Full Access');
    await page.locator('.plan-execute-btn.edit-auto').click();
    expect(await posted('planOptionSelected')).toEqual([expect.objectContaining({ panelId: 'owner', payload: expect.objectContaining({
      syntheticPlanId: 'delivery', conversationId: 'conversation', executionMode: 'edit-automatically', executionAccessLevel: 'full-access',
    }) })]);
    expect(await page.locator('#message-input').inputValue()).toBe('Independent draft');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keyboard activation cannot silently escape Cline Plan', async () => {
    await boot(); await page.locator('.plan-option-card').focus(); await page.keyboard.press('Enter');
    expect(await posted('planOptionSelected')).toEqual([]); expect(await posted('updateSettings')).toEqual([]);
    expect(await page.locator('#behavior-popup').isVisible()).toBe(true);
  });

  for (const provider of ['claude-code', 'openai-codex']) it.skipIf(CHROMIUM_UNAVAILABLE)(`${provider} retains Ask and gated automatic execution`, async () => {
    await boot(provider); expect(await page.locator('.plan-execute-btn.ask-first').isEnabled()).toBe(true);
    await page.locator('.plan-execute-btn.edit-auto').click();
    expect((await posted('planOptionSelected')).at(-1)?.payload).toMatchObject({ executionMode: 'edit-automatically', executionAccessLevel: 'ask-permission' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('switching providers invalidates a retained execution callback', async () => {
    await boot('claude-code');
    await page.evaluate(() => { (window as any).__oldPlanExecute = document.querySelector('.plan-execute-btn.edit-auto'); });
    await receive('settingsSync', { provider: 'cline' });
    await page.evaluate(() => (window as any).__oldPlanExecute.click());
    expect(await posted('planOptionSelected')).toEqual([]); expect(await posted('updateSettings')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('switching conversations invalidates the pending recovery card', async () => {
    await boot(); await page.locator('.plan-execute-btn.edit-auto').click();
    await page.evaluate(() => { (window as any).__oldPlanExecute = document.querySelector('.plan-execute-btn.edit-auto'); });
    await receive('conversationChanged', { id: 'replacement', messages: [] });
    await page.evaluate(() => (window as any).__oldPlanExecute.click());
    expect(await posted('planOptionSelected')).toEqual([]);
  });
});
