import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliLifecycleProvider } from '../../helpers/cliLifecycleProvider';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import type { ContextItem, Conversation, Settings, StreamChunk } from '../../../src/types';
import { acpApprovalDecision } from '../../../src/providers/base/NativeApprovalPolicy';

vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: vi.fn(async () => {}),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class NativeProvider extends CliLifecycleProvider {
  readonly validate = vi.fn(async () => {});
  readonly run = vi.fn(async function* (_settings: Settings, _session: PanelSessionState): AsyncGenerator<StreamChunk> {
    yield { type: 'text', content: 'native' };
  });
  constructor() { super(true, true); }
  protected async _validateNativeApprovalCli() { await this.validate(); }
  protected async *_sendNativeTurn(_content: string, _context: ContextItem[], settings: Settings,
    _conversation: Conversation | null, session: PanelSessionState) { yield* this.run(settings, session); }
  bind(session: PanelSessionState) {
    const proc = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null }) as ChildProcess;
    session.process = proc;
    return this._createNativeApprovalRequests(session, proc)!;
  }
}
const providers: NativeProvider[] = [];
afterEach(() => { providers.splice(0).forEach(provider => provider.dispose()); vi.restoreAllMocks(); });
function harness() {
  const provider = new NativeProvider(); providers.push(provider);
  const persistent = vi.spyOn(provider as unknown as { _sendViaPersistentProcess(): AsyncGenerator<StreamChunk> }, '_sendViaPersistentProcess');
  const singleShot = vi.spyOn(provider as unknown as { _sendSingleShot(): AsyncGenerator<StreamChunk> }, '_sendSingleShot');
  const settings: Settings = { provider: 'codex', mode: 'ask-before-edit', accessLevel: 'ask-permission',
    model: '', contextMode: 'auto', thinkingLevel: 'none' };
  const send = () => provider.sendMessage('hello', [], settings, null, undefined, 'panel');
  return { provider, persistent, singleShot, settings, send };
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []; for await (const chunk of stream) { chunks.push(chunk); } return chunks;
}

describe('native protocol turn ownership in the base provider', () => {
  it('does not fall back after native startup or submitted-turn failure', async () => {
    const h = harness();
    h.provider.run.mockImplementation(async function* () {
      yield { type: 'text', content: 'already submitted' };
      throw new Error('native transport lost');
    });
    expect(await collect(h.send())).toEqual([
      { type: 'text', content: 'already submitted' }, { type: 'error', content: 'native transport lost' }, { type: 'done' },
    ]);
    expect(h.persistent).not.toHaveBeenCalled(); expect(h.singleShot).not.toHaveBeenCalled();
  });

  it('rejects unsupported native protocol before any execution path', async () => {
    const h = harness(); h.provider.validate.mockRejectedValue(new Error('unsupported protocol'));
    expect(await collect(h.send())).toEqual([{ type: 'error', content: 'unsupported protocol' }, { type: 'done' }]);
    expect(h.provider.run).not.toHaveBeenCalled(); expect(h.persistent).not.toHaveBeenCalled(); expect(h.singleShot).not.toHaveBeenCalled();
  });

  it('captures settings and the original host before awaiting native validation', async () => {
    const h = harness(); const ready = deferred<void>();
    h.provider.validate.mockReturnValue(ready.promise);
    const first = vi.fn(async () => false); const replacement = vi.fn(async () => true);
    h.provider.setNativeApprovalHost({ handlerForPanel: () => first });
    h.provider.run.mockImplementation(async function* (settings, session) {
      const response = deferred<string>();
      h.provider.bind(session).request('request', { id: 'edit', name: 'Edit', input: {}, status: 'running' },
        acpApprovalDecision(settings, 'edit'), decision => response.resolve(decision));
      yield { type: 'text', content: await response.promise };
    });
    const completion = collect(h.send());
    expect(h.provider.validate).toHaveBeenCalledOnce();
    h.settings.mode = 'edit-automatically'; h.settings.accessLevel = 'full-access';
    h.provider.setNativeApprovalHost({ handlerForPanel: () => replacement });
    ready.resolve();
    expect(await completion).toEqual([{ type: 'text', content: 'deny' }, { type: 'done' }]);
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ defaultDecision: 'ask' }));
    expect(replacement).not.toHaveBeenCalled();
  });

  it('Stop during protocol validation cannot start a native turn later', async () => {
    const h = harness(); const ready = deferred<void>();
    h.provider.validate.mockReturnValue(ready.promise);
    const completion = collect(h.send());
    h.provider.cancelCurrentRequest('panel'); ready.resolve();
    expect(await completion).toEqual([]);
    expect(h.provider.run).not.toHaveBeenCalled(); expect(h.singleShot).not.toHaveBeenCalled();
  });

  it('disposing during eager validation cannot spawn a child after disposal', async () => {
    const h = harness(); const ready = deferred<void>();
    const spawn = vi.spyOn(h.provider as unknown as { _spawnCliProcess(): ChildProcess }, '_spawnCliProcess');
    h.provider.validate.mockReturnValue(ready.promise);
    const preparing = h.provider.preSpawnPersistentProcess('panel', h.settings);
    h.provider.dispose(); ready.resolve(); await preparing;
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a newer warmup supersedes an older pending validation', async () => {
    const h = harness(); const ready = deferred<void>();
    const spawn = vi.spyOn(h.provider as unknown as { _getOrSpawnPersistentProcess(session: PanelSessionState, settings: Settings): Promise<ChildProcess | null> }, '_getOrSpawnPersistentProcess').mockResolvedValue(null);
    h.provider.validate.mockReturnValueOnce(ready.promise);
    const old = h.provider.preSpawnPersistentProcess('panel', { ...h.settings, model: 'old' });
    await h.provider.preSpawnPersistentProcess('panel', { ...h.settings, model: 'new' });
    ready.resolve(); await old;
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1].model).toBe('new');
  });

  it.each(['Stop', 'new turn'] as const)('%s retires pending eager validation', async action => {
    const h = harness(); const ready = deferred<void>();
    const spawn = vi.spyOn(h.provider as unknown as { _getOrSpawnPersistentProcess(): Promise<ChildProcess | null> }, '_getOrSpawnPersistentProcess').mockResolvedValue(null);
    h.provider.validate.mockReturnValueOnce(ready.promise);
    const preparing = h.provider.preSpawnPersistentProcess('panel', h.settings);
    if (action === 'Stop') { h.provider.cancelCurrentRequest('panel'); }
    else { await collect(h.send()); }
    ready.resolve(); await preparing;
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not warm up or emit stale native chunks during a current turn', async () => {
    const h = harness(); const ready = deferred<void>(); const started = deferred<void>();
    h.provider.run.mockImplementation(async function* () {
      started.resolve(); await ready.promise; yield { type: 'text', content: 'stale' };
    });
    const completion = collect(h.send()); await started.promise;
    await h.provider.preSpawnPersistentProcess('panel', { ...h.settings, model: 'other' });
    expect(h.provider.validate).toHaveBeenCalledOnce();
    h.provider.cancelCurrentRequest('panel'); ready.resolve();
    expect(await completion).toEqual([{ type: 'done' }]);
  });
});
