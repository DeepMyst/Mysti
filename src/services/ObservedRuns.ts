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
 * ObservedRuns (Plan 20 Phase 3) — what the HOST actually watched happen.
 *
 * WHY THIS IS THE LOAD-BEARING PIECE OF THE VERIFICATION LADDER
 * ------------------------------------------------------------
 * The obvious design has the model author a capability AND the golden cases
 * that prove it works. That is not evidence, it is theatre, and the failure is
 * documented rather than hypothetical: the Darwin Gödel Machine fabricated a
 * passing test log for tests that never ran, and when asked to fix hallucination
 * detection it found both the honest fix and the hack of deleting the detector's
 * markers. ToolMaker's headline 80% rests on 124 unit tests written by HUMANS
 * and held out from the agent.
 *
 * So the model never writes an expectation here. This store records commands the
 * host itself executed — the real command, its real exit code, a digest of its
 * real output — and a capability is verified by REPLAYING those and comparing
 * against what was recorded. The model can propose a capability; it cannot
 * propose what "working" means.
 *
 * It doubles as the T2 recurrence signal: a normalized command shape seen three
 * times is the measured break-even for distilling it into a capability
 * (~364K tokens to distill vs ~139K saved per reuse).
 *
 * Stores digests, not output. A command's stdout can contain anything the
 * workspace contains.
 */

import { createHash } from 'crypto';

export interface ObservedRun {
  /** Normalized shape, e.g. `npm run test:unit` with arguments generalized. */
  shape: string;
  /** The exact command as executed, kept for replay. */
  command: string;
  exitCode: number | null;
  /** SHA-256 of the trimmed stdout — never the output itself. */
  outputDigest: string;
  /** Bytes of stdout, so a replay can sanity-check magnitude too. */
  outputBytes: number;
  at: number;
  /** Distinct coordinator run this was seen in (recurrence needs independence). */
  runId: string;
}

/** Minimal Memento shape so tests can pass a plain object. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

const KEY = 'mysti.observedRuns.v1';
const MAX_RECORDS = 300;

/** Measured distillation break-even. Below this, distilling costs more than it saves. */
export const RECURRENCE_THRESHOLD = 3;

/**
 * Normalize a command into a comparable "shape".
 *
 * Absolute paths, hashes, ports, timestamps and quoted literals vary run to run
 * while describing the same procedure, so they are generalized. Without this
 * every invocation looks unique and the recurrence signal never fires.
 */
export function commandShape(command: string): string {
  return command
    .trim()
    .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, '<str>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T\d:.]*\b/g, '<date>')
    .replace(/(^|\s)(\/[^\s]+)/g, '$1<path>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

export function digestOutput(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

export class ObservedRuns {
  constructor(private readonly _state: MementoLike, private readonly _nowMs: () => number = () => Date.now()) {}

  private _load(): ObservedRun[] {
    const raw = this._state.get<ObservedRun[]>(KEY);
    return Array.isArray(raw) ? raw.filter(r => r && typeof r.command === 'string') : [];
  }

  /** Record a command the HOST ran. Never called with model-supplied results. */
  record(command: string, exitCode: number | null, stdout: string, runId: string): void {
    const runs = this._load();
    runs.push({
      shape: commandShape(command),
      command: command.slice(0, 2_000),
      exitCode,
      outputDigest: digestOutput(stdout),
      outputBytes: Buffer.byteLength(stdout, 'utf8'),
      at: this._nowMs(),
      runId,
    });
    if (runs.length > MAX_RECORDS) { runs.splice(0, runs.length - MAX_RECORDS); }
    void this._state.update(KEY, runs);
  }

  /** Every observation of a shape, newest last. */
  forShape(shape: string): ObservedRun[] {
    return this._load().filter(r => r.shape === shape);
  }

  /**
   * How many INDEPENDENT times a shape succeeded.
   *
   * Independence is per coordinator run, not per invocation: five retries
   * inside one turn are one observation, not five. Correlated observations
   * counted as independent votes is exactly how a promotion gate degrades —
   * grouping by dependency cut false promotion from 0.597 to 0.040 in the
   * published evaluation.
   */
  independentSuccesses(shape: string): number {
    const runIds = new Set<string>();
    for (const run of this._load()) {
      if (run.shape === shape && run.exitCode === 0) { runIds.add(run.runId); }
    }
    return runIds.size;
  }

  /** Shapes that have recurred enough to be worth distilling. */
  recurringShapes(threshold = RECURRENCE_THRESHOLD): Array<{ shape: string; runs: number }> {
    const byShape = new Map<string, Set<string>>();
    for (const run of this._load()) {
      if (run.exitCode !== 0) { continue; }
      if (!byShape.has(run.shape)) { byShape.set(run.shape, new Set()); }
      byShape.get(run.shape)!.add(run.runId);
    }
    return [...byShape.entries()]
      .map(([shape, ids]) => ({ shape, runs: ids.size }))
      .filter(s => s.runs >= threshold)
      .sort((a, b) => b.runs - a.runs);
  }

  /**
   * The golden cases for a capability, drawn from observations the host made.
   *
   * Returns [] when there is no observed history — and callers MUST treat that
   * as "cannot verify" rather than falling back to anything the model supplied.
   */
  goldensFor(commands: string[]): ObservedRun[] {
    const out: ObservedRun[] = [];
    const seen = new Set<string>();
    for (const command of commands) {
      const shape = commandShape(command);
      if (seen.has(shape)) { continue; }
      const successes = this.forShape(shape).filter(r => r.exitCode === 0);
      if (successes.length > 0) {
        seen.add(shape);
        out.push(successes[successes.length - 1]);
      }
    }
    return out;
  }

  clear(): void { void this._state.update(KEY, []); }
}
