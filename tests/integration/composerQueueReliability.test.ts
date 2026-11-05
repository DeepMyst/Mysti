import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { Settings } from '../../src/types';

vi.mock('vscode', async () => {
  const base = await vi.importActual<any>('../helpers/mockVscode');
  return { ...base, window: { ...base.window, showOpenDialog: vi.fn() } };
});

const SETTINGS = { provider: 'claude-code', model: 'claude-model', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const ATTACHMENT = { id: 'owned-file', fileName: 'retry-example.txt', type: 'file', base64Data: Buffer.from('A queued regression fixture').toString('base64'), mimeType: 'text/plain', size: 27 };
function harness(kind: 'unknown' | 'native' | 'local' | 'prefill' = 'unknown') {
  const posted: any[] = [];
  const host: any = Object.assign(Object.create(ChatViewProvider.prototype), {
    _sidebarId: 'a', _panelStates: new Map([['a', { currentConversationId: 'work' }]]),
    _mystiRunGen: new Map(),
    _getPanelProvider: () => 'claude-code',
    _postToPanel: (_panel: string, message: any) => posted.push(message),
    _emitBadgeUnlocks: () => {}, _engagementManager: { trackSlashCommandUsed: () => [] },
    _handleSendMessage: vi.fn(async () => {}),
    _slashCommandManager: {
      mapLegacyCommand: (command: string) => `cmd:${command}`,
      isKnownCommand: () => kind === 'local',
      findNativeCommandId: () => kind === 'native' || kind === 'prefill' ? 'native:claude-code:review' : null,
      resolveNativeCommand: () => kind === 'prefill' ? { kind: 'prefill', text: '/review ' } : { kind: 'prompt', text: '/review retry policy' },
      executeCommand: vi.fn(async () => 'Local command completed'),
    },
  });
  host._getSlashCommandCallbacks = () => ({ postToPanel: host._postToPanel, updateSettings: vi.fn(async () => {}), executeManualCompaction: vi.fn(async () => {}) });
  const invoke = (requestId = 'slash-1') => host._handleMessage({ type: 'executeSlashCommand', panelId: 'a', payload: {
    requestId, command: 'review', args: 'retry policy', settings: SETTINGS,
    context: [{ type: 'file', path: '/fixture/context.ts', content: 'owned context' }], attachments: [ATTACHMENT],
  } });
  return { host, posted, invoke };
}

describe('PC-06 queued slash actions at the real host boundary', () => {
  for (const kind of ['unknown', 'native'] as const) {
    it(`${kind} slash prompts retain the queued files and context`, async () => {
      const h = harness(kind); await h.invoke();
      expect(h.host._handleSendMessage).toHaveBeenCalledOnce();
      expect(h.host._handleSendMessage.mock.calls[0]).toEqual([{ content: '/review retry policy', settings: SETTINGS,
        context: [{ type: 'file', path: '/fixture/context.ts', content: 'owned context' }], attachments: [ATTACHMENT] }, 'a']);
      expect(h.posted.filter(message => message.type === 'slashCommandCompleted')).toEqual([
        { type: 'slashCommandCompleted', payload: { requestId: 'slash-1', kind: 'turn', success: true } },
      ]);
    });
  }

  it('acknowledges a local command only after its asynchronous action completes', async () => {
    const h = harness('local'); let finish!: () => void;
    h.host._slashCommandManager.executeCommand.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = h.invoke();
    expect(h.posted.some(message => message.type === 'slashCommandCompleted')).toBe(false);
    finish(); await pending;
    expect(h.posted).toContainEqual({ type: 'slashCommandCompleted', payload: { requestId: 'slash-1', kind: 'action', success: true } });
    expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  });

  it('reports a prefill without pretending an agent response completed', async () => {
    const h = harness('prefill'); await h.invoke();
    expect(h.posted.some(message => message.type === 'setInputValue')).toBe(false);
    expect(h.posted).toContainEqual({ type: 'slashCommandCompleted', payload: { requestId: 'slash-1', kind: 'prefill', success: true, prefill: '/review ' } });
    expect(h.host._handleSendMessage).not.toHaveBeenCalled();
    expect(h.posted.some(message => message.type === 'responseComplete')).toBe(false);
  });

  it('settles a failed local action once so the composer does not remain busy', async () => {
    const h = harness('local'); h.host._slashCommandManager.executeCommand.mockRejectedValue(new Error('Local command failed'));
    await h.invoke();
    expect(h.posted.filter(message => message.type === 'slashCommandCompleted')).toEqual([
      { type: 'slashCommandCompleted', payload: { requestId: 'slash-1', kind: 'error', success: false, error: 'Local command failed' } },
    ]);
  });

  it('dispatches a repeated request ID once while accepting a later distinct command', async () => {
    const h = harness('native'); let finish!: () => void;
    h.host._handleSendMessage.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = h.invoke('same-command'); await h.invoke('same-command');
    expect(h.host._handleSendMessage).toHaveBeenCalledOnce(); finish(); await pending;
    await h.invoke('next-command'); expect(h.host._handleSendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not apply a delayed command choice or acknowledgement to a different conversation', async () => {
    const h = harness('local'); let finish!: () => void;
    const update = vi.fn(async () => {});
    h.host._getSlashCommandCallbacks = () => ({ postToPanel: h.host._postToPanel, updateSettings: update, executeManualCompaction: vi.fn(async () => {}) });
    h.host._slashCommandManager.executeCommand.mockImplementation(async (_id: string, _args: string, _panel: string, callbacks: any) => {
      await new Promise<void>(resolve => { finish = resolve; });
      await callbacks.updateSettings({ model: 'old-dialog-selection' }, 'a');
      callbacks.postToPanel('a', { type: 'setInputValue', payload: { value: 'old conversation draft' } });
      return 'Old choice completed';
    });
    const pending = h.invoke(); h.host._panelStates.get('a').currentConversationId = 'replacement'; finish(); await pending;
    expect(update).not.toHaveBeenCalled(); expect(h.posted).toEqual([]);
  });
});

describe('PC-06 attachment picker ownership', () => {
  for (const change of ['conversation', 'panel replacement', 'sent draft'] as const) {
    it(`does not stage a delayed file selection after its ${change} changed`, async () => {
      const h = harness(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc06-attachments-'));
      const file = path.join(directory, 'original-draft.txt'); fs.writeFileSync(file, 'Only belongs to the original draft');
      h.host._getPanelAgent = () => 'claude-code';
      h.host._providerManager = { getProviderInstance: () => ({ capabilities: { supportsImages: true, supportsFileAttachments: true } }) };
      let finish!: (files: any[]) => void;
      vi.mocked(vscode.window.showOpenDialog).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      try {
        const pending = h.host._handleRequestFileAttachment('a');
        if (change === 'conversation') { h.host._panelStates.get('a').currentConversationId = 'different-work'; }
        if (change === 'panel replacement') { h.host._panelStates.set('a', { currentConversationId: 'work' }); }
        if (change === 'sent draft') { h.host._mystiRunGen.set('a', 1); }
        finish([vscode.Uri.file(file)]); await pending;
        expect(h.posted.filter(message => message.type === 'fileAttachmentSelected')).toEqual([]);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
