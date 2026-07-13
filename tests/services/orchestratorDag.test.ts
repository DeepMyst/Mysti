/**
 * OrchestratorDag tests (Plan 15 Phase 2a) — parse, validate, and frontier the
 * @mysti coordinator's task DAG.
 */
import { describe, it, expect } from 'vitest';
import {
  parseOrchestratorPlan,
  validateDag,
  topologicalFrontiers,
  chainLength,
  DAG_MAX_NODES,
  type OrchestratorPlan,
} from '../../src/services/OrchestratorDag';

describe('parseOrchestratorPlan', () => {
  it('parses a { nodes: [...] } object', () => {
    const plan = parseOrchestratorPlan('{"nodes":[{"id":"n1","task":"do x","dependsOn":[]}]}');
    expect(plan).not.toBeNull();
    expect(plan!.nodes[0]).toEqual({ id: 'n1', task: 'do x', backend: undefined, dependsOn: [] });
  });

  it('parses a bare array of nodes', () => {
    const plan = parseOrchestratorPlan('[{"id":"a","task":"t","dependsOn":[],"backend":"google-gemini"}]');
    expect(plan!.nodes[0].backend).toBe('google-gemini');
  });

  it('tolerates prose around the JSON', () => {
    const plan = parseOrchestratorPlan('Here is the plan:\n```json\n{"nodes":[{"id":"n1","task":"x","dependsOn":[]}]}\n```\nThat should work.');
    expect(plan!.nodes.length).toBe(1);
  });

  it('does not confuse braces inside string literals', () => {
    const plan = parseOrchestratorPlan('{"nodes":[{"id":"n1","task":"emit {json} to file","dependsOn":[]}]}');
    expect(plan!.nodes[0].task).toBe('emit {json} to file');
  });

  it('skips malformed nodes (missing id/task) but keeps valid ones', () => {
    const plan = parseOrchestratorPlan('{"nodes":[{"id":"","task":"x"},{"task":"no id"},{"id":"ok","task":"good","dependsOn":[]}]}');
    expect(plan!.nodes.map(n => n.id)).toEqual(['ok']);
  });

  it('returns null on non-JSON or empty', () => {
    expect(parseOrchestratorPlan('no json here')).toBeNull();
    expect(parseOrchestratorPlan('')).toBeNull();
    expect(parseOrchestratorPlan('{"nodes":[]}')).toBeNull(); // no usable nodes
  });
});

describe('validateDag', () => {
  const ok = (nodes: OrchestratorPlan['nodes']) => validateDag({ nodes });

  it('accepts a valid linear DAG', () => {
    expect(ok([
      { id: 'a', task: 't', dependsOn: [] },
      { id: 'b', task: 't', dependsOn: ['a'] },
    ]).valid).toBe(true);
  });

  it('accepts a diamond (shared dependency)', () => {
    expect(ok([
      { id: 'a', task: 't', dependsOn: [] },
      { id: 'b', task: 't', dependsOn: ['a'] },
      { id: 'c', task: 't', dependsOn: ['a'] },
      { id: 'd', task: 't', dependsOn: ['b', 'c'] },
    ]).valid).toBe(true);
  });

  it('rejects duplicate ids', () => {
    const r = ok([{ id: 'a', task: 't', dependsOn: [] }, { id: 'a', task: 't2', dependsOn: [] }]);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('duplicate');
  });

  it('rejects a dangling dependency', () => {
    const r = ok([{ id: 'a', task: 't', dependsOn: ['ghost'] }]);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('unknown');
  });

  it('rejects self-dependency', () => {
    const r = ok([{ id: 'a', task: 't', dependsOn: ['a'] }]);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('itself');
  });

  it('rejects a cycle', () => {
    const r = ok([
      { id: 'a', task: 't', dependsOn: ['b'] },
      { id: 'b', task: 't', dependsOn: ['a'] },
    ]);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('cycle');
  });

  it('rejects a plan over the node cap', () => {
    const nodes = Array.from({ length: DAG_MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, task: 't', dependsOn: [] }));
    const r = ok(nodes);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('cap');
  });

  it('rejects an empty plan', () => {
    expect(ok([]).valid).toBe(false);
  });
});

describe('topologicalFrontiers', () => {
  it('groups independent nodes into a single frontier', () => {
    const f = topologicalFrontiers({ nodes: [
      { id: 'a', task: 't', dependsOn: [] },
      { id: 'b', task: 't', dependsOn: [] },
      { id: 'c', task: 't', dependsOn: [] },
    ] });
    expect(f.length).toBe(1);
    expect(f[0].sort()).toEqual(['a', 'b', 'c']);
  });

  it('orders a linear chain into one node per frontier', () => {
    const f = topologicalFrontiers({ nodes: [
      { id: 'a', task: 't', dependsOn: [] },
      { id: 'b', task: 't', dependsOn: ['a'] },
      { id: 'c', task: 't', dependsOn: ['b'] },
    ] });
    expect(f).toEqual([['a'], ['b'], ['c']]);
  });

  it('handles a diamond: shared dep first, join last', () => {
    const f = topologicalFrontiers({ nodes: [
      { id: 'a', task: 't', dependsOn: [] },
      { id: 'b', task: 't', dependsOn: ['a'] },
      { id: 'c', task: 't', dependsOn: ['a'] },
      { id: 'd', task: 't', dependsOn: ['b', 'c'] },
    ] });
    expect(f[0]).toEqual(['a']);
    expect(f[1].sort()).toEqual(['b', 'c']);
    expect(f[2]).toEqual(['d']);
    // Every node appears exactly once.
    expect(f.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('chainLength equals the number of frontiers', () => {
    const plan = { nodes: [
      { id: 'a', task: 't', dependsOn: [] },
      { id: 'b', task: 't', dependsOn: ['a'] },
    ] };
    expect(chainLength(plan)).toBe(2);
  });
});
