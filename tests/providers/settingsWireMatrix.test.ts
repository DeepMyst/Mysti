import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { OllamaProvider } from '../../src/providers/ollama/OllamaProvider';
import { LocalAIProvider } from '../../src/providers/localai/LocalAIProvider';
import { MiniMaxProvider } from '../../src/providers/minimax/MiniMaxProvider';
import * as factory from '../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage } from '../helpers/mockVscode';
import { codexAppServerInput, handleCodexAppServer } from '../../src/providers/codex/CodexAppServerProtocol';
import type { EffortLevel, Settings } from '../../src/types';

const levels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const base = { mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearMockConfig(); clearConfigurationListeners(); });
const own = <T extends { dispose(): void }>(provider: T): T => { cleanups.push(() => provider.dispose()); return provider; };
const context = () => ({ subscriptions: [], secrets: createMockSecretStorage() } as unknown as vscode.ExtensionContext);

describe('PC-04 complete declared effort/thinking wire matrix', () => {
  for (const level of levels) {
    it(`Claude serializes ${level} effort independently from Ultracode and thinking`, () => {
      const provider = own(new factory.TestableClaudeProvider()); (provider as any)._cachedCliVersion = '2.1.286';
      for (const ultracode of [false, true]) {
        const settings = { ...base, model: provider.config.defaultModel, effortLevel: level, thinkingLevel: 'high', ultracode } as Settings;
        const args = provider.buildPersistentCliArgs(settings, (provider as any)._getSession('panel'))!;
        expect(args[args.indexOf('--effort') + 1]).toBe(level);
        expect(JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'))).toEqual({ ultracode });
        expect((provider as any).getThinkingTokens(settings.thinkingLevel)).toBe(16000);
      }
    });

    it(`Codex transmits ${level} effort and the routed model in native thread/turn RPC`, () => {
      const provider = own(new factory.TestableCodexProvider()); const session = (provider as any)._getSession('panel');
      provider.buildPersistentCliArgs({ ...base, routedModel: 'requested-codex-model', effortLevel: level }, session);
      const state = session.appServer; const sent: any[] = [];
      const proc = { stdin: { writable: true, destroyed: false, write: (line: string) => sent.push(JSON.parse(line)) } } as any;
      const init = JSON.parse(codexAppServerInput(state, 'original task'));
      handleCodexAppServer({ id: init.id, result: {} }, state, proc, undefined);
      const config = sent.at(-1); handleCodexAppServer({ id: config.id, result: { config: {} } }, state, proc, undefined);
      const start = sent.at(-1);
      expect(start.params.model).toBe('requested-codex-model');
      expect(start.params.config.model_reasoning_effort).toBe(level === 'max' ? 'xhigh' : level);
      handleCodexAppServer({ id: start.id, result: { thread: { id: 'thread' } } }, state, proc, undefined);
      expect(sent.at(-1)).toMatchObject({ method: 'turn/start', params: { effort: level === 'max' ? 'xhigh' : level } });
    });

    it(`Copilot transmits ${level} for an explicit model and omits effort with Auto`, () => {
      const provider = own(new factory.TestableCopilotProvider()); const session = (provider as any)._getSession('panel');
      const args = provider.buildCliArgs({ ...base, model: 'gpt-5.4', effortLevel: level }, session);
      expect(args[args.indexOf('--effort') + 1]).toBe(level === 'max' ? 'xhigh' : level);
      expect(provider.buildCliArgs({ ...base, model: 'auto', effortLevel: level }, session)).not.toContain('--effort');
    });
  }

  const apiCases = [
    { id: 'ollama', make: () => new OllamaProvider(context()), expected: ['low', 'medium', 'high', 'high', 'high'], field: 'think' },
    { id: 'localai', make: () => new LocalAIProvider(context()), expected: ['low', 'medium', 'high', 'high', 'high'], field: 'reasoning_effort' },
    { id: 'openrouter', make: () => new factory.TestableOpenRouterProvider(), expected: ['low', 'medium', 'high', 'high', 'high'], field: 'reasoning' },
    { id: 'minimax', make: () => new MiniMaxProvider(context()), expected: [undefined, undefined, undefined, undefined, undefined], field: 'reasoning_effort' },
  ];
  for (const testCase of apiCases) {
    it(`${testCase.id}: supported effort reaches HTTP and unset/unsupported controls are omitted`, async () => {
      const provider = own(testCase.make()); const bodies: any[] = [];
      const modelLookups: unknown[] = [];
      vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('task');
      vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-fixture-key');
      if (testCase.id === 'minimax') { vi.spyOn(provider as any, '_getApiKey').mockResolvedValue('synthetic-fixture-key'); }
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        if (testCase.id === 'ollama' && String(_url).endsWith('/api/show')) {
          modelLookups.push(JSON.parse(init.body));
          return new Response(JSON.stringify({
            capabilities: ['completion', 'thinking'],
            thinking: { values: ['low', 'medium', 'high'], default: 'medium' },
          }));
        }
        if (!init?.body) { return new Response(JSON.stringify({ models: [], data: [] })); }
        bodies.push(JSON.parse(init.body));
        return new Response(testCase.id === 'ollama'
          ? JSON.stringify({ message: { content: 'answer' }, done: false }) + '\n' + JSON.stringify({ done: true }) + '\n'
          : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      }));
      for (const effortLevel of [...levels, undefined]) {
        const lookupsBefore = modelLookups.length;
        const out = [];
        for await (const chunk of provider.sendMessage('task', [], { ...base, routedModel: 'requested-model', effortLevel }, null)) { out.push(chunk); }
        expect(out.some(chunk => chunk.type === 'text')).toBe(true);
        expect(out.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
        const body = bodies.at(-1); expect(body.model).toBe('requested-model');
        const expected = effortLevel === undefined ? undefined : testCase.expected[levels.indexOf(effortLevel)];
        expect(testCase.field === 'reasoning' ? body.reasoning?.effort : body[testCase.field]).toBe(expected);
        if (testCase.id === 'ollama') {
          expect(modelLookups.length - lookupsBefore).toBe(effortLevel === undefined ? 0 : 1);
        }
      }
      if (testCase.id === 'ollama') {
        expect(modelLookups).toEqual(levels.map(() => ({ model: 'requested-model' })));
        expect(bodies).toHaveLength(6);
      }
    });
  }

  const noEffort = [factory.TestableGeminiProvider, factory.TestableCursorProvider, factory.TestableOpenClawProvider,
    factory.TestableOpenCodeProvider, factory.TestableQwenProvider, factory.TestableHermesProvider,
    factory.TestableContinueProvider, factory.TestableKimiProvider];
  for (const Provider of noEffort) {
    it(`${Provider.name}: unsupported effort/thinking do not become CLI controls`, () => {
      const provider = own(new Provider()); const session = (provider as any)._getSession('panel');
      const settings = { ...base, model: '', effortLevel: 'max', thinkingLevel: 'high' } as Settings;
      if (provider.id === 'opencode' || provider.id === 'qwen-code') { settings.mode = 'edit-automatically'; settings.accessLevel = 'full-access'; }
      const args = provider.buildCliArgs(settings, session);
      expect(args).not.toContain('--effort');
      // OpenCode's fixed --thinking renders reasoning; it is not a level
      // selection. OpenClaw already has a separate legacy --thinking mapping.
      if (provider.id !== 'opencode' && provider.id !== 'openclaw') { expect(args).not.toContain('--thinking'); }
      if (provider.id !== 'qwen-code') { expect((provider as any).getThinkingTokens('high')).toBeUndefined(); }
      // Qwen's inherited budget helper is ignored by Base because the
      // capability is false; persistentSettingsTransitions tests actual env.
    });
  }

  it('Cline preserves legacy Plan and refuses unsupported modern constrained modes before serialization', () => {
    const provider = own(new factory.TestableClineProvider()); const session = (provider as any)._getSession('panel');
    for (const version of ['1.0.8', '3.0.61']) {
      (provider as any)._cachedCliVersion = version;
      for (const mode of ['quick-plan', 'detailed-plan', 'default', 'edit-automatically'] as const) {
        for (const accessLevel of ['read-only', 'full-access'] as const) {
          const plan = accessLevel === 'read-only' || mode.endsWith('-plan');
          const settings = { ...base, mode, accessLevel, effortLevel: 'max' } as Settings;
          if (!version.startsWith('1.') && plan) {
            expect(() => provider.buildCliArgs(settings, session)).toThrow(/cannot use Plan or Read Only safely/);
            continue;
          }
          const args = provider.buildCliArgs(settings, session);
          expect(args).not.toContain('--effort');
          if (version.startsWith('1.')) { expect(args[args.indexOf('--mode') + 1]).toBe(plan ? 'plan' : 'act'); expect(args.includes('--yolo')).toBe(!plan); }
          else {
            expect(args).not.toContain('--plan');
            expect(args.slice(args.indexOf('--auto-approve'), args.indexOf('--auto-approve') + 2))
              .toEqual(['--auto-approve', 'true']);
          }
        }
      }
    }
  });
});
