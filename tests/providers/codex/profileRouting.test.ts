import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableKimiProvider, TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: mocks.kill,
}));
const providers: Array<TestableCodexProvider | TestableKimiProvider> = [];
afterEach(() => {
  providers.splice(0).forEach(provider => provider.dispose());
  vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});
const settings: Settings = { provider: 'openai-codex', model: 'gpt-5.6-sol', effortLevel: 'medium',
  mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
async function collect(stream: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks;
}
type Rpc = { id: number; method: string; params?: Record<string, any> };
function harness() {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  const provider = new TestableCodexProvider(); providers.push(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/codex');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Controlled profile-routing test.');
  vi.spyOn(provider as any, 'takeReportedContextWindow').mockReturnValue(undefined);
  const fallback = vi.spyOn(provider, 'buildCliArgs');
  const children: Array<{ args: string[]; frames: Rpc[] }> = [];
  mocks.spawn.mockImplementation((_executable: string, args: string[]) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 187000 + children.length,
      exitCode: null, signalCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess;
    const child = { args, frames: [] as Rpc[] }; children.push(child);
    const emit = (value: unknown) => { stdout.write(JSON.stringify(value) + '\n'); };
    let buffer = '';
    stdin.on('data', bytes => {
      buffer += bytes.toString(); let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const rpc: Rpc = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); child.frames.push(rpc);
        setImmediate(() => {
          if (rpc.method === 'initialize') {
            emit(args.includes('missing-profile') ? { id: rpc.id, error: { code: -32000, message: 'Selected profile is unavailable.' } }
              : { id: rpc.id, result: {} });
          } else if (rpc.method === 'config/read') emit({ id: rpc.id, result: { config: {} } });
          else if (rpc.method === 'thread/start' || rpc.method === 'thread/resume') emit({ id: rpc.id, result: { thread: { id: 'owned-thread' } } });
          else if (rpc.method === 'turn/start') {
            const id = `turn-${child.frames.filter(value => value.method === 'turn/start').length}`;
            emit({ id: rpc.id, result: { turn: { id } } });
            emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned-thread', turnId: id, itemId: 'text', delta: 'CONTROLLED_REPLY' } });
            emit({ method: 'turn/completed', params: { threadId: 'owned-thread', turn: { id, status: 'completed' } } });
          }
        });
      }
    });
    return process;
  });
  return { provider, children, fallback, send: () => collect(provider.sendMessage('Continue', [], settings, null, undefined, 'panel')) };
}
function actionableProfileError(chunks: StreamChunk[]) {
  const errors = chunks.filter(chunk => chunk.type === 'error');
  expect(errors).toHaveLength(1);
  expect(errors[0].content).toMatch(/profile/i);
  expect(errors[0].content).toContain('mysti.codexProfile');
  expect(errors[0].content).toMatch(/clear|settings/i);
  expect(errors[0].content).not.toMatch(/could not start its native approval transport/);
  expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  expect(chunks.filter(chunk => chunk.type === 'text')).toEqual([]);
}

describe('PB02-D10 saved Codex profiles cannot silently select the default', () => {
  it.each(['bad profile!', 'bad/profile', '   ', 'a'.repeat(65), null, 0, false, {}])('rejects invalid saved profile %j before dispatch with recovery guidance', async saved => {
    const h = harness(); setMockConfig('codexProfile', saved);
    actionableProfileError(await h.send());
    expect(h.children).toEqual([]); expect(mocks.spawn).not.toHaveBeenCalled(); expect(h.fallback).not.toHaveBeenCalled();
  });
  it.each([['', ['app-server']], ['profile-one', ['--profile', 'profile-one', 'app-server']],
    [' profile-one ', ['--profile', 'profile-one', 'app-server']]])('honors explicit saved profile %j', async (saved, args) => {
    const h = harness(); setMockConfig('codexProfile', saved);
    const chunks = await h.send();
    expect(h.children).toHaveLength(1); expect(h.children[0].args).toEqual(args);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([]);
    expect(chunks.filter(chunk => chunk.type === 'text')).toEqual([{ type: 'text', content: 'CONTROLLED_REPLY' }]);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('does not dispatch invalid selection to a warmed default process, then recovers on a corrected name', async () => {
    const h = harness(); await h.send(); const before = h.children[0].frames.length;
    setMockConfig('codexProfile', 'bad/profile'); actionableProfileError(await h.send());
    expect(h.children).toHaveLength(1); expect(h.children[0].frames).toHaveLength(before);
    setMockConfig('codexProfile', ' corrected-profile '); const recovered = await h.send();
    expect(h.children).toHaveLength(2); expect(h.children[1].args).toEqual(['--profile', 'corrected-profile', 'app-server']);
    expect(h.children[1].frames.find(value => value.method === 'thread/resume')?.params).toMatchObject({ threadId: 'owned-thread' });
    expect(recovered.filter(chunk => chunk.type === 'error')).toEqual([]); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('reuses the warmed named-profile process when only surrounding whitespace changes', async () => {
    const h = harness(); setMockConfig('codexProfile', 'profile-one'); await h.send();
    const original = h.children[0];
    setMockConfig('codexProfile', ' profile-one '); const chunks = await h.send();
    expect(h.children).toHaveLength(1); expect(h.children[0]).toBe(original);
    expect(original.args).toEqual(['--profile', 'profile-one', 'app-server']);
    expect(original.frames.filter(value => value.method === 'turn/start')).toHaveLength(2);
    expect(original.frames.filter(value => value.method === 'thread/start')).toHaveLength(1);
    expect(original.frames.filter(value => value.method === 'thread/resume')).toHaveLength(0);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([]); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('preserves a valid but missing profile rejection without retrying the default', async () => {
    const h = harness(); setMockConfig('codexProfile', 'missing-profile');
    const chunks = await h.send(); expect(h.children).toHaveLength(1);
    expect(h.children[0].args).toEqual(['--profile', 'missing-profile', 'app-server']);
    expect(h.children[0].frames.some(value => value.method === 'turn/start')).toBe(false);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([expect.objectContaining({ content: expect.stringContaining('Selected profile is unavailable.') })]);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('keeps the actual required-transport setup error without adding a generic duplicate', async () => {
    const h = harness();
    vi.spyOn(h.provider as any, '_sendViaPersistentProcess').mockImplementation(async function* () { throw new Error('Controlled executable setup failed.'); });
    const chunks = await h.send();
    expect(chunks).toEqual([{ type: 'error', content: 'Controlled executable setup failed.' }, { type: 'done' }]);
    expect(h.children).toEqual([]); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('does not surface a delayed required-transport setup failure after Stop', async () => {
    const h = harness();
    let entered!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    vi.spyOn(h.provider as any, '_sendViaPersistentProcess').mockImplementation(async function* () {
      entered(); await pending;
    });
    const completion = h.send(); await started;
    h.provider.cancelCurrentRequest('panel'); reject(new Error('Late controlled setup failure.'));
    expect(await completion).toEqual([{ type: 'done' }]);
    expect(h.children).toEqual([]); expect(mocks.spawn).not.toHaveBeenCalled(); expect(h.fallback).not.toHaveBeenCalled();
  });
  it('retains the existing setup-time single-shot fallback for an optional persistent transport', async () => {
    const provider = new TestableKimiProvider(); providers.push(provider);
    // This models Base's optional transport path; real Kimi requests require ACP.
    vi.spyOn(provider as any, 'requiresPersistentTransport').mockReturnValue(false);
    vi.spyOn(provider as any, '_sendViaPersistentProcess').mockImplementation(async function* () { throw new Error('Optional persistent setup failed.'); });
    const fallback = vi.spyOn(provider as any, '_sendSingleShot').mockImplementation(async function* () {
      yield { type: 'text', content: 'CONTROLLED_SINGLE_SHOT' }; yield { type: 'done' };
    });
    expect(await collect(provider.sendMessage('Continue', [], { ...settings, provider: provider.id, model: provider.config.defaultModel, mode: 'edit-automatically', accessLevel: 'full-access' }, null, undefined, 'panel')))
      .toEqual([{ type: 'text', content: 'CONTROLLED_SINGLE_SHOT' }, { type: 'done' }]);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
