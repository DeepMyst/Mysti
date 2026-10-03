/** Account-backed editor smoke, enabled only by MYSTI_LIVE_PROVIDERS=1. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame } from 'playwright';

if (process.env.MYSTI_LIVE_PROVIDERS === '1') {
  describe('Live providers in the real Mysti chat', function () {
    this.timeout(240_000);
    let browser: Browser;
    before(async () => {
      const config = vscode.workspace.getConfiguration('mysti');
      await config.update('claudeCodePath', path.join(os.homedir(), '.local/bin/claude'), vscode.ConfigurationTarget.Global);
      await config.update('codexPath', 'codex', vscode.ConfigurationTarget.Global);
      await config.update('defaultMode', 'ask-before-edit', vscode.ConfigurationTarget.Global);
      await config.update('accessLevel', 'ask-permission', vscode.ConfigurationTarget.Global);
      await config.update('autoContext', false, vscode.ConfigurationTarget.Global);
      await config.update('showSuggestions', false, vscode.ConfigurationTarget.Global);
      await vscode.extensions.getExtension('DeepMyst.mysti')!.activate();
      const endpoint = fs.readFileSync(path.join(process.env.MYSTI_TEST_USER_DATA_DIR!, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
    });
    after(async () => { await browser?.close(); });
    async function chat(): Promise<Frame> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        for (const context of browser.contexts()) {
          for (const page of context.pages()) {
            for (const frame of page.frames()) {
              try {
                if (await frame.locator('#message-input').count()) { await page.bringToFront(); return frame; }
              } catch { /* editor webviews detach while tabs are opening */ }
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('Mysti chat webview did not open');
    }
    for (const provider of ['claude-code', 'openai-codex']) {
      it(`${provider}: completes two turns and enforces Deny / Allow from real permission cards`, async () => {
        for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label !== 'Mysti Canvas')) { await vscode.window.tabGroups.close(tab); }
        const config = vscode.workspace.getConfiguration('mysti');
        await config.update('defaultProvider', provider, vscode.ConfigurationTarget.Global);
        await config.update('defaultModel', provider === 'claude-code' ? 'claude-sonnet-4-6' : 'gpt-5.6-sol', vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('mysti.openInNewTab');
        const frame = await chat();
        const skip = frame.locator('.wizard-skip-btn');
        if (await skip.isVisible()) { await skip.click(); }
        const send = async (prompt: string) => {
          await frame.locator('#message-input').fill(prompt);
          await frame.locator('#send-btn').click();
        };
        const finished = async (marker: string) => {
          await frame.locator('.message.assistant').filter({ hasText: marker }).last().waitFor({ state: 'visible', timeout: 120_000 });
          await frame.locator('.message.assistant.streaming').waitFor({ state: 'hidden', timeout: 120_000 });
        };
        await send('Do not use tools. Remember code MYSTI_EDITOR_9327 and reply exactly EDITOR_READY.');
        await finished('EDITOR_READY');
        await send('Do not use tools. What exact code did I ask you to remember?');
        await finished('MYSTI_EDITOR_9327');
        const markerName = `${provider}-approval-marker.txt`;
        const markerPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, markerName);
        try { fs.unlinkSync(markerPath); } catch { /* absent is expected */ }
        await send(`Use your file edit tool to create ${markerName} containing EDITOR_OK. Invoke the tool now to trigger the native approval card; do not ask permission in prose. If denied, stop and reply EDITOR_DENIED; do not retry.`);
        const deny = frame.locator('.permission-card:not(.resolved) [data-action="deny"]').last();
        try { await deny.waitFor({ state: 'visible', timeout: 60_000 }); }
        catch (error) { console.log('[live review] last reply:', await frame.locator('.message.assistant').last().textContent()); throw error; }
        assert.strictEqual(fs.existsSync(markerPath), false, 'write ran before host approval');
        await deny.click(); await finished('EDITOR_DENIED');
        assert.strictEqual(fs.existsSync(markerPath), false, 'denied write ran');
        await send(`Now create ${markerName} containing EDITOR_OK with your file edit tool. I will approve it. Reply EDITOR_DONE afterward.`);
        const approve = frame.locator('.permission-card:not(.resolved) [data-action="approve"]').last();
        await approve.waitFor({ state: 'visible', timeout: 120_000 });
        assert.strictEqual(fs.existsSync(markerPath), false);
        await approve.click(); await finished('EDITOR_DONE');
        assert.ok(fs.readFileSync(markerPath, 'utf8').includes('EDITOR_OK'));
        fs.unlinkSync(markerPath);
        // Close this chat so the next provider has a fresh panel and history.
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label !== 'Mysti Canvas');
        for (const tab of tabs) { await vscode.window.tabGroups.close(tab); }
      });
    }
  });
}
