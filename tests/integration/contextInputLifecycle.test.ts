import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as contextFileReader from '../../src/services/ContextFileReader';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ContextManager } from '../../src/managers/ContextManager';
import { createMockMemento } from '../helpers/mockVscode';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Context input routes retain their original panel and operation lifetime', () => {
  let directory: string, first: string, second: string;
  let manager: ContextManager, host: any, panels: Map<string, any>;
  let store: ReturnType<typeof createMockMemento>;
  let originalPicker: unknown;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-context-input-'));
    first = path.join(directory, 'a.ts'); second = path.join(directory, 'b.ts');
    fs.writeFileSync(first, 'first context 🧪'); fs.writeFileSync(second, 'second context العربية');
    store = createMockMemento();
    originalPicker = (vscode.window as any).showOpenDialog;
    (vscode.window as any).showOpenDialog = vi.fn();
    manager = new ContextManager({ workspaceState: store } as unknown as vscode.ExtensionContext);
    panels = new Map(['sidebar', 'owner', 'sibling'].map(id => [id, {
      id, currentConversationId: 'conversation-' + id, navigationRevision: 0,
      panel: { active: id === 'owner' }, webview: { postMessage: vi.fn(async () => true) },
    }]));
    host = Object.assign(Object.create(ChatViewProvider.prototype), {
      _contextManager: manager, _panelStates: panels, _sidebarId: 'sidebar',
      _lastActivePanelId: 'owner', _mirrorToHub: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPicker === undefined) delete (vscode.window as any).showOpenDialog;
    else (vscode.window as any).showOpenDialog = originalPicker;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function holdFile(file: string) {
    const started = deferred<void>(), release = deferred<void>();
    const original = contextFileReader.readContextFileText.bind(contextFileReader);
    vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation(async (target, options) => {
      if (String(target) === file) { started.resolve(); await release.promise; }
      return original(target, options);
    });
    return { started, release };
  }

  function changeOwner(change: string) {
    const owner = panels.get('owner');
    if (change === 'clear') manager.clearContext('owner');
    else if (change === 'close') { panels.delete('owner'); manager.clearPanelContext('owner'); }
    else if (change === 'conversation') owner.currentConversationId = 'successor';
    else if (change === 'navigation') owner.navigationRevision++;
    else panels.set('owner', { ...owner, webview: { postMessage: vi.fn(async () => true) } });
  }

  function expectNoLateContext(oldOwner: any, change: string) {
    if (change === 'close') expect((manager as any)._panelContexts.has('owner')).toBe(false);
    expect((manager as any)._panelContexts.has('default')).toBe(false);
    expect(manager.formatContextForPrompt('owner')).toBe('');
    expect(manager.getContext('sibling')).toEqual([]);
    expect(oldOwner.webview.postMessage).not.toHaveBeenCalled();
    if (panels.has('owner')) expect(panels.get('owner').webview.postMessage).not.toHaveBeenCalled();
    if (change === 'close') expect(store._store.has('mysti.context:owner')).toBe(false);
    else expect(store._store.get('mysti.context:owner') ?? []).toEqual([]);
  }

  for (const type of ['file', 'folder']) {
    for (const change of ['close', 'conversation', 'navigation', 'replacement']) {
      it(`${type} webview input cannot commit or notify after ${change}`, async () => {
        const held = holdFile(first), oldOwner = panels.get('owner');
        const pending = host._handleMessage({ type: 'addToContext', panelId: 'owner', payload: { type, path: type === 'file' ? first : directory } });
        await held.started.promise; changeOwner(change); held.release.resolve(); await pending;
        expectNoLateContext(oldOwner, change);
      });
    }
  }

  for (const change of ['clear', 'close', 'conversation', 'navigation', 'replacement']) {
    it(`file picker opened before ${change} cannot add its late result`, async () => {
      const picked = deferred<vscode.Uri[] | undefined>(), oldOwner = panels.get('owner');
      vi.spyOn(vscode.window, 'showOpenDialog').mockReturnValueOnce(picked.promise);
      const pending = host._handleMessage({ type: 'addContextFile', panelId: 'owner' });
      changeOwner(change); picked.resolve([vscode.Uri.file(first), vscode.Uri.file(second)]); await pending;
      expectNoLateContext(oldOwner, change);
    });
  }

  for (const route of ['drop', 'picker']) {
    it(`Clear during a ${route} batch stops the remaining files and a later add works`, async () => {
      const held = holdFile(first), oldOwner = panels.get('owner');
      vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValueOnce([vscode.Uri.file(first), vscode.Uri.file(second)]);
      const pending = host._handleMessage(route === 'drop'
        ? { type: 'addContextPaths', panelId: 'owner', payload: [first, second] }
        : { type: 'addContextFile', panelId: 'owner' });
      await held.started.promise; manager.clearContext('owner'); held.release.resolve(); await pending;
      expectNoLateContext(oldOwner, 'clear');
      await host._handleMessage({ type: 'addContextPaths', panelId: 'owner', payload: [second] });
      expect(manager.getContext('owner').map(item => item.path)).toEqual([second]);
      expect(manager.formatContextForPrompt('owner')).toContain('second context العربية');
    });
  }

  it('an Explorer folder URI adds its files only to the selected chat', async () => {
    await host.addToContext(vscode.Uri.file(directory));
    expect(manager.getContext('owner').map(item => item.path)).toEqual([first, second]);
    expect(manager.formatContextForPrompt('owner')).toContain('first context 🧪');
    expect(manager.formatContextForPrompt('owner')).toContain('second context العربية');
    expect(manager.getContext('sidebar')).toEqual([]); expect(manager.getContext('sibling')).toEqual([]);
    expect(panels.get('owner').webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'contextUpdated', payload: manager.getContext('owner') });
  });

  it('a dropped folder reaches folder expansion and preserves Unicode file content', async () => {
    await host._handleMessage({ type: 'addContextPaths', panelId: 'owner', payload: [directory] });
    expect(manager.getContext('owner').map(item => item.path)).toEqual([first, second]);
    expect(manager.formatContextForPrompt('owner')).toContain('second context العربية');
    expect(manager.getContext('sibling')).toEqual([]);
    expect(panels.get('owner').webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'contextUpdated', payload: manager.getContext('owner') });
  });

  it('a picker keeps its original owner when focus moves to a sibling', async () => {
    const picked = deferred<vscode.Uri[] | undefined>();
    vi.spyOn(vscode.window, 'showOpenDialog').mockReturnValueOnce(picked.promise);
    const pending = host._handleMessage({ type: 'addContextFile', panelId: 'owner' });
    panels.get('owner').panel.active = false; panels.get('sibling').panel.active = true;
    picked.resolve([vscode.Uri.file(first)]); await pending;
    expect(manager.getContext('owner').map(item => item.path)).toEqual([first]);
    expect(manager.getContext('sibling')).toEqual([]);
    expect(panels.get('sibling').webview.postMessage).not.toHaveBeenCalled();
  });

  for (const route of ['Explorer stat', 'picker', 'cancelled picker']) {
    it(`saved context completing during ${route} preserves both restoration and the user's choice`, async () => {
      store._store.set('mysti.context:owner', [{ id: 'saved', type: 'file', path: first, enabled: true }]);
      const held = holdFile(first);
      const restore = manager.restorePanelContext('owner');
      await held.started.promise;
      const picked = deferred<vscode.Uri[] | undefined>();
      const statStarted = deferred<void>(), statRelease = deferred<void>();
      const stat = fs.promises.stat.bind(fs.promises);
      vi.spyOn(fs.promises, 'stat').mockImplementation(async (file, options) => {
        if (route === 'Explorer stat' && String(file) === second) {
          statStarted.resolve(); await statRelease.promise;
        }
        return stat(file, options);
      });
      vi.spyOn(vscode.window, 'showOpenDialog').mockReturnValueOnce(picked.promise);
      const pending = route === 'Explorer stat'
        ? host.addToContext(vscode.Uri.file(second))
        : host._handleMessage({ type: 'addContextFile', panelId: 'owner' });
      if (route === 'Explorer stat') await statStarted.promise;
      held.release.resolve(); await restore;
      statRelease.resolve(); picked.resolve(route === 'cancelled picker' ? undefined : [vscode.Uri.file(second)]);
      await pending;
      expect(manager.getContext('owner').map(item => item.path)).toEqual(route === 'cancelled picker' ? [first] : [first, second]);
      expect(manager.formatContextForPrompt('owner')).toContain('first context 🧪');
      expect(manager.getContext('sibling')).toEqual([]);
      if (route === 'cancelled picker') expect(panels.get('owner').webview.postMessage).not.toHaveBeenCalled();
      else expect(manager.formatContextForPrompt('owner')).toContain('second context العربية');
    });
  }
});
