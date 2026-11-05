import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { normalizeUsage, contextFillTokens } from '../../../src/services/TokenAccounting';
import type { Settings, StreamChunk } from '../../../src/types';

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async () => ({ ...await vi.importActual<typeof import('child_process')>('child_process'), spawn: boundary.spawn }));
vi.mock('../../../src/utils/processKill', async () => ({
  ...await vi.importActual<typeof import('../../../src/utils/processKill')>('../../../src/utils/processKill'),
  killProcessTree: vi.fn(async () => undefined),
}));

// Numeric-only projection of the retained Cline 3.0.61 three-call Act run.
// @cline/core's usage contract includes BOTH cache reads/writes in inputTokens;
// getCurrentContextSize uses the latest assistant call, not accumulated totals.
const calls = [
  { inputTokens: 96001, outputTokens: 74, cacheReadTokens: 832, cacheWriteTokens: 0, cost: 0.024572624400000003, totalCost: 0.024572624400000003 },
  { inputTokens: 96261, outputTokens: 147, cacheReadTokens: 96000, cacheWriteTokens: 0, cost: 0.00021840030000000107, totalCost: 0.024791024700000004 },
  { inputTokens: 96623, outputTokens: 90, cacheReadTokens: 96256, cacheWriteTokens: 0, cost: 0.00018704879999999896, totalCost: 0.024978073500000003 },
];
const total = { inputTokens: 288885, outputTokens: 311, cacheReadTokens: 193088, cacheWriteTokens: 0, totalCost: 0.024978073500000003 };
const usage = (value: object) => ({ type: 'agent_event', event: { type: 'usage', ...value } });
const result = (value: object) => ({ type: 'run_result', finishReason: 'completed', usage: value });
const settings: Settings = { provider: 'cline', model: 'deepseek/deepseek-chat', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };
let provider: TestableClineProvider;
let transcript: object[];
beforeEach(() => {
  provider = new TestableClineProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/owned/fake-cline');
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Owned accounting fixture');
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  boundary.spawn.mockReset().mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null as number | null, signalCode: null });
    const rows = transcript;
    setImmediate(() => {
      proc.stdout.write(JSON.stringify({ type: 'text', content: 'Owned fixture answer.' }) + '\n');
      for (const row of rows) proc.stdout.write(JSON.stringify(row) + '\n');
      proc.exitCode = 0; proc.stdout.end(); proc.stderr.end(); proc.emit('exit', 0, null); proc.emit('close', 0, null);
    });
    return proc;
  });
});
afterEach(() => { provider.dispose(); vi.restoreAllMocks(); });
async function send(rows: object[], panel = 'A'): Promise<StreamChunk & { contextUsage?: any }> {
  transcript = rows;
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage('Inspect fixture', [], settings, null, undefined, panel)) chunks.push(chunk);
  expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([]);
  const done = chunks.filter(chunk => chunk.type === 'done'); expect(done).toHaveLength(1);
  return done[0];
}

describe('Cline completion separates turn totals from latest model context', () => {
  it('retains native turn totals and cost while measuring the final call', async () => {
    const done = await send([...calls.map(usage), { type: 'agent_event', event: { type: 'done', usage: total } }, result(total)]);
    expect(done.usage).toMatchObject({ input_tokens: 95797, output_tokens: 311, cache_read_input_tokens: 193088, normalized: true, reportedCostUsd: total.totalCost });
    expect(done.contextUsage).toMatchObject({ input_tokens: 367, output_tokens: 90, cache_read_input_tokens: 96256, normalized: true });
    expect(contextFillTokens(done.contextUsage)).toBe(96623);
  });

  it('uses measured call totals if a valid stream has no aggregate result', async () => {
    const done = await send(calls.map(usage));
    expect(done.usage).toMatchObject({ input_tokens: 95797, output_tokens: 311, cache_read_input_tokens: 193088 });
    expect(done.usage?.reportedCostUsd).toBeCloseTo(total.totalCost);
    expect(contextFillTokens(done.contextUsage)).toBe(96623);
  });

  it('does not add cumulative cost when the native translator omits a zero cost delta', async () => {
    // Installed translateUsage emits cost: undefined for a zero delta while
    // retaining totalCost. That cumulative value is not another call's charge.
    const done = await send([
      usage({ inputTokens: 100, outputTokens: 10, cost: 1, totalCost: 1 }),
      usage({ inputTokens: 120, outputTokens: 5, totalCost: 1 }),
    ]);
    expect(done.usage?.reportedCostUsd).toBe(1);
    expect(done.usage?.output_tokens).toBe(15);
    expect(done.contextUsage?.reportedCostUsd).toBeUndefined();
  });

  it('does not reuse an earlier call after a new iteration reports no usage', async () => {
    const done = await send([
      { type: 'agent_event', event: { type: 'iteration_start', iteration: 1 } }, usage(calls[0]),
      { type: 'agent_event', event: { type: 'iteration_start', iteration: 2 } }, result(total),
    ]);
    expect(done.contextUsage).toBeNull();
    expect(done.usage?.output_tokens).toBe(311);
  });

  it('accepts done totals without confusing them with latest-call context', async () => {
    const done = await send([usage(calls[2]), { type: 'agent_event', event: { type: 'done', usage: total } }]);
    expect(done.usage).toMatchObject({ input_tokens: 95797, output_tokens: 311 });
    expect(contextFillTokens(done.contextUsage)).toBe(96623);
  });

  it.each(['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4.5'])('normalizes reads AND writes exactly once for %s', async model => {
    const raw = { inputTokens: 10000, outputTokens: 15, cacheReadTokens: 6000, cacheWriteTokens: 3000 };
    const done = await send([usage(raw), result(raw)]);
    expect(done.usage).toMatchObject({ input_tokens: 1000, cache_read_input_tokens: 6000, cache_creation_input_tokens: 3000, normalized: true });
    expect(normalizeUsage(done.usage!, 'auto', model)).toEqual(done.usage);
    expect(contextFillTokens(normalizeUsage(done.contextUsage, 'auto', model))).toBe(10000);
  });

  it('keeps aggregate-only usage measurable as cost but latest context explicitly unknown', async () => {
    const done = await send([result(total)]);
    expect(done.usage?.output_tokens).toBe(311);
    expect(done.contextUsage).toBeNull();
  });

  it.each([undefined, null, -1, '100', 0])('does not promote invalid latest input %j or an earlier call to current context', async inputTokens => {
    const done = await send([usage(calls[0]), usage({ inputTokens, outputTokens: 3, cacheReadTokens: 25 }), result(total)]);
    expect(done.contextUsage).toBeNull();
    expect(done.usage?.output_tokens).toBe(311);
  });

  it('does not accept inconsistent cache subsets as measured context', async () => {
    const done = await send([usage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 90, cacheWriteTokens: 30 }), result(total)]);
    expect(done.contextUsage).toBeNull();
  });

  it('keeps a later turn and another panel from borrowing context', async () => {
    expect(contextFillTokens((await send([usage(calls[2]), result(total)])).contextUsage)).toBe(96623);
    expect((await send([result(total)], 'B')).contextUsage).toBeNull();
    expect((await send([result(total)], 'A')).contextUsage).toBeNull();
    provider.clearSession('A');
    expect((await send([result(total)], 'A')).contextUsage).toBeNull();
  });

  it('leaves legacy vendor-native usage and its implicit context contract intact', async () => {
    const done = await send([{ type: 'done', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 } }]);
    expect(done.usage).toEqual({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 });
    expect(done.contextUsage).toBeUndefined();
  });
});
