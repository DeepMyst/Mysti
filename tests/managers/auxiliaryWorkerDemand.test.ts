import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionManager } from '../../src/managers/SuggestionManager';
import { PlanOptionManager } from '../../src/managers/PlanOptionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type { Conversation, Message } from '../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', async original => ({ ...await original<typeof import('../../src/utils/processKill')>(),
  killProcessTree: vi.fn(async proc => { proc?.kill('SIGKILL'); }) }));
const managers: Array<{ dispose(): void }> = [];
let children: any[];
const content = 'Compare bounded retries and explain how their limits protect the server.';
const resultFor = (prompt: string) => prompt.startsWith('Generate a short') ? 'Bounded retries review'
  : prompt.startsWith('Given this AI response') ? JSON.stringify([{ title: 'Add tests', prompt: 'Test the retry cap' }])
    : JSON.stringify({ questions: [], planOptions: [], context: 'Bounded retry classification' });
beforeEach(() => {
  vi.useFakeTimers(); clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/deadline-worker'); children = [];
  mocks.spawn.mockReset().mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, deadlineMissed: false, prompt: '', closed: false, kill: vi.fn() });
    const close = (code: number) => { if (proc.closed) return; proc.closed = true; proc.exitCode = code; proc.emit('exit', code); proc.emit('close', code); };
    // Reproduce the real CLI boundary: startup commits to no-input failure at 3s,
    // and only closes later. A 3.5s request can still find the stale pooled handle.
    const deadline = setTimeout(() => { proc.deadlineMissed = !proc.prompt; }, 3000);
    const timeoutClose = setTimeout(() => { if (proc.deadlineMissed) { proc.stderr.write('No stdin received; input required for --print'); close(1); } }, 4000);
    proc.stdin.on('data', data => { proc.prompt += data.toString(); });
    proc.stdin.on('finish', () => {
      if (proc.deadlineMissed) return;
      clearTimeout(deadline); clearTimeout(timeoutClose);
      setTimeout(() => { proc.stdout.write(resultFor(proc.prompt)); close(0); }, 0);
    });
    proc.kill.mockImplementation(() => { clearTimeout(deadline); clearTimeout(timeoutClose); close(1); return true; });
    children.push(proc); return proc;
  });
});
afterEach(() => {
  managers.splice(0).forEach(manager => manager.dispose()); children.forEach(child => child.emit('close', null));
  vi.clearAllTimers(); vi.useRealTimers(); clearMockConfig(); vi.restoreAllMocks();
});
function create(kind: 'title' | 'suggestions' | 'classification') {
  const manager = kind === 'classification' ? new PlanOptionManager() : new SuggestionManager({} as any); managers.push(manager);
  return { manager, invoke: () => kind === 'classification' ? (manager as PlanOptionManager).classifyResponse(content)
    : kind === 'title' ? (manager as SuggestionManager).generateTitle(content)
      : (manager as SuggestionManager).generateSuggestions({} as Conversation, { content } as Message).catch(() => []) };
}
function assertResult(kind: string, result: any) {
  if (kind === 'title') expect(result).toBe('Bounded retries review');
  else if (kind === 'classification') expect(result).toMatchObject({ context: 'Bounded retry classification' });
  else expect(result).toEqual([expect.objectContaining({ message: 'Test the retry cap' })]);
}

describe('PB02-D08 optional workers start only with ready prompts', () => {
  it.each(['title', 'suggestions', 'classification'] as const)('%s remains usable after the CLI startup input deadline', async kind => {
    const operation = create(kind);
    await vi.advanceTimersByTimeAsync(3500);
    const pending = operation.invoke(); await vi.advanceTimersByTimeAsync(1000);
    assertResult(kind, await pending);
    expect(children).toHaveLength(1); expect(children[0].deadlineMissed).toBe(false);
    expect(children[0].closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('idle constructors and completed operations spawn no unused replacement workers', async () => {
    const operations = (['title', 'suggestions', 'classification'] as const).map(kind => ({ kind, ...create(kind) }));
    expect(mocks.spawn.mock.calls.length).toBe(0); await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.spawn.mock.calls.length).toBe(0);
    for (const [index, operation] of operations.entries()) {
      const pending = operation.invoke(); await vi.advanceTimersByTimeAsync(0); assertResult(operation.kind, await pending);
      expect(children).toHaveLength(index + 1); expect(children.every(child => child.closed)).toBe(true);
      await vi.advanceTimersByTimeAsync(20000); expect(children).toHaveLength(index + 1);
    }
  });
});
