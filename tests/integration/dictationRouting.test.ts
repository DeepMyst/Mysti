import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
afterEach(() => vi.restoreAllMocks());
describe('dictation host routing', () => {
  it('carries originating tab and request identity through start, finish and cancellation', async () => {
    const dictation = { start: vi.fn(), finish: vi.fn(), cancelPanel: vi.fn() };
    const view = Object.assign(Object.create(ChatViewProvider.prototype), { _dictationManager: dictation, _sidebarId: 'sidebar' });
    for (const [type, method] of [['startDictation', 'start'], ['finishDictation', 'finish'], ['cancelDictation', 'cancelPanel']] as const) {
      await view._handleMessage({ type, panelId: 'tab', payload: { requestId: 'voice-1' } });
      expect(dictation[method]).toHaveBeenCalledWith('tab', 'voice-1');
    }
    await view._handleMessage({ type: 'startDictation', payload: { requestId: 'sidebar-voice' } });
    expect(dictation.start).toHaveBeenCalledWith('sidebar', 'sidebar-voice');
  });
  it('installs only the known speech extension and reports install failures', async () => {
    const execute = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    const view = Object.assign(Object.create(ChatViewProvider.prototype), { _sidebarId: 'sidebar' });
    await view._handleMessage({ type: 'installDictationSupport', payload: { extension: 'untrusted.extension' } });
    expect(execute).toHaveBeenCalledWith('workbench.extensions.installExtension', 'ms-vscode.vscode-speech');
    expect(info).toHaveBeenCalled();
    execute.mockRejectedValueOnce(new Error('Marketplace unavailable'));
    await view._handleMessage({ type: 'installDictationSupport' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Marketplace unavailable'));
    await view._handleMessage({ type: 'dictationSettings' });
    expect(execute).toHaveBeenLastCalledWith('workbench.action.openSettings', '@tag:accessibility voice');
  });
});
