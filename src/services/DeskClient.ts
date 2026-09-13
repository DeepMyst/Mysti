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
 * DeskClient (Plan 21 Phase 2) — the caller half of `mysti.desk/1`.
 *
 * Signs one envelope, hands it to a transport, and turns whatever comes back
 * into a `DeskCallOutcome`. It is the only Desk module that talks outward,
 * which is why it lives in `src/services/` and NOT in `src/services/desk/`:
 * everything under that directory is held to `importGraph.test.ts`, whose whole
 * claim is that a serving path cannot reach the network. Putting an HTTP caller
 * there would have meant weakening that test, so the caller was moved out.
 *
 * ── The transport is injected, and there is no default ─────────────────────
 *
 * `DeskTransport` has no built-in implementation here. A default that reached
 * `http` would (a) drag a socket into every test and (b) make this module the
 * one place where "just call it directly" quietly becomes possible. The wiring
 * that owns a real socket owns the risk; this module owns the semantics.
 *
 * ── Nothing here throws ────────────────────────────────────────────────────
 *
 * `call()` returns a typed failure for every path, including a transport that
 * rejects, a peer that hangs, and a response that is structurally garbage. A
 * Desk call happens mid-turn inside the coordinator loop; an exception escaping
 * this module would take down a run for a reason the user has no way to act on.
 *
 * ── I21: incomplete is an error, never a flag ──────────────────────────────
 *
 * An `ok:true` response is refused — payload DISCARDED — unless ALL of these
 * hold: `complete === true`, `policy.withheld` is empty, `policy.redactions` is
 * present and exactly `0`, and no artifact `manifest` is declared. Each of the
 * three things I21 names (clipping, redaction-drop, an unverifiable artifact)
 * becomes `{ok:false, error:'incomplete'}`. There is deliberately no path by
 * which a partial artifact reaches the caller as a success with a caveat — that
 * is the shape that turns "the peer withheld three files" into a green node.
 *
 * `manifest` deserves its own note: I21 requires that a declared manifest's
 * paths and sha256 be checked against the artifact before anything is applied
 * or marked done. Phase 2 has no artifact-integration path to check against, so
 * rather than pass an unverified manifest through as success, this module (a)
 * refuses any `ok:true` carrying a non-null manifest and (b) drops `handoff` —
 * the one artifact verb — from the callable set entirely. A verb whose I21
 * obligation is unimplemented must not be callable.
 *
 * ── Authentication is never implicit ───────────────────────────────────────
 *
 * A caller must either pin the peer's public key or say `unpinned: true` out
 * loud; a missing key is refused BEFORE anything is sent, not silently
 * downgraded to "shape-validated only". A success additionally carries
 * `verified`, so an authenticated result is not byte-identical to an
 * unauthenticated one. Two mechanisms, because the previous single one was a
 * doc comment, and a comment is not a mechanism.
 *
 * ── What this module does NOT do (be explicit, so nobody assumes) ──────────
 *
 * - Payload prose is screened for characters that corrupt a render or a log
 *   (controls, bidi, zero-width) and payload `path`/`paths` fields are held to
 *   `DeskContract.validatePath`. Payload prose is NOT screened for
 *   prompt-injection CONTENT — a `consult` answer is remote text and must still
 *   be fenced as untrusted by whoever hands it to a model (I8).
 * - §3.3's `counter`, `lamport`, `generation` and `originId` are NOT minted
 *   here. `counter` and `lamport` need per-peer state this stateless client
 *   does not own, and all four would have to be added to the signed
 *   `DeskEnvelope` type. I19/I20/I22 are therefore UNMET on the outbound path
 *   in Phase 2; the replay story rests on `challenge` + `callId` dedupe alone.
 * - A timed-out call aborts its transport request but does NOT emit a
 *   `desk.cancel` on the caller's behalf; cancel is a second request with its
 *   own deadline and rate-limit slot, and that policy belongs to the caller.
 */

import * as crypto from 'crypto';
import { hasControlCharacters } from '../utils/controlCharacters';
import type { DeskCallResult } from '../types';
import {
  LIMITS,
  DESK_VERB_NAMES,
  isDeskVerb,
  hasUnsafeChars,
  validateArray,
  validateId,
  validatePath,
  DESK_VERBS,
} from './desk/DeskContract';
import { canonicalize, sign } from './desk/DeskEnvelope';
import type { DeskEnvelope, SignedEnvelope } from './desk/DeskEnvelope';

/** Protocol verbs. Always callable, never grantable as capabilities (§3.2). */
const PROTOCOL_VERBS = ['hello', 'cancel'] as const;

/**
 * Contract verbs whose I21 obligation (manifest paths + sha256 checked against
 * the artifact before it is applied or a node is marked done) has no
 * implementation yet. They are removed from the callable set rather than
 * shipped as an unverified success — see the header note on `manifest`.
 */
const UNIMPLEMENTED_ARTIFACT_VERBS: readonly string[] = ['handoff'];

/**
 * Ceiling on `deadlineMs`. A deadline is simultaneously how long WE hang and
 * how much abort budget the callee installs (I18), so an unbounded one is both
 * a local stall and a remote spend authorization. Ten minutes is above the
 * slowest verb the plan describes (a `review` model turn) and far below "until
 * the window is closed".
 */
export const DESK_MAX_DEADLINE_MS = 10 * 60 * 1000;

/**
 * Refusal ceiling for a response body, matching the `limits.bodyBytes` the
 * handshake advertises (§3.2). Note this is a REFUSAL, not a clip: clipping
 * would be exactly the silent truncation I21 exists to forbid.
 *
 * It is handed to the transport as `maxBytes` so the carrier can abort the READ
 * past it, and re-checked after decode as defence in depth. Checking only after
 * decode capped nothing on the wire: a hostile peer got a full read, a full
 * parse and a full tree walk before "oversize" came back.
 */
export const DESK_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Nesting depth accepted in a response. A deep structure is not useful to any
 * verb and is a cheap way to blow the stack of whichever renderer, canonicalizer
 * or fencer touches the payload next.
 */
const MAX_RESPONSE_DEPTH = 12;

/**
 * Keys that must never appear as own properties of a decoded response.
 * `JSON.parse('{"__proto__":…}')` produces exactly such an own property, and it
 * survives an assignment-based merge downstream. Refused rather than stripped,
 * matching DeskContract's drop-do-not-repair discipline.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The shape a peer's `error` string must have before it is passed on. A peer
 * authors this field, and it ends up in logs and cards; constraining it to a
 * lowercase token means it cannot carry a newline, a fence marker, or markup.
 */
const ERROR_TOKEN_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Namespace separator for a peer-authored error token.
 *
 * The peer's tokens and this module's tokens are otherwise indistinguishable:
 * a peer answering `error:"bad-signature"` produced exactly what we emit when a
 * pinned key fails to verify, so a caller reacting to "bad-signature ⇒ unpin
 * and re-pair", "timeout ⇒ retry" or "rate-limited ⇒ back off" was reacting to
 * a remote assertion it believed was a local determination. Prefixing makes the
 * namespaces disjoint by construction rather than by convention.
 */
const PEER_ERROR_PREFIX = 'peer:';

/**
 * Bearer character class. A bearer is the ONE field that ends up in a header,
 * so it is held to visible ASCII: that refuses CR and LF outright (header
 * injection — the P1-3 class this file's response side already defends), and
 * refuses the non-ASCII obs-text a carrier would have to guess an encoding for.
 */
const BEARER_RE = /^[!-~]+$/;

/** Generous next to any real token, far below any carrier's header budget. */
const MAX_BEARER_CHARS = 1024;

/** base64 SPKI for Ed25519 is 60 chars; the cap only bounds parse work. */
const MAX_PEER_KEY_CHARS = 512;

/** Ed25519 signatures are exactly 64 bytes. */
const ED25519_SIG_BYTES = 64;

/** §3.4 spells the response signature `ed25519:base64url(...)`. */
const RESPONSE_SIG_PREFIX = 'ed25519:';

/** Payload keys whose values are coordinates, not prose. */
const PATH_KEYS = new Set(['path', 'paths']);

/** Longest object key accepted inside a payload. */
const MAX_PAYLOAD_KEY_CHARS = 128;

/**
 * Characters refused in payload PROSE.
 *
 * Deliberately not `DeskContract.hasUnsafeChars`: that one refuses `\n` and
 * `\t`, which a `consult` answer legitimately contains. Deliberately not
 * `validateText` either: it trims and rejects the empty string, and a screener
 * that rewrites its input is the "repair, don't drop" anti-pattern the contract
 * header argues against. So: every C0/C1 control except tab/newline/carriage
 * return, every bidi override or isolate, every zero-width character.
 */
const PROSE_UNSAFE_RE = /[\u061C\u200B-\u200F\u2066-\u2069\u202A-\u202E\uFEFF]/;

/**
 * Failures this module can produce itself. A peer-supplied token arrives
 * `peer:`-prefixed, so this IS the exhaustive set of unprefixed error values.
 */
export type DeskClientError =
  | 'bad-url'
  | 'bad-bearer'
  | 'bad-peer-key'
  | 'unpinned-peer'
  | 'bad-verb'
  | 'bad-args'
  | 'bad-call-id'
  | 'bad-challenge'
  | 'bad-deadline'
  | 'bad-clock'
  | 'prepare-failed'
  | 'sign-failed'
  | 'timeout'
  | 'transport-error'
  | 'denied'
  | 'not-found'
  | 'rate-limited'
  | 'peer-error'
  | 'bad-status'
  | 'bad-response'
  | 'bad-signature'
  | 'oversize'
  | 'incomplete';

/** A call that produced a payload. `verified` says whether it is authenticated. */
export interface DeskCallSuccess {
  ok: true;
  payload: Record<string, unknown>;
  /**
   * True only when the response signature verified against the key the caller
   * pinned. `false` means the caller opted out with `unpinned: true` and the
   * payload is shape-validated ONLY — it is not attributable to anyone.
   */
  verified: boolean;
}

/** A call that produced no payload. Never carries one, whatever the peer sent. */
export interface DeskCallFailure {
  ok: false;
  error: string;
  withheld?: string[];
}

export type DeskCallOutcome = DeskCallSuccess | DeskCallFailure;

/**
 * Compile-time proof that the richer outcome is still a `DeskCallResult`, so a
 * consumer holding the shared type keeps working. If `DeskCallResult` ever
 * narrows in a way this violates, tsc fails here rather than at a call site.
 */
const _outcomeIsCallResult: (o: DeskCallOutcome) => DeskCallResult = (o) => o;
void _outcomeIsCallResult;

/**
 * The one thing this module needs from the outside world.
 *
 * `bearer` is the channel credential only — it authenticates the pipe, never
 * the caller (I12); authority rests on the signature inside the body. The
 * client guarantees `bearer` is non-empty visible ASCII with no CR/LF, so a
 * carrier may place it in an `Authorization` header without re-escaping; a
 * carrier must NOT relax that by accepting a bearer from anywhere else.
 *
 * `maxBytes` is a hard read ceiling: an implementation MUST abort the response
 * read once more than that many bytes have arrived, rather than buffering the
 * whole body and letting the client refuse it afterwards.
 *
 * `signal` is aborted when the client's own deadline fires. An implementation
 * MUST use it to tear the request down, otherwise a timed-out call leaves a
 * socket open and (for `consult`/`review`) a paid model turn running.
 */
export interface DeskTransport {
  post(
    url: string,
    body: unknown,
    opts: { bearer: string; timeoutMs: number; maxBytes: number; signal: AbortSignal },
  ): Promise<{ status: number; body: unknown }>;
}

export type DeskClientDeps = {
  transport: DeskTransport;
  now(): number;
  /** Caller-minted, per-request; the callee's dedupe key (§3.5). */
  newCallId(): string;
} & ({ privateKey: string; sign?: never } | {
  /** Secret-storage backed signer; the client never receives the device key. */
  sign(bytesUtf8: string): Promise<string>;
  privateKey?: never;
});

export interface CallOptions {
  url: string;
  bearer: string;
  /** Echoed from `hello`; a request cannot be minted offline without it. */
  challenge: string;
  verb: string;
  args: Record<string, unknown>;
  deadlineMs: number;
  /**
   * The peer's pinned public key, base64. Supply this OR `unpinned: true` —
   * omitting both is refused before anything is sent. When supplied, the
   * response's `sig` is verified against it, a bad or missing signature fails
   * the call, and the success carries `verified: true`.
   */
  peerPublicKey?: string;
  /**
   * Explicit opt-out from response authentication (loopback self-pairing, where
   * no key is pinned yet). Greppable on purpose: `unpinned` in a call site is a
   * reviewable claim, whereas an absent `peerPublicKey` — book not loaded, key
   * not pinned, field renamed, exception swallowed upstream — was an accident
   * that looked exactly like a decision. Mutually exclusive with
   * `peerPublicKey`; supplying both is refused rather than resolved.
   */
  unpinned?: true;
  /**
   * Reuse a previous attempt's `callId` (§3.5: "retries MUST carry the original
   * callId"). The callee returns the cached response and never re-executes, so
   * a retried `assign` cannot double-queue and a retried `consult` cannot
   * double-bill. Omit it and the injected minter supplies a fresh one.
   */
  callId?: string;
}

/** Everything `call()` needs after validation, with nothing left unchecked. */
interface PreparedRequest {
  signed: SignedEnvelope;
  url: string;
  bearer: string;
  deadlineMs: number;
  peerPublicKey: string | undefined;
}

function failure(error: DeskClientError, withheld?: string[]): DeskCallFailure {
  return withheld && withheld.length > 0 ? { ok: false, error, withheld } : { ok: false, error };
}

/** A peer's own token, namespaced so it can never be read as one of ours. */
function peerFailure(token: string, withheld: string[]): DeskCallFailure {
  const error = `${PEER_ERROR_PREFIX}${token}`;
  return withheld.length > 0 ? { ok: false, error, withheld } : { ok: false, error };
}

/**
 * True when `v` is composed only of values JSON can round-trip, is not nested
 * past the cap, and carries no prototype-poisoning key.
 *
 * Recursion is safe because the depth cap is checked BEFORE descending, so the
 * stack is bounded by MAX_RESPONSE_DEPTH regardless of input.
 *
 * Arrays go through the same own-property enumeration as objects. `v.every`
 * visited index elements only, so an array carrying an own `__proto__` or a
 * swapped prototype passed — and the stated reason for this check existing at
 * all is a transport "doing something other than decoding JSON", which is
 * precisely the case where that becomes reachable.
 */
function isJsonSafe(v: unknown, depth: number): boolean {
  if (v === null) { return true; }
  const t = typeof v;
  if (t === 'boolean' || t === 'string') { return true; }
  if (t === 'number') { return Number.isFinite(v as number); }
  if (t !== 'object') { return false; }
  if (depth >= MAX_RESPONSE_DEPTH) { return false; }

  const proto = Object.getPrototypeOf(v);
  const isArray = Array.isArray(v);
  // A class instance, Map, Date or Buffer never comes out of JSON.parse; one
  // arriving means the transport is doing something other than decoding JSON.
  if (isArray) {
    if (proto !== Array.prototype && proto !== null) { return false; }
  } else if (proto !== Object.prototype && proto !== null) {
    return false;
  }

  const o = v as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(o)) {
    if (UNSAFE_KEYS.has(k)) { return false; }
    // JSON.parse produces only canonical index keys (plus `length`) on an
    // array. Anything else is a hand-built object wearing an array's shape.
    if (isArray && k !== 'length' && String(Number(k) >>> 0) !== k) { return false; }
    if (isArray && k === 'length') { continue; }
    if (!isJsonSafe(o[k], depth + 1)) { return false; }
  }
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) { return false; }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Screen the one field that actually reaches a model prompt and a card.
 *
 * `error` was regex-bound and `policy.withheld` went through `validatePath`,
 * while `payload` — the field with consequences — was returned verbatim. A
 * `locate` result's `path` is a coordinate a caller will plausibly open or
 * render, so any key named `path`/`paths` is held to the contract's path rules
 * (no `..`, no absolute, no backslash, no drive letter, no control/bidi). Every
 * other string is prose and is refused only for characters that corrupt a
 * render, a log line or a fence header.
 *
 * Prose CONTENT (an embedded fence marker, a fake system header) is NOT
 * screened here: legitimate answers discuss those strings, and content trust is
 * the fencer's job under I8. That is stated in the header rather than implied.
 */
function screenPayloadValue(v: unknown, key: string | undefined, depth: number): boolean {
  if (depth >= MAX_RESPONSE_DEPTH) { return false; }
  if (v === null) { return true; }
  const t = typeof v;
  if (t === 'boolean') { return true; }
  if (t === 'number') { return Number.isFinite(v as number); }
  if (t === 'string') {
    const s = v as string;
    if (key !== undefined && PATH_KEYS.has(key)) { return validatePath(s, key).ok; }
    return !hasControlCharacters(s, { allowTextWhitespace: true }) && !PROSE_UNSAFE_RE.test(s);
  }
  if (Array.isArray(v)) {
    if (v.length > LIMITS.arrayItems) { return false; }
    // Elements inherit their container's key, so `paths: [...]` screens every
    // element as a path rather than as prose.
    return v.every(x => screenPayloadValue(x, key, depth + 1));
  }
  if (!isPlainObject(v)) { return false; }
  for (const k of Object.keys(v)) {
    if (k.length === 0 || k.length > MAX_PAYLOAD_KEY_CHARS) { return false; }
    if (hasUnsafeChars(k)) { return false; }
    if (!screenPayloadValue(v[k], k, depth + 1)) { return false; }
  }
  return true;
}

/** Map a non-2xx status onto a closed error token. */
function statusToError(status: number): DeskClientError {
  if (status === 401 || status === 403) { return 'denied'; }
  if (status === 404) { return 'not-found'; }
  if (status === 408 || status === 504) { return 'timeout'; }
  if (status === 429) { return 'rate-limited'; }
  if (status >= 500 && status <= 599) { return 'peer-error'; }
  return 'bad-status';
}

/**
 * The caller half of one Desk request.
 *
 * Stateless by construction: no connection, no session, no queue. Everything
 * that would need to persist across calls (dedupe, backoff, the outbox) belongs
 * to the peer book, which owns durability — see §3.6. The one concession is
 * `CallOptions.callId`, which lets that owner replay an id it persisted.
 */
export class DeskClient {
  constructor(private readonly _deps: DeskClientDeps) {}

  async call(opts: CallOptions): Promise<DeskCallOutcome> {
    let req: PreparedRequest;
    try {
      const prepared = await this._prepare(opts);
      if ('error' in prepared) { return failure(prepared.error); }
      req = prepared.req;
    } catch {
      // A throw here is a broken injected dependency (`now`, `newCallId`) or a
      // hostile getter on the options object — NOT a key problem. Reporting it
      // as 'sign-failed' pointed an operator at the key material for a fault
      // that was never near it; `sign()` has its own narrow try below.
      return failure('prepare-failed');
    }

    // The deadline is also the callee's abort budget (I18), so when it fires
    // locally the request itself must be torn down: otherwise a `consult` that
    // this turn already abandoned keeps burning a paid model turn on someone
    // else's account and holds a socket for as long as the carrier allows.
    const controller = new AbortController();

    let response: { status: number; body: unknown };
    try {
      const raced = await this._race(
        this._deps.transport.post(req.url, req.signed, {
          bearer: req.bearer,
          timeoutMs: req.deadlineMs,
          maxBytes: DESK_MAX_RESPONSE_BYTES,
          signal: controller.signal,
        }),
        req.deadlineMs,
        controller,
      );
      if (raced.kind === 'timeout') { return failure('timeout'); }
      if (raced.kind === 'error') { return failure('transport-error'); }
      response = raced.value;
    } catch {
      return failure('transport-error');
    }

    try {
      return this._interpret(req.signed.envelope, response, req.peerPublicKey);
    } catch {
      return failure('bad-response');
    }
  }

  // -------------------------------------------------------------------------
  // Request construction
  // -------------------------------------------------------------------------

  /**
   * Validate everything BEFORE a byte leaves the machine.
   *
   * The alternative — let the peer validate, and map its 400 — was rejected:
   * the args come from a model, and a model-invented verb reaching the wire is
   * an enumeration probe against someone else's grant table. It also spends a
   * rate-limit slot on the callee for a request we already know is malformed.
   */
  private async _prepare(opts: CallOptions): Promise<{ req: PreparedRequest } | { error: DeskClientError }> {
    if (typeof opts.url !== 'string' || !isPeerUrl(opts.url)) { return { error: 'bad-url' }; }

    const bearer = opts.bearer;
    if (typeof bearer !== 'string' || bearer.length === 0
      || bearer.length > MAX_BEARER_CHARS || !BEARER_RE.test(bearer)) {
      return { error: 'bad-bearer' };
    }

    const pin = readPin(opts);
    if ('error' in pin) { return { error: pin.error }; }

    if (!validateId(opts.challenge, 'challenge').ok) { return { error: 'bad-challenge' }; }

    const deadlineMs = opts.deadlineMs;
    if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)
      || deadlineMs <= 0 || deadlineMs > DESK_MAX_DEADLINE_MS) {
      return { error: 'bad-deadline' };
    }

    if (!isPlainObject(opts.args)) { return { error: 'bad-args' }; }

    const verbCheck = this._checkVerb(opts.verb, opts.args);
    if ('error' in verbCheck) { return { error: verbCheck.error }; }

    // A caller-supplied id is a §3.5 retry of an id the peer book persisted; it
    // is validated exactly like a minted one, so a replayed id cannot smuggle a
    // shape the minter could not have produced.
    const callId = opts.callId !== undefined ? opts.callId : this._deps.newCallId();
    if (!validateId(callId, 'callId').ok) { return { error: 'bad-call-id' }; }

    const issuedAt = this._deps.now();
    if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) { return { error: 'bad-clock' }; }

    const envelope: DeskEnvelope = {
      protocol: 'mysti.desk/1',
      callId,
      verb: verbCheck.verb,
      args: verbCheck.args,
      issuedAt,
      challenge: opts.challenge,
      deadlineMs,
    };

    let signed: SignedEnvelope;
    try {
      signed = this._deps.sign
        ? { envelope, signature: await this._deps.sign(canonicalize(envelope)) }
        : sign(envelope, this._deps.privateKey);
    } catch {
      // Narrow on purpose: only a key or serialization fault reads as
      // 'sign-failed', so that token still means what an operator thinks.
      return { error: 'sign-failed' };
    }

    return {
      req: {
        signed,
        url: opts.url,
        bearer,
        deadlineMs,
        peerPublicKey: pin.peerPublicKey,
      },
    };
  }

  /**
   * The verb allowlist is closed and has exactly one definition:
   * `DESK_CALLABLE_VERBS`. The membership test and the exported list are the
   * same value, so a verb cannot be advertised without being callable (or the
   * reverse) — previously the exported list and the hardcoded `hello`/`cancel`
   * literals could drift silently past a test that only pinned the list.
   *
   * Args go through the contract's own validator so the request this machine
   * signs is the same shape the receiver will re-validate.
   */
  private _checkVerb(
    verb: unknown,
    args: Record<string, unknown>,
  ): { verb: string; args: Record<string, unknown> } | { error: DeskClientError } {
    if (typeof verb !== 'string' || !DESK_CALLABLE_VERBS.includes(verb)) {
      return { error: 'bad-verb' };
    }
    if (isDeskVerb(verb)) {
      const validated = DESK_VERBS[verb].validate(args);
      if (!validated.ok) { return { error: 'bad-args' }; }
      return { verb, args: validated.value };
    }
    if (verb === 'hello') {
      if (Object.keys(args).length > 0) { return { error: 'bad-args' }; }
      return { verb, args: {} };
    }
    if (verb === 'cancel') {
      // Targeted cancel only: an untargeted one is the OpenClaw-audit gap the
      // plan calls out, so a cancel without a callId is refused rather than
      // widened into "cancel whatever is running".
      if (!validateId(args.callId, 'callId').ok) { return { error: 'bad-args' }; }
      return { verb, args: { callId: args.callId } };
    }
    /* istanbul ignore next — unreachable while DESK_CALLABLE_VERBS is the gate */
    return { error: 'bad-verb' };
  }

  // -------------------------------------------------------------------------
  // Deadline
  // -------------------------------------------------------------------------

  /**
   * Enforce the deadline locally rather than trusting the transport to honour
   * the `timeoutMs` it was handed. The transport is injected — it may be a
   * mock, a relay client, or a future carrier — and a hung peer must cost this
   * turn exactly `deadlineMs`, not "whatever the carrier decides".
   *
   * The transport promise is folded into a settled-either-way promise BEFORE
   * the race, so a rejection that lands after we have already timed out is
   * handled rather than surfacing as an unhandled rejection.
   */
  private _race<T>(
    p: Promise<T>,
    ms: number,
    controller: AbortController,
  ): Promise<{ kind: 'value'; value: T } | { kind: 'error' } | { kind: 'timeout' }> {
    const settled = p.then(
      (value) => ({ kind: 'value' as const, value }),
      () => ({ kind: 'error' as const }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        // Abort BEFORE resolving, so the carrier is torn down whether or not
        // the caller does anything with the timeout result.
        try { controller.abort(); } catch { /* an aborted controller is fine */ }
        resolve({ kind: 'timeout' as const });
      }, ms);
    });
    return Promise.race([settled, timeout]).finally(() => {
      if (timer !== undefined) { clearTimeout(timer); }
    });
  }

  // -------------------------------------------------------------------------
  // Response interpretation
  // -------------------------------------------------------------------------

  private _interpret(
    sent: DeskEnvelope,
    response: { status: number; body: unknown },
    peerPublicKey: string | undefined,
  ): DeskCallOutcome {
    // Integrality matters because the acceptance side is a token set, not a
    // range over an arbitrary finite number a transport handed us: 200.5 is not
    // a status.
    if (typeof response?.status !== 'number' || !Number.isInteger(response.status)) {
      return failure('bad-response');
    }
    // `mysti.desk/1` answers 200 and nothing else — errors are structured in
    // the body (§3.4). A 201 or a 204-with-a-body is a carrier doing something
    // the protocol does not describe, so it is refused rather than accepted.
    if (response.status !== 200) {
      // The peer's error BODY is deliberately dropped here. It is
      // attacker-authored text, and a caller that renders "why did this fail"
      // outside a fence is exactly the P1-3 header-injection path.
      return failure(statusToError(response.status));
    }

    const body = response.body;
    if (!isPlainObject(body)) { return failure('bad-response'); }
    if (!isJsonSafe(body, 0)) { return failure('bad-response'); }

    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
    } catch {
      return failure('bad-response');
    }
    if (bytes > DESK_MAX_RESPONSE_BYTES) { return failure('oversize'); }

    if (body.protocol !== 'mysti.desk/1') { return failure('bad-response'); }
    // Binding the response to THIS request: without it a peer (or anything in
    // the path) could answer call A with the cached result of call B, which is
    // how a cheap `status` becomes an oracle for an expensive `consult`.
    if (body.callId !== sent.callId) { return failure('bad-response'); }
    if (body.verb !== sent.verb) { return failure('bad-response'); }
    if (typeof body.ok !== 'boolean') { return failure('bad-response'); }

    let verified = false;
    if (peerPublicKey !== undefined) {
      if (!verifyResponseSignature(body, peerPublicKey, sent.challenge, sent.callId)) {
        return failure('bad-signature');
      }
      verified = true;
    }

    const policy = readPolicy(body);
    if (policy === 'invalid') { return failure('bad-response'); }
    const withheld = policy.withheld;

    if (body.ok === false) {
      const err = body.error;
      if (typeof err !== 'string' || !ERROR_TOKEN_RE.test(err)) { return failure('bad-response'); }
      return peerFailure(err, withheld);
    }

    // ---- ok === true from here. I21 territory. ----

    // A success that also names an error is self-contradictory; refuse rather
    // than pick a side, because picking one lets the peer choose which half we
    // believe.
    if (body.error !== undefined) { return failure('bad-response'); }

    // `complete` must be present and exactly true. Missing-means-complete was
    // rejected: it makes an older or buggier peer's silence read as success.
    if (body.complete !== true) { return failure('incomplete', withheld); }
    if (withheld.length > 0) { return failure('incomplete', withheld); }

    // I21's redaction-drop half. `redactions` must be PRESENT and zero: absent
    // is treated exactly like `complete` being absent, because a peer that does
    // not report its screening is not evidence that its screening removed
    // nothing. A non-numeric count is a shape fault, handled in readPolicy.
    if (policy.redactions !== 0) { return failure('incomplete', withheld); }

    // An artifact was declared but nothing here can check its paths or sha256
    // against the artifact (see the header note). Refusing is the only honest
    // answer; `handoff` is additionally not callable at all.
    if (body.manifest !== undefined && body.manifest !== null) {
      return failure('incomplete', withheld);
    }

    if (!isPlainObject(body.payload)) { return failure('bad-response'); }
    if (!screenPayloadValue(body.payload, undefined, 0)) { return failure('bad-response'); }
    return { ok: true, payload: body.payload, verified };
  }
}

/**
 * HTTP(S), or an exact authenticated iroh endpoint identifier — never a file or data URL — and
 * never one carrying userinfo.
 *
 * Credentials in the URL are refused because the channel credential is the
 * `bearer` and nothing else: a URL that carries its own is either a second,
 * unreviewed credential path or an attempt to make a hostile origin look like a
 * familiar one (`http://desk.acme.internal@evil.example/`).
 *
 * NOT fixed here, and deliberately: the origin itself is still whatever the
 * caller names. Constraining WHERE (the visualTestPolicy discipline) requires
 * the pinned peer record, which this stateless module does not hold — the
 * wiring that resolves a peer row owns that check.
 */
function isPeerUrl(raw: string): boolean {
  if (/^iroh:\/\/[a-f0-9]{64}\/desk$/.test(raw)) { return true; }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
  if (u.username !== '' || u.password !== '') { return false; }
  return true;
}

/**
 * Resolve the caller's authentication choice, refusing the accident.
 *
 * Exactly one of `peerPublicKey` / `unpinned: true` must be given. Both is a
 * contradiction (is this authenticated or not?) and neither is the fail-open
 * this replaced: an optional key silently degraded "verified against the pinned
 * peer key" into "shape-validated only" with nothing in the result to say so.
 */
function readPin(opts: CallOptions):
  { peerPublicKey: string | undefined } | { error: DeskClientError } {
  const key = opts.peerPublicKey;
  const unpinned = opts.unpinned;
  if (key !== undefined) {
    if (unpinned !== undefined) { return { error: 'bad-peer-key' }; }
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_PEER_KEY_CHARS) {
      return { error: 'bad-peer-key' };
    }
    return { peerPublicKey: key };
  }
  // `true` and only `true`: a truthy value is not a decision.
  if (unpinned !== true) { return { error: 'unpinned-peer' }; }
  return { peerPublicKey: undefined };
}

/** What a response's `policy` block says about what is missing from it. */
interface PolicyView {
  withheld: string[];
  /** `'absent'` is distinct from `0`: only one of them is a claim. */
  redactions: number | 'absent';
}

/**
 * Pull the I21 fields out of a response.
 *
 * Returns `'invalid'` — not an empty list, not a zero count — when a field is
 * present but malformed. Treating a malformed withheld list as "nothing was
 * withheld", or a malformed redaction count as "nothing was redacted", would
 * invert I21: the two fields that say bytes are missing would fail open.
 */
function readPolicy(body: Record<string, unknown>): PolicyView | 'invalid' {
  const policy = body.policy;
  if (policy === undefined) { return { withheld: [], redactions: 'absent' }; }
  if (!isPlainObject(policy)) { return 'invalid'; }

  let withheld: string[] = [];
  if (policy.withheld !== undefined) {
    const paths = validateArray(
      policy.withheld,
      (x, i) => validatePath(x, `withheld[${i}]`),
      'withheld',
      LIMITS.arrayItems,
    );
    if (!paths.ok) { return 'invalid'; }
    withheld = paths.value;
  }

  let redactions: number | 'absent' = 'absent';
  if (policy.redactions !== undefined) {
    const r = policy.redactions;
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 0) { return 'invalid'; }
    redactions = r;
  }

  return { withheld, redactions };
}

/**
 * Verify the callee's signature over the response (§3.4).
 *
 * The signed message is `sha256(challenge ‖ callId ‖ JCS(response minus sig))`
 * and the encoding is `ed25519:base64url(...)`, both exactly as the plan spells
 * them. The previous implementation signed only `canonicalize(body minus sig)`
 * and expected bare base64, which meant (a) a conforming peer's signature would
 * have decoded to garbage and failed as 'bad-signature', and (b) a captured
 * signed response replayed for any future call that reused its callId, because
 * nothing in the body binds it to this session. Folding in the challenge — a
 * value the CALLER received from this peer's `hello` and the peer never chose —
 * is what makes a verified response fresh.
 */
function verifyResponseSignature(
  body: Record<string, unknown>,
  publicKeyBase64: string,
  challenge: string,
  callId: string,
): boolean {
  const sig = body.sig;
  if (typeof sig !== 'string' || !sig.startsWith(RESPONSE_SIG_PREFIX)) { return false; }
  const raw = sig.slice(RESPONSE_SIG_PREFIX.length);
  if (raw.length === 0 || raw.length > 256) { return false; }

  const unsigned: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (k !== 'sig') { unsigned[k] = body[k]; }
  }
  try {
    const signature = Buffer.from(raw, 'base64url');
    if (signature.length !== ED25519_SIG_BYTES) { return false; }
    const message = crypto.createHash('sha256')
      .update(Buffer.from(challenge, 'utf8'))
      .update(Buffer.from(callId, 'utf8'))
      .update(Buffer.from(canonicalize(unsigned), 'utf8'))
      .digest();
    return crypto.verify(
      null,
      message,
      crypto.createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki',
      }),
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Every verb `call()` will put on the wire — and, because `_checkVerb` tests
 * membership in this very list, every verb it will accept. Exported for tests
 * and for UI.
 */
export const DESK_CALLABLE_VERBS: readonly string[] = Object.freeze([
  ...DESK_VERB_NAMES.filter(v => !UNIMPLEMENTED_ARTIFACT_VERBS.includes(v)),
  ...PROTOCOL_VERBS,
]);
