/**
 * DeskScope tests (Plan 21 Phase 1, invariant I3).
 *
 * Two properties carry the security weight:
 *
 *  1. INTERSECTION — a repository's `.mysti/desk-share.json` can only ever
 *     narrow the machine-scoped ceiling. Widening must be unrepresentable,
 *     not merely rejected.
 *  2. FAIL CLOSED — every ambiguous state (no ceiling, no share file, garbage
 *     in either, empty intersection) resolves to "nothing shared". "Not
 *     configured" must never mean "everything".
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_SCOPE,
  filterInScope,
  isInScope,
  resolveScope,
} from '../../../src/services/desk/DeskScope';

const ceiling = (...p: string[]) => p;
const share = (...p: string[]) => ({ allow: p });

describe('resolveScope — fails closed', () => {
  it('shares nothing when no ceiling is configured', () => {
    expect(resolveScope({ share: share('src') })).toEqual(EMPTY_SCOPE);
  });

  it('shares nothing when there is no share file', () => {
    expect(resolveScope({ ceiling: ceiling('*') })).toEqual(EMPTY_SCOPE);
  });

  it('shares nothing for an empty input', () => {
    expect(resolveScope({})).toEqual(EMPTY_SCOPE);
  });

  it('shares nothing when the share file is malformed', () => {
    expect(resolveScope({ ceiling: ceiling('*'), share: { allow: 'src' } })).toEqual(EMPTY_SCOPE);
    expect(resolveScope({ ceiling: ceiling('*'), share: { allow: null } })).toEqual(EMPTY_SCOPE);
    expect(resolveScope({ ceiling: ceiling('*'), share: {} })).toEqual(EMPTY_SCOPE);
  });

  it('shares nothing when the intersection is empty', () => {
    expect(resolveScope({ ceiling: ceiling('src/api'), share: share('docs') })).toEqual(EMPTY_SCOPE);
  });

  it('drops unparseable entries rather than guessing at them', () => {
    const s = resolveScope({ ceiling: ceiling('*'), share: share('../etc', 'src') });
    expect(s.allow).toEqual(['src']);
  });

  it('drops a traversal even when it is the only entry', () => {
    expect(resolveScope({ ceiling: ceiling('*'), share: share('../../etc') })).toEqual(EMPTY_SCOPE);
  });
});

describe('resolveScope — intersection can only narrow', () => {
  it('takes the narrower side when the share is inside the ceiling', () => {
    const s = resolveScope({ ceiling: ceiling('src'), share: share('src/billing') });
    expect(s.allow).toEqual(['src/billing']);
  });

  it('takes the narrower side when the CEILING is the tighter one', () => {
    // The repo asks for all of `src`; the machine only permits `src/billing`.
    const s = resolveScope({ ceiling: ceiling('src/billing'), share: share('src') });
    expect(s.allow).toEqual(['src/billing']);
  });

  it('a repo cannot widen past the ceiling by listing a sibling', () => {
    const s = resolveScope({ ceiling: ceiling('src/billing'), share: share('src/billing', 'src/secrets') });
    expect(s.allow).toEqual(['src/billing']);
    expect(isInScope(s, 'src/secrets/keys.ts')).toBe(false);
  });

  it('a repo cannot widen by claiming the whole workspace', () => {
    const s = resolveScope({ ceiling: ceiling('src/billing'), share: share('*') });
    expect(s.allow).toEqual(['src/billing']);
    expect(isInScope(s, 'README.md')).toBe(false);
  });

  it('a ceiling of * defers entirely to the share file', () => {
    const s = resolveScope({ ceiling: ceiling('*'), share: share('src', 'docs') });
    expect([...s.allow].sort()).toEqual(['docs', 'src']);
  });

  it('keeps multiple surviving prefixes', () => {
    const s = resolveScope({ ceiling: ceiling('src', 'docs'), share: share('src/api', 'docs') });
    expect([...s.allow].sort()).toEqual(['docs', 'src/api']);
  });

  it('tolerates a trailing slash in hand-written config', () => {
    const s = resolveScope({ ceiling: ceiling('src/'), share: share('src/billing/') });
    expect(s.allow).toEqual(['src/billing']);
  });

  it('de-duplicates repeated prefixes', () => {
    const s = resolveScope({ ceiling: ceiling('src'), share: share('src', 'src', 'src/') });
    expect(s.allow).toEqual(['src']);
  });
});

describe('scopeVersion', () => {
  it('changes when the shared set changes, even at the same declared version', () => {
    const a = resolveScope({ ceiling: ceiling('*'), share: { allow: ['src'], version: 'v1' } });
    const b = resolveScope({ ceiling: ceiling('*'), share: { allow: ['src', 'docs'], version: 'v1' } });
    expect(a.scopeVersion).not.toBe(b.scopeVersion);
  });

  it('is stable across prefix ORDER, so a reordered file does not bust the cache', () => {
    const a = resolveScope({ ceiling: ceiling('*'), share: { allow: ['src', 'docs'], version: 'v1' } });
    const b = resolveScope({ ceiling: ceiling('*'), share: { allow: ['docs', 'src'], version: 'v1' } });
    expect(a.scopeVersion).toBe(b.scopeVersion);
  });

  it('changes when the declared version changes', () => {
    const a = resolveScope({ ceiling: ceiling('*'), share: { allow: ['src'], version: 'v1' } });
    const b = resolveScope({ ceiling: ceiling('*'), share: { allow: ['src'], version: 'v2' } });
    expect(a.scopeVersion).not.toBe(b.scopeVersion);
  });
});

describe('isInScope', () => {
  const scope = resolveScope({ ceiling: ceiling('*'), share: share('src/billing') });

  it('admits the prefix itself and anything beneath it', () => {
    expect(isInScope(scope, 'src/billing')).toBe(true);
    expect(isInScope(scope, 'src/billing/webhook.ts')).toBe(true);
    expect(isInScope(scope, 'src/billing/deep/nested/file.ts')).toBe(true);
  });

  it('refuses a sibling whose name merely starts the same way', () => {
    // The classic prefix bug: "src/billing-secrets" must not pass on "src/billing".
    expect(isInScope(scope, 'src/billing-secrets/keys.ts')).toBe(false);
    expect(isInScope(scope, 'src/billingX')).toBe(false);
  });

  it('refuses anything outside', () => {
    expect(isInScope(scope, 'src/auth/login.ts')).toBe(false);
    expect(isInScope(scope, 'README.md')).toBe(false);
  });

  it('re-validates the path, so a traversal never passes', () => {
    expect(isInScope(scope, 'src/billing/../../.env')).toBe(false);
    expect(isInScope(scope, '/etc/passwd')).toBe(false);
    expect(isInScope(scope, 'src/billing/‮evil')).toBe(false);
  });

  it('admits nothing under the empty scope', () => {
    expect(isInScope(EMPTY_SCOPE, 'src/billing/webhook.ts')).toBe(false);
    expect(isInScope(EMPTY_SCOPE, 'anything')).toBe(false);
  });
});

describe('filterInScope', () => {
  it('keeps only in-scope paths, preserving order', () => {
    const scope = resolveScope({ ceiling: ceiling('*'), share: share('src') });
    expect(filterInScope(scope, ['src/a.ts', 'docs/b.md', 'src/c.ts'])).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('returns nothing for the empty scope', () => {
    expect(filterInScope(EMPTY_SCOPE, ['src/a.ts'])).toEqual([]);
  });
});
