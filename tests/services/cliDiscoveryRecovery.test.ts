import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CliDiscoveryService, type CliStatus, type DiscoveryProviderSource } from '../../src/services/CliDiscoveryService';
import type { ICliProvider } from '../../src/providers/base/IProvider';
import { clearConfigurationListeners, fireConfigurationChange } from '../helpers/mockVscode';

const providerIds = ['claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot', 'cursor',
  'openclaw', 'opencode', 'ollama', 'localai', 'qwen-code', 'hermes', 'continue', 'openrouter', 'minimax', 'kimi-code'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function provider(id = 'openai-codex') {
  return {
    id,
    discoverCli: vi.fn(async (_force?: boolean) => ({ found: true, path: `/fixture/bin/${id}`, version: '1.0.0' })),
    checkAuthentication: vi.fn(async () => ({ authenticated: true })),
  };
}

type TestProvider = ReturnType<typeof provider>;
const services: CliDiscoveryService[] = [];
function harness(providers: TestProvider[], options?: { probeTimeoutMs?: number }) {
  const ready = deferred<void>();
  const events = new vscode.EventEmitter<string>();
  const source: DiscoveryProviderSource = {
    getAllProviders: () => providers as unknown as ICliProvider[],
    getProviderInstance: id => providers.find(p => p.id === id) as unknown as ICliProvider,
    whenReady: ready.promise,
    onProviderReady: events.event,
  };
  const service = new CliDiscoveryService(source, options);
  services.push(service);
  return { service, ready };
}

async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); } }

afterEach(() => {
  for (const service of services.splice(0)) { service.dispose(); }
  clearConfigurationListeners();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PC-02 discovery recovery and concurrent panels', () => {
  it('runs a forced probe after an older ordinary probe so Refresh observes the upgraded binary', async () => {
    const cli = provider(); const old = deferred<any>();
    cli.discoverCli.mockReturnValueOnce(old.promise).mockResolvedValue({ found: true, path: '/fixture/New CLI/codex', version: '2.0.0' });
    const { service } = harness([cli]);
    const ordinary = service.getStatus(cli.id);
    const updates: CliStatus[][] = [];
    service.onDidUpdate(statuses => updates.push(statuses));
    const refreshes = Array.from({ length: 3 }, () => service.refresh(cli.id));
    old.resolve({ found: false, path: '/fixture/Old CLI/codex', version: '1.0.0' });
    await ordinary;
    for (const refresh of refreshes) {
      expect(await refresh).toEqual([expect.objectContaining({ path: '/fixture/New CLI/codex', version: '2.0.0', authenticated: true })]);
    }
    expect(cli.discoverCli.mock.calls.map(call => call[0])).toEqual([false, true]);
    expect(updates.every(batch => batch[0]?.version === '2.0.0')).toBe(true);
  });

  it('does not reuse a forced probe made before a custom-path setting changed', async () => {
    const cli = provider(); const old = deferred<any>();
    cli.discoverCli.mockReturnValueOnce(old.promise).mockResolvedValue({ found: true, path: '/fixture/Chosen CLI/codex', version: '3.0.0' });
    const { service } = harness([cli]);
    const before = service.refresh(cli.id);
    fireConfigurationChange('mysti.codexPath');
    const after = service.refresh(cli.id);
    old.resolve({ found: true, path: '/fixture/Previous CLI/codex', version: '1.0.0' });
    await before;
    expect(await after).toEqual([expect.objectContaining({ path: '/fixture/Chosen CLI/codex', version: '3.0.0' })]);
    expect(service.getCachedStatus(cli.id)?.path).toBe('/fixture/Chosen CLI/codex');
    expect(cli.discoverCli).toHaveBeenCalledTimes(2);
  });

  it('a menu opened after authentication invalidation waits for a current result', async () => {
    const cli = provider(); const staleAuth = deferred<any>();
    cli.checkAuthentication.mockReturnValueOnce(staleAuth.promise).mockResolvedValue({ authenticated: true });
    const { service } = harness([cli]);
    const old = service.getStatus(cli.id);
    await flush();
    service.invalidate(cli.id);
    const current = service.getStatus(cli.id);
    staleAuth.resolve({ authenticated: false });
    await old;
    expect(await current).toMatchObject({ authenticated: true });
    expect(service.getCachedStatus(cli.id)?.authenticated).toBe(true);
  });

  it('bulk refresh publishes the latest version when another panel updates a fast provider while its sibling waits', async () => {
    const cli = provider(); const sibling = provider('claude-code'); const slow = deferred<any>();
    sibling.discoverCli.mockReturnValueOnce(slow.promise);
    const { service } = harness([cli, sibling]);
    const bulk = service.refresh(); await flush();
    cli.discoverCli.mockResolvedValue({ found: true, path: '/fixture/New CLI/codex', version: '2.0.0' });
    await service.refresh(cli.id);
    const updates: CliStatus[][] = []; service.onDidUpdate(statuses => updates.push(statuses));
    slow.resolve({ found: true, path: '/fixture/bin/claude' });
    expect(await bulk).toEqual([
      expect.objectContaining({ providerId: cli.id, version: '2.0.0' }),
      expect.objectContaining({ providerId: sibling.id }),
    ]);
    expect(updates[0]?.find(status => status.providerId === cli.id)?.version).toBe('2.0.0');
  });

  it('can recover from a provider that throws before returning a discovery promise', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cli = provider();
    cli.discoverCli.mockImplementationOnce(() => { throw new Error('configuration unavailable'); });
    const { service } = harness([cli]);
    expect(await service.refresh(cli.id)).toEqual([expect.objectContaining({ found: false })]);
    expect(await service.refresh(cli.id)).toEqual([expect.objectContaining({ found: true, authenticated: true })]);
    expect(cli.discoverCli).toHaveBeenCalledTimes(2);
  });

  it('does not resume discovery when provider initialization finishes after disposal', async () => {
    const cli = provider(); const { service, ready } = harness([cli]);
    service.dispose(); ready.resolve(); await flush();
    expect(cli.discoverCli).not.toHaveBeenCalled();
    expect(await service.refresh()).toEqual([]);
    expect(await service.getStatus(cli.id)).toBeUndefined();
  });

  it('does not start authentication or repopulate its cache after disposal during discovery', async () => {
    const cli = provider(); const discovery = deferred<any>();
    cli.discoverCli.mockReturnValue(discovery.promise);
    const { service } = harness([cli]);
    const pending = service.getStatus(cli.id);
    service.dispose(); discovery.resolve({ found: true, path: '/fixture/bin/codex' });
    expect(await pending).toBeUndefined();
    expect(cli.checkAuthentication).not.toHaveBeenCalled();
    expect(service.getAllCachedStatuses()).toEqual([]);
  });

  it('returns healthy siblings and recovers after one of 16 providers stalls in discovery', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const providers = providerIds.map(id => provider(id)); const stuck = deferred<any>();
    providers[0].discoverCli.mockReturnValueOnce(stuck.promise);
    providers[1].discoverCli.mockRejectedValue(new Error('discovery unavailable'));
    providers[2].checkAuthentication.mockRejectedValue(new Error('auth unavailable'));
    const { service } = harness(providers, { probeTimeoutMs: 50 });
    let result: CliStatus[] | undefined;
    const refresh = service.refresh().then(statuses => { result = statuses; });
    await vi.advanceTimersByTimeAsync(51);
    expect(result, 'one stalled backend must not hold the 15 siblings indefinitely').toHaveLength(16);
    await refresh;
    expect(result?.filter(status => status.authenticated)).toHaveLength(13);
    expect(result?.find(status => status.providerId === providers[0].id)?.found).toBe(false);
    expect(await service.refresh(providers[0].id)).toEqual([expect.objectContaining({ found: true, authenticated: true })]);
    stuck.resolve({ found: false, path: '/stale/result' }); await flush();
    expect(service.getCachedStatus(providers[0].id)?.found).toBe(true);
    expect(providers[0].checkAuthentication).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps installation and version facts when auth stalls, then allows sign-in recovery', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cli = provider(); const auth = deferred<any>();
    cli.checkAuthentication.mockReturnValueOnce(auth.promise).mockResolvedValue({ authenticated: true });
    const { service } = harness([cli], { probeTimeoutMs: 50 });
    let result: CliStatus | undefined;
    const pending = service.getStatus(cli.id).then(status => { result = status; });
    await vi.advanceTimersByTimeAsync(51);
    expect(result).toMatchObject({ found: true, version: '1.0.0', authenticated: false });
    await pending;
    expect(await service.refresh(cli.id)).toEqual([expect.objectContaining({ authenticated: true })]);
    auth.resolve({ authenticated: false }); await flush();
    expect(service.getCachedStatus(cli.id)?.authenticated).toBe(true);
  });

  it('coalesces 50 refresh rounds from three panels across all 16 providers without losing versions or paths', async () => {
    const providers = providerIds.map(id => provider(id));
    const { service } = harness(providers);
    for (let round = 0; round < 50; round++) {
      providers.forEach((cli, index) => {
        cli.discoverCli.mockResolvedValue({ found: true, path: `/fixture/CLI ${index}/agent`, version: `${round + 1}.0.0` });
        cli.checkAuthentication.mockResolvedValue({ authenticated: (round + index) % 5 !== 0 });
      });
      const snapshots = await Promise.all(Array.from({ length: 3 }, () => service.refresh()));
      for (const snapshot of snapshots) {
        expect(snapshot).toHaveLength(16);
        expect(snapshot.map(status => status.path)).toEqual(providers.map((_, index) => `/fixture/CLI ${index}/agent`));
        expect(snapshot.every(status => status.version === `${round + 1}.0.0`)).toBe(true);
      }
    }
    for (const cli of providers) {
      expect(cli.discoverCli).toHaveBeenCalledTimes(50);
      expect(cli.checkAuthentication).toHaveBeenCalledTimes(50);
    }
  });
});
