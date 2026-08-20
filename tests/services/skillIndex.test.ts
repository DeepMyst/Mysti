/**
 * Plan 20 Phase 1 — retrieval quality over the REAL bundled catalog.
 *
 * This is the phase's go/no-go evidence, so the tests run against the artifacts
 * that actually ship rather than fixtures: if the index cannot find the 42
 * bundled personas/skills/roles from a plausible paraphrase, nothing downstream
 * is worth building. Both directions matter — the negatives are the half that
 * catches an index which simply returns something for every query.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { SkillIndex, SKILL_INDEX_MIN_ARTIFACTS, type IndexedArtifact } from '../../src/services/SkillIndex';
import { parseAgentMarkdown } from '../../src/managers/agentMarkdown';

const CORE = path.resolve(__dirname, '..', '..', 'resources', 'agents', 'core');

function loadRealCatalog(): IndexedArtifact[] {
  const out: IndexedArtifact[] = [];
  for (const [dir, type] of [['personas', 'persona'], ['skills', 'skill'], ['roles', 'role']] as const) {
    const base = path.join(CORE, dir);
    if (!fs.existsSync(base)) { continue; }
    for (const entry of fs.readdirSync(base)) {
      if (!entry.toLowerCase().endsWith('.md')) { continue; }
      const parsed = parseAgentMarkdown(fs.readFileSync(path.join(base, entry), 'utf8'));
      const fm = parsed.frontmatter;
      out.push({
        id: String(fm.id || entry.replace(/\.md$/, '')),
        name: String(fm.name || ''),
        description: String(fm.description || ''),
        category: String(fm.category || 'general'),
        type,
        activationTriggers: Array.isArray(fm.activationTriggers) ? fm.activationTriggers.map(String) : undefined,
        trusted: true,
      });
    }
  }
  return out;
}

const catalog = loadRealCatalog();
const index = new SkillIndex(catalog);

describe('SkillIndex over the real bundled catalog', () => {
  it('indexes every bundled artifact', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(40);
    expect(index.size).toBe(catalog.length);
    expect(index.worthIndexing).toBe(true);
  });

  it('finds the intended artifact from natural paraphrases', () => {
    // Eight paraphrases a user might actually type — none quoting the skill id.
    const cases: Array<[string, string]> = [
      ['write the failing test before the code', 'test-driven'],
      ['make sure this code has no security holes', 'secure-coding'],  // ranks 3rd behind the security persona - both are right
      ['keep my answers short and to the point', 'concise'],
      ['I want to be able to undo this deployment', 'rollback-ready'],
      ['add logging and metrics so we can debug production', 'observability'],
      ['design the REST endpoints before implementing', 'api-design-first'],
      ['do not let this change balloon in scope', 'scope-discipline'],
      ['handle it gracefully when the service is down', 'graceful-degradation'],
    ];
    const misses: string[] = [];
    for (const [query, expectedId] of cases) {
      const ids = index.search(query, 3).map(h => h.artifact.id);
      if (!ids.includes(expectedId)) { misses.push(`${query} → got [${ids.join(', ')}], wanted ${expectedId}`); }
    }
    expect(misses, `top-3 misses:\n${misses.join('\n')}`).toEqual([]);
  });

  it('returns nothing for queries the catalog genuinely does not cover', () => {
    // The half that catches an index which always returns *something*.
    // These score exactly ZERO - after stop-word removal they share no term
    // with any artifact. Deliberately NOT including "recommend a good
    // restaurant": "recommend" really is an advisor trigger, so scoring it is
    // correct lexical behaviour, and asserting otherwise would test a fiction.
    for (const query of [
      'what is the weather in Paris tomorrow',
      'translate this sentence into Hungarian',
      'book me a flight to Lisbon',
      'sort my grocery shopping list',
    ]) {
      expect(index.search(query, 3), `expected no hits for "${query}"`).toEqual([]);
    }
  });

  it('ranks a name/trigger hit above an incidental prose hit', () => {
    const hits = index.search('test driven development', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].artifact.id).toBe('test-driven');
  });

  it('matches a bare one-word query - the floor must not eat short queries', () => {
    // Regression: a floor tuned off multi-word paraphrases silently made
    // single-word queries return nothing at all.
    expect(index.search('security', 5).map(h => h.artifact.id)).toContain('secure-coding');
  });

  it('finds an artifact through an adverb form of its trigger', () => {
    // Regression: "gracefully" did not stem to "graceful", so the skill whose
    // trigger is "graceful degradation" was unreachable from natural phrasing.
    expect(index.search('handle it gracefully', 3).map(h => h.artifact.id)).toContain('graceful-degradation');
  });

  it('can restrict results to one artifact type', () => {
    const skillsOnly = index.search('security', 5, 'skill');
    expect(skillsOnly.length).toBeGreaterThan(0);
    expect(skillsOnly.every(h => h.artifact.type === 'skill')).toBe(true);
  });
});

describe('always-on footprint is O(1) in library size', () => {
  const makeCatalog = (n: number): IndexedArtifact[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `artifact-${i}`,
      name: `Artifact ${i}`,
      description: `Does useful thing number ${i} for the project`,
      category: `category-${i % 6}`,
      type: 'skill' as const,
      activationTriggers: [`thing${i}`, 'useful'],
    }));

  it('stays under the 600-token budget at 200 artifacts', () => {
    const header = new SkillIndex(makeCatalog(200)).categoryHeader();
    // ~4 chars/token, matching AgentContextManager's own estimator.
    expect(header.length / 4).toBeLessThan(600);
  });

  it('does not grow materially between 20 and 2000 artifacts', () => {
    const small = new SkillIndex(makeCatalog(20)).categoryHeader().length;
    const huge = new SkillIndex(makeCatalog(2000)).categoryHeader().length;
    // Only the digits in the counts change, so growth is a handful of chars.
    expect(huge - small).toBeLessThan(40);
  });

  it('emits NOTHING below the minimum catalog size', () => {
    const tiny = new SkillIndex(makeCatalog(SKILL_INDEX_MIN_ARTIFACTS - 1));
    expect(tiny.worthIndexing).toBe(false);
    expect(tiny.categoryHeader()).toBe('');
    expect(new SkillIndex([]).categoryHeader()).toBe('');
  });

  it('names the categories so the model knows what it can search for', () => {
    const header = new SkillIndex(makeCatalog(30)).categoryHeader();
    expect(header).toMatch(/^30 available: /);
    expect(header).toContain('category-0');
  });
});

describe('rendering', () => {
  it('labels non-verified artifacts so the model can weigh them', () => {
    const idx = new SkillIndex([
      { id: 'bundled', name: 'Bundled', description: 'ships with the extension', category: 'general', type: 'skill', trusted: true },
      { id: 'mine', name: 'Mine', description: 'written in this workspace', category: 'general', type: 'skill', trusted: false },
    ]);
    const rendered = idx.renderHits([
      { artifact: idx.get('bundled')!, score: 1 },
      { artifact: idx.get('mine')!, score: 1 },
    ]);
    expect(rendered).toContain('bundled (skill, general) — ships with the extension');
    expect(rendered).toContain('mine (skill, general) [user-authored]');
  });

  it('renders nothing for no hits', () => {
    expect(new SkillIndex([]).renderHits([])).toBe('');
  });
});
