import { describe, it, expect } from 'vitest';
import { clampHeadTail, capAttachedFiles } from '../../src/coordinator/promptBudget';

describe('clampHeadTail', () => {
  it('leaves short text alone', () => {
    expect(clampHeadTail('abc', 2, 2)).toBe('abc');
  });
  it('keeps the head and tail and says how much there was', () => {
    const out = clampHeadTail('a'.repeat(100) + 'b'.repeat(100), 10, 5, 'clamped');
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out.endsWith('b'.repeat(5))).toBe(true);
    expect(out).toContain('[clamped — 200 chars total]');
  });
});

describe('capAttachedFiles', () => {
  it('caps each file and the total, and counts what it dropped', () => {
    const files = [
      { path: 'a', content: 'x'.repeat(10_000) },
      { path: 'b', content: 'y'.repeat(10_000) },
      { path: 'c', content: 'z'.repeat(10_000) },
      { path: 'd', content: 'w' },
    ];
    const r = capAttachedFiles(files, 8_000, 20_000);
    expect(r.files.map(f => f.body.length)).toEqual([8_000, 8_000, 4_000]);
    expect(r.files.every(f => f.truncated)).toBe(true);
    expect(r.omitted).toBe(1);
  });
});
