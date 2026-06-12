/**
 * LocalAI discovery tests (Plan 03 Phase 2, task 5):
 * 1s probe timeout, and the module-level TTL skip that avoids network I/O
 * during background init after a recent failed probe of the default endpoint.
 * The wizard/first-use path (direct discoverCli()) must never hit the skip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { LocalAIProvider, resetLocalAIDiscoveryCache } from '../../../src/providers/localai/LocalAIProvider';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
      setKeysForSync: () => {},
    },
    workspaceState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
    },
    extensionPath: '/mock/extension',
    extensionUri: vscode.Uri.file('/mock/extension'),
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global-storage'),
    logUri: vscode.Uri.file('/mock/logs'),
    extensionMode: 1,
    extension: {} as any,
    environmentVariableCollection: {} as any,
    secrets: {} as any,
    languageModelAccessInformation: {} as any,
  } as unknown as vscode.ExtensionContext;
}

describe('LocalAIProvider discovery', () => {
  let provider: LocalAIProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearMockConfig();
    resetLocalAIDiscoveryCache();
    provider = new LocalAIProvider(createMockContext());
    fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetLocalAIDiscoveryCache();
    clearMockConfig();
  });

  it('probes with a 1s timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await provider.discoverCli();

    expect(timeoutSpy).toHaveBeenCalledWith(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8080/v1/models');
  });

  it('sends the configured API key on discovery probes', async () => {
    setMockConfig('localaiApiKey', 'secret-key');

    await provider.discoverCli();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-key');
  });

  it('skips the init probe when the default endpoint failed within the TTL', async () => {
    await provider.initialize(); // probe fails, failure timestamp recorded
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await provider.initialize(); // within TTL — no network I/O
    await provider.initialize();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.getCliPath()).toBe('http://localhost:8080');
  });

  it('does not skip a direct discoverCli() call (wizard / first-use path)', async () => {
    await provider.initialize(); // records the failure
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const result = await provider.discoverCli(); // wizard refresh — real probe
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(false);
  });

  it('honors force=true even during init-style flows', async () => {
    await provider.initialize();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await provider.discoverCli(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never skips for a non-default endpoint', async () => {
    setMockConfig('localaiEndpoint', 'http://gpu-box:8080');

    await provider.initialize();
    await provider.initialize();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears the failure TTL after a successful probe', async () => {
    await provider.initialize(); // failure recorded
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue({ ok: true });
    const result = await provider.discoverCli(); // direct probe succeeds
    expect(result.found).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await provider.initialize(); // TTL cleared — init probes again
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
