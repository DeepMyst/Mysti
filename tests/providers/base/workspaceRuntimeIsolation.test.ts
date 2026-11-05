import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearMockConfig, clearConfigurationListeners } from '../../helpers/mockVscode';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const settings: Settings = { provider: 'openai-codex', model: '', mode: 'ask-before-edit', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'manual' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});

function harness() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc09-workspaces-')));
  const roots = ['project A', 'project B', 'secondary'].map(name => path.join(directory, name));
  roots.forEach(root => fs.mkdirSync(root));
  const originalFolders = vscode.workspace.workspaceFolders;
  const setRoots = (values: string[] | undefined) => Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    value: values?.map((root, index) => ({ uri: vscode.Uri.file(root), name: path.basename(root), index })), configurable: true,
  });
  setRoots([roots[0]]);
  const provider = new TestableCodexProvider();
  const ledger = path.join(directory, 'worker-ledger.jsonl');
  const children = new Set<any>();
  const originalSpawn = (provider as any)._getOrSpawnPersistentProcess.bind(provider);
  vi.spyOn(provider as any, '_getOrSpawnPersistentProcess').mockImplementation(async (...args: any[]) => {
    const child = await originalSpawn(...args); if (child) children.add(child); return child;
  });
  const build = provider.buildPersistentCliArgs.bind(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((next, session) => {
    build(next, session);
    return [path.resolve(__dirname, '../../fixtures/codexWorkspaceAgent.cjs'), ledger];
  });
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: string) => content);
  provider.setNativeApprovalHost({ handlerForPanel: () => async () => true });
  cleanups.push(async () => {
    const closed = [...children].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 2500); child.once('close', () => { clearTimeout(timer); resolve(); });
    }));
    provider.dispose(); await Promise.all(closed);
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: originalFolders });
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const records = () => fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const canaries = (root: string) => {
    const file = path.join(root, 'pc09-owned-canary.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  const send = async (content: string, next: Partial<Settings> = {}) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage(content, [], { ...settings, ...next }, null, undefined, 'sidebar')) chunks.push(chunk);
    expect(chunks.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    return chunks;
  };
  return { provider, roots, setRoots, send, records, canaries };
}

describe('PC-09 persistent runtime follows its owned workspace', () => {
  it('the next same-settings turn executes in the new first workspace, retaining the explicit conversation thread', async () => {
    const h = harness();
    await h.send('project-A requirement');
    h.setRoots([h.roots[1]]);
    await h.send('project-B requirement');
    expect(h.canaries(h.roots[0]).map(row => row.prompt)).toEqual(['project-A requirement']);
    expect(h.canaries(h.roots[1]).map(row => row.prompt)).toEqual(['project-B requirement']);
    const starts = h.records().filter(row => row.event === 'spawn');
    expect(starts.map(row => row.cwd)).toEqual([h.roots[0], h.roots[1]]);
    expect(new Set(starts.map(row => row.pid)).size).toBe(2);
    expect(h.records().find(row => row.event === 'thread/resume')).toMatchObject({ cwd: h.roots[1], requestedCwd: h.roots[1], thread: 'same-native-thread' });
  });

  it('replaces an unused warm process before the first request in a different workspace', async () => {
    const h = harness();
    await h.provider.preSpawnPersistentProcess('sidebar', settings);
    h.setRoots([h.roots[1]]);
    await h.send('new-workspace-only');
    expect(h.canaries(h.roots[0])).toEqual([]);
    expect(h.canaries(h.roots[1]).map(row => row.prompt)).toEqual(['new-workspace-only']);
  });

  it('does not migrate or terminate an active approval when roots change; its following turn uses the new root', async () => {
    const h = harness(); const requested = deferred<NativeApprovalRequest>(); const decision = deferred<boolean>();
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => { requested.resolve(request); return decision.promise; } });
    const active = h.send('already-running-in-A'); const card = await requested.promise;
    h.setRoots([h.roots[1]]);
    await h.provider.preSpawnPersistentProcess('sidebar', settings);
    expect(card.signal.aborted).toBe(false);
    decision.resolve(true); await active;
    h.provider.setNativeApprovalHost({ handlerForPanel: () => async () => true });
    await h.send('next-turn-in-B');
    expect(h.canaries(h.roots[0]).map(row => row.prompt)).toEqual(['already-running-in-A']);
    expect(h.canaries(h.roots[1]).map(row => row.prompt)).toEqual(['next-turn-in-B']);
  });

  it('removing all folders uses the extension-host working directory instead of failing before transport startup', async () => {
    const h = harness(); h.setRoots([]);
    // A denied fixture operation records cwd but never writes into the host cwd.
    await h.send('empty-workspace-observation', { mode: 'quick-plan', accessLevel: 'read-only' });
    expect(h.records().find(row => row.event === 'spawn')?.cwd).toBe(process.cwd());
    expect(h.records().find(row => row.event === 'decision')?.allowed).toBe(false);
  });

  it('changing only a secondary folder preserves the healthy first-root process', async () => {
    const h = harness(); h.setRoots([h.roots[0], h.roots[1]]);
    await h.send('first-root-before'); h.setRoots([h.roots[0], h.roots[2]]); await h.send('first-root-after');
    expect(h.records().filter(row => row.event === 'spawn')).toHaveLength(1);
    expect(h.canaries(h.roots[0]).map(row => row.prompt)).toEqual(['first-root-before', 'first-root-after']);
  });
});
