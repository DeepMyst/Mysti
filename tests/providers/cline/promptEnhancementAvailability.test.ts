import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager, PromptEnhancementUnsupportedError } from '../../../src/managers/ProviderManager';
import { buildProviderManifest } from '../../../src/providers/base/ProviderManifest';
import type { ICliProvider } from '../../../src/providers/base/IProvider';
import { clearConfigurationListeners, clearMockConfig, getMockConfigUpdates, setMockConfig } from '../../helpers/mockVscode';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async () => ({ ...await vi.importActual<typeof import('child_process')>('child_process'), spawn: mocks.spawn }));
const chat = fs.readFileSync(path.resolve(__dirname, '../../../media/chat/chat.js'), 'utf8');
let manager: ProviderManager;

function extractFunction(name: string): string {
  const start = chat.indexOf(`function ${name}(`);
  if (start < 0) { throw new Error(`Missing public affordance function ${name}`); }
  let depth = 0;
  for (let i = chat.indexOf('{', start); i < chat.length; i++) {
    if (chat[i] === '{') { depth++; }
    if (chat[i] === '}' && --depth === 0) { return chat.slice(start, i + 1); }
  }
  throw new Error(`Unbalanced public affordance function ${name}`);
}

function selectProviders(ids: string[]) {
  const registry = manager.getRegistry();
  const providers = ids.map(id => {
    const provider = registry.get(id);
    if (!provider) { throw new Error(`Missing actual registered provider ${id}`); }
    return provider;
  });
  vi.spyOn(registry, 'getAll').mockReturnValue(providers);
  return providers;
}

function button(providers: ICliProvider[], installed: string[]) {
  const state = {
    settings: { provider: 'cline' },
    providerManifest: { providers: buildProviderManifest({ getAll: () => providers }) },
    providerAvailability: Object.fromEntries(installed.map(id => [id, { available: true }])),
  };
  const enhanceBtn = { disabled: false, title: '', classList: { contains: () => false } };
  const execute = new Function('state', 'enhanceBtn', `${extractFunction('resolveEnhanceProvider')}\n${extractFunction('updateEnhanceAffordance')}\nupdateEnhanceAffordance();return {resolved:resolveEnhanceProvider(),button:enhanceBtn};`);
  return execute(state, enhanceBtn) as { resolved: { id: string | null; fallback: boolean; unavailable?: boolean }; button: typeof enhanceBtn };
}

beforeEach(() => {
  clearMockConfig(); setMockConfig('defaultProvider', 'cline');
  mocks.spawn.mockReset().mockImplementation(() => { throw new Error('Unexpected Cline enhancement process'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const context = {
    subscriptions: [], extensionPath: '/synthetic/extension', extensionUri: vscode.Uri.file('/synthetic/extension'),
    globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
    workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
  } as unknown as vscode.ExtensionContext;
  manager = new ProviderManager(context);
});

afterEach(() => {
  manager.dispose(); vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});

describe('Cline prompt enhancement is unavailable without a qualified text-only CLI', () => {
  it.each([null, 'version unavailable', '1.0.8', '3.0.61'])('keeps the actual manifest and optional method consistent for version %s', version => {
    const [cline] = selectProviders(['cline']);
    (cline as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = version;
    expect(buildProviderManifest({ getAll: () => [cline] })[0].capabilities.supportsPromptEnhancement).toBe(false);
    expect(cline.enhancePrompt).toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a public manager request for active Cline without spawning when no fallback exists', async () => {
    selectProviders(['cline']);
    await expect(manager.enhancePrompt('Keep this draft', 'cline')).rejects.toBeInstanceOf(PromptEnhancementUnsupportedError);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(getMockConfigUpdates()).toEqual({});
  });

  it('does not select Cline as an enhancement fallback for another provider', async () => {
    const [, cline] = selectProviders(['qwen-code', 'cline']);
    const discover = vi.spyOn(cline, 'discoverCli').mockResolvedValue({ found: true, path: '/synthetic/cline' });
    await expect(manager.enhancePrompt('Keep this draft', 'qwen-code')).rejects.toBeInstanceOf(PromptEnhancementUnsupportedError);
    expect(discover).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('disables the actual UI affordance for Cline when no capable backend is installed', () => {
    const providers = selectProviders(['cline', 'claude-code']);
    const actual = button(providers, ['cline']);
    expect(actual.resolved).toMatchObject({ id: null, unavailable: true });
    expect(actual.button.disabled).toBe(true);
    expect(actual.button.title).toContain('Cline cannot enhance prompts');
  });

  it('names the same installed fallback in the public UI and manager result without spawning Cline', async () => {
    const providers = selectProviders(['cline', 'claude-code']);
    const fallback = providers[1];
    vi.spyOn(fallback, 'discoverCli').mockResolvedValue({ found: true, path: '/synthetic/claude' });
    // This tests routing/attribution only. The existing backend's real tool authority is not exercised or claimed safe.
    const enhance = vi.spyOn(fallback, 'enhancePrompt').mockResolvedValue('Clarified draft');
    const actual = button(providers, ['cline', 'claude-code']);
    expect(actual.resolved).toMatchObject({ id: fallback.id, fallback: true });
    expect(actual.button.disabled).toBe(false);
    const displayName = buildProviderManifest({ getAll: () => providers }).find(entry => entry.id === fallback.id)!.displayName;
    expect(actual.button.title).toBe(`Enhance prompt (via ${displayName})`);
    expect(await manager.enhancePrompt('Original draft', 'cline')).toEqual({
      prompt: 'Clarified draft', enhancedBy: fallback.displayName, enhancedById: fallback.id, fallback: true, changed: true,
    });
    expect(enhance).toHaveBeenCalledExactlyOnceWith('Original draft');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(getMockConfigUpdates()).toEqual({});
  });
});
