import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { contextRangeCases, contextRangeItem } from '../helpers/contextRangeCases';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';

describe('context selection line labels in the shipped browser', () => {
  let browser: Browser, page: Page, errors: string[];
  const receive = (type: string, payload: unknown) => page.evaluate(message =>
    window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
  beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) return;
    errors = []; page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent(composeChatHtml());
  });
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });

  it.skipIf(CHROMIUM_UNAVAILABLE)('labels initial and restored context consistently while composer preserves raw selection metadata', async () => {
    const context = contextRangeCases.map(contextRangeItem);
    const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
    try {
      await receive('initialState', { ...INITIAL_STATE, panelId: 'range-owner', providerManifest: buildProviderManifestPayload(registry),
        conversation: { id: 'range-conversation', messages: [] }, context });
    } finally { registry.dispose(); }
    const expected = contextRangeCases.map((value, index) => `selection-${index}.ts${value.label ? ':' + value.label : ''}`);
    expect(await page.locator('.context-item-path').allTextContents()).toEqual(expected);
    await receive('contextUpdated', context);
    expect(await page.locator('.context-item-path').allTextContents()).toEqual(expected);
    await page.locator('#message-input').fill('Review the exact selected bytes.');
    await page.locator('#send-btn').click();
    const sends = await page.evaluate(() => (window as any).__posted.filter((message: any) => message.type === 'sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.context).toEqual(context);
  }, 20_000);
});
