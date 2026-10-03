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
 * DeskStandup (Plan 21 Phase 6, invariants I19/I21/I12/I32) — the team digest.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `DeskBoard.fnew` answers "what is the state of ONE board". A standup asks
 * "what is every peer on my roster reporting", which is the same fold run per
 * peer plus attribution. That is all this module is: a composition, with no
 * new state and no new authority.
 *
 * Model-free, randomness-free and ambient-time-free, for the same reason
 * `renderStandup` is: two people must be able to point at the same sentence
 * and know it derives from the same signed events. A generated summary is
 * none of those things. `now` is injected; no clock is read here.
 *
 * ── Byte-identical, and why that costs vigilance ───────────────────────────
 *
 * Every ordering decision is a plain code-unit comparison. `localeCompare` is
 * BANNED in this file: it resolves through ICU, so two machines with different
 * locale data would sort two peers differently and the digest would stop being
 * comparable — which is the entire point of it being deterministic. The same
 * argument bans ICU-derived character classes (`\p{Cf}` and friends): the set
 * they match changes with the host's Unicode version, so the escape class
 * below is written out as explicit code-point ranges instead.
 *
 * No absolute time is rendered either. A formatted timestamp needs a timezone,
 * and the timezone is a property of the machine, not of the events. Lease
 * remainders are relative to the injected `now`, so they stay reproducible.
 *
 * ── Every string here is untrusted, and so is every TYPE ────────────────────
 *
 * Task titles and owner ids arrive from peers (I12: a body-supplied display
 * name is never honoured, but a `propose` title legitimately crosses). Peer
 * aliases are LOCAL — the human typed them — yet the roster is a JSON store on
 * disk, so a corrupted or hand-edited record must not be able to forge output
 * either. Three separate attacks are in scope:
 *
 *  1. Fence escape — a newline, bidi override or invisible character inside a
 *     title, forging a heading, a bucket label, or a reordered line. Every
 *     such character is escaped to visible `\uXXXX` text.
 *  2. Attribution spoofing INSIDE one line — a title of
 *     `fix" .. "root` reads as another peer's work once the line is composed.
 *     Peer-supplied spans are therefore quote-DELIMITED, and a quote inside
 *     the span is escaped, so the delimiters are unambiguous.
 *  3. TYPE confusion — a wire event is JSON, so `title` can arrive as an
 *     ARRAY, a number or an object however the TypeScript signature reads.
 *     `DeskBoard.fold` copies those fields through verbatim and DeskContract
 *     has no board-event validator, so a `for..of` over a `string[]` would
 *     test each ELEMENT as one unit and emit `fix" - "root` RAW. Every span is
 *     therefore rendered through `_span`, which refuses a non-string outright,
 *     and `_escapeInline` THROWS on one rather than trusting its annotation.
 *
 * Escaping was chosen over dropping for characters: it is lossless and
 * reversible, so a human reading the digest still sees that something odd was
 * sent rather than seeing a silently cleaned string.
 *
 * ── The escape class is wider than the wire class, on purpose ──────────────
 *
 * `DeskContract.hasUnsafeChars` is still queried, so nothing the WIRE refuses
 * can be rendered here. But it is an under-approximation, which a boundary
 * that REJECTS can afford and a renderer that ESCAPES cannot: U+2028/2029 are
 * line terminators, U+2060-2064 / U+00AD / U+FFF9-FFFB are invisible, and the
 * U+E0000-E007F tag block is the standard channel for smuggling instructions
 * into a model — and this digest is model-facing text. `_isRenderUnsafe` is
 * therefore the UNION of the contract's class and an explicit local one that
 * covers every format character, both line separators, lone surrogates and the
 * noncharacters. An allowlist (escape everything outside printable ASCII) was
 * rejected: it would mangle every legitimate non-Latin title, which is a real
 * loss to a real user in exchange for no additional structural safety.
 *
 * ── No caller yet, and what that means for these claims ───────────────────
 *
 * Nothing in `src/` calls `computeStandup` or `renderTeamStandup` today, so
 * every guard here is enforced IN THIS MODULE rather than assumed of a caller.
 * That is deliberate: a shape check placed in a not-yet-written ingestion path
 * protects nothing, and the validator this module really wants — a
 * `DeskContract.validateBoardEvent`, alongside a `leaseMs` bound the fold can
 * reject at the wire — does not exist. `_isFoldable` and `_span` are the local
 * stand-ins, deliberately narrower in scope than a contract validator: they
 * refuse what would corrupt or deny THIS rendering, and nothing else.
 *
 * ── Truncation is an error, never a flag (I21) ─────────────────────────────
 *
 * An over-long or wrongly-typed span is REFUSED — replaced by a marker naming
 * the field and the length. No prefix of the original is rendered, because a
 * truncated title that looks complete is the failure mode I21 exists to
 * forbid. The refusal is per ITEM rather than per digest on purpose: throwing
 * the whole standup away would let one peer with one bad title deny the digest
 * to the whole team. That promise is only kept if EVERY malformed shape lands
 * on the refusal path, so the per-task render and the per-peer fold are each
 * wrapped: an entry nobody anticipated degrades to one refused line, never to
 * a lost digest.
 */

import { hasUnsafeChars, validateAlias, LIMITS } from '../services/desk/DeskContract';
import { LEASE_MAX_MS, fold } from '../services/desk/DeskBoard';
import type { BoardEvent, BoardState, TaskView } from '../services/desk/DeskBoard';

/** One peer's contribution to the digest. `events` is that peer's board log. */
export interface StandupInput {
  peerAlias: string;
  events: BoardEvent[];
}

/**
 * One rendered section. Every string in here is ALREADY escaped and composed
 * by `computeStandup`; `renderTeamStandup` only lays them out.
 */
export interface StandupSection {
  peerAlias: string;
  done: string[];
  inProgress: string[];
  open: string[];
  needsAttention: string[];
}

/** Marks an alias that failed `validateAlias`. No valid alias can start with it. */
const INVALID_ALIAS_PREFIX = '!';

/**
 * How far a span may grow under escaping before it is refused.
 *
 * A single code point can expand 6x (`"`), so a cap applied only BEFORE
 * escaping is an amplifier: 200 newlines render as 1202 characters. Honest
 * text expands barely at all, so a 2x budget refuses the amplifier without
 * touching a title that merely quotes something.
 */
const ESCAPE_EXPANSION_BUDGET = 2;

/** Rendered width of an invalid alias, before its disambiguating fingerprint. */
const ALIAS_RENDER_MAX = LIMITS.alias * 2;

/** `!` + escaped head + `#` + 8 hex. The widest heading this module can emit. */
const ALIAS_RENDER_TOTAL_MAX = 1 + ALIAS_RENDER_MAX + 1 + 8;

/**
 * A lease longer than this is treated as unexpirable.
 *
 * `Number.isFinite` was the original test, and it guards the wrong property:
 * `leaseMs: 1e300` is perfectly finite and pins a task for 1e295 minutes. The
 * hazard is a claim that never returns to the frontier, so the bound has to be
 * on PLAUSIBILITY, not on representability. A week is far past any honest desk
 * lease (they are minutes) and far short of the attack, so it flags the pin
 * without ever flagging real work.
 */
const MAX_PLAUSIBLE_LEASE_MS = LEASE_MAX_MS;

/*
 * NOTE ON REACHABILITY. `DeskBoard.fold` now clamps `leaseMs` at the source
 * (LEASE_MAX_MS) and substitutes a short default for a malformed one, so a
 * TaskView arriving from `computeStandup` can no longer carry a non-finite or
 * implausible remainder. The checks below are therefore UNREACHABLE on that
 * path and are kept deliberately, for two reasons: `_leaseSuffix` takes a
 * TaskView and nothing stops a future caller assembling one by hand, and the
 * digest is the last thing a human reads before deciding a task is healthy.
 * They are documented as belt-and-braces rather than claimed as tested.
 */

/**
 * Code points escaped by this renderer beyond the contract's own class.
 *
 * Written as literal ranges rather than Unicode property escapes so the set is
 * pinned to this file and not to the host's ICU build — see the header on why
 * byte-identity forbids ICU-derived behaviour. Covers: C0/C1 controls, every
 * format (Cf) character including the invisible operators, both line/paragraph
 * separators, lone surrogates, and the noncharacters.
 */
const RENDER_UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001F], [0x007F, 0x009F],          // Cc
  [0x00AD, 0x00AD],                             // SOFT HYPHEN
  [0x0600, 0x0605], [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F],
  [0x0890, 0x0891], [0x08E2, 0x08E2],           // Arabic format characters
  [0x180E, 0x180E],                             // MONGOLIAN VOWEL SEPARATOR
  [0x200B, 0x200F],                             // zero width + directional marks
  [0x2028, 0x2029],                             // LINE / PARAGRAPH SEPARATOR
  [0x202A, 0x202E],                             // bidi embedding + override
  [0x2060, 0x2064],                             // WORD JOINER + invisible operators
  [0x2066, 0x206F],                             // isolates + deprecated formatting
  [0xD800, 0xDFFF],                             // lone surrogates
  [0xFDD0, 0xFDEF],                             // noncharacters
  [0xFEFF, 0xFEFF],                             // BOM / ZWNBSP
  [0xFFF9, 0xFFFB],                             // interlinear annotation
  [0x110BD, 0x110BD], [0x110CD, 0x110CD],
  [0x13430, 0x1343F],                           // Egyptian format controls
  [0x1BCA0, 0x1BCA3],                           // shorthand format controls
  [0x1D173, 0x1D17A],                           // musical format controls
  [0xE0000, 0xE007F],                           // TAG block — the smuggling channel
];

/**
 * True when a code point must not reach the digest unescaped.
 *
 * The contract's predicate is queried FIRST so this module can never render
 * something the wire boundary refuses; the local class then widens it. Union,
 * never replacement — drift in either direction is a hole.
 */
function _isRenderUnsafe(ch: string): boolean {
  if (hasUnsafeChars(ch)) { return true; }
  const cp = ch.codePointAt(0) ?? 0;
  // Noncharacters: the last two code points of every plane.
  if ((cp & 0xFFFE) === 0xFFFE) { return true; }
  for (const [lo, hi] of RENDER_UNSAFE_RANGES) {
    if (cp >= lo && cp <= hi) { return true; }
  }
  return false;
}

/**
 * Escape one untrusted span for inline rendering.
 *
 * Iteration is by code point (`for..of`), so a surrogate pair is never split
 * into two lone halves — and because lone surrogates ARE in the escape class,
 * that is an observable property rather than a decorative one.
 *
 * The non-string check is a PRECONDITION, not a type assertion: this function
 * is reached from wire-supplied JSON where a `string` annotation proves
 * nothing, and a `for..of` over an array would silently emit each element raw.
 * Callers that can legitimately see a non-string use `_span`, which refuses.
 */
function _escapeInline(s: string): string {
  if (typeof s !== 'string') {
    throw new TypeError('[Mysti] DeskStandup: _escapeInline requires a string');
  }
  let out = '';
  for (const ch of s) {
    // Escaped first, so the escape sequences below are unambiguous.
    if (ch === '\\') { out += '\\\\'; continue; }
    // The delimiter for peer-supplied spans; see the header's attack 2.
    if (ch === '"') { out += '\\u0022'; continue; }
    if (_isRenderUnsafe(ch)) {
      const cp = ch.codePointAt(0) ?? 0;
      out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Render one peer-supplied span: quote-delimited, escaped and BOUNDED.
 *
 * Every refusal marker starts with `[`, and every accepted span starts with
 * `"`, so a caller can tell them apart without parsing. `kind` and the numbers
 * are module-owned text, never peer text, so the marker itself cannot be
 * forged from the outside.
 */
function _span(value: unknown, kind: string, max: number): string {
  if (typeof value !== 'string') { return `[${kind} refused: not a string]`; }
  if (value.length > max) { return `[${kind} refused: ${value.length} chars exceeds ${max}]`; }
  const escaped = _escapeInline(value);
  const escapedMax = max * ESCAPE_EXPANSION_BUDGET;
  if (escaped.length > escapedMax) {
    return `[${kind} refused: ${escaped.length} escaped chars exceeds ${escapedMax}]`;
  }
  return '"' + escaped + '"';
}

/**
 * FNV-1a over UTF-16 code units — a disambiguator, not a security primitive.
 *
 * Used only to keep `_renderAlias` INJECTIVE once its output is bounded:
 * truncation alone would let two different corrupt roster records collapse
 * into one section, which is exactly the merge the alias marker exists to
 * prevent. Written out rather than imported because this module imports no
 * capability — not even `node:crypto`.
 */
function _fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Render an alias for display and for sorting.
 *
 * A valid alias passes through untouched (`ALIAS_RE` already excludes every
 * unsafe class). Anything else — only reachable from a corrupted roster — is
 * escaped, prefixed and capped. The mapping stays INJECTIVE: distinct aliases
 * never collapse into one section, which is what stops a junk record from
 * merging itself into a real peer's attribution. Bounding the output would
 * break that on its own (pigeonhole), so a truncated alias carries a
 * fingerprint of the WHOLE original.
 */
function _renderAlias(alias: string): string {
  if (validateAlias(alias).ok) { return alias; }
  const escaped = _escapeInline(alias);
  if (escaped.length <= ALIAS_RENDER_MAX) { return INVALID_ALIAS_PREFIX + escaped; }
  let head = escaped.slice(0, ALIAS_RENDER_MAX);
  // Never leave a dangling high surrogate: the cut must not manufacture the
  // very lone surrogate the escape class exists to remove.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) { head = head.slice(0, -1); }
  return INVALID_ALIAS_PREFIX + head + '#' + _fingerprint(alias);
}

/** A title that would exceed the wire limit is refused whole, never trimmed. */
function _titleOf(t: TaskView): string {
  const title = _span(t.title, 'title', LIMITS.title);
  // A refusal names the task so the human can still find it; the taskId is
  // peer-supplied too, so it is bounded by the same rule rather than inlined.
  if (title.startsWith('[')) { return `${title} task ${_span(t.taskId, 'taskId', LIMITS.id)}`; }
  return title;
}

/** The owner of a claim, bounded like any other peer-supplied span. */
function _ownerOf(t: TaskView): string {
  return _span(t.owner ?? 'unknown', 'owner', LIMITS.id);
}

/** Code-unit ordering. Deliberately not `localeCompare` — see the header. */
function _byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * True when a claimed task's lease can never plausibly expire.
 *
 * `fold` computes `leaseExpiresAt = claimedAt + leaseMs` and expires with
 * `now >= leaseExpiresAt`. `leaseMs` crosses the wire and nothing validates it
 * — not DeskBoard, not DeskContract — so `NaN`, `Infinity` and `1e300` all
 * hold the claim past any horizon a human will ever observe. The digest cannot
 * fix the fold, but it must not INHERIT the silence — such a task is surfaced
 * under "needs attention" as well as being listed in progress. Listing it
 * twice is deliberate: hiding it from "in progress" would contradict the
 * folded state, and hiding it from "needs attention" would hide an
 * indefinitely-pinned task from the only human who can unpin it.
 */
function _hasUnexpirableLease(t: TaskView, now: number): boolean {
  if (t.state !== 'claimed' || t.leaseExpiresAt === null) { return false; }
  if (typeof t.leaseExpiresAt !== 'number' || !Number.isFinite(t.leaseExpiresAt)) { return true; }
  return t.leaseExpiresAt - now > MAX_PLAUSIBLE_LEASE_MS;
}

/**
 * The lease remainder, in bounded form.
 *
 * The rendered width is capped along with the value: an unbounded float prints
 * `1.6666666666666668e+295m`, which is neither comparable nor readable in a
 * digest whose whole purpose is that two people see the same line.
 */
function _leaseNote(t: TaskView, now: number): string {
  if (t.leaseExpiresAt === null) { return ''; }
  if (typeof t.leaseExpiresAt !== 'number' || !Number.isFinite(t.leaseExpiresAt)) { return ' (lease invalid)'; }
  const remaining = t.leaseExpiresAt - now;
  if (remaining > MAX_PLAUSIBLE_LEASE_MS) { return ' (lease implausible)'; }
  // The floor is defensive only: `fold` has already turned a past-due claim
  // into `failed` against this same `now`, so a negative remainder cannot
  // reach here through `computeStandup`.
  const left = Math.max(0, Math.round(remaining / 60_000));
  return ` (lease ${left}m left)`;
}

/** Fail closed on the numeric boundary: a NaN `now` makes every clock test false. */
function _requireInstant(now: number, fn: string): void {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new RangeError(`[Mysti] DeskStandup.${fn}: now must be a finite number`);
  }
}

/**
 * Shape check for one event, run BEFORE `fold` sees it.
 *
 * Only the fields the fold does arithmetic, keying or sorting with are
 * enforced: a holey array yields `undefined` and a non-string `taskId` becomes
 * a Map key that sorts by coercion, both of which throw or scramble the digest
 * for every peer. `title` is deliberately NOT checked here — a wrongly-typed
 * title is refused per item at render, and dropping the event instead would
 * delete a real task from a real board over a cosmetic field.
 */
function _isFoldable(e: unknown): e is BoardEvent {
  try {
    if (!e || typeof e !== 'object' || Array.isArray(e)) { return false; }
    const ev = e as Record<string, unknown>;
    if (typeof ev.eventId !== 'string' || typeof ev.taskId !== 'string' || typeof ev.peerId !== 'string') {
      return false;
    }
    if (typeof ev.kind !== 'string') { return false; }
    // `lamport` is checked for TYPE only: `fold` has its own NaN/negative rule
    // and reports it as a dropped event, which is better information than a
    // silent disappearance here.
    if (typeof ev.lamport !== 'number' || typeof ev.generation !== 'number') { return false; }
    if (typeof ev.receivedAt !== 'number') { return false; }
    if (ev.leaseMs !== undefined && typeof ev.leaseMs !== 'number') { return false; }
    return true;
  } catch {
    // A field whose getter throws is not a field. This check runs OUTSIDE the
    // per-peer catch, so without this the read itself would deny the digest to
    // everyone - the same whole-team denial by a different door.
    return false;
  }
}

function _sectionFor(alias: string, state: BoardState, now: number, malformed: number): StandupSection {
  const done: string[] = [];
  const inProgress: string[] = [];
  const open: string[] = [];
  const needsAttention: string[] = [];
  const unexpirable: string[] = [];

  // `fold` already returns tasks ordered by taskId, and filtering preserves
  // order, so every bucket below is deterministic without re-sorting.
  let index = 0;
  for (const t of state.tasks) {
    const at = index++;
    try {
      switch (t.state) {
        case 'done':
          done.push(_titleOf(t));
          break;
        case 'claimed':
          inProgress.push(`${_titleOf(t)} - ${_ownerOf(t)}${_leaseNote(t, now)}`);
          if (_hasUnexpirableLease(t, now)) {
            unexpirable.push(`[lease] ${_titleOf(t)} held by ${_ownerOf(t)} with no plausible expiry`);
          }
          break;
        case 'failed':
          needsAttention.push(_titleOf(t));
          break;
        default:
          open.push(_titleOf(t));
          break;
      }
    } catch {
      // I21's promise is that a refusal is per ITEM. Every KNOWN malformed
      // shape is already refused above; this catch is what makes the promise
      // hold for the unknown one, instead of one peer's junk entry throwing
      // the whole team's digest away. The index is positional in a fold that
      // is already sorted by taskId, so it is deterministic.
      needsAttention.push(`[task refused: entry ${at} could not be rendered]`);
    }
  }

  needsAttention.push(...unexpirable);

  if (malformed > 0) {
    // Dropped before the fold rather than by it, so it is reported separately:
    // "this desk is sending events that are not events" is a different problem
    // from "this desk is sending events my rules refuse".
    needsAttention.push(`[malformed] ${malformed} event(s) discarded before folding`);
  }

  if (state.rejected.length > 0) {
    // Surfaced per peer rather than pooled: "which desk is dropping events" is
    // the question a human actually has, and pooling erases it.
    const reasons = [...new Set(state.rejected.map(r => _escapeInline(String(r.reason))))].sort(_byString);
    needsAttention.push(`[dropped] ${state.rejected.length} event(s): ${reasons.join(', ')}`);
  }

  return { peerAlias: alias, done, inProgress, open, needsAttention };
}

/**
 * Fold every peer's board and attribute the result.
 *
 * Inputs sharing one alias are MERGED into a single section rather than
 * producing two: `fold` is permutation-invariant and deduplicates by eventId,
 * so merging is order-independent, whereas two same-alias sections would be
 * ordered by their position in `inputs` and the output would stop being
 * byte-identical across orderings.
 */
export function computeStandup(inputs: StandupInput[], now: number): StandupSection[] {
  _requireInstant(now, 'computeStandup');
  if (!Array.isArray(inputs)) {
    throw new TypeError('[Mysti] DeskStandup.computeStandup: inputs must be an array');
  }

  const merged = new Map<string, BoardEvent[]>();
  const malformed = new Map<string, number>();
  for (const input of inputs) {
    if (!input || typeof input.peerAlias !== 'string' || !Array.isArray(input.events)) {
      throw new TypeError('[Mysti] DeskStandup.computeStandup: each input needs a peerAlias and an events array');
    }
    const key = _renderAlias(input.peerAlias);
    let bucket = merged.get(key);
    if (!bucket) { bucket = []; merged.set(key, bucket); }
    let bad = malformed.get(key) ?? 0;
    // A loop, not `push(...events)`: spreading a peer-sized array into an
    // argument list blows the call stack somewhere past ~125k events, which
    // would be a whole-digest denial written by whoever sends the most events.
    for (const e of input.events) {
      if (_isFoldable(e)) { bucket.push(e); } else { bad++; }
    }
    malformed.set(key, bad);
  }

  const aliases = [...merged.keys()].sort(_byString);
  return aliases.map(alias => {
    const events = merged.get(alias) ?? [];
    const bad = malformed.get(alias) ?? 0;
    try {
      return _sectionFor(alias, fold(events, now), now, bad);
    } catch {
      // Same reasoning as the per-task catch, one level up: a peer whose log
      // breaks the fold loses its own section's detail, never the digest.
      return {
        peerAlias: alias,
        done: [],
        inProgress: [],
        open: [],
        needsAttention: [`[peer refused: ${events.length} event(s) could not be folded]`],
      };
    }
  });
}

/**
 * Assert a string carries nothing that could break out of its line.
 *
 * `computeStandup` is the sanitizer; this is a second, independent gate for
 * the case where sections were assembled by hand or by a future caller.
 * Re-escaping here was rejected: escaping is not idempotent (a `\` would
 * double on every pass), so a redundant escape would corrupt honest output
 * while a hard refusal cannot. The class asked about is `_isRenderUnsafe`, the
 * same union the escaper uses — a gate narrower than the escaper would accept
 * exactly what the escaper was widened to catch.
 */
function _assertRenderable(s: unknown, where: string): asserts s is string {
  if (typeof s !== 'string') {
    throw new TypeError(`[Mysti] DeskStandup.renderTeamStandup: ${where} must be a string`);
  }
  for (const ch of s) {
    if (_isRenderUnsafe(ch)) {
      throw new Error(`[Mysti] DeskStandup.renderTeamStandup: unescaped control/bidi character in ${where}`);
    }
  }
}

/**
 * Assert one section is shaped like a section.
 *
 * The gate used to probe `s?.peerAlias` and then trust the rest, so it
 * fabricated output for anything else: `done: 'ab'` rendered `**Done (2)**`
 * with two forged items, because a string has a `length` and iterates. A
 * second gate that invents counts is worse than no second gate.
 */
function _assertSection(s: unknown): asserts s is StandupSection {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw new TypeError('[Mysti] DeskStandup.renderTeamStandup: each section must be an object');
  }
  const section = s as Record<string, unknown>;
  _assertRenderable(section.peerAlias, 'peerAlias');
  const alias = section.peerAlias as string;
  // I12 is only true if it is enforced HERE too: `computeStandup` validates
  // the alias, and a hand-assembled section is precisely the case this gate
  // exists for. Accepted forms are exactly the two `_renderAlias` can emit.
  const marked = alias.startsWith(INVALID_ALIAS_PREFIX) && alias.length <= ALIAS_RENDER_TOTAL_MAX;
  if (!validateAlias(alias).ok && !marked) {
    throw new Error('[Mysti] DeskStandup.renderTeamStandup: peerAlias is neither valid nor marked invalid');
  }
  for (const field of ['done', 'inProgress', 'open', 'needsAttention'] as const) {
    if (!Array.isArray(section[field])) {
      throw new TypeError(`[Mysti] DeskStandup.renderTeamStandup: ${field} must be an array`);
    }
  }
}

function _bucket(lines: string[], label: string, items: string[], empty: string, where: string): void {
  lines.push(`**${label} (${items.length})**`);
  if (items.length === 0) {
    lines.push(`- ${empty}`);
  } else {
    for (const item of items) {
      _assertRenderable(item, where);
      lines.push(`- ${item}`);
    }
  }
  lines.push('');
}

/**
 * Render the digest as Markdown.
 *
 * Bucket names, counts and empty-state wording mirror
 * `DeskBoard.renderStandup` so a single-peer digest and a team digest read the
 * same. That module's rendered TEXT is deliberately not scraped and re-indented
 * here: parsing another module's Markdown is a hidden coupling that would break
 * silently the day its heading depth changes, whereas composing from the typed
 * `TaskView` breaks at compile time.
 */
export function renderTeamStandup(sections: StandupSection[], now: number): string {
  _requireInstant(now, 'renderTeamStandup');
  if (!Array.isArray(sections)) {
    throw new TypeError('[Mysti] DeskStandup.renderTeamStandup: sections must be an array');
  }

  const lines: string[] = ['## Team standup', ''];

  if (sections.length === 0) {
    // An empty roster is a normal state (nobody paired yet), not an error, and
    // an empty string would read as a broken command.
    lines.push('_No peers on the roster._');
    return lines.join('\n');
  }

  lines.push(`_${sections.length} peer(s)._`);
  lines.push('');

  for (const s of sections) {
    _assertSection(s);
    lines.push(`### ${s.peerAlias}`);
    lines.push('');
    _bucket(lines, 'Done', s.done, 'nothing yet', 'done');
    _bucket(lines, 'In progress', s.inProgress, 'nothing in flight', 'inProgress');
    _bucket(lines, 'Open', s.open, 'nothing open', 'open');
    // Mirrors renderStandup: the attention bucket appears only when it has
    // something in it, so a quiet digest stays quiet.
    if (s.needsAttention.length > 0) {
      _bucket(lines, 'Needs attention', s.needsAttention, '', 'needsAttention');
    }
  }

  // Trailing blank line from the last bucket is dropped so the output has one
  // canonical byte form.
  while (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }
  return lines.join('\n');
}
