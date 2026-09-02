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
 * DeskServingGate (Plan 21 Phase 4, invariant I7) — the two consent gates and
 * the effect-block builder.
 *
 * ── What I7 actually says, and why it is one module ────────────────────────
 *
 * "The decision-bearing half of an approval card is extension-computed,
 * complete, escaped, normalized, and never truncated."
 *
 * Every clause is a separate historical failure:
 *
 *   extension-computed — the byte count and the digest come from the REAL
 *     bytes that are about to leave, never from a model's claim about them.
 *     `buildEffectBlock` therefore takes the payload itself and has no
 *     parameter through which a caller could assert `totalBytes` or `sha256`.
 *     A block that lies is not merely discouraged; it is unconstructible here,
 *     and `askDisclosure` re-derives both from the draft it is handed, so a
 *     hand-built block describing payload A cannot be used to approve
 *     payload B.
 *
 *   complete / never truncated — `_runMystiMcpTool` renders a payload preview
 *     with `MAX_PREVIEW = 8000` while Desk-class payloads run to megabytes.
 *     Showing a human 8 KB and sending 4 MB is consent laundering (review
 *     finding P1-6/P2-6). Nothing in this file clips. Where a payload is too
 *     large to render honestly the action is REFUSED, and the refusal names
 *     the exact size and the exact cap, which is loud and recoverable. That is
 *     I21 applied to a card: truncation is an error, never a flag.
 *
 *   escaped — see the escaping note below.
 *
 *   normalized — see the whitespace note below.
 *
 * ── Escaped: why this module escapes, rather than trusting its sink ────────
 *
 * `renderEffectBlock` returns HTML-escaped text. The alternative considered
 * and REJECTED was to return plain text and escape at the sink (the webview),
 * which avoids the cosmetic risk of a double-escaped `&amp;amp;`. It was
 * rejected because this module cannot know its sink — the same string has to
 * be safe in the permission-card markup, in a `showWarningMessage` modal, and
 * in a log line — and an unescaped effect block reaching `innerHTML` is markup
 * injection in the DECISION-BEARING half of the card, which is precisely what
 * I7 exists to prevent. A double-escape is a fidelity nuisance; an unescaped
 * one is a consent bypass. Fail closed.
 *
 * Escaping is the second line regardless: the first is refusal. Every field is
 * validated against a closed shape before it is escaped, so the escaping never
 * has to be the thing that saves us.
 *
 * Escaping and SCANNING are deliberately kept apart. The renderer builds two
 * parallel strings — the escaped one it returns, and a plain one it scans —
 * because `escapeHtml` removes `" ' & < >`, which are exactly the delimiters
 * `EgressScanner`'s secret-shaped-assignment detector needs. Scanning the
 * escaped text (the first version of this file) meant a transport carrying
 * `token="<20 random chars>"` passed the block scan while the identical string
 * blocked on its own: the whole assignment detector, and any future detector
 * that needs a quote, an angle bracket or an ampersand, was blind at exactly
 * the boundary that matters. The plain render is strictly the stronger thing
 * to scan — escaping cannot manufacture a definite finding, since every entity
 * ends in `;`, which breaks the word-boundary-anchored vendor runs, and no
 * entity spells a vendor prefix.
 *
 * ── Normalized: refusal, not repair ────────────────────────────────────────
 *
 * Whitespace normalization here means REFUSING every whitespace character that
 * is not U+0020, plus leading, trailing and doubled spaces. It does not mean
 * rewriting them. Collapsing `src/a  b.ts` to `src/a b.ts` would render a path
 * that is not the path being sent, and a decision-bearing block that shows
 * something other than the truth fails I7 more seriously than it fails
 * aesthetics. Rewriting is also how a validator becomes an oracle
 * (`DeskContract`: drop, do not repair).
 *
 * Unicode composition is deliberately NOT normalized. macOS hands back NFD
 * paths; NFC-ing them would print a path whose bytes differ from the bytes on
 * the wire, which is the same fidelity failure in the other direction.
 *
 * ── Two decisions, never one ───────────────────────────────────────────────
 *
 * `askSpend` asks "run this at all?" — it costs money and attention. It
 * carries the inbound question and NO draft, because at that point no draft
 * exists. `askDisclosure` asks "may these exact bytes leave?" and carries the
 * complete draft. They are separate methods with separate cards on purpose: a
 * single prompt that bundles them means a human who agreed to spend $0.004 has
 * silently agreed to disclose whatever the turn happened to produce. Nothing
 * in this module lets an approval of one satisfy the other; there is no cached
 * decision and no shared state between the two calls.
 *
 * ── Placement: why `src/managers/`, not `src/services/desk/` ───────────────
 *
 * This module is pure and imports no forbidden capability, so it would pass
 * the `src/services/desk/` import-graph assertion. It lives in `managers/`
 * because it is a UI-facing consent surface whose one dependency is an
 * injected `confirm` that must reach `requestPermissionInline`, and because
 * `services/desk/` is the sealed dispatch surface — keeping a card-raising
 * module out of it keeps that assertion about what it says it is about.
 */

import * as crypto from 'crypto';
import type { DeskVerb } from '../types';
import { LIMITS, hasUnsafeChars, validateAlias, validatePath } from '../services/desk/DeskContract';
import { blocksEgress, describeEgressVerdict, scanEgress } from '../services/EgressScanner';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * The decision-bearing half of a Desk card.
 *
 * Every field is either extension-owned (`verb`, `peerAlias`) or derived from
 * bytes this machine measured (`totalBytes`, `sha256`, `paths[].bytes`). None
 * of it is a model's description of itself.
 */
export interface EffectBlock {
  verb: string;
  peerAlias: string;
  fingerprint: string;
  transport: string;
  paths: Array<{ path: string; bytes: number; scan: 'clean' | 'blocked' }>;
  totalBytes: number;
  sha256: string;
  modelId: string;
  retentionClass: string;
}

export interface GateDeps {
  /** Raise a card. MUST be forceInteractive: this leaves the machine. */
  confirm(title: string, body: string, effect: EffectBlock): Promise<boolean>;
  /**
   * The caller's explicit statement that `confirm` reaches the FORCED
   * interactive permission entry point — a card a human must answer, which
   * DENIES on timeout — and not a path that can auto-approve.
   *
   * A comment saying "MUST be forceInteractive" is not a control. Plan 19
   * shipped a `forceInteractive` that did not defeat the permission TIMEOUT
   * auto-approve and silently auto-sent an MCP call; a caller wiring `confirm`
   * to a default permission path with `timeoutBehavior: auto-accept` reopens
   * that bug, and nothing here would notice.
   *
   * This flag does not PROVE the wiring — only the permission layer can, and
   * this module deliberately does not import it (see the placement note). What
   * it does is make the requirement unskippable and reviewable: the literal
   * `true` is required at construction, it cannot be satisfied by an object
   * that merely has a `confirm`, and it names the property a reviewer must
   * check at the one call site that sets it.
   */
  confirmIsForcedInteractive: true;
  /**
   * Optional refusal sink, for the audit trail.
   *
   * Not decoration: without it a refusal and a human clicking Deny are the
   * same `false`, and I22 needs to tell them apart — one is a human decision,
   * the other is a control that fired.
   */
  onRefusal?(reason: GateRefusalReason, detail: string): void;
}

export type GateRefusalReason =
  | 'invalid-field'
  | 'invalid-path'
  | 'invalid-estimate'
  | 'unrenderable'
  | 'secret-in-effect-block'
  | 'secret-in-payload'
  | 'path-scan-blocked'
  | 'effect-block-mismatch'
  | 'payload-too-large'
  | 'confirm-failed'
  /**
   * Not a control firing: a bug in this module (a TypeError, a RangeError, a
   * throwing accessor on a caller's block). Kept distinct because I22's whole
   * purpose is telling a human Deny from a control that fired, and a sink that
   * files a crash as 'invalid-field' cannot tell a control from a crash — nor
   * can a test that asserts the reason.
   */
  | 'internal-error';

/** A refusal. Thrown, never returned as a flag on a partial result (I21). */
export class EffectBlockError extends Error {
  constructor(public readonly reason: GateRefusalReason, message: string) {
    super(message);
    this.name = 'EffectBlockError';
  }
}

function refuse(reason: GateRefusalReason, message: string): never {
  throw new EffectBlockError(reason, message);
}

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

/**
 * Exhaustiveness anchor. `Record<DeskVerb, true>` fails `tsc` the moment
 * `types.ts` grows a verb, so a new verb cannot silently become unrenderable
 * (or, worse, render through a fallback path nobody reviewed).
 */
const DESK_VERB_SET: Record<DeskVerb, true> = {
  status: true, locate: true, consult: true, review: true,
  handoff: true, assign: true, followup: true,
};

/**
 * The spend gate is not a wire verb — nothing is sent — but its card carries
 * an effect block for the same reason every other card does, so the renderer
 * has exactly one shape to handle.
 */
export const SPEND_VERB = 'spend';

const RENDERABLE_VERBS: ReadonlySet<string> =
  new Set<string>([...Object.keys(DESK_VERB_SET), SPEND_VERB]);

/**
 * Placeholder for a field a given decision does not bear on (the spend card
 * has no transport and no digest of anything outbound). Spelled out rather
 * than left blank so a reader can tell "not part of this decision" from "we
 * failed to determine it".
 */
export const NOT_APPLICABLE = 'not-applicable';

/**
 * I9 retention classes, closed. A peer that attests
 * `"zero-retention (see our policy)"` must NOT render as zero-retention, and
 * an allowlist is the only way to guarantee the reader's eye is not the parser.
 */
const RETENTION_CLASSES: ReadonlySet<string> =
  new Set<string>(['zero-retention', 'logged', 'training-permitted', NOT_APPLICABLE]);

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Render bounds are module constants, not instance options, because
 * `renderEffectBlock` is a free function: a per-instance render cap would be
 * unenforceable at the boundary that matters and would exist only to look
 * configurable.
 */
export const MAX_EFFECT_PATHS = 200;
export const MAX_RENDER_CHARS = 65_536;

/** Field caps. Long enough for a real value, short enough to stay readable. */
const FIELD_CAPS = {
  fingerprint: 128,
  transport: 200,
  modelId: 200,
  verb: 32,
  retentionClass: 64,
} as const;

const FINGERPRINT_RE = /^[A-Za-z0-9_.:-]{4,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface GateLimits {
  /** Hard ceiling on a draft, in UTF-8 bytes. Above it: refuse, never clip. */
  maxDraftBytes: number;
  /** Hard ceiling on an inbound question, in characters. */
  maxQuestionChars: number;
}

export const GATE_LIMIT_DEFAULTS: Readonly<GateLimits> = Object.freeze({
  maxDraftBytes: 1_048_576,
  maxQuestionChars: LIMITS.question,
});

/**
 * Absolute ceilings. A caller may lower a limit; it may never raise one past
 * these. Mirrors the settings rule that a less-trusted scope may only LOWER
 * authority.
 */
export const GATE_LIMIT_CEILINGS: Readonly<GateLimits> = Object.freeze({
  maxDraftBytes: 4_194_304,
  /**
   * The wire contract's own question cap, not a looser number. This was 20 000,
   * five times what `validateCall` accepts, which made the gate a WEAKER check
   * than the parser it is supposed to back up: any caller reaching `askSpend`
   * with a question that did not come through `validateCall` could put 20 000
   * characters on a consent card. A second enforcement of a bound is only
   * worth having if it is at least as tight as the first.
   */
  maxQuestionChars: LIMITS.question,
});

/**
 * Resolve one numeric option.
 *
 * This exists because `{ ...DEFAULTS, ...opts }` is wrong for options that
 * arrive from `cfg.get<number>('unset')`: that returns `undefined`, the spread
 * OVERWRITES the default with it, and every subsequent comparison against
 * `undefined`/`NaN` is false — so the limit silently stops limiting. That exact
 * bug disabled a rate limiter and a body cap earlier in this plan.
 *
 * Direction matters. A value ABOVE the ceiling is a request for more authority
 * than this module grants, and it falls back to the DEFAULT rather than being
 * clamped to the ceiling: a caller asking for a 10 GB draft cap is confused,
 * and quietly handing them 4 MiB looks like their request was honoured.
 *
 * A value BELOW the floor is the opposite request — less authority — and is
 * clamped DOWN to the floor rather than bounced to the default. Falling back
 * to the default there was a real inversion: `0` and every negative meant
 * "allow nothing", and the module answered with 1 MiB. "A caller may lower,
 * never raise" has to hold for the confused caller too, and a floor of 1 byte
 * refuses loudly instead of quietly permitting a megabyte.
 */
function resolveLimit(name: string, raw: unknown, def: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    if (raw !== undefined) {
      console.warn(`[Mysti] DeskServingGate: ignoring non-finite ${name}, using ${def}`);
    }
    return def;
  }
  const n = Math.floor(raw);
  if (n > max) {
    console.warn(`[Mysti] DeskServingGate: ${name}=${n} above ceiling ${max}, using ${def}`);
    return def;
  }
  if (n < min) {
    console.warn(`[Mysti] DeskServingGate: ${name}=${n} below floor ${min}, clamping to ${min}`);
    return min;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Character discipline
// ---------------------------------------------------------------------------

/**
 * Any whitespace that is not U+0020. `hasUnsafeChars` already refuses tab,
 * newline and CR as C0 controls; this catches the Unicode spaces it does not
 * know about — NBSP, the U+2000 block, U+2028/9, ideographic space — each of
 * which can forge column alignment in a fixed-layout card.
 */
const NON_PLAIN_SPACE_RE = /[^\S ]/u;

/** Interlinear annotation marks: bidi-adjacent, outside `hasUnsafeChars`. */
const ANNOTATION_RE = /[\uFFF9-\uFFFB]/;

/**
 * Invisible characters that are neither controls, nor bidi marks, nor in the
 * short zero-width list `DeskContract.hasUnsafeChars` knows: soft hyphen,
 * combining grapheme joiner, the Hangul and Khmer fillers, the Mongolian and
 * invisible-operator blocks, the variation selectors, and the U+E0000 TAG
 * block — the standard modern hidden-text vector, since a tag sequence renders
 * as nothing at all and survives copy/paste intact.
 *
 * Without this, two model ids or two cited paths could be visually identical
 * and differ in the decision-bearing half of the card, which is the exact
 * property the "refuse, do not repair" rule above claims to hold. Refused
 * rather than stripped, for the same reason nothing else here is repaired:
 * printing a value that is not the value in use is the failure, not the
 * cosmetics.
 *
 * Applied to FIELDS and PATHS only, never to prose. A draft is human-written
 * text where U+FE0F is how half the emoji in a code review are spelled;
 * refusing an answer for containing one would delete something a legitimate
 * user needs, and prose already refuses the zero-width characters that can
 * hide a discriminator.
 */
// Every code point in this class is meant to match ON ITS OWN. The lint rule
// below fires because several of them (U+034F, the variation selectors) are
// combining marks, and a class containing one can be misread as matching a
// whole grapheme; here the singleton match IS the check. Each is written as an
// escape rather than as a literal so it stays legible in the source of a file
// about invisible characters.
const INVISIBLE_RE =
  // eslint-disable-next-line no-misleading-character-class
  /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2060-\u2064\u206A-\u206F\u3164\uFE00-\uFE0F\uFFA0]|[\u{E0000}-\u{E0FFF}]/u;

/**
 * Controls that are never legitimate inside prose (tab/LF/CR excepted).
 *
 * The lint rule below exists to catch a control character typed into a pattern
 * by accident; matching them deliberately is this constant's entire job.
 */
// eslint-disable-next-line no-control-regex
const PROSE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Bidi overrides/isolates and zero-width characters. */
const PROSE_BIDI_ZW_RE =
  /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF\uFFF9-\uFFFB]/;

/**
 * HTML escaping. `&` first, or the entities produced by the later rules get
 * re-escaped into visible garbage.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A single-line, decision-bearing field. Refuses everything it cannot render
 * faithfully; returns the value unmodified (escaping happens at render time,
 * once).
 */
function requireField(field: string, v: unknown, max: number): string {
  if (typeof v !== 'string') { refuse('invalid-field', `${field} must be a string`); }
  if (v.length === 0) { refuse('invalid-field', `${field} must not be empty`); }
  if (v.length > max) { refuse('invalid-field', `${field} exceeds ${max} chars`); }
  if (hasUnsafeChars(v) || ANNOTATION_RE.test(v)) {
    refuse('invalid-field', `${field} contains control, bidi or zero-width characters`);
  }
  if (INVISIBLE_RE.test(v)) {
    refuse('invalid-field', `${field} contains invisible or default-ignorable characters`);
  }
  if (NON_PLAIN_SPACE_RE.test(v)) {
    refuse('invalid-field', `${field} contains non-plain whitespace`);
  }
  if (v !== v.trim() || v.includes('  ')) {
    refuse('invalid-field', `${field} has leading, trailing or doubled spaces`);
  }
  return v;
}

/**
 * Untrusted prose bound for the CONTENT block: an inbound question, or a draft
 * this machine's own model wrote. Newlines and tabs are legitimate here, so
 * only the non-whitespace controls are refused. NOT trimmed — the draft has to
 * stay byte-identical to what was hashed, or the digest binding in
 * `askDisclosure` would compare a different string than the one being sent.
 *
 * Zero-width characters are refused even though that also refuses an emoji ZWJ
 * sequence. Accepted cost: U+200B is the canonical way to hide a discriminator
 * inside text a human is about to approve, and a family emoji in a code review
 * is worth less than that guarantee.
 */
function requireProse(field: string, v: unknown, maxChars: number): string {
  if (typeof v !== 'string') { refuse('invalid-field', `${field} must be a string`); }
  if (v.trim().length === 0) { refuse('invalid-field', `${field} must not be empty`); }
  if (v.length > maxChars) {
    refuse('payload-too-large',
      `${field} is ${v.length} chars, cap is ${maxChars} — refused, not truncated`);
  }
  if (PROSE_CONTROL_RE.test(v)) { refuse('invalid-field', `${field} contains control characters`); }
  if (PROSE_BIDI_ZW_RE.test(v)) {
    refuse('invalid-field', `${field} contains bidi or zero-width characters`);
  }
  return v;
}

/**
 * The alias is the ONLY name rendered anywhere (I12), so its shape is the whole
 * defence against a spoofed display name. `DeskContract` owns that regex;
 * duplicating it here would let the two drift.
 */
function requireAlias(v: unknown): string {
  const r = validateAlias(v);
  if (!r.ok) { refuse('invalid-field', `peerAlias: ${r.error}`); }
  return r.value;
}

/**
 * A cited path, validated the same way at build time and at render time.
 * `validatePath` permits an interior space; the card's fixed alignment does
 * not, and a leading space is enough to fake an indentation level.
 */
function requirePath(v: unknown): string {
  const r = validatePath(v, 'citedPath');
  if (!r.ok) { refuse('invalid-path', r.error); }
  const p = r.value;
  if (INVISIBLE_RE.test(p)) {
    refuse('invalid-path', 'citedPath contains invisible or default-ignorable characters');
  }
  if (NON_PLAIN_SPACE_RE.test(p) || p !== p.trim() || p.includes('  ')) {
    refuse('invalid-path', `citedPath "${p}" has non-plain, leading, trailing or doubled whitespace`);
  }
  return p;
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export interface EffectBlockInput {
  verb: string;
  peerAlias: string;
  fingerprint: string;
  transport: string;
  payload: string;
  citedPaths: string[];
  modelId: string;
  retentionClass: string;
}

/** The header fields, validated identically wherever a block enters. */
function validateHeader(src: {
  verb: unknown; peerAlias: unknown; fingerprint: unknown;
  transport: unknown; modelId: unknown; retentionClass: unknown;
}): Pick<EffectBlock, 'verb' | 'peerAlias' | 'fingerprint' | 'transport' | 'modelId' | 'retentionClass'> {
  const verb = requireField('verb', src.verb, FIELD_CAPS.verb);
  if (!RENDERABLE_VERBS.has(verb)) { refuse('invalid-field', `verb "${verb}" is not a Desk verb`); }
  const peerAlias = requireAlias(src.peerAlias);
  const fingerprint = requireField('fingerprint', src.fingerprint, FIELD_CAPS.fingerprint);
  if (!FINGERPRINT_RE.test(fingerprint)) {
    refuse('invalid-field', `fingerprint must match ${FINGERPRINT_RE.source}`);
  }
  const transport = requireField('transport', src.transport, FIELD_CAPS.transport);
  const modelId = requireField('modelId', src.modelId, FIELD_CAPS.modelId);
  const retentionClass = requireField('retentionClass', src.retentionClass, FIELD_CAPS.retentionClass);
  if (!RETENTION_CLASSES.has(retentionClass)) {
    refuse('invalid-field', `retentionClass "${retentionClass}" is not an attested class`);
  }
  return { verb, peerAlias, fingerprint, transport, modelId, retentionClass };
}

/**
 * Build the decision-bearing block from the REAL payload.
 *
 * `totalBytes` and `sha256` are measured, not accepted: there is deliberately
 * no input through which a caller (or a model driving one) could assert them.
 *
 * `paths[].bytes` is the count of CONTENT bytes disclosed from that file, and
 * for a consult/review answer it is 0 — the answer cites coordinates, and the
 * only bytes leaving are the answer itself, counted once in `totalBytes`. The
 * rejected alternative was to report the byte length of the path STRING, which
 * makes the most decision-relevant number on the card ambiguous ("1842 bytes,
 * and 22 more?"). A reader seeing `0 content bytes` learns something true and
 * load-bearing: no file content crosses. Phase 5's bundle builder fills the
 * same field from real file sizes.
 *
 * Throws `EffectBlockError` rather than returning a partial block. A block that
 * cannot be rendered in full is not a block.
 */
export function buildEffectBlock(input: EffectBlockInput): EffectBlock {
  if (input === null || typeof input !== 'object') {
    refuse('invalid-field', 'effect block input must be an object');
  }

  const header = validateHeader(input);

  if (typeof input.payload !== 'string') {
    refuse('invalid-field', 'payload must be a string');
  }

  if (!Array.isArray(input.citedPaths)) {
    refuse('invalid-path', 'citedPaths must be an array');
  }
  if (input.citedPaths.length > MAX_EFFECT_PATHS) {
    refuse('unrenderable',
      `${input.citedPaths.length} cited paths exceeds ${MAX_EFFECT_PATHS} — refused, not truncated`);
  }

  const seen = new Set<string>();
  const paths: EffectBlock['paths'] = [];
  for (const raw of input.citedPaths) {
    const p = requirePath(raw);
    // Refuse a duplicate rather than de-duplicating it. De-duplication is a
    // silent edit of the decision-bearing half, and a caller emitting the same
    // citation twice is confused about what it is disclosing.
    //
    // The render boundary refuses this too, and the two messages differ ON
    // PURPOSE: identical messages made this check an equivalent mutant —
    // deleting it left the suite green, because `buildEffectBlock` proves the
    // render and the render refused with the same words. Naming the boundary
    // keeps each one independently pinnable, and tells an audit reader which
    // one fired.
    if (seen.has(p)) { refuse('invalid-path', `citedPaths lists "${p}" twice`); }
    seen.add(p);
    // A path is itself disclosure, and a path can carry credential material
    // (`secrets/sk_live_...`).
    //
    // The first version RECORDED a blocked verdict here and let the card show
    // it, on the theory that a flagged citation should stay visible. That is
    // unreachable: the rendered block is scanned as a whole, so a credential in
    // a path refuses at the render step anyway — just with the wrong reason
    // attached. Refusing here instead keeps the reason accurate and refuses one
    // step earlier. The offending path is NOT echoed, matching DeskRedactor:
    // repeating it is disclosing the thing the check exists to withhold.
    //
    // `scan` survives on the block because externally-assembled blocks do carry
    // per-file verdicts — Phase 5's bundle card lists files with checkboxes and
    // a flagged file is merely uncheckable — and because `askDisclosure`
    // re-checks it for any block this builder did not make.
    if (blocksEgress(scanEgress(p))) {
      refuse('path-scan-blocked', 'a cited path carries credential material');
    }
    paths.push({ path: p, bytes: 0, scan: 'clean' });
  }

  const block: EffectBlock = {
    ...header,
    paths,
    totalBytes: Buffer.byteLength(input.payload, 'utf8'),
    sha256: sha256Hex(input.payload),
  };

  // Prove it renders IN FULL before anyone can hold it. A block that exists but
  // cannot be shown honestly is how "well, we showed them something" happens.
  renderEffectBlock(block);
  return block;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 12;

function row(label: string, value: string): string {
  return '  ' + label.padEnd(LABEL_WIDTH, ' ') + value;
}

/**
 * Validate a block completely, render it, and hand back BOTH the rendered
 * string and a frozen copy built from the validated values.
 *
 * Every field is RE-validated here rather than trusted from the block object:
 * `EffectBlock` is a plain interface, so anything can construct one, and the
 * render boundary is the last place before a human reads it. A block whose path
 * contained a newline could otherwise forge an extra `verb  status` row.
 *
 * The validated COPY is the point of the return shape. Validating in place and
 * then reading `block.verb` again downstream is validation by side effect: a
 * caller's object can carry an accessor that answers 'alice' to this function
 * and 'Not-Alice The Bank' to the next read, which is exactly the spoofed
 * display name I12 exists to forbid, arriving through the one field the card's
 * title interpolates. Nothing downstream may touch the caller's object again.
 * The copy is frozen so a later mutation cannot reach the audit sink either.
 *
 * The digest is printed in full. An abbreviated hash is not a hash — two
 * payloads sharing a 12-char prefix is a party trick — and the operator who
 * later compares what arrived against what was approved needs all 64.
 */
function renderChecked(block: EffectBlock): { block: EffectBlock; rendered: string } {
  if (block === null || typeof block !== 'object') {
    refuse('invalid-field', 'effect block must be an object');
  }

  const header = validateHeader(block);

  // Read each field ONCE, into a local. Everything below — and everything the
  // caller does with the returned copy — uses the local, never a second read.
  const totalBytes: number = block.totalBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    refuse('invalid-field', 'totalBytes must be a non-negative safe integer');
  }
  const sha256: string = block.sha256;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    refuse('invalid-field', 'sha256 must be 64 lowercase hex chars');
  }
  const rawPaths = block.paths;
  if (!Array.isArray(rawPaths)) { refuse('invalid-path', 'paths must be an array'); }
  if (rawPaths.length > MAX_EFFECT_PATHS) {
    refuse('unrenderable',
      `${rawPaths.length} paths exceeds ${MAX_EFFECT_PATHS} — refused, not truncated`);
  }

  // Two parallel renders of the same content: `lines` is escaped and returned,
  // `plain` is what the egress scan reads. See the escaping note in the file
  // header for why scanning the escaped form was a hole rather than a saving.
  const lines: string[] = ['EFFECT'];
  const plain: string[] = ['EFFECT'];
  const add = (label: string, plainValue: string, escapedValue: string): void => {
    plain.push(row(label, plainValue));
    lines.push(row(label, escapedValue));
  };
  const addField = (label: string, v: string): void => { add(label, v, escapeHtml(v)); };
  /** A value this module produced (a count, a hex digest): nothing to escape. */
  const addOwn = (label: string, v: string): void => { add(label, v, v); };

  addField('verb', header.verb);
  add('to', `"${header.peerAlias}"`, `"${escapeHtml(header.peerAlias)}"`);
  addField('key', header.fingerprint);
  addField('over', header.transport);
  addField('model', header.modelId);
  addField('retention', header.retentionClass);
  addOwn('bytes', String(totalBytes));
  addOwn('sha256', sha256);
  addOwn('cites', `${rawPaths.length} path(s)`);

  const seen = new Set<string>();
  const paths: EffectBlock['paths'] = [];
  for (const entry of rawPaths) {
    if (entry === null || typeof entry !== 'object') {
      refuse('invalid-path', 'a cited path entry is not an object');
    }
    const p = requirePath(entry.path);
    // Refuse a repeat, exactly as `buildEffectBlock` does. The two boundaries
    // have to enforce the SAME set or "re-validated at both boundaries" is a
    // claim rather than a property: a hand-built block was rendering
    // `src/a.ts` twice under `cites  2 path(s)`, and de-duplicating it at the
    // render step would have been the silent edit of the decision-bearing half
    // that the build step refuses.
    if (seen.has(p)) { refuse('invalid-path', `citedPath "${p}" is listed twice`); }
    seen.add(p);
    const bytes: number = entry.bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      refuse('invalid-path', `citedPath "${p}" has a non-integer byte count`);
    }
    const scan = entry.scan;
    if (scan !== 'clean' && scan !== 'blocked') {
      refuse('invalid-path', `citedPath "${p}" has an unrecognised scan verdict`);
    }
    const tail = `  (${bytes} content bytes)  scan ${scan}`;
    plain.push(`    ${p}${tail}`);
    lines.push(`    ${escapeHtml(p)}${tail}`);
    paths.push({ path: p, bytes, scan });
  }

  const rendered = lines.join('\n');
  // Capped on the ESCAPED string: it is the longer of the two and the one a
  // human is actually handed.
  if (rendered.length > MAX_RENDER_CHARS) {
    refuse('unrenderable',
      `effect block renders to ${rendered.length} chars, cap is ${MAX_RENDER_CHARS} — refused, not truncated`);
  }

  // Last check on the decision-bearing half itself, over the PLAIN text. A
  // transport URL carrying a query-string credential, or a model id someone
  // pasted a key into, would otherwise be disclosed by the very surface that
  // exists to prevent disclosure. A hit refuses; it never raises a card,
  // because a human cannot usefully adjudicate "is this token live?" (I5).
  const verdict = scanEgress(plain.join('\n'));
  if (blocksEgress(verdict)) {
    refuse('secret-in-effect-block',
      `effect block would disclose credential material: ${describeEgressVerdict(verdict)}`);
  }

  for (const entry of paths) { Object.freeze(entry); }
  Object.freeze(paths);
  const checked: EffectBlock = { ...header, paths, totalBytes, sha256 };
  Object.freeze(checked);
  return { block: checked, rendered };
}

/** The rendered block alone, for callers that need nothing else. */
export function renderEffectBlock(block: EffectBlock): string {
  return renderChecked(block).rendered;
}

/**
 * Format a USD estimate.
 *
 * Rounds UP, always. A card that shows $0.0000 for a $0.00004 turn is
 * technically rounded and practically a lie; a consent surface must never
 * understate what it is asking for.
 */
function formatUsd(usd: number): string {
  return '$' + (Math.ceil(usd * 10_000) / 10_000).toFixed(4);
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

export class DeskServingGate {
  private readonly _deps: GateDeps;
  private readonly _limits: GateLimits;

  constructor(deps: GateDeps, opts?: Partial<GateLimits>) {
    if (deps === null || typeof deps !== 'object' || typeof deps.confirm !== 'function') {
      throw new Error('[Mysti] DeskServingGate requires a confirm() dependency');
    }
    // The literal `true`, not a truthy value: the same rule `_ask` applies to
    // the answer, for the same reason. See `GateDeps.confirmIsForcedInteractive`
    // for what this does and does not prove.
    if (deps.confirmIsForcedInteractive !== true) {
      throw new Error(
        '[Mysti] DeskServingGate requires confirm() to be the forced-interactive '
        + 'permission entry point (set confirmIsForcedInteractive: true at the call site)');
    }
    this._deps = deps;
    // Each option is resolved individually, never spread over the defaults.
    // See `resolveLimit` for why the spread form is a live hazard.
    this._limits = {
      maxDraftBytes: resolveLimit(
        'maxDraftBytes', opts?.maxDraftBytes,
        GATE_LIMIT_DEFAULTS.maxDraftBytes, 1, GATE_LIMIT_CEILINGS.maxDraftBytes),
      maxQuestionChars: resolveLimit(
        'maxQuestionChars', opts?.maxQuestionChars,
        GATE_LIMIT_DEFAULTS.maxQuestionChars, 1, GATE_LIMIT_CEILINGS.maxQuestionChars),
    };
  }

  /** The resolved bounds, for tests and for a diagnostic surface. */
  get limits(): Readonly<GateLimits> { return { ...this._limits }; }

  /**
   * Gate 1 — spend. "run this at all?"
   *
   * Carries the inbound question in full and no draft, because none exists yet.
   * Approving this approves a local model turn, and nothing leaving.
   *
   * `attest` is optional and additive: when the callee has already resolved
   * which model will process the payload, naming it here satisfies I9's "both
   * cards name the model" without changing the required signature.
   */
  async askSpend(
    peerAlias: string,
    question: string,
    estimateUsd: number,
    attest?: { modelId: string; retentionClass: string },
  ): Promise<boolean> {
    try {
      const alias = requireAlias(peerAlias);

      // NaN and Infinity are refused rather than displayed. `$NaN` on a consent
      // card is not a price, and a comparison against it downstream would be
      // false in both directions — the exact shape of the bug that disabled a
      // cap earlier in this plan.
      if (typeof estimateUsd !== 'number' || !Number.isFinite(estimateUsd)) {
        refuse('invalid-estimate', 'estimateUsd must be a finite number');
      }
      if (estimateUsd < 0) { refuse('invalid-estimate', 'estimateUsd must not be negative'); }
      if (estimateUsd > 1_000_000) { refuse('invalid-estimate', 'estimateUsd is implausible'); }

      const q = requireProse('question', question, this._limits.maxQuestionChars);

      // The spend block describes what ARRIVED, not what will leave: nothing
      // leaves at gate 1. The digest lets the audit trail join this decision to
      // the disclosure decision that may follow it.
      const block = buildEffectBlock({
        verb: SPEND_VERB,
        peerAlias: alias,
        fingerprint: NOT_APPLICABLE,
        transport: NOT_APPLICABLE,
        payload: q,
        citedPaths: [],
        modelId: attest?.modelId ?? NOT_APPLICABLE,
        retentionClass: attest?.retentionClass ?? NOT_APPLICABLE,
      });

      const checked = renderChecked(block);

      // The inbound question is SCANNED but never refused on. Nothing leaves
      // this machine at gate 1, so a credential inside a peer's question is not
      // an I5 egress break — and refusing here would delete a legitimate
      // question ("why does ghp_… get rejected?") that a human has every right
      // to read and answer. What it IS is information the human needs before
      // approving a turn whose answer may quote it, so the verdict is surfaced
      // on the card. `describeEgressVerdict` is value-free by construction, so
      // the note cannot itself become the disclosure.
      const qVerdict = scanEgress(q);
      const qNote = blocksEgress(qVerdict)
        ? `\n  [egress scan: ${describeEgressVerdict(qVerdict)}`
          + ' — nothing leaves the machine at gate 1, and an answer quoting this'
          + ' is refused at gate 2]'
        : '';

      const title = `Run a Desk serving turn for "${alias}"? (${formatUsd(estimateUsd)})`;
      const body = [
        checked.rendered,
        row('estimate', formatUsd(estimateUsd)),
        '',
        `QUESTION (${q.length} chars, written by "${alias}", untrusted, complete)${qNote}`,
        escapeHtml(q),
      ].join('\n');

      return await this._ask(title, body, checked.block);
    } catch (e) {
      return this._refused(e);
    }
  }

  /**
   * Gate 2 — disclosure. The COMPLETE draft, verbatim, never truncated.
   *
   * The draft is bound to the block by size and digest before anything is
   * shown. That binding is the whole anti-laundering property: a block built
   * from a 1 KB summary cannot be used to approve the 4 MB artifact that
   * actually gets sent.
   */
  async askDisclosure(block: EffectBlock, draft: string): Promise<boolean> {
    try {
      if (typeof draft !== 'string') { refuse('invalid-field', 'draft must be a string'); }

      // Validate and SNAPSHOT the block before reading a single field off it.
      // Everything below uses `checked`; `block` is never touched again. A
      // caller's object may carry accessors, and validating one read while a
      // later read returns something else is how the card title came to render
      // an unvalidated display name. `renderChecked` also refuses a non-object
      // block, so there is no separate object guard here to drift out of sync.
      const checked = renderChecked(block);
      const effect = checked.block;

      // Gate 2 is the ONE card that authorises bytes leaving, so it must name
      // where they go. A block with `verb: 'spend'`, or with any outbound field
      // left at NOT_APPLICABLE, renders `Send a spend answer to "alice"?` over
      // `key not-applicable / over not-applicable / model not-applicable /
      // retention not-applicable` — a human approving a disclosure with no
      // peer key, no transport, no serving model and no retention class named,
      // which is I9 and I12 unenforced at the only boundary that matters. The
      // spend pseudo-verb is refused outright: its own header says nothing is
      // sent, so it cannot be the verb on a card that sends.
      if (effect.verb === SPEND_VERB) {
        refuse('invalid-field',
          `verb "${SPEND_VERB}" names no wire effect and may not authorise a disclosure`);
      }
      for (const [name, value] of [
        ['fingerprint', effect.fingerprint],
        ['transport', effect.transport],
        ['modelId', effect.modelId],
        ['retentionClass', effect.retentionClass],
      ] as const) {
        if (value === NOT_APPLICABLE) {
          refuse('invalid-field',
            `${name} is "${NOT_APPLICABLE}" — a disclosure card must name where the bytes go`);
        }
      }

      // Size first: refuse a 4 MB draft before spending a hash on it.
      const bytes = Buffer.byteLength(draft, 'utf8');
      if (bytes > this._limits.maxDraftBytes) {
        refuse('payload-too-large',
          `draft is ${bytes} bytes, cap is ${this._limits.maxDraftBytes} — refused, not truncated`);
      }

      if (effect.totalBytes !== bytes) {
        refuse('effect-block-mismatch',
          `effect block claims ${String(effect.totalBytes)} bytes, draft is ${bytes}`);
      }
      // Constant-time by construction over fixed-length digests. Neither side is
      // a secret, so this is not load-bearing here — it is the house style for
      // digest comparison (I12), and using it removes the question. Both buffers
      // are 32 bytes because `renderChecked` already proved the digest's shape;
      // `timingSafeEqual` throws on a length mismatch, and a throw here would be
      // filed as an internal error rather than as a control firing.
      const actual = Buffer.from(sha256Hex(draft), 'hex');
      const claimed = Buffer.from(effect.sha256, 'hex');
      if (!crypto.timingSafeEqual(actual, claimed)) {
        refuse('effect-block-mismatch', 'effect block digest does not match the draft');
      }

      // Character discipline on the draft. `requireProse` does not trim, so the
      // bytes just hashed are the bytes rendered and the bytes sent.
      //
      // The cap passed here is a CHARACTER cap that happens to be derived from
      // the byte cap. UTF-8 never spends fewer than one byte per character, so
      // `maxDraftBytes` characters is a bound at least as tight as the byte
      // check above — it is passed as its own named value precisely so the two
      // units are not confused if that check ever moves or changes shape.
      const maxDraftChars = this._limits.maxDraftBytes;
      requireProse('draft', draft, maxDraftChars);

      // A flagged citation is visible on the card but never sendable. The build
      // path already records the verdict; this catches a block assembled some
      // other way, which is the only route by which a 'blocked' entry gets here.
      const flagged = effect.paths.filter(pth => pth.scan === 'blocked');
      if (flagged.length > 0) {
        refuse('path-scan-blocked', `${flagged.length} cited path(s) failed egress screening`);
      }

      // Content screening. A hit REFUSES and never raises a card: asking a human
      // "is this 40-char string a credential?" gets a click-through, so asking
      // is worse than useless (I5).
      const verdict = scanEgress(draft);
      if (blocksEgress(verdict)) {
        refuse('secret-in-payload',
          `draft would disclose credential material: ${describeEgressVerdict(verdict)}`);
      }

      // Both interpolations come from the validated SNAPSHOT — the verb from a
      // closed set, the alias from the local-alias regex — so the title cannot
      // be steered by anything remote, and cannot be steered by a second read
      // of the caller's object either (I8/I12).
      const title = `Send a ${effect.verb} answer to "${effect.peerAlias}"?`;
      const body = [
        checked.rendered,
        '',
        `CONTENT (${draft.length} chars, ${bytes} bytes, complete, written by your agent)`,
        escapeHtml(draft),
      ].join('\n');

      return await this._ask(title, body, effect);
    } catch (e) {
      return this._refused(e);
    }
  }

  /**
   * Raise the card. Only the literal `true` approves: a dependency that returns
   * a truthy string, a non-empty object, or a resolved-but-undefined promise is
   * a bug, and reading a bug as consent is the worst available failure
   * direction here.
   */
  private async _ask(title: string, body: string, block: EffectBlock): Promise<boolean> {
    let answer: unknown;
    try {
      answer = await this._deps.confirm(title, body, block);
    } catch (e) {
      return this._refused(new EffectBlockError(
        'confirm-failed', `confirm() threw: ${e instanceof Error ? e.message : String(e)}`));
    }
    return answer === true;
  }

  private _refused(e: unknown): false {
    // Anything that is not an EffectBlockError is a BUG here, not a control
    // that fired, and the audit trail has to say so: I22 exists to tell a
    // human Deny from a control, and it cannot do that if a crash is filed
    // under the same reason a validator uses.
    const reason: GateRefusalReason =
      e instanceof EffectBlockError ? e.reason : 'internal-error';
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[Mysti] DeskServingGate refused (${reason}): ${detail}`);
    try {
      this._deps.onRefusal?.(reason, detail);
    } catch {
      // A broken audit sink must never turn a refusal into an approval.
    }
    return false;
  }
}
