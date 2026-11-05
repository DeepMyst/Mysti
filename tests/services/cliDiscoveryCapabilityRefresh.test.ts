import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CliDiscoveryService, type CliStatus, type DiscoveryProviderSource } from '../../src/services/CliDiscoveryService';
import type { CliDiscoveryResult, ICliProvider } from '../../src/providers/base/IProvider';
import { clearConfigurationListeners } from '../helpers/mockVscode';

const cleanups: Array<() => void> = [];
function harness() {
  const cli = {
    id: 'cline',
    discoverCli: vi.fn(async (): Promise<CliDiscoveryResult> => ({ found: true, path: '/fixture/cline', version: '1.0.8' })),
    checkAuthentication: vi.fn(async () => ({ authenticated: true })),
  };
  const ready = new vscode.EventEmitter<string>();
  const source: DiscoveryProviderSource = {
    getAllProviders: () => [cli as unknown as ICliProvider],
    getProviderInstance: id => id === cli.id ? cli as unknown as ICliProvider : undefined,
    whenReady: new Promise<void>(() => {}), onProviderReady: ready.event,
  };
  const service = new CliDiscoveryService(source);
  const changes: CliStatus[] = [];
  const subscription = service.onDidChange(status => changes.push(status));
  cleanups.push(() => { subscription.dispose(); service.dispose(); ready.dispose(); });
  return { cli, service, changes };
}
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); clearConfigurationListeners(); vi.restoreAllMocks(); });

describe('discovery publishes changes needed by live capability manifests', () => {
  it('publishes the first settled version to already-open capability consumers', async () => {
    const { service, changes } = harness();
    await service.getStatus('cline');
    expect(changes).toEqual([expect.objectContaining({ providerId: 'cline', found: true, authenticated: true, version: '1.0.8' })]);
  });

  it('publishes upgrades and downgrades when installation and auth stay unchanged', async () => {
    const { cli, service, changes } = harness();
    await service.getStatus('cline'); changes.length = 0;
    cli.discoverCli.mockResolvedValue({ found: true, path: '/fixture/cline', version: '3.0.61' });
    await service.refresh('cline');
    cli.discoverCli.mockResolvedValue({ found: true, path: '/fixture/cline', version: '1.0.8' });
    await service.refresh('cline');
    expect(changes.map(status => status.version)).toEqual(['3.0.61', '1.0.8']);
    expect(changes.every(status => status.found && status.authenticated)).toBe(true);
  });

  it('publishes a replacement path even when version and availability match', async () => {
    const { cli, service, changes } = harness();
    await service.getStatus('cline'); changes.length = 0;
    cli.discoverCli.mockResolvedValue({ found: true, path: '/fixture/replacement/cline', version: '1.0.8' });
    await service.refresh('cline');
    expect(changes.map(status => status.path)).toEqual(['/fixture/replacement/cline']);
  });

  it('does not rebroadcast identical facts just because a probe completed again', async () => {
    const { service, changes } = harness();
    await service.getStatus('cline'); changes.length = 0;
    await service.refresh('cline'); await service.refresh('cline');
    expect(changes).toEqual([]);
  });

  it('never publishes a stale version after the selected executable was invalidated', async () => {
    const { cli, service, changes } = harness();
    let settle!: (value: CliDiscoveryResult) => void;
    cli.discoverCli.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    const pending = service.getStatus('cline');
    service.invalidate('cline');
    settle({ found: true, path: '/fixture/stale/cline', version: '1.0.8' });
    await pending;
    expect(changes).toEqual([]);
    cli.discoverCli.mockResolvedValue({ found: true, path: '/fixture/current/cline', version: '3.0.61' });
    await service.refresh('cline');
    expect(changes.map(status => [status.path, status.version])).toEqual([['/fixture/current/cline', '3.0.61']]);
  });
});
