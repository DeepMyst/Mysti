/** Opt-in live, read-only assignment smoke. Uses an isolated editor test profile. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame } from 'playwright';

if (process.env.MYSTI_LIVE_MENTIONS === '1') {
  describe('Live explicit Claude Code and Codex opinions', function () {
    this.timeout(180_000);
    let browser: Browser;
    after(async () => { await browser?.close(); });
    it('renders both actual provider responses without selected-provider substitution', async () => {
      const config = vscode.workspace.getConfiguration('mysti');
      const baseProvider = process.env.MYSTI_LIVE_BASE_PROVIDER || 'openai-codex';
      await config.update('defaultAgent', baseProvider, vscode.ConfigurationTarget.Global);
      await config.update('defaultProvider', baseProvider, vscode.ConfigurationTarget.Global);
      await config.update('claudeCodePath', process.env.MYSTI_LIVE_CLAUDE_PATH || 'claude', vscode.ConfigurationTarget.Global);
      await config.update('codexPath', process.env.MYSTI_LIVE_CODEX_PATH || 'codex', vscode.ConfigurationTarget.Global);
      await config.update('claudeCodeModel', process.env.MYSTI_LIVE_CLAUDE_MODEL || 'sonnet', vscode.ConfigurationTarget.Global);
      await config.update('defaultMode', 'ask-before-edit', vscode.ConfigurationTarget.Global);
      await config.update('accessLevel', 'read-only', vscode.ConfigurationTarget.Global);
      await config.update('autoContext', false, vscode.ConfigurationTarget.Global);
      await config.update('showSuggestions', false, vscode.ConfigurationTarget.Global);
      await vscode.extensions.getExtension('DeepMyst.mysti')!.activate();
      for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputWebview)) {
        await vscode.window.tabGroups.close(tab);
      }
      await vscode.commands.executeCommand('mysti.openInNewTab');
      const endpoint = fs.readFileSync(path.join(process.env.MYSTI_TEST_USER_DATA_DIR!, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      let frame: Frame | undefined;
      const deadline = Date.now() + 30_000;
      while (!frame && Date.now() < deadline) {
        for (const context of browser.contexts()) {
          for (const page of context.pages()) {
            for (const candidate of page.frames()) {
              try {
                if (await candidate.locator('#message-input').isVisible() &&
                    await candidate.locator('#init-loading-overlay').isHidden()) {
                  frame = candidate; await page.bringToFront(); break;
                }
              }
              catch { /* webview is mounting */ }
            }
          }
        }
        if (!frame) { await new Promise(r => setTimeout(r, 200)); }
      }
      assert.ok(frame, 'Mysti chat must open');
      const skip = frame.locator('.wizard-skip-btn'); if (await skip.isVisible()) { await skip.click(); }
      // The extension may already be active from another native test. Changing
      // defaults does not replace that panel's selection; choose it through UI.
      await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent="${baseProvider}"]`).click();
      const selected = await frame.locator('#agent-name').textContent();
      assert.ok(baseProvider === 'cline' ? /cline/i.test(selected || '') : /codex/i.test(selected || ''),
        `Expected ${baseProvider} selected, got ${selected}`);
      const prompt = '@claude @codex What is your opinion on adding a TTL cache to a read-heavy API? Do not use tools or delegate. Give your own independent opinion in two short sentences, prefixed OPINION_OK.';
      await frame.locator('#message-input').fill(prompt);
      await frame.locator('#send-btn').click();
      await frame.locator('.collaboration-card').nth(1).waitFor({ timeout: 45_000 });
      const captureDir = process.env.MYSTI_LIVE_CAPTURE_DIR;
      if (captureDir) { fs.mkdirSync(captureDir, { recursive: true }); }
      let index = 0;
      const stopAt = Date.now() + 100_000;
      while (Date.now() < stopAt) {
        if (captureDir) { await frame.locator('body').screenshot({ path: path.join(captureDir, `frame-${String(index++).padStart(4, '0')}.png`) }); }
        const cards = frame.locator('.collaboration-card');
        if (await frame.locator('.collaboration-status[data-state="complete"]').count() === 2) { break; }
        if (await frame.locator('.collaboration-status[data-state="error"]').count()) {
          throw new Error('A live participant failed: ' + await cards.innerText().catch(() => 'inspect provider setup'));
        }
        await new Promise(r => setTimeout(r, 750));
      }
      assert.strictEqual(await frame.locator('.collaboration-status[data-state="complete"]').count(), 2, 'both providers must complete');
      for (const card of await frame.locator('.collaboration-card').all()) {
        assert.ok((await card.textContent())?.includes('OPINION_OK'), 'each card contains its own real response');
      }
      await frame.locator('.message.assistant.streaming').waitFor({ state: 'hidden', timeout: 15_000 });
      assert.ok((await frame.locator('.message.assistant').last().textContent())?.includes('OPINION_OK'));
    });
  });
}
