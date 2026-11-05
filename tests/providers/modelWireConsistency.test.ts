import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/providers/ollama/OllamaProvider';
import { LocalAIProvider } from '../../src/providers/localai/LocalAIProvider';
import { MiniMaxProvider } from '../../src/providers/minimax/MiniMaxProvider';
import { TestableClineProvider, TestableOpenRouterProvider } from '../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../src/types';

const context = () => ({ subscriptions: [], secrets: createMockSecretStorage() } as unknown as vscode.ExtensionContext);
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners(); });
const base = { mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const cases = [
  { id: 'ollama', key: 'ollamaModel', make: () => new OllamaProvider(context()), configuredWins: false },
  { id: 'localai', key: 'localaiModel', make: () => new LocalAIProvider(context()), configuredWins: false },
  { id: 'minimax', key: 'minimaxModel', make: () => new MiniMaxProvider(context()), configuredWins: true },
];

function harness(testCase: typeof cases[number]) {
  const provider = testCase.make(); cleanups.push(() => provider.dispose());
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('fixture task');
  if (testCase.id === 'minimax') { vi.spyOn(provider as any, '_getApiKey').mockResolvedValue('synthetic-fixture-key'); }
  const bodies: Record<string, any>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.body) { bodies.push(JSON.parse(init.body)); }
    if (!init?.body) { return new Response(JSON.stringify({ models: [] })); }
    const answer = testCase.id === 'ollama'
      ? JSON.stringify({ message: { content: 'fixture answer' }, done: false }) + '\n' + JSON.stringify({ done: true }) + '\n'
      : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'fixture answer' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
    return new Response(answer);
  }));
  const send = async (settings: Settings) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('task', [], settings, null)) { chunks.push(chunk); }
    expect(chunks.some(chunk => chunk.type === 'text')).toBe(true);
    expect(chunks.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
    return bodies.at(-1)!;
  };
  return { provider, send };
}

describe('PC-04 reported effective models equal outgoing API requests', () => {
  it('MiniMax preserves the originating configured model while credential lookup is pending', async () => {
    const h = harness(cases[2]); setMockConfig('minimaxModel', 'original-model');
    let finish!: (key: string) => void;
    vi.mocked((h.provider as any)._getApiKey).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const settings = { ...base, provider: 'minimax', model: 'picker-model' } as Settings;
    const pending = h.send(settings); setMockConfig('minimaxModel', 'replacement-model'); finish('synthetic-fixture-key');
    expect((await pending).model).toBe('original-model');
    expect((await h.send(settings)).model).toBe('replacement-model');
  });

  it('OpenRouter preserves the originating configured model while prompt building is pending', async () => {
    const provider = new TestableOpenRouterProvider(); cleanups.push(() => provider.dispose());
    vi.spyOn(provider as any, '_getApiKey').mockReturnValue('synthetic-fixture-key');
    let finish!: (prompt: string) => void;
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('next task');
    const requested: string[] = [];
    provider.setClient({ streamChat: async function* (request: any) { requested.push(request.model); yield { text: 'answer' }; yield { done: true }; } } as any);
    const send = async () => { for await (const _chunk of provider.sendMessage('task', [], { ...base, provider: 'openrouter', model: 'picker-model' }, null)) { /* drain */ } };
    setMockConfig('openrouterModel', 'original-model'); const pending = send();
    setMockConfig('openrouterModel', 'replacement-model'); finish('original task'); await pending;
    await send(); expect(requested).toEqual(['original-model', 'replacement-model']);
  });

  for (const testCase of cases) {
    it(`${testCase.id}: attribution includes the configured fallback without a picker selection`, async () => {
      setMockConfig(testCase.key, 'configured-model'); const h = harness(testCase);
      const settings = { ...base, provider: testCase.id, model: '' } as Settings;
      expect((await h.send(settings)).model).toBe('configured-model');
      expect(h.provider.getEffectiveModelForSettings(settings)).toBe('configured-model');
    });

    it(`${testCase.id}: picker/configured precedence stays intact, and routed requests win`, async () => {
      setMockConfig(testCase.key, 'configured-model'); const h = harness(testCase);
      const settings = { ...base, provider: testCase.id, model: 'picker-model' } as Settings;
      const expected = testCase.configuredWins ? 'configured-model' : 'picker-model';
      expect((await h.send(settings)).model).toBe(expected);
      expect(h.provider.getEffectiveModelForSettings(settings)).toBe(expected);
      const routed = { ...settings, routedModel: 'routed-model' };
      expect((await h.send(routed)).model).toBe('routed-model');
      expect(h.provider.getEffectiveModelForSettings(routed)).toBe('routed-model');
    });
  }

  it('modern Cline honors its advertised custom override and explicit routed model', () => {
    const provider = new TestableClineProvider(); cleanups.push(() => provider.dispose());
    (provider as any)._cachedCliVersion = '3.0.61'; setMockConfig('clineModel', 'configured-model');
    const settings = { ...base, provider: 'cline', model: 'picker-model', mode: 'edit-automatically', accessLevel: 'full-access' } as Settings;
    const session = (provider as any)._getSession('panel');
    const configured = provider.buildCliArgs(settings, session);
    expect(configured[configured.indexOf('--model') + 1]).toBe('configured-model');
    expect(provider.getEffectiveModelForSettings(settings)).toBe('configured-model');
    const routed = provider.buildCliArgs({ ...settings, routedModel: 'routed-model' }, session);
    expect(routed[routed.indexOf('--model') + 1]).toBe('routed-model');
  });

  it('legacy Cline does not claim that a selected or configured model reached an unsupported CLI', () => {
    const provider = new TestableClineProvider(); cleanups.push(() => provider.dispose());
    (provider as any)._cachedCliVersion = '1.0.8'; setMockConfig('clineModel', 'configured-model');
    const settings = { ...base, provider: 'cline', model: 'picker-model', routedModel: 'routed-model' } as Settings;
    expect(provider.buildCliArgs(settings, (provider as any)._getSession('panel'))).not.toContain('--model');
    expect(provider.getEffectiveModelForSettings(settings)).toBeUndefined();
  });
});
