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
 * SkillTelemetry (Plan 20 Phase 1) — the go/no-go instrument.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Phase 1 shipped retrieval on a hypothesis: that the coordinator failing to
 * find the right working practice is what costs quality, and that fixing
 * retrieval is therefore worth building authoring on top of. That hypothesis
 * has to be falsifiable, or Phases 2–4 get funded on vibes.
 *
 * The published warning is specific: a self-evolving skill library can degrade
 * BELOW the no-skill baseline while aggregate accuracy still looks fine, and
 * the signal that moves first is ROUTER ENGAGEMENT — healthy libraries get a
 * skill assigned on 70–80% of tasks, drifting ones fall to ~19%. So engagement
 * is the headline number here, not a vanity count of lookups.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No prompts, no content, no queries, no file paths — only artifact ids the
 * user already has on disk, plus counters. This is a local instrument for the
 * user's own go/no-go decision; it is not analytics and nothing here is sent
 * anywhere.
 *
 * Memento-injectable so it is directly testable with a plain object.
 */

/** How a coordinator run ended, as far as the host can honestly observe. */
export type RunOutcome = 'completed' | 'cancelled' | 'turn-limit' | 'error';

export interface SkillRunRecord {
  /** Number of catalog searches the model issued this run. */
  searches: number;
  /** Artifact ids the model actually read (deduped). */
  viewed: string[];
  outcome: RunOutcome;
  at: number;
}

export interface SkillTelemetrySummary {
  runs: number;
  runsThatSearched: number;
  runsThatViewed: number;
  /**
   * Fraction of runs where the model consulted the catalog at all.
   * The comparison point from the literature: 70–80% healthy, ~19% drifting.
   */
  engagementRate: number;
  /** Of the runs that searched, how many led to actually reading something. */
  searchToViewRate: number;
  /** Completion rate split by whether the catalog was consulted. */
  completionWithView: number | null;
  completionWithoutView: number | null;
  /** Artifact id → times read, most-read first. */
  topArtifacts: Array<{ id: string; views: number }>;
}

/** Minimal Memento shape (vscode.Memento) so tests can pass a plain object. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

const KEY = 'mysti.skillTelemetry.v1';
/**
 * Ring-buffer size. Four weeks of heavy single-user IDE traffic is comfortably
 * under this, and bounding it keeps workspaceState small.
 */
const MAX_RUNS = 500;

export class SkillTelemetry {
  constructor(private readonly _state: MementoLike, private readonly _nowMs: () => number = () => Date.now()) {}

  private _load(): SkillRunRecord[] {
    const raw = this._state.get<SkillRunRecord[]>(KEY);
    return Array.isArray(raw) ? raw.filter(r => r && typeof r.outcome === 'string' && Array.isArray(r.viewed)) : [];
  }

  /**
   * Record one coordinator run. Runs where the catalog was unavailable are the
   * caller's business to skip — a run that could not search must not count
   * against engagement, or the headline number measures the setting rather than
   * the retrieval.
   */
  record(searches: number, viewed: string[], outcome: RunOutcome): void {
    const runs = this._load();
    runs.push({
      searches: Math.max(0, Math.floor(searches)),
      viewed: [...new Set(viewed)].slice(0, 20),
      outcome,
      at: this._nowMs(),
    });
    if (runs.length > MAX_RUNS) { runs.splice(0, runs.length - MAX_RUNS); }
    void this._state.update(KEY, runs);
  }

  summary(): SkillTelemetrySummary {
    const runs = this._load();
    const searched = runs.filter(r => r.searches > 0);
    const viewedRuns = runs.filter(r => r.viewed.length > 0);
    const notViewedRuns = runs.filter(r => r.viewed.length === 0);

    const completion = (set: SkillRunRecord[]): number | null =>
      set.length === 0 ? null : set.filter(r => r.outcome === 'completed').length / set.length;

    const views = new Map<string, number>();
    for (const run of runs) {
      for (const id of run.viewed) { views.set(id, (views.get(id) || 0) + 1); }
    }

    return {
      runs: runs.length,
      runsThatSearched: searched.length,
      runsThatViewed: viewedRuns.length,
      engagementRate: runs.length === 0 ? 0 : searched.length / runs.length,
      searchToViewRate: searched.length === 0 ? 0 : viewedRuns.length / searched.length,
      completionWithView: completion(viewedRuns),
      completionWithoutView: completion(notViewedRuns),
      topArtifacts: [...views.entries()]
        .map(([id, v]) => ({ id, views: v }))
        .sort((a, b) => (b.views - a.views) || a.id.localeCompare(b.id))
        .slice(0, 20),
    };
  }

  /**
   * A readable go/no-go report.
   *
   * Written to be read by a person deciding whether to fund more work, so it
   * states the decision rule and refuses to render a verdict on a sample too
   * small to support one.
   */
  report(): string {
    const s = this.summary();
    const pct = (n: number | null): string => n === null ? 'n/a' : `${Math.round(n * 100)}%`;
    const lines = [
      '# Agent catalog — retrieval report (Plan 20 Phase 1 go/no-go)',
      '',
      `Runs recorded: ${s.runs}`,
      `Runs that searched the catalog: ${s.runsThatSearched} (${pct(s.engagementRate)} engagement)`,
      `Of those, runs that read an artifact: ${s.runsThatViewed} (${pct(s.searchToViewRate)})`,
      '',
      '## Outcome split',
      `Completed, catalog consulted:     ${pct(s.completionWithView)}`,
      `Completed, catalog not consulted: ${pct(s.completionWithoutView)}`,
      '',
      '## Most-read artifacts',
      s.topArtifacts.length === 0 ? '(none yet)' : s.topArtifacts.map(a => `- ${a.id}: ${a.views}`).join('\n'),
      '',
      '## How to read this',
      'Engagement is the number that moves first. Published comparison: a healthy',
      'library is consulted on 70–80% of tasks; ~19% indicates drift.',
      '',
    ];
    if (s.runs < 30) {
      lines.push(`**Not enough data to decide** (${s.runs} runs; want at least 30, ideally 4 weeks of normal use).`);
    } else if (s.engagementRate < 0.3) {
      lines.push('**Signal so far: NO-GO.** The model rarely consults the catalog, so retrieval is');
      lines.push('not the bottleneck — authoring more artifacts (Phases 2–4) would not be reached.');
    } else {
      const delta = (s.completionWithView ?? 0) - (s.completionWithoutView ?? 0);
      lines.push(`**Signal so far: engagement ${pct(s.engagementRate)}, completion delta ${Math.round(delta * 100)}pp.**`);
      lines.push('Engagement alone is not value — weigh the completion delta before funding Phases 2–4.');
    }
    return lines.join('\n');
  }

  clear(): void { void this._state.update(KEY, []); }
}
