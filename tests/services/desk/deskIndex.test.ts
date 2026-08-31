/**
 * DeskIndex tests (Plan 21 Phase 1, invariant I4).
 *
 * The property under test is an ABSENCE: no caller-supplied string is ever
 * interpreted. A pattern is looked up as a literal Map key and misses, rather
 * than matching anything — because a search verb that honours patterns is a
 * blind oracle (ask for a key shape, read the match count, binary-search the
 * secret out with no content returned and no card raised).
 */
import { describe, it, expect } from 'vitest';
import { DeskIndex, MAX_HITS } from '../../../src/services/desk/DeskIndex';
import { resolveScope } from '../../../src/services/desk/DeskScope';
import type { IndexSource } from '../../../src/services/desk/DeskIndex';

const scopeOf = (...allow: string[]) =>
  resolveScope({ ceiling: ['*'], share: { allow, version: 'v1' } });

function source(files: Record<string, string>): IndexSource {
  return {
    paths: Object.keys(files),
    readText: (p) => (p in files ? files[p] : null),
  };
}

const SAMPLE = {
  'src/billing/retry.ts': [
    'export const backoffSchedule = [1, 2, 4];',
    'export function computeRetry(attempt: number) { return attempt; }',
    'export class RetryPolicy {}',
    'export interface RetryOptions {}',
  ].join('\n'),
  'src/auth/login.ts': 'export function login() {}\nexport const SECRET_SAUCE = 1;',
  'docs/guide.md': '# Guide',
};

describe('DeskIndex — exact-token lookup', () => {
  const index = DeskIndex.build(scopeOf('src'), source(SAMPLE));

  it('finds an exported const by its exact name', () => {
    const hits = index.lookup('backoffSchedule', 'symbol');
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('src/billing/retry.ts');
    expect(hits[0].line).toBe(1);
    expect(hits[0].symbol).toBe('backoffSchedule');
  });

  it('finds functions, classes and interfaces', () => {
    expect(index.lookup('computeRetry', 'symbol')[0]?.line).toBe(2);
    expect(index.lookup('RetryPolicy', 'symbol')[0]?.line).toBe(3);
    expect(index.lookup('RetryOptions', 'symbol')[0]?.line).toBe(4);
  });

  it('finds a file by basename or stem', () => {
    expect(index.lookup('retry.ts', 'path')[0]?.path).toBe('src/billing/retry.ts');
    expect(index.lookup('retry', 'path')[0]?.path).toBe('src/billing/retry.ts');
  });

  it('returns coordinates only — never file content', () => {
    const hit = index.lookup('backoffSchedule', 'symbol')[0];
    expect(Object.keys(hit).sort()).toEqual(['line', 'path', 'symbol']);
    expect(JSON.stringify(hit)).not.toContain('[1, 2, 4]');
  });
});

describe('DeskIndex — a caller string is never interpreted', () => {
  const index = DeskIndex.build(scopeOf('src'), source(SAMPLE));

  const patterns = [
    'backoff.*',
    '.*',
    'backoff[A-Z]',
    'backoffSchedule|login',
    '^backoff',
    'backoff?',
    'SECRET_.*',
  ];

  for (const p of patterns) {
    it(`treats "${p}" as a literal and finds nothing`, () => {
      expect(index.lookup(p, 'symbol')).toEqual([]);
      expect(index.lookup(p, 'path')).toEqual([]);
    });
  }

  it('does not match on substring', () => {
    // "backoff" is a prefix of a real symbol; an exact index must miss it.
    expect(index.lookup('backoff', 'symbol')).toEqual([]);
    expect(index.lookup('Schedule', 'symbol')).toEqual([]);
  });

  it('is case-sensitive — no fuzzy widening', () => {
    expect(index.lookup('backoffschedule', 'symbol')).toEqual([]);
    expect(index.lookup('BACKOFFSCHEDULE', 'symbol')).toEqual([]);
  });

  it('a miss and an empty scope are indistinguishable in shape', () => {
    const empty = DeskIndex.build(resolveScope({}), source(SAMPLE));
    expect(empty.lookup('backoffSchedule', 'symbol')).toEqual([]);
    expect(index.lookup('nosuchsymbol', 'symbol')).toEqual([]);
  });

  it('rejects prototype keys rather than returning Object.prototype members', () => {
    expect(index.lookup('__proto__', 'symbol')).toEqual([]);
    expect(index.lookup('constructor', 'symbol')).toEqual([]);
    expect(index.lookup('toString', 'symbol')).toEqual([]);
  });
});

describe('DeskIndex — the scope is the index boundary', () => {
  it('never indexes a path outside the scope', () => {
    const index = DeskIndex.build(scopeOf('src/billing'), source(SAMPLE));
    expect(index.lookup('backoffSchedule', 'symbol')).toHaveLength(1);
    // login.ts is in src/auth, outside the shared prefix.
    expect(index.lookup('login', 'symbol')).toEqual([]);
    expect(index.lookup('SECRET_SAUCE', 'symbol')).toEqual([]);
    expect(index.lookup('login.ts', 'path')).toEqual([]);
  });

  it('indexes nothing at all under the empty scope', () => {
    const index = DeskIndex.build(resolveScope({}), source(SAMPLE));
    expect(index.localStats()).toEqual({ symbols: 0, paths: 0 });
  });

  it('carries the scopeVersion it was built for', () => {
    const scope = scopeOf('src');
    expect(DeskIndex.build(scope, source(SAMPLE)).scopeVersion).toBe(scope.scopeVersion);
  });

  it('skips vendored and generated trees even when they are in scope', () => {
    const index = DeskIndex.build(scopeOf('*'), source({
      'node_modules/lib/index.ts': 'export const vendored = 1;',
      'dist/bundle.js': 'export const built = 1;',
      'src/real.ts': 'export const real = 1;',
    }));
    expect(index.lookup('vendored', 'symbol')).toEqual([]);
    expect(index.lookup('built', 'symbol')).toEqual([]);
    expect(index.lookup('real', 'symbol')).toHaveLength(1);
  });

  it('does not read a file it will not index', () => {
    const read: string[] = [];
    DeskIndex.build(scopeOf('src'), {
      paths: ['src/a.ts', 'src/notes.md', 'node_modules/x/y.ts'],
      readText: (p) => { read.push(p); return 'export const a = 1;'; },
    });
    expect(read).toEqual(['src/a.ts']);   // .md is path-indexed only; node_modules skipped
  });
});

describe('DeskIndex — bounds', () => {
  it('caps hits per token', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_HITS + 10; i++) {
      files[`src/f${i}.ts`] = 'export const duplicated = 1;';
    }
    const index = DeskIndex.build(scopeOf('src'), source(files));
    expect(index.lookup('duplicated', 'symbol')).toHaveLength(MAX_HITS);
  });

  it('skips a minified line rather than extracting noise from it', () => {
    const index = DeskIndex.build(scopeOf('src'), source({
      'src/min.ts': `export const a=1;${'x'.repeat(600)}`,
    }));
    expect(index.lookup('a', 'symbol')).toEqual([]);
  });

  it('returns a fresh array — a caller cannot mutate the index through a result', () => {
    const index = DeskIndex.build(scopeOf('src'), source(SAMPLE));
    const first = index.lookup('backoffSchedule', 'symbol');
    first.push({ path: 'injected', line: 99 });
    expect(index.lookup('backoffSchedule', 'symbol')).toHaveLength(1);
  });

  it('tolerates an unreadable file without failing the build', () => {
    const index = DeskIndex.build(scopeOf('src'), {
      paths: ['src/ok.ts', 'src/bad.ts'],
      readText: (p) => (p === 'src/ok.ts' ? 'export const ok = 1;' : null),
    });
    expect(index.lookup('ok', 'symbol')).toHaveLength(1);
  });
});
