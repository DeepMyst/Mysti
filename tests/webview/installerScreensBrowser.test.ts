import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { SetupManager } from '../../src/managers/SetupManager';
import { filterInstallMethodsForOS } from '../../src/utils/platform';
const context = { subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any;
const registry = new ProviderRegistry(context);
const manager = new SetupManager(context, { getProviderInstance: (id: string) => registry.get(id) } as any);
const infos = registry.getAll().map(p => ({ ...manager.getProviderSetupInfo(p.id), providerId: p.id, displayName: p.displayName,
  supportsAutoInstall: p.capabilities.supportsAutoInstall, npmAvailable: true, installMethods: p.getInstallMethods?.() || [] }));
describe('all provider installation screens', () => {
  let browser: Browser, page: Page, dir: string;
  let errors: string[];
  const fire = (type: string, payload: any) => page.evaluate(m => window.dispatchEvent(new MessageEvent('message', { data: m })), { type, payload });
  const posted = () => page.evaluate(() => (window as any).__posted as Array<{ type: string; payload: any }>);
  async function open(providerId: string) {
    await page.evaluate(id => {
      const b = document.createElement('button'); b.className = 'agent-install-btn'; b.dataset.agent = id;
      document.body.append(b); b.click(); b.remove();
    }, providerId);
    return (await posted()).filter(m => m.type === 'requestProviderInstallInfo').at(-1)!.payload.requestId;
  }
  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    browser = await chromium.launch(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-installer-ui-'));
    fs.writeFileSync(path.join(dir, 'chat.html'), composeChatHtml());
  });
  beforeEach(async () => {
    errors = []; page = await browser.newPage({ viewport: { width: 320, height: 650 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`file://${path.join(dir, 'chat.html')}`);
    await fire('initialState', INITIAL_STATE);
  });
  afterEach(async () => { await page?.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); registry.dispose(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    for (const info of infos) {
      it.skipIf(CHROMIUM_UNAVAILABLE)(`${info.providerId} on ${platform}: renders applicable actions and hands off correctly`, async () => {
        const requestId = await open(info.providerId);
        expect(await page.locator('#install-status').textContent()).toContain('Loading');
        const payload = { ...info, requestId, installMethods: filterInstallMethodsForOS(info.installMethods, platform) };
        await fire('providerInstallInfo', payload);
        expect(await page.locator('#install-provider-title').textContent()).toContain(info.displayName);
        const box = await page.locator('.install-provider-content').boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
        if (info.supportsAutoInstall) {
          await page.click('#install-auto-btn');
          expect(await posted()).toContainEqual(expect.objectContaining({ type: 'startProviderSetup', payload: { providerId: info.providerId, autoInstall: true } }));
          expect(await page.locator('#install-progress-section').isVisible()).toBe(true);
        } else {
          expect(await page.locator('#install-auto-section').isVisible()).toBe(false);
          await page.locator('.install-method-terminal-btn').first().click();
          expect(await posted()).toContainEqual(expect.objectContaining({ type: 'openTerminal', payload: { providerId: info.providerId, command: payload.installMethods[0]?.command || info.installCommand } }));
        }
        await page.click('#install-close-btn');
        expect(await page.locator('#install-provider-modal').isVisible()).toBe(false);
      });
    }
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('opens manual installation from the wizard with a matching request identity', async () => {
    await fire('showWizard', { panelId: 'sidebar', providers: [{ providerId: 'ollama', installed: false, authenticated: false, supportsAutoInstall: false }], npmAvailable: true });
    await page.locator('.provider-card[data-provider="ollama"] .provider-action-btn').click();
    const request = (await posted()).filter(m => m.type === 'requestProviderInstallInfo').at(-1)!;
    await fire('providerInstallInfo', { ...infos.find(p => p.providerId === 'ollama'), requestId: request.payload.requestId });
    expect(await page.locator('#install-provider-modal').isVisible()).toBe(true);
    expect(await page.locator('.install-method-terminal-btn').count()).toBeGreaterThan(0);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a completion timer cannot close a newly opened dialog for the same provider', async () => {
    await page.clock.install();
    await open('claude-code'); await fire('providerInstallInfo', infos[0]);
    await page.click('#install-auto-btn');
    await fire('providerSetupStep', { providerId: 'claude-code', step: 'complete', message: 'Ready', progress: 100 });
    await open('claude-code');
    await page.clock.fastForward(1600);
    expect(await page.locator('#install-provider-modal').isVisible()).toBe(true);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('does not hide authentication behind the install popup; timeout retains recovery', async () => {
    await open('claude-code'); await fire('providerInstallInfo', infos[0]);
    await page.click('#install-auto-btn');
    await fire('authPrompt', { providerId: 'claude-code', message: 'Sign in to Claude' });
    expect(await page.locator('#install-provider-modal').isVisible()).toBe(false);
    await page.click('#auth-confirm-btn');
    expect((await posted()).some(m => m.type === 'authConfirm')).toBe(true);
    await fire('setupFailed', { providerId: 'claude-code', error: 'Authentication timed out.' });
    expect(await page.locator('#setup-overlay .setup-message').textContent()).toContain('timed out');
    await page.click('#auth-retry-btn');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'startProviderSetup', payload: { providerId: 'claude-code', autoInstall: false } }));
    await page.click('#auth-error-close-btn');
    expect(await page.locator('#setup-overlay').isVisible()).toBe(false);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('auth choices can be selected by keyboard and cancelled outside the wizard', async () => {
    await open('openai-codex');
    await fire('providerInstallInfo', infos.find(p => p.providerId === 'openai-codex'));
    await fire('authOptions', { providerId: 'openai-codex', displayName: 'Codex', options: manager.getAuthOptions('openai-codex') });
    expect(await page.locator('#install-provider-modal').isVisible()).toBe(false);
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'selectAuthMethod', payload: { providerId: 'openai-codex', method: 'api-key' } }));
    expect(await page.locator('#setup-overlay').isVisible()).toBe(true);
    await page.click('#auth-choice-skip-btn');
    expect((await posted()).some(m => m.type === 'skipSetup')).toBe(true);
    await fire('authOptions', { providerId: 'openai-codex', displayName: 'Codex', options: manager.getAuthOptions('openai-codex') });
    await page.click('.auth-options-cancel');
    expect(await page.locator('#auth-options-modal').isVisible()).toBe(false);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('refresh reports actual completion, updates readiness, and exposes connection handoff', async () => {
    await open('cursor'); await fire('providerInstallInfo', infos.find(p => p.providerId === 'cursor'));
    await page.click('#install-refresh-btn');
    expect(await page.locator('#install-refresh-btn').isDisabled()).toBe(true);
    await fire('providerDetectionComplete', { error: 'Probe unavailable' });
    expect(await page.locator('#install-status').textContent()).toContain('Probe unavailable');
    expect(await page.locator('#install-refresh-btn').isEnabled()).toBe(true);
    await page.click('#install-refresh-btn');
    await fire('wizardStatus', { providers: [{ providerId: 'cursor', installed: true, authenticated: false }], npmAvailable: true });
    await fire('providerDetectionComplete', {});
    await page.click('#install-connect-btn');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'startProviderSetup', payload: { providerId: 'cursor', autoInstall: false } }));
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('loading failures can retry, and older replies for the same provider cannot overwrite the new dialog', async () => {
    const oldId = await open('claude-code');
    await fire('providerInstallInfo', { providerId: 'claude-code', requestId: oldId, error: 'Could not load' });
    await page.click('#install-refresh-btn');
    const newId = (await posted()).filter(m => m.type === 'requestProviderInstallInfo').at(-1)!.payload.requestId;
    await fire('providerInstallInfo', { ...infos[0], requestId: oldId });
    expect(await page.locator('#install-status').textContent()).toContain('Loading');
    await fire('providerInstallInfo', { ...infos[0], requestId: newId });
    expect(await page.locator('#install-auto-btn').isEnabled()).toBe(true);
    await page.locator('#install-close-btn').focus(); await page.keyboard.press('Escape');
    expect(await page.locator('#install-provider-modal').isVisible()).toBe(false);
  });
});
