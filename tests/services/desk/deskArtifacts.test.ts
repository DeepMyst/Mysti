/**
 * DeskArtifacts tests (Plan 21 Phase 5, invariant I15).
 *
 * The claim under test: work crosses a trust boundary ONLY as an enumerated
 * working-tree file set with zero reachable history, and never as a partial
 * or flagged payload (I21).
 *
 * Written adversarially. Every security branch here has been checked by
 * deleting it, watching this file go red, and restoring it — a test that
 * cannot fail is decoration. Where a guard's absence fails CLOSED (a clamp, a
 * sort) the test still pins it, because "fails closed" is a property that only
 * holds until the next edit.
 */
import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_LIMITS,
  BUNDLE_FIELDS,
  BUNDLE_FILE_FIELDS,
  LIMIT_CEILING,
  buildArtifact,
  bundleDigest,
  verifyBundle,
} from '../../../src/services/desk/DeskArtifacts';
import type { BuildInput, DeskBundle } from '../../../src/services/desk/DeskArtifacts';
import { resolveScope } from '../../../src/services/desk/DeskScope';
import * as crypto from 'crypto';

/**
 * Assemble credential-shaped strings at runtime so this test file itself
 * never contains a scannable token — otherwise the repo's own secret scanners
 * (and this very module, when someone bundles the tests) fire on the fixture.
 */
const j = (...parts: string[]) => parts.join('');

const BASE = 'a'.repeat(40);
const OTHER_BASE = 'b'.repeat(40);
const SCOPE = resolveScope({ ceiling: ['*'], share: { allow: ['src'], version: 'v1' } });
/** The only scope from which a ref may be handed over: the whole workspace. */
const FULL_SCOPE = resolveScope({ ceiling: ['*'], share: { allow: ['*'], version: 'v1' } });
const EMPTY_SCOPE = resolveScope({ ceiling: [], share: { allow: [] } });

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    mode: 'bundle',
    files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
    baseSha: BASE,
    sameTrustDomain: false,
    scope: SCOPE,
    ...over,
  };
}

/** A ref build that is valid in every respect the test is not varying. */
function refInput(over: Partial<BuildInput> = {}): BuildInput {
  return input({
    mode: 'ref',
    ref: 'refs/heads/feat/x',
    sameTrustDomain: true,
    scope: FULL_SCOPE,
    files: [],
    ...over,
  });
}

function builtBundle(over: Partial<BuildInput> = {}): DeskBundle {
  const r = buildArtifact(input(over));
  if (!r.ok) { throw new Error(`expected a bundle, got ${r.error}`); }
  if (r.artifact.mode !== 'bundle') { throw new Error('expected bundle mode'); }
  return r.artifact;
}

/** Deep clone that keeps the bundle a plain JSON object. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Verify against an accept-scope wide enough not to be the thing under test. */
const verifyAny = (b: unknown, opts?: Parameters<typeof verifyBundle>[2]) =>
  verifyBundle(b, FULL_SCOPE, opts);

// ---------------------------------------------------------------------------

describe('trust domain (I15) — a ref never crosses', () => {
  it('refuses mode:"ref" when the peer is in a different trust domain', () => {
    const r = buildArtifact(refInput({ sameTrustDomain: false }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('ref-cross-domain');
  });

  it('produces no artifact at all on a cross-domain ref (not a flagged one)', () => {
    const r = buildArtifact(refInput({ sameTrustDomain: false }));
    expect(r).not.toHaveProperty('artifact');
  });

  it('allows mode:"ref" inside one trust domain when the whole workspace is shared', () => {
    const r = buildArtifact(refInput());
    expect(r.ok).toBe(true);
    expect(r.ok && r.artifact).toEqual({ mode: 'ref', ref: 'refs/heads/feat/x', baseSha: BASE });
  });

  it('fails closed on a truthy-but-not-true sameTrustDomain', () => {
    // A JSON payload or a loosely-typed caller can deliver 1 / "yes" / {}.
    // Only the boolean true may open this door.
    for (const truthy of [1, 'yes', {}, [], 'true']) {
      const r = buildArtifact(refInput({ sameTrustDomain: truthy as unknown as boolean }));
      expect(r.ok, `sameTrustDomain=${JSON.stringify(truthy)} must not pass`).toBe(false);
      expect(r.ok === false && r.code).toBe('ref-cross-domain');
    }
  });

  it('refuses the cross-domain ref before anything else can accept it', () => {
    // Everything about this call is otherwise valid, so the refusal can only
    // come from the trust-domain rule.
    const r = buildArtifact(refInput({ ref: 'refs/heads/main', sameTrustDomain: false }));
    expect(r.ok === false && r.code).toBe('ref-cross-domain');
  });

  it('lets a bundle cross a trust domain', () => {
    expect(buildArtifact(input({ sameTrustDomain: false })).ok).toBe(true);
  });

  it('refuses an unknown mode', () => {
    const r = buildArtifact(input({ mode: 'patch' as unknown as 'bundle' }));
    expect(r.ok === false && r.code).toBe('invalid-mode');
  });
});

describe('a ref may not out-run the share scope', () => {
  // A ref carries the whole repository. This module has no git, so it cannot
  // check what is in the ref — but a workspace that shares nothing, or only
  // `src`, must not be able to emit one regardless of trust domain.

  it('refuses a ref when the share scope is EMPTY, even intra-domain', () => {
    const r = buildArtifact(refInput({ scope: EMPTY_SCOPE }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('ref-out-of-scope');
    expect(r).not.toHaveProperty('artifact');
  });

  it('refuses a ref when the scope is narrower than the whole workspace', () => {
    // SCOPE shares `src`; the ref would hand over everything.
    const r = buildArtifact(refInput({ scope: SCOPE }));
    expect(r.ok === false && r.code).toBe('ref-out-of-scope');
  });

  it('refuses the narrow-scope ref even when the declared file list is in scope', () => {
    // The file list is the sender's unverifiable claim about the ref, so a
    // clean, in-scope list must not buy the ref its way out.
    const r = buildArtifact(refInput({
      scope: SCOPE,
      files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
    }));
    expect(r.ok === false && r.code).toBe('ref-out-of-scope');
  });

  it('still lets a BUNDLE go out under a narrow scope — the escape is real', () => {
    // The refusal above must not read as "narrow scopes cannot hand off work".
    const r = buildArtifact(input({ scope: SCOPE, sameTrustDomain: true }));
    expect(r.ok).toBe(true);
  });

  it('emits a ref that carries no file set at all, as documented', () => {
    const r = buildArtifact(refInput({
      files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
    }));
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.artifact).sort()).toEqual(['baseSha', 'mode', 'ref']);
  });
});

describe('a bundle carries no reachable history', () => {
  const bundle = builtBundle({
    files: [
      { path: 'src/a.ts', content: 'a\n' },
      { path: 'src/b.ts', content: 'b\n' },
    ],
  });

  it('has exactly the declared field set and nothing else', () => {
    expect(Object.keys(bundle).sort()).toEqual([...BUNDLE_FIELDS].sort());
    for (const f of bundle.files) {
      expect(Object.keys(f).sort()).toEqual([...BUNDLE_FILE_FIELDS].sort());
    }
  });

  it('contains no commit-graph-shaped key anywhere in the object', () => {
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
          keys.push(k);
          walk(sub);
        }
      }
    };
    walk(bundle);
    const historyish = keys.filter(k =>
      /^(parent|parents|commit|commits|history|ancestors|packfile|pack|objects|refs?|head|headSha|revList|shallow|graft)$/i.test(k));
    expect(historyish).toEqual([]);
  });

  it('mentions no git ref, remote or object id in any value', () => {
    const text = JSON.stringify(bundle);
    expect(text).not.toMatch(/refs\//);
    expect(text).not.toMatch(/\.git\b/);
  });

  it('verifyBundle refuses a bundle carrying parent commits', () => {
    const smuggled = { ...clone(bundle), parents: ['b'.repeat(40)] };
    const r = verifyAny(smuggled);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/^unknown-field: "parents" .*reachable history/);
  });

  it('verifyBundle refuses commit metadata smuggled onto a FILE entry', () => {
    const smuggled = clone(bundle);
    (smuggled.files[0] as unknown as Record<string, unknown>).commit = 'c'.repeat(40);
    const r = verifyAny(smuggled);
    expect(r.ok === false && r.error).toMatch(/^unknown-field: files\[0\]\."commit"/);
  });

  it('verifyBundle refuses an unrecognised field even when it looks harmless', () => {
    const r = verifyAny({ ...clone(bundle), note: 'just a label' });
    expect(r.ok === false && r.error).toMatch(/^unknown-field: "note"/);
  });

  it('verifyBundle refuses a NON-ENUMERABLE smuggled field', () => {
    // Object.keys sees only own enumerable string keys, so this is the shape
    // that walks past a keys-based allowlist. A JSON payload cannot carry one
    // — an in-process caller can.
    const smuggled = clone(bundle) as unknown as Record<string, unknown>;
    Object.defineProperty(smuggled, 'parents', {
      value: ['b'.repeat(40)], enumerable: false, configurable: true, writable: true,
    });
    expect(Object.keys(smuggled)).not.toContain('parents');
    const r = verifyAny(smuggled);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('unknown-field');
  });

  it('verifyBundle refuses a SYMBOL-keyed smuggled field', () => {
    const smuggled = clone(bundle) as unknown as Record<string | symbol, unknown>;
    smuggled[Symbol.for('parents')] = ['b'.repeat(40)];
    const r = verifyAny(smuggled);
    expect(r.ok === false && r.code).toBe('unknown-field');
  });

  it('verifyBundle refuses a non-enumerable field on a FILE entry', () => {
    const smuggled = clone(bundle);
    Object.defineProperty(smuggled.files[0], 'commit', {
      value: 'c'.repeat(40), enumerable: false, configurable: true, writable: true,
    });
    const r = verifyAny(smuggled);
    expect(r.ok === false && r.code).toBe('unknown-field');
  });

  it('verifyBundle refuses a ref masquerading as a verifiable artifact', () => {
    const r = verifyAny({ mode: 'ref', ref: 'refs/heads/x', baseSha: BASE });
    expect(r.ok === false && r.code).toBe('invalid-mode');
  });
});

describe('egress screening blocks the whole build (I5 + I21)', () => {
  const AWS = j('AKIA', 'IOSFODNN7EXAMPLE');
  const GH = j('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');

  it('blocks the build when any single file carries a credential', () => {
    const r = buildArtifact(input({
      files: [
        { path: 'src/a.ts', content: 'export const a = 1;\n' },
        { path: 'src/cfg.ts', content: `const id = "${AWS}";\n` },
        { path: 'src/c.ts', content: 'export const c = 3;\n' },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('secret-detected');
    expect(r.ok === false && r.blockedPaths).toEqual(['src/cfg.ts']);
  });

  it('never returns a partial artifact with the clean files', () => {
    const r = buildArtifact(input({
      files: [
        { path: 'src/a.ts', content: 'export const a = 1;\n' },
        { path: 'src/cfg.ts', content: `const id = "${AWS}";\n` },
      ],
    }));
    expect(r).not.toHaveProperty('artifact');
  });

  it('lists EVERY offending file, so the fix is one round trip', () => {
    const r = buildArtifact(input({
      files: [
        { path: 'src/one.ts', content: `x = "${AWS}"\n` },
        { path: 'src/two.ts', content: `y = "${GH}"\n` },
        { path: 'src/ok.ts', content: 'export const ok = true;\n' },
      ],
    }));
    expect(r.ok === false && r.blockedPaths).toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('blocks a PEM private key block', () => {
    const pem = j('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----\nMIIEow==\n');
    const r = buildArtifact(input({ files: [{ path: 'src/key.ts', content: pem }] }));
    expect(r.ok === false && r.blockedPaths).toEqual(['src/key.ts']);
  });

  it('does not echo the credential it found', () => {
    const r = buildArtifact(input({ files: [{ path: 'src/cfg.ts', content: `k = "${AWS}"\n` }] }));
    expect(r.ok === false && r.error).not.toContain(AWS);
    expect(JSON.stringify(r)).not.toContain(AWS);
  });

  it('scans the PATH as well as the content — the manifest crosses too', () => {
    // A checked-in key file named after its own key. The path is part of the
    // artifact, so a content-only scan is narrower than the attack surface.
    const r = buildArtifact(input({
      files: [{ path: `src/${AWS}.ts`, content: 'export const ok = true;\n' }],
    }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('secret-detected');
  });

  it('withholds the offending PATH instead of echoing it back', () => {
    // When the credential IS the path, naming the path in the refusal would
    // make the refusal the leak.
    const r = buildArtifact(input({
      files: [{ path: `src/${AWS}.ts`, content: 'export const ok = true;\n' }],
    }));
    expect(JSON.stringify(r)).not.toContain(AWS);
    expect(r.ok === false && r.blockedPaths).toEqual(['files[0].path (withheld)']);
  });

  it('withholds the path even when that file ALSO has a credential inside', () => {
    const r = buildArtifact(input({
      files: [{ path: `src/${AWS}.ts`, content: `k = "${GH}"\n` }],
    }));
    expect(JSON.stringify(r)).not.toContain(AWS);
    expect(JSON.stringify(r)).not.toContain(GH);
  });

  it('scans the REF NAME, and never echoes it', () => {
    // A branch named after a token walks straight through a content-only scan.
    const r = buildArtifact(refInput({ ref: `refs/heads/${GH}` }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('secret-detected');
    expect(JSON.stringify(r)).not.toContain(GH);
  });

  it('does NOT block on an entropy-only token (advisory, per EgressScanner)', () => {
    // A hard block on raw entropy fires on minified bundles and lockfile
    // hashes often enough that the scanner gets switched off, which protects
    // nothing. This test pins that deliberate choice.
    const r = buildArtifact(input({
      files: [{ path: 'src/hash.ts', content: 'export const H = "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRg";\n' }],
    }));
    expect(r.ok).toBe(true);
  });

  it('does not fire on ordinary source paths', () => {
    // The path scan must not cost a legitimate build. If this ever goes red,
    // the scanner — not this test — is what to change.
    const r = buildArtifact(input({
      files: [
        { path: 'src/managers/SecretRotationManager.ts', content: 'export const a = 1;\n' },
        { path: 'src/api-key-docs/README.md', content: '# notes\n' },
      ],
    }));
    expect(r.ok).toBe(true);
  });
});

describe('the scan over a ref build covers the CLAIM, not the ref', () => {
  const AWS = j('AKIA', 'IOSFODNN7EXAMPLE');

  it('blocks on a credential in the declared file list, intra-domain', () => {
    // What this proves: the caller's list is scanned in ref mode. What it does
    // NOT prove — and cannot — is that the ref was scanned. See below.
    const r = buildArtifact(refInput({
      files: [{ path: 'src/cfg.ts', content: `k = "${AWS}"\n` }],
    }));
    expect(r.ok === false && r.code).toBe('secret-detected');
  });

  it('emits a ref with an EMPTY declared list, so the scan covered nothing', () => {
    // Pinning the honest shape of the guarantee: with files: [] there is
    // nothing to scan and the ref still goes out. The header comment says so
    // and {@link DeskRef} says so; this test stops that admission from
    // silently becoming false in either direction.
    const r = buildArtifact(refInput({ files: [] }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.artifact).toEqual({ mode: 'ref', ref: 'refs/heads/feat/x', baseSha: BASE });
  });
});

describe('paths are validated and scope-bounded', () => {
  it.each([
    ['../etc/passwd', 'traversal'],
    ['/etc/passwd', 'absolute'],
    ['src\\a.ts', 'backslash'],
    ['C:/src/a.ts', 'drive letter'],
    ['src/./a.ts', 'dot segment'],
    ['src//a.ts', 'empty segment'],
    ['', 'empty'],
  ])('refuses %s (%s)', (p) => {
    const r = buildArtifact(input({ files: [{ path: p, content: 'x' }] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('invalid-path');
  });

  it('refuses a path carrying a bidi override', () => {
    const r = buildArtifact(input({
      files: [{ path: 'src/a\u202Egnp.ts', content: 'x' }],
    }));
    expect(r.ok === false && r.code).toBe('invalid-path');
  });

  it('refuses a file outside the shared scope', () => {
    const r = buildArtifact(input({ files: [{ path: 'secrets/prod.ts', content: 'x' }] }));
    expect(r.ok === false && r.code).toBe('out-of-scope');
  });

  it('refuses a BUNDLE when nothing is shared', () => {
    const r = buildArtifact(input({ scope: EMPTY_SCOPE }));
    expect(r.ok === false && r.code).toBe('out-of-scope');
  });

  it('refuses a REF when nothing is shared — "nothing" means nothing', () => {
    // The bundle case above used to be the whole of this claim, and a ref with
    // files: [] walked out of an empty scope with ok:true.
    const r = buildArtifact(refInput({ scope: EMPTY_SCOPE }));
    expect(r.ok === false && r.code).toBe('ref-out-of-scope');
  });

  it('refuses a scope object with no allow list', () => {
    const r = buildArtifact(input({ scope: {} as never }));
    expect(r.ok === false && r.code).toBe('invalid-scope');
  });

  it('refuses a duplicate path rather than picking a winner', () => {
    const r = buildArtifact(input({
      files: [
        { path: 'src/a.ts', content: 'first' },
        { path: 'src/a.ts', content: 'second' },
      ],
    }));
    expect(r.ok === false && r.code).toBe('duplicate-path');
  });

  it('refuses content carrying a NUL byte', () => {
    const r = buildArtifact(input({ files: [{ path: 'src/bin.ts', content: 'a\u0000b' }] }));
    expect(r.ok === false && r.code).toBe('binary-content');
  });

  it('refuses a non-string content', () => {
    const r = buildArtifact(input({
      files: [{ path: 'src/a.ts', content: 42 as unknown as string }],
    }));
    expect(r.ok === false && r.code).toBe('invalid-file');
  });

  it.each([
    ['null', null],
    ['a bare string', 'src/a.ts'],
    ['an array', ['src/a.ts', 'content']],
    ['a number', 7],
  ])('refuses a file entry that is %s rather than throwing', (_label, entry) => {
    const r = buildArtifact(input({
      files: [entry as unknown as { path: string; content: string }],
    }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('invalid-file');
  });

  it('refuses an empty bundle', () => {
    const r = buildArtifact(input({ files: [] }));
    expect(r.ok === false && r.code).toBe('empty-bundle');
  });

  it.each([
    ['b'.repeat(39)],
    ['B'.repeat(40)],
    [''],
  ])('refuses an invalid baseSha (%s)', (s) => {
    const r = buildArtifact(input({ baseSha: s }));
    expect(r.ok === false && r.code).toBe('invalid-base-sha');
  });
});

describe('ref names', () => {
  const ref = (r: unknown) => buildArtifact(refInput({ ref: r as string }));

  it.each([
    ['feat/x'],                       // not under refs/
    ['HEAD'],
    ['--upload-pack=/bin/sh'],
    ['refs/heads/../../evil'],
    ['refs/heads/x..y'],
    ['refs/heads//x'],
    ['refs/heads/x/'],
    ['refs/heads/x.lock'],
    ['refs/heads/x y'],
    ['refs/heads/x^'],
    ['refs/heads/x~1'],
    ['refs/heads/x:y'],
    ['refs/heads/-x'],
    ['refs/heads/x?'],
    ['refs/heads/x*'],
    ['refs/heads/x.'],                // git check-ref-format refuses a trailing dot
    ['refs/heads/x./y'],
    [''],
  ])('refuses ref %s', (r) => {
    expect(ref(r).ok, `ref ${r} must be refused`).toBe(false);
  });

  it('refuses an over-long ref by LENGTH, not as a side effect of the charset', () => {
    // The '' case above is caught by the refs/ prefix rule, so without this
    // the length bound has no covering test at all. A ref name reaches an
    // argv and a log line, so its bound is its own guard.
    const long = `refs/heads/${'a'.repeat(300)}`;
    const r = ref(long);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/ref length/);
  });

  it('accepts a ref exactly at the length bound', () => {
    // The clamp must not be one character too tight either.
    const atBound = `refs/heads/${'a'.repeat(255 - 'refs/heads/'.length)}`;
    expect(atBound.length).toBe(255);
    expect(ref(atBound).ok).toBe(true);
  });

  it('refuses a missing ref in ref mode', () => {
    expect(ref(undefined).ok).toBe(false);
    expect(ref(null).ok).toBe(false);
    expect(ref(123).ok).toBe(false);
  });

  it('accepts a normal branch ref', () => {
    expect(ref('refs/heads/feat/desk-artifacts').ok).toBe(true);
  });

  it('accepts a ref with an interior dot', () => {
    // The trailing-dot rule must not cost `refs/tags/v1.2.3`.
    expect(ref('refs/tags/v1.2.3').ok).toBe(true);
  });
});

describe('limits fail closed and refuse rather than trim (I21)', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, content: `export const x${i} = ${i};\n` }));

  it('refuses a file set over the cap instead of taking the first N', () => {
    const r = buildArtifact(input({ files: many(ARTIFACT_LIMITS.maxFiles + 1) }));
    expect(r.ok === false && r.code).toBe('too-many-files');
    expect(r).not.toHaveProperty('artifact');
  });

  it('still enforces the default when an option is explicitly undefined', () => {
    // `cfg.get<number>('unset')` returns undefined, and a `{...DEFAULTS,
    // ...opts}` spread would let that erase the default. This is the exact
    // bug that disabled a rate limiter earlier in this plan.
    const r = buildArtifact(input({ files: many(ARTIFACT_LIMITS.maxFiles + 1) }), { maxFiles: undefined });
    expect(r.ok === false && r.code).toBe('too-many-files');
  });

  it('still enforces the default when an option is NaN', () => {
    // NaN makes every comparison false, so a limit that reaches a `>` stops
    // limiting silently.
    const r = buildArtifact(input({ files: many(ARTIFACT_LIMITS.maxFiles + 1) }), { maxFiles: NaN });
    expect(r.ok === false && r.code).toBe('too-many-files');
  });

  it('still enforces the default when an option is Infinity', () => {
    const big = 'x'.repeat(ARTIFACT_LIMITS.maxFileBytes + 1);
    const r = buildArtifact(input({ files: [{ path: 'src/big.ts', content: big }] }), {
      maxFileBytes: Infinity,
    });
    expect(r.ok === false && r.code).toBe('file-too-large');
  });

  it('still enforces the default when an option is not a number at all', () => {
    const r = buildArtifact(input({ files: many(ARTIFACT_LIMITS.maxFiles + 1) }), {
      maxFiles: '10000' as unknown as number,
    });
    expect(r.ok === false && r.code).toBe('too-many-files');
  });

  it('clamps a zero or negative cap to 1 — one file passes, two do not', () => {
    // Both halves are load-bearing. Only the ACCEPT half distinguishes the
    // floor from its absence: with `if (n < 1) return 1` deleted, maxFiles: 0
    // refuses even a single file and the refuse-half alone still passes.
    expect(buildArtifact(input({ files: many(1) }), { maxFiles: 0 }).ok).toBe(true);
    expect(buildArtifact(input({ files: many(1) }), { maxFiles: -5 }).ok).toBe(true);
    const two = buildArtifact(input({ files: many(2) }), { maxFiles: 0 });
    expect(two.ok === false && two.code).toBe('too-many-files');
  });

  it('caps an over-large option at the hard ceiling instead of honouring it', () => {
    // The sole enforcement of "an option cannot become a bypass". Without the
    // ceiling clamp these three calls would disable all three caps.
    const r = buildArtifact(input({ files: many(LIMIT_CEILING.maxFiles + 1) }), {
      maxFiles: 1e9,
      maxFileBytes: 1e12,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe(`too-many-files: ${LIMIT_CEILING.maxFiles + 1} exceeds ${LIMIT_CEILING.maxFiles}`);
  });

  it('caps the per-file byte option at the ceiling', () => {
    const over = 'x'.repeat(LIMIT_CEILING.maxFileBytes + 1);
    const r = buildArtifact(input({ files: [{ path: 'src/big.ts', content: over }] }), {
      maxFileBytes: 1e12, maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(new RegExp(`max ${LIMIT_CEILING.maxFileBytes}\\)$`));
  });

  it('caps the total-byte option at the ceiling', () => {
    // Five files that each sit exactly ON the per-file ceiling: individually
    // fine, jointly over the total ceiling. One string, five paths.
    const atCeiling = 'x'.repeat(LIMIT_CEILING.maxFileBytes);
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts`, content: atCeiling }));
    const r = buildArtifact(input({ files }), {
      maxFileBytes: 1e12, maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe(`bundle-too-large: exceeds ${LIMIT_CEILING.maxTotalBytes} bytes`);
  });

  it('caps the inbound ceilings too, so a receiver option is no bypass either', () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
      path: `src/f${i}.ts`, content: `${i}`, sha256: sha(`${i}`),
    }));
    const bundle = {
      mode: 'bundle', files, manifest: files.map(f => f.path),
      sha256: bundleDigest(files, BASE), baseSha: BASE,
    };
    // Ridiculous options must resolve to the ceiling, not to themselves…
    expect(verifyAny(bundle, {
      maxFiles: 1e9, maxFileBytes: 1e12, maxTotalBytes: Number.MAX_SAFE_INTEGER,
    }).ok).toBe(true);
    // …and the ceiling numbers are the ones this module claims.
    expect(LIMIT_CEILING).toEqual({
      maxFiles: 2_000,
      maxFileBytes: 16 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
    });
  });

  it('refuses an oversized single file', () => {
    const r = buildArtifact(input({ files: [{ path: 'src/big.ts', content: 'x'.repeat(2001) }] }), {
      maxFileBytes: 2000,
    });
    expect(r.ok === false && r.code).toBe('file-too-large');
  });

  it('refuses when the set exceeds the total byte budget', () => {
    const r = buildArtifact(input({
      files: [
        { path: 'src/a.ts', content: 'x'.repeat(900) },
        { path: 'src/b.ts', content: 'y'.repeat(900) },
      ],
    }), { maxTotalBytes: 1000 });
    expect(r.ok === false && r.code).toBe('bundle-too-large');
  });

  it('measures UTF-8 BYTES, not code units', () => {
    // Four bytes per emoji: a length check would pass this at 400 chars.
    const r = buildArtifact(input({ files: [{ path: 'src/e.ts', content: '\u{1F680}'.repeat(200) }] }), {
      maxFileBytes: 500,
    });
    expect(r.ok === false && r.code).toBe('file-too-large');
  });

  it('refuses a non-array files field', () => {
    const r = buildArtifact(input({ files: 'src/a.ts' as unknown as [] }));
    expect(r.ok === false && r.code).toBe('invalid-input');
  });

  it('refuses a non-object input', () => {
    expect(buildArtifact(null as unknown as BuildInput).ok).toBe(false);
  });
});

describe('digests and manifest are computed over the real bytes', () => {
  it('hashes each file over its own content', () => {
    const b = builtBundle({ files: [{ path: 'src/a.ts', content: 'hello\n' }] });
    expect(b.files[0].sha256).toBe(sha('hello\n'));
  });

  it('declares a manifest that is exactly the sorted payload paths', () => {
    const b = builtBundle({
      files: [
        { path: 'src/z.ts', content: 'z' },
        { path: 'src/a.ts', content: 'a' },
      ],
    });
    expect(b.manifest).toEqual(['src/a.ts', 'src/z.ts']);
    expect(b.files.map(f => f.path)).toEqual(b.manifest);
  });

  it('packs byte-identically regardless of input order', () => {
    const a = builtBundle({
      files: [
        { path: 'src/a.ts', content: 'a' },
        { path: 'src/b.ts', content: 'b' },
      ],
    });
    const b = builtBundle({
      files: [
        { path: 'src/b.ts', content: 'b' },
        { path: 'src/a.ts', content: 'a' },
      ],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('changes the bundle digest when any byte changes', () => {
    const a = builtBundle({ files: [{ path: 'src/a.ts', content: 'a' }] });
    const b = builtBundle({ files: [{ path: 'src/a.ts', content: 'A' }] });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('changes the bundle digest when a path changes but content does not', () => {
    const a = builtBundle({ files: [{ path: 'src/a.ts', content: 'same' }] });
    const b = builtBundle({ files: [{ path: 'src/b.ts', content: 'same' }] });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('binds the file set, so swapping two files\u2019 contents is detected', () => {
    const a = builtBundle({
      files: [
        { path: 'src/a.ts', content: 'one' },
        { path: 'src/b.ts', content: 'two' },
      ],
    });
    const swapped = builtBundle({
      files: [
        { path: 'src/a.ts', content: 'two' },
        { path: 'src/b.ts', content: 'one' },
      ],
    });
    expect(a.sha256).not.toBe(swapped.sha256);
  });

  it('binds the baseSha, so the same files on another commit hash differently', () => {
    const a = builtBundle({ files: [{ path: 'src/a.ts', content: 'a' }], baseSha: BASE });
    const b = builtBundle({ files: [{ path: 'src/a.ts', content: 'a' }], baseSha: OTHER_BASE });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('bundleDigest is the digest the builder used', () => {
    const b = builtBundle({ files: [{ path: 'src/a.ts', content: 'a' }] });
    expect(bundleDigest(b.files, b.baseSha)).toBe(b.sha256);
  });

  it('bundleDigest is order-independent', () => {
    // This is what makes a reordered-in-transit bundle the same artifact. It
    // is also what verifyBundle relies on when it digests the received order.
    const b = builtBundle({
      files: [
        { path: 'src/a.ts', content: 'a' },
        { path: 'src/b.ts', content: 'b' },
        { path: 'src/c.ts', content: 'c' },
      ],
    });
    expect(bundleDigest([...b.files].reverse(), b.baseSha)).toBe(b.sha256);
  });

  it('bundleDigest refuses a baseSha it cannot canonicalise', () => {
    // A newline in baseSha could otherwise impersonate a file line.
    const b = builtBundle({ files: [{ path: 'src/a.ts', content: 'a' }] });
    expect(() => bundleDigest(b.files, 'nope')).toThrow(TypeError);
    expect(() => bundleDigest(b.files, `${BASE}\nx`)).toThrow(TypeError);
  });
});

describe('verifyBundle recomputes and refuses on mismatch (I21)', () => {
  const good = builtBundle({
    files: [
      { path: 'src/a.ts', content: 'export const a = 1;\n' },
      { path: 'src/b.ts', content: 'export const b = 2;\n' },
    ],
  });

  it('accepts a bundle it just built', () => {
    const r = verifyAny(clone(good));
    expect(r.ok).toBe(true);
    expect(r.ok && r.bundle.sha256).toBe(good.sha256);
  });

  it('accepts a bundle whose file array was REORDERED in transit', () => {
    // Order is not part of the artifact — bundleDigest sorts internally — so
    // a reordered payload must still verify, and the returned bundle must be
    // the canonical sorted one.
    const shuffled = clone(good);
    shuffled.files.reverse();
    shuffled.manifest.reverse();
    const r = verifyAny(shuffled);
    expect(r.ok).toBe(true);
    expect(r.ok && r.bundle.sha256).toBe(good.sha256);
    expect(r.ok && r.bundle.manifest).toEqual(good.manifest);
  });

  it('refuses tampered content whose declared file digest was left alone', () => {
    const bad = clone(good);
    bad.files[0].content = 'export const a = 999;\n';
    const r = verifyAny(bad);
    expect(r.ok === false && r.error).toMatch(/^file-digest-mismatch: src\/a\.ts/);
  });

  it('refuses tampered content whose file digest was recomputed to match', () => {
    // The attacker who can edit content can also edit the per-file hash. Only
    // the bundle-level digest catches this.
    const bad = clone(good);
    bad.files[0].content = 'export const a = 999;\n';
    bad.files[0].sha256 = sha(bad.files[0].content);
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('bundle-digest-mismatch');
  });

  it('refuses a baseSha rewritten in transit', () => {
    // baseSha is the commit the receiver applies this set ONTO. Re-targeting
    // it silently applies four files written against commit A onto commit B,
    // so it has to be inside the digest — every per-file hash still matches.
    const bad = clone(good);
    bad.baseSha = OTHER_BASE;
    const r = verifyAny(bad);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('bundle-digest-mismatch');
  });

  it('does not re-emit an attacker-chosen baseSha', () => {
    const bad = clone(good);
    bad.baseSha = OTHER_BASE;
    const r = verifyAny(bad);
    expect(r).not.toHaveProperty('bundle');
  });

  it('refuses a file dropped in transit even when the manifest still declares it', () => {
    const bad = clone(good);
    bad.files.splice(1, 1);
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('manifest-mismatch');
  });

  it('refuses a manifest that declares a path the payload does not carry', () => {
    const bad = clone(good);
    bad.manifest = ['src/a.ts', 'src/other.ts'];
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('manifest-mismatch');
  });

  it('refuses a manifest padded to the right length with a duplicate', () => {
    const bad = clone(good);
    bad.files.splice(1, 1);
    bad.manifest = ['src/a.ts', 'src/a.ts'];
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('manifest-mismatch');
  });

  it('refuses an oversized manifest before walking it', () => {
    // A 400k-entry manifest against a two-file payload is refused by an O(1)
    // comparison, not after a full copy. b.manifest.length is capped by
    // nothing else in this function.
    const bad = clone(good) as unknown as { manifest: string[] };
    bad.manifest = Array.from({ length: 400_000 }, (_, i) => `src/f${i}.ts`);
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('manifest-mismatch');
  });

  it('refuses the oversized manifest BEFORE validating the file entries', () => {
    // The ordering is the point, and this is what makes it observable: with
    // the early length comparison removed, the per-file walk runs first and
    // this returns invalid-file instead.
    const bad = clone(good) as unknown as { manifest: string[]; files: unknown[] };
    bad.manifest = Array.from({ length: 400_000 }, (_, i) => `src/f${i}.ts`);
    bad.files = [null];
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('manifest-mismatch');
  });

  it('refuses a non-string manifest entry rather than coercing it', () => {
    const bad = clone(good);
    (bad.manifest as unknown[])[1] = { toString: () => 'src/b.ts' };
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('invalid-manifest');
  });

  it('refuses a bundle digest that does not match the recomputed one', () => {
    const bad = clone(good);
    bad.sha256 = sha('something else');
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('bundle-digest-mismatch');
  });

  it('refuses a malformed bundle digest', () => {
    const bad = clone(good);
    bad.sha256 = 'not-a-digest';
    expect(verifyAny(bad).ok).toBe(false);
  });

  it('refuses an uppercase digest, so one artifact has one spelling', () => {
    const bad = clone(good);
    bad.sha256 = good.sha256.toUpperCase();
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('invalid-digest');
  });

  it('refuses duplicate paths in the payload', () => {
    const bad = clone(good);
    bad.files[1] = { ...bad.files[0] };
    bad.manifest = ['src/a.ts', 'src/a.ts'];
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('duplicate-path');
  });

  it('refuses a traversal path arriving from a peer', () => {
    const bad = clone(good);
    bad.files[0].path = '../../.ssh/authorized_keys';
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('invalid-path');
  });

  it('refuses an invalid baseSha', () => {
    const bad = clone(good);
    bad.baseSha = 'nope';
    expect(verifyAny(bad).ok).toBe(false);
  });

  it('refuses an empty file set', () => {
    const r = verifyAny({ mode: 'bundle', files: [], manifest: [], sha256: sha(''), baseSha: BASE });
    expect(r.ok === false && r.code).toBe('empty-bundle');
  });

  it('enforces the file-count cap on inbound bundles too', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `src/f${i}.ts`, content: `${i}`, sha256: sha(`${i}`),
    }));
    const r = verifyAny({
      mode: 'bundle',
      files,
      manifest: files.map(f => f.path),
      sha256: bundleDigest(files, BASE),
      baseSha: BASE,
    }, { maxFiles: 2 });
    expect(r.ok === false && r.code).toBe('too-many-files');
  });

  it('enforces the per-file byte cap on inbound bundles too', () => {
    const files = [{ path: 'src/big.ts', content: 'x'.repeat(4000), sha256: sha('x'.repeat(4000)) }];
    const r = verifyAny({
      mode: 'bundle', files, manifest: ['src/big.ts'], sha256: bundleDigest(files, BASE), baseSha: BASE,
    }, { maxFileBytes: 100 });
    expect(r.ok === false && r.code).toBe('file-too-large');
  });

  it('enforces the TOTAL byte cap on inbound bundles too', () => {
    // Each file passes maxFileBytes on its own; together they must not. This
    // is the memory-exhaustion guard on the one path that consumes untrusted
    // peer data, and it had no test at all.
    const files = [
      { path: 'src/a.ts', content: 'x'.repeat(900), sha256: sha('x'.repeat(900)) },
      { path: 'src/b.ts', content: 'y'.repeat(900), sha256: sha('y'.repeat(900)) },
    ];
    const r = verifyAny({
      mode: 'bundle', files, manifest: files.map(f => f.path),
      sha256: bundleDigest(files, BASE), baseSha: BASE,
    }, { maxFileBytes: 1000, maxTotalBytes: 1000 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/^bundle-too-large/);
  });

  it.each([[null], [undefined], ['a string'], [42], [[]], [true]])(
    'refuses a non-object bundle (%s)', (v) => {
      expect(verifyAny(v).ok).toBe(false);
    });

  it('refuses a non-array files field', () => {
    const r = verifyAny({ mode: 'bundle', files: 'x', manifest: [], sha256: sha(''), baseSha: BASE });
    expect(r.ok === false && r.code).toBe('invalid-files');
  });

  it('refuses a non-array manifest', () => {
    const bad = clone(good) as unknown as Record<string, unknown>;
    bad.manifest = 'src/a.ts';
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('invalid-manifest');
  });

  it('refuses a file entry that is an array (Object.keys would look empty-ish)', () => {
    const bad = clone(good) as unknown as { files: unknown[] };
    bad.files[0] = ['src/a.ts', 'content'];
    const r = verifyAny(bad);
    expect(r.ok === false && r.code).toBe('invalid-file');
  });

  it.each([
    ['a number', 42],
    ['an array', ['x']],
    ['an object with toString', { toString: () => 'x' }],
    ['null', null],
  ])('refuses inbound content that is %s rather than throwing', (_label, content) => {
    // The receive path is the side that handles attacker-chosen types: with
    // the typeof guard gone this is a TypeError thrown out of verifyBundle
    // (`(42).indexOf`), not a refusal.
    const bad = clone(good) as unknown as { files: Array<Record<string, unknown>> };
    bad.files[0].content = content;
    const run = () => verifyAny(bad);
    expect(run).not.toThrow();
    const r = run();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('invalid-file');
  });

  it('never throws on a malformed payload, whatever shape it is', () => {
    const shapes: unknown[] = [
      { mode: 'bundle' },
      { mode: 'bundle', files: [{}], manifest: [null], sha256: sha(''), baseSha: BASE },
      { mode: 'bundle', files: [{ path: 1, content: 2, sha256: 3 }], manifest: [4], sha256: 5, baseSha: 6 },
      { mode: 'bundle', files: [null], manifest: ['x'], sha256: sha(''), baseSha: BASE },
      { mode: 'bundle', files: [{ path: 'src/a.ts', content: 'a' }], manifest: ['src/a.ts'], sha256: sha(''), baseSha: BASE },
      { mode: 'bundle', files: [{ path: 'src/a.ts', content: 'a', sha256: sha('a') }], manifest: ['src/a.ts'], sha256: sha('a'), baseSha: BASE },
      Object.create(null),
      new Date(),
      { mode: 'bundle', files: { length: 2 }, manifest: [], sha256: sha(''), baseSha: BASE },
    ];
    for (const s of shapes) {
      expect(() => verifyAny(s), `shape ${JSON.stringify(s)} must not throw`).not.toThrow();
      expect(verifyAny(s).ok, `shape ${JSON.stringify(s)} must not verify`).toBe(false);
    }
  });

  it('refuses a NUL smuggled into inbound content', () => {
    const files = [{ path: 'src/a.ts', content: 'a\u0000b', sha256: sha('a\u0000b') }];
    const r = verifyAny({
      mode: 'bundle', files, manifest: ['src/a.ts'], sha256: bundleDigest(files, BASE), baseSha: BASE,
    });
    expect(r.ok === false && r.code).toBe('binary-content');
  });

  it('returns a rebuilt bundle, not the object it was handed', () => {
    // Downstream code must never be able to touch a field this function did
    // not validate, so the accepted value is reconstructed from checked parts.
    const incoming = clone(good);
    const r = verifyAny(incoming);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bundle).not.toBe(incoming);
      expect(r.bundle.files[0]).not.toBe(incoming.files[0]);
      expect(Object.keys(r.bundle).sort()).toEqual([...BUNDLE_FIELDS].sort());
    }
  });

  it('round-trips through JSON, which is how it actually crosses the wire', () => {
    const r = verifyAny(JSON.parse(JSON.stringify(good)));
    expect(r.ok).toBe(true);
    expect(r.ok && r.bundle.manifest).toEqual(good.manifest);
  });
});

describe('verifyBundle applies the receiver scope, not just integrity', () => {
  /** A structurally perfect bundle naming whatever paths the test wants. */
  const inbound = (paths: string[]): DeskBundle => {
    const files = paths
      .map(p => ({ path: p, content: `content of ${p}\n`, sha256: sha(`content of ${p}\n`) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      mode: 'bundle',
      files,
      manifest: files.map(f => f.path),
      sha256: bundleDigest(files, BASE),
      baseSha: BASE,
    };
  };

  const ACCEPT_SRC = resolveScope({ ceiling: ['*'], share: { allow: ['src'], version: 'v1' } });

  it('refuses an inbound bundle naming the INSTRUCTION SURFACE', () => {
    // Plan 20 Phase 2 spent a phase protecting `.mysti/agents/**`. A peer
    // bundle naming it used to pass a green integrity check.
    const r = verifyBundle(inbound(['.mysti/agents/skills/evil/SKILL.md']), ACCEPT_SRC);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('out-of-scope');
  });

  it('refuses an inbound bundle naming the editor config', () => {
    const r = verifyBundle(inbound(['.vscode/settings.json']), ACCEPT_SRC);
    expect(r.ok === false && r.code).toBe('out-of-scope');
  });

  it('refuses the WHOLE bundle when one path is out of scope, never the rest', () => {
    // I21: no partial apply, no quiet drop.
    const r = verifyBundle(inbound(['src/ok.ts', '.vscode/settings.json']), ACCEPT_SRC);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('bundle');
  });

  it('accepts an inbound bundle entirely inside the accept scope', () => {
    const r = verifyBundle(inbound(['src/a.ts', 'src/b.ts']), ACCEPT_SRC);
    expect(r.ok).toBe(true);
  });

  it('refuses everything when the receiver accepts nothing', () => {
    const r = verifyBundle(inbound(['src/a.ts']), EMPTY_SCOPE);
    expect(r.ok === false && r.code).toBe('out-of-scope');
  });

  it('accepts anything only when the receiver says so explicitly with ["*"]', () => {
    const r = verifyBundle(inbound(['.mysti/agents/skills/evil/SKILL.md']), FULL_SCOPE);
    expect(r.ok).toBe(true);
  });

  it('refuses a malformed scope rather than treating it as open', () => {
    for (const bad of [undefined, null, {}, { allow: 'src' }, 'src']) {
      const r = verifyBundle(inbound(['src/a.ts']), bad as never);
      expect(r.ok, `scope ${JSON.stringify(bad)} must not verify`).toBe(false);
      expect(r.ok === false && r.code).toBe('invalid-scope');
    }
  });
});

describe('failure detail stays local; the code is the wire-safe part', () => {
  const AWS = j('AKIA', 'IOSFODNN7EXAMPLE');

  it('carries a coarse code alongside the operator-facing error', () => {
    const r = buildArtifact(input({ files: [{ path: 'secrets/prod.ts', content: 'x' }] }));
    expect(r.ok).toBe(false);
    if (r.ok) { return; }
    expect(r.code).toBe('out-of-scope');
    // The detail names a path the peer was explicitly denied — that is what
    // makes it local-only, and why the code exists as a separate field.
    expect(r.error).toContain('secrets/prod.ts');
    expect(r.code).not.toContain('secrets/prod.ts');
  });

  it('keeps every disclosure out of the code, on every refusal shape', () => {
    const cases: Array<() => ReturnType<typeof buildArtifact>> = [
      () => buildArtifact(input({ files: [{ path: 'secrets/prod.ts', content: 'x' }] })),
      () => buildArtifact(input({ files: [{ path: 'src/cfg.ts', content: `k = "${AWS}"\n` }] })),
      () => buildArtifact(input({ files: [{ path: 'src/big.ts', content: 'xx' }] }), { maxFileBytes: 1 }),
      () => buildArtifact(refInput({ scope: SCOPE })),
    ];
    for (const run of cases) {
      const r = run();
      expect(r.ok).toBe(false);
      if (r.ok) { continue; }
      // A code is a fixed vocabulary: lowercase words and dashes, nothing
      // interpolated from the local file system.
      expect(r.code).toMatch(/^[a-z-]+$/);
      expect(r.error.startsWith(`${r.code}:`)).toBe(true);
    }
  });
});
