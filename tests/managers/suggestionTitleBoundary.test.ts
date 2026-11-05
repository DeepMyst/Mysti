import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionManager } from '../../src/managers/SuggestionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', async original => ({ ...await original<typeof import('../../src/utils/processKill')>(), killProcessTree: vi.fn(async () => {}) }));
let manager: SuggestionManager;
let child: any;
beforeEach(() => {
  vi.useFakeTimers(); clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/title-worker');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.spawn.mockReset().mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    return child;
  });
  manager = new SuggestionManager({} as any);
});
afterEach(() => { manager.dispose(); child?.emit('close', null); child = undefined; vi.clearAllTimers(); vi.useRealTimers(); clearMockConfig(); vi.restoreAllMocks(); });

const boundary = 'A'.repeat(49) + '😀 report';
function complete(output: string, code = 0) { child.stdout.emit('data', Buffer.from(output)); child.emit('close', code); }

describe('conversation title truncation preserves valid Unicode and accurate ellipses', () => {
  it('generated title excludes a whole astral character that does not fit the existing 50-unit bound', async () => {
    const pending = manager.generateTitle('Review a report'); complete(boundary);
    expect(await pending).toBe('A'.repeat(49));
  });
  it('a generated astral character that exactly fits the existing bound is retained', async () => {
    const expected = 'A'.repeat(48) + '😀'; const pending = manager.generateTitle('Review a report'); complete(expected + ' more');
    expect(await pending).toBe(expected);
  });
  it('a nonzero title worker returns a valid truncated fallback', async () => {
    const pending = manager.generateTitle(boundary); complete('ignored title', 1);
    expect(await pending).toBe('A'.repeat(49) + '...');
  });
  it('a title worker timeout returns a valid truncated fallback', async () => {
    const pending = manager.generateTitle(boundary); await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toBe('A'.repeat(49) + '...');
  });
  it('a disposed manager returns a valid truncated fallback without starting work', async () => {
    manager.dispose(); expect(await manager.generateTitle(boundary)).toBe('A'.repeat(49) + '...'); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('surrounding whitespace alone does not imply omitted fallback content', async () => {
    manager.dispose(); expect(await manager.generateTitle('  Review café 😀 reports  ')).toBe('Review café 😀 reports');
  });
  it('an exactly fitting Unicode fallback does not imply omitted content', async () => {
    const text = 'A'.repeat(48) + '😀'; manager.dispose(); expect(await manager.generateTitle(text)).toBe(text);
  });
  it('a real ASCII overflow retains the existing limit and ellipsis policy', async () => {
    manager.dispose(); expect(await manager.generateTitle('A'.repeat(51))).toBe('A'.repeat(50) + '...');
  });
});
