import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}), version: vi.fn() }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async () => ({ ...await vi.importActual<any>('../../../src/utils/processKill'), killProcessTree: mocks.kill }));
vi.mock('../../../src/utils/platform', async () => ({ ...await vi.importActual<any>('../../../src/utils/platform'), probeCliVersion: mocks.version }));

const settings = { provider: 'openai-codex', model: 'fixture-model', mode: 'quick-plan', accessLevel: 'read-only',
  thinkingLevel: 'none', contextMode: 'auto' } as Settings;
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function harness() {
  mocks.spawn.mockReset(); mocks.kill.mockClear(); mocks.version.mockReset();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-upgraded-cli-'));
  let binary = path.join(directory, 'CLI with spaces');
  fs.writeFileSync(binary, 'fixture executable version one');
  let version: string | undefined = 'codex-cli 1.0.0';
  mocks.version.mockImplementation(async () => version);
  const provider = new TestableCodexProvider(); const internal = provider as any;
  vi.spyOn(provider, 'getCliPath').mockImplementation(() => binary);
  vi.spyOn(provider, 'discoverCli').mockImplementation(() => internal._rememberCliPath(binary));
  vi.spyOn(internal, 'prepareAttachments').mockResolvedValue(async () => {});
  vi.spyOn(internal, 'buildPromptAsync').mockResolvedValue('continue the same task');
  const spawned: any[] = [];
  mocks.spawn.mockImplementation((executable: string) => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 6000 + spawned.length, exitCode: null, signalCode: null, killed: false,
      kill: vi.fn(() => true), executable, version,
    });
    spawned.push(proc); return proc;
  });
  const read = vi.spyOn(internal, '_readUntilBoundary').mockImplementation(async function* (proc: any, session: any) {
    session.sessionId = 'thread-to-resume';
    yield { type: 'text', content: proc.version || 'unknown version' };
    session.process = null;
  });
  const send = async (panel = 'panel') => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('continue', [], settings, null, undefined, panel)) { chunks.push(chunk); }
    return chunks;
  };
  cleanups.push(() => { provider.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { provider, internal, spawned, send, read, binary: () => binary,
    changeVersion: (next: string | undefined) => { version = next; },
    changePath: () => { binary = path.join(directory, 'Other CLI'); fs.writeFileSync(binary, 'new executable'); },
  };
}

describe('PC-02 upgraded CLI replaces warm processes on the next turn', () => {
  it('replaces an initially unversioned warm Codex process once when discovery settles and reuses its replacement', async () => {
    const h = harness();
    const firstVersion = deferred<string>();
    mocks.version.mockImplementationOnce(() => firstVersion.promise);
    const discovery = h.provider.discoverCli();
    const observations: unknown[] = [];
    const observe = (phase: string) => observations.push({
      phase, cachedVersion: h.internal._cachedCliVersion,
      cliGeneration: h.internal._cliGeneration,
      spawnCount: h.spawned.length, killCount: mocks.kill.mock.calls.length,
      currentPid: h.internal._getSession('panel').persistentProcess?.pid ?? null,
      persistentSettings: { ...h.internal._getSession('panel').persistentSettings },
    });
    try {
      await h.provider.preSpawnPersistentProcess('panel', settings);
      const original = h.spawned[0];
      observe('warm-before-first-version');
      firstVersion.resolve('codex-cli 1.0.0');
      await discovery;
      observe('first-version-resolved');
      await h.provider.preSpawnPersistentProcess('panel', settings);
      const replacement = h.spawned[1];
      observe('same-settings-prewarm');
      expect(await h.send()).toContainEqual({ type: 'text', content: 'codex-cli 1.0.0' });
      observe('public-send-completed');
      // First discovery adds runtime information that can affect invocation.
      // Preserve conservative invalidation, then reuse the resulting child.
      expect(h.spawned).toHaveLength(2);
      expect(mocks.kill).toHaveBeenCalledTimes(1);
      expect(mocks.kill.mock.calls[0]?.[0]).toBe(original);
      expect(replacement).not.toBe(original);
      expect(h.internal._getSession('panel').persistentProcess).toBe(replacement);
    } finally {
      firstVersion.resolve('codex-cli 1.0.0');
      await discovery;
      const receipt = process.env.PB02_INITIAL_DISCOVERY_RECEIPT;
      if (receipt) {
        expect(path.isAbsolute(receipt)).toBe(true);
        fs.appendFileSync(receipt, JSON.stringify({
          case: 'initial-version-after-prewarm', observations,
          spawnedPids: h.spawned.map(proc => proc.pid),
          disposedPidsBeforeFixtureCleanup: mocks.kill.mock.calls.map(call => (call[0] as any)?.pid),
          actualProviderChildren: 0, transport: 'existing mocked process and parser fixture',
        }) + '\n');
      }
    }
  });

  it('uses the newly discovered Codex version for the next answer and preserves its thread', async () => {
    const h = harness(); await h.provider.discoverCli();
    expect(await h.send()).toContainEqual({ type: 'text', content: 'codex-cli 1.0.0' });
    h.changeVersion('codex-cli 2.0.0'); await h.provider.discoverCli();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(await h.send()).toContainEqual({ type: 'text', content: 'codex-cli 2.0.0' });
    expect(mocks.kill.mock.calls[0]?.[0]).toBe(h.spawned[0]);
    expect(h.internal._getSession('panel').appServer.threadId).toBe('thread-to-resume');
    await h.send(); expect(h.spawned).toHaveLength(2);
  });

  it('does not reuse the old executable after a custom-path change with the same version', async () => {
    const h = harness(); await h.provider.discoverCli(); await h.send();
    h.changePath(); await h.provider.discoverCli(); await h.send();
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1].executable).toBe(h.binary());
  });

  it('detects a replaced executable even when the CLI does not return a version', async () => {
    const h = harness(); h.changeVersion(undefined); await h.provider.discoverCli(); await h.send();
    fs.writeFileSync(h.binary(), 'replacement executable with a different identity and length');
    await h.provider.discoverCli(); await h.send();
    expect(h.spawned).toHaveLength(2);
  });

  it('keeps an unchanged warm process across repeated discovery refreshes', async () => {
    const h = harness(); await h.provider.discoverCli(); await h.send();
    await h.provider.discoverCli(); await h.provider.preSpawnPersistentProcess('panel', settings); await h.send();
    expect(h.spawned).toHaveLength(1); expect(mocks.kill).not.toHaveBeenCalled();
  });

  it('lets an active response finish after refresh and prewarm, then upgrades the next turn', async () => {
    const h = harness(); const started = deferred<void>(); const finish = deferred<void>();
    h.read.mockImplementationOnce(async function* (proc: any, session: any) {
      started.resolve(); await finish.promise;
      yield { type: 'text', content: proc.version }; session.process = null;
    });
    await h.provider.discoverCli(); const active = h.send(); await started.promise;
    h.changeVersion('codex-cli 2.0.0'); await h.provider.discoverCli();
    await h.provider.preSpawnPersistentProcess('panel', settings);
    expect(h.spawned).toHaveLength(1); expect(mocks.kill).not.toHaveBeenCalled();
    finish.resolve(); expect(await active).toContainEqual({ type: 'text', content: 'codex-cli 1.0.0' });
    expect(await h.send()).toContainEqual({ type: 'text', content: 'codex-cli 2.0.0' });
  });

  it('replaces each warmed panel when that panel next sends, without discarding other sessions', async () => {
    const h = harness(); await h.provider.discoverCli(); await h.send('a'); await h.send('b');
    h.changeVersion('codex-cli 2.0.0'); await h.provider.discoverCli();
    await h.send('a'); expect(h.spawned).toHaveLength(3);
    expect(h.internal._getSession('b').persistentProcess).toBe(h.spawned[1]);
    expect(await h.send('b')).toContainEqual({ type: 'text', content: 'codex-cli 2.0.0' });
    expect(h.spawned).toHaveLength(4);
    expect(h.internal._getSession('b').appServer.threadId).toBe('thread-to-resume');
  });
});
