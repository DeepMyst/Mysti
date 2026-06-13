/**
 * Ollama discovery tests (Plan 03 Phase 2, task 5):
 * 1s probe timeout, and the module-level TTL skip that avoids network I/O
 * during background init after a recent failed probe of the default endpoint.
 * The wizard/first-use path (direct discoverCli()) must never hit the skip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { OllamaProvider, resetOllamaDiscoveryCache } from '../../../src/providers/ollama/OllamaProvider';
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

describe('OllamaProvider discovery', () => {
  let provider: OllamaProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearMockConfig();
    resetOllamaDiscoveryCache();
    provider = new OllamaProvider(createMockContext());
    fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetOllamaDiscoveryCache();
    clearMockConfig();
  });

  it('probes with a 1s timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await provider.discoverCli();

    expect(timeoutSpy).toHaveBeenCalledWith(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:11434/api/tags');
  });

  it('skips the init probe when the default endpoint failed within the TTL', async () => {
    await provider.initialize(); // probe fails, failure timestamp recorded
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await provider.initialize(); // within TTL — no network I/O
    await provider.initialize();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.getCliPath()).toBe('http://localhost:11434');
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
    setMockConfig('ollamaEndpoint', 'http://gpu-box:11434');

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

  describe('discoverModels (Plan 01 Phase 3)', () => {
    it('parses /api/tags into ModelInfo[]', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5-coder:7b' }] }),
      });
      const models = await provider.discoverModels(1000);
      expect(models).toEqual([
        { id: 'llama3.2:latest', name: 'llama3.2:latest' },
        { id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b' },
      ]);
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:11434/api/tags');
    });

    it('returns null on a non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false });
      expect(await provider.discoverModels(1000)).toBeNull();
    });

    it('returns null on fetch failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      expect(await provider.discoverModels(1000)).toBeNull();
    });

    it('returns null when the server reports no models', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
      expect(await provider.discoverModels(1000)).toBeNull();
    });
  });
});
