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
 * DeskArtifacts (Plan 21 Phase 5, invariant I15) — how work crosses a trust
 * boundary.
 *
 * ── Two modes, and the boundary decides which ──────────────────────────────
 *
 * `ref` is a git ref. It is cheap and lossless and it carries REACHABLE
 * HISTORY: every commit an attacker (or a colleague, months ago) ever made on
 * that branch, including files deleted in a later commit, including the
 * `.env` that was committed and reverted. Inside one trust domain — one
 * company, one secrets domain, one shared remote — that history is already
 * mutually reachable, so a ref discloses nothing new. Across a trust domain
 * it is the CamoLeak-class leak: the sender believes they shared four files
 * and actually shared every byte that branch can reach.
 *
 * So `mode:'ref'` is REFUSED when `sameTrustDomain` is false. Not warned
 * about, not gated behind a card — refused, because the disclosure is exactly
 * the thing a human reading a card cannot see.
 *
 * `bundle` is an enumerated set of WORKING-TREE files. It has no parent
 * commits, no packfile, no ref, and nothing reachable from it: what you see
 * in the manifest is the entire artifact. That property is structural, not a
 * promise — {@link DeskBundle} has no field that could hold a commit graph,
 * and {@link verifyBundle} refuses any object carrying a field it does not
 * recognise, so a future sender cannot smuggle one in beside the files.
 *
 * ── What a ref is NOT checked for, stated plainly ──────────────────────────
 *
 * This module is pure: it has no git. It therefore CANNOT enumerate what a ref
 * contains, so for `mode:'ref'` it cannot scope-check or egress-scan the bytes
 * that actually leave. Any `files` supplied alongside a ref are the sender's
 * unverifiable CLAIM about the ref; they are scanned and scope-checked because
 * checking a claim beats ignoring it, but a clean result over that list says
 * nothing about the ref. See {@link DeskRef}.
 *
 * Two structural controls stand in for the check that cannot be done here:
 *   1. `sameTrustDomain !== true` refuses the ref outright (above).
 *   2. A ref is refused unless the share scope covers the WHOLE workspace.
 *      A ref carries the whole repository, so a workspace that has declared
 *      it shares only `docs` — or nothing at all — must not be able to emit
 *      one: that would be the scope saying one thing and the artifact doing
 *      another. The escape is an enumerated bundle, which can be narrowed.
 *
 * Requiring a NON-EMPTY file list for a ref was considered and rejected: it
 * would manufacture the appearance of a scanned artifact out of a list nothing
 * verifies. Refusing on scope is a real control; a mandatory unverifiable
 * declaration is not.
 *
 * ── Refuse, never redact, never truncate (I21) ─────────────────────────────
 *
 * A credential found in any file blocks the WHOLE build. Three rejected
 * alternatives, and why:
 *   - Gate it behind a card: 93-97% of such prompts are approved, and the
 *     human cannot evaluate "is this 40-char string live?" anyway.
 *   - Strip the span and send the rest: the recipient cannot tell what is
 *     missing, and — worse — the credential stays in the sender's file, so
 *     the next request leaks it through a path this scanner does not know.
 *   - Drop the offending file and send the others: same silent-partial
 *     failure, dressed as success.
 * Refusing teaches the sender to remove the credential. It is loud,
 * recoverable, and fixes the actual problem.
 *
 * Exceeding a size or count cap is likewise an error, never a trim.
 *
 * The file PATH and the ref NAME are scanned as well as the content: all three
 * cross the boundary, and a checked-in key file named after its own key would
 * otherwise walk straight through. When the credential is in the path or the
 * ref itself, the refusal names a POSITION and never the string — echoing it
 * would make the refusal the leak it exists to prevent.
 *
 * ── Failure text is LOCAL-ONLY ─────────────────────────────────────────────
 *
 * `handoff` is a peer-facing verb, and every refusal here is shaped for the
 * operator's console: it names a path the peer was explicitly denied, an exact
 * local file size, or the fact that this repository contains a live AWS key
 * and which file it is in. Serialising `error` or `blockedPaths` into a Desk
 * response would hand a peer a scope-and-inventory oracle. So a failure also
 * carries a stable `code`: coarse, value-free, and the only field a call site
 * may even consider forwarding — and since a code is still policy-revealing,
 * a single generic refusal remains the better peer-facing answer. See
 * {@link BuildResult}.
 *
 * ── Purity ─────────────────────────────────────────────────────────────────
 *
 * No fs, no git, no vscode: contents arrive as data already read by the
 * caller, so the packing rules are a pure function and the privileged reads
 * (and any git invocation) stay at the caller's boundary, where I11's import
 * graph can keep them out of the serving path.
 */

import * as crypto from 'crypto';
import { validatePath, validateSha1 } from './DeskContract';
import { isInScope } from './DeskScope';
import { blocksEgress, describeEgressVerdict, scanEgress } from '../EgressScanner';
import type { DeskScopeSpec } from '../../types';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ArtifactMode = 'ref' | 'bundle';

/** One working-tree file. `sha256` is over the file's UTF-8 bytes. */
export interface BundleFile {
  path: string;
  content: string;
  sha256: string;
}

/**
 * An enumerated file set with zero reachable history.
 *
 * `manifest` is the sorted path list a receiver checks the payload against
 * (I21: a declared manifest that does not match the payload is a refusal, so
 * a node can never go green on a partial artifact). `sha256` binds the whole
 * set AND the `baseSha` it is written against — see {@link bundleDigest}.
 */
export interface DeskBundle {
  mode: 'bundle';
  files: BundleFile[];
  manifest: string[];
  sha256: string;
  baseSha: string;
}

/**
 * A git ref. Intra-trust-domain only (I15).
 *
 * UNSCANNED AND UNSCOPED BY THIS MODULE. There is no git here, so nothing in
 * this file has read what the ref contains: the egress scan and the scope
 * check ran over the caller's `input.files` — an unverifiable claim about the
 * ref — and over the ref NAME. Whatever resolves this ref to a tree owns the
 * per-path scope check and the per-blob egress scan of the bytes it reads.
 */
export interface DeskRef {
  mode: 'ref';
  ref: string;
  baseSha: string;
}

export type DeskArtifact = DeskBundle | DeskRef;

export interface BuildInput {
  mode: ArtifactMode;
  /**
   * The working-tree files. Required and non-empty for `bundle`.
   *
   * Accepted for `ref` too, where they are scanned and scope-checked — but
   * they are the sender's CLAIM about the ref, not a description of it, and
   * they are not carried in the artifact. A clean scan over this list is not
   * evidence about the ref (see the header comment).
   */
  files: Array<{ path: string; content: string }>;
  baseSha: string;
  sameTrustDomain: boolean;
  /**
   * The effective share scope. Must be a {@link DeskScopeSpec} produced by
   * `DeskScope.resolveScope`, which is where the machine-scoped ceiling is
   * intersected in.
   *
   * Stated honestly: this argument is caller-supplied and structurally
   * unbranded, so the per-path check below re-checks the CALLER'S OWN CLAIM
   * rather than applying an independent ceiling. A caller that fabricates
   * `{ allow: ['*'] }` widens itself and nothing here can tell. The check
   * still earns its place — it catches a file list assembled from an unscoped
   * read by a correct caller — but it is not a control against the caller,
   * and no reader should treat it as one.
   */
  scope: DeskScopeSpec;
  /**
   * The ref to hand over, e.g. `refs/heads/feat/x`. Required for `mode:'ref'`.
   * Optional on the interface so a bundle build never has to supply a
   * meaningless value.
   */
  ref?: string;
}

/**
 * Stable, coarse failure codes.
 *
 * `code` is the only part of a failure a call site should even consider
 * putting on the wire; `error` and `blockedPaths` are operator-facing and
 * disclose local paths, sizes and inventory.
 */
export type BuildFailureCode =
  | 'invalid-input'
  | 'invalid-mode'
  | 'ref-cross-domain'
  | 'ref-out-of-scope'
  | 'invalid-base-sha'
  | 'invalid-scope'
  | 'too-many-files'
  | 'empty-bundle'
  | 'invalid-file'
  | 'invalid-path'
  | 'out-of-scope'
  | 'duplicate-path'
  | 'binary-content'
  | 'file-too-large'
  | 'bundle-too-large'
  | 'secret-detected'
  | 'invalid-ref';

export type VerifyFailureCode =
  | 'not-an-object'
  | 'invalid-mode'
  | 'invalid-scope'
  | 'unknown-field'
  | 'invalid-base-sha'
  | 'invalid-digest'
  | 'invalid-files'
  | 'empty-bundle'
  | 'too-many-files'
  | 'invalid-manifest'
  | 'manifest-mismatch'
  | 'invalid-file'
  | 'invalid-path'
  | 'out-of-scope'
  | 'duplicate-path'
  | 'binary-content'
  | 'file-too-large'
  | 'bundle-too-large'
  | 'file-digest-mismatch'
  | 'bundle-digest-mismatch';

/**
 * `error` and `blockedPaths` are LOCAL-ONLY. They name denied paths, exact
 * byte counts and the files holding credential material; forwarding them to a
 * peer turns a refusal into a scope-and-inventory oracle. Render them in the
 * operator's UI and log, and send at most `code`.
 */
export type BuildResult =
  | { ok: true; artifact: DeskArtifact }
  | { ok: false; code: BuildFailureCode; error: string; blockedPaths?: string[] };

/** `error` is LOCAL-ONLY for the same reason as {@link BuildResult}. */
export type VerifyResult =
  | { ok: true; bundle: DeskBundle }
  | { ok: false; code: VerifyFailureCode; error: string };

function refuse<C extends string>(code: C, detail: string): { ok: false; code: C; error: string } {
  return { ok: false, code, error: `${code}: ${detail}` };
}

// ---------------------------------------------------------------------------
// Limits — clamped at the boundary, never spread
// ---------------------------------------------------------------------------

export interface ArtifactLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const ARTIFACT_LIMITS: Readonly<ArtifactLimits> = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
});

/**
 * Hard ceilings no caller may raise past, so an option cannot become a bypass.
 *
 * Exported so a test can assert the exact numbers: this clamp is the whole of
 * that property, and a constant referenced by no assertion is one careless
 * edit from vanishing silently.
 */
export const LIMIT_CEILING: Readonly<ArtifactLimits> = Object.freeze({
  maxFiles: 2_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

/**
 * Resolve one numeric option.
 *
 * Deliberately NOT `{...ARTIFACT_LIMITS, ...opts}`: an explicit `undefined` —
 * precisely what `workspace.getConfiguration().get<number>('unset')` returns —
 * overwrites the default in a spread, and a `NaN` that reaches a comparison
 * makes every `>` false, so the limit silently stops limiting. That exact bug
 * disabled a rate limiter and a body cap earlier in this plan.
 */
function limit(raw: unknown, fallback: number, ceiling: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) { return fallback; }
  const n = Math.floor(raw);
  if (n < 1) { return 1; }
  if (n > ceiling) { return ceiling; }
  return n;
}

function resolveLimits(opts?: Partial<ArtifactLimits>): ArtifactLimits {
  return {
    maxFiles: limit(opts?.maxFiles, ARTIFACT_LIMITS.maxFiles, LIMIT_CEILING.maxFiles),
    maxFileBytes: limit(opts?.maxFileBytes, ARTIFACT_LIMITS.maxFileBytes, LIMIT_CEILING.maxFileBytes),
    maxTotalBytes: limit(opts?.maxTotalBytes, ARTIFACT_LIMITS.maxTotalBytes, LIMIT_CEILING.maxTotalBytes),
  };
}

// ---------------------------------------------------------------------------
// Field allowlists — this is what makes "no reachable history" checkable
// ---------------------------------------------------------------------------

/**
 * The complete field set of a bundle. Anything else — `parents`, `commit`,
 * `packfile`, `refs` — is refused by {@link verifyBundle} rather than ignored.
 *
 * Ignoring an unknown field would be the ordinary tolerant-parser choice and
 * is wrong here: a receiver that ignores `parents` still hands the object to
 * whatever renders or stores it next, and the sender's UI already told a human
 * "4 files". An allowlist is the only version of "no reachable history" that a
 * test can assert and a future edit cannot quietly relax.
 */
export const BUNDLE_FIELDS: readonly string[] =
  Object.freeze(['mode', 'files', 'manifest', 'sha256', 'baseSha']);

export const BUNDLE_FILE_FIELDS: readonly string[] =
  Object.freeze(['path', 'content', 'sha256']);

/**
 * Field names that would mean a commit graph came along. Not needed for
 * correctness — the allowlist above already refuses them — but naming them
 * turns a generic "unknown field" into a refusal message that says what the
 * sender actually did.
 */
const HISTORY_FIELDS: readonly string[] = Object.freeze([
  'parent', 'parents', 'commit', 'commits', 'history', 'ancestors',
  'packfile', 'pack', 'objects', 'refs', 'ref', 'headSha', 'head',
  'revList', 'shallow', 'graft',
]);

/**
 * Own keys including NON-ENUMERABLE and SYMBOL ones, rendered as strings for
 * the allowlist comparison.
 *
 * `Object.keys` sees only own enumerable string keys, so a `parents` defined
 * with `Object.defineProperty(o, 'parents', { enumerable: false })` — or under
 * a symbol — would sail through a check whose stated guarantee is "ANY field
 * outside the allowlist is refused". A JSON-parsed wire payload cannot carry
 * one, but the guarantee should not quietly depend on the caller having gone
 * through JSON. A symbol renders as `Symbol(x)`, which is in neither
 * allowlist, so it is refused rather than accepted.
 */
function ownKeyNames(o: object): string[] {
  return Reflect.ownKeys(o).map(k => (typeof k === 'symbol' ? k.toString() : k));
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

const SHA1_HEX_RE = /^[0-9a-f]{40}$/;

/**
 * The bundle digest: sha256 over a mode tag, the baseSha, and
 * `sha256sum`-shaped lines, one per file, sorted by path.
 *
 * A digest-of-digests rather than a digest of concatenated bytes, because it
 * binds every byte transitively while staying order-independent and
 * hand-checkable (`sha256sum -c` reads the same lines). `\n` is a safe
 * separator: {@link validatePath} rejects control characters, so no path can
 * contain one and no two file sets can canonicalise to the same string.
 *
 * `baseSha` is INSIDE the digest and the leading `bundle` line pins the mode.
 * Without them the digest binds only the file set, so an in-transit edit of
 * `baseSha` survives verification — and `baseSha` is the commit the receiver
 * applies the file set onto, so changing it silently re-targets the whole
 * handoff (four files written against commit A, applied onto commit B) while
 * every hash check goes green.
 *
 * Throws on a `baseSha` that is not 40 lowercase hex. Both call sites validate
 * first; a caller that does not deserves a loud failure rather than a digest
 * over an ambiguous canonical form — a `baseSha` carrying a newline could
 * otherwise impersonate a file line.
 */
export function bundleDigest(files: BundleFile[], baseSha: string): string {
  if (typeof baseSha !== 'string' || !SHA1_HEX_RE.test(baseSha)) {
    throw new TypeError('bundleDigest: baseSha must be 40 lowercase hex chars');
  }
  const lines = [...files]
    .sort(byPath)
    .map(f => `${f.sha256}  ${f.path}`)
    .join('\n');
  return sha256Hex(`bundle\n${baseSha}\n${lines}\n`);
}

/**
 * Code-unit order, never `localeCompare`: the digest must be identical on
 * every machine, and locale-aware collation is neither stable across ICU
 * versions nor across a user's locale setting.
 */
function byPath(a: { path: string }, b: { path: string }): number {
  if (a.path < b.path) { return -1; }
  if (a.path > b.path) { return 1; }
  return 0;
}

// ---------------------------------------------------------------------------
// Ref validation
// ---------------------------------------------------------------------------

/**
 * A conservative subset of git's ref-name rules (`git check-ref-format`).
 *
 * Only `refs/…` is accepted: a bare name like `HEAD`, `--upload-pack=…`, or
 * anything beginning with `-` could be read as an option by whatever git
 * command consumes it, and an allowlist beats trying to enumerate the
 * dangerous spellings.
 */
const REF_SEGMENT_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function validateRef(raw: unknown): { ok: true; value: string } | { ok: false; detail: string } {
  if (typeof raw !== 'string') { return { ok: false, detail: 'ref must be a string' }; }
  const v = raw.trim();
  // Length is its own check, not a side effect of the character rules: this
  // string is destined for an argv and a log line.
  if (v.length === 0 || v.length > 255) { return { ok: false, detail: 'ref length' }; }
  if (!v.startsWith('refs/')) { return { ok: false, detail: 'ref must start with refs/' }; }
  if (!REF_SEGMENT_RE.test(v)) { return { ok: false, detail: 'illegal characters' }; }
  if (v.includes('..') || v.includes('//') || v.endsWith('/') || v.endsWith('.lock')) {
    return { ok: false, detail: 'illegal sequence' };
  }
  // A segment may not begin with `-` or `.`: git permits both, but a leading
  // dash is an option once the name reaches an argv, and a leading dot is the
  // hidden-file spelling. Refusing here costs a branch name nobody wants.
  //
  // A TRAILING dot is refused because `git check-ref-format` refuses it. An
  // accepted-here-but-rejected-there name would push the failure to a later,
  // less controlled layer than the validator that claims to own the rule.
  const badSegment = (s: string): boolean =>
    s.length === 0 || s.startsWith('-') || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock');
  if (v.split('/').some(badSegment)) {
    return { ok: false, detail: 'illegal segment' };
  }
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * A NUL means the payload is binary, and `content: string` cannot round-trip
 * binary. Refusing beats a silently-corrupted file on the receiving end — and
 * a NUL written to disk also makes git treat the result as binary, which
 * removes it from human review at exactly the wrong moment.
 */
function hasNul(s: string): boolean { return s.indexOf('\u0000') !== -1; }

/** The scope prefix meaning "the whole workspace" (see DeskScope). */
const WHOLE_WORKSPACE = '*';

/** Structural check only — see the honesty note on {@link BuildInput.scope}. */
function scopeShapeOk(scope: unknown): scope is DeskScopeSpec {
  return scope !== null && typeof scope === 'object'
    && Array.isArray((scope as DeskScopeSpec).allow);
}

/**
 * Pack an artifact for a peer.
 *
 * Everything is checked before anything is produced: there is no partial
 * result and no "built but flagged" state (I21).
 */
export function buildArtifact(input: BuildInput, opts?: Partial<ArtifactLimits>): BuildResult {
  if (input === null || typeof input !== 'object') {
    return refuse('invalid-input', 'input must be an object');
  }
  const limits = resolveLimits(opts);

  if (input.mode !== 'ref' && input.mode !== 'bundle') {
    return refuse('invalid-mode', 'mode must be "ref" or "bundle"');
  }

  // I15, first and unconditionally. A ref carries reachable history — deleted
  // files, reverted commits, everything the branch can see — and no card can
  // render that, so this is a refusal rather than a gate.
  if (input.mode === 'ref' && input.sameTrustDomain !== true) {
    return refuse(
      'ref-cross-domain',
      'a git ref carries reachable history and may not cross a trust domain '
      + '— hand off an enumerated bundle instead',
    );
  }

  const base = validateSha1(input.baseSha, 'baseSha');
  if (!base.ok) { return refuse('invalid-base-sha', base.error); }

  const rawFiles = Array.isArray(input.files) ? input.files : null;
  if (rawFiles === null) { return refuse('invalid-input', 'files must be an array'); }
  if (rawFiles.length > limits.maxFiles) {
    // Refuse, do not take the first N: a truncated file set is a partial
    // artifact wearing a success badge (I21).
    return refuse('too-many-files', `${rawFiles.length} exceeds ${limits.maxFiles}`);
  }
  if (input.mode === 'bundle' && rawFiles.length === 0) {
    return refuse('empty-bundle', 'a bundle must enumerate at least one file');
  }

  const scope = input.scope;
  if (!scopeShapeOk(scope)) {
    return refuse('invalid-scope', 'scope must carry an allow list');
  }

  // A ref cannot be narrowed, and this module has no git with which to check
  // what it contains — but it CAN refuse to emit one from a workspace whose
  // own declared scope is narrower than everything, which is precisely the
  // case where the scope and the artifact would be saying different things.
  //
  // Placed before the per-file loop deliberately: `files` is optional for a
  // ref, so a loop-based check refuses nothing when the list is empty, and an
  // empty list is the shape a ref build normally has.
  if (input.mode === 'ref' && !scope.allow.includes(WHOLE_WORKSPACE)) {
    return refuse(
      'ref-out-of-scope',
      scope.allow.length === 0
        ? 'nothing is shared, so no ref may be handed over'
        : 'a ref carries the whole repository and the share scope is narrower '
          + '— hand off an enumerated bundle instead',
    );
  }

  const seen = new Set<string>();
  const checked: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;

  for (let i = 0; i < rawFiles.length; i++) {
    const entry = rawFiles[i];
    // `Array.isArray` as well as the null/typeof pair, matching the receive
    // side: an array is `typeof 'object'`, so without it `['src/a.ts','x']`
    // reaches `entry.path` as undefined and is refused as a bad PATH — a
    // misleading message for a bad ENTRY, and one guard away from a throw if
    // the shape check ever moves.
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return refuse('invalid-file', `files[${i}] must be an object`);
    }
    const p = validatePath(entry.path, `files[${i}].path`);
    if (!p.ok) { return refuse('invalid-path', p.error); }

    // Scope is checked here as well as at the read boundary. This is the last
    // place the sender's own policy applies before bytes leave, and a caller
    // that assembled the list from somewhere other than a scoped read must not
    // be able to widen it BY ACCIDENT. It re-checks the caller's own claim; it
    // is not a control against the caller — see {@link BuildInput.scope}.
    if (!isInScope(scope, p.value)) {
      return refuse('out-of-scope', `${p.value} is outside the shared scope`);
    }

    // A duplicate is refused rather than deduped: two entries for one path
    // disagree about content, and silently picking one is a coin flip the
    // receiver cannot audit.
    if (seen.has(p.value)) {
      return refuse('duplicate-path', `${p.value} appears more than once`);
    }
    seen.add(p.value);

    if (typeof entry.content !== 'string') {
      return refuse('invalid-file', `files[${i}].content must be a string`);
    }
    if (hasNul(entry.content)) {
      return refuse('binary-content', `${p.value} contains a NUL byte`);
    }

    const bytes = Buffer.byteLength(entry.content, 'utf8');
    if (bytes > limits.maxFileBytes) {
      return refuse('file-too-large', `${p.value} is ${bytes} bytes (max ${limits.maxFileBytes})`);
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      return refuse('bundle-too-large', `exceeds ${limits.maxTotalBytes} bytes`);
    }

    checked.push({ path: p.value, content: entry.content });
  }

  // Scan EVERY file even after the first hit, so the share card can say
  // "remove the credential from these three files" once instead of turning
  // the fix into three round trips. The PATH is scanned as well as the
  // content: the manifest crosses the boundary too.
  const blockedPaths: string[] = [];
  const details: string[] = [];
  for (let i = 0; i < checked.length; i++) {
    const f = checked[i];
    const inPath = scanEgress(f.path);
    const inContent = scanEgress(f.content);
    const pathBlocked = blocksEgress(inPath);
    const contentBlocked = blocksEgress(inContent);
    if (!pathBlocked && !contentBlocked) { continue; }
    // When the credential is IN the path, the path IS the secret — name the
    // position instead, or this refusal becomes the disclosure.
    const label = pathBlocked ? `files[${i}].path (withheld)` : f.path;
    blockedPaths.push(label);
    if (pathBlocked) { details.push(`${label}: ${describeEgressVerdict(inPath)}`); }
    if (contentBlocked) { details.push(`${label}: ${describeEgressVerdict(inContent)}`); }
  }
  if (blockedPaths.length > 0) {
    return {
      // Detector labels and counts only — EgressScanner never returns the
      // matched value, so this message cannot become the leak it prevents.
      ...refuse(
        'secret-detected',
        `credential material in ${blockedPaths.length} file(s) — ${details.join('; ')}`,
      ),
      blockedPaths,
    };
  }

  if (input.mode === 'ref') {
    const ref = validateRef(input.ref);
    if (!ref.ok) { return refuse('invalid-ref', ref.detail); }
    // The ref NAME crosses the boundary as literal text, so it is scanned like
    // any other outbound string, and never echoed on a hit: a branch named
    // after a token would put the token in this message.
    const refVerdict = scanEgress(ref.value);
    if (blocksEgress(refVerdict)) {
      return refuse(
        'secret-detected',
        `credential material in the ref name (withheld) — ${describeEgressVerdict(refVerdict)}`,
      );
    }
    // No `files` on a DeskRef: the receiver reads the ref from its own object
    // store at the verified sha, so a sender-supplied file list here would be
    // an unverifiable claim about what the ref contains. Which is exactly why
    // none of the checks above is a check ON THE REF — see {@link DeskRef}.
    return { ok: true, artifact: { mode: 'ref', ref: ref.value, baseSha: base.value } };
  }

  // Sorted so the same file set packs to byte-identical bytes on any machine,
  // which is what lets an effectId dedupe two deliveries of one handoff.
  const files: BundleFile[] = checked
    .map(f => ({ path: f.path, content: f.content, sha256: sha256Hex(f.content) }))
    .sort(byPath);

  const bundle: DeskBundle = {
    mode: 'bundle',
    files,
    manifest: files.map(f => f.path),
    sha256: bundleDigest(files, base.value),
    baseSha: base.value,
  };
  return { ok: true, artifact: bundle };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a bundle received from a peer.
 *
 * This is an integrity check AND a scope check, and `scope` is a REQUIRED
 * argument because the two must not be separable. Integrity answers "is this
 * exactly the enumerated set the sender declared, and nothing else"; the scope
 * answers "may a peer name this path at all". Without the second, an inbound
 * manifest of `.mysti/agents/skills/evil/SKILL.md` and `.vscode/settings.json`
 * — the instruction surface and the editor config, which Plan 20 Phase 2 spent
 * a phase protecting — passes a green integrity check, and the apply path
 * downstream has nothing left to appeal to.
 *
 * A receiver that genuinely accepts anything must say so by passing a scope
 * whose allow list is `['*']`. There is no default, because a default is the
 * thing every future call site silently inherits.
 *
 * It deliberately does NOT re-run the egress scanner: a credential in an
 * inbound bundle is the sender's leak, not the receiver's, and refusing here
 * would only hide it from the human who has to tell them.
 *
 * `ok: true` is NOT an authorization result. The local write gate, the
 * checkpoint and the consumed-effects ledger live in the apply path — which
 * does not exist yet. This module has no production caller, so the first one
 * inherits every deferral in this comment at once, and it must land the apply
 * gate in the same change that wires this in.
 *
 * Hash comparison is a plain `!==` and not `timingSafeEqual`: these digests
 * are public integrity values, not secrets, and reaching for a constant-time
 * compare here would imply otherwise to the next reader.
 */
export function verifyBundle(
  bundle: unknown,
  scope: DeskScopeSpec,
  opts?: Partial<ArtifactLimits>,
): VerifyResult {
  const limits = resolveLimits(opts);

  if (!scopeShapeOk(scope)) {
    return refuse('invalid-scope', 'scope must carry an allow list');
  }

  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return refuse('not-an-object', 'bundle must be an object');
  }
  const b = bundle as Record<string, unknown>;

  if (b.mode !== 'bundle') {
    // A ref reaching this function means a cross-domain path tried to reuse
    // the bundle plumbing, which is exactly the I15 bypass.
    return refuse('invalid-mode', 'only mode "bundle" can be verified');
  }

  for (const key of ownKeyNames(b)) {
    if (!BUNDLE_FIELDS.includes(key)) {
      const why = HISTORY_FIELDS.includes(key)
        ? 'a bundle carries no reachable history'
        : 'unrecognised field';
      return refuse('unknown-field', `"${key}" — ${why}`);
    }
  }

  const base = validateSha1(b.baseSha, 'baseSha');
  if (!base.ok) { return refuse('invalid-base-sha', base.error); }

  if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) {
    return refuse('invalid-digest', 'sha256 must be 64 lowercase hex chars');
  }

  if (!Array.isArray(b.files)) { return refuse('invalid-files', 'files must be an array'); }
  if (b.files.length === 0) { return refuse('empty-bundle', 'a bundle must enumerate at least one file'); }
  if (b.files.length > limits.maxFiles) {
    return refuse('too-many-files', `${b.files.length} exceeds ${limits.maxFiles}`);
  }
  if (!Array.isArray(b.manifest)) { return refuse('invalid-manifest', 'manifest must be an array'); }
  // Compared BEFORE the per-entry walk. The manifest is peer-supplied and
  // capped by nothing else, so a 400k-entry manifest against a one-file
  // payload would otherwise be walked and copied in full before an O(1)
  // comparison refused it. `b.files.length` is already capped above.
  if (b.manifest.length !== b.files.length) {
    return refuse(
      'manifest-mismatch',
      `declares ${b.manifest.length} path(s), payload carries ${b.files.length}`,
    );
  }

  const files: BundleFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (let i = 0; i < b.files.length; i++) {
    const raw = b.files[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return refuse('invalid-file', `files[${i}] must be an object`);
    }
    const f = raw as Record<string, unknown>;
    for (const key of ownKeyNames(f)) {
      if (!BUNDLE_FILE_FIELDS.includes(key)) {
        const why = HISTORY_FIELDS.includes(key)
          ? 'a bundled file carries no commit metadata'
          : 'unrecognised field';
        return refuse('unknown-field', `files[${i}]."${key}" — ${why}`);
      }
    }
    const p = validatePath(f.path, `files[${i}].path`);
    if (!p.ok) { return refuse('invalid-path', p.error); }
    // The receiver's accept scope. A peer may not name a path outside it — in
    // particular the instruction surface (`.mysti/agents/**`) and the editor
    // config, which are exactly what a hostile bundle aims at.
    if (!isInScope(scope, p.value)) {
      return refuse('out-of-scope', `${p.value} is outside the accepted scope`);
    }
    if (seen.has(p.value)) {
      return refuse('duplicate-path', `${p.value} appears more than once`);
    }
    seen.add(p.value);

    if (typeof f.content !== 'string') {
      return refuse('invalid-file', `files[${i}].content must be a string`);
    }
    if (hasNul(f.content)) {
      return refuse('binary-content', `${p.value} contains a NUL byte`);
    }
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > limits.maxFileBytes) {
      return refuse('file-too-large', `${p.value} is ${bytes} bytes (max ${limits.maxFileBytes})`);
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      return refuse('bundle-too-large', `exceeds ${limits.maxTotalBytes} bytes`);
    }

    const actual = sha256Hex(f.content);
    if (typeof f.sha256 !== 'string' || f.sha256 !== actual) {
      // I21: a hash mismatch is an error, never a warning and never a flag on
      // an otherwise-applied artifact.
      return refuse('file-digest-mismatch', p.value);
    }
    files.push({ path: p.value, content: f.content, sha256: actual });
  }

  // The manifest is the sender's DECLARATION of what the payload contains.
  // Comparing it against the payload is what stops a node going green on a
  // set that quietly lost a file in transit.
  const declared: string[] = [];
  for (let i = 0; i < b.manifest.length; i++) {
    const entry = b.manifest[i];
    // A non-string manifest entry is refused rather than coerced to a
    // sentinel: any sentinel is a value a crafted payload could also declare,
    // and comparing garbage against garbage is how a mismatch check passes.
    if (typeof entry !== 'string') {
      return refuse('invalid-manifest', `manifest[${i}] must be a string`);
    }
    declared.push(entry);
  }
  if (declared.length !== files.length) {
    return refuse(
      'manifest-mismatch',
      `declares ${declared.length} path(s), payload carries ${files.length}`,
    );
  }
  const payloadPaths = files.map(f => f.path).sort();
  const declaredSorted = [...declared].sort();
  for (let i = 0; i < payloadPaths.length; i++) {
    if (declaredSorted[i] !== payloadPaths[i]) {
      return refuse('manifest-mismatch', 'declared paths do not match the payload');
    }
  }

  // Computed over the RECEIVED order, which {@link bundleDigest} sorts
  // internally: a bundle whose file array was reordered in transit is the same
  // artifact and must still verify. `baseSha` is inside this digest, so a
  // re-targeted handoff fails here instead of applying onto another commit.
  const digest = bundleDigest(files, base.value);
  if (digest !== b.sha256) {
    return refuse('bundle-digest-mismatch', 'recomputed sha256 does not match the declared one');
  }

  // Rebuilt from validated parts rather than returned as-received, so nothing
  // a caller touches downstream can be a field this function did not check.
  const sorted = files.sort(byPath);
  return {
    ok: true,
    bundle: {
      mode: 'bundle',
      files: sorted,
      manifest: sorted.map(f => f.path),
      sha256: digest,
      baseSha: base.value,
    },
  };
}
