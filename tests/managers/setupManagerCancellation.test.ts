import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { SetupManager } from '../../src/managers/SetupManager';

vi.mock('vscode', async () => {
  const actual = await vi.importActual<typeof import('vscode')>('vscode');
  return { ...actual, window: { ...actual.window,
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
    showInputBox: vi.fn(async () => undefined),
  } };
});

const platform = vi.hoisted(() => ({ writable: vi.fn(async () => true) }));
vi.mock('../../src/utils/platform', async () => ({
  ...await vi.importActual<typeof import('../../src/utils/platform')>('../../src/utils/platform'),
  canWriteNpmGlobalDir: platform.writable,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const provider = {
    displayName: 'Test CLI', capabilities: { supportsAutoInstall: true },
    discoverCli: vi.fn(async () => ({ found: false, path: '/test/cli' })),
    checkAuthentication: vi.fn(async () => ({ authenticated: true })),
    getInstallCommand: () => 'npm install -g test-cli', getAuthCommand: () => 'test-cli login',
  };
  const manager = new SetupManager({ subscriptions: [], globalState: { get: () => undefined, update: vi.fn() } } as any,
    { getProviderInstance: () => provider } as any) as any;
  vi.spyOn(manager, '_checkNodeVersion').mockResolvedValue({ meets: true });
  vi.spyOn(manager, 'checkNpmAvailable').mockResolvedValue(true);
  vi.spyOn(manager, 'checkNetworkConnectivity').mockResolvedValue(true);
  vi.spyOn(manager, '_checkNpmDirect').mockResolvedValue(true);
  vi.spyOn(manager, '_recordInstall').mockResolvedValue(undefined);
  const command = vi.spyOn(manager, '_runCommand').mockResolvedValue({ success: true });
  const local = vi.spyOn(manager, '_installToLocalPrefix').mockResolvedValue({ success: true });
  const terminal = vi.spyOn(vscode.window, 'createTerminal');
  return { manager, provider, command, local, terminal };
}

beforeEach(() => { platform.writable.mockReset().mockResolvedValue(true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('setup cancellation before further side effects', () => {
  it('does not install or check authentication after cancelled discovery', async () => {
    const h = harness(); const discovery = deferred<any>(); const controller = new AbortController();
    h.provider.discoverCli.mockReturnValue(discovery.promise);
    const install = vi.spyOn(h.manager, 'autoInstallCli');
    const run = h.manager.setupProvider('test', undefined, controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); discovery.resolve({ found: false }); await settled;
    expect(install).not.toHaveBeenCalled(); expect(h.provider.checkAuthentication).not.toHaveBeenCalled();
  });

  it('does not start authentication after a completed install whose owner cancelled', async () => {
    const h = harness(); const install = deferred<any>(); const controller = new AbortController();
    const started = deferred<void>();
    vi.spyOn(h.manager, 'autoInstallCli').mockImplementation(() => { started.resolve(); return install.promise; });
    const run = h.manager.setupProvider('test', undefined, controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise; controller.abort(); install.resolve({ success: true }); await settled;
    expect(h.provider.checkAuthentication).not.toHaveBeenCalled();
  });

  it('does not open a login terminal after cancelled inner discovery', async () => {
    const h = harness(); const discovery = deferred<any>(); const controller = new AbortController();
    h.provider.discoverCli.mockReturnValue(discovery.promise);
    const run = h.manager.authenticateProvider('test', controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); discovery.resolve({ found: true, path: '/test/cli' }); await settled;
    expect(h.terminal).not.toHaveBeenCalled();
  });

  it('passes cancellation into provider-owned authentication prompts', async () => {
    const h = harness(); const authentication = deferred<any>(); const controller = new AbortController();
    const configureAuthentication = vi.fn(() => authentication.promise);
    Object.assign(h.provider, { configureAuthentication });
    const run = h.manager.authenticateProvider('test', controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(configureAuthentication).toHaveBeenCalledWith(controller.signal);
    controller.abort(); authentication.resolve({ authenticated: false }); await settled;
    expect(h.provider.discoverCli).not.toHaveBeenCalled(); expect(h.terminal).not.toHaveBeenCalled();
  });

  it('does not persist an API key returned from a prompt after Skip', async () => {
    const h = harness(); const input = deferred<string | undefined>(); const controller = new AbortController();
    vi.stubEnv('CURSOR_API_KEY', 'prior-test-key');
    vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(input.promise);
    const update = vi.fn(async () => undefined);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ update } as any);
    const run = h.manager.authenticateWithMethod('cursor', 'api-key', undefined, controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); input.resolve('new-test-key'); await settled;
    expect(update).not.toHaveBeenCalled(); expect(process.env.CURSOR_API_KEY).toBe('prior-test-key');
    expect(h.provider.checkAuthentication).not.toHaveBeenCalled();
  });

  it('stops the next credential stage if cancellation occurs during settings persistence', async () => {
    const h = harness(); const write = deferred<void>(); const controller = new AbortController();
    vi.stubEnv('CURSOR_API_KEY', 'prior-test-key');
    const update = vi.fn(() => write.promise);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ update } as any);
    const run = h.manager.authenticateWithMethod('cursor', 'api-key', 'new-test-key', controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(update).toHaveBeenCalledTimes(1); controller.abort(); write.resolve(); await settled;
    expect(process.env.CURSOR_API_KEY).toBe('prior-test-key');
    expect(h.provider.checkAuthentication).not.toHaveBeenCalled();
  });

  it('refuses already-cancelled entrypoints before discovery, prompts or installation', async () => {
    const h = harness(); const controller = new AbortController(); controller.abort();
    await expect(h.manager.setupProvider('test', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.manager.autoInstallCli('test', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.manager.authenticateProvider('test', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.manager.authenticateWithMethod('cursor', 'api-key', 'test-key', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.provider.discoverCli).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled();
    expect(h.terminal).not.toHaveBeenCalled();
  });
});

describe('shared installer cancellation', () => {
  it('stops after cancelled npm discovery without probing the network or starting an install', async () => {
    const h = harness(); const npm = deferred<boolean>(); const started = deferred<void>(); const controller = new AbortController();
    h.manager.checkNpmAvailable.mockImplementation(() => { started.resolve(); return npm.promise; });
    const run = h.manager.autoInstallCli('test', undefined, controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise; controller.abort(); npm.resolve(true); await settled;
    expect(h.manager.checkNetworkConnectivity).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled();
  });

  it('does not create a local-prefix fallback after cancellation during permission preflight', async () => {
    const h = harness(); const permission = deferred<boolean>(); const started = deferred<void>(); const controller = new AbortController();
    platform.writable.mockImplementation(() => { started.resolve(); return permission.promise; });
    const run = h.manager.autoInstallCli('test', undefined, controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise; controller.abort(); permission.resolve(false); await settled;
    expect(h.local).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled();
  });

  it.each(['network', 'permission'])('does not retry or fall back after a cancelled running command fails (%s)', async kind => {
    const h = harness(); const command = deferred<any>(); const started = deferred<void>(); const controller = new AbortController();
    h.command.mockImplementation(() => { started.resolve(); return command.promise; });
    vi.spyOn(h.manager, '_classifyError').mockReturnValue(kind);
    vi.spyOn(h.manager, '_delay').mockResolvedValue(undefined);
    const run = h.manager.autoInstallCli('test', undefined, controller.signal);
    const settled = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise; controller.abort(); command.resolve({ success: false, error: kind, exitCode: 1 }); await settled;
    expect(h.command).toHaveBeenCalledTimes(1); expect(h.local).not.toHaveBeenCalled();
    expect(h.provider.discoverCli).not.toHaveBeenCalled();
  });

  it('keeps a shared install alive for a second panel while cancelling the first caller', async () => {
    const h = harness(); const npm = deferred<boolean>(); const first = new AbortController(); const second = new AbortController();
    h.manager.checkNpmAvailable.mockReturnValue(npm.promise);
    h.provider.discoverCli.mockResolvedValue({ found: true, path: '/test/cli' });
    const one = h.manager.autoInstallCli('test', undefined, first.signal);
    const settledOne = expect(one).rejects.toMatchObject({ name: 'AbortError' });
    const two = h.manager.autoInstallCli('test', undefined, second.signal);
    first.abort(); npm.resolve(true);
    await expect(two).resolves.toMatchObject({ success: true }); await settledOne;
    expect(h.command).toHaveBeenCalledTimes(1); expect(h.manager._installRuns.size).toBe(0);
  });

  it('lets a fresh caller recover after an abandoned run settles without overlapping installers', async () => {
    const h = harness(); const command = deferred<any>(); const started = deferred<void>(); const first = new AbortController();
    h.command.mockImplementationOnce(() => { started.resolve(); return command.promise; }).mockResolvedValue({ success: true });
    h.provider.discoverCli.mockResolvedValue({ found: true, path: '/test/cli' });
    const one = h.manager.autoInstallCli('test', undefined, first.signal);
    const settledOne = expect(one).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise; first.abort(); const two = h.manager.autoInstallCli('test');
    await Promise.resolve();
    expect(h.command).toHaveBeenCalledTimes(1);
    command.resolve({ success: true });
    await settledOne; await expect(two).resolves.toMatchObject({ success: true });
    expect(h.command).toHaveBeenCalledTimes(2); expect(h.provider.discoverCli).toHaveBeenCalledTimes(1);
    expect(h.manager._installRuns.size).toBe(0);
  });
});
