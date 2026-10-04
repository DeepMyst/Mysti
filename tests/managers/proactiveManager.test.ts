import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
const host = vi.hoisted(() => ({ observe: vi.fn(), request: vi.fn(), posted: vi.fn(), toast: vi.fn(), open: vi.fn(), changed: undefined as any, message: undefined as any, signedIn: false, trusted: true }));
vi.mock('vscode', () => ({
  Uri: { joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/'), toString() { return this.fsPath; } }), parse: (value: string) => value },
  ViewColumn: { Active: 1 },
  workspace: { get isTrusted() { return host.trusted; }, workspaceFolders: [{ name: 'repo', uri: { scheme: 'file', fsPath: '/repo' } }] },
  window: { createWebviewPanel: () => ({ reveal: vi.fn(), dispose: vi.fn(), onDidDispose: vi.fn(), webview: { cspSource: 'test', asWebviewUri: (uri: any) => uri, postMessage: host.posted, onDidReceiveMessage: (cb: any) => { host.message = cb; return { dispose() {} }; } } }), showInformationMessage: host.toast },
  env: { openExternal: host.open }, commands: { executeCommand: vi.fn() },
}));
vi.mock('../../src/services/proactive/LocalRepository', async original => ({ ...await original<any>(), observeRepository: host.observe }));
vi.mock('../../src/services/proactive/ProactiveClient', () => ({ ProactiveClient: class { request(...args: any[]) { return host.request(...args); } } }));
import { ProactiveManager } from '../../src/managers/ProactiveManager';
const snapshot = { head: 'a', branch: 'main', behind: 1, ahead: 0, overlap: ['file'], dirty: ['file'], upstream: 'refs/remotes/origin/main', upstreamHead: 'b', observedAt: '2026-10-01T09:00:00Z' };
const emptyCloud = { available: true, read_only: false, responsibilities: [], connections: [], insights: [] };
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('proactive lifecycle and authorization boundaries', () => {
  let manager: any, state: any;
  const create = (watches: any[] = [], notifications = false) => {
    state = { watches, notifications, daily: { day: '', count: 0 }, notified: [] };
    const context = { extensionUri: { fsPath: path.resolve('.') }, workspaceState: { get: () => state, update: vi.fn(async (_key, value) => { state = value; }) } };
    const auth = { onDidChangeAuth: (cb: any) => { host.changed = cb; return { dispose() {} }; }, isSignedIn: () => host.signedIn, getApiKey: () => 'key', getApiUrl: () => 'https://api.v2.deepmyst.com' };
    manager = new ProactiveManager(context as any, auth as any); return manager;
  };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 1, 9)); host.observe.mockReset().mockResolvedValue(snapshot); host.request.mockReset().mockResolvedValue(emptyCloud); host.posted.mockReset(); host.toast.mockReset().mockResolvedValue(undefined); host.open.mockReset(); host.signedIn = false; host.trusted = true; });
  afterEach(() => { manager?.dispose(); vi.useRealTimers(); });
  it('does not monitor before opt-in or in an untrusted workspace', async () => {
    create(); await manager._refresh(); expect(host.observe).not.toHaveBeenCalled(); expect(host.request).not.toHaveBeenCalled();
    state.watches.push({ root: '/repo', active: true, insights: [] }); host.trusted = false;
    await manager._refresh(); expect(host.observe).not.toHaveBeenCalled(); expect(state.watches[0].health).toContain('trusted');
  });
  it('drops an in-flight observation after pause or removal', async () => {
    const waiting = deferred(); host.observe.mockReturnValue(waiting.promise);
    create([{ root: '/repo', active: true, insights: [] }]);
    await manager._handle({ type: 'localState', id: '/repo', active: false });
    waiting.resolve(snapshot); await manager._refresh();
    expect(state.watches[0].insights).toEqual([]);
    expect(state.watches[0].snapshot).toBeUndefined();
    await manager._handle({ type: 'removeLocal', id: '/repo' }); expect(state.watches).toEqual([]);
  });
  it('persists deduplication and reserves a notification before delivery', async () => {
    create([{ root: '/repo', name: 'repo', active: true, insights: [] }], true);
    await manager._refresh(); await manager._refresh();
    expect(state.watches[0].insights).toHaveLength(1);
    expect(host.toast).toHaveBeenCalledTimes(1);
    expect(state.daily.count).toBe(1); expect(state.notified).toHaveLength(1);
    await manager._handle({ type: 'markLocal', root: '/repo', id: state.watches[0].insights[0].id, state: 'dismissed' });
    await manager._refresh(); expect(state.watches[0].insights[0].state).toBe('dismissed');
  });
  it('clears cloud evidence on sign-out and discards the previous account response', async () => {
    const waiting = deferred(); host.signedIn = true; host.request.mockReturnValue(waiting.promise);
    create(); manager.open();
    host.signedIn = false; host.changed();
    waiting.resolve({ ...emptyCloud, insights: [{ id: 'private-old-account' }] });
    await manager._refresh();
    expect(manager._cloud).toBeUndefined();
    expect(host.posted.mock.calls.at(-1)[0].cloud).toBeUndefined();
  });
  it('opens only stored HTTPS evidence on approved source hosts', async () => {
    host.signedIn = true; host.request.mockResolvedValue({ ...emptyCloud, insights: [{ id: 'evil', state: 'read', evidence: { url: 'https://evil.test/steal' } }, { id: 'good', state: 'read', evidence: { url: 'https://github.com/org/repo/pull/1' } }] });
    create(); await manager._refresh();
    await manager._handle({ type: 'evidence', id: 'unknown', url: 'https://evil.test' });
    await manager._handle({ type: 'evidence', id: 'evil' });
    expect(host.open).not.toHaveBeenCalled();
    await manager._handle({ type: 'evidence', id: 'good' });
    expect(host.open).toHaveBeenCalledWith('https://github.com/org/repo/pull/1');
  });
  it('refreshes task evidence without uploading or persisting the task summary', async () => {
    host.signedIn = true;
    host.request.mockResolvedValue({ ...emptyCloud, responsibilities: [{ id: 'r', title: 'Task', state: 'active', health: 'Checked', last_checked_at: snapshot.observedAt }], insights: [] });
    create(); await manager._refresh();
    await manager._handle({ type: 'taskBriefing', requestId: 1, id: 'r', summary: 'private task summary' });
    expect(manager._briefing.responsibilityId).toBe('r');
    expect(host.request.mock.calls.every(args => args.length === 0)).toBe(true);
    expect(JSON.stringify(state)).not.toContain('private task summary');
    host.signedIn = false; host.changed();
    expect(manager._briefing).toBeUndefined();
  });

});
