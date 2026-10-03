import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
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
      ? { healthy: true, version: 'fixture' } : { connected: ['vendor'], all: [] }))));
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
});
