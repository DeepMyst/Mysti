/**
 * DeskContract tests (Plan 21 Phase 1).
 *
 * This is the boundary every inbound cross-machine request crosses before any
 * code sees it. Two properties matter more than coverage:
 *
 *  1. It DROPS rather than repairs. A validator that cleans up hostile input
 *     is an oracle — if `../../etc/passwd` becomes `etc/passwd`, the caller
 *     learns the filter's shape and writes the next probe around it.
 *  2. `locate` takes a literal, never a pattern. A search verb that accepts a
 *     pattern is a blind oracle: ask for a key shape, read the match count,
 *     and binary-search a secret out with zero content returned and zero
 *     approval cards raised.
 */
import { describe, it, expect } from 'vitest';
import {
  DESK_VERBS,
  DESK_VERB_NAMES,
  LIMITS,
  hasUnsafeChars,
  isDeskVerb,
  validateAlias,
  validateArray,
  validateCall,
  validateId,
  validatePath,
  validateSha1,
  validateSha256,
  validateText,
  validateToken,
} from '../../../src/services/desk/DeskContract';

describe('validatePath — drops, never repairs', () => {
  const rejected: [string, string][] = [
    ['parent traversal', '../secrets.env'],
    ['nested traversal', 'src/../../etc/passwd'],
    ['absolute posix', '/etc/passwd'],
    ['windows drive', 'C:/Users/me/.ssh/id_rsa'],
    ['backslash separator', 'src\\index.ts'],
    ['UNC prefix', '\\\\server\\share'],
    ['dot segment', './src/index.ts'],
    ['inner dot segment', 'src/./index.ts'],
    ['double slash', 'src//index.ts'],
    ['trailing slash', 'src/'],
    ['empty', ''],
    ['NUL byte', 'src/index\u0000.ts'],
    ['newline', 'src/index.ts\nsrc/other.ts'],
    ['bidi override', 'src/\u202Egnp.exe'],
    ['zero width', 'src/in\u200Bdex.ts'],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      const r = validatePath(value);
      expect(r.ok, `${label} must be rejected`).toBe(false);
    });
  }

  it('rejects a path past the length cap', () => {
    expect(validatePath('a/'.repeat(LIMITS.path)).ok).toBe(false);
  });

  it('accepts an ordinary workspace-relative path unchanged', () => {
    const r = validatePath('src/services/desk/DeskContract.ts');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toBe('src/services/desk/DeskContract.ts');
  });

  it('NEVER silently rewrites a traversal into a valid path', () => {
    const r = validatePath('../../etc/passwd');
    expect(r.ok).toBe(false);
    // The failure must not leak a "cleaned" candidate the caller could probe with.
    expect(JSON.stringify(r)).not.toContain('etc/passwd');
  });
});

describe('validateToken — a literal, never a pattern', () => {
  const patternProbes = [
    'AKIA[A-Z0-9]{16}',
    'sk-.*',
    'secret?',
    'a|b',
    '(foo)',
    'x{1,10}',
    'a+b',
    '^start',
    'end$',
    'back\\slash',
  ];

  for (const probe of patternProbes) {
    it(`rejects pattern metacharacters: ${probe}`, () => {
      expect(validateToken(probe).ok, `${probe} must be refused`).toBe(false);
    });
  }

  it('accepts an ordinary identifier', () => {
    const r = validateToken('backoffSchedule');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toBe('backoffSchedule');
  });

  it('accepts a dotted or dashed literal', () => {
    expect(validateToken('retry.config').ok).toBe(true);
    expect(validateToken('billing-svc').ok).toBe(true);
  });

  it('rejects control, bidi and zero-width characters', () => {
    expect(validateToken('tok\u0000en').ok).toBe(false);
    expect(validateToken('tok\u202Een').ok).toBe(false);
    expect(validateToken('tok\u200Ben').ok).toBe(false);
  });

  it('rejects an over-long token', () => {
    expect(validateToken('a'.repeat(LIMITS.token + 1)).ok).toBe(false);
  });

  it('rejects an empty or whitespace-only token', () => {
    expect(validateToken('').ok).toBe(false);
    expect(validateToken('   ').ok).toBe(false);
  });
});

describe('validateText — prose may wrap, but not escape', () => {
  it('permits newlines, which are legitimate in a question', () => {
    const r = validateText('line one\nline two', LIMITS.question, 'question');
    expect(r.ok).toBe(true);
  });

  it('refuses non-whitespace control characters', () => {
    expect(validateText('bad\u0007bell', LIMITS.question).ok).toBe(false);
    expect(validateText('bad\u0000nul', LIMITS.question).ok).toBe(false);
  });

  it('refuses bidi overrides — a rendered card must read as it resolves', () => {
    expect(validateText('safe\u202Eevil', LIMITS.question).ok).toBe(false);
  });

  it('refuses zero-width characters', () => {
    expect(validateText('he\u200Bllo', LIMITS.question).ok).toBe(false);
  });

  it('trims, and rejects when only whitespace remains', () => {
    const r = validateText('  hello  ', LIMITS.question);
    expect(r.ok && r.value).toBe('hello');
    expect(validateText('   \n  ', LIMITS.question).ok).toBe(false);
  });

  it('enforces the cap', () => {
    expect(validateText('a'.repeat(LIMITS.question + 1), LIMITS.question).ok).toBe(false);
  });
});

describe('identifier validators', () => {
  it('accepts a well-formed id and rejects the rest', () => {
    expect(validateId('01JD8Q2Z6M4N7XPB').ok).toBe(true);
    expect(validateId('has space').ok).toBe(false);
    expect(validateId('has/slash').ok).toBe(false);
    expect(validateId('').ok).toBe(false);
    expect(validateId('a'.repeat(65)).ok).toBe(false);
    expect(validateId(42).ok).toBe(false);
  });

  it('accepts a lowercase alias and rejects display-name shapes', () => {
    expect(validateAlias('alice').ok).toBe(true);
    expect(validateAlias('billing-svc').ok).toBe(true);
    expect(validateAlias('Alice').ok).toBe(false);       // case matters
    expect(validateAlias('-leading').ok).toBe(false);
    expect(validateAlias('alice bob').ok).toBe(false);
    expect(validateAlias('a'.repeat(33)).ok).toBe(false);
  });

  it('validates git object ids by exact width', () => {
    expect(validateSha1('a'.repeat(40)).ok).toBe(true);
    expect(validateSha1('A'.repeat(40)).ok).toBe(false);  // lowercase only
    expect(validateSha1('a'.repeat(39)).ok).toBe(false);
    expect(validateSha256('b'.repeat(64)).ok).toBe(true);
    expect(validateSha256('b'.repeat(40)).ok).toBe(false);
  });
});

describe('validateArray', () => {
  it('validates each item and reports the failing index', () => {
    const r = validateArray(['src/a.ts', '../b.ts'], (x, i) => validatePath(x, `p[${i}]`), 'paths');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('[1]');
  });

  it('enforces the item cap', () => {
    const many = Array.from({ length: LIMITS.arrayItems + 1 }, () => 'src/a.ts');
    expect(validateArray(many, x => validatePath(x), 'paths').ok).toBe(false);
  });

  it('accepts an empty array', () => {
    expect(validateArray([], x => validatePath(x)).ok).toBe(true);
  });

  it('rejects a non-array', () => {
    expect(validateArray('src/a.ts' as unknown, x => validatePath(x)).ok).toBe(false);
  });
});

describe('the verb table', () => {
  it('is closed — exactly the seven verbs', () => {
    expect([...DESK_VERB_NAMES].sort()).toEqual(
      ['assign', 'consult', 'followup', 'handoff', 'locate', 'review', 'status'],
    );
  });

  it('is frozen, so it cannot be extended at runtime', () => {
    expect(Object.isFrozen(DESK_VERBS)).toBe(true);
  });

  it('never marks a model-turn verb auto-answerable', () => {
    // A verb that spends the callee's tokens must involve their human.
    for (const spec of Object.values(DESK_VERBS)) {
      if (spec.costsModelTurn) {
        expect(spec.autoAnswerable, `${spec.verb} costs a turn and must not auto-answer`).toBe(false);
      }
    }
  });

  it('only grants status and locate by default', () => {
    const byDefault = Object.values(DESK_VERBS).filter(s => s.grantable === 'default').map(s => s.verb);
    expect(byDefault.sort()).toEqual(['locate', 'status']);
  });

  it('documents what each verb discloses', () => {
    for (const spec of Object.values(DESK_VERBS)) {
      expect(spec.discloses.length).toBeGreaterThan(10);
    }
  });

  it('narrows an untrusted string with isDeskVerb', () => {
    expect(isDeskVerb('consult')).toBe(true);
    expect(isDeskVerb('exec')).toBe(false);
    expect(isDeskVerb('constructor')).toBe(false); // prototype-pollution probe
    expect(isDeskVerb('__proto__')).toBe(false);
    expect(isDeskVerb(null)).toBe(false);
  });
});

describe('validateCall', () => {
  it('rejects an unknown verb without hinting at what exists', () => {
    const r = validateCall('exec', {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('unknown verb');
  });

  it('status takes no arguments at all', () => {
    expect(validateCall('status', {}).ok).toBe(true);
    expect(validateCall('status', { path: 'src' }).ok).toBe(false);
  });

  it('locate requires a literal token and defaults its kind', () => {
    const r = validateCall('locate', { token: 'backoffSchedule' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.args).toEqual({ token: 'backoffSchedule', kind: 'symbol' });
    expect(validateCall('locate', { token: 'a.*' }).ok).toBe(false);
    expect(validateCall('locate', { token: 'x', kind: 'regex' }).ok).toBe(false);
  });

  it('consult requires a bounded question', () => {
    expect(validateCall('consult', { question: 'how does retry work?' }).ok).toBe(true);
    expect(validateCall('consult', { question: '' }).ok).toBe(false);
    expect(validateCall('consult', {}).ok).toBe(false);
  });

  it('review requires a base sha and clean paths', () => {
    expect(validateCall('review', { baseSha: 'a'.repeat(40), paths: ['src/a.ts'] }).ok).toBe(true);
    expect(validateCall('review', { baseSha: 'nope', paths: [] }).ok).toBe(false);
    expect(validateCall('review', { baseSha: 'a'.repeat(40), paths: ['../x'] }).ok).toBe(false);
  });

  it('assign requires an id, a title and a detail', () => {
    const ok = validateCall('assign', { proposalId: 'p1', title: 'Do it', detail: 'Please do the thing' });
    expect(ok.ok).toBe(true);
    expect(validateCall('assign', { proposalId: 'p 1', title: 't', detail: 'd' }).ok).toBe(false);
  });

  it('followup accepts an optional cursor only', () => {
    expect(validateCall('followup', {}).ok).toBe(true);
    expect(validateCall('followup', { cursor: 'abc123' }).ok).toBe(true);
    expect(validateCall('followup', { cursor: 'has space' }).ok).toBe(false);
  });

  it('rejects non-object args for every verb', () => {
    for (const verb of DESK_VERB_NAMES) {
      expect(validateCall(verb, 'string').ok, `${verb} must reject a string`).toBe(false);
      expect(validateCall(verb, []).ok, `${verb} must reject an array`).toBe(false);
      expect(validateCall(verb, null).ok, `${verb} must reject null`).toBe(false);
    }
  });
});

describe('hasUnsafeChars', () => {
  it('is true for control, bidi and zero-width, false for ordinary text', () => {
    expect(hasUnsafeChars('ordinary text')).toBe(false);
    expect(hasUnsafeChars('with\ttab')).toBe(true);
    expect(hasUnsafeChars('with\nnewline')).toBe(true);
    expect(hasUnsafeChars('with\u202Ebidi')).toBe(true);
    expect(hasUnsafeChars('with\u200Bzw')).toBe(true);
    expect(hasUnsafeChars('émoji ok 🎉')).toBe(false);
  });
});
