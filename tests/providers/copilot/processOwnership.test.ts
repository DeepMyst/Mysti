import { execFileSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { ProviderManager } from '../../../src/managers/ProviderManager';
import { killProcessTree } from '../../../src/utils/processKill';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import type { Settings } from '../../../src/types';

// Matches the installed npm-loader.js: the tracked Node shim blocks in
// spawnSync while its native child owns the actual work and inherited pipes.
const nativeSource = `process.stdout.write('READY:' + process.pid + '\\n'); setInterval(() => process.stdout.write('tick\\n'), 20);`;

function running(pid: number): boolean {
  try {
    // An adopted child can briefly remain a zombie until init reaps it.
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch { return false; }
}

function fixture(childSource = nativeSource) {
  const oldFolders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true, value: [{ uri: { fsPath: process.cwd() } }],
  });
  const provider = new TestableCopilotProvider();
  const wrapperSource = `require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'inherit' });`;
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildCliArgs').mockReturnValue(['-e', wrapperSource, '--']);
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('fixture');
  const state = {
    _activePanelProcesses: new Map<string, ChildProcess>(),
    _panelProviders: new Map<string, string>(),
    _nativeApprovalTurns: new Map(),
    _getPanelProvider: () => provider,
  };
  const tracker = {
    registerProcess: (panelId: string, proc: ChildProcess) => state._activePanelProcesses.set(panelId, proc),
    clearProcess: (panelId: string, proc?: ChildProcess) => ProviderManager.prototype.clearProcess.call(state as unknown as ProviderManager, panelId, proc),
  };
  const children: number[] = [];
  const wrappers: ChildProcess[] = [];
  const start = async () => {
    const stream = provider.sendMessage('fixture', [], {} as Settings, null, undefined, 'copilot-fixture', tracker);
    expect((await stream.next()).value?.type).toBe('session_active');
    const proc = state._activePanelProcesses.get('copilot-fixture')!;
    wrappers.push(proc);
    let output = '';
    proc.stdout!.on('data', chunk => { output += String(chunk); });
    await vi.waitFor(() => expect(output).toMatch(/READY:\d+/), { timeout: 3000 });
    const pid = Number(/READY:(\d+)/.exec(output)![1]);
    children.push(pid);
    return { stream, proc, pid, output: () => output };
  };
  return {
    provider, start,
    cancel: () => ProviderManager.prototype.cancelRequest.call(state as unknown as ProviderManager, 'copilot-fixture'),
    async cleanup() {
      // Only PIDs supplied by these disposable fixtures are ever targeted.
      for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      for (const proc of wrappers) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
      provider.dispose();
      await vi.waitFor(() => expect(children.some(running)).toBe(false), { timeout: 3000 });
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: oldFolders });
    },
  };
}

describe.skipIf(process.platform === 'win32')('Copilot owns its wrapper and native child on POSIX', () => {
  afterEach(() => vi.restoreAllMocks());

  it('escalates a native child that ignores SIGTERM after its wrapper has exited', async () => {
    const h = fixture(`process.on('SIGTERM', () => {}); ${nativeSource}`);
    try {
      const child = await h.start();
      const wrapperExited = new Promise<void>(resolve => child.proc.once('exit', () => resolve()));
      const terminated = killProcessTree(child.proc, 500);
      await wrapperExited;
      expect(running(child.pid), 'The native child must survive SIGTERM to exercise escalation').toBe(true);
      await terminated;
      await vi.waitFor(() => expect(running(child.pid)).toBe(false), { timeout: 1000 });
      await child.stream.return(undefined);
    } finally { await h.cleanup(); }
  }, 10_000);

  it('Stop terminates the native child and the next request can start and stop cleanly', async () => {
    const h = fixture();
    try {
      const first = await h.start();
      expect(running(first.pid)).toBe(true);
      h.cancel();
      await vi.waitFor(() => expect(running(first.pid)).toBe(false), { timeout: 1000 });
      const second = await h.start();
      // Late cleanup of the old request must not erase/kill its replacement.
      await first.stream.return(undefined);
      expect(second.pid).not.toBe(first.pid);
      expect(running(second.pid)).toBe(true);
      h.cancel();
      await second.stream.return(undefined);
      await vi.waitFor(() => expect(running(second.pid)).toBe(false), { timeout: 1000 });
    } finally { await h.cleanup(); }
  }, 10_000);

  it('a legacy permission pause freezes native work, resumes it, and Stop kills a frozen child', async () => {
    const h = fixture();
    try {
      const child = await h.start();
      await vi.waitFor(() => expect(child.output()).toContain('tick'));
      expect(h.provider.suspendProcess('copilot-fixture')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 60));
      const paused = child.output();
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(child.output()).toBe(paused);
      expect(h.provider.resumeProcess('copilot-fixture')).toBe(true);
      await vi.waitFor(() => expect(child.output().length).toBeGreaterThan(paused.length));
      expect(h.provider.suspendProcess('copilot-fixture')).toBe(true);
      const session = (h.provider as unknown as { _getSession(id: string): PanelSessionState })._getSession('copilot-fixture');
      expect(session.suspended).toBe(true);
      h.cancel();
      await child.stream.return(undefined);
      await vi.waitFor(() => expect(running(child.pid)).toBe(false), { timeout: 1000 });
    } finally { await h.cleanup(); }
  }, 10_000);
});
