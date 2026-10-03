import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { SetupManager } from '../../src/managers/SetupManager';
function harness() {
  const provider = { id: 'openai-codex', displayName: 'Codex', capabilities: { supportsAutoInstall: true },
    getInstallCommand: () => 'npm install -g @openai/codex', getAuthCommand: () => 'codex login',
    discoverCli: vi.fn(async () => ({ found: true })), checkAuthentication: vi.fn(async () => ({ authenticated: true })) };
  const discovery = { onDidChange: () => ({}), invalidate: vi.fn(), refresh: vi.fn(async () => []) };
  const context = { subscriptions: [], globalState: { get: () => undefined } } as any;
  const manager = new SetupManager(context, { getProviderInstance: () => provider } as any, discovery as any);
  return { manager, provider, discovery, context };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('installer reliability', () => {
  it('does not require Node when an installed CLI is already ready', async () => {
    const h = harness();
    const node = vi.spyOn(h.manager as any, '_checkNodeVersion').mockResolvedValue({ meets: false });
    expect(await h.manager.setupProvider('openai-codex')).toMatchObject({ success: true });
    expect(node).not.toHaveBeenCalled();
  });
  it('shares an in-flight installation and permits a later retry', async () => {
    const { manager } = harness();
    let resolve!: (v: any) => void;
    const actual = vi.spyOn(manager as any, '_autoInstallCli').mockImplementation(() => new Promise(r => { resolve = r; }));
    const a = manager.autoInstallCli('openai-codex'), b = manager.autoInstallCli('openai-codex');
    expect(actual).toHaveBeenCalledOnce();
    resolve({ success: false });
    expect(await a).toEqual(await b);
    const c = manager.autoInstallCli('openai-codex');
    expect(actual).toHaveBeenCalledTimes(2);
    resolve({ success: true });
    expect(await c).toEqual({ success: true });
  });
  it('prompts securely for an API key instead of opening OAuth', async () => {
    const { manager } = harness();
    vi.stubEnv('OPENAI_API_KEY', '');
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('test-key');
    const terminal = vi.fn();
    (vscode.window as any).createTerminal = terminal;
    expect(await manager.authenticateWithMethod('openai-codex', 'api-key')).toMatchObject({ authenticated: true });
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ password: true }));
    expect(process.env.OPENAI_API_KEY).toBe('test-key');
    expect(terminal).not.toHaveBeenCalled();
  });
  it('launches sign-in using the discovered binary and includes its directory on PATH', async () => {
    const { manager, provider } = harness();
    const binary = path.resolve('private prefix', 'bin', 'codex');
    provider.discoverCli.mockResolvedValue({ found: true, path: binary } as any);
    const terminal = { show: vi.fn(), sendText: vi.fn() };
    (vscode.window as any).createTerminal = vi.fn(() => terminal);
    await manager.authenticateProvider('openai-codex');
    expect(terminal.sendText).toHaveBeenCalledWith(expect.stringContaining(binary));
    expect(terminal.sendText.mock.calls[0][0]).toMatch(/ login$/);
    expect((vscode.window as any).createTerminal).toHaveBeenCalledWith(expect.objectContaining({ env: { PATH: expect.stringContaining(path.dirname(binary)) } }));
  });

  it('cancelling API-key entry does not fall through to a CLI login', async () => {
    const { manager } = harness();
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    const terminal = vi.fn();
    (vscode.window as any).createTerminal = terminal;
    expect(await manager.authenticateWithMethod('openai-codex', 'api-key')).toMatchObject({ authenticated: false, error: expect.stringContaining('cancelled') });
    expect(terminal).not.toHaveBeenCalled();
  });
  it('routes OpenRouter configuration to settings, never runs prose as a command', async () => {
    const { manager } = harness();
    const terminal = vi.fn();
    (vscode.window as any).createTerminal = terminal;
    const command = vi.spyOn(vscode.commands, 'executeCommand');
    await manager.authenticateProvider('openrouter');
    expect(command).toHaveBeenCalledWith('workbench.action.openSettings', 'mysti.openrouter.apiKey');
    expect(terminal).not.toHaveBeenCalled();
  });
  it('uses the Gemini CLI for Vertex AI setup and rejects obsolete GCA setup', async () => {
    const { manager, provider } = harness();
    provider.getAuthCommand = () => 'gemini';
    const terminal = { show: vi.fn(), sendText: vi.fn() };
    (vscode.window as any).createTerminal = vi.fn(() => terminal);
    expect(manager.getAuthOptions('google-gemini')).toContainEqual(expect.objectContaining({ id: 'vertex-ai', action: 'cli-login' }));
    await manager.authenticateWithMethod('google-gemini', 'cli-login');
    expect(terminal.sendText).toHaveBeenCalledExactlyOnceWith('gemini');
    expect(await manager.authenticateWithMethod('google-gemini', 'gca')).toMatchObject({ authenticated: false, error: expect.stringContaining('not supported') });
    expect(terminal.sendText).toHaveBeenCalledOnce();
  });
  it('deduplicates install watchers, avoids overlapping probes and disposes timers', async () => {
    vi.useFakeTimers();
    const { manager, discovery, context } = harness();
    let resolve!: (v: any) => void;
    discovery.refresh.mockImplementation(() => new Promise(r => { resolve = r; }));
    manager.watchForInstall('openai-codex', undefined, 10);
    manager.watchForInstall('openai-codex', undefined, 10);
    await vi.advanceTimersByTimeAsync(30);
    expect(discovery.refresh).toHaveBeenCalledOnce();
    resolve([{ found: true }]);
    await vi.advanceTimersByTimeAsync(30);
    expect(discovery.refresh).toHaveBeenCalledOnce();
    manager.watchForInstall('other', undefined, 10);
    for (const disposable of context.subscriptions) disposable.dispose();
    await vi.advanceTimersByTimeAsync(30);
    expect(discovery.refresh).toHaveBeenCalledOnce();
  });
});
