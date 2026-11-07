import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { writeFileSync } from 'node:fs';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifest } from '../../src/providers/base/ProviderManifest';
import { OllamaProvider } from '../../src/providers/ollama/OllamaProvider';
import { LocalAIProvider } from '../../src/providers/localai/LocalAIProvider';
import { TestableCopilotProvider } from '../helpers/providerFactory';
import { clearMockConfig, createMockSecretStorage, setMockConfig } from '../helpers/mockVscode';
import type { Settings } from '../../src/types';

const ids = ['claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot', 'cursor', 'openclaw', 'opencode',
  'ollama', 'localai', 'qwen-code', 'hermes', 'continue', 'openrouter', 'minimax', 'kimi-code'];
const context = () => ({ subscriptions: [], secrets: createMockSecretStorage(), globalState: { get: () => undefined, update: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext);
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); clearMockConfig(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PC-12 real adapter capability truthfulness', () => {
  it('captures all 16 actual adapters and the OpenCode transport transition without enabling dormant or pseudo agents', () => {
    const registry = new ProviderRegistry(context()); cleanup.push(() => registry.dispose());
    const cli = buildProviderManifest(registry);
    expect(cli.map(entry => entry.id).sort()).toEqual([...ids].sort());
    expect(cli.some(entry => ['manus', 'mysti', 'brainstorm'].includes(entry.id))).toBe(false);
    expect(cli.find(entry => entry.id === 'minimax')!.capabilities).toMatchObject({ supportsToolUse: false, planMode: 'none', supportsImages: false });
    for (const entry of cli) {
      expect(entry.capabilities.supportsStreaming).toBe(true);
      expect(entry.capabilities.supportsSteering).not.toBe(true);
      // Every adapter governs reasoning natively (effort/model); none enforces a Mysti token budget.
      expect(entry.capabilities.thinkingLevelEffective).toBe(false);
      if (!entry.capabilities.emitsUsage) expect(entry.capabilities.usageConvention).toBe('none');
    }
    setMockConfig('opencodeEndpoint', 'http://127.0.0.1:43123');
    const remote = buildProviderManifest(registry).find(entry => entry.id === 'opencode')!;
    expect(remote.capabilities).toMatchObject({ supportsNativeApproval: true, supportsImages: false, supportsFileAttachments: false,
      supportsAutoInstall: false, sessionKind: 'prompt-history', modelSelection: 'full', emitsUsage: false });
    setMockConfig('opencodeEndpoint', '');
    expect(buildProviderManifest(registry).find(entry => entry.id === 'opencode')!.capabilities).toEqual(cli.find(entry => entry.id === 'opencode')!.capabilities);
    if (process.env.PC12_CAPABILITY_LEDGER) writeFileSync(process.env.PC12_CAPABILITY_LEDGER, JSON.stringify({
      source: 'Actual ProviderRegistry constructors; no discovery, authentication or inference executed.',
      cli: cli.map(({ id, defaultModel, capabilities }) => ({ id, defaultModel, capabilities })),
      opencodeRemote: remote.capabilities,
    }, null, 2));
  });

  it('Copilot Auto declares no effort control while explicit models inherit the real wire tiers', () => {
    const provider = new TestableCopilotProvider(); cleanup.push(() => provider.dispose());
    const caps = provider.capabilities;
    expect((caps as any).effortLevelsByModel?.auto).toEqual([]);
    const settings = { mode: 'quick-plan', accessLevel: 'read-only', provider: provider.id, thinkingLevel: 'none', contextMode: 'manual' } as Settings;
    for (const effortLevel of caps.effortLevels!) {
      const session = (provider as any)._getSession('panel');
      expect(provider.buildCliArgs({ ...settings, model: 'auto', effortLevel }, session)).not.toContain('--effort');
      const args = provider.buildCliArgs({ ...settings, model: 'gpt-5.4', effortLevel }, session);
      expect(args[args.indexOf('--effort') + 1]).toBe(effortLevel);
    }
  });

  it.each([['ollama', OllamaProvider], ['localai', LocalAIProvider]] as const)('%s tool requests remain proposals without fabricated execution results', async (id, Provider) => {
    const provider = new Provider(context()); cleanup.push(() => provider.dispose());
    expect((provider.capabilities as any).toolCallsAreProposals).toBe(true);
    vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Review a proposed edit without executing it.');
    const input = { file_path: '/owned/canary.txt', old_string: 'before', new_string: 'after' };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      if (!init?.body) return new Response(JSON.stringify({ models: [], data: [] }));
      return new Response(id === 'ollama'
        ? JSON.stringify({ message: { tool_calls: [{ function: { name: 'Edit', arguments: input } }] }, done: false }) + '\n' + JSON.stringify({ done: true }) + '\n'
        : 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'proposal', function: { name: 'Edit', arguments: JSON.stringify(input) } }] } }] }) + '\n\ndata: [DONE]\n\n');
    }));
    const out = [];
    for await (const event of provider.sendMessage('task', [], { provider: id, mode: 'ask-before-edit', accessLevel: 'ask-permission',
      thinkingLevel: 'none', contextMode: 'manual', model: 'controlled-model' }, null)) out.push(event);
    expect(out.filter(event => event.type === 'tool_use')).toEqual([expect.objectContaining({ toolCall: expect.objectContaining({
      name: 'Edit', input, status: 'proposed', proposalOnly: true,
    }) })]);
    expect(out.some(event => event.type === 'tool_result' || event.type === 'error')).toBe(false);
  });
});
