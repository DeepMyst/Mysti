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
 * DeskContract (Plan 21 Phase 1) — the closed verb table and the validators
 * that every inbound Desk request passes through before any code sees it.
 *
 * ── Drop, do not repair ────────────────────────────────────────────────────
 *
 * Every sanitizer here REJECTS malformed input rather than cleaning it up.
 * Repairing attacker-supplied data is how a validator becomes an oracle: if
 * `../../etc/passwd` silently becomes `etc/passwd`, the caller learns the
 * filter's shape and the next probe is written around it. A rejection teaches
 * nothing and cannot be normalised into a bypass. This mirrors the discipline
 * already used by `_sanitizeMcpTools`.
 *
 * ── Why the strings are so tightly bounded ─────────────────────────────────
 *
 * Remote-supplied text reaches three places that historically break on it: a
 * model prompt (where a newline can escape a fence header), the webview (where
 * a bidi override can reorder a rendered path — trojan-source in a roster is
 * real), and a log line. Rather than escaping per-destination, the contract
 * refuses the characters outright at the boundary: control characters, bidi
 * overrides, and anything past a length cap.
 *
 * This module is PURE. It imports nothing — not vscode, not fs, not the
 * scanner — so it can be reasoned about and tested in isolation, and so it can
 * never become a path to a capability.
 */

import type { DeskVerb } from '../../types';

/** Result of validating one field or one argument object. */
export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail<T>(error: string): Validated<T> { return { ok: false, error }; }
function pass<T>(value: T): Validated<T> { return { ok: true, value }; }

// ---------------------------------------------------------------------------
// Character-class guards
// ---------------------------------------------------------------------------

/**
 * C0/C1 controls except none — tab, newline and carriage return are INCLUDED
 * in the rejection set on purpose. A newline in an attribution field is the
 * fence-header escape that CANVAS-LANE-03 documents; a tab is enough to forge
 * alignment in a rendered card.
 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Bidirectional overrides and isolates. These reorder rendered text without
 * changing its bytes, so a path can display as one thing and resolve as
 * another ("trojan source"). The webview renders peer-supplied paths.
 */
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;

/** Zero-width characters, which can hide a discriminator inside a token. */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/;

/** True when a string carries any character class the contract refuses. */
export function hasUnsafeChars(s: string): boolean {
  return CONTROL_CHAR_RE.test(s) || BIDI_RE.test(s) || ZERO_WIDTH_RE.test(s);
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

export const LIMITS = {
  id: 64,
  alias: 32,
  token: 128,
  path: 400,
  question: 4_000,
  title: 200,
  detail: 20_000,
  /** Most arrays that cross the wire; a fan-out cap, not a UI cap. */
  arrayItems: 200,
} as const;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** An opaque identifier: callId, proposalId, askId. */
export function validateId(v: unknown, field = 'id'): Validated<string> {
  if (typeof v !== 'string') { return fail(`${field} must be a string`); }
  if (!ID_RE.test(v)) { return fail(`${field} must match ${ID_RE.source}`); }
  return pass(v);
}

/** A locally-typed peer handle. Never supplied by the remote side. */
export function validateAlias(v: unknown): Validated<string> {
  if (typeof v !== 'string') { return fail('alias must be a string'); }
  if (!ALIAS_RE.test(v)) { return fail(`alias must match ${ALIAS_RE.source}`); }
  return pass(v);
}

export function validateSha1(v: unknown, field = 'sha'): Validated<string> {
  if (typeof v !== 'string' || !SHA1_RE.test(v)) { return fail(`${field} must be 40 lowercase hex chars`); }
  return pass(v);
}

export function validateSha256(v: unknown, field = 'digest'): Validated<string> {
  if (typeof v !== 'string' || !SHA256_RE.test(v)) { return fail(`${field} must be 64 lowercase hex chars`); }
  return pass(v);
}

/**
 * A workspace-relative POSIX path.
 *
 * Rejects — never rewrites — absolute paths, any `..` segment, backslashes,
 * UNC prefixes, Windows drive letters, and embedded NULs. Note `.` segments
 * are also refused: a caller that means `src/a.ts` can say so, and permitting
 * `./src/./a.ts` means two spellings of one path, which defeats any
 * path-keyed cache or dedupe built on top.
 */
export function validatePath(v: unknown, field = 'path'): Validated<string> {
  if (typeof v !== 'string') { return fail(`${field} must be a string`); }
  if (v.length === 0) { return fail(`${field} must not be empty`); }
  if (v.length > LIMITS.path) { return fail(`${field} exceeds ${LIMITS.path} chars`); }
  if (hasUnsafeChars(v)) { return fail(`${field} contains control, bidi or zero-width characters`); }
  if (v.includes('\\')) { return fail(`${field} must use POSIX separators`); }
  if (v.startsWith('/')) { return fail(`${field} must be workspace-relative`); }
  if (/^[A-Za-z]:/.test(v)) { return fail(`${field} must not carry a drive letter`); }
  const segments = v.split('/');
  if (segments.some(s => s === '..' || s === '.' || s === '')) {
    return fail(`${field} must not contain empty, "." or ".." segments`);
  }
  return pass(v);
}

/** Free text bound for a model prompt or a card. */
export function validateText(v: unknown, max: number, field = 'text'): Validated<string> {
  if (typeof v !== 'string') { return fail(`${field} must be a string`); }
  const trimmed = v.trim();
  if (trimmed.length === 0) { return fail(`${field} must not be empty`); }
  if (trimmed.length > max) { return fail(`${field} exceeds ${max} chars`); }
  if (BIDI_RE.test(trimmed) || ZERO_WIDTH_RE.test(trimmed)) {
    return fail(`${field} contains bidi or zero-width characters`);
  }
  // Newlines are legitimate inside a question or a proposal body, so only the
  // non-whitespace controls are refused here.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) {
    return fail(`${field} contains control characters`);
  }
  return pass(trimmed);
}

/**
 * An exact lookup token. Deliberately NOT a pattern: no regex, glob, wildcard
 * or character class ever reaches local bytes (plans/21 I4). A search verb
 * that accepts a pattern is a blind oracle — ask for a key shape, read the
 * match count, binary-search a secret out one character at a time with zero
 * content returned and zero cards raised.
 */
export function validateToken(v: unknown): Validated<string> {
  if (typeof v !== 'string') { return fail('token must be a string'); }
  const t = v.trim();
  if (t.length === 0) { return fail('token must not be empty'); }
  if (t.length > LIMITS.token) { return fail(`token exceeds ${LIMITS.token} chars`); }
  if (hasUnsafeChars(t)) { return fail('token contains control, bidi or zero-width characters'); }
  // Anything that would only be meaningful as a PATTERN is refused, so that a
  // future implementation cannot quietly start interpreting it.
  if (/[*?[\]{}()|\\^$+]/.test(t)) {
    return fail('token must be a literal — pattern metacharacters are not accepted');
  }
  return pass(t);
}

/** A bounded homogeneous array. */
export function validateArray<T>(
  v: unknown,
  item: (x: unknown, i: number) => Validated<T>,
  field = 'items',
  max: number = LIMITS.arrayItems,
): Validated<T[]> {
  if (!Array.isArray(v)) { return fail(`${field} must be an array`); }
  if (v.length > max) { return fail(`${field} exceeds ${max} entries`); }
  const out: T[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = item(v[i], i);
    if (!r.ok) { return fail(`${field}[${i}]: ${r.error}`); }
    out.push(r.value);
  }
  return pass(out);
}

// ---------------------------------------------------------------------------
// The verb table
// ---------------------------------------------------------------------------

export interface VerbSpec {
  verb: DeskVerb;
  /** Granted by default at pairing, or opt-in per peer. */
  grantable: 'default' | 'opt-in';
  /** May this be answered with no human in the loop? */
  autoAnswerable: boolean;
  /** Does serving it cost the callee a model turn (and therefore money)? */
  costsModelTurn: boolean;
  /** One-line description of what actually leaves the machine. */
  discloses: string;
  /** Validate + normalise this verb's arguments. */
  validate(args: unknown): Validated<Record<string, unknown>>;
}

function asObject(args: unknown): Validated<Record<string, unknown>> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return fail('args must be an object');
  }
  return pass(args as Record<string, unknown>);
}

export const DESK_VERBS: Readonly<Record<DeskVerb, VerbSpec>> = Object.freeze({
  status: {
    verb: 'status',
    grantable: 'default',
    autoAnswerable: true,
    costsModelTurn: false,
    discloses: 'owner-typed availability strings — never a path or file name',
    validate: (args) => {
      const o = asObject(args);
      if (!o.ok) { return o; }
      if (Object.keys(o.value).length > 0) { return fail('status takes no arguments'); }
      return pass({});
    },
  },
  locate: {
    verb: 'locate',
    grantable: 'default',
    autoAnswerable: true,
    costsModelTurn: false,
    discloses: 'coordinates only — path, line, symbol',
    validate: (args) => {
      const o = asObject(args);
      if (!o.ok) { return o; }
      const token = validateToken(o.value.token);
      if (!token.ok) { return fail(token.error); }
      const kindRaw = o.value.kind ?? 'symbol';
      if (kindRaw !== 'symbol' && kindRaw !== 'path') {
        return fail('kind must be "symbol" or "path"');
      }
      return pass({ token: token.value, kind: kindRaw });
    },
  },
  consult: {
    verb: 'consult',
    grantable: 'opt-in',
    autoAnswerable: false,
    costsModelTurn: true,
    discloses: 'prose plus {path, lines} citations — never file contents',
    validate: (args) => {
      const o = asObject(args);
      if (!o.ok) { return o; }
      const q = validateText(o.value.question, LIMITS.question, 'question');
      if (!q.ok) { return fail(q.error); }
      return pass({ question: q.value });
    },
  },
  review: {
    verb: 'review',
    grantable: 'opt-in',
    autoAnswerable: false,
    costsModelTurn: true,
    discloses: 'structured findings anchored to (path, blobSha, line)',
    validate: (args) => {
      const o = asObject(args);
      if (!o.ok) { return o; }
      const sha = validateSha1(o.value.baseSha, 'baseSha');
      if (!sha.ok) { return fail(sha.error); }
      const paths = validateArray(o.value.paths, (x, i) => validatePath(x, `paths[${i}]`), 'paths');
      if (!paths.ok) { return fail(paths.error); }
      return pass({ baseSha: sha.value, paths: paths.value });
    },
  },
  handoff: {
    verb: 'handoff',
    grantable: 'opt-in',
    autoAnswerable: false,
    costsModelTurn: false,
    discloses: 'a git ref (same trust domain) or an enumerated file bundle',
    validate: (args) => {
      const o = asObject(args);
      if (!o.ok) { return o; }
      const title = validateText(o.value.title, LIMITS.title, 'title');
      if (!title.ok) { return fail(title.error); }
      const sha = validateSha1(o.value.baseSha, 'baseSha');
      if (!sha.ok) { return fail(sha.error); }
      return pass({ title: title.value, baseSha: sha.value });
    },
  },
  assign: {
    verb: 'assign',
    grantable: 'opt-in',
    autoAnswerable: false,
    costsModelTurn: false,
    discloses: 'a proposal record — a human click starts any work',
    validate: (args) => {
      const o = asObject(args);
      if (!o.ok) { return o; }
      const title = validateText(o.value.title, LIMITS.title, 'title');
      if (!title.ok) { return fail(title.error); }
      const detail = validateText(o.value.detail, LIMITS.detail, 'detail');
      if (!detail.ok) { return fail(detail.error); }
      const proposalId = validateId(o.value.proposalId, 'proposalId');
      if (!proposalId.ok) { return fail(proposalId.error); }
      return pass({ title: title.value, detail: detail.value, proposalId: proposalId.value });
    },
  },
  followup: {
    verb: 'followup',
    grantable: 'opt-in',
    autoAnswerable: true,
    costsModelTurn: false,
    discloses: 'the status of proposals the caller itself sent',
    validate: (args) => {
      const o = asObject(args);
      if (!o.ok) { return o; }
      if (o.value.cursor !== undefined) {
        const c = validateId(o.value.cursor, 'cursor');
        if (!c.ok) { return fail(c.error); }
        return pass({ cursor: c.value });
      }
      return pass({});
    },
  },
});

/** Every verb name, for enumeration and tests. */
export const DESK_VERB_NAMES: readonly DeskVerb[] =
  Object.freeze(Object.keys(DESK_VERBS) as DeskVerb[]);

/** Is this an accepted verb? Narrows an untrusted string. */
export function isDeskVerb(v: unknown): v is DeskVerb {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DESK_VERBS, v);
}

/**
 * Validate a verb + args pair coming off the wire.
 *
 * An UNGRANTED verb is not distinguishable here from an unknown one — that
 * distinction belongs to the dispatcher, which returns "no such verb" for
 * both so a caller cannot enumerate capabilities it was not granted
 * (plans/21: discovery is authorization-scoped).
 */
export function validateCall(verb: unknown, args: unknown): Validated<{ verb: DeskVerb; args: Record<string, unknown> }> {
  if (!isDeskVerb(verb)) { return fail('unknown verb'); }
  const spec = DESK_VERBS[verb];
  const validated = spec.validate(args);
  if (!validated.ok) { return fail(validated.error); }
  return pass({ verb, args: validated.value });
}
