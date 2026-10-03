/**
 * CanvasOpParser tests — the fenced `canvas-op` fallback transport: extracting
 * complete blocks (including fences split across stream chunks), tolerating
 * surrounding prose, and surfacing malformed blocks as errors (never silently
 * dropping an edit).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CanvasOpParser } from '../../src/managers/CanvasOpParser';

describe('CanvasOpParser', () => {
  let parser: CanvasOpParser;

  beforeEach(() => {
    parser = new CanvasOpParser();
  });

  it('parses a complete fenced block in one push', () => {
    const text = 'Here you go:\n```canvas-op\n{"kind":"insert_page","proposedValue":{"mode":"html","htmlSource":"<h1>Hi</h1>"}}\n```\nDone.';
    const results = parser.push(text);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    if (results[0].ok) {
      expect(results[0].op.kind).toBe('insert_page');
      expect(results[0].op.proposedValue).toEqual({ mode: 'html', htmlSource: '<h1>Hi</h1>' });
    }
  });

  it('carries targetPageId and baseVersion through', () => {
    const text = '```canvas-op\n{"kind":"edit_page","targetPageId":"p1","baseVersion":3,"proposedValue":{"htmlSource":"x"}}\n```';
    const [r] = parser.push(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.op.targetPageId).toBe('p1');
      expect(r.op.baseVersion).toBe(3);
    }
  });

  it('reassembles a block split across chunks', () => {
    expect(parser.push('intro ```canvas-op\n{"kind":"delete_page",')).toEqual([]);
    expect(parser.push('"targetPageId":"p9",')).toEqual([]);
    const results = parser.push('"proposedValue":{}}\n``` trailing');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    if (results[0].ok) {
      expect(results[0].op.kind).toBe('delete_page');
      expect(results[0].op.targetPageId).toBe('p9');
    }
  });

  it('reassembles when the opening fence itself is split across chunks', () => {
    expect(parser.push('text ```canvas')).toEqual([]);
    const results = parser.push('-op\n{"kind":"reorder","proposedValue":["a","b"]}\n```');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    if (results[0].ok) {
      expect(results[0].op.proposedValue).toEqual(['a', 'b']);
    }
  });

  it('parses multiple blocks in a single push', () => {
    const text =
      '```canvas-op\n{"kind":"set_theme","proposedValue":{"x":1}}\n```' +
      ' and then ' +
      '```canvas-op\n{"kind":"set_format","proposedValue":{"formatId":"a4-portrait"}}\n```';
    const results = parser.push(text);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('reports invalid JSON without throwing', () => {
    const [r] = parser.push('```canvas-op\n{not valid json}\n```');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('invalid JSON'); }
  });

  it('reports an unknown op kind', () => {
    const [r] = parser.push('```canvas-op\n{"kind":"nuke_everything","proposedValue":{}}\n```');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('unknown canvas-op kind'); }
  });

  it('reports a missing proposedValue', () => {
    const [r] = parser.push('```canvas-op\n{"kind":"insert_page"}\n```');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('proposedValue'); }
  });

  it('ignores plain prose with no fences and does not grow the buffer unboundedly', () => {
    for (let i = 0; i < 100; i++) {
      expect(parser.push('just some streaming words and tokens '.repeat(5))).toEqual([]);
    }
    // A real block still parses after lots of prose.
    const results = parser.push('```canvas-op\n{"kind":"insert_page","proposedValue":{"mode":"html"}}\n```');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it('reset() drops a half-buffered block', () => {
    parser.push('```canvas-op\n{"kind":"insert_page",');
    parser.reset();
    const results = parser.push('"proposedValue":{}}\n```');
    expect(results).toEqual([]); // the opening half was discarded
  });
});
