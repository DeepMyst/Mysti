/**
 * ProviderRegistry perf instrumentation tests (Plan 03 Phase 1, task 4):
 * per-provider `provider.init.<id>` duration samples inside initializeAll()
 * and the slowest-3 summary log — both gated by PerfTracker.isEnabled().
 *
 * Plan 03 Phase 2 (background provider initialization): initializeAll() now
 * runs all provider initialize() calls in parallel via Promise.allSettled.
 * Each provider is timed inside its own async closure, so the duration tests
 * below drive a manually-advanced clock and per-provider deferred promises.
 * This file also covers `whenReady` and the `onProviderReady` event.
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

/** Fake provider whose initialize() settles immediately. */
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

interface DeferredProvider extends FakeProvider {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** Fake provider whose initialize() settles only when the test says so. */
function deferredProvider(id: string): DeferredProvider {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const initialize = vi.fn(() => promise);
  const provider = {
    id,
    displayName: id,
    initialize,
    dispose: vi.fn(),
  } as unknown as ICliProvider;
  return { provider, initialize, resolve, reject };
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

/** Mock Date.now() with a manually-advanced clock; returns the setter. */
function installManualClock(): (ms: number) => void {
  let nowMs = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  return (ms: number) => {
    nowMs = ms;
  };
}

/** Drain pending promise continuations (deferred settles → closure resumes). */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
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

  /**
   * Start initializeAll() with providers a/b/c/d (all starting at t=0) and
   * settle them so the durations come out as a=30, b=20, c=10, d=0.
   */
  async function runAbcdScenario(): Promise<{ fakes: DeferredProvider[] }> {
    const fakes = [
      deferredProvider('a'),
      deferredProvider('b'),
      deferredProvider('c'),
      deferredProvider('d'),
    ];
    const registry = createRegistry(fakes);
    const setNow = installManualClock();

    setNow(0);
    const initPromise = registry.initializeAll();

    setNow(0);
    fakes[3].resolve(); // d → 0ms
    await flushMicrotasks();
    setNow(10);
    fakes[2].resolve(); // c → 10ms
    await flushMicrotasks();
    setNow(20);
    fakes[1].resolve(); // b → 20ms
    await flushMicrotasks();
    setNow(30);
    fakes[0].resolve(); // a → 30ms
    await initPromise;

    return { fakes };
  }

  describe('when perf logging is enabled', () => {
    it('records a provider.init.<id> sample per provider (timed in its own closure)', async () => {
      const { fakes } = await runAbcdScenario();

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
      await runAbcdScenario();

      const slowestLogs = perfLogs().filter((l) => l.startsWith('[Mysti][perf] provider.init slowest:'));
      expect(slowestLogs).toHaveLength(1);
      expect(slowestLogs[0]).toBe('[Mysti][perf] provider.init slowest: a=30.0ms, b=20.0ms, c=10.0ms');
    });

    it('still samples a provider whose initialize() throws', async () => {
      const broken = deferredProvider('broken');
      const ok = deferredProvider('ok');
      const registry = createRegistry([broken, ok]);
      const setNow = installManualClock();

      setNow(0);
      const initPromise = registry.initializeAll();

      setNow(10);
      ok.resolve(); // ok → 10ms (settles before broken — not blocked by it)
      await flushMicrotasks();
      setNow(50);
      broken.reject(new Error('broken init failed')); // broken → 50ms
      await initPromise;

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

  describe('background initialization (Plan 03 Phase 2)', () => {
    it('fans out all initialize() calls immediately — a hung provider does not block others', async () => {
      const slow = deferredProvider('slow');
      const fast1 = deferredProvider('fast1');
      const fast2 = deferredProvider('fast2');
      const registry = createRegistry([slow, fast1, fast2]);
      const ready: string[] = [];
      registry.onProviderReady((id: string) => ready.push(id));

      const initPromise = registry.initializeAll();

      // Parallel fan-out: every provider's initialize() started up front
      expect(slow.initialize).toHaveBeenCalledTimes(1);
      expect(fast1.initialize).toHaveBeenCalledTimes(1);
      expect(fast2.initialize).toHaveBeenCalledTimes(1);

      fast1.resolve();
      fast2.resolve();
      await flushMicrotasks();

      // Fast providers settled (and announced) while slow is still pending
      expect(ready).toEqual(['fast1', 'fast2']);

      let initSettled = false;
      void initPromise.then(() => {
        initSettled = true;
      });
      await flushMicrotasks();
      expect(initSettled).toBe(false);

      slow.resolve();
      await initPromise;
      expect(ready).toEqual(['fast1', 'fast2', 'slow']);
    });

    it('one failing provider does not block others and whenReady still resolves', async () => {
      const broken = deferredProvider('broken');
      const ok = deferredProvider('ok');
      const registry = createRegistry([broken, ok]);
      const ready: string[] = [];
      registry.onProviderReady((id: string) => ready.push(id));

      const initPromise = registry.initializeAll();
      ok.resolve();
      await flushMicrotasks();
      expect(ready).toContain('ok');

      broken.reject(new Error('boom'));
      await initPromise;

      // Resolves even though a provider failed — and fired for the failure too
      await expect(registry.whenReady).resolves.toBeUndefined();
      expect(ready).toEqual(['ok', 'broken']);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('whenReady stays pending until initializeAll() settles', async () => {
      const a = deferredProvider('a');
      const registry = createRegistry([a]);

      let readyResolved = false;
      void registry.whenReady.then(() => {
        readyResolved = true;
      });

      const initPromise = registry.initializeAll();
      await flushMicrotasks();
      expect(readyResolved).toBe(false);

      a.resolve();
      await initPromise;
      await flushMicrotasks();
      expect(readyResolved).toBe(true);
    });

    it('fires onProviderReady in settle order, independent of registration order', async () => {
      const a = deferredProvider('a');
      const b = deferredProvider('b');
      const c = deferredProvider('c');
      const registry = createRegistry([a, b, c]);
      const order: string[] = [];
      registry.onProviderReady((id: string) => order.push(id));

      const initPromise = registry.initializeAll();
      c.resolve();
      await flushMicrotasks();
      a.resolve();
      await flushMicrotasks();
      b.resolve();
      await initPromise;

      expect(order).toEqual(['c', 'a', 'b']);
    });
  });
});
