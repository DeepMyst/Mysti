/**
 * PerfTracker tests — ring buffer cap, percentile math, disabled no-op
 * behavior (with coarse-mark exception), report shape, and config wiring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { PerfTracker, PERF_SAMPLE_BUFFER_CAP } from '../../src/utils/PerfTracker';

describe('PerfTracker', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearMockConfig();
    PerfTracker.reset();
    PerfTracker.setEnabled(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    PerfTracker.dispose();
    PerfTracker.reset();
    PerfTracker.setEnabled(false);
  });

  describe('percentile math', () => {
    it('computes nearest-rank percentiles over recorded samples', () => {
      // 10, 20, ..., 1000 — shuffled insertion order should not matter
      const values: number[] = [];
      for (let i = 1; i <= 100; i++) {
        values.push(i * 10);
      }
      for (let i = values.length - 1; i > 0; i--) {
        const j = (i * 7919) % (i + 1);
        [values[i], values[j]] = [values[j], values[i]];
      }
      for (const v of values) {
        PerfTracker.sample('render.chunk', v);
      }

      expect(PerfTracker.percentile('render.chunk', 50)).toBe(500);
      expect(PerfTracker.percentile('render.chunk', 95)).toBe(950);
      expect(PerfTracker.percentile('render.chunk', 0)).toBe(10);
      expect(PerfTracker.percentile('render.chunk', 100)).toBe(1000);
    });

    it('clamps out-of-range percentiles', () => {
      PerfTracker.sample('x', 1);
      PerfTracker.sample('x', 2);
      expect(PerfTracker.percentile('x', -5)).toBe(1);
      expect(PerfTracker.percentile('x', 250)).toBe(2);
    });

    it('returns undefined when no samples exist', () => {
      expect(PerfTracker.percentile('never-sampled', 95)).toBeUndefined();
    });
  });

  describe('ring buffer', () => {
    it('caps each buffer at PERF_SAMPLE_BUFFER_CAP and keeps the newest samples', () => {
      const total = PERF_SAMPLE_BUFFER_CAP + 500;
      for (let i = 1; i <= total; i++) {
        PerfTracker.sample('chunk', i);
      }

      const report = PerfTracker.report();
      expect(report.samples.chunk.count).toBe(PERF_SAMPLE_BUFFER_CAP);
      // Oldest 500 samples evicted: minimum surviving value is 501
      expect(PerfTracker.percentile('chunk', 0)).toBe(501);
      expect(report.samples.chunk.max).toBe(total);
    });

    it('keeps buffers independent per name', () => {
      PerfTracker.sample('a', 5);
      PerfTracker.sample('b', 50);
      expect(PerfTracker.percentile('a', 100)).toBe(5);
      expect(PerfTracker.percentile('b', 100)).toBe(50);
    });
  });

  describe('disabled behavior', () => {
    beforeEach(() => {
      PerfTracker.setEnabled(false);
    });

    it('sample() is a no-op when disabled', () => {
      PerfTracker.sample('chunk', 123);
      expect(PerfTracker.percentile('chunk', 50)).toBeUndefined();
      expect(PerfTracker.report().samples).toEqual({});
    });

    it('non-coarse measure() is a no-op when disabled', () => {
      PerfTracker.mark('custom.start');
      const result = PerfTracker.measure('custom.total', 'custom.start');
      expect(result).toBe(-1);
      expect(PerfTracker.report().measures).toEqual({});
      const perfLogs = logSpy.mock.calls.filter((c) => String(c[0]).startsWith('[Mysti][perf]'));
      expect(perfLogs).toHaveLength(0);
    });

    it.each(['activation.total', 'panel.timeToUsable', 'send.ttftRender'])(
      'coarse measure %s is always recorded and logged',
      (name) => {
        PerfTracker.mark('start');
        const ms = PerfTracker.measure(name, 'start');
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(PerfTracker.report().measures[name]).toBe(ms);
        const perfLogs = logSpy.mock.calls.filter((c) => String(c[0]).startsWith(`[Mysti][perf] ${name}:`));
        expect(perfLogs).toHaveLength(1);
      }
    );
  });

  describe('measure', () => {
    it('returns elapsed ms and logs with the [Mysti][perf] prefix when enabled', () => {
      PerfTracker.mark('m.start');
      const ms = PerfTracker.measure('m.total', 'm.start');
      expect(ms).toBeGreaterThanOrEqual(0);
      const perfLogs = logSpy.mock.calls.filter((c) => String(c[0]).startsWith('[Mysti][perf] m.total:'));
      expect(perfLogs).toHaveLength(1);
      expect(String(perfLogs[0][0])).toMatch(/^\[Mysti\]\[perf\] m\.total: \d+(\.\d+)?ms$/);
    });

    it('returns -1 when the from-mark does not exist', () => {
      expect(PerfTracker.measure('m.total', 'never-marked')).toBe(-1);
    });
  });

  describe('report', () => {
    it('returns plain-object measures and percentile summaries', () => {
      PerfTracker.mark('r.start');
      PerfTracker.measure('r.total', 'r.start');
      PerfTracker.sample('r.chunk', 10);
      PerfTracker.sample('r.chunk', 20);
      PerfTracker.sample('r.chunk', 30);

      const report = PerfTracker.report();
      expect(report.enabled).toBe(true);
      expect(typeof report.measures['r.total']).toBe('number');
      expect(report.samples['r.chunk']).toEqual({
        count: 3,
        p50: 20,
        p95: 30,
        max: 30,
        mean: 20,
      });
    });

    it('reset() clears measures and samples', () => {
      PerfTracker.mark('r.start');
      PerfTracker.measure('r.total', 'r.start');
      PerfTracker.sample('r.chunk', 1);
      PerfTracker.reset();
      const report = PerfTracker.report();
      expect(report.measures).toEqual({});
      expect(report.samples).toEqual({});
    });
  });

  describe('init / config wiring', () => {
    it('reads mysti.debug.performanceLogging from workspace config', () => {
      setMockConfig('debug.performanceLogging', true);
      PerfTracker.init();
      expect(PerfTracker.isEnabled()).toBe(true);

      setMockConfig('debug.performanceLogging', false);
      PerfTracker.init();
      expect(PerfTracker.isEnabled()).toBe(false);
    });

    it('defaults to disabled when the setting is absent', () => {
      PerfTracker.init();
      expect(PerfTracker.isEnabled()).toBe(false);
    });

    it('accepts a custom readConfig override', () => {
      PerfTracker.init(() => true);
      expect(PerfTracker.isEnabled()).toBe(true);
      PerfTracker.init(() => false);
      expect(PerfTracker.isEnabled()).toBe(false);
    });

    it('setEnabled() toggles detailed tracking', () => {
      PerfTracker.setEnabled(false);
      expect(PerfTracker.isEnabled()).toBe(false);
      PerfTracker.setEnabled(true);
      expect(PerfTracker.isEnabled()).toBe(true);
    });
  });
});
