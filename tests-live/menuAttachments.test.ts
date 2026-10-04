/** Account-backed smoke: run explicitly with vitest.live.config.ts. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { TestableClaudeProvider, TestableCodexProvider } from '../tests/helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../tests/helpers/mockVscode';
import type { Settings, StreamChunk } from '../src/types';
const results: unknown[] = [];
for (const id of ['claude-code', 'openai-codex'] as const) {
  it(`${id}: reads file and image attachments through the actual Mysti transport`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-live-attachments-'));
    const folders = vscode.workspace.workspaceFolders;
    const provider = id === 'claude-code' ? new TestableClaudeProvider() : new TestableCodexProvider();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: [{ uri: vscode.Uri.file(dir), name: 'attachment-test', index: 0 }], configurable: true });
    setMockConfig('claudeCodePath', process.env.MYSTI_LIVE_CLAUDE || path.join(os.homedir(), '.local/bin/claude'));
    setMockConfig('codexPath', process.env.MYSTI_LIVE_CODEX || 'codex');
    const watchdog = setTimeout(() => provider.cancelCurrentRequest('attachment-test'), 100000);
    const started = Date.now();
    const row: Record<string, unknown> = { provider: id, scope: 'Actual CLI inference with a temporary text attachment and generated blue PNG; no user files.' };
    try {
      if (id === 'claude-code') {
        fs.mkdirSync(path.join(dir, '.claude'));
        const settingsFile = path.join(dir, '.claude/settings.json');
        fs.writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true }));
        const build = provider.buildPersistentCliArgs.bind(provider);
        vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((s, session) => [...build(s, session)!, '--settings', settingsFile]);
      }
      const browser = await chromium.launch();
      let png: Buffer;
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
        await page.setContent('<style>html,body{margin:0;width:100%;height:100%;background:#0000ff}</style>');
        png = await page.screenshot();
      } finally { await browser.close(); }
      const marker = 'MYSTI_ATTACHMENT_' + randomUUID().slice(0, 8);
      const settings: Settings = { provider: id, model: id === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol', mode: 'ask-before-edit', accessLevel: 'read-only', thinkingLevel: 'none', effortLevel: 'low', contextMode: 'manual' };
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.sendMessage('Read the attached text file and inspect the attached image. Reply with the exact token from the text file and the dominant color of the image. Do not modify files.', [], settings, null, undefined, 'attachment-test', undefined, undefined, [
        { id: 'token', type: 'file', fileName: 'token.txt', mimeType: 'text/plain', size: marker.length, base64Data: Buffer.from(marker).toString('base64') },
        { id: 'image', type: 'image', fileName: 'color.png', mimeType: 'image/png', size: png.length, base64Data: png.toString('base64') },
      ])) chunks.push(chunk);
      const answer = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
      row.errors = chunks.filter(c => c.type === 'error' || c.type === 'auth_error').map(c => c.content);
      row.fileRead = answer.includes(marker); row.imageRead = /blue/i.test(answer);
      expect(row.errors).toEqual([]); expect(row.fileRead).toBe(true); expect(row.imageRead).toBe(true);
      row.passed = true;
    } catch (error) { row.passed = false; row.error = String(error); throw error; }
    finally {
      clearTimeout(watchdog); provider.dispose(); vi.restoreAllMocks(); clearMockConfig();
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: folders }); fs.rmSync(dir, { recursive: true, force: true });
      row.durationMs = Date.now() - started; results.push(row);
      fs.writeFileSync(path.resolve('plans/37-live-attachment-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), platform: process.platform, results }, null, 2) + '\n');
    }
  }, 120000);
}
