/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 24 Phase 4 — file-disjoint lane partitioning.
 *
 * A topological frontier says only that two nodes have no DEPENDENCY on each
 * other; it says nothing about whether they edit the same file. Running those
 * together is a silent lost-update: both agents read the same original, and the
 * one that finishes second overwrites the first. `partitionLanes` splits on the
 * declared file hints so that case runs sequentially instead.
 *
 * The hints are model-authored and therefore advisory — this is an optimisation
 * that avoids a race, never an access control. The pool's write gate is
 * unchanged and remains the only authority over what a lane may touch.
 */
import { describe, it, expect } from 'vitest';
import {
  partitionLanes,
  parseOrchestratorPlan,
  topologicalFrontiers,
} from '../../src/services/OrchestratorDag';
import type { OrchestratorPlan } from '../../src/services/OrchestratorDag';

function plan(nodes: Array<{ id: string; files?: string[]; dependsOn?: string[] }>): OrchestratorPlan {
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      task: `task ${n.id}`,
      dependsOn: n.dependsOn ?? [],
      ...(n.files ? { files: n.files } : {}),
    })),
  };
}

describe('partitionLanes — file disjointness', () => {
  it('keeps nodes with no shared file in one lane group', () => {
    const p = plan([
      { id: 'a', files: ['src/a.ts'] },
      { id: 'b', files: ['src/b.ts'] },
      { id: 'c', files: ['src/c.ts'] },
    ]);
    expect(partitionLanes(p, ['a', 'b', 'c'], 3)).toEqual([['a', 'b', 'c']]);
  });

  it('splits two nodes that claim the same file into sequential groups', () => {
    const p = plan([
      { id: 'a', files: ['src/shared.ts'] },
      { id: 'b', files: ['src/shared.ts'] },
    ]);
    expect(partitionLanes(p, ['a', 'b'], 3)).toEqual([['a'], ['b']]);
  });

  it('splits on a PARTIAL overlap, not just an identical set', () => {
    const p = plan([
      { id: 'a', files: ['src/x.ts', 'src/shared.ts'] },
      { id: 'b', files: ['src/y.ts', 'src/shared.ts'] },
    ]);
    expect(partitionLanes(p, ['a', 'b'], 3)).toEqual([['a'], ['b']]);
  });

  it('normalizes a leading ./ so the same file is recognised either way', () => {
    const p = plan([
      { id: 'a', files: ['./src/shared.ts'] },
      { id: 'b', files: ['src/shared.ts'] },
    ]);
    expect(partitionLanes(p, ['a', 'b'], 3)).toEqual([['a'], ['b']]);
  });

  it('treats a node with NO hint as unconstrained', () => {
    // An absent hint is not evidence of disjointness, but this is an
    // optimisation and not a safety mechanism — refusing to parallelise
    // everything unhinted would disable fan-out entirely, since `files` is
    // optional and most plans will omit it.
    const p = plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(partitionLanes(p, ['a', 'b', 'c'], 3)).toEqual([['a', 'b', 'c']]);
  });

  it('caps group width at the lane limit', () => {
    const p = plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
    expect(partitionLanes(p, ['a', 'b', 'c', 'd', 'e'], 3)).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });

  it('never drops or reorders a node', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const p = plan([
      { id: 'a', files: ['1.ts'] }, { id: 'b', files: ['1.ts'] },
      { id: 'c', files: ['2.ts'] }, { id: 'd', files: ['2.ts'] },
      { id: 'e' }, { id: 'f', files: ['1.ts'] },
    ]);
    const groups = partitionLanes(p, ids, 3);
    expect(groups.flat()).toEqual(ids);
    // No group may contain the same file twice.
    for (const g of groups) {
      const files = g.flatMap(id => p.nodes.find(n => n.id === id)?.files ?? []);
      expect(new Set(files).size, g.join(',')).toBe(files.length);
    }
  });

  it('survives a degenerate lane cap', () => {
    const p = plan([{ id: 'a' }, { id: 'b' }]);
    expect(partitionLanes(p, ['a', 'b'], 0)).toEqual([['a'], ['b']]);
    expect(partitionLanes(p, ['a', 'b'], -5)).toEqual([['a'], ['b']]);
  });

  it('returns nothing for an empty frontier', () => {
    expect(partitionLanes(plan([{ id: 'a' }]), [], 3)).toEqual([]);
  });
});

describe('parseOrchestratorPlan — files hint', () => {
  it('parses a files array and drops non-string entries', () => {
    const p = parseOrchestratorPlan(JSON.stringify({
      nodes: [{ id: 'n1', task: 't', dependsOn: [], files: ['src/a.ts', 42, '', '  src/b.ts  '] }],
    }));
    expect(p?.nodes[0].files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('omits files entirely when absent or unusable', () => {
    const p = parseOrchestratorPlan(JSON.stringify({
      nodes: [{ id: 'n1', task: 't', dependsOn: [] }, { id: 'n2', task: 't', dependsOn: [], files: 'nope' }],
    }));
    expect(p?.nodes[0].files).toBeUndefined();
    expect(p?.nodes[1].files).toBeUndefined();
  });

  it('caps a hostile files list rather than carrying it into every comparison', () => {
    const many = Array.from({ length: 500 }, (_, i) => `f${i}.ts`);
    const p = parseOrchestratorPlan(JSON.stringify({
      nodes: [{ id: 'n1', task: 't', dependsOn: [], files: many }],
    }));
    expect(p?.nodes[0].files?.length).toBe(32);
  });
});

describe('lanes compose with the existing frontier logic', () => {
  it('partitions each dependency frontier independently', () => {
    const p = plan([
      { id: 'a', files: ['shared.ts'] },
      { id: 'b', files: ['shared.ts'] },
      { id: 'c', dependsOn: ['a', 'b'] },
    ]);
    const frontiers = topologicalFrontiers(p);
    expect(frontiers).toEqual([['a', 'b'], ['c']]);
    const groups = frontiers.flatMap(f => partitionLanes(p, f, 3));
    // a and b conflict, so three sequential groups rather than two.
    expect(groups).toEqual([['a'], ['b'], ['c']]);
  });
});
