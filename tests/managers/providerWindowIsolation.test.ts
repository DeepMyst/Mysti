import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { NativeApprovalRequest } from '../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../src/types';
import { clearMockConfig, clearConfigurationListeners } from '../helpers/mockVscode';

const settings: Settings = { provider: 'openai-codex', model: '', mode: 'ask-before-edit', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'manual' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});

function windows() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc09-windows-')));
  const originalFolders = vscode.workspace.workspaceFolders;
  const children = new Set<any>();
  const instances = ['window-A', 'window-B'].map(name => {
    const root = path.join(directory, name); fs.mkdirSync(root);
    const ledger = path.join(directory, `${name}.jsonl`);
    const manager = new ProviderManager({
      subscriptions: [], extensionPath: '/mock/extension', extensionUri: vscode.Uri.file('/mock/extension'),
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as vscode.ExtensionContext);
    const provider = manager.getRegistry().get('openai-codex')! as any;
    const originalSpawn = provider._getOrSpawnPersistentProcess.bind(provider);
    vi.spyOn(provider, '_getOrSpawnPersistentProcess').mockImplementation(async (...args: any[]) => {
      const child = await originalSpawn(...args); if (child) children.add(child); return child;
    });
    const build = provider.buildPersistentCliArgs.bind(provider);
    vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((next: Settings, session: any) => {
      build(next, session); return [path.resolve(__dirname, '../fixtures/codexWorkspaceAgent.cjs'), ledger];
    });
    vi.spyOn(provider, 'buildPromptAsync').mockImplementation(async (content: string) => content);
    const activateOwnWorkspace = () => Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: [{ uri: vscode.Uri.file(root), name, index: 0 }], configurable: true,
    });
    const records = () => fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    const canaries = () => {
      const file = path.join(root, 'pc09-owned-canary.jsonl');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    };
    const send = async (content: string) => {
      activateOwnWorkspace();
      const chunks: StreamChunk[] = [];
      for await (const chunk of manager.sendMessage(content, [], settings, null, undefined, 'sidebar')) chunks.push(chunk);
      expect(chunks.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
      return chunks;
    };
    return { name, root, manager, provider, records, canaries, send };
  });
  cleanups.push(async () => {
    const closed = [...children].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 2500); child.once('close', () => { clearTimeout(timer); resolve(); });
    }));
    instances.forEach(window => window.manager.dispose()); await Promise.all(closed);
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: originalFolders });
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return instances;
}

describe('PC-09 independent managers with colliding panel and native IDs', () => {
  it('concurrent Allow and Deny reach only the captured window process and workspace', async () => {
    const [a, b] = windows();
    const seenA = deferred<NativeApprovalRequest>(), seenB = deferred<NativeApprovalRequest>();
    const allowA = deferred<boolean>(), allowB = deferred<boolean>();
    a.manager.setNativeApprovalHandler(async request => { seenA.resolve(request); return allowA.promise; });
    b.manager.setNativeApprovalHandler(async request => { seenB.resolve(request); return allowB.promise; });
    const runA = a.send('A-only-nonce'); const cardA = await seenA.promise;
    const runB = b.send('B-only-nonce'); const cardB = await seenB.promise;
    expect(cardA.panelId).toBe('sidebar'); expect(cardB.panelId).toBe('sidebar');
    expect(cardA.nativeRequestId).toBe(77); expect(cardB.nativeRequestId).toBe(77);
    expect(cardA.toolCall.id).toBe(cardB.toolCall.id); expect(cardA.id).not.toBe(cardB.id);
    allowA.resolve(true); allowB.resolve(false);
    const [answerA, answerB] = await Promise.all([runA, runB]);
    expect(answerA.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('allowed:A-only-nonce');
    expect(answerB.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('denied:B-only-nonce');
    expect(a.canaries().map(row => row.prompt)).toEqual(['A-only-nonce']); expect(b.canaries()).toEqual([]);
    expect(a.provider.getSessionId('sidebar')).toBe('same-native-thread');
    expect(b.provider.getSessionId('sidebar')).toBe('same-native-thread');
    a.manager.clearSession('sidebar', { allProviders: true });
    expect(a.provider.hasSession('sidebar')).toBe(false); expect(b.provider.hasSession('sidebar')).toBe(true);
  });

  it('Stop, late Allow, replacement and manager disposal cannot cancel another window with identical native IDs', async () => {
    const [a, b] = windows(); const seenA = deferred<NativeApprovalRequest>(), seenB = deferred<NativeApprovalRequest>();
    const allowA = deferred<boolean>(), allowB = deferred<boolean>();
    a.manager.setNativeApprovalHandler(async request => { seenA.resolve(request); return allowA.promise; });
    b.manager.setNativeApprovalHandler(async request => { seenB.resolve(request); return allowB.promise; });
    const runA = a.send('stopped-A'); const oldCard = await seenA.promise;
    const runB = b.send('surviving-B'); const siblingCard = await seenB.promise;
    a.manager.cancelRequest('sidebar'); await runA;
    expect(oldCard.signal.aborted).toBe(true); expect(siblingCard.signal.aborted).toBe(false);
    const replacementSeen = deferred<NativeApprovalRequest>(), replacementDecision = deferred<boolean>();
    a.manager.setNativeApprovalHandler(async request => { replacementSeen.resolve(request); return replacementDecision.promise; });
    const nextA = a.send('replacement-A'); const replacementCard = await replacementSeen.promise;
    expect(replacementCard.id).not.toBe(oldCard.id); allowA.resolve(true);
    a.manager.dispose(); await nextA;
    expect(replacementCard.signal.aborted).toBe(true); expect(siblingCard.signal.aborted).toBe(false);
    replacementDecision.resolve(true); allowB.resolve(true); await runB;
    expect(a.canaries()).toEqual([]); expect(b.canaries().map(row => row.prompt)).toEqual(['surviving-B']);
    expect(b.records().filter(row => row.event === 'spawn')).toHaveLength(1);
  });

  it('250 controlled turns keep colliding native IDs, nonces and canary writes in their owning manager', async () => {
    const all = windows(); const cards: NativeApprovalRequest[] = [];
    for (const window of all) window.manager.setNativeApprovalHandler(async request => { cards.push(request); return true; });
    for (let index = 0; index < 250; index++) {
      const owner = all[index % 2]; const nonce = `${owner.name}-turn-${index}`;
      const response = await owner.send(nonce);
      expect(response.filter(c => c.type === 'text').map(c => c.content).join('')).toBe(`allowed:${nonce}`);
      expect(response.filter(c => c.type === 'done')).toHaveLength(1);
    }
    expect(cards).toHaveLength(250); expect(new Set(cards.map(card => card.id)).size).toBe(250);
    expect(new Set(cards.map(card => card.nativeRequestId))).toEqual(new Set([77]));
    for (const owner of all) {
      expect(owner.canaries()).toHaveLength(125);
      expect(owner.canaries().every(row => row.prompt.startsWith(owner.name))).toBe(true);
      expect(owner.records().filter(row => row.event === 'spawn')).toHaveLength(1);
      expect(owner.records().filter(row => row.event === 'turn')).toHaveLength(125);
      expect((owner.manager as any)._nativeApprovalTurns.size).toBe(0);
      expect((owner.provider as any)._requests.has(owner.provider._getSession('sidebar'))).toBe(false);
      expect(owner.provider._panelSessions.size).toBe(1);
      expect((owner.manager as any)._activePanelProcesses.size).toBe(1);
    }
  }, 15000);
});
