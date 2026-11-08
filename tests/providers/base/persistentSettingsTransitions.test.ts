import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider, TestableClineProvider, TestableCodexProvider, TestableHermesProvider, TestableKimiProvider, TestableQwenProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async () => ({ ...await vi.importActual<any>('../../../src/utils/processKill'), killProcessTree: mocks.kill }));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig(); clearConfigurationListeners(); });
function harness(provider = new TestableCodexProvider() as any) {
  mocks.spawn.mockReset(); mocks.kill.mockClear(); vi.stubEnv('MAX_THINKING_TOKENS', undefined);
  const internal = provider as any; internal._cachedCliVersion = provider.id === 'claude-code' ? '2.1.286' : '1.0.0';
  const base = { provider: provider.id, model: provider.config.defaultModel, mode: 'quick-plan', accessLevel: 'read-only',
    thinkingLevel: 'none', contextMode: 'manual', effortLevel: 'high' } as Settings;
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/fixture/selected-cli');
  vi.spyOn(internal, 'prepareAttachments').mockResolvedValue(async () => {});
  vi.spyOn(internal, 'buildPromptAsync').mockResolvedValue('continue original task');
  const children: any[] = [];
  mocks.spawn.mockImplementation((_file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 6700 + children.length, exitCode: null, signalCode: null, killed: false, args, thinkingTokens: options.env.MAX_THINKING_TOKENS });
    children.push(child); return child;
  });
  vi.spyOn(internal, '_readUntilBoundary').mockImplementation(async function* (_proc: any, session: any) {
    session.sessionId = 'original-task'; yield { type: 'text', content: 'continued task' }; session.process = null;
  });
  const send = async (overrides: Partial<Settings> = {}) => {
    const out: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('continue', [], { ...base, ...overrides }, null, undefined, 'panel')) { out.push(chunk); }
    expect(out).toContainEqual({ type: 'text', content: 'continued task' });
  };
  cleanups.push(() => provider.dispose()); return { provider, internal, children, send, base };
}

describe('PC-04 settings transitions follow effective runtime controls', () => {
  for (const version of ['1.0.8', '3.0.61']) {
    it(`Cline ${version} declares thinking levels ineffective when real requests ignore the setting`, async () => {
      const h = harness(new TestableClineProvider());
      h.internal._cachedCliVersion = version;
      vi.spyOn(h.internal, 'buildAgentInstructionsAsync').mockResolvedValue('');
      vi.spyOn(h.internal, 'processStream').mockImplementation(async function* () { yield { type: 'text', content: 'continued task' }; });
      // Modern Cline refuses read-only before transport; use its explicitly
      // supported authority to test whether thinking affects real spawn args.
      const authority: Partial<Settings> = version === '3.0.61'
        ? { mode: 'edit-automatically', accessLevel: 'full-access' } : {};
      await h.send({ ...authority, thinkingLevel: 'none' });
      await h.send({ ...authority, thinkingLevel: 'high' });
      expect(h.children).toHaveLength(2);
      expect(h.children[0].args).toEqual(h.children[1].args);
      expect(h.children.map(child => child.thinkingTokens)).toEqual([undefined, undefined]);
      expect(h.provider.capabilities.thinkingLevelEffective).toBe(false);
    });
  }

  it('does not export an ineffective thinking budget to Qwen after switching from a thinking-capable backend', async () => {
    const h = harness(new TestableQwenProvider());
    h.base.mode = 'edit-automatically'; h.base.accessLevel = 'full-access';
    vi.spyOn(h.internal, 'processStream').mockImplementation(async function* () { yield { type: 'text', content: 'continued task' }; });
    await h.send({ thinkingLevel: 'high' });
    expect(h.children[0].thinkingTokens).toBeUndefined();
  });

  for (const [label, make] of [
    ['Codex', () => new TestableCodexProvider()], ['Hermes', () => new TestableHermesProvider()], ['Kimi', () => new TestableKimiProvider()],
  ] as const) {
    it(`${label}: changing an ineffective thinking setting preserves the warmed conversation`, async () => {
      const h = harness(make());
      // Exercise Kimi's supported transport, independently of mode admission.
      if (h.provider.id === 'kimi-code') { h.base.mode = 'edit-automatically'; h.base.accessLevel = 'full-access'; }
      await h.send(); const original = h.children[0];
      for (const thinkingLevel of ['low', 'medium', 'high', 'none'] as const) { await h.send({ thinkingLevel }); }
      expect(h.children).toHaveLength(1); expect(mocks.kill).not.toHaveBeenCalled();
      expect(h.internal._getSession('panel').persistentProcess).toBe(original);
      expect(original.thinkingTokens).toBeUndefined();
    });
  }

  it('Codex does not respawn when xhigh→max maps to the same supported effort', async () => {
    const h = harness(); await h.send({ effortLevel: 'xhigh' }); await h.send({ effortLevel: 'max' });
    expect(h.internal._getSession('panel').appServer.effort).toBe('xhigh');
    expect(h.children).toHaveLength(1);
  });

  it('Claude leaves reasoning to --effort: thinking levels add no budget and do not respawn the process', async () => {
    const h = harness(new TestableClaudeProvider());
    for (const thinkingLevel of ['none', 'low', 'medium', 'high', 'none'] as const) {
      await h.send({ thinkingLevel }); expect(h.children.at(-1).thinkingTokens).toBeUndefined();
    }
    expect(h.children).toHaveLength(1);
  });

  it('Codex changes the selected profile on the next turn and preserves native thread continuation', async () => {
    const h = harness(); setMockConfig('codexProfile', 'profile-one'); await h.send();
    expect(h.children[0].args.slice(0, 2)).toEqual(['--profile', 'profile-one']);
    setMockConfig('codexProfile', 'profile-two'); await h.send();
    expect(h.children[1].args.slice(0, 2)).toEqual(['--profile', 'profile-two']);
    expect(h.internal._getSession('panel').appServer.threadId).toBe('original-task');
    await h.send(); expect(h.children).toHaveLength(2);
  });

  it('keeps 100 successive model/effort selections aligned with the process that handles each turn', async () => {
    const h = harness(); const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (let index = 0; index < 100; index++) {
      const routedModel = `routed-model-${index}`; const effortLevel = effortLevels[index % effortLevels.length];
      await h.send({ routedModel, effortLevel });
      const state = h.internal._getSession('panel').appServer;
      expect(state.model).toBe(routedModel); expect(state.effort).toBe(effortLevel === 'max' ? 'xhigh' : effortLevel);
      if (index > 0) { expect(state.threadId).toBe('original-task'); }
    }
    expect(h.children).toHaveLength(100);
  });

  it('defers 30 pending-turn model/effort changes until the next turn without interrupting initialization', async () => {
    const h = harness();
    for (let index = 0; index < 30; index++) {
      let finish!: (value: string) => void; let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      vi.mocked(h.internal.buildPromptAsync).mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
      setMockConfig('codexModel', `original-model-${index}`);
      const pending = h.send({ effortLevel: 'high' }); await ready;
      const originalProcess = h.internal._getSession('panel').persistentProcess;
      setMockConfig('codexModel', `replacement-model-${index}`);
      await h.provider.preSpawnPersistentProcess('panel', { ...h.base, effortLevel: 'low' });
      expect(h.internal._getSession('panel').persistentProcess).toBe(originalProcess);
      expect(h.internal._getSession('panel').appServer).toMatchObject({ model: `original-model-${index}`, effort: 'high' });
      finish('originating prompt'); await pending;
      await h.send({ effortLevel: 'low' });
      expect(h.internal._getSession('panel').appServer).toMatchObject({ model: `replacement-model-${index}`, effort: 'low', threadId: 'original-task' });
    }
    expect(h.children).toHaveLength(60);
  });
});
