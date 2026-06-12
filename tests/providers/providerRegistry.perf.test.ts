/**
 * ProviderRegistry perf instrumentation tests (Plan 03 Phase 1, task 4):
 * per-provider `provider.init.<id>` duration samples inside initializeAll()
 * and the slowest-3 summary log — both gated by PerfTracker.isEnabled().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { PerfTracker } from '../../src/utils/PerfTracker';
import type { ICliProvider } from '../../src/providers/base/IProvider';

// Minimal mock extension context for provider constructors
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

interface FakeProvider {
  provider: ICliProvider;
  initialize: ReturnType<typeof vi.fn>;
}

function fakeProvider(id: string, opts: { fail?: boolean } = {}): FakeProvider {
  const initialize = vi.fn(async () => {
    if (opts.fail) {
      throw new Error(`${id} init failed`);
    }
  });
  const provider = {
    id,
    displayName: id,
    initialize,
    dispose: vi.fn(),
  } as unknown as ICliProvider;
  return { provider, initialize };
}

/** Build a registry containing only the given fake providers. */
function createRegistry(fakes: FakeProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry(createMockContext());
  for (const id of registry.getIds()) {
    registry.unregister(id);
  }
  for (const fake of fakes) {
    registry.register(fake.provider);
  }
  return registry;
}

/** Mock Date.now() to return queued values (falls back to the last value). */
function queueDateNow(values: number[]): ReturnType<typeof vi.spyOn> {
  const queue = [...values];
  const last = values[values.length - 1] ?? 0;
  return vi.spyOn(Date, 'now').mockImplementation(() =>
    queue.length > 0 ? queue.shift()! : last
  );
}

describe('ProviderRegistry perf instrumentation', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    PerfTracker.reset();
    PerfTracker.setEnabled(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PerfTracker.reset();
    PerfTracker.setEnabled(false);
  });

  function perfLogs(): string[] {
    return logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith('[Mysti][perf]'));
  }

  describe('when perf logging is enabled', () => {
    it('records a provider.init.<id> sample per provider', async () => {
      const fakes = [fakeProvider('a'), fakeProvider('b'), fakeProvider('c'), fakeProvider('d')];
      const registry = createRegistry(fakes);
      // Two Date.now() reads per provider: durations 30, 20, 10, 0
      queueDateNow([0, 30, 100, 120, 200, 210, 300, 300]);

      await registry.initializeAll();

      const report = PerfTracker.report();
      expect(report.samples['provider.init.a']).toEqual({ count: 1, p50: 30, p95: 30, max: 30, mean: 30 });
      expect(report.samples['provider.init.b'].max).toBe(20);
      expect(report.samples['provider.init.c'].max).toBe(10);
      expect(report.samples['provider.init.d'].max).toBe(0);
      for (const fake of fakes) {
        expect(fake.initialize).toHaveBeenCalledTimes(1);
      }
    });

    it('logs the 3 slowest providers, slowest first', async () => {
      const registry = createRegistry([
        fakeProvider('a'), fakeProvider('b'), fakeProvider('c'), fakeProvider('d'),
      ]);
      queueDateNow([0, 30, 100, 120, 200, 210, 300, 300]);

      await registry.initializeAll();

      const slowestLogs = perfLogs().filter((l) => l.startsWith('[Mysti][perf] provider.init slowest:'));
      expect(slowestLogs).toHaveLength(1);
      expect(slowestLogs[0]).toBe('[Mysti][perf] provider.init slowest: a=30.0ms, b=20.0ms, c=10.0ms');
    });

    it('still samples a provider whose initialize() throws', async () => {
      const failing = fakeProvider('broken', { fail: true });
      const ok = fakeProvider('ok');
      const registry = createRegistry([failing, ok]);
      queueDateNow([0, 50, 100, 110]);

      await registry.initializeAll();

      const report = PerfTracker.report();
      expect(report.samples['provider.init.broken'].max).toBe(50);
      expect(report.samples['provider.init.ok'].max).toBe(10);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('when perf logging is disabled', () => {
    beforeEach(() => {
      PerfTracker.setEnabled(false);
    });

    it('records no samples and emits no perf logs, but still initializes providers', async () => {
      const fakes = [fakeProvider('a'), fakeProvider('b')];
      const registry = createRegistry(fakes);

      await registry.initializeAll();

      expect(PerfTracker.report().samples).toEqual({});
      expect(perfLogs()).toHaveLength(0);
      for (const fake of fakes) {
        expect(fake.initialize).toHaveBeenCalledTimes(1);
      }
    });
  });

  it('skips re-initialization on a second initializeAll() call', async () => {
    const fake = fakeProvider('a');
    const registry = createRegistry([fake]);

    await registry.initializeAll();
    await registry.initializeAll();

    expect(fake.initialize).toHaveBeenCalledTimes(1);
    expect(PerfTracker.report().samples['provider.init.a'].count).toBe(1);
  });
});
