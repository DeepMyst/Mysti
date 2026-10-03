import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  commands: [] as string[], builtin: true as boolean | undefined, speech: undefined as any,
  active: undefined as any, changed: undefined as any, closed: undefined as any,
  docs: [] as any[], execute: vi.fn(), open: vi.fn(),
}));
vi.mock('vscode', () => ({
  StatusBarAlignment: { Right: 2 }, ViewColumn: { Beside: -2 },
  window: {
    createStatusBarItem: () => ({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }),
    get activeTextEditor() { return host.active; },
    showTextDocument: async (doc: any) => { host.active = { document: doc }; return host.active; },
  },
  commands: { getCommands: async () => host.commands, executeCommand: (...args: any[]) => host.execute(...args), registerCommand: () => ({ dispose() {} }) },
  extensions: { getExtension: () => host.speech },
  workspace: {
    getConfiguration: () => ({ get: () => host.builtin }),
    openTextDocument: (...args: any[]) => host.open(...args),
    onDidChangeTextDocument: (fn: any) => { host.changed = fn; return { dispose() { host.changed = undefined; } }; },
    onDidCloseTextDocument: (fn: any) => { host.closed = fn; return { dispose() { host.closed = undefined; } }; },
  },
}));
import { DictationManager } from '../../src/managers/DictationManager';
describe('DictationManager ownership and lifecycle', () => {
  let manager: DictationManager, emit: ReturnType<typeof vi.fn>, speech: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    host.commands = ['workbench.action.editorDictation.start']; host.builtin = true; host.speech = undefined;
    host.docs = []; host.active = undefined; host.execute.mockReset(); host.open.mockReset();
    host.open.mockImplementation(async () => {
      const doc = { text: '', isUntitled: true, isClosed: false, getText() { return this.text; } };
      host.docs.push(doc); return doc;
    });
    host.execute.mockImplementation(async () => { host.active.document.isClosed = true; });
    emit = vi.fn(); speech = vi.fn().mockResolvedValue(undefined); manager = new DictationManager(emit, speech);
  });
  afterEach(async () => { await manager.cancelPanel('panel'); manager.dispose(); vi.useRealTimers(); });
  it('routes only its document and finishes only for its owner', async () => {
    await manager.start('panel', 'one');
    host.changed({ document: { getText: () => 'source code' } });
    expect(emit).not.toHaveBeenCalledWith('panel', expect.objectContaining({ text: 'source code' }));
    host.docs[0].text = 'spoken words'; host.changed({ document: host.docs[0] });
    expect(emit).toHaveBeenLastCalledWith('panel', { requestId: 'one', state: 'active', text: 'spoken words' });
    await manager.finish('other-panel', 'one'); await manager.finish('panel', 'old');
    expect(speech).toHaveBeenCalledTimes(1);
    await manager.finish('panel', 'one');
    expect(speech).toHaveBeenLastCalledWith('workbench.action.editorDictation.stop');
    expect(emit).toHaveBeenLastCalledWith('panel', { requestId: 'one', state: 'complete', text: 'spoken words' });
    expect(host.docs[0].isClosed).toBe(true);
  });
  it('offers setup on older hosts, without opening or recording', async () => {
    host.builtin = undefined;
    await manager.start('panel', 'one');
    expect(emit).toHaveBeenLastCalledWith('panel', expect.objectContaining({ state: 'error', needsSetup: true }));
    expect(host.open).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
    host.speech = { activate: vi.fn().mockResolvedValue(undefined) };
    await manager.start('panel', 'two'); expect(host.speech.activate).toHaveBeenCalled();
  });
  it('cancels pending startup and rejects simultaneous sessions', async () => {
    const starting = manager.start('panel', 'one');
    await manager.start('other', 'two');
    expect(emit).toHaveBeenCalledWith('other', expect.objectContaining({ state: 'error' }));
    const cancel = manager.cancelPanel('panel'); await starting; await cancel;
    expect(speech).not.toHaveBeenCalled(); expect(host.open).not.toHaveBeenCalled();
    expect(emit).toHaveBeenLastCalledWith('panel', { requestId: 'one', state: 'cancelled' });
  });
  it('preserves text and never discards a saved editor; startup failures can retry', async () => {
    speech.mockRejectedValueOnce(new Error('Microphone denied'));
    await manager.start('panel', 'one');
    expect(emit).toHaveBeenCalledWith('panel', expect.objectContaining({ state: 'error', error: expect.stringContaining('Microphone denied') }));
    await manager.start('panel', 'two'); host.execute.mockClear();
    host.docs[1].isUntitled = false; host.docs[1].text = 'saved text';
    await manager.finish('panel', 'two');
    expect(host.execute).not.toHaveBeenCalled();
    expect(emit).toHaveBeenLastCalledWith('panel', expect.objectContaining({ state: 'complete', text: 'saved text' }));
  });
  it('bounds sessions to five minutes and discards on document close', async () => {
    vi.useFakeTimers();
    await manager.start('panel', 'one'); host.docs[0].text = 'timeout text';
    await vi.advanceTimersByTimeAsync(300_000);
    expect(emit).toHaveBeenLastCalledWith('panel', expect.objectContaining({ state: 'complete', text: 'timeout text' }));
    await manager.start('panel', 'two'); host.docs[1].isClosed = true; host.closed(host.docs[1]);
    await manager.cancelPanel('panel');
    expect(emit).toHaveBeenLastCalledWith('panel', expect.objectContaining({ state: 'cancelled' }));
  });
});
