/**
 * CanvasFormats tests — catalog lookups, longer-edge normalization, anchor
 * geometry, and the per-format prompt personas that steer the design sub-agent.
 */
import { describe, it, expect } from 'vitest';
import {
  CANVAS_FORMATS,
  getFormat,
  getDefaultFormat,
  listFormats,
  isPrint,
  normalizeLongerEdge,
  makeCustomFormat,
  resolveFormat,
  computeAnchors,
  buildFormatPersona,
} from '../../src/managers/CanvasFormats';

describe('CanvasFormats', () => {
  it('every catalog format has its longer edge normalized to 1920', () => {
    for (const f of CANVAS_FORMATS) {
      expect(Math.max(f.width, f.height)).toBe(1920);
    }
  });

  it('getDefaultFormat is deck-16x9 at 1920x1080 (and is a copy)', () => {
    const a = getDefaultFormat();
    const b = getDefaultFormat();
    expect(a.formatId).toBe('deck-16x9');
    expect(a.width).toBe(1920);
    expect(a.height).toBe(1080);
    expect(a).not.toBe(b); // distinct objects — safe to mutate
  });

  it('getFormat looks up by id, undefined when absent', () => {
    expect(getFormat('story-9x16')!.height).toBe(1920);
    expect(getFormat('nope')).toBeUndefined();
  });

  it('listFormats returns clones, not catalog references', () => {
    const list = listFormats();
    expect(list).toHaveLength(CANVAS_FORMATS.length);
    expect(list[0]).not.toBe(CANVAS_FORMATS[0]);
  });

  it('isPrint distinguishes print formats', () => {
    expect(isPrint(getFormat('a4-portrait')!)).toBe(true);
    expect(isPrint(getFormat('deck-16x9')!)).toBe(false);
  });

  describe('normalizeLongerEdge', () => {
    it('scales the longer edge to 1920 preserving ratio', () => {
      expect(normalizeLongerEdge(3840, 2160)).toEqual({ width: 1920, height: 1080 });
      expect(normalizeLongerEdge(500, 1000)).toEqual({ width: 960, height: 1920 });
    });
    it('handles degenerate input', () => {
      expect(normalizeLongerEdge(0, 0)).toEqual({ width: 1920, height: 1920 });
    });
  });

  describe('makeCustomFormat / resolveFormat', () => {
    it('makeCustomFormat normalizes to the design space', () => {
      const f = makeCustomFormat(800, 600);
      expect(f.formatId).toBe('custom');
      expect(Math.max(f.width, f.height)).toBe(1920);
    });
    it('resolveFormat returns the catalog entry for a known id', () => {
      expect(resolveFormat({ formatId: 'square-1x1' }).width).toBe(1920);
    });
    it('resolveFormat builds a custom format from dims', () => {
      const f = resolveFormat({ formatId: 'custom', width: 1200, height: 1200 });
      expect(f.formatId).toBe('custom');
      expect(f.width).toBe(1920);
      expect(f.height).toBe(1920);
    });
    it('resolveFormat falls back to the default for unknown ids', () => {
      expect(resolveFormat({ formatId: 'bogus' }).formatId).toBe('deck-16x9');
    });
  });

  describe('computeAnchors', () => {
    it('centers and yields four rule-of-thirds points', () => {
      const a = computeAnchors(getFormat('deck-16x9')!);
      expect(a.center).toEqual({ x: 960, y: 540 });
      expect(a.thirds).toHaveLength(4);
    });
    it('insets the safe rect by safeMargin for print, zero for screen', () => {
      const print = computeAnchors(getFormat('a4-portrait')!);
      expect(print.safeRect.x).toBe(getFormat('a4-portrait')!.safeMargin);
      const screen = computeAnchors(getFormat('deck-16x9')!);
      expect(screen.safeRect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    });
  });

  describe('buildFormatPersona', () => {
    it('print personas mention the safe area and no animation', () => {
      const p = buildFormatPersona(getFormat('a4-portrait')!);
      expect(p.toLowerCase()).toContain('safe area');
      expect(p.toLowerCase()).toContain('no animation');
    });
    it('tall formats instruct vertical stacking and forbid 3 columns', () => {
      const p = buildFormatPersona(getFormat('story-9x16')!);
      expect(p.toLowerCase()).toContain('stack');
      expect(p).toContain('NO 3-column');
    });
    it('wide formats favor horizontal/columns', () => {
      const p = buildFormatPersona(getFormat('landscape-1.91x1')!);
      expect(p.toLowerCase()).toContain('landscape');
      expect(p.toLowerCase()).toMatch(/column|horizontal/);
    });
    it('square formats center a focal block', () => {
      const p = buildFormatPersona(getFormat('square-1x1')!);
      expect(p.toLowerCase()).toContain('square');
      expect(p.toLowerCase()).toContain('center');
    });
  });
});
