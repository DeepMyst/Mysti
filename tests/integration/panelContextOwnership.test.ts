import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as contextFileReader from '../../src/services/ContextFileReader';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ContextManager } from '../../src/managers/ContextManager';
import { EditorContextTracker } from '../../src/chat/EditorContextTracker';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

// Exercise the shipped command adapters without activating unrelated paid CLI,
// telemetry or network services. AST extraction uses the actual callback source,
// then connects it to the real host prototype and ContextManager below.
const source = ts.createSourceFile('extension.ts', fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function command(name: string, host: any, contextManager: ContextManager): (...args: any[]) => any {
  let callback: ts.Expression | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.commands.registerCommand'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) callback = node.arguments[1];
    ts.forEachChild(node, walk);
  };
  walk(source); expect(callback, name).toBeDefined();
  const js = ts.transpileModule('const callback = ' + callback!.getText(source) + ';', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('vscode', 'chatViewProvider', 'contextManager', js + '\nreturn callback;')(vscode, host, contextManager);
}
function deferred() { let resolve!: (value: string) => void; const promise = new Promise<string>(done => { resolve = done; }); return { promise, resolve }; }

describe('PC-09 public context commands and detached panel ownership', () => {
  let directory: string, file: string, contextManager: ContextManager, host: any;
  let panels: Map<string, any>, store: Map<string, unknown>, created: any[];
  const mutableWindow = vscode.window as any;
  let originalCreate: any, originalEditor: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-panel-context-')); file = path.join(directory, 'owned.ts'); fs.writeFileSync(file, 'export const owner = 1;');
    store = new Map();
    contextManager = new ContextManager({ workspaceState: { get: (key: string) => store.get(key), keys: () => [...store.keys()],
      update: async (key: string, value: unknown) => { if (value === undefined) store.delete(key); else store.set(key, value); } } } as any);
    panels = new Map(['sidebar', 'a', 'b'].map(id => [id, { id, currentConversationId: 'conversation-' + id,
      panel: id === 'sidebar' ? undefined : { active: id === 'a' }, webview: { postMessage: vi.fn(async () => true) } }]));
    created = []; originalCreate = mutableWindow.createWebviewPanel; originalEditor = mutableWindow.activeTextEditor;
    mutableWindow.activeTextEditor = undefined;
    mutableWindow.createWebviewPanel = vi.fn(() => {
      for (const value of panels.values()) if (value.panel) value.panel.active = false;
      const panel = { active: true, webview: { onDidReceiveMessage: vi.fn(), postMessage: vi.fn() },
        onDidDispose: (callback: () => void) => { (panel as any).close = callback; } };
      created.push(panel); return panel;
    });
    let conversation = 0;
    host = Object.assign(Object.create(ChatViewProvider.prototype), {
      _panelStates: panels, _contextManager: contextManager, _sidebarId: 'sidebar', _lastActivePanelId: 'sidebar',
      _editorContextTracker: new EditorContextTracker(vscode.window),
      _extensionUri: vscode.Uri.file(directory), _extensionContext: { extension: { packageJSON: { version: '0.0.0' } } },
      _conversationManager: { createNewConversation: () => ({ id: 'new-' + ++conversation }) },
      _sendInitialState: vi.fn(), _tryPreSpawnPersistentProcess: vi.fn(), _mirrorToHub: vi.fn(),
      _cancelPanelSetup: vi.fn(), _unbindHubFrom: vi.fn(), _cancelQueuedChannelTurn: vi.fn(), _cancelPendingSubAgentQuestions: vi.fn(),
      _modelCliUpgrades: new Map(), _lastUserMessage: new Map(), _lastSendSettings: new Map(), _lastMentionContext: new Map(),
      _cancelledPanels: new Set(), _runningPanels: new Set(), _pendingPlanSelections: new Set(), _panelAutonomyLevel: new Map(),
      _mystiRunGen: new Map(), _brainstormPreparations: new Map(), _mystiAbortControllers: new Map(), _vtNonces: new Map(), _vtScanners: new Map(),
      _providerManager: { cancelRequest: vi.fn(), getAllProviders: () => [] }, _backgroundJobManager: { listRunning: () => [] },
      _abortMystiDirect: vi.fn(), _channelBridge: { clearPanel: vi.fn() }, _brainstormManager: { cancelSession: vi.fn(), clearSession: vi.fn() },
      _collaborationManager: { cancelPanel: vi.fn() }, _visualTestManager: { disposePanel: vi.fn() },
      _compactionManager: { resetUsage: vi.fn() }, _pendingPlans: { clearPanel: vi.fn() },
    });
  });
  afterEach(() => {
    host._editorContextTracker.dispose();
    mutableWindow.createWebviewPanel = originalCreate; mutableWindow.activeTextEditor = originalEditor;
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const type of ['contextUpdated', 'conversationHistory', 'settingsChanged', 'providerChanged']) it(`explicit ${type} target is never widened to sibling webviews`, async () => {
    const message = { type, payload: { owner: 'a' } }; host.postMessage(message, 'a');
    expect(panels.get('a').webview.postMessage).toHaveBeenCalledExactlyOnceWith(message);
    expect(panels.get('b').webview.postMessage).not.toHaveBeenCalled(); expect(panels.get('sidebar').webview.postMessage).not.toHaveBeenCalled();
    expect(host._mirrorToHub).toHaveBeenCalledExactlyOnceWith('a', message);
  });

  it('an untargeted shared catalogue remains a deliberate broadcast', () => {
    const message = { type: 'modelsUpdated', payload: { provider: 'claude-code', models: [] } }; host.postMessage(message);
    for (const panel of panels.values()) expect(panel.webview.postMessage).toHaveBeenCalledExactlyOnceWith(message);
    expect(host._mirrorToHub).toHaveBeenCalledExactlyOnceWith(null, message);
  });

  for (const owner of ['active editor', 'bound hub', 'last chat', 'sidebar']) it(`Add to Context follows the ${owner} and leaves sibling and default buckets unchanged`, async () => {
    let id = 'a';
    if (owner !== 'active editor') panels.get('a').panel.active = false;
    if (owner === 'bound hub') { host._hub = { panel: { active: true }, originPanelId: 'b' }; id = 'b'; }
    if (owner === 'last chat') { host._lastActivePanelId = 'b'; id = 'b'; }
    if (owner === 'sidebar') host._lastActivePanelId = 'closed-panel';
    if (owner === 'sidebar') id = 'sidebar';
    await command('mysti.addToContext', host, contextManager)(vscode.Uri.file(file));
    expect(contextManager.getContext(id)).toEqual([expect.objectContaining({ type: 'file', path: file, content: 'export const owner = 1;' })]);
    for (const other of ['sidebar', 'a', 'b', 'default'].filter(value => value !== id)) expect(contextManager.getContext(other)).toEqual([]);
    expect(panels.get(id).webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'contextUpdated', payload: contextManager.getContext(id) });
    for (const [other, panel] of panels) if (other !== id) expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('selection command retains exact selected bytes, line range and language in the last focused chat', async () => {
    panels.get('a').panel.active = false; host._lastActivePanelId = 'b';
    mutableWindow.activeTextEditor = { selection: { isEmpty: false, start: { line: 4 }, end: { line: 7 } },
      document: { uri: vscode.Uri.file(file), languageId: 'typescript', getText: () => 'selected\nbytes 🧪' } };
    await command('mysti.addToContext', host, contextManager)();
    expect(contextManager.getContext('b')).toEqual([expect.objectContaining({ type: 'selection', content: 'selected\nbytes 🧪', startLine: 4, endLine: 7, language: 'typescript' })]);
    expect(contextManager.getContext('default')).toEqual([]); expect(panels.get('a').webview.postMessage).not.toHaveBeenCalled();
  });

  it('Clear Context removes only the active owner and its persisted bucket', async () => {
    for (const id of ['sidebar', 'a', 'b', 'default']) await contextManager.addFileToContext(file, id);
    await command('mysti.clearContext', host, contextManager)();
    expect(contextManager.getContext('a')).toEqual([]); expect(store.get('mysti.context:a')).toEqual([]);
    for (const id of ['sidebar', 'b', 'default']) expect(contextManager.getContext(id)).toHaveLength(1);
    expect(panels.get('a').webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'contextUpdated', payload: [] });
    expect(panels.get('b').webview.postMessage).not.toHaveBeenCalled();
  });

  it('a delayed file read stays with its original owner when focus moves to a sibling', async () => {
    const gate = deferred(); vi.spyOn(contextFileReader, 'readContextFileText').mockReturnValueOnce(gate.promise as any);
    const pending = command('mysti.addToContext', host, contextManager)(vscode.Uri.file(file));
    panels.get('a').panel.active = false; panels.get('b').panel.active = true;
    gate.resolve('owned slow read'); await pending;
    expect(contextManager.getContext('a')[0]?.content).toBe('owned slow read'); expect(contextManager.getContext('b')).toEqual([]);
    expect(panels.get('b').webview.postMessage).not.toHaveBeenCalled();
  });

  it('concurrent Add to Context commands for one file retain a single owned item', async () => {
    const first = deferred(), second = deferred();
    vi.spyOn(contextFileReader, 'readContextFileText').mockReturnValueOnce(first.promise as any).mockReturnValueOnce(second.promise as any);
    const add = command('mysti.addToContext', host, contextManager);
    const one = add(vscode.Uri.file(file)), two = add(vscode.Uri.file(file));
    first.resolve('first read'); await one; second.resolve('second read'); await two;
    expect(contextManager.getContext('a')).toHaveLength(1);
    expect(contextManager.getContext('a')[0].content).toBe('first read');
  });

  for (const change of ['close', 'clear', 'new conversation', 'replace panel']) it(`a file read completing after ${change} cannot reintroduce old context or notify a successor`, async () => {
    const gate = deferred(); vi.spyOn(contextFileReader, 'readContextFileText').mockReturnValueOnce(gate.promise as any);
    const old = panels.get('a'); const pending = command('mysti.addToContext', host, contextManager)(vscode.Uri.file(file));
    if (change === 'close') { panels.delete('a'); contextManager.clearPanelContext('a'); }
    else if (change === 'clear') contextManager.clearContext('a');
    else if (change === 'new conversation') old.currentConversationId = 'successor';
    else panels.set('a', { ...old, webview: { postMessage: vi.fn() } });
    gate.resolve('STALE_FILE_BYTES'); await pending;
    // Inspect the real manager map without creating a fresh bucket as getContext would.
    expect((contextManager as any)._panelContexts.get('a') || []).toEqual([]);
    expect(contextManager.getContext('default')).toEqual([]);
    expect(old.webview.postMessage).not.toHaveBeenCalled();
    if (panels.has('a')) expect(panels.get('a').webview.postMessage).not.toHaveBeenCalled();
    if (change === 'close') expect(store.has('mysti.context:a')).toBe(false);
  });

  it('Add to Context opens one owned chat when no panel exists instead of using a hidden global bucket', async () => {
    panels.clear(); await command('mysti.addToContext', host, contextManager)(vscode.Uri.file(file));
    expect(created).toHaveLength(1); expect(panels.size).toBe(1);
    const id = [...panels.keys()][0]; expect(contextManager.getContext(id)[0]?.path).toBe(file); expect(contextManager.getContext('default')).toEqual([]);
  });

  it('two tabs opened during the same millisecond retain independent identities, conversations and disposal', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const before = new Set(panels.keys()); host.openInNewTab(); host.openInNewTab();
    const ids = [...panels.keys()].filter(id => !before.has(id));
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
    expect(panels.get(ids[0]).currentConversationId).not.toBe(panels.get(ids[1]).currentConversationId);
    created[0].close();
    expect(panels.has(ids[0])).toBe(false); expect(panels.has(ids[1])).toBe(true);
    expect(host._providerManager.cancelRequest).toHaveBeenCalledExactlyOnceWith(ids[0]);
  });
});
