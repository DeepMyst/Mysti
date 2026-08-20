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
 * SkillIndex (Plan 20 Phase 1) — retrieval over the agent catalog.
 *
 * WHY RETRIEVAL IS THE LOAD-BEARING PART
 * --------------------------------------
 * The measured result on agent skills is blunt: CURATED skills lift pass rate
 * +16.2pp, SELF-GENERATED ones +0.0pp (SkillsBench, arXiv 2606.11435). So the
 * value is not in an agent writing skills — it is in the right skill being FOUND
 * at the right moment. Today the coordinator cannot see skills at all
 * (`buildPromptContext` has exactly one caller, and it is a CLI-backend path),
 * so it has 42 bundled artifacts available and reaches none of them.
 *
 * WHY NOT JUST INJECT THEM
 * ------------------------
 * Because that is how you buy an accuracy cliff. Tool/skill selection degrades
 * past roughly 30–50 always-present entries, and it degrades as a cliff rather
 * than a gradient. So the always-on footprint is a compact CATEGORY HEADER —
 * O(1) in library size — and everything else is pulled on demand.
 *
 * Pure module: no `vscode`, no `fs`. Everything here is directly testable, and
 * the scoring can be tuned against fixtures rather than against a live editor.
 */

/** One indexable agent artifact. Mirrors the fields `AgentMetadata` exposes. */
export interface IndexedArtifact {
  id: string;
  name: string;
  description: string;
  category: string;
  type: 'persona' | 'skill' | 'role';
  activationTriggers?: string[];
  /** Integrity-verified bundled content (Plan 20 Phase 0). Affects labelling only. */
  trusted?: boolean;
}

export interface SkillSearchHit {
  artifact: IndexedArtifact;
  score: number;
}

/**
 * Below this many artifacts an index cannot pay for itself — a library that
 * small is cheaper to list than to search.
 */
export const SKILL_INDEX_MIN_ARTIFACTS = 8;

/**
 * Words that appear across the corpus and therefore separate nothing.
 *
 * The two-letter function words matter more than they look. Activation triggers
 * are written as phrases — "walk ME through", "best way TO learn" — so without
 * them a query like "book me a flight to Lisbon" scores the mentor persona
 * higher than several genuine matches. Short technical tokens that DO carry
 * meaning (ui, ci, db, js, go) are deliberately absent from this list.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'via',
  'use', 'using', 'used', 'get', 'set', 'all', 'any', 'new', 'out', 'how',
  'need', 'make', 'run', 'now', 'then', 'when', 'what', 'which', 'some', 'you',
  'your', 'are', 'was', 'were', 'have', 'has', 'had', 'can', 'should', 'would',
  'about', 'help', 'want', 'please', 'like', 'just', 'not', 'but', 'its',
  // Two-letter function words — noise in both queries and trigger phrases.
  'me', 'my', 'to', 'in', 'on', 'at', 'of', 'or', 'if', 'as', 'be', 'do',
  'is', 'it', 'an', 'we', 'us', 'so', 'no', 'up', 'by', 'am', 'he', 'la',
]);

/**
 * Minimum BM25 score for a result to be returned at all.
 *
 * Measured against the bundled catalog, genuine matches score 4.5-18.4 - and
 * off-topic queries ("what is the weather", "book me a flight") score exactly
 * ZERO, because after stop-word removal they share no term with any artifact.
 * The STOPWORDS list, not this number, is what stops false matches; an earlier
 * floor of 5 was measured killing real hits (secure-coding at 4.51) while still
 * admitting the one borderline case it was meant to catch.
 *
 * So this is a low guard against a single incidental common-term match, not the
 * primary filter. Raising it trades recall for nothing.
 */
const MIN_SCORE = 2;

// Okapi BM25 constants. k1 controls term-frequency saturation, b controls
// length normalization; these are the standard defaults and the corpus is far
// too small to justify tuning them.
const K1 = 1.2;
const B = 0.75;

/**
 * Field weights. A hit on the NAME or on an explicit activation trigger is much
 * stronger evidence than a hit in prose: triggers are the author saying "this is
 * when to use me", which is exactly the retrieval question being asked.
 */
const FIELD_BOOST = { name: 3, triggers: 3, description: 1, category: 1 } as const;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Crude suffix stemmer so "testing"/"tests"/"test" collide.
 *
 * Adverbs matter more than they look: without the `-ly` rule, "handle it
 * gracefully" never reaches the skill whose trigger is "graceful degradation".
 * The `-ly` strip is length-guarded so "apply"/"reply" keep their root — and
 * note that an occasional wrong stem is harmless anyway, because both the query
 * and the document go through the same function. Only INCONSISTENT stemming
 * loses matches.
 */
function stem(token: string): string {
  let out = token;
  if (out.endsWith('ly') && out.length - 2 >= 4) { out = out.slice(0, -2); }
  out = out
    .replace(/(ies)$/, 'y')
    .replace(/(sses|ches|shes|xes)$/, '')
    .replace(/(ing|ed|es|s)$/, '');
  return out || token;
}

interface IndexedDoc {
  artifact: IndexedArtifact;
  /** stem → weighted term frequency */
  terms: Map<string, number>;
  length: number;
}

export class SkillIndex {
  private readonly _docs: IndexedDoc[] = [];
  private readonly _df = new Map<string, number>();
  private _avgLength = 0;

  constructor(artifacts: IndexedArtifact[]) {
    for (const artifact of artifacts) {
      const terms = new Map<string, number>();
      let length = 0;
      const addField = (text: string | undefined, boost: number): void => {
        for (const raw of tokenize(text || '')) {
          const key = stem(raw);
          terms.set(key, (terms.get(key) || 0) + boost);
          length += boost;
        }
      };
      addField(artifact.name, FIELD_BOOST.name);
      addField(artifact.id.replace(/-/g, ' '), FIELD_BOOST.name);
      addField((artifact.activationTriggers || []).join(' '), FIELD_BOOST.triggers);
      addField(artifact.description, FIELD_BOOST.description);
      addField(artifact.category, FIELD_BOOST.category);

      this._docs.push({ artifact, terms, length });
      for (const term of terms.keys()) {
        this._df.set(term, (this._df.get(term) || 0) + 1);
      }
    }
    const total = this._docs.reduce((sum, d) => sum + d.length, 0);
    this._avgLength = this._docs.length > 0 ? total / this._docs.length : 0;
  }

  get size(): number { return this._docs.length; }

  /** True when the catalog is worth searching rather than simply listing. */
  get worthIndexing(): boolean { return this._docs.length >= SKILL_INDEX_MIN_ARTIFACTS; }

  /**
   * Rank artifacts against a natural-language description of the task.
   *
   * Returns [] rather than a weak best-effort match when nothing scores: a
   * confidently wrong skill is worse than none, because its instructions are
   * injected and followed.
   */
  search(query: string, limit = 3, type?: IndexedArtifact['type']): SkillSearchHit[] {
    const queryTerms = tokenize(query).map(stem);
    if (queryTerms.length === 0 || this._docs.length === 0) { return []; }

    const pool = type ? this._docs.filter(d => d.artifact.type === type) : this._docs;
    const hits: SkillSearchHit[] = [];

    for (const doc of pool) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.terms.get(term);
        if (!tf) { continue; }
        const df = this._df.get(term) || 0;
        // +1 inside the log keeps IDF non-negative for a term present in every
        // document — without it a universal term scores negatively and actively
        // pushes down the artifacts that match it.
        const idf = Math.log(1 + (this._docs.length - df + 0.5) / (df + 0.5));
        const norm = tf + K1 * (1 - B + (B * doc.length) / (this._avgLength || 1));
        score += idf * ((tf * (K1 + 1)) / norm);
      }
      if (score >= MIN_SCORE) { hits.push({ artifact: doc.artifact, score }); }
    }

    hits.sort((a, b) => (b.score - a.score) || a.artifact.id.localeCompare(b.artifact.id));
    return hits.slice(0, limit);
  }

  /**
   * The always-present footprint: what KINDS of thing exist and how many.
   *
   * O(1) in library size by construction — the model learns that a catalog
   * exists and roughly what it covers, then searches. Listing names here would
   * reintroduce exactly the linear growth the index exists to avoid.
   */
  categoryHeader(maxCategories = 8): string {
    if (!this.worthIndexing) { return ''; }
    const counts = new Map<string, number>();
    for (const doc of this._docs) {
      const key = doc.artifact.category || 'general';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, maxCategories);
    const shown = top.reduce((sum, [, n]) => sum + n, 0);
    const rest = this._docs.length - shown;
    const parts = top.map(([category, n]) => `${category} (${n})`);
    if (rest > 0) { parts.push(`other (${rest})`); }
    return `${this._docs.length} available: ${parts.join(', ')}`;
  }

  /** Render hits for the model. Kept here so the wording is testable. */
  renderHits(hits: SkillSearchHit[]): string {
    if (hits.length === 0) { return ''; }
    return hits.map(h => {
      const a = h.artifact;
      const triggers = a.activationTriggers?.length
        ? ` [triggers: ${a.activationTriggers.slice(0, 6).join(', ')}]`
        : '';
      return `${a.id} (${a.type}, ${a.category})${a.trusted ? '' : ' [user-authored]'} — ${a.description}${triggers}`;
    }).join('\n');
  }

  /** Look up one artifact by exact id. */
  get(id: string): IndexedArtifact | undefined {
    return this._docs.find(d => d.artifact.id === id)?.artifact;
  }
}
