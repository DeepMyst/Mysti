import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { createCodexSession } from '../../helpers/sessionFactory';
import { clearMockConfig, createMockMemento, setMockConfig } from '../../helpers/mockVscode';
import { ModelRegistryService } from '../../../src/services/ModelRegistryService';
import type { Settings } from '../../../src/types';
const base: Settings = { mode: 'ask-before-edit', accessLevel: 'ask-permission', provider: 'openai-codex', model: '', thinkingLevel: 'none', contextMode: 'manual' };
beforeEach(clearMockConfig);
describe('Codex catalog selection reaches the app-server', () => {
  it('passes the selected provider-scoped custom catalog entry and explicit default', () => {
    const provider = new TestableCodexProvider();
    setMockConfig('customModels', { 'openai-codex': ['my-codex-model'], 'claude-code': ['other-model'] });
    const registry = new ModelRegistryService({ globalState: createMockMemento() } as unknown as ExtensionContext);
    registry.setProviderSource({ getProvider: () => provider.config, getAllProviderIds: () => [provider.id], getProviderInstance: () => undefined });
    const selected = registry.getModels(provider.id, { revalidate: false }).models.find(model => model.id === 'my-codex-model');
    expect(selected).toBeDefined();
    const session = createCodexSession();
    provider.buildPersistentCliArgs({ ...base, model: selected!.id }, session);
    expect(session.appServer?.model).toBe('my-codex-model');
    provider.buildPersistentCliArgs({ ...base, model: provider.config.defaultModel }, session);
    expect(session.appServer?.model).toBe(provider.config.defaultModel);
    provider.buildPersistentCliArgs({ ...base, model: 'other-model' }, session);
    expect(session.appServer?.model).toBe(provider.config.defaultModel);
    registry.dispose(); provider.dispose();
  });
});
