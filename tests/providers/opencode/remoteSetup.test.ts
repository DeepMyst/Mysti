import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { registerOpenCodeRemoteSetup } from '../../../src/providers/opencode/setup';
import { fireConfigurationChange } from '../../helpers/mockVscode';
import type { ProviderManager } from '../../../src/managers/ProviderManager';
import { OpenCodeProvider } from '../../../src/providers/opencode/OpenCodeProvider';
import { remoteConnection, remoteSecretKey } from '../../../src/providers/opencode/OpenCodeRemote';
import { clearMockConfig, setMockConfig, createMockSecretStorage, window } from '../../helpers/mockVscode';

let provider: OpenCodeProvider;
let secrets: ReturnType<typeof createMockSecretStorage>;
beforeEach(() => {
  clearMockConfig(); secrets = createMockSecretStorage();
  provider = new OpenCodeProvider({ subscriptions: [], secrets } as unknown as vscode.ExtensionContext);
});
afterEach(() => { provider.dispose(); clearMockConfig(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('OpenCode remote setup', () => {
  it('refreshes provider status and models after direct endpoint settings changes', async () => {
    const refresh = vi.fn(async () => {});
    const subscriptions: Array<{ dispose(): void }> = [];
    registerOpenCodeRemoteSetup({ subscriptions } as unknown as vscode.ExtensionContext, {} as ProviderManager, refresh);
    try {
      fireConfigurationChange('mysti.opencodeEndpoint');
      expect(refresh).toHaveBeenCalledOnce();
      fireConfigurationChange('mysti.defaultModel');
      expect(refresh).toHaveBeenCalledOnce();
    } finally { subscriptions.forEach(s => s.dispose()); }
  });

  it('keeps local CLI behavior until an endpoint is configured', () => {
    expect(provider.configureAuthentication).toBeUndefined();
    expect(provider.capabilities.supportsAutoInstall).toBe(true);
    setMockConfig('opencodeEndpoint', 'http://localhost:4096');
    expect(provider.capabilities.supportsNativeApproval).toBe(true);
    expect(provider.capabilities.supportsAutoInstall).toBe(false);
    expect(provider.capabilities.supportsFileAttachments).toBe(false);
    expect(provider.getSlashCommands()).toEqual([]);
  });
  it('is available without a local CLI and stores a server password separately', async () => {
    setMockConfig('opencodeEndpoint', 'http://localhost:4096');
    vi.spyOn(window, 'showInputBox').mockResolvedValue('server-password');
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(JSON.stringify(url.pathname.endsWith('/health')
      ? { healthy: true, version: 'fixture' } : { providers: [{ id: 'vendor', models: {} }] }))));
    expect(await provider.discoverCli()).toEqual({ found: true, path: 'http://localhost:4096' });
    expect((await provider.configureAuthentication!()).authenticated).toBe(true);
    expect(await secrets.get(remoteSecretKey(remoteConnection('http://localhost:4096')))).toBe('server-password');
    expect(await secrets.get(remoteSecretKey(remoteConnection('http://localhost:4097')))).toBeUndefined();
  });
  it('reports an unreachable server instead of claiming successful authentication', async () => {
    setMockConfig('opencodeEndpoint', 'http://localhost:4096');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connection refused'); }));
    expect(await provider.checkAuthentication()).toEqual({ authenticated: false, error: 'Connection refused' });
  });
  it.each(['late-password', ''])('does not change the server credential after setup closes (late value %j)', async value => {
    setMockConfig('opencodeEndpoint', 'http://localhost:4096');
    const key = remoteSecretKey(remoteConnection('http://localhost:4096'));
    await secrets.store(key, 'keep-existing-password');
    const controller = new AbortController();
    let finishPrompt!: (value: string) => void;
    vi.spyOn(window, 'showInputBox').mockReturnValue(new Promise(resolve => { finishPrompt = resolve; }));
    const store = vi.spyOn(secrets, 'store');
    const remove = vi.spyOn(secrets, 'delete');
    const check = vi.spyOn(provider, 'checkAuthentication');
    const pending = provider.configureAuthentication!(controller.signal);
    controller.abort();
    finishPrompt(value);
    expect((await pending).authenticated).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(await secrets.get(key)).toBe('keep-existing-password');
  });
});
