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
 */

/**
 * PerfTracker — lightweight, dependency-free performance instrumentation.
 *
 * Static-style singleton used across the extension host to mark/measure
 * wall-clock durations and collect per-name sample ring buffers.
 *
 * Gating (KEY DESIGN RULE):
 * - Everything is gated by the `mysti.debug.performanceLogging` setting
 *   (default false), wired up via `init()`.
 * - When OFF, only the coarse measures (`activation.total`,
 *   `panel.timeToUsable`, `send.ttftRender`) are recorded and logged;
 *   `sample()` and non-coarse `measure()` calls are true no-ops
 *   (a single boolean check, zero allocations).
 *
 * All methods are synchronous. Logs use the `[Mysti][perf]` prefix.
 */

import * as vscode from 'vscode';

/** Coarse measures that are always recorded/logged, even when disabled. */
const COARSE_MEASURES: ReadonlySet<string> = new Set([
  'activation.total',
  'panel.timeToUsable',
  'send.ttftRender',
]);

/** Maximum samples retained per name (ring buffer capacity). */
export const PERF_SAMPLE_BUFFER_CAP = 2000;

/** Summary statistics for one sample ring buffer. */
export interface PerfSampleSummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Plain-object snapshot returned by `PerfTracker.report()`. */
export interface PerfReport {
  enabled: boolean;
  /** Last recorded value (ms) per measure name. */
  measures: Record<string, number>;
  /** Percentile summaries per sample name. */
  samples: Record<string, PerfSampleSummary>;
}

interface RingBuffer {
  values: number[];
  /** Next write position. */
  index: number;
  /** Number of valid entries (<= PERF_SAMPLE_BUFFER_CAP). */
  count: number;
}

/**
 * Monotonic clock with graceful fallbacks: global `performance.now`
 * (available in the extension host), then Node's `perf_hooks`, then
 * `Date.now()`.
 */
const now: () => number = (() => {
  const globalPerf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (globalPerf && typeof globalPerf.now === 'function') {
    return () => globalPerf.now!.call(globalPerf);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const perfHooks = require('perf_hooks') as { performance: { now: () => number } };
    return () => perfHooks.performance.now();
  } catch {
    return () => Date.now();
  }
})();

export class PerfTracker {
  private static _enabled = false;
  private static _marks: Map<string, number> = new Map();
  private static _measures: Map<string, number> = new Map();
  private static _buffers: Map<string, RingBuffer> = new Map();
  private static _configListener: vscode.Disposable | undefined;

  private constructor() {
    // Static-style singleton — not instantiable.
  }

  /**
   * Initialize from configuration and watch for changes to
   * `mysti.debug.performanceLogging`.
   *
   * @param readConfig Optional override for reading the enabled flag
   *                   (defaults to the `mysti.debug.performanceLogging`
   *                   workspace setting). Re-invoked whenever that setting
   *                   changes.
   * @returns The configuration-listener disposable (push it onto
   *          `context.subscriptions`), or undefined when no listener could
   *          be registered (e.g., outside the extension host).
   */
  static init(readConfig?: () => boolean): vscode.Disposable | undefined {
    const read = readConfig ?? PerfTracker._readConfigSetting;

    try {
      PerfTracker._enabled = read() === true;
    } catch {
      PerfTracker._enabled = false;
    }

    // Re-init replaces any previous listener.
    PerfTracker._configListener?.dispose();
    PerfTracker._configListener = undefined;

    try {
      PerfTracker._configListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e || typeof e.affectsConfiguration !== 'function' || e.affectsConfiguration('mysti.debug.performanceLogging')) {
          try {
            PerfTracker._enabled = read() === true;
          } catch {
            PerfTracker._enabled = false;
          }
        }
      });
    } catch {
      // vscode API unavailable (tests / non-extension context) — flag-only mode.
    }

    return PerfTracker._configListener;
  }

  /** Enable/disable detailed tracking (coarse measures stay always-on). */
  static setEnabled(enabled: boolean): void {
    PerfTracker._enabled = enabled;
  }

  /** Whether detailed tracking is on. Use to gate any heavier caller-side work. */
  static isEnabled(): boolean {
    return PerfTracker._enabled;
  }

  /**
   * Record a named timestamp. Always recorded (cheap map write) so that
   * coarse measures work even when tracking is disabled.
   */
  static mark(name: string): void {
    PerfTracker._marks.set(name, now());
  }

  /**
   * Measure elapsed ms since `fromMark` and record it under `name`.
   *
   * Logs `[Mysti][perf] <name>: <ms>ms` and stores the value when enabled,
   * or when `name` is one of the always-on coarse measures
   * (`activation.total`, `panel.timeToUsable`, `send.ttftRender`).
   *
   * @returns Elapsed milliseconds, or -1 when skipped (disabled non-coarse
   *          measure, or `fromMark` was never marked).
   */
  static measure(name: string, fromMark: string): number {
    if (!PerfTracker._enabled && !COARSE_MEASURES.has(name)) {
      return -1;
    }
    const start = PerfTracker._marks.get(fromMark);
    if (start === undefined) {
      return -1;
    }
    const ms = now() - start;
    PerfTracker._measures.set(name, ms);
    console.log(`[Mysti][perf] ${name}: ${ms.toFixed(1)}ms`);
    return ms;
  }

  /**
   * Add a duration sample (ms) to the per-name ring buffer (cap 2000).
   * True no-op when disabled — a single boolean check, zero allocations.
   */
  static sample(name: string, ms: number): void {
    if (!PerfTracker._enabled) {
      return;
    }
    let buffer = PerfTracker._buffers.get(name);
    if (!buffer) {
      buffer = { values: [], index: 0, count: 0 };
      PerfTracker._buffers.set(name, buffer);
    }
    buffer.values[buffer.index] = ms;
    buffer.index = (buffer.index + 1) % PERF_SAMPLE_BUFFER_CAP;
    if (buffer.count < PERF_SAMPLE_BUFFER_CAP) {
      buffer.count++;
    }
  }

  /**
   * Percentile (nearest-rank method) over the samples recorded for `name`.
   *
   * @param name Sample buffer name.
   * @param p Percentile in [0, 100].
   * @returns The percentile value, or undefined when no samples exist.
   */
  static percentile(name: string, p: number): number | undefined {
    const buffer = PerfTracker._buffers.get(name);
    if (!buffer || buffer.count === 0) {
      return undefined;
    }
    const sorted = buffer.values.slice(0, buffer.count).sort((a, b) => a - b);
    return PerfTracker._nearestRank(sorted, p);
  }

  /**
   * Snapshot of all recorded measures and sample summaries as a plain object.
   */
  static report(): PerfReport {
    const measures: Record<string, number> = {};
    for (const [name, ms] of PerfTracker._measures) {
      measures[name] = ms;
    }

    const samples: Record<string, PerfSampleSummary> = {};
    for (const [name, buffer] of PerfTracker._buffers) {
      if (buffer.count === 0) {
        continue;
      }
      const sorted = buffer.values.slice(0, buffer.count).sort((a, b) => a - b);
      let sum = 0;
      for (const v of sorted) {
        sum += v;
      }
      samples[name] = {
        count: buffer.count,
        p50: PerfTracker._nearestRank(sorted, 50),
        p95: PerfTracker._nearestRank(sorted, 95),
        max: sorted[sorted.length - 1],
        mean: sum / buffer.count,
      };
    }

    return { enabled: PerfTracker._enabled, measures, samples };
  }

  /** Clear all marks, measures, and sample buffers (keeps enabled state). */
  static reset(): void {
    PerfTracker._marks.clear();
    PerfTracker._measures.clear();
    PerfTracker._buffers.clear();
  }

  /** Dispose the configuration listener registered by `init()`. */
  static dispose(): void {
    PerfTracker._configListener?.dispose();
    PerfTracker._configListener = undefined;
  }

  private static _readConfigSetting(): boolean {
    try {
      return vscode.workspace.getConfiguration('mysti').get<boolean>('debug.performanceLogging', false) === true;
    } catch {
      return false;
    }
  }

  /** Nearest-rank percentile over an ascending-sorted array (n >= 1). */
  private static _nearestRank(sortedAscending: number[], p: number): number {
    const n = sortedAscending.length;
    const clamped = Math.min(100, Math.max(0, p));
    const rank = Math.ceil((clamped / 100) * n) - 1;
    const index = Math.min(n - 1, Math.max(0, rank));
    return sortedAscending[index];
  }
}
