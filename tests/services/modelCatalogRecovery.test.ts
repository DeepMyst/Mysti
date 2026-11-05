import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ModelRegistryService, MODEL_REGISTRY_CACHE_KEY } from '../../src/services/ModelRegistryService';
import { MODEL_DISCOVERY_TIMEOUT_MS } from '../../src/constants';
import { clearConfigurationListeners, clearMockConfig, createMockMemento, fireConfigurationChange, setMockConfig } from '../helpers/mockVscode';
import type { ModelInfo } from '../../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const registries: ModelRegistryService[] = [];
function harness(ids = ['ollama', 'localai'], cache?: unknown) {
  const globalState = createMockMemento();
  if (cache) { void globalState.update(MODEL_REGISTRY_CACHE_KEY, cache); }
  const registry = new ModelRegistryService({ globalState } as any); registries.push(registry);
  const providers = Object.fromEntries(ids.map(id => [id, { id,
    discoverModels: vi.fn<() => Promise<ModelInfo[] | null>>(async () => [{ id: 'shared', name: `${id} shared`, contextWindow: 4096 }]),
  }]));
  registry.setProviderSource({ getAllProviderIds: () => ids,
    getProvider: id => ({ models: [{ id: 'shared', name: `${id} curated`, contextWindow: 8192 }], defaultModel: `${id}-default` }),
    getProviderInstance: id => providers[id],
  });
  const events: string[] = []; registry.onDidUpdateModels(event => events.push(event.providerId));
  return { registry, globalState, providers, events };
}
afterEach(() => {
  registries.splice(0).forEach(registry => registry.dispose());
  clearConfigurationListeners(); clearMockConfig(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('PC-04 model catalog input and persistence recovery', () => {
  it('filters malformed live rows and metadata while preserving usable model identities and curated windows', async () => {
    const h = harness();
    h.providers.ollama.discoverModels.mockResolvedValue([null, 7, {}, { id: 42, name: 'bad' },
      { id: 'bad model', name: 'bad' }, { id: 'shared', name: { unsafe: true }, contextWindow: -1 },
      { id: 'usable', name: 'Usable', contextWindow: 32768 },
    ] as any);
    await h.registry.refresh('ollama');
    const state = h.registry.getModels('ollama', { revalidate: false });
    expect(state.models).toEqual([
      expect.objectContaining({ id: 'shared', name: expect.any(String), contextWindow: 8192 }),
      expect.objectContaining({ id: 'usable', name: 'Usable', contextWindow: 32768 }),
    ]);
    expect(h.registry.getContextWindow('ollama', 'shared')).toBe(8192);
  });

  it('rehydrates a corrupted cache without throwing or serving invalid model IDs', () => {
    const h = harness(['ollama'], { ollama: { models: [null, { id: 'safe', name: 'Safe' }, { id: {}, name: 'bad' }], fetchedAt: Date.now() } });
    expect(h.registry.getModels('ollama', { revalidate: false }).models.map(model => model.id)).toEqual(['shared', 'safe']);
  });

  it('keeps the last usable catalog when every returned row is invalid', async () => {
    const h = harness(); await h.registry.refresh('ollama'); h.events.length = 0;
    h.providers.ollama.discoverModels.mockResolvedValue([{ name: 'no model id' }, null] as any);
    await h.registry.refresh('ollama');
    expect(h.registry.getModels('ollama', { revalidate: false }).models).toEqual([
      expect.objectContaining({ id: 'shared', name: 'ollama shared' }),
    ]);
    expect(h.events).toEqual([]);
  });

  it('retains a usable in-memory result and notifies panels when durable cache storage fails', async () => {
    const h = harness(); vi.spyOn(h.globalState, 'update').mockRejectedValue(new Error('Disk unavailable'));
    await expect(h.registry.refresh('ollama')).resolves.toBeUndefined();
    expect(h.registry.getModels('ollama', { revalidate: false }).models[0].name).toBe('ollama shared');
    expect(h.events).toEqual(['ollama']);
  });

  it('serializes whole-cache persistence so a slow older write cannot erase another provider after restart', async () => {
    const h = harness(); const firstWrite = deferred<void>();
    const entered = deferred<void>(); const update = h.globalState.update.bind(h.globalState);
    const write = vi.spyOn(h.globalState, 'update').mockImplementationOnce(async (key, value) => {
      entered.resolve(); await firstWrite.promise; await update(key, value);
    });
    const first = h.registry.refresh('ollama'); await entered.promise;
    const second = h.registry.refresh('localai');
    // Let the second discovery reach persistence while the first write is blocked.
    await new Promise<void>(resolve => setImmediate(resolve));
    firstWrite.resolve(); await Promise.all([first, second]);
    const restored = new ModelRegistryService({ globalState: h.globalState } as any); registries.push(restored);
    expect(restored.getModels('ollama', { revalidate: false }).models[0]?.name).toBe('ollama shared');
    expect(restored.getModels('localai', { revalidate: false }).models[0]?.name).toBe('localai shared');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('keeps duplicate model IDs scoped by provider through out-of-order discovery and reload', async () => {
    const h = harness(); const first = deferred<ModelInfo[]>();
    h.providers.ollama.discoverModels.mockReturnValue(first.promise);
    const a = h.registry.refresh('ollama'); await h.registry.refresh('localai');
    first.resolve([{ id: 'shared', name: 'Ollama answer', contextWindow: 16384 }]); await a;
    const restored = new ModelRegistryService({ globalState: h.globalState } as any); registries.push(restored);
    for (const registry of [h.registry, restored]) {
      expect(registry.getModels('ollama', { revalidate: false }).models[0]).toMatchObject({ name: 'Ollama answer', contextWindow: 16384 });
      expect(registry.getModels('localai', { revalidate: false }).models[0]).toMatchObject({ name: 'localai shared', contextWindow: 4096 });
    }
  });
});

describe('PC-04 catalog lifecycle and connection ownership', () => {
  it('discards a late response from the previous endpoint and refreshes the selected endpoint without touching a healthy sibling', async () => {
    const h = harness(); await h.registry.refresh('localai'); h.events.length = 0;
    const old = deferred<ModelInfo[]>(); h.providers.ollama.discoverModels.mockReturnValueOnce(old.promise);
    const first = h.registry.refresh('ollama');
    setMockConfig('ollamaEndpoint', 'http://127.0.0.1:22114'); fireConfigurationChange('mysti.ollamaEndpoint');
    h.providers.ollama.discoverModels.mockResolvedValue([{ id: 'new-endpoint', name: 'New endpoint' }]);
    const refresh = h.registry.refresh('ollama', { force: true });
    old.resolve([{ id: 'old-endpoint', name: 'Old endpoint' }]); await Promise.all([first, refresh]);
    expect(h.registry.getModels('ollama', { revalidate: false }).models.map(model => model.id)).toEqual(['shared', 'new-endpoint']);
    expect(h.providers.localai.discoverModels).toHaveBeenCalledOnce();
    expect(h.registry.getModels('localai', { revalidate: false }).models[0].name).toBe('localai shared');
    expect(h.events.filter(id => id === 'ollama')).toHaveLength(1);
  });

  it('invalidates an already-cached old endpoint before serving new connection models', async () => {
    const h = harness();
    h.providers.ollama.discoverModels.mockResolvedValueOnce([{ id: 'old-private-model', name: 'Old endpoint' }]);
    await h.registry.refresh('ollama');
    setMockConfig('ollamaEndpoint', 'http://127.0.0.1:22114'); fireConfigurationChange('mysti.ollamaEndpoint');
    expect(h.registry.getModels('ollama', { revalidate: false }).models.map(model => model.id)).toEqual(['shared']);
    const fresh = h.registry.getModels('ollama'); expect(fresh.discoveryStatus).toBe('fallback');
    await h.registry.refresh('ollama');
    expect(h.providers.ollama.discoverModels).toHaveBeenCalledTimes(2);
  });

  it('does not restore a previous endpoint catalog after changing settings and restarting before a new probe', async () => {
    const h = harness(); h.providers.ollama.discoverModels.mockResolvedValue([{ id: 'private-old-endpoint', name: 'Old endpoint' }]);
    await h.registry.refresh('ollama');
    setMockConfig('ollamaEndpoint', 'http://127.0.0.1:22114'); fireConfigurationChange('mysti.ollamaEndpoint');
    await new Promise<void>(resolve => setImmediate(resolve));
    h.registry.dispose();
    const restored = new ModelRegistryService({ globalState: h.globalState } as any); registries.push(restored);
    expect(restored.getModels('ollama', { revalidate: false }).models.map(model => model.id)).not.toContain('private-old-endpoint');
  });

  it('does not invalidate or probe catalogs for unrelated model/effort/provider selection settings', async () => {
    const h = harness(); await h.registry.refresh('ollama');
    for (const key of ['ollamaModel', 'defaultProvider', 'defaultThinkingLevel', 'defaultEffortLevel']) {
      fireConfigurationChange(`mysti.${key}`); h.registry.getModels('ollama');
    }
    expect(h.providers.ollama.discoverModels).toHaveBeenCalledOnce();
  });

  it('ignores an in-flight response after provider-source replacement', async () => {
    const h = harness(); const old = deferred<ModelInfo[]>(); h.providers.ollama.discoverModels.mockReturnValue(old.promise);
    const pending = h.registry.refresh('ollama');
    const discover = vi.fn(async () => [{ id: 'replacement', name: 'Replacement' }]);
    h.registry.setProviderSource({ getAllProviderIds: () => ['ollama'], getProvider: () => ({ models: [], defaultModel: 'replacement' }),
      getProviderInstance: () => ({ id: 'ollama', discoverModels: discover }) });
    const replacement = h.registry.refresh('ollama'); old.resolve([{ id: 'obsolete', name: 'Obsolete' }]);
    await Promise.all([pending, replacement]);
    expect(h.registry.getModels('ollama', { revalidate: false }).models.map(model => model.id)).toEqual(['replacement']);
  });

  it('serves and probes the replacement source when open-panel listeners reread an invalidated catalog immediately', async () => {
    const h = harness(['ollama']); await h.registry.refresh('ollama');
    h.registry.onDidUpdateModels(() => { h.registry.getModels('ollama'); });
    const replacement = vi.fn(async () => [{ id: 'replacement', name: 'Replacement' }]);
    h.registry.setProviderSource({ getAllProviderIds: () => ['ollama'], getProvider: () => ({ models: [], defaultModel: 'replacement' }),
      getProviderInstance: () => ({ id: 'ollama', discoverModels: replacement }) });
    await h.registry.refresh('ollama');
    expect(h.providers.ollama.discoverModels).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledOnce();
    expect(h.registry.getModels('ollama', { revalidate: false }).models.map(model => model.id)).toEqual(['replacement']);
  });

  it('settles a hung request, allows a fresh retry, and ignores a late timed-out result', async () => {
    vi.useFakeTimers(); const h = harness(); const old = deferred<ModelInfo[]>();
    h.providers.ollama.discoverModels.mockReturnValueOnce(old.promise);
    const pending = h.registry.refresh('ollama'); await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_TIMEOUT_MS + 1); await pending;
    h.providers.ollama.discoverModels.mockResolvedValue([{ id: 'retried', name: 'Retried' }]); await h.registry.refresh('ollama');
    old.resolve([{ id: 'obsolete', name: 'Obsolete' }]); await Promise.resolve();
    expect(h.registry.getModels('ollama', { revalidate: false }).models.map(model => model.id)).toEqual(['shared', 'retried']);
    expect(h.events).toEqual(['ollama']); expect(vi.getTimerCount()).toBe(0);
  });

  it('stops staggered discovery and prevents late cache writes when disposed', async () => {
    vi.useFakeTimers(); const h = harness(); const old = deferred<ModelInfo[]>();
    h.providers.ollama.discoverModels.mockReturnValue(old.promise);
    const writes = vi.spyOn(h.globalState, 'update'); const pending = h.registry.refreshAll();
    h.registry.dispose(); old.resolve([{ id: 'late', name: 'Late' }]);
    await vi.advanceTimersByTimeAsync(500); await pending;
    expect(h.providers.localai.discoverModels).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled(); expect(h.events).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a hung registry wait and its deadline timer on disposal without borrowing another provider request', async () => {
    vi.useFakeTimers(); const h = harness(); const old = deferred<ModelInfo[]>();
    h.providers.ollama.discoverModels.mockReturnValue(old.promise);
    let settled = false; const pending = h.registry.refresh('ollama').then(() => { settled = true; });
    h.registry.dispose(); await vi.advanceTimersByTimeAsync(0);
    const settledOnDispose = settled;
    old.reject(new Error('Late provider shutdown')); await pending;
    expect(settledOnDispose).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(h.providers.localai.discoverModels).not.toHaveBeenCalled();
  });
});

describe('PC-04 concurrent custom model edits', () => {
  it('preserves simultaneous additions from two panels to different provider catalogs', async () => {
    const h = harness(); const writes: Array<{ value: any; finish: () => void }> = [];
    vi.spyOn(vscode.workspace.getConfiguration('mysti'), 'update').mockImplementation((_key, value) => new Promise<void>(resolve => {
      writes.push({ value, finish: () => { setMockConfig('customModels', value); resolve(); } });
    }));
    const a = h.registry.addCustomModel('ollama', 'panel-a'); const b = h.registry.addCustomModel('localai', 'panel-b');
    await Promise.resolve(); writes[0].finish(); await a; await Promise.resolve();
    writes[1].finish(); await b;
    expect(h.registry.getModels('ollama', { revalidate: false }).models.map(model => model.id)).toContain('panel-a');
    expect(h.registry.getModels('localai', { revalidate: false }).models.map(model => model.id)).toContain('panel-b');
  });

  it('recovers custom-model writes after one settings update rejects', async () => {
    const h = harness(); let written: any;
    vi.spyOn(vscode.workspace.getConfiguration('mysti'), 'update').mockRejectedValueOnce(new Error('Settings locked'))
      .mockImplementation(async (_key, value) => { written = value; setMockConfig('customModels', value); });
    await expect(h.registry.addCustomModel('ollama', 'failed')).rejects.toThrow('Settings locked');
    await h.registry.addCustomModel('ollama', 'recovered');
    expect(written).toEqual({ ollama: ['recovered'] }); expect(h.events).toEqual(['ollama']);
  });
});
