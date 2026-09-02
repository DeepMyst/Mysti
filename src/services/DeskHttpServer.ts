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
 * DeskHttpServer (Plan 21 Phase 2, transport tier T0) — the loopback carrier
 * for one signed Desk envelope.
 *
 * ── Why this file is NOT in src/services/desk/ ─────────────────────────────
 *
 * `tests/services/desk/importGraph.test.ts` forbids every module under
 * `src/services/desk/` from reaching `http`, `net`, `child_process`, `vscode`,
 * and friends. That test IS the security claim of Plan 21 (I11): the serving
 * path cannot write, spawn, or reach the network. A socket obviously must, so
 * the carrier lives one directory up and the dispatcher it feeds stays inside
 * the fence. Weakening the import-graph test to accommodate this file was the
 * rejected alternative — it would have retired the only mechanically-checkable
 * security property in the plan to save a directory hop.
 *
 * ── The rejection order IS the security property ───────────────────────────
 *
 * Every check below is ordered deliberately, and the order — not merely the
 * presence — of each check is what makes the guarantee hold:
 *
 *   1. Host header not loopback           -> 403   (DNS-rebinding kill, first)
 *   2. Origin present and not loopback    -> 403   (cross-site kill)
 *   3. Bearer resolves to a REVOKED peer  -> 410   (I13: revocation is
 *                                                   consulted before anything
 *                                                   that could serve the peer)
 *   4. Bearer missing / unresolvable      -> 401   (constant-time)
 *   5. Body malformed / oversized         -> 400 / 413
 *   6. Only then does `deps.handle` see it.
 *
 * `Expect: 100-continue` is answered by the SAME pipeline (`checkContinue`),
 * never by node's automatic 100. Left to node, an unauthenticated caller with a
 * rebound Host is told "go ahead, upload" before gate (1) has run.
 *
 * A later check must never be able to answer a request an earlier one would
 * have refused: a rebound Host carrying a perfectly valid bearer is 403, not
 * 200 and not 401, because the rebinding attacker learns nothing from a 403
 * and everything from a 401 (a 401 proves the port speaks Desk). The tests
 * assert each pair, not just each code.
 *
 * ── What the bearer is, and is not ─────────────────────────────────────────
 *
 * The bearer authenticates the CHANNEL. It never authorizes a verb — I12's
 * per-request Ed25519 signature over a server-chosen challenge does that,
 * inside `deps.handle`. This server therefore deliberately knows nothing
 * about grants, verbs, scopes or signatures; it decides only "may these bytes
 * be handed to the dispatcher at all".
 */

import * as http from 'http';
import * as crypto from 'crypto';

/**
 * Hard ceiling on a request body. The protocol's own `limits.bodyBytes` is far
 * smaller (64 KiB in §3.2) and is enforced by the dispatcher against the
 * *peer's* grant; this is the transport's own backstop so an unauthenticated
 * or over-granted sender cannot make the extension host buffer arbitrary RAM.
 */
export const DESK_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The single endpoint. Anything else 404s, and only after authentication. */
export const DESK_PATH = '/desk';

/**
 * The identity a request bearing this server's own session token is served as.
 *
 * It is a *channel* identity, not a peer: it owns no `PeerGrant`, so
 * `deps.handle` answers `not_granted` for every verb unless the host has
 * deliberately registered a grant for it — which is exactly what the Phase 2
 * self-pairing flow does when it pairs one machine to itself across two
 * VSCode windows. Keeping it a named reserved id (rather than letting a token
 * match impersonate an arbitrary peer) means a stolen token can never inherit
 * a real teammate's grant.
 */
export const DESK_CHANNEL_PEER_ID = 'p_channel_local';

/**
 * Bearers longer than this are refused unresolved rather than handed to
 * `deps.resolvePeer`. The peer book does a lookup per call; an unauthenticated
 * caller should not get to choose how much work that lookup costs.
 */
const MAX_BEARER_CHARS = 4096;

/**
 * Shortest acceptable session token. A pairing token is a bearer over a port
 * this server does not rate-limit, so a 4-character one is walk-in-able. The
 * generated token is 48 hex chars; this only bounds what a HOST may substitute.
 */
const MIN_TOKEN_CHARS = 16;

/**
 * Socket timeouts, explicit rather than inherited: node's defaults (60 s
 * headers / 300 s request) are generous enough that a handful of half-open
 * sockets can sit on the extension host for five minutes each. Exported so the
 * tests can assert them on the LIVE server — the assignments are otherwise a
 * silent mutant (deleting them restores node's defaults with no visible change).
 */
export const DESK_HEADERS_TIMEOUT_MS = 10_000;
export const DESK_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Own-key names that are refused anywhere in a parsed body.
 *
 * `__proto__` as an own key is what `JSON.parse` produces (unlike an object
 * literal) and is the classic pollution vector for any downstream deep-merge;
 * `constructor`/`prototype` are the other half of the same family. No legitimate
 * Desk envelope (§3.2: verb, callId, args, deadlineMs, lamport, generation,
 * originId, sig) carries any of the three as a KEY.
 */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Phase 2 ships loopback only. Phase 3 adds `tailnet`/`lan` — see {@link DeskHttpServer.start}. */
export type DeskBind = 'loopback' | 'off';

export interface DeskServerDeps {
  /**
   * Resolve a bearer to a peerId, or null.
   *
   * CONTRACT (I12): the argument is attacker-chosen and the answer maps to a
   * real teammate's `PeerGrant` — a stronger secret than this server's own
   * session token, which IS compared in constant time below. An implementation
   * MUST therefore look the bearer up in a way that is independent of the
   * stored values: key a map by `sha256(bearer)`, or `timingSafeEqual` over
   * fixed-length digests. A linear scan of stored bearers with `===` leaks a
   * per-candidate prefix oracle and is a defect, not a style choice. It must
   * also not enumerate: an unknown bearer and a known-but-wrong one must cost
   * the same.
   */
  resolvePeer(bearer: string): string | null;
  /**
   * Current challenge for a peer; issue one if none.
   *
   * DELIBERATELY NEVER CALLED FROM THIS CARRIER. Issuing a challenge here would
   * mint one for every 403/401 probe — an unauthenticated caller must not be
   * able to drive challenge state. `deps.handle` owns the I12 challenge cycle.
   * A test asserts this stays uncalled across a batch of refusals.
   */
  challengeFor(peerId: string): string;
  /** Handle a verified call. Returns a JSON-serialisable result. */
  handle(peerId: string, body: unknown): Promise<unknown>;
  isRevoked(peerId: string): boolean;
}

export interface DeskServerOptions {
  /** Override the generated session token (tests, and the pairing flow). Must be >= 16 chars. */
  token?: string;
  /** Override {@link DESK_CHANNEL_PEER_ID} for a host that names its self-peer differently. */
  channelPeerId?: string;
  /**
   * Lower (never raise) the body cap. Values above {@link DESK_MAX_BODY_BYTES}
   * are clamped down. A present-but-unusable value (NaN, Infinity, 0, negative,
   * non-number) THROWS — see the constructor.
   */
  maxBodyBytes?: number;
}

export interface DeskHttpHandle {
  /** 0 when bound `off`. */
  port: number;
  token: string;
  /** Empty string when bound `off`. */
  url: string;
}

type Refusal =
  | 'forbidden'
  | 'unauthorized'
  | 'revoked'
  | 'not_found'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'too_large'
  | 'bad_request'
  | 'internal';

export class DeskHttpServer {
  private readonly _deps: DeskServerDeps;
  private readonly _token: string;
  private readonly _channelPeerId: string;
  private readonly _maxBody: number;
  private _http: http.Server | null = null;
  private _stopped = false;
  private _starting: Promise<DeskHttpHandle> | null = null;
  private _handleInfo: DeskHttpHandle | null = null;

  /**
   * Every option is validated here, at the boundary, because absorbing a bad
   * one is how a cap stops capping.
   *
   * `Math.max(1, Math.min(NaN, CEILING))` is `NaN`, and every later comparison
   * against `NaN` (`declared > cap`, `total > cap`) is FALSE — so a single
   * malformed machine-scoped setting silently deleted the transport's only
   * memory backstop while the class still reported a cap. `NaN` is the natural
   * output of `Number(cfg.get('…'))` on a typo'd setting, so this is a live
   * path, not a theoretical one.
   *
   * Rejected alternative: silently substituting {@link DESK_MAX_BODY_BYTES} for
   * an unusable value. That converts an operator typo into a 4 MiB buffer they
   * never asked for and hides the typo forever; a constructor throw means Desk
   * does not come up, which is the fail-CLOSED direction (the setting is
   * machine-scoped and Desk defaults off, so "not running" is the safe state).
   * `undefined` is still "not specified" and takes the default — that is the
   * `??` above, not an absorbed error.
   */
  constructor(deps: DeskServerDeps, opts?: DeskServerOptions) {
    this._deps = deps;
    this._token = validateToken(opts?.token);
    this._channelPeerId = validateChannelPeerId(opts?.channelPeerId);
    this._maxBody = validateMaxBody(opts?.maxBodyBytes);
  }

  get token(): string { return this._token; }

  get isRunning(): boolean { return this._http !== null && this._http.listening; }

  /**
   * The timeouts actually installed on the live socket, or null when nothing is
   * bound. Exposed because the assignments in `_start` are otherwise invisible:
   * deleting them silently restores node's 60 s/300 s defaults, and no
   * request-level test can tell the difference without waiting a minute.
   */
  get socketTimeouts(): { headersMs: number; requestMs: number } | null {
    return this._http ? { headersMs: this._http.headersTimeout, requestMs: this._http.requestTimeout } : null;
  }

  /**
   * Bind the carrier.
   *
   * `'off'` does not listen-and-refuse; it never creates a socket, so there is
   * nothing to port-scan and nothing to reach even from loopback. That matters
   * because the setting is machine-scoped and defaults off: "Desk is off" must
   * mean no listener exists, not that a listener answers 403.
   *
   * `'off'` is AUTHORITATIVE, not merely a no-op on a virgin instance: calling
   * it on a running server tears the listener down before returning. A host
   * that reacts to the machine-scoped `bind` setting flipping to `off` by
   * calling `start('off')` on the existing instance must not be told "port 0,
   * url ''" while the old socket keeps serving the pairing token — that is
   * exactly the shape of "the UI says Desk is off" while it is not.
   *
   * PHASE 3 SEAM — `tailnet` and `lan` belong here, and the plan (§3.1, T1) is
   * explicit that an off-loopback bind must REFUSE plaintext at `start()`
   * rather than warn: the bearer and the envelope would otherwise cross a
   * network in the clear, and a warning is not a control. That refusal is not
   * implemented here, so this phase refuses the values outright instead of
   * silently binding them to 127.0.0.1 (which would be a lie to the caller) or
   * binding them for real (which would be the plaintext hole).
   */
  async start(bind: DeskBind = 'loopback'): Promise<DeskHttpHandle> {
    // Hoisted above BOTH the bind validation and the 'off' branch: a stopped
    // server must be stopped for every argument. It previously guarded only the
    // 'loopback' path, so start('off') on a stopped server handed back a live
    // token, and the redundant post-listen copy of this check meant a stopped
    // server still transiently bound a real port before refusing.
    if (this._stopped) { throw new Error(STOPPED_MESSAGE); }
    if (bind !== 'loopback' && bind !== 'off') {
      throw new Error(`DeskHttpServer: unsupported bind "${String(bind)}" — Phase 2 is loopback-only`);
    }
    if (bind === 'off') {
      await this._teardown();
      console.log('[Mysti] DeskHttpServer: bind=off — no listener.');
      return { port: 0, token: this._token, url: '' };
    }
    if (this._handleInfo) { return this._handleInfo; }
    if (this._starting) { return this._starting; }
    this._starting = this._start();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  private async _start(): Promise<DeskHttpHandle> {
    const server = http.createServer((req, res) => { void this._onRequest(req, res, false); });
    // Answer `Expect: 100-continue` through the same gates. Without this
    // listener node auto-writes "HTTP/1.1 100 Continue" BEFORE the Host, Origin
    // and bearer checks — i.e. it invites an unauthenticated caller with a
    // rebound Host to upload up to the cap, and hands it a distinct pre-gate
    // response the constant-shape refusals are supposed to deny it.
    server.on('checkContinue', (req, res) => { void this._onRequest(req, res, true); });
    server.headersTimeout = DESK_HEADERS_TIMEOUT_MS;
    server.requestTimeout = DESK_REQUEST_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });

    // A stop() that arrived while `listen` was pending must still win, or a
    // fast open/close leaks a listening socket for the rest of the session.
    if (this._stopped) {
      await closeServer(server);
      throw new Error(STOPPED_MESSAGE);
    }

    this._http = server;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this._handleInfo = { port, token: this._token, url: `http://127.0.0.1:${port}${DESK_PATH}` };
    return this._handleInfo;
  }

  /** Idempotent and PERMANENT: safe before `start()`, during it, and repeatedly after. */
  async stop(): Promise<void> {
    this._stopped = true;
    await this._teardown();
  }

  /**
   * Drop the listener, waiting out an in-flight `start()` first so a fast
   * open/close cannot leak a listening socket for the rest of the session.
   * Shared by `stop()` (permanent) and `start('off')` (re-startable).
   */
  private async _teardown(): Promise<void> {
    if (this._starting) { await this._starting.catch(() => { /* start already lost the race */ }); }
    const server = this._http;
    this._http = null;
    this._handleInfo = null;
    if (server) { await closeServer(server); }
  }

  private async _onRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    expectContinue: boolean,
  ): Promise<void> {
    if (expectContinue) {
      // This request's socket was never cleared for a body unless a gate below
      // called writeContinue(); drop it once the answer has flushed so a client
      // that ignores the final status cannot upload into a closed pipeline.
      res.on('finish', () => { try { req.destroy(); } catch { /* already gone */ } });
    }
    try {
      await this._route(req, res, expectContinue);
    } catch (err) {
      // A throw anywhere above must not leave the socket hanging, and must not
      // describe itself to the caller.
      console.error(`[Mysti] DeskHttpServer: unhandled request error (${errLabel(err)})`);
      try {
        if (!res.headersSent) { refuse(res, 500, 'internal'); } else { res.end(); }
      } catch { /* socket already destroyed — nothing left to answer on */ }
    }
  }

  private async _route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    expectContinue: boolean,
  ): Promise<void> {
    // (1) DNS-rebinding: we listen on 127.0.0.1 only, so a legitimate client
    // always addresses a loopback host. A browser tricked into resolving an
    // attacker domain to 127.0.0.1 carries that domain in Host. Checked FIRST,
    // before the bearer, so the answer is identical whether or not the caller
    // guessed a real token — a 401 here would confirm the port speaks Desk.
    if (!isLoopbackHostHeader(req.headers.host)) {
      refuse(res, 403, 'forbidden');
      return;
    }
    // (2) Origin is only present when a browser sent the request; a non-loopback
    // one (including the opaque "null" of a sandboxed frame) is never us.
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(String(origin))) {
      refuse(res, 403, 'forbidden');
      return;
    }

    const bearer = extractBearer(req.headers.authorization);
    const peerId = this._resolve(bearer);

    // (3) I13: the revocation list is consulted BEFORE anything that could
    // serve the peer — before routing, before the media-type gate, before a
    // byte of body is read, and therefore long before `deps.handle`. A revoked
    // peer's own bearer still RESOLVES (removal from a peer store is not
    // revocation), so a cut-off teammate must be answered "gone", never
    // "malformed" and never served. Its position relative to the 401 in (4) is
    // not observable — the two branches are mutually exclusive on any single
    // request — but its position relative to everything BELOW it is, and the
    // ordering tests pin that.
    if (peerId !== null && this._isRevoked(peerId)) {
      refuse(res, 410, 'revoked');
      return;
    }

    // (4) Nothing resolved. Fall back to this server's own session token,
    // compared over fixed-length digests so neither its length nor its bytes
    // leak through timing (I12 names timingSafeEqual explicitly).
    let caller = peerId;
    if (caller === null) {
      if (bearer.length > 0 && bearer.length <= MAX_BEARER_CHARS && timingSafeEqualStr(bearer, this._token)) {
        caller = this._channelPeerId;
        // The channel identity is revocable too, or "revoke everything" would
        // have a hole exactly the size of the pairing token.
        if (this._isRevoked(caller)) {
          refuse(res, 410, 'revoked');
          return;
        }
      } else {
        refuse(res, 401, 'unauthorized');
        return;
      }
    }

    // Endpoint shape is checked only once the caller is authenticated, so an
    // unauthenticated prober cannot map the surface.
    if ((req.url || '').split('?')[0] !== DESK_PATH) {
      refuse(res, 404, 'not_found');
      return;
    }
    if (req.method !== 'POST') {
      refuse(res, 405, 'method_not_allowed');
      return;
    }
    // Requiring application/json is CSRF defence in depth: the three content
    // types a cross-origin form can send without a preflight (text/plain,
    // multipart/form-data, application/x-www-form-urlencoded) are all refused
    // here, so a rebound page cannot reach the dispatcher even in the window
    // where its Host/Origin somehow passed.
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') {
      refuse(res, 415, 'unsupported_media_type');
      return;
    }

    // Only NOW may an `Expect: 100-continue` caller upload: Host, Origin,
    // revocation, bearer, path, method and media type have all passed, and the
    // declared Content-Length is checked inside _readBody before this fires.
    const release = expectContinue
      ? () => { if (!res.headersSent) { res.writeContinue(); } }
      : undefined;
    const read = await this._readBody(req, release);
    if (read.tooLarge) {
      refuse(res, 413, 'too_large');
      // Answer first, THEN drop the upload. Destroying the request stream
      // before the response has flushed is how a 413 turns into a connection
      // reset the client cannot distinguish from a crash.
      res.on('finish', () => { try { req.destroy(); } catch { /* already gone */ } });
      return;
    }
    if (read.text === null) {
      refuse(res, 400, 'bad_request');
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(read.text);
    } catch {
      refuse(res, 400, 'bad_request');
      return;
    }
    // Refuse rather than strip: stripping would change the bytes the I12
    // signature was computed over, turning a prototype-pollution attempt into a
    // confusing signature failure instead of a clean rejection.
    //
    // Checked AFTER parsing, over own keys. The previous form was a substring
    // scan of the raw text for `"__proto__"`, which (a) missed every JSON
    // escape — a body spelling the key with a backslash-u005f escape for its
    // underscores contains no such substring, parses to an own `__proto__`
    // key, and sailed straight through to deps.handle, (b) never looked at
    // `constructor`/`prototype` at all, and (c) refused a legitimate envelope
    // that merely carried the STRING "__proto__" as a value. A parsed walk has
    // none of the three failure modes.
    if (hasPollutingKey(body)) {
      refuse(res, 400, 'bad_request');
      return;
    }

    // (6) Everything above passed; the dispatcher owns the rest — verb,
    // signature, challenge, grant, scope. This server never inspects them.
    let result: unknown;
    try {
      result = await this._deps.handle(caller, body);
    } catch (err) {
      console.error(`[Mysti] DeskHttpServer: handler failed (${errLabel(err)})`);
      refuse(res, 500, 'internal');
      return;
    }
    let payload: string;
    try {
      // `as string | undefined`: the lib type says string, but JSON.stringify
      // genuinely returns undefined for a bare undefined/function/symbol, and
      // that value would reach Buffer.byteLength as an unhandled TypeError.
      const encoded = JSON.stringify(result ?? null) as string | undefined;
      if (encoded === undefined) { throw new Error('handler returned a non-serialisable value'); }
      payload = encoded;
    } catch (err) {
      console.error(`[Mysti] DeskHttpServer: handler result is not serialisable (${errLabel(err)})`);
      refuse(res, 500, 'internal');
      return;
    }
    res.writeHead(200, jsonHeaders(Buffer.byteLength(payload))).end(payload);
  }

  /** `deps.resolvePeer` is host code; a throw from it must not authenticate anyone. */
  private _resolve(bearer: string): string | null {
    if (bearer.length === 0 || bearer.length > MAX_BEARER_CHARS) { return null; }
    let peerId: string | null;
    try {
      peerId = this._deps.resolvePeer(bearer);
    } catch (err) {
      console.error(`[Mysti] DeskHttpServer: resolvePeer threw — treating as unauthenticated (${errLabel(err)})`);
      return null;
    }
    // A non-string (or empty) answer is a host bug, not an identity.
    return typeof peerId === 'string' && peerId.length > 0 ? peerId : null;
  }

  /** Fail CLOSED: an unanswerable revocation question is a revocation. */
  private _isRevoked(peerId: string): boolean {
    try {
      return this._deps.isRevoked(peerId) === true;
    } catch (err) {
      console.error(`[Mysti] DeskHttpServer: isRevoked threw — treating peer as revoked (${errLabel(err)})`);
      return true;
    }
  }

  /**
   * Read at most `_maxBody` bytes. The cap is enforced twice — once against a
   * declared Content-Length (so an oversized body is refused before a single
   * chunk is buffered) and once against the bytes actually received (because
   * Content-Length is attacker-supplied and chunked encoding omits it).
   */
  private _readBody(
    req: http.IncomingMessage,
    release?: () => void,
  ): Promise<{ text: string | null; tooLarge: boolean }> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this._maxBody) {
      return Promise.resolve({ text: null, tooLarge: true });
    }
    // A 100-continue caller is sitting on its body until now. Released only
    // after the declared length passed the cap, so an oversized upload is still
    // refused before a byte of it is invited.
    release?.();
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const done = (text: string | null, tooLarge: boolean) => {
        if (settled) { return; }
        settled = true;
        resolve({ text, tooLarge });
      };
      req.on('data', (c: Buffer) => {
        if (settled) { return; }
        total += c.length;
        if (total > this._maxBody) {
          // Stop accumulating at the cap rather than buffering the whole body
          // and measuring it afterwards. Pause instead of destroy so the 413
          // still has a socket to travel on; the caller drops it after.
          chunks.length = 0;
          req.pause();
          done(null, true);
          return;
        }
        chunks.push(c);
      });
      // No `total === 0` short-circuit: it was exactly equivalent to letting
      // '' fall through to JSON.parse (which throws -> the same 400), i.e. a
      // branch no test could ever distinguish. An indistinguishable branch is a
      // permanently surviving mutant, so it is deleted rather than tested.
      req.on('end', () => { done(Buffer.concat(chunks).toString('utf8'), false); });
      req.on('error', () => done(null, false));
      req.on('aborted', () => done(null, false));
    });
  }
}

const STOPPED_MESSAGE = 'DeskHttpServer stopped before startup completed';

function validateToken(token: string | undefined): string {
  if (token === undefined) { return crypto.randomBytes(24).toString('hex'); }
  if (typeof token !== 'string' || token.length < MIN_TOKEN_CHARS) {
    throw new TypeError(`DeskHttpServer: token must be a string of at least ${MIN_TOKEN_CHARS} characters`);
  }
  return token;
}

function validateChannelPeerId(id: string | undefined): string {
  if (id === undefined) { return DESK_CHANNEL_PEER_ID; }
  // `?? ` would have accepted '' — and an empty caller id is what `deps.handle`
  // then has to authorize.
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('DeskHttpServer: channelPeerId must be a non-empty string');
  }
  return id;
}

function validateMaxBody(bytes: number | undefined): number {
  if (bytes === undefined) { return DESK_MAX_BODY_BYTES; }
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 1) {
    throw new TypeError(`DeskHttpServer: maxBodyBytes must be a finite number >= 1, got ${String(bytes)}`);
  }
  // Clamp DOWN only: an option can lower the transport backstop, never raise it.
  return Math.min(Math.floor(bytes), DESK_MAX_BODY_BYTES);
}

/**
 * True when any object in the parsed body owns a key from {@link POLLUTING_KEYS}.
 *
 * Iterative on purpose: a 4 MiB body can encode a two-million-deep nest, and a
 * recursive walk would RangeError somewhere the caller does not expect it.
 * Rejected alternative: a node budget on top of the byte cap — the byte cap
 * already bounds this walk to O(body size), the same order as the JSON.parse
 * that just ran, and an untestable "too many nodes" branch would be one more
 * permanently surviving mutant.
 */
function hasPollutingKey(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') { continue; }
    // getOwnPropertyNames, not `in`/for-in: only OWN keys are the pollution
    // vector, and JSON.parse materialises `__proto__` as exactly that.
    for (const key of Object.getOwnPropertyNames(node)) {
      if (POLLUTING_KEYS.has(key)) { return true; }
      stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return false;
}

/**
 * Host callbacks own the text inside their Errors. A peer book that throws
 * `no peer for bearer <value>` would write a live credential into the
 * extension-host log — the one channel through which request-derived bytes
 * could otherwise escape a module that is scrupulous about never echoing the
 * request. Only the constructor name crosses; the stack is dropped with it
 * because V8 prefixes the stack with the message.
 */
function errLabel(err: unknown): string {
  return err instanceof Error ? (err.name || 'Error') : typeof err;
}

/** Constant-shape refusal. No echo of the request, no detail, no hint. */
function refuse(res: http.ServerResponse, status: number, error: Refusal): void {
  const payload = JSON.stringify({ ok: false, error });
  res.writeHead(status, jsonHeaders(Buffer.byteLength(payload))).end(payload);
}

function jsonHeaders(length: number): http.OutgoingHttpHeaders {
  return {
    'content-type': 'application/json',
    'content-length': length,
    // The response can carry remote-authored bytes onward; never let a browser
    // sniff it into something executable, and never let it sit in a cache.
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}

/**
 * `Bearer <token>` -> `<token>`; anything else -> `''`.
 *
 * Exported so the EXTRACTION can be pinned directly. Driven only through the
 * server it is untestable in the way that matters: loosening `(\S+)` to `(.+)`
 * merely makes a mangled bearer fail to resolve, which looks identical to a
 * correct refusal from the outside.
 */
export function extractBearer(header: string | string[] | undefined): string {
  if (typeof header !== 'string') { return ''; }
  const m = header.match(/^Bearer[ \t]+(\S+)[ \t]*$/i);
  return m ? m[1] : '';
}

/**
 * Compare over sha256 digests, not raw bytes: `timingSafeEqual` throws on a
 * length mismatch, and the usual "return false if lengths differ" guard turns
 * the secret's length into a timing oracle. Fixed-width digests have neither
 * problem (I12).
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** True when a Host header names a loopback host (`127.0.0.1`/`localhost`/`[::1]`, optional port). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) { return false; }
  const m = host.match(/^(\[[^\]]*\]|[^:]+)(:\d+)?$/);
  if (!m) { return false; }
  const h = m[1].toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

/** True when an Origin header (if a browser sent one) is a localhost origin. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false; // includes the opaque "null" origin
  }
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    server.close(done);
    // Keep-alive sockets hold close() open indefinitely; the caller is
    // disposing, so drop them (node >= 18.2).
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    if (!server.listening) { done(); }
  });
}
