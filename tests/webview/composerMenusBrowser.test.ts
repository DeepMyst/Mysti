import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

describe('composer model and action menus', () => {
  let browser: Browser;
  let page: Page;
  let dir: string;
  const errors: string[] = [];
  const fire = (message: Record<string, unknown>) => page.evaluate(m => {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
  }, message);
  const posted = () => page.evaluate(() => (window as unknown as {
    __posted: Array<{ type: string; payload?: Record<string, unknown> }>;
  }).__posted);

  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    browser = await chromium.launch();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-menus-'));
    fs.writeFileSync(path.join(dir, 'chat.html'), composeChatHtml());
  });
  beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 400, height: 850 } });
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`file://${path.join(dir, 'chat.html')}`);
    await page.addStyleTag({ content: ':root { --vscode-editor-background: #1e1e1e; --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-font-family: Arial; --vscode-font-size: 13px; --vscode-panel-border: #444; }' });
    await fire({ type: 'initialState', payload: {
      ...INITIAL_STATE,
      settings: { ...(INITIAL_STATE.settings as object), model: 'opus' },
      providers: [
        { name: 'claude-code', models: [{ id: 'opus', name: 'Opus', description: 'Complex coding and reasoning' }, { id: 'sonnet', name: 'Sonnet', description: 'Everyday tasks' }] },
        { name: 'openai-codex', models: [{ id: 'codex', name: 'Codex', description: 'Coding agent' }] },
        { name: 'gemini-cli', models: [{ id: 'gemini', name: 'Gemini' }] },
      ],
      providerManifest: { schemaVersion: 1, providers: [
        { id: 'claude-code', capabilities: { supportsUltracode: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortDefault: 'high' } },
        { id: 'openai-codex', capabilities: { effortLevels: ['low', 'medium', 'high', 'xhigh'], effortDefault: 'medium' } },
        { id: 'gemini-cli', capabilities: {} },
      ] },
    } });
  });
  afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('chooses a described model with the keyboard and posts the existing setting', async () => {
    await page.click('#model-menu-btn');
    const active = page.locator('#model-menu [aria-pressed="true"]');
    expect(await active.textContent()).toContain('Complex coding and reasoning');
    expect(await active.textContent()).toContain('✓');
    expect(await active.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(6, 62, 96)');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.locator('#model-menu').isVisible()).toBe(false);
    expect(await page.locator('#model-menu-label').textContent()).toBe('Sonnet');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'updateSettings', payload: { model: 'sonnet', customModel: '' } }));
    expect(await page.locator('#model-menu-btn').evaluate(el => el === document.activeElement)).toBe(true);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('changes effort through real range keys and synchronizes both menus', async () => {
    await page.click('#model-menu-btn');
    const slider = page.locator('#model-menu input[type="range"]');
    expect(await slider.getAttribute('max')).toBe('4');
    expect(await slider.getAttribute('aria-valuetext')).toBe('High');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    expect(await slider.getAttribute('aria-valuetext')).toBe('Extra High');
    expect(await page.locator('#model-menu-btn #model-menu-effort').textContent()).toBe('Extra High');
    expect(await slider.evaluate(el => el === document.activeElement)).toBe(true);
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'updateSettings', payload: { effortLevel: 'xhigh' } }));
    await page.keyboard.press('Escape');
    await page.click('#tools-menu-btn');
    expect(await page.locator('#tools-menu input[type="range"]').getAttribute('aria-valuetext')).toBe('Extra High');
    expect(await page.locator('#tools-menu [data-effort-control]').evaluate(el => (el as HTMLElement).style.getPropertyValue('--effort-fill'))).toBe('75%');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps Ultracode independent of effort and synchronizes all three controls', async () => {
    await page.click('#model-menu-btn');
    await page.click('#model-menu [data-ultracode-toggle]');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'updateSettings', payload: { ultracode: true } }));
    expect(await page.locator('[data-ultracode-toggle][aria-checked="true"]').count()).toBe(3);
    expect(await page.locator('#model-menu-btn #model-menu-effort').textContent()).toBe('High · Ultracode');
    expect(await page.locator('#model-menu input[type="range"]').getAttribute('aria-valuetext')).toBe('High');
    await page.keyboard.press('Escape');
    await page.click('#tools-menu-btn');
    await page.click('#tools-menu [data-ultracode-toggle]');
    expect(await page.locator('[data-ultracode-toggle][aria-checked="false"]').count()).toBe(3);
    expect(await page.locator('#model-menu-btn #model-menu-effort').textContent()).toBe('High');
    await fire({ type: 'settingsSync', payload: { ultracode: true, effortLevel: 'max' } });
    expect(await page.locator('[data-ultracode-toggle][aria-checked="true"]').count()).toBe(3);
    await fire({ type: 'settingsSync', payload: { provider: 'openai-codex', model: 'codex' } });
    expect(await page.locator('#tools-menu [data-ultracode-control]').isVisible()).toBe(false);
    expect(await page.locator('#tools-menu input[type="range"]').getAttribute('aria-valuetext')).toBe('Extra High');
    await fire({ type: 'settingsSync', payload: { provider: 'claude-code', model: 'opus' } });
    expect(await page.locator('#tools-menu [data-ultracode-toggle]').getAttribute('aria-checked')).toBe('true');
    expect(await page.locator('#tools-menu input[type="range"]').getAttribute('aria-valuetext')).toBe('Max');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('opens slash commands using the visible button beside actions', async () => {
    await page.click('#slash-cmd-btn');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'requestSlashCommands', payload: { query: '' } }));
    await fire({ type: 'slashCommandMenu', payload: { commands: [{ id: 'help', label: 'Help', description: 'Show help', section: 'General' }], sections: ['General'] } });
    expect(await page.locator('#slash-menu').isVisible()).toBe(true);
  });

  async function requestInstall(id: string) {
    await page.evaluate(providerId => {
      const button = document.createElement('button');
      button.className = 'agent-install-btn';
      button.dataset.agent = providerId;
      document.body.append(button);
      button.click();
      button.remove();
    }, id);
  }

  const installInfo = { providerId: 'claude-code', displayName: 'Claude', installCommand: 'npm install -g @anthropic-ai/claude-code',
    authInstructions: ['Run claude auth login'], supportsAutoInstall: true, npmAvailable: true };

  it.skipIf(CHROMIUM_UNAVAILABLE)('installs from the popup, displays failure details, permits retry and closes after success', async () => {
    await page.clock.install();
    await requestInstall('claude-code');
    await fire({ type: 'providerInstallInfo', payload: installInfo });
    expect(await page.locator('#install-provider-modal').isVisible()).toBe(true);
    await page.click('#install-auto-btn');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'startProviderSetup', payload: expect.objectContaining({ providerId: 'claude-code' }) }));
    await fire({ type: 'providerSetupStep', payload: { providerId: 'claude-code', step: 'failed', message: 'Network unavailable', errorCategory: 'network', suggestedFix: 'Check connection', retryable: true } });
    expect(await page.locator('#install-error-details').textContent()).toContain('Check connection');
    await page.clock.fastForward(2100);
    await page.locator('#install-auto-btn').waitFor({ state: 'visible' });
    await page.click('#install-auto-btn');
    await fire({ type: 'providerSetupStep', payload: { providerId: 'claude-code', step: 'complete', message: 'Ready', progress: 100 } });
    await page.clock.fastForward(1600);
    await page.locator('#install-provider-modal').waitFor({ state: 'hidden' });
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('rejects stale install replies, disables auto-install without npm and runs manual methods', async () => {
    await requestInstall('claude-code');
    await requestInstall('cursor');
    await fire({ type: 'providerInstallInfo', payload: installInfo });
    expect(await page.locator('#install-status').textContent()).toContain('Loading');
    await fire({ type: 'providerInstallInfo', payload: { ...installInfo, providerId: 'cursor', displayName: 'Cursor', supportsAutoInstall: false,
      installMethods: [{ label: 'Windows', command: "irm 'https://cursor.com/install?win32=true' | iex" }] } });
    expect(await page.locator('#install-auto-section').isVisible()).toBe(false);
    await page.click('.install-method-terminal-btn');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'openTerminal', payload: { providerId: 'cursor', command: "irm 'https://cursor.com/install?win32=true' | iex" } }));
    await page.click('#install-refresh-btn');
    expect((await posted()).some(m => m.type === 'refreshProviderDetection')).toBe(true);
    await page.click('#install-close-btn');
    await requestInstall('claude-code');
    await fire({ type: 'providerInstallInfo', payload: { ...installInfo, npmAvailable: false } });
    expect(await page.locator('#install-auto-btn').isDisabled()).toBe(true);
    await page.click('#install-terminal-btn');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'openTerminal', payload: { providerId: 'claude-code', command: installInfo.installCommand } }));
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('filters groups, reports an empty result, and routes an action', async () => {
    await page.click('#tools-menu-btn');
    await page.fill('#tools-menu-filter', 'nothing matches');
    expect(await page.locator('#tools-menu-empty').isVisible()).toBe(true);
    await page.fill('#tools-menu-filter', 'export');
    expect(await page.locator('#tools-menu .tools-menu-item:visible').count()).toBe(1);
    await page.click('[data-composer-action="export-conversation-btn"]');
    expect((await posted()).some(m => m.type === 'exportConversation')).toBe(true);
    expect(await page.locator('#tools-menu').isVisible()).toBe(false);
    await page.click('#tools-menu-btn');
    expect(await page.locator('#tools-menu-filter').inputValue()).toBe('');
    await page.click('#actions-model-btn');
    expect(await page.locator('#model-menu').isVisible()).toBe(true);
    expect(await page.locator('#tools-menu-btn').getAttribute('aria-expanded')).toBe('false');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('uses Codex and Mysti effort levels and removes unsupported controls', async () => {
    await fire({ type: 'settingsSync', payload: { provider: 'openai-codex', model: 'codex', effortLevel: 'medium' } });
    await page.click('#model-menu-btn');
    expect(await page.locator('#model-menu input[type="range"]').getAttribute('max')).toBe('3');
    expect(await page.locator('#model-menu [data-model]:not([data-model="__custom__"])').count()).toBe(1);
    await fire({ type: 'settingsSync', payload: { provider: 'mysti', effortLevel: 'medium' } });
    expect(await page.locator('#model-menu input[type="range"]').getAttribute('max')).toBe('2');
    await page.click('[data-model="__coordinator__"]');
    expect((await posted()).some(m => m.type === 'setCoordinatorModel')).toBe(true);
    await fire({ type: 'settingsSync', payload: { provider: 'gemini-cli', model: 'gemini' } });
    await page.click('#model-menu-btn');
    expect(await page.locator('#model-menu [data-effort-control]').isVisible()).toBe(false);
    expect(await page.locator('#model-menu [data-model]:not([data-model="__custom__"])').count()).toBe(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('Escape closes the menu without stopping an active response; outside click dismisses it', async () => {
    await fire({ type: 'responseStarted' });
    await page.click('#model-menu-btn');
    await page.keyboard.press('Escape');
    expect(await page.locator('#model-menu').isVisible()).toBe(false);
    expect((await posted()).some(m => m.type === 'cancelRequest')).toBe(false);
    await page.click('#tools-menu-btn');
    await page.click('#message-input');
    expect(await page.locator('#tools-menu').isVisible()).toBe(false);
    expect(await page.locator('#tools-menu-btn').getAttribute('aria-expanded')).toBe('false');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('fits a narrow panel and honors light and high contrast theme colors', async () => {
    await page.setViewportSize({ width: 300, height: 650 });
    await page.addStyleTag({ content: ':root { --vscode-menu-background: #fff; --vscode-menu-foreground: #222; --vscode-list-activeSelectionBackground: #005fb8; --vscode-list-activeSelectionForeground: #fff; --vscode-contrastActiveBorder: #f0f; --vscode-descriptionForeground: #555; }' });
    await page.click('#model-menu-btn');
    const box = await page.locator('#model-menu').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(300);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(await page.locator('#model-menu').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('#model-menu [aria-pressed="true"]').evaluate(el => getComputedStyle(el).borderColor)).toBe('rgb(255, 0, 255)');
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps effort visible with a long model catalog and dismisses when focus leaves', async () => {
    await fire({ type: 'modelsUpdated', payload: { provider: 'claude-code', models: Array.from({ length: 40 }, (_, i) => ({
      id: i === 0 ? 'opus' : `model-${i}`, name: `Model ${i}`, description: 'A model from the provider catalog',
    })) } });
    await page.click('#model-menu-btn');
    const menu = await page.locator('#model-menu').boundingBox();
    const effort = await page.locator('#model-menu input[type="range"]').boundingBox();
    expect(effort!.y).toBeGreaterThan(menu!.y);
    expect(effort!.y + effort!.height).toBeLessThan(menu!.y + menu!.height);
    expect(await page.locator('#model-menu-options').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.locator('#model-menu input[type="range"]').focus();
    await page.keyboard.press('Tab');
    expect(await page.locator('#model-menu').isVisible()).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.locator('#model-menu').isVisible()).toBe(false);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('offers an upgrade beside a version error and displays progress, failure and verified success', async () => {
    const payload = { id: 'upgrade-1', providerId: 'claude-code', providerLabel: 'Claude', minimum: '2.1.280',
      state: 'available', message: 'This model requires Claude CLI 2.1.280 or newer.' };
    await fire({ type: 'modelCliUpgrade', payload });
    const button = page.locator('.cli-upgrade-button');
    expect(await button.textContent()).toBe('Upgrade CLI · 2.1.280+');
    await button.click();
    expect(await button.isDisabled()).toBe(true);
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'upgradeModelCli', payload: { id: 'upgrade-1' } }));
    await fire({ type: 'modelCliUpgrade', payload: { ...payload, state: 'installing', message: 'Verifying the installed CLI…' } });
    expect(await button.textContent()).toBe('Upgrading…');
    await fire({ type: 'modelCliUpgrade', payload: { ...payload, state: 'failed', message: 'CLI version is still 2.1.278' } });
    expect(await button.isEnabled()).toBe(true);
    expect(await button.textContent()).toBe('Retry upgrade');
    await fire({ type: 'modelCliUpgrade', payload: { ...payload, state: 'ready', message: 'CLI 2.1.286 is ready. Send your message again.' } });
    expect(await button.isDisabled()).toBe(true);
    expect(await page.locator('.cli-upgrade-status').textContent()).toContain('2.1.286');
    expect(await page.locator('.cli-model-upgrade').count()).toBe(1);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('replaces obsolete upgrade offers and ignores late results in another conversation', async () => {
    const payload = { id: 'old', providerId: 'claude-code', providerLabel: 'Claude', minimum: '2.1.280', state: 'available', message: '<img src=x onerror=alert(1)>' };
    await fire({ type: 'modelCliUpgrade', payload });
    expect(await page.locator('.cli-upgrade-status img').count()).toBe(0);
    await fire({ type: 'modelCliUpgrade', payload: { ...payload, id: 'new' } });
    expect(await page.locator('.cli-model-upgrade').count()).toBe(1);
    await page.click('.cli-upgrade-button');
    expect(await posted()).toContainEqual(expect.objectContaining({ type: 'upgradeModelCli', payload: { id: 'new' } }));
    await fire({ type: 'conversationChanged', payload: { id: 'next', messages: [] } });
    await fire({ type: 'modelCliUpgrade', payload: { ...payload, id: 'new', state: 'ready' } });
    expect(await page.locator('.cli-model-upgrade').count()).toBe(0);
  });
});
