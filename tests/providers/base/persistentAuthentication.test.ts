import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider, TestableCodexProvider, TestableHermesProvider, TestableKimiProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';
import { resetPlatformCache } from '../../../src/utils/platform';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async () => ({ ...await vi.importActual<any>('../../../src/utils/processKill'), killProcessTree: mocks.kill }));

const cases = [
  { name: 'Codex', make: () => new TestableCodexProvider(), key: 'OPENAI_API_KEY', model: 'gpt-5.4' },
  { name: 'Claude', make: () => new TestableClaudeProvider(), key: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-6' },
  { name: 'Hermes', make: () => new TestableHermesProvider(), key: 'NOUS_API_KEY', model: 'default' },
  { name: 'Kimi', make: () => new TestableKimiProvider(), key: 'MOONSHOT_API_KEY', model: 'kimi-for-coding' },
];
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig(); clearConfigurationListeners();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function harness(testCase = cases[0]) {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  resetPlatformCache();
  const provider = testCase.make(); const internal = provider as any;
  const settings = { provider: provider.id, model: testCase.model, mode: 'quick-plan', accessLevel: 'read-only',
    thinkingLevel: 'none', contextMode: 'auto' } as Settings;
  // Authentication lifecycle is exercised only under supported Kimi authority.
  if (provider.id === 'kimi-code') { settings.mode = 'edit-automatically'; settings.accessLevel = 'full-access'; }
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/fixture/selected-cli');
  vi.spyOn(internal, 'prepareAttachments').mockResolvedValue(async () => {});
  vi.spyOn(internal, 'buildPromptAsync').mockResolvedValue('continue the original task');
  const spawned: any[] = [];
  mocks.spawn.mockImplementation((_file, _args, options) => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 6500 + spawned.length, exitCode: null, signalCode: null, killed: false,
      kill: vi.fn(() => true), credential: options.env[testCase.key],
    });
    spawned.push(proc); return proc;
  });
  const read = vi.spyOn(internal, '_readUntilBoundary').mockImplementation(async function* (proc: any, session: any) {
    session.sessionId = 'original-task-session';
    yield proc.credential === 'synthetic-replacement-key'
      ? { type: 'text', content: 'continued original task' }
      : { type: 'error', content: 'Authentication failed: API key is invalid.' };
    session.process = null;
  });
  const send = async (panel = 'panel') => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('continue', [], settings, null, undefined, panel)) { chunks.push(chunk); }
    return chunks;
  };
  cleanups.push(() => provider.dispose());
  return { provider, internal, spawned, send, read, settings };
}

describe('PC-03 persistent credential replacement', () => {
  for (const testCase of cases) {
    it(`${testCase.name}: replacing an invalid environment key recovers on the next turn`, async () => {
      vi.stubEnv(testCase.key, 'synthetic-revoked-key');
      const h = harness(testCase);
      expect((await h.send()).filter(chunk => chunk.type === 'error')).toHaveLength(1);
      vi.stubEnv(testCase.key, 'synthetic-replacement-key');
      expect(await h.send()).toContainEqual({ type: 'text', content: 'continued original task' });
      expect(h.spawned).toHaveLength(2);
      expect(h.internal._getSession('panel').sessionId).toBe('original-task-session');
      await h.send(); expect(h.spawned).toHaveLength(2);
    });
  }

  it('finishes an active turn with its original credential, then replaces each panel independently', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-revoked-key');
    const h = harness(); const started = deferred(); const finish = deferred();
    await h.send('other');
    h.read.mockImplementationOnce(async function* (proc: any, session: any) {
      started.resolve(); await finish.promise;
      yield { type: 'text', content: proc.credential === 'synthetic-revoked-key' ? 'original turn finished' : 'wrong credential' };
      session.process = null;
    });
    const active = h.send(); await started.promise;
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-replacement-key');
    await h.provider.preSpawnPersistentProcess('panel', h.settings);
    expect(mocks.kill).not.toHaveBeenCalled();
    finish.resolve(); expect(await active).toContainEqual({ type: 'text', content: 'original turn finished' });
    expect(await h.send()).toContainEqual({ type: 'text', content: 'continued original task' });
    expect(h.internal._getSession('other').persistentProcess).toBe(h.spawned[0]);
    expect(await h.send('other')).toContainEqual({ type: 'text', content: 'continued original task' });
    expect(h.spawned).toHaveLength(4);
  });

  it('retains healthy Codex when an unrelated provider key changes and never logs synthetic credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-replacement-key');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(); await h.send();
    vi.stubEnv('MOONSHOT_API_KEY', 'synthetic-unrelated-key');
    await h.send(); expect(h.spawned).toHaveLength(1);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-revoked-key'); await h.send();
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toMatch(/synthetic-(replacement|revoked|unrelated)-key/);
  });

  it('reports twenty failed turns once each without hidden retry and recovers after credential replacement', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-revoked-key');
    const h = harness();
    for (let turn = 0; turn < 20; turn++) {
      expect((await h.send()).filter(chunk => chunk.type === 'error')).toHaveLength(1);
    }
    expect(h.read).toHaveBeenCalledTimes(20);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-replacement-key');
    expect(await h.send()).toContainEqual({ type: 'text', content: 'continued original task' });
    expect(h.read).toHaveBeenCalledTimes(21);
  });

  it('removing a previously accepted key does not keep using it through the old process', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-replacement-key');
    const h = harness(); await h.send(); vi.stubEnv('OPENAI_API_KEY', undefined);
    expect((await h.send()).filter(chunk => chunk.type === 'error')).toHaveLength(1);
    expect(h.spawned).toHaveLength(2);
  });
});
