import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionManager } from '../../src/managers/SuggestionManager';
import { PlanOptionManager } from '../../src/managers/PlanOptionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type { Conversation, Message } from '../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../src/utils/processKill')>(),
  killProcessTree: vi.fn(async (proc, _grace, options) => { proc?.kill(options?.initialSignal || 'SIGTERM'); }),
}));

const CONTENT = 'Please compare these retry approaches and explain the tradeoffs of each option.';
const managers: Array<{ dispose(): void }> = [];
let children: any[];
let failStdinWrite: boolean;
const suggestions = () => {
  const manager = new SuggestionManager({} as any); managers.push(manager); return manager;
};
const plans = () => { const manager = new PlanOptionManager(); managers.push(manager); return manager; };
const suggest = (manager: SuggestionManager) => manager.generateSuggestions({} as Conversation, { content: CONTENT } as Message).catch(() => []);
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/worker'); children = []; failStdinWrite = false;
  mocks.spawn.mockReset().mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn(() => true) });
    if (failStdinWrite) vi.spyOn(proc.stdin, 'write').mockImplementation(() => { throw new Error('controlled closed stdin'); });
    children.push(proc); return proc;
  });
});
afterEach(() => {
  managers.splice(0).forEach(manager => manager.dispose());
  // The mock kill does not deliver OS close; settle that lifecycle boundary so
  // the real worker helper can release each test's private working directory.
  children.forEach(child => child.emit('close', null));
  vi.clearAllTimers(); vi.useRealTimers(); clearMockConfig(); vi.restoreAllMocks();
});

describe('PC-07 auxiliary workers own disposal and late callbacks', () => {
  it('disposing suggestions terminates both active title and suggestion workers', async () => {
    const manager = suggestions(); const title = manager.generateTitle(CONTENT);
    const pending = suggest(manager);
    expect(children).toHaveLength(2);
    manager.dispose();
    expect(children[0].kill, 'The active title belongs to this manager too').toHaveBeenCalled();
    expect(children[1].kill).toHaveBeenCalled();
    children.forEach(child => child.emit('close', null)); await Promise.all([title, pending]);
  });

  it.each(['suggestions', 'title', 'classification'] as const)('%s settles immediately on disposal without waiting for child close', async kind => {
    const manager = kind === 'classification' ? plans() : suggestions();
    const pending = kind === 'classification' ? (manager as PlanOptionManager).classifyResponse(CONTENT)
      : kind === 'title' ? (manager as SuggestionManager).generateTitle(CONTENT) : suggest(manager as SuggestionManager);
    let settled = false; void pending.then(() => { settled = true; });
    manager.dispose(); await flush();
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });

  it.each(['suggestions', 'title', 'classification'] as const)('%s late close/error cannot respawn workers after disposal', async kind => {
    const manager = kind === 'classification' ? plans() : suggestions();
    const pending = kind === 'classification' ? (manager as PlanOptionManager).classifyResponse(CONTENT)
      : kind === 'title' ? (manager as SuggestionManager).generateTitle(CONTENT) : suggest(manager as SuggestionManager);
    const before = mocks.spawn.mock.calls.length;
    manager.dispose();
    children[0].emit('error', new Error('late owned-worker error'));
    children[0].emit('close', 1); await pending;
    expect(mocks.spawn).toHaveBeenCalledTimes(before);
  });

  it('a cancelled suggestion close cannot erase ownership of its replacement', async () => {
    const manager = suggestions();
    const first = suggest(manager); const old = children[0];
    const second = suggest(manager); const replacement = children[1];
    old.emit('close', null); await first;
    manager.cancelGeneration();
    expect(replacement.kill).toHaveBeenCalled();
    replacement.emit('close', null); await second;
  });

  it('classification disposal terminates and settles every concurrently owned request', async () => {
    const manager = plans();
    const requests = [1, 2, 3].map(number => manager.classifyResponse(CONTENT + number));
    manager.dispose();
    expect(children).toHaveLength(3);
    for (const child of children) expect(child.kill).toHaveBeenCalled();
    for (const child of children) child.emit('close', null);
    await Promise.all(requests);
  });

  it('disposed APIs return harmless results without creating new workers', async () => {
    const manager = suggestions(); const planManager = plans();
    manager.dispose(); planManager.dispose();
    const before = mocks.spawn.mock.calls.length;
    const pending = [suggest(manager), manager.generateTitle(CONTENT), planManager.classifyResponse(CONTENT)];
    expect(mocks.spawn).toHaveBeenCalledTimes(before);
    await Promise.all(pending);
  });

  it.each(['suggestions', 'classification'] as const)('%s drains diagnostic pipes beyond the stream high-water mark', async kind => {
    const manager = kind === 'suggestions' ? suggestions() : plans();
    const pending = kind === 'suggestions' ? suggest(manager as SuggestionManager)
      : (manager as PlanOptionManager).classifyResponse(CONTENT);
    expect(children).toHaveLength(1);
    const callbacks = children.map(child => {
      const drained = vi.fn(); child.stderr.write(Buffer.alloc(256 * 1024, 120), drained); return drained;
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const drained of callbacks) expect(drained).toHaveBeenCalledOnce();
    manager.dispose(); await pending;
  });

  it('successful title, suggestion and classification results survive the lifecycle changes', async () => {
    const manager = suggestions();
    const title = manager.generateTitle(CONTENT); const titleWorker = children[0];
    titleWorker.stdout.write('Retry design review'); titleWorker.emit('close', 0);
    expect(await title).toBe('Retry design review');
    const pending = suggest(manager); const worker = children[1];
    worker.stdout.write(JSON.stringify([{ title: 'Compare retries', description: 'Compare the retry limits', prompt: 'Compare limits now' }]));
    worker.emit('close', 0);
    expect(await pending).toEqual([expect.objectContaining({ title: 'Compare retries', message: 'Compare limits now' })]);
    const planManager = plans();
    const classification = planManager.classifyResponse(CONTENT);
    const planWorker = children.at(-1);
    planWorker.stdout.write(JSON.stringify({ questions: [], planOptions: [{ title: 'Bound retries', approach: 'Limit attempts to three.' }], context: 'Retry options' }));
    planWorker.emit('close', 0);
    expect(await classification).toMatchObject({ context: 'Retry options', planOptions: [{ title: 'Bound retries', approach: 'Limit attempts to three.' }] });
  });

  it('a title timeout returns its fallback while a suggestion timeout can use complete partial JSON', async () => {
    const manager = suggestions();
    const title = manager.generateTitle('Original request title'); const titleWorker = children[0];
    titleWorker.stdout.write('Unfinished generated title');
    await vi.advanceTimersByTimeAsync(20000);
    expect(await title).toBe('Original request title');
    expect(titleWorker.kill).toHaveBeenCalled();
    const pending = suggest(manager); const worker = children[1];
    worker.stdout.write('[{"title":"Retry tests","prompt":"Add retry tests"}]');
    await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toEqual([expect.objectContaining({ message: 'Add retry tests' })]);
    expect(worker.kill).toHaveBeenCalled();
    const spawned = children.length; worker.emit('close', 0);
    expect(children).toHaveLength(spawned);
  });

  it.each(['suggestions', 'title', 'classification'] as const)('%s handles a synchronous stdin write failure without leaking a pending operation', async kind => {
    const manager = kind === 'classification' ? plans() : suggestions();
    failStdinWrite = true;
    const pending = kind === 'classification' ? (manager as PlanOptionManager).classifyResponse(CONTENT)
      : kind === 'title' ? (manager as SuggestionManager).generateTitle(CONTENT) : suggest(manager as SuggestionManager);
    await pending;
    const failed = children[0];
    expect(failed.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
