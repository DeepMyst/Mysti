/** Explicit opt-in account-backed smoke. Runs only with vitest.live.config.ts. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider, TestableCodexProvider } from '../tests/helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../tests/helpers/mockVscode';
import type { Settings, StreamChunk } from '../src/types';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); clearMockConfig(); });
for (const id of ['claude-code', 'openai-codex'] as const) {
  describe(id, () => {
    it('streams, resumes across restart, enforces approvals/read-only, cancels and recovers', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-live-review-'));
      if (id === 'claude-code') {
        fs.mkdirSync(path.join(directory, '.claude'));
        fs.writeFileSync(path.join(directory, '.claude/settings.json'), JSON.stringify({ disableAllHooks: true, permissions: { allow: ['Write', 'Edit', 'Bash(*)'] } }));
      }
      const folders = vscode.workspace.workspaceFolders;
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: [{ uri: vscode.Uri.file(directory), name: 'live-review', index: 0 }], configurable: true });
      const provider = id === 'claude-code' ? new TestableClaudeProvider() : new TestableCodexProvider();
      if (id === 'claude-code') {
        const build = provider.buildPersistentCliArgs.bind(provider);
        vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((s, session) => [...build(s, session)!, '--settings', path.join(directory, '.claude/settings.json')]);
      }
      setMockConfig('claudeCodePath', process.env.MYSTI_LIVE_CLAUDE || path.join(os.homedir(), '.local/bin/claude'));
      setMockConfig('codexPath', process.env.MYSTI_LIVE_CODEX || 'codex');
      cleanups.push(() => { provider.dispose(); Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: folders }); fs.rmSync(directory, { recursive: true, force: true }); });
      // Avoid loading project prompt/context from the review repository. Transport,
      // policy, parsing, session ownership and the real CLI remain unmodified.
      vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (message: string) => message);
      const settings: Settings = { provider: id, model: id === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol',
        mode: 'ask-before-edit', accessLevel: 'ask-permission', thinkingLevel: 'none', effortLevel: 'low', contextMode: 'manual' };
      const run = async (message: string, overrides: Partial<Settings> = {}) => {
        const chunks: StreamChunk[] = [];
        for await (const chunk of provider.sendMessage(message, [], { ...settings, ...overrides }, null, undefined, 'live')) { chunks.push(chunk); }
        expect(chunks.filter(c => c.type === 'error')).toEqual([]);
        expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
        return chunks.filter(c => c.type === 'text').map(c => c.content).join('');
      };
      expect(await run('Do not use tools. Remember review code MYSTI_7429 and reply only READY.')).toContain('READY');
      expect(provider.hasSession('live')).toBe(true);
      expect(await run('Do not use tools. What exact review code did I give you?')).toContain('MYSTI_7429');
      provider.disposePersistentProcess('live');
      expect(await run('Do not use tools. After process restart, repeat the review code I gave you.')).toContain('MYSTI_7429');
      const marker = path.join(directory, 'marker.txt');
      let requests = 0;
      provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
        if (request.defaultDecision === 'allow') { return true; }
        requests++; expect(fs.existsSync(marker)).toBe(false); return false;
      } });
      await run('Create marker.txt containing REVIEW_OK using your file edit tool (Write or apply_patch). Request permission if needed. If denied, stop immediately; do not try other tools.');
      expect(requests).toBeGreaterThan(0); expect(fs.existsSync(marker)).toBe(false);
      requests = 0;
      provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
        if (request.defaultDecision === 'allow') { return true; }
        requests++; expect(fs.existsSync(marker)).toBe(false); return true;
      } });
      await run('Now create marker.txt containing REVIEW_OK with your file edit tool. I will approve the operation.');
      expect(requests).toBeGreaterThan(0); expect(fs.readFileSync(marker, 'utf8')).toContain('REVIEW_OK');
      let observed!: () => void;
      const pending = new Promise<void>(resolve => { observed = resolve; });
      let approvalSignal: AbortSignal | undefined;
      provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
        if (request.defaultDecision === 'allow') { return true; }
        approvalSignal = request.signal; observed();
        return new Promise<boolean>(resolve => request.signal.addEventListener('abort', () => resolve(false), { once: true }));
      } });
      const stopped = run('Invoke the file edit tool now to create stopped.txt containing STOP_MARKER. Do not ask for permission in prose; use the native tool request.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No native request to cancel')), 60_000); })]); }
      finally { if (timer) { clearTimeout(timer); } }
      expect(fs.existsSync(path.join(directory, 'stopped.txt'))).toBe(false);
      provider.cancelCurrentRequest('live'); await stopped;
      expect(approvalSignal?.aborted).toBe(true);
      expect(fs.existsSync(path.join(directory, 'stopped.txt'))).toBe(false);
      expect(await run('Do not use tools. Reply only RECOVERED.')).toContain('RECOVERED');
      provider.clearSession('live'); expect(provider.hasSession('live')).toBe(false);
      const elevate = vi.fn(async () => true);
      provider.setNativeApprovalHost({ handlerForPanel: () => elevate });
      await run('Try to create readonly.txt with the file edit tool. If the tool or policy denies it, stop and report that.', { accessLevel: 'read-only' });
      expect(fs.existsSync(path.join(directory, 'readonly.txt'))).toBe(false);
      expect(elevate).not.toHaveBeenCalled();

    }, 240_000);
  });
}
