/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for RetrievalCoordinator pure reducers (Plan 08 retrieval).
 */
import { describe, it, expect } from 'vitest';
import { RetrievalCoordinator, type RetrievedSnippet } from '../../src/managers/RetrievalCoordinator';

describe('RetrievalCoordinator.parseSnippets', () => {
  it('parses a fenced JSON array', () => {
    const t = '```json\n[{"quote":"hello world","relevance":0.9,"msgId":"m1"}]\n```';
    const s = RetrievalCoordinator.parseSnippets(t);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ quote: 'hello world', msgId: 'm1' });
    expect(s[0].relevance).toBeCloseTo(0.9);
  });

  it('parses a loose array embedded in prose and defaults relevance', () => {
    const s = RetrievalCoordinator.parseSnippets('Sure! [{"quote":"a span"}] done');
    expect(s).toHaveLength(1);
    expect(s[0].relevance).toBe(0.5);
  });

  it('drops entries without a quote and clamps relevance', () => {
    const s = RetrievalCoordinator.parseSnippets('[{"relevance":2},{"quote":"ok","relevance":5}]');
    expect(s).toHaveLength(1);
    expect(s[0].relevance).toBe(1);
  });

  it('returns [] on junk', () => {
    expect(RetrievalCoordinator.parseSnippets('no json here')).toEqual([]);
    expect(RetrievalCoordinator.parseSnippets('[}')).toEqual([]);
  });
});

describe('RetrievalCoordinator.reduce', () => {
  it('sorts by relevance and dedups near-duplicates', () => {
    const a: RetrievedSnippet[] = [
      { quote: 'alpha beta gamma delta', relevance: 0.9 },
      { quote: 'alpha beta gamma delta', relevance: 0.5 },
    ];
    const b: RetrievedSnippet[] = [{ quote: 'epsilon zeta eta theta', relevance: 0.7 }];
    const out = RetrievalCoordinator.reduce([a, b], 5, 10000);
    expect(out).toHaveLength(2);
    expect(out[0].relevance).toBe(0.9);
    expect(out[1].relevance).toBe(0.7);
  });

  it('caps at topK', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ quote: `unique snippet number ${i} here`, relevance: 1 - i * 0.05 }));
    const out = RetrievalCoordinator.reduce([items], 3, 1_000_000);
    expect(out).toHaveLength(3);
  });

  it('formatSnippets renders a block or empty string', () => {
    expect(RetrievalCoordinator.formatSnippets([])).toBe('');
    const block = RetrievalCoordinator.formatSnippets([{ quote: 'q1', relevance: 1, msgId: 'm9' }]);
    expect(block).toContain('Retrieved context');
    expect(block).toContain('q1');
    expect(block).toContain('m9');
  });
});
