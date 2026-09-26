import { describe, it, expect, vi } from 'vitest';
import { runMystiSubagent, type SubagentPorts } from '../../src/coordinator/MystiSubagentRunner';
import type { CoordinatorStreamEvent } from '../../src/services/CoordinatorModelClient';

const N = 'sub12345';
const REPORT = '## Result\nfound it\n## Evidence\nsrc/a.ts:1\n## Changes\nnone\n## Open questions\nnone';

function ports(scripts: CoordinatorStreamEvent[][], over: Partial<SubagentPorts> = {}) {
  const requests: string[][] = [];
  let cancelled = false;
  const p: SubagentPorts = {
    stream: async function* (messages) {
      requests.push(messages.map(m => m.content));
      yield* (scripts[requests.length - 1] ?? [{ text: '' }]);
    },
    isCancelled: () => cancelled,
    registerAbort: () => {},
    runRead: vi.fn(async d => ({ ok: true, output: `contents of ${'path' in d ? d.path : d.kind}` })),
    fence: (kind, output) => `<<FENCE ${kind}>>${output}<</FENCE>>`,
    trace: vi.fn(),
    ...over,
  };
  return { p, requests, cancel: () => { cancelled = true; } };
}
const cfg = { id: 'c1', directiveNonce: N, brief: '## Task\nfind it' };

describe('runMystiSubagent', () => {
  it('runs read tools, then returns only the report', async () => {
    const h = ports([[{ text: `<read:${N}>src/a.ts</read>` }], [{ text: `Looked.\n${REPORT}` }]]);
    const r = await runMystiSubagent(cfg, h.p);
    expect(h.p.runRead).toHaveBeenCalledWith({ kind: 'read', path: 'src/a.ts' });
    expect(h.requests[1].at(-1)).toContain('<<FENCE read>>contents of src/a.ts');
    expect(r.summary).toBe(REPORT);
    expect(r.hasError).toBe(false);
    expect(r.roundTrips).toBe(2);
    expect(r.toolCalls).toBe(1);
  });

  it('runs native tool calls through the same path', async () => {
    const h = ports([[{ toolCalls: [{ id: 't1', name: 'grep', arguments: '{"pattern":"auth"}' }] }], [{ text: REPORT }]]);
    await runMystiSubagent(cfg, h.p);
    expect(h.p.runRead).toHaveBeenCalledWith({ kind: 'grep', pattern: 'auth', include: undefined });
  });

  it('is read-only without runExec: a write tag is plain text, never executed', async () => {
    const h = ports([[{ text: `<write:${N} path="x.ts">evil</write>\n${REPORT}` }]]);
    const r = await runMystiSubagent(cfg, h.p);
    expect(r.wrote).toBe(false);
    expect(h.requests[0][0]).toContain('READ-ONLY');
  });

  it('is read-only without runExec: a NATIVE write tool call is refused, never executed (T14)', async () => {
    const h = ports([[{ toolCalls: [{ id: 't1', name: 'write', arguments: '{"path":"x.ts","content":"evil"}' }] }], [{ text: REPORT }]]);
    const r = await runMystiSubagent(cfg, h.p);
    expect(h.requests[1].at(-1)).toBe('"write" is not available to you.');
    expect(h.p.runRead).not.toHaveBeenCalled();
    expect(h.p.trace).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_use' }));
    expect(r.wrote).toBe(false);
  });

  it('cannot delegate further (depth 1)', async () => {
    const h = ports([[{ text: `<delegate:${N} agent="mysti">more</delegate>\n${REPORT}` }]]);
    const r = await runMystiSubagent(cfg, h.p);
    expect(r.roundTrips).toBe(1);
    expect(h.p.runRead).not.toHaveBeenCalled();
  });

  it('writes through runExec when given one', async () => {
    const runExec = vi.fn(async () => ({ ok: true, output: 'wrote x.ts' }));
    const h = ports([[{ text: `<write:${N} path="x.ts">content</write>` }], [{ text: REPORT }]], { runExec });
    const r = await runMystiSubagent(cfg, h.p);
    expect(runExec).toHaveBeenCalledWith({ kind: 'write', path: 'x.ts', content: 'content' }, 'c1-t0');
    expect(r.wrote).toBe(true);
  });

  it('enforces the tool budget', async () => {
    const h = ports([[{ text: `<read:${N}>a</read>` }], [{ text: `<read:${N}>b</read>` }], [{ text: REPORT }]]);
    await runMystiSubagent({ ...cfg, maxTools: 1 }, h.p);
    expect(h.p.runRead).toHaveBeenCalledTimes(1);
    expect(h.requests[2].at(-1)).toContain('Tool budget reached (1)');
  });

  it('reports a model error as a failure', async () => {
    const h = ports([[{ error: '401 unauthorized' }]]);
    const r = await runMystiSubagent(cfg, h.p);
    expect(r.hasError).toBe(true);
    expect(r.error).toBe('401 unauthorized');
  });

  it('stops when cancelled', async () => {
    const h = ports([[{ text: `<read:${N}>a</read>` }], [{ text: REPORT }]]);
    (h.p.runRead as any).mockImplementation(async () => { h.cancel(); return { ok: true, output: 'x' }; });
    const r = await runMystiSubagent(cfg, h.p);
    expect(h.requests).toHaveLength(1);
    expect(r.roundTrips).toBe(1);
  });

  it('sums the cost the stream reports', async () => {
    const h = ports([[{ text: REPORT, costUsd: 0.02 }]]);
    expect((await runMystiSubagent(cfg, h.p)).costUsd).toBeCloseTo(0.02);
  });

  it('leaves cost unmeasured (not $0) when the stream never reports it', async () => {
    const h = ports([[{ text: REPORT }]]);
    expect((await runMystiSubagent(cfg, h.p)).costUsd).toBeUndefined();
  });

  it('reports exhaustion when the turn cap runs out, even though the rescue produces text', async () => {
    const h = ports([
      [{ text: `Checking step 1.\n<read:${N}>f1</read>` }],
      [{ text: `Checking step 2.\n<read:${N}>f2</read>` }],
      [{ text: `Checking step 3.\n<read:${N}>f3</read>` }],
      [{ text: REPORT }],
    ]);
    const r = await runMystiSubagent({ ...cfg, maxTurns: 3 }, h.p);
    expect(h.requests).toHaveLength(4);
    expect(r.exhausted).toBe(true);
    expect(r.hasError).toBe(false);
    expect(r.summary).toBe(REPORT);
  });
});
