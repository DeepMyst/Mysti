import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  execute: vi.fn(), processListeners: new Set<(e: any) => void>(), endListeners: new Set<(e: any) => void>(),
}));
vi.mock('vscode', async importOriginal => ({
  ...await importOriginal<typeof import('vscode')>(),
  Task: class {
    constructor(public definition: unknown, public scope: unknown, public name: string, public source: string, public execution: unknown) {}
  },
  ShellExecution: class { constructor(public command: string, public args: string[]) {} },
  TaskScope: { Global: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
  tasks: {
    executeTask: mock.execute,
    onDidEndTaskProcess: (callback: (e: any) => void) => {
      mock.processListeners.add(callback);
      return { dispose: () => mock.processListeners.delete(callback) };
    },
    onDidEndTask: (callback: (e: any) => void) => {
      mock.endListeners.add(callback);
      return { dispose: () => mock.endListeners.delete(callback) };
    },
  },
}));
import { runCliUpgradeTask } from '../../src/services/CliModelUpgrade';

describe('CLI upgrade terminal task', () => {
  let execution: any;
  beforeEach(() => {
    mock.execute.mockReset().mockImplementation(async task => {
      execution = { task, terminate: vi.fn() };
      return execution;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    expect(mock.processListeners.size).toBe(0);
    expect(mock.endListeners.size).toBe(0);
  });
  const plan = { executable: '/path with spaces/claude', args: ['install', 'latest'] };
  const finish = (exitCode: number | undefined, source = execution) => {
    for (const callback of mock.processListeners) callback({ execution: source, exitCode });
  };

  it('runs a visible task with separate command/arguments and waits for its own exit', async () => {
    const pending = runCliUpgradeTask('Claude', plan);
    expect(execution.task.execution).toMatchObject({ command: plan.executable, args: ['install', 'latest'] });
    expect(execution.task.presentationOptions.reveal).toBe(1);
    finish(0, { task: { definition: { id: 'unrelated' } } });
    expect(mock.processListeners.size).toBe(1);
    finish(0);
    await pending;
  });
  it.each([1, undefined])('reports unsuccessful/cancelled exit %s', async exitCode => {
    const pending = runCliUpgradeTask('Claude', plan);
    finish(exitCode);
    await expect(pending).rejects.toThrow(exitCode === undefined ? 'cancelled' : 'code 1');
  });
  it('reports a task that ends without launching a process', async () => {
    const pending = runCliUpgradeTask('Claude', plan);
    for (const callback of mock.endListeners) callback({ execution });
    await expect(pending).rejects.toThrow('without a successful install');
  });
  it('cleans up when the task API rejects the launch', async () => {
    mock.execute.mockRejectedValueOnce(new Error('Task launch failed'));
    await expect(runCliUpgradeTask('Claude', plan)).rejects.toThrow('Task launch failed');
  });
  it('terminates a timed-out installer and cleans up listeners', async () => {
    vi.useFakeTimers();
    const pending = runCliUpgradeTask('Claude', plan);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await assertion;
    expect(execution.terminate).toHaveBeenCalledOnce();
  });
});
