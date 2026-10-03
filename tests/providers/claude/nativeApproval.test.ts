import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../../src/types';

const settings: Settings = { provider: 'claude-code', mode: 'ask-before-edit', accessLevel: 'ask-permission',
  model: '', thinkingLevel: 'none', contextMode: 'auto' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) { await cleanup(); } vi.restoreAllMocks(); });
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-claude-native-'));
  const folders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    value: [{ uri: vscode.Uri.file(directory), name: 'fixture', index: 0 }], configurable: true,
  });
  const provider = new TestableClaudeProvider();
  const build = provider.buildPersistentCliArgs.bind(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((s, session) => {
    const args = build(s, session)!;
    expect(args).toContain('stdio');
    expect(args).not.toContain('--dangerously-skip-permissions');
    return [path.resolve(__dirname, '../../fixtures/claudePermissionAgent.cjs'), directory, session.panelId];
  });
  vi.spyOn(provider as unknown as { buildPromptAsync(): Promise<string> }, 'buildPromptAsync').mockResolvedValue('fixture');
  cleanups.push(async () => {
    provider.dispose(); Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: folders });
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { provider, marker: (panel: string) => path.join(directory, panel),
    send: async (panel = 'panel', overrides: Partial<Settings> = {}) => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.sendMessage('fixture', [], { ...settings, ...overrides }, null, undefined, panel)) { chunks.push(chunk); }
      return chunks;
    },
  };
}

describe('Claude native approvals through a real child process', () => {
  it('holds zero-argument operations until approval; native IDs can be reused next turn', async () => {
    const h = harness(); const seen = deferred<NativeApprovalRequest>(); const decision = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => { seen.resolve(request); return decision.promise; } });
    const run = h.send(); const request = await seen.promise;
    expect(request.toolCall).toMatchObject({ name: 'Bash', input: {} });
    expect(fs.existsSync(h.marker('panel'))).toBe(false);
    decision.resolve(true);
    expect((await run).filter(c => c.type === 'done')).toHaveLength(1);
    expect(fs.readFileSync(h.marker('panel'), 'utf8')).toBe('executed\n');
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async second => {
      expect(second.id).not.toBe(request.id); expect(second.nativeRequestId).toBe(request.nativeRequestId); return true;
    } });
    await h.send();
    expect(fs.readFileSync(h.marker('panel'), 'utf8')).toBe('executed\nexecuted\n');
  });
  it('denies without a host; readonly policy cannot be elevated by the host', async () => {
    const h = harness(); await h.send(); expect(fs.existsSync(h.marker('panel'))).toBe(false);
    const handler = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    await h.send('readonly', { accessLevel: 'read-only' });
    expect(handler).not.toHaveBeenCalled(); expect(fs.existsSync(h.marker('readonly'))).toBe(false);
  });
  it('Stop cancels the card; a late Allow cannot authorize a replacement turn', async () => {
    const h = harness(); const seen = deferred<NativeApprovalRequest>(); const decision = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => { seen.resolve(request); return decision.promise; } });
    const first = h.send(); const request = await seen.promise;
    h.provider.cancelCurrentRequest('panel'); await first;
    expect(request.signal.aborted).toBe(true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async () => false });
    const next = h.send(); decision.resolve(true); await next;
    expect(fs.existsSync(h.marker('panel'))).toBe(false);
  });
  it('cannot silently fall back when the approval transport fails to start', async () => {
    const h = harness();
    vi.spyOn(h.provider as unknown as { _getOrSpawnPersistentProcess(): Promise<null> }, '_getOrSpawnPersistentProcess').mockResolvedValue(null);
    const fallback = vi.spyOn(h.provider, 'buildCliArgs');
    const chunks = await h.send();
    expect(chunks.some(c => c.type === 'error' && c.content.includes('native approval transport'))).toBe(true);
    expect(fallback).not.toHaveBeenCalled(); expect(fs.existsSync(h.marker('panel'))).toBe(false);
  });
  it('keeps concurrent panels independent and cancels pending approvals when a session is cleared', async () => {
    const h = harness(); const pending = deferred<NativeApprovalRequest>(); const decision = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: panel => async request => {
      if (panel === 'a') { pending.resolve(request); return decision.promise; }
      return false;
    } });
    const first = h.send('a'); const request = await pending.promise;
    await h.send('b'); expect(fs.existsSync(h.marker('b'))).toBe(false);
    h.provider.clearSession('a'); await first;
    expect(request.signal.aborted).toBe(true); expect(h.provider.hasSession('a')).toBe(false);
    decision.resolve(true);
    expect(fs.existsSync(h.marker('a'))).toBe(false);
  });

});
