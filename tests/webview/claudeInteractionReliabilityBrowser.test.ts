import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry);

describe('PB-01 Claude interaction ownership in shipped Chromium UI', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload?: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  const posted = (type: string) => page.evaluate(type => (window as any).__posted.filter((entry: any) => entry.type === type), type);
  const option = { id: 'native-option', title: 'Fix retry cap', summary: 'Preserve attempts', approach: 'Clamp the delay.', pros: [], cons: [], complexity: 'low' };
  const showPlan = (delivery = 'delivery-a') => receive('planOptions', { source: 'exit-plan-mode', messageId: 'native-plan-message',
    syntheticPlanId: delivery, originalQuery: 'Fix retry without changing attempts', options: [option] });
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    errors = []; page = await browser.newPage({ viewport: { width: 680, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(composeChatHtml());
    await receive('initialState', { ...INITIAL_STATE, panelId: 'claude-owner', providerManifest: manifest, conversation: { id: 'chat-a', messages: [] } });
    await receive('messageAdded', { id: 'native-plan-message', role: 'assistant', provider: 'claude-code', content: 'Plan: clamp the delay.' });
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a double selection of one native plan emits only one execution request', async () => {
    await showPlan();
    await page.locator('.plan-option-header').click();
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('.plan-execute-btn.ask-first')!;
      button.click(); button.click();
    });
    expect(await posted('planOptionSelected')).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a retained native plan button cannot execute after switching conversations', async () => {
    await showPlan();
    await page.evaluate(() => { (window as any).__oldPlan = document.querySelector('.plan-execute-btn.edit-auto'); });
    await receive('conversationChanged', { id: 'chat-b', messages: [{ id: 'native-plan-message', role: 'assistant', provider: 'claude-code', content: 'A different branch retains the same message ID.' }] });
    await showPlan('delivery-b');
    await page.evaluate(() => { (window as any).__oldPlan.click(); });
    expect(await posted('planOptionSelected')).toEqual([]);
    expect(await page.locator('.plan-options-container[data-synthetic-plan-id="delivery-b"]').count()).toBe(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('replacing the plan card revokes its saved controls without disabling the new plan', async () => {
    await showPlan();
    await page.evaluate(() => { (window as any).__oldPlan = document.querySelector('.plan-execute-btn.ask-first'); });
    await showPlan('delivery-replacement');
    await page.evaluate(() => { (window as any).__oldPlan.click(); });
    expect(await posted('planOptionSelected')).toEqual([]);
    await page.locator('.plan-option-header').click();
    await page.locator('.plan-execute-btn.ask-first').click();
    expect(await posted('planOptionSelected')).toHaveLength(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('dismissing a native plan makes its retained execution callback inert', async () => {
    await showPlan();
    await page.evaluate(() => { (window as any).__oldPlan = document.querySelector('.plan-execute-btn.edit-auto'); });
    await page.locator('.plan-options-skip-btn').click();
    await page.evaluate(() => { (window as any).__oldPlan.click(); });
    expect(await posted('planOptionsSkipped')).toHaveLength(1);
    expect(await posted('planOptionSelected')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a delayed timer cannot rebind a replacement plan to the previous delivery', async () => {
    await showPlan('delivery-old'); await showPlan('delivery-current');
    await receive('semiAutonomousPlanTimer', { syntheticPlanId: 'delivery-old', timeout: 30, expiresAt: Date.now() + 30000 });
    expect(await page.locator('.plan-options-container').getAttribute('data-synthetic-plan-id')).toBe('delivery-current');
    expect(await page.locator('.plan-semi-auto-timer').count()).toBe(0);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keyboard execution carries exact native-plan ownership once and preserves the independent draft', async () => {
    await showPlan(); await page.locator('#message-input').fill('Independent next task');
    await page.locator('.plan-option-card').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    expect(await posted('planOptionSelected')).toEqual([{ type: 'planOptionSelected', panelId: 'claude-owner', payload: {
      selectedPlan: option, originalQuery: 'Fix retry without changing attempts', messageId: 'native-plan-message',
      syntheticPlanId: 'delivery-a', conversationId: 'chat-a', executionMode: 'edit-automatically', executionAccessLevel: 'ask-permission', customInstructions: '',
    } }]);
    expect(await page.locator('#message-input').inputValue()).toBe('Independent next task');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Keep Planning preserves custom instructions and does not send an ordinary request from the browser', async () => {
    await showPlan(); await page.locator('.plan-option-header').click();
    await page.locator('.custom-instructions-toggle').click();
    await page.locator('.custom-instructions-textarea').fill('Keep the five-attempt constraint.');
    await page.locator('.plan-execute-btn.keep-planning').click();
    expect(await posted('planOptionSelected')).toEqual([expect.objectContaining({ payload: expect.objectContaining({
      syntheticPlanId: 'delivery-a', conversationId: 'chat-a', executionMode: 'quick-plan', customInstructions: 'Keep the five-attempt constraint.',
    }) })]);
    expect(await posted('sendMessage')).toEqual([]);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('a settled automatic plan cannot be re-executed through its retained callback', async () => {
    await showPlan();
    await page.evaluate(() => { (window as any).__oldPlan = document.querySelector('.plan-execute-btn.edit-auto'); });
    await receive('semiAutonomousDecision', { targetType: 'plan', requestId: 'delivery-a', approved: true, reasoning: 'Selected the bounded retry plan.' });
    await page.evaluate(() => { (window as any).__oldPlan.dispatchEvent(new MouseEvent('click')); });
    expect(await posted('planOptionSelected')).toEqual([]);
    expect(await page.locator('.plan-options-container .semi-autonomous-feedback').textContent()).toBe('Selected the bounded retry plan.');
  });

  for (const questions of [{ bad: true }, [null], [{ question: 'Choose a retry cap', options: 'invalid' }]]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`malformed native questions are rejected visibly without a phantom card: ${JSON.stringify(questions)}`, async () => {
      await receive('askUserQuestion', { toolCallId: 'invalid-question', source: 'tool', questions });
      expect(await page.locator('.ask-user-question-container').count()).toBe(0);
      expect(await page.locator('.message.error').textContent()).toMatch(/invalid.*question.*retry/i);
      expect(await posted('askUserQuestionResponse')).toEqual([]);
      expect(await posted('askUserQuestionSkipped')).toEqual([]);
    });
  }
});
