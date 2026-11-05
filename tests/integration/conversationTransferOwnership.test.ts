import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ConversationManager } from '../../src/managers/ConversationManager';

vi.mock('vscode', async () => {
  const base = await vi.importActual<any>('../helpers/mockVscode');
  return { ...base, env: { ...base.env, clipboard: { writeText: vi.fn(async () => {}) } },
    window: { ...base.window, showSaveDialog: vi.fn(), showOpenDialog: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
    workspace: { ...base.workspace, fs: { readFile: vi.fn(), writeFile: vi.fn(async () => {}) } },
  };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const store = new Map<string, unknown>();
  const manager = new ConversationManager({ globalState: {
    get: (key: string) => store.get(key),
    update: async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); },
  } } as any);
  const source = manager.getCurrentConversation()!;
  manager.addMessageToConversation(source.id, 'user', 'Export Café 🧪 with exact CRLF\r\nand a literal <script> tag');
  const answer = manager.addMessageToConversation(source.id, 'assistant', 'A **Markdown** answer.');
  const other = manager.createNewConversation(); manager.addMessageToConversation(other.id, 'user', 'SIBLING_ONLY');
  const panels = new Map(['a', 'b'].map(id => [id, { id, currentConversationId: id === 'a' ? source.id : other.id, webview: {}, navigationRevision: 0 }]));
  const providers = { clearSession: vi.fn(), cancelRequest: vi.fn(), getAllProviderIds: () => [] };
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: panels, _conversationManager: manager, _providerManager: providers,
    _mystiRunGen: new Map(), _cancelledPanels: new Set(), _runningPanels: new Set(['a', 'b']),
    _dictationManager: { cancelPanel: vi.fn(async () => {}) },
    _delayedChannelTurns: { cancelPanel: vi.fn() }, _channelBridge: { clearQueuedMessages: vi.fn() },
    _brainstormManager: { cancelSession: vi.fn(), clearSession: vi.fn() },
    _collaborationManager: { cancelPanel: vi.fn() }, _sessionManager: { cancelPanel: vi.fn() },
    _mentionRouter: { cancelSubAgents: vi.fn() }, _subAgentQuestions: { cancelPanel: vi.fn() },
    _pendingPlans: { clearPanel: vi.fn() }, _pendingPlanSelections: new Set(),
    _permissionManager: { clearSessionUpgrade: vi.fn() }, _lifecycleManager: { markIdle: vi.fn(), removeSession: vi.fn() },
    _compactionManager: { resetUsage: vi.fn() }, _engagementManager: { trackConversationShared: () => [], trackExport: () => [], trackConversationStarted: () => [] },
    _abortMystiDirect: vi.fn(), _emitBadgeUnlocks: vi.fn(), _postToPanel: vi.fn(), postMessage: vi.fn(),
  });
  let sequence = 0;
  const action = (type: string, payload: any = {}, panelId = 'a') => host._handleMessage({ type, panelId,
    payload: { requestId: `request-${++sequence}`, conversationId: panels.get(panelId)?.currentConversationId, ...payload } });
  return { host, manager, source, other, answer, panels, providers, action, store };
}
const importedText = JSON.stringify({ messages: [{ role: 'user', content: 'IMPORTED_ONLY' }, { role: 'assistant', content: 'Archived answer' }] });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file('/owned/conversation.json')]);
  vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/owned/export.json'));
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(importedText));
  vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
  vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('PC-11 conversation transfer ownership and result honesty', () => {
  it('imports into only the originating panel, cancels its native history and preserves sibling work', async () => {
    const h = harness(); const source = JSON.stringify(h.source), sibling = JSON.stringify(h.other);
    await h.action('importFromFile');
    const current = h.panels.get('a')!.currentConversationId;
    expect(current).not.toBe(h.source.id);
    expect(h.manager.getConversation(current)!.messages[0].content).toBe('IMPORTED_ONLY');
    expect(h.providers.clearSession).toHaveBeenCalledWith('a', { allProviders: true });
    expect(h.providers.cancelRequest).toHaveBeenCalledExactlyOnceWith('a');
    expect(h.host._mystiRunGen.get('a')).toBeGreaterThan(0);
    expect(h.host._runningPanels.has('a')).toBe(false); expect(h.host._runningPanels.has('b')).toBe(true);
    expect(JSON.stringify(h.source)).toBe(source); expect(JSON.stringify(h.other)).toBe(sibling);
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'conversationChanged', payload: h.manager.getConversation(current) });
    expect(h.host.postMessage).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'read'] as const)('a delayed import %s cannot replace a newer conversation or create an orphan', async stage => {
    const h = harness(); const wait = deferred<any>();
    if (stage === 'dialog') vi.mocked(vscode.window.showOpenDialog).mockReturnValueOnce(wait.promise);
    else vi.mocked(vscode.workspace.fs.readFile).mockReturnValueOnce(wait.promise);
    const pending = h.action('importFromFile');
    if (stage === 'read') await vi.waitFor(() => expect(vscode.workspace.fs.readFile).toHaveBeenCalledOnce());
    await h.host._handleSwitchConversation('a', h.other.id);
    const before = JSON.stringify(h.manager.getAllConversations()); h.host._postToPanel.mockClear(); h.providers.cancelRequest.mockClear();
    wait.resolve(stage === 'dialog' ? [vscode.Uri.file('/owned/conversation.json')] : Buffer.from(importedText)); await pending;
    expect(h.panels.get('a')!.currentConversationId).toBe(h.other.id);
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    expect(h.host._postToPanel).not.toHaveBeenCalled(); expect(h.providers.cancelRequest).not.toHaveBeenCalled();
  });

  it.each(['new turn', 'panel replacement', 'closed panel', 'source deleted'] as const)('%s invalidates an import before parsing', async action => {
    const h = harness(); const wait = deferred<any>(); vi.mocked(vscode.workspace.fs.readFile).mockReturnValueOnce(wait.promise);
    const pending = h.action('importFromFile'); await vi.waitFor(() => expect(vscode.workspace.fs.readFile).toHaveBeenCalledOnce());
    if (action === 'new turn') h.host._mystiRunGen.set('a', 42);
    else if (action === 'panel replacement') h.panels.set('a', { ...h.panels.get('a')! });
    else if (action === 'closed panel') h.panels.delete('a');
    else h.manager.deleteConversation(h.source.id);
    const before = JSON.stringify(h.manager.getAllConversations()); h.host._postToPanel.mockClear();
    wait.resolve(Buffer.from(importedText)); await pending;
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    if (action === 'new turn') {
      expect(h.host._postToPanel).toHaveBeenCalledExactlyOnceWith('a', { type: 'exportResult', payload: expect.objectContaining({ success: false, cancelled: true, requestId: 'request-1' }) });
    } else { expect(h.host._postToPanel).not.toHaveBeenCalled(); }
  });

  it.each(['cancel', 'unreadable', 'invalid'] as const)('import %s preserves the active turn and gives an accurate result', async result => {
    const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
    if (result === 'cancel') vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce(undefined);
    if (result === 'unreadable') vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error('Read denied'));
    if (result === 'invalid') vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from('{broken'));
    await expect(h.action('importFromFile')).resolves.toBeUndefined();
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before); expect(h.providers.cancelRequest).not.toHaveBeenCalled();
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'exportResult', payload: expect.objectContaining({
      requestId: 'request-1', conversationId: h.source.id, operation: 'import', success: false,
      ...(result === 'cancel' ? { cancelled: true } : { error: expect.any(String) }),
    }) });
  });

  it('cancels a superseded import request without leaving its own control pending', async () => {
    const h = harness(); const wait = deferred<any>(); vi.mocked(vscode.window.showOpenDialog).mockReturnValueOnce(wait.promise).mockResolvedValueOnce(undefined);
    const first = h.action('importFromFile'); await h.action('importFromFile');
    wait.resolve([vscode.Uri.file('/owned/conversation.json')]); await first;
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(h.host._postToPanel.mock.calls.map(([, message]: any) => message.payload)).toEqual([
      expect.objectContaining({ requestId: 'request-2', cancelled: true }), expect.objectContaining({ requestId: 'request-1', cancelled: true }),
    ]);
  });

  it('shows import format limitations after the destination conversation is rendered', async () => {
    const h = harness(); const markdown = h.manager.exportToMarkdown(h.source.id, true);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([vscode.Uri.file('/owned/transcript.md')]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(markdown));
    await h.action('importFromFile');
    const events = h.host._postToPanel.mock.calls.map(([, message]: any) => message);
    const changed = events.findIndex((message: any) => message.type === 'conversationChanged');
    const notice = events.findIndex((message: any) => message.type === 'conversationImportNotice');
    expect(changed).toBeGreaterThan(-1); expect(notice).toBeGreaterThan(changed);
    expect(events[notice].payload).toEqual({ conversationId: h.panels.get('a')!.currentConversationId, notice: expect.stringMatching(/Markdown|metadata/i) });
  });

  it('refuses to copy a share link for an empty conversation that cannot be imported', async () => {
    const h = harness(); const empty = h.manager.createNewConversation(); h.panels.get('a')!.currentConversationId = empty.id;
    await h.action('triggerShareLink');
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'exportResult', payload: expect.objectContaining({ success: false, error: expect.stringMatching(/message|empty/i) }) });
  });

  it.each(['json', 'jsonl', 'markdown', 'cancel'] as const)('import %s acknowledgement does not claim an unrelated export format', async format => {
    const h = harness();
    if (format === 'cancel') vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce(undefined);
    else {
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([vscode.Uri.file(`/owned/transcript.${format === 'markdown' ? 'md' : format}`)]);
      const text = format === 'markdown' ? h.manager.exportToMarkdown(h.source.id, true)
        : format === 'jsonl' ? JSON.stringify({ role: 'user', content: 'JSONL transcript' }) : importedText;
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(text));
    }
    await h.action('importFromFile');
    const result = h.host._postToPanel.mock.calls.find(([, message]: any) => message.type === 'exportResult')![1].payload;
    expect(result).toMatchObject({ operation: 'import', requestId: 'request-1', success: format !== 'cancel' });
    expect(result).not.toHaveProperty('format');
  });

  it('duplicate import delivery uses one dialog and creates one conversation', async () => {
    const h = harness(); const wait = deferred<any>(); vi.mocked(vscode.window.showOpenDialog).mockReturnValue(wait.promise);
    const payload = { requestId: 'same-import' };
    const one = h.action('importFromFile', payload), two = h.action('importFromFile', payload);
    wait.resolve([vscode.Uri.file('/owned/conversation.json')]); await Promise.all([one, two]);
    expect(vscode.window.showOpenDialog).toHaveBeenCalledOnce(); expect(h.manager.getAllConversations()).toHaveLength(3);
  });

  it.each(['exportConversation', 'copyMessageMarkdown', 'exportToFile', 'triggerShareLink', 'importFromFile'])(
    '%s refuses an explicit foreign conversation before IO', async type => {
      const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
      await h.action(type, { conversationId: h.other.id, messageId: h.answer.id });
      expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled(); expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
      expect(vscode.window.showOpenDialog).not.toHaveBeenCalled(); expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    },
  );

  it('copies exact code text from the new scoped request instead of its envelope', async () => {
    const h = harness(); const text = '\ufeffconst café = "🧪";\r\n\t// tail  \r\n';
    await h.action('copyToClipboard', { text });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'exportResult', payload: expect.objectContaining({ operation: 'copy', success: true, requestId: 'request-1', conversationId: h.source.id }) });
  });

  it.each(['copyToClipboard', 'copyMessageMarkdown', 'exportConversation', 'triggerShareLink'])(
    '%s reports clipboard rejection without throwing or claiming success', async type => {
      const h = harness(); vi.mocked(vscode.env.clipboard.writeText).mockRejectedValueOnce(new Error('Clipboard denied'));
      await expect(h.action(type, { text: 'test', messageId: h.answer.id })).resolves.toBeUndefined();
      expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'exportResult', payload: expect.objectContaining({ success: false, requestId: 'request-1', conversationId: h.source.id, error: 'Clipboard denied' }) });
      expect(h.host._postToPanel.mock.calls.some(([, message]: any) => message.payload?.success)).toBe(false);
    },
  );

  it('late clipboard acknowledgement cannot update a replacement chat', async () => {
    const h = harness(); const wait = deferred<void>(); vi.mocked(vscode.env.clipboard.writeText).mockReturnValueOnce(wait.promise);
    const pending = h.action('exportConversation'); await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledOnce());
    await h.host._handleSwitchConversation('a', h.other.id); h.host._postToPanel.mockClear();
    wait.resolve(); await pending; expect(h.host._postToPanel).not.toHaveBeenCalled();
  });

  it.each(['exportConversation', 'exportToFile'] as const)('%s completes across a new turn in the same visible conversation', async kind => {
    const h = harness(); const wait = deferred<any>();
    if (kind === 'exportToFile') vi.mocked(vscode.window.showSaveDialog).mockReturnValueOnce(wait.promise);
    else vi.mocked(vscode.env.clipboard.writeText).mockReturnValueOnce(wait.promise);
    const pending = h.action(kind);
    await vi.waitFor(() => expect(kind === 'exportToFile' ? vscode.window.showSaveDialog : vscode.env.clipboard.writeText).toHaveBeenCalledOnce());
    h.host._mystiRunGen.set('a', 45);
    wait.resolve(kind === 'exportToFile' ? vscode.Uri.file('/owned/export.json') : undefined); await pending;
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'exportResult', payload: expect.objectContaining({ success: true, requestId: 'request-1', conversationId: h.source.id }) });
  });

  it('acknowledges two different copy controls in the same chat and finishes with the latest text', async () => {
    const h = harness(); const wait = deferred<void>(); vi.mocked(vscode.env.clipboard.writeText).mockReturnValueOnce(wait.promise);
    const first = h.action('copyToClipboard', { text: 'first code block' });
    await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledOnce());
    const second = h.action('copyToClipboard', { text: 'second code block' });
    wait.resolve(); await Promise.all([first, second]);
    expect(vi.mocked(vscode.env.clipboard.writeText).mock.calls.map(([text]) => text)).toEqual(['first code block', 'second code block']);
    expect(h.host._postToPanel.mock.calls.map(([, event]: any) => event.payload.requestId)).toEqual(['request-1', 'request-2']);
  });

  it('serializes clipboard writes and skips a stale queued copy without losing the newest write', async () => {
    const h = harness(); const wait = deferred<void>(); vi.mocked(vscode.env.clipboard.writeText).mockReturnValueOnce(wait.promise);
    const first = h.action('copyToClipboard', { text: 'first' });
    await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledOnce());
    const second = h.action('copyToClipboard', { text: 'second' });
    await h.host._handleSwitchConversation('a', h.other.id); h.host._postToPanel.mockClear();
    const third = h.action('copyToClipboard', { text: 'third' });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
    wait.resolve(); await Promise.all([first, second, third]);
    expect(vi.mocked(vscode.env.clipboard.writeText).mock.calls.map(([text]) => text)).toEqual(['first', 'third']);
    expect(h.host._postToPanel).toHaveBeenCalledExactlyOnceWith('a', { type: 'exportResult', payload: expect.objectContaining({ success: true, requestId: 'request-3' }) });
  });

  it('a late save dialog never writes after the owner navigated away', async () => {
    const h = harness(); const wait = deferred<any>(); vi.mocked(vscode.window.showSaveDialog).mockReturnValueOnce(wait.promise);
    const pending = h.action('exportToFile'); await h.host._handleSwitchConversation('a', h.other.id);
    h.host._postToPanel.mockClear(); wait.resolve(vscode.Uri.file('/owned/export.json')); await pending;
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled(); expect(h.host._postToPanel).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'write failure', 'success'] as const)('file export %s reports its actual destination/result', async result => {
    const h = harness();
    if (result === 'cancel') vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(undefined);
    if (result === 'write failure') vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce(new Error('Disk denied'));
    await expect(h.action('exportToFile', { format: 'json' })).resolves.toBeUndefined();
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'exportResult', payload: expect.objectContaining({
      operation: 'file', format: 'json', success: result === 'success', requestId: 'request-1', conversationId: h.source.id,
      ...(result === 'cancel' ? { cancelled: true } : result === 'write failure' ? { error: 'Disk denied' } : {}),
    }) });
  });

  it('highly compressible over-limit sharing copies complete JSON instead of silently shortened text', async () => {
    const h = harness();
    for (let n = 0; n < 14; n++) h.manager.addMessageToConversation(h.source.id, n % 2 ? 'assistant' : 'user', `${n}:` + 'repeat'.repeat(1000));
    await h.action('triggerShareLink');
    const text = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0][0];
    expect(text.startsWith('{')).toBe(true);
    const parsed = JSON.parse(text); expect(parsed.conversation.messages.map((m: any) => m.content)).toEqual(h.source.messages.map(m => m.content));
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'exportResult', payload: expect.objectContaining({ operation: 'share', format: 'json', success: true, notice: expect.stringMatching(/full.*JSON/i) }) });
  });

  it('a confirmed URI import opens its own tab instead of clearing every running panel', async () => {
    const h = harness(); const imported = h.manager.importFromContent(importedText, 'conversation.json')!;
    h.host.openInNewTab = vi.fn(() => 'new-tab');
    const original = [...h.panels.values()].map(value => value.currentConversationId);
    await h.host.openImportedConversation(imported);
    expect(h.host.openInNewTab).toHaveBeenCalledExactlyOnceWith(imported.id);
    expect([...h.panels.values()].map(value => value.currentConversationId)).toEqual(original);
    expect(h.providers.cancelRequest).not.toHaveBeenCalled(); expect(h.host.postMessage).not.toHaveBeenCalled();
  });
});
