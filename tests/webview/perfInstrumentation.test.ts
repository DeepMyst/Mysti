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
 * Plan 03 Phase 1 — webview perf harness (chunk ring buffer, nearest-rank
 * percentiles, gating, uiReady/perfMark/perfReport posting).
 *
 * Like tests/webview/wizardPanelId.test.ts, these tests extract the REAL
 * functions from the generated webview script by brace matching and execute
 * them, so they cannot drift from the shipped artifact. Each extracted
 * function's free identifiers (perfState, performance, postMessageWithPanelId,
 * ...) are supplied as `new Function` parameters.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getWebviewContent } from '../../src/webview/webviewContent';
import { Uri } from '../helpers/mockVscode';
import { PerfTracker } from '../../src/utils/PerfTracker';

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Extract a top-level `function name(...) { ... }` declaration from JS source by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

/** Fresh perfState mirroring the webview-side declaration. */
function freshPerfState(): any {
  return {
    enabled: false,
    samples: null,
    index: 0,
    count: 0,
    chunkCount: 0,
    heapTimer: null,
    uiReadySent: false,
  };
}

const CAP = 2000; // PERF_SAMPLE_BUFFER_CAP in the webview script

let html: string;

beforeAll(() => {
  const mockWebview = {
    asWebviewUri: (uri: unknown) => uri,
    cspSource: 'mock-csp:',
  } as any;
  const extensionUri = Uri.file('/mock/extension') as any;
  html = getWebviewContent(mockWebview, extensionUri, '0.0.0');
});

// ---------------------------------------------------------------------------
// Whole-script syntax guard — the perf block lives inside a TS template
// literal, so tsc cannot catch JS syntax errors in the generated script.
// ---------------------------------------------------------------------------

describe('webview script syntax', () => {
  it('every generated <script> block parses as valid JavaScript', () => {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((s) => s.trim().length > 0);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      // Throws SyntaxError (failing the test) if the script does not parse.
      expect(() => new Function(s)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// perfPercentile — nearest-rank math (must mirror PerfTracker.percentile)
// ---------------------------------------------------------------------------

describe('webview perfPercentile', () => {
  function runPercentile(sorted: number[], p: number): number {
    const src = extractFunction(html, 'perfPercentile');
    const run = new Function('sorted', 'p', `${src}\nreturn perfPercentile(sorted, p);`);
    return run(sorted, p);
  }

  it('computes nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => (i + 1) * 10); // 10..1000
    expect(runPercentile(sorted, 50)).toBe(500);
    expect(runPercentile(sorted, 95)).toBe(950);
    expect(runPercentile(sorted, 100)).toBe(1000);
  });

  it('clamps p to [0, 100] and handles single-element arrays', () => {
    expect(runPercentile([42], 0)).toBe(42);
    expect(runPercentile([42], 100)).toBe(42);
    expect(runPercentile([1, 2, 3], -50)).toBe(1);
    expect(runPercentile([1, 2, 3], 250)).toBe(3);
  });

  it('returns 0 for an empty array (webview-side convention)', () => {
    expect(runPercentile([], 95)).toBe(0);
  });

  it('matches PerfTracker.percentile (extension side) on the same data', () => {
    const values = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
    PerfTracker.reset();
    PerfTracker.setEnabled(true);
    for (const v of values) {
      PerfTracker.sample('parity', v);
    }
    const sorted = [...values].sort((a, b) => a - b);
    for (const p of [0, 1, 25, 50, 75, 95, 99, 100]) {
      expect(runPercentile(sorted, p)).toBe(PerfTracker.percentile('parity', p));
    }
    PerfTracker.setEnabled(false);
    PerfTracker.reset();
  });
});

// ---------------------------------------------------------------------------
// perfRecordChunk — ring buffer semantics (cap 2000)
// ---------------------------------------------------------------------------

describe('webview perfRecordChunk ring buffer', () => {
  function makeRecorder(perfState: any): (ms: number) => void {
    const src = extractFunction(html, 'perfRecordChunk');
    const run = new Function(
      'perfState', 'PERF_SAMPLE_BUFFER_CAP', 'ms',
      `${src}\nperfRecordChunk(ms);`
    );
    return (ms: number) => run(perfState, CAP, ms);
  }

  it('appends samples and counts chunks', () => {
    const perfState = freshPerfState();
    perfState.enabled = true;
    const record = makeRecorder(perfState);

    record(1.5);
    record(2.5);
    record(3.5);

    expect(perfState.samples).toEqual([1.5, 2.5, 3.5]);
    expect(perfState.count).toBe(3);
    expect(perfState.index).toBe(3);
    expect(perfState.chunkCount).toBe(3);
  });

  it('wraps at the 2000-sample cap, overwriting the oldest entries', () => {
    const perfState = freshPerfState();
    perfState.enabled = true;
    const record = makeRecorder(perfState);

    for (let i = 0; i < CAP + 5; i++) {
      record(i);
    }

    expect(perfState.count).toBe(CAP);              // never exceeds the cap
    expect(perfState.samples.length).toBe(CAP);     // buffer does not grow
    expect(perfState.index).toBe(5);                // wrapped around
    expect(perfState.samples[0]).toBe(CAP);         // oldest overwritten
    expect(perfState.samples[4]).toBe(CAP + 4);
    expect(perfState.samples[5]).toBe(5);           // survivors untouched
    expect(perfState.chunkCount).toBe(CAP + 5);     // chunk counter keeps counting
  });
});

// ---------------------------------------------------------------------------
// perfBuildReport — per-response summary shape
// ---------------------------------------------------------------------------

describe('webview perfBuildReport', () => {
  function buildReport(perfState: any, heapUsed: number | undefined): any {
    const percentileSrc = extractFunction(html, 'perfPercentile');
    const reportSrc = extractFunction(html, 'perfBuildReport');
    const run = new Function(
      'perfState', 'perfHeapUsed',
      `${percentileSrc}\n${reportSrc}\nreturn perfBuildReport();`
    );
    return run(perfState, () => heapUsed);
  }

  it('summarizes the ring buffer into {chunkCount, p50, p95, max, heapUsed}', () => {
    const perfState = freshPerfState();
    perfState.enabled = true;
    perfState.samples = [30, 10, 20, 40, 50]; // unsorted on purpose
    perfState.count = 5;
    perfState.index = 5;
    perfState.chunkCount = 5;

    const report = buildReport(perfState, 12345678);

    expect(report.type).toBe('perfReport');
    expect(report.reason).toBe('done');
    expect(report.chunkCount).toBe(5);
    expect(report.p50).toBe(30);
    expect(report.p95).toBe(50);
    expect(report.max).toBe(50);
    expect(report.heapUsed).toBe(12345678);
  });

  it('produces a zeroed report when no samples exist (heap may be unavailable)', () => {
    const report = buildReport(freshPerfState(), undefined);

    expect(report.chunkCount).toBe(0);
    expect(report.p50).toBe(0);
    expect(report.p95).toBe(0);
    expect(report.max).toBe(0);
    expect(report.heapUsed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleResponseChunk — gating (disabled path must not touch the perf harness)
// ---------------------------------------------------------------------------

describe('webview handleResponseChunk perf gating', () => {
  function runChunk(perfState: any, chunk: any) {
    const bodyCalls: any[] = [];
    const recorded: number[] = [];
    const firstChunkPosts: number[] = [];
    let nowCalls = 0;
    const src = extractFunction(html, 'handleResponseChunk');
    const run = new Function(
      'perfState', 'handleResponseChunkBody', 'perfRecordChunk', 'perfPostFirstChunkRendered', 'performance', 'chunk',
      `${src}\nhandleResponseChunk(chunk);`
    );
    run(
      perfState,
      (c: any) => bodyCalls.push(c),
      (ms: number) => recorded.push(ms),
      (sentAt: number) => firstChunkPosts.push(sentAt),
      { now: () => { nowCalls++; return nowCalls * 10; } },
      chunk
    );
    return { bodyCalls, recorded, firstChunkPosts, nowCalls };
  }

  it('disabled: delegates to the body without timing or sampling', () => {
    const perfState = freshPerfState(); // enabled: false

    const r = runChunk(perfState, { type: 'text', content: 'hi' });

    expect(r.bodyCalls).toHaveLength(1);
    expect(r.recorded).toHaveLength(0);   // ring buffer untouched
    expect(r.nowCalls).toBe(0);           // performance.now never called
    expect(r.firstChunkPosts).toHaveLength(0);
  });

  it('disabled: still posts firstChunkRendered for the perfSentAt-stamped chunk (coarse send.ttftRender)', () => {
    const perfState = freshPerfState();

    const r = runChunk(perfState, { type: 'text', content: 'hi', perfSentAt: 1718000000000 });

    expect(r.firstChunkPosts).toEqual([1718000000000]);
    expect(r.recorded).toHaveLength(0);
  });

  it('enabled: times the body into the ring buffer and posts firstChunkRendered', () => {
    const perfState = freshPerfState();
    perfState.enabled = true;

    const r = runChunk(perfState, { type: 'text', content: 'hi', perfSentAt: 99 });

    expect(r.bodyCalls).toHaveLength(1);
    expect(r.recorded).toEqual([10]);     // stubbed now(): 20 - 10
    expect(r.firstChunkPosts).toEqual([99]);
  });
});

// ---------------------------------------------------------------------------
// perfSetEnabled — heap sampling lifecycle (init sample, 60s timer, teardown)
// ---------------------------------------------------------------------------

describe('webview perfSetEnabled', () => {
  function makeHarness(perfState: any) {
    const heapPosts: number[] = [];
    const intervals: Array<{ ms: number; cleared: boolean }> = [];
    const src = extractFunction(html, 'perfSetEnabled');
    const run = new Function(
      'perfState', 'perfPostHeapSample', 'setInterval', 'clearInterval', 'on',
      `${src}\nperfSetEnabled(on);`
    );
    const setEnabled = (on: boolean) => run(
      perfState,
      () => heapPosts.push(1),
      (_fn: () => void, ms: number) => { intervals.push({ ms, cleared: false }); return intervals.length; },
      (id: number) => { intervals[id - 1].cleared = true; },
      on
    );
    return { setEnabled, heapPosts, intervals };
  }

  it('enable: posts an init heap sample and starts the 60s interval', () => {
    const perfState = freshPerfState();
    const h = makeHarness(perfState);

    h.setEnabled(true);

    expect(perfState.enabled).toBe(true);
    expect(h.heapPosts).toHaveLength(1);
    expect(h.intervals).toEqual([{ ms: 60000, cleared: false }]);
    expect(perfState.heapTimer).toBe(1);
  });

  it('disable: clears the interval and drops the ring buffer', () => {
    const perfState = freshPerfState();
    const h = makeHarness(perfState);
    h.setEnabled(true);
    perfState.samples = [1, 2, 3];
    perfState.count = 3;
    perfState.index = 3;
    perfState.chunkCount = 3;

    h.setEnabled(false);

    expect(perfState.enabled).toBe(false);
    expect(h.intervals[0].cleared).toBe(true);
    expect(perfState.heapTimer).toBeNull();
    expect(perfState.samples).toBeNull();
    expect(perfState.count).toBe(0);
    expect(perfState.index).toBe(0);
    expect(perfState.chunkCount).toBe(0);
  });

  it('is idempotent: re-enabling does not stack intervals or re-sample', () => {
    const perfState = freshPerfState();
    const h = makeHarness(perfState);

    h.setEnabled(true);
    h.setEnabled(true);

    expect(h.heapPosts).toHaveLength(1);
    expect(h.intervals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// perfPostUiReady — unconditional, once per webview lifetime
// ---------------------------------------------------------------------------

describe('webview perfPostUiReady', () => {
  function makeHarness(perfState: any) {
    const posted: any[] = [];
    const src = extractFunction(html, 'perfPostUiReady');
    const run = new Function(
      'perfState', 'postMessageWithPanelId', 'requestAnimationFrame',
      `${src}\nperfPostUiReady();`
    );
    return {
      posted,
      post: () => run(
        perfState,
        (m: any) => posted.push(m),
        (cb: () => void) => cb() // run the rAF callback synchronously
      ),
    };
  }

  it('posts uiReady even when perf logging is disabled (coarse panel.timeToUsable)', () => {
    const perfState = freshPerfState(); // enabled: false
    const h = makeHarness(perfState);

    h.post();

    expect(h.posted).toEqual([{ type: 'uiReady' }]);
    expect(perfState.uiReadySent).toBe(true);
  });

  it('only posts once per webview lifetime', () => {
    const perfState = freshPerfState();
    const h = makeHarness(perfState);

    h.post();
    h.post();

    expect(h.posted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// perfPostFirstChunkRendered — perfMark message shape
// ---------------------------------------------------------------------------

describe('webview perfPostFirstChunkRendered', () => {
  it('posts {type:perfMark, name:firstChunkRendered, sentAt} inside rAF', () => {
    const posted: any[] = [];
    const src = extractFunction(html, 'perfPostFirstChunkRendered');
    const run = new Function(
      'postMessageWithPanelId', 'requestAnimationFrame', 'sentAt',
      `${src}\nperfPostFirstChunkRendered(sentAt);`
    );
    let rafUsed = false;
    run(
      (m: any) => posted.push(m),
      (cb: () => void) => { rafUsed = true; cb(); },
      1234567890
    );

    expect(rafUsed).toBe(true);
    expect(posted).toEqual([{ type: 'perfMark', name: 'firstChunkRendered', sentAt: 1234567890 }]);
  });
});

afterEach(() => {
  // Keep the shared static PerfTracker clean for other test files.
  PerfTracker.setEnabled(false);
  PerfTracker.reset();
});
