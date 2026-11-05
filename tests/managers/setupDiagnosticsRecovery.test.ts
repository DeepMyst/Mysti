import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SetupManager } from '../../src/managers/SetupManager';
import * as platform from '../../src/utils/platform';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, accessSync: vi.fn(actual.accessSync), existsSync: vi.fn(actual.existsSync) };
});

vi.mock('../../src/utils/platform', () => ({
  getPlatformInfo: vi.fn(async () => ({ os: 'darwin', arch: 'arm64', shell: '/bin/zsh', hasNvm: false, npmVersion: '10.9.0' })),
  getNpmPrefix: vi.fn(async () => '/fixture/npm'),
  canWriteNpmGlobalDir: vi.fn(async () => true),
  probeCliOutput: vi.fn(),
  resolveCommandOnPath: vi.fn(async () => '/fixture/Login Node/bin/npm'),
  resetPlatformInfoCache: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(platform.probeCliOutput).mockReset().mockImplementation(async (_file, args) => {
    const command = args.join(' ');
    if (command.includes('--version')) { return '11.6.0'; }
    if (command.includes('config get prefix')) { return '/fixture/Selected Node'; }
    if (command.includes('command -v npm')) { return '/fixture/Login Node/bin/npm'; }
    return undefined;
  });
});

function harness() {
  const providers = ['broken', 'healthy'].map(id => ({
    id, displayName: id,
    discoverCli: vi.fn(async () => ({ found: true, version: '1.2.3', path: `/fixture/${id} prefix/bin/cli` })),
    checkAuthentication: vi.fn(async () => ({ authenticated: true })),
  }));
  const manager = new SetupManager({ subscriptions: [], globalState: { get: () => undefined } } as any,
    { getAllProviders: () => providers } as any);
  (manager as any)._npmPath = '/fixture/Selected Node/bin/npm';
  vi.spyOn(manager, 'checkNpmAvailable').mockResolvedValue(true);
  vi.spyOn(manager, 'checkNetworkConnectivity').mockResolvedValue(true);
  vi.spyOn(manager as any, '_checkNodeVersion').mockResolvedValue({ meets: true, version: 'v22.23.3' });
  return { manager, providers };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('PC-02 diagnostics recovery', () => {
  it('reports the selected npm version, executable and prefix rather than another PATH installation', async () => {
    const { manager } = harness();
    const report = await manager.runDiagnostics();
    expect(report.npmStatus).toMatchObject({ version: '11.6.0', path: '/fixture/Selected Node/bin/npm', prefix: '/fixture/Selected Node' });
    const calls = vi.mocked(platform.probeCliOutput).mock.calls;
    expect(calls.map(call => [call[0], call[1]])).toEqual(expect.arrayContaining([
      ['/fixture/Selected Node/bin/npm', ['--version']],
      ['/fixture/Selected Node/bin/npm', ['config', 'get', 'prefix']],
    ]));
    const env = calls[0][3]!;
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')!;
    expect(env[pathKey]?.split(path.delimiter)[0]).toBe('/fixture/Selected Node/bin');
  });

  it('checks write permissions on the selected prefix without borrowing another npm permissions result', async () => {
    const { manager } = harness();
    const access = vi.spyOn(fs, 'accessSync').mockImplementation(() => { throw new Error('EACCES'); });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const report = await manager.runDiagnostics();
    expect(report.npmStatus.canWriteGlobalDir).toBe(false);
    expect(access).toHaveBeenCalledWith('/fixture/Selected Node/lib/node_modules', fs.constants.W_OK);
  });

  it('reports the login-shell npm identity and configuration through that same shell', async () => {
    const { manager } = harness();
    (manager as any)._npmPath = 'npm'; (manager as any)._npmUsesLoginShell = true;
    vi.stubEnv('SHELL', '/fixture/Login Shell/bin/bash');
    const report = await manager.runDiagnostics();
    expect(report.npmStatus).toMatchObject({ version: '11.6.0', path: '/fixture/Login Node/bin/npm', prefix: '/fixture/Selected Node' });
    const calls = vi.mocked(platform.probeCliOutput).mock.calls;
    expect(calls.map(call => [call[0], call[1]])).toEqual(expect.arrayContaining([
      ['/fixture/Login Shell/bin/bash', ['-l', '-c', 'npm --version']],
      ['/fixture/Login Shell/bin/bash', ['-l', '-c', 'npm config get prefix']],
    ]));
  });

  it('leaves a failed selected-npm version unknown while retaining prefix and healthy providers', async () => {
    const { manager } = harness();
    vi.mocked(platform.probeCliOutput).mockImplementation(async (_file, args) => args.includes('--version') ? undefined : '/fixture/Selected Node');
    const report = await manager.runDiagnostics();
    expect(report.npmStatus.version).toBeUndefined();
    expect(report.npmStatus.prefix).toBe('/fixture/Selected Node');
    expect(report.providers.every(provider => provider.authenticated)).toBe(true);
  });

  it('runs independent diagnostics concurrently after npm selection instead of accumulating their delays', async () => {
    vi.useFakeTimers();
    const { manager, providers } = harness();
    const later = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 10_000));
    vi.spyOn(manager, 'checkNpmAvailable').mockImplementation(() => later(true));
    vi.spyOn(manager as any, '_checkNodeVersion').mockImplementation(() => later({ meets: true, version: 'v22.23.3' }));
    vi.spyOn(manager, 'checkNetworkConnectivity').mockImplementation(() => later(true));
    providers.forEach(provider => provider.discoverCli.mockImplementation(() => later({ found: true, version: '1.2.3', path: '/fixture/bin/cli' })));
    let complete = false;
    const report = manager.runDiagnostics().then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(complete).toBe(true);
    await report;
  });

  it('returns healthy providers and the discovery failure when one backend throws', async () => {
    const { manager, providers } = harness();
    providers[0].discoverCli.mockRejectedValue(new Error('EACCES: cannot execute fixture CLI'));
    const report = await manager.runDiagnostics();
    expect(report.providers).toHaveLength(2);
    expect(report.providers[0]).toMatchObject({ id: 'broken', installed: false, error: expect.stringContaining('EACCES') });
    expect(report.providers[1]).toMatchObject({ id: 'healthy', installed: true, authenticated: true });
  });

  it('retains the installed binary identity when its authentication probe fails', async () => {
    const { manager, providers } = harness();
    providers[0].checkAuthentication.mockRejectedValue(new Error('Authentication service unavailable'));
    const report = await manager.runDiagnostics();
    expect(report.providers[0]).toMatchObject({ installed: true, path: '/fixture/broken prefix/bin/cli',
      version: '1.2.3', authenticated: false, error: 'Authentication service unavailable' });
    expect(report.providers[1].authenticated).toBe(true);
  });

  it('identifies the exact configured binary, including spaces, for troubleshooting updates', async () => {
    const { manager } = harness();
    const report = await manager.runDiagnostics();
    expect(report.providers[1]).toMatchObject({ path: '/fixture/healthy prefix/bin/cli', version: '1.2.3' });
  });

  it('shares concurrent panel diagnostics instead of starting duplicate provider probes', async () => {
    const { manager, providers } = harness();
    let finish!: (value: any) => void;
    providers[0].discoverCli.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = manager.runDiagnostics(), second = manager.runDiagnostics();
    await vi.waitFor(() => expect(providers[0].discoverCli).toHaveBeenCalled());
    finish({ found: true, path: '/fixture/shared', version: '1.2.3' });
    const reports = await Promise.all([first, second]);
    expect(reports[0]).toEqual(reports[1]);
    expect(providers[0].discoverCli).toHaveBeenCalledTimes(1);
    expect(providers[1].discoverCli).toHaveBeenCalledTimes(1);
    await manager.runDiagnostics();
    expect(providers[1].discoverCli).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung backend, reports siblings, and does not let late results rewrite the report', async () => {
    vi.useFakeTimers();
    const { manager, providers } = harness();
    let finish!: (value: any) => void;
    providers[0].discoverCli.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    let report: Awaited<ReturnType<SetupManager['runDiagnostics']>> | undefined;
    const pending = manager.runDiagnostics().then(value => { report = value; });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(report, 'Diagnostics must return even if one discovery promise never settles').toBeDefined();
      expect(report!.providers[0]).toMatchObject({ id: 'broken', installed: false, error: expect.stringMatching(/timed out/i) });
      expect(report!.providers[1]).toMatchObject({ id: 'healthy', installed: true, authenticated: true });
      const before = JSON.stringify(report);
      finish({ found: true, version: '9.9.9', path: '/late/cli' });
      await pending;
      await vi.advanceTimersByTimeAsync(1);
      expect(JSON.stringify(report)).toBe(before);
      expect(providers[0].checkAuthentication).not.toHaveBeenCalled();
    } finally {
      finish({ found: false });
      await pending;
    }
  });
});
