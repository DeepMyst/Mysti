import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
function harness() {
  const view = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: new Map([['tab', { currentConversationId: 'conversation' }]]),
    _postToPanel: vi.fn(), _getPanelProvider: vi.fn(() => 'openai-codex'), _getPanelAgent: vi.fn(() => 'openai-codex'),
    _getPanelModel: () => 'gpt-test', _handleUpdateSettings: vi.fn(),
    _providerManager: { enhancePrompt: vi.fn(async () => ({ prompt: 'Enhanced', changed: true })), getProviderInstance: () => ({ capabilities: { supportsImages: true, supportsFileAttachments: true } }) },
    _conversationManager: { exportToMarkdown: vi.fn(() => '# Conversation') },
    _engagementManager: { trackExport: () => [] }, _emitBadgeUnlocks: vi.fn(),
  });
  return view;
}
afterEach(() => vi.restoreAllMocks());
describe('menu actions in the extension host', () => {
  it('enhances with the current tab provider and echoes the request identity', async () => {
    const view = harness(); await view._handleEnhancePrompt({ prompt: 'Draft', requestId: 7 }, 'tab');
    expect(view._providerManager.enhancePrompt).toHaveBeenCalledWith('Draft', 'openai-codex');
    expect(view._postToPanel).toHaveBeenCalledWith('tab', { type: 'promptEnhanced', payload: { prompt: 'Enhanced', changed: true, requestId: 7 } });
  });
  it('returns enhancement errors to the matching request', async () => {
    const view = harness(); view._providerManager.enhancePrompt.mockRejectedValue(new Error('Offline'));
    await view._handleEnhancePrompt({ prompt: 'Draft', requestId: 8 }, 'tab');
    expect(view._postToPanel).toHaveBeenCalledWith('tab', { type: 'promptEnhanceError', payload: { requestId: 8, error: 'Offline' } });
  });
  it('exports the current tab and reports empty conversation and clipboard failures', async () => {
    const view = harness(); const clipboard = vi.fn(async (_text: string) => {}); (vscode.env as any).clipboard = { writeText: clipboard };
    await view._handleExportConversation('tab'); expect(clipboard).toHaveBeenCalledWith('# Conversation');
    await view._handleExportConversation('empty');
    expect(view._postToPanel).toHaveBeenCalledWith('empty', { type: 'exportResult', payload: { success: false, error: expect.stringContaining('no conversation') } });
    clipboard.mockRejectedValue(new Error('Clipboard unavailable')); await view._handleExportConversation('tab');
    expect(view._postToPanel).toHaveBeenCalledWith('tab', { type: 'exportResult', payload: { success: false, error: 'Clipboard unavailable' } });
  });
  it('applies a custom model through the shared writer and cancels safely after switching providers', async () => {
    const view = harness(); const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(' local/model:latest ');
    await view._handleCustomModel('tab');
    expect(view._handleUpdateSettings).toHaveBeenCalledWith({ model: 'local/model:latest', customModel: 'local/model:latest' }, 'tab');
    view._handleUpdateSettings.mockClear();
    input.mockImplementation(async () => { view._getPanelProvider.mockReturnValue('other'); return 'wrong/model'; });
    await view._handleCustomModel('tab'); expect(view._handleUpdateSettings).not.toHaveBeenCalled();
  });
  it('attaches readable files with correct MIME and surfaces oversized, missing and unsupported selections', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-menu-attachments-'));
    try {
      const svg = path.join(dir, 'image.svg'), large = path.join(dir, 'large.txt'), missing = path.join(dir, 'missing');
      fs.writeFileSync(svg, '<svg/>'); fs.writeFileSync(large, ''); fs.truncateSync(large, 11 * 1024 * 1024);
      const picker = vi.fn().mockResolvedValue([svg, large, missing].map(vscode.Uri.file));
      (vscode.window as any).showOpenDialog = picker;
      const view = harness(); await view._handleRequestFileAttachment('tab');
      expect(view._postToPanel).toHaveBeenCalledWith('tab', { type: 'attachmentWarning', payload: { message: expect.stringContaining('10 MB') } });
      expect(view._postToPanel).toHaveBeenCalledWith('tab', { type: 'fileAttachmentSelected', payload: { attachments: [expect.objectContaining({ fileName: 'image.svg', mimeType: 'image/svg+xml', base64Data: Buffer.from('<svg/>').toString('base64') })] } });
      view._postToPanel.mockClear(); picker.mockResolvedValue([vscode.Uri.file(svg)]);
      view._providerManager.getProviderInstance = () => ({ capabilities: {} });
      await view._handleRequestFileAttachment('tab');
      expect(view._postToPanel).toHaveBeenCalledExactlyOnceWith('tab', { type: 'attachmentWarning', payload: { message: expect.stringContaining('does not accept image') } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
