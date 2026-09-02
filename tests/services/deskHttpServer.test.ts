/**
 * DeskHttpServer tests (Plan 21 Phase 2, transport tier T0).
 *
 * The claim under test is not "each check exists" — it is that the checks fire
 * in a fixed ORDER, and that an earlier refusal wins over a later one that
 * would also have fired. Every ordering test therefore constructs a request
 * that trips TWO gates at once and asserts the EARLIER code, so reordering the
 * handler (or deleting a gate and letting the next one "cover" it) turns the
 * suite red rather than leaving it green with a weaker guarantee.
 *
 * Everything is driven over a real loopback socket with fully attacker-chosen
 * headers, because the properties being asserted (Host spoofing, chunked
 * bodies with no Content-Length, oversized uploads) are not reachable by
 * calling the class's methods directly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';

/**
 * `crypto.timingSafeEqual` is wrapped, not replaced, so the constant-time
 * property of the token compare can be pinned MECHANICALLY. Asserting only "a
 * wrong token of the right length is 401" pins the return value, which a plain
 * `a === b` satisfies too — that mutant survived the whole suite. Recording the
 * call proves the compare went through timingSafeEqual over two fixed-width
 * digests. Timing the two paths statistically was the rejected alternative: on
 * a shared CI box it is flaky in both directions, and a flaky security test
 * gets deleted.
 */
const cryptoSpy = vi.hoisted(() => ({ timingSafeEqualCalls: [] as Array<[number, number]> }));
vi.mock('crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('crypto')>();
  return {
    ...real,
    default: real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      cryptoSpy.timingSafeEqualCalls.push([a.byteLength, b.byteLength]);
      return real.timingSafeEqual(a, b);
    },
  };
});

import {
  DeskHttpServer,
  DESK_MAX_BODY_BYTES,
  DESK_CHANNEL_PEER_ID,
  DESK_PATH,
  DESK_HEADERS_TIMEOUT_MS,
  DESK_REQUEST_TIMEOUT_MS,
  extractBearer,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  type DeskServerDeps,
  type DeskBind,
} from '../../src/services/DeskHttpServer';

const PEER_BEARER = 'bearer-for-alice-0123456789';
const PEER_ID = 'p_alice';

interface Recorder {
  resolveArgs: string[];
  handled: Array<{ peer: string; body: unknown }>;
  revokedArgs: string[];
  challengeArgs: string[];
}

function makeDeps(over: Partial<DeskServerDeps> = {}): { deps: DeskServerDeps; rec: Recorder } {
  const rec: Recorder = { resolveArgs: [], handled: [], revokedArgs: [], challengeArgs: [] };
  const base: DeskServerDeps = {
    resolvePeer: (b) => { rec.resolveArgs.push(b); return b === PEER_BEARER ? PEER_ID : null; },
    challengeFor: (p) => { rec.challengeArgs.push(p); return 'c_challenge'; },
    handle: async (peer, body) => { rec.handled.push({ peer, body }); return { ok: true, echo: body }; },
    isRevoked: (p) => { rec.revokedArgs.push(p); return false; },
  };
  return { deps: { ...base, ...over }, rec };
}

interface RawOpts {
  headers?: Record<string, string>;
  path?: string;
  method?: string;
  body?: string;
  /** Suppress node's automatic Content-Length by using chunked encoding. */
  chunked?: boolean;
}

interface RawResult { status: number; body: string; headers: http.IncomingHttpHeaders }

function raw(port: number, opts: RawOpts = {}): Promise<RawResult> {
  const body = opts.body ?? '{}';
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.chunked) { headers['transfer-encoding'] = 'chunked'; }
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent:false — every request gets its own connection. With keep-alive
      // the server's post-refusal socket teardown lands on the NEXT request as
      // an ECONNRESET, which would make ordering assertions flaky rather than
      // wrong.
      { host: '127.0.0.1', port, path: opts.path ?? DESK_PATH, method: opts.method ?? 'POST', headers, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Servers started by a test, torn down even when it throws. */
const live: DeskHttpServer[] = [];
async function start(deps: DeskServerDeps, opts?: { token?: string; maxBodyBytes?: number; channelPeerId?: string }) {
  const s = new DeskHttpServer(deps, opts);
  live.push(s);
  const h = await s.start();
  return { server: s, handle: h };
}
afterEach(async () => {
  while (live.length) { await live.pop()!.stop(); }
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('DeskHttpServer — binding', () => {
  it('binds loopback on an ephemeral port and reports a usable handle', async () => {
    const { deps } = makeDeps();
    const { server, handle } = await start(deps);
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/desk$/);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.token).toHaveLength(48);
    expect(server.isRunning).toBe(true);
  });

  it("bind 'off' creates NO listener at all — not a listener that refuses", async () => {
    const activeHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
    expect(typeof activeHandles).toBe('function');
    const before = new Set(activeHandles!.call(process));

    const { deps } = makeDeps();
    const server = new DeskHttpServer(deps);
    live.push(server);
    const handle = await server.start('off');

    expect(handle.port).toBe(0);
    expect(handle.url).toBe('');
    expect(handle.token).toBe(server.token);
    expect(server.isRunning).toBe(false);
    const leaked = activeHandles!.call(process).filter(
      (h): h is http.Server => !before.has(h) && h instanceof http.Server && h.listening,
    );
    expect(leaked).toHaveLength(0);
  });

  it("start('off') on a RUNNING server tears the listener down — 'off' is authoritative, not advisory", async () => {
    // The regression this pins: the 'off' branch used to short-circuit above
    // every piece of state, so a host reacting to the machine-scoped `bind`
    // setting by calling start('off') on the live instance was told
    // {port:0,url:''} while the original socket kept serving the pairing token.
    const activeHandles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles;
    const before = new Set(activeHandles.call(process));
    const { deps, rec } = makeDeps();
    const { server, handle } = await start(deps);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER) })).status).toBe(200);

    const off = await server.start('off');
    expect(off).toEqual({ port: 0, token: server.token, url: '' });
    expect(server.isRunning).toBe(false);
    // The old port must be GONE, not answering 403.
    await expect(raw(handle.port, { headers: auth(PEER_BEARER) })).rejects.toBeTruthy();
    const leaked = activeHandles.call(process).filter(
      (h): h is http.Server => !before.has(h) && h instanceof http.Server && h.listening,
    );
    expect(leaked).toHaveLength(0);
    expect(rec.handled).toHaveLength(1);   // the one pre-'off' request, and no more
  });

  it("start('off') is re-startable, while stop() stays permanent for BOTH bind values", async () => {
    const { deps } = makeDeps();
    const server = new DeskHttpServer(deps);
    live.push(server);
    await server.start('off');
    const back = await server.start('loopback');       // 'off' is not a tombstone
    expect(back.port).toBeGreaterThan(0);
    expect((await raw(back.port, { headers: auth(PEER_BEARER) })).status).toBe(200);

    await server.stop();
    // …but stop() is. Previously start('off') skipped the stopped check and
    // handed back a live token from a permanently dead server.
    await expect(server.start('off')).rejects.toThrow(/stopped before startup/);
    await expect(server.start('loopback')).rejects.toThrow(/stopped before startup/);
  });

  it('refuses every bind that is not loopback (Phase 3 tailnet/lan must add TLS first)', async () => {
    const { deps } = makeDeps();
    const server = new DeskHttpServer(deps);
    live.push(server);
    for (const bad of ['tailnet', 'lan', '0.0.0.0', '', 'LOOPBACK']) {
      await expect(server.start(bad as unknown as DeskBind)).rejects.toThrow(/unsupported bind/);
    }
    expect(server.isRunning).toBe(false);
  });

  it('the body cap is 4 MiB and cannot be raised by an option', async () => {
    expect(DESK_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps, { maxBodyBytes: DESK_MAX_BODY_BYTES * 8 });
    // Declared oversize, sent by hand: the point is that the refusal lands
    // BEFORE the body is uploaded, so there is no 4 MiB write to race with.
    const status = await rawSocket(handle.port,
      `POST ${DESK_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${PEER_BEARER}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${DESK_MAX_BODY_BYTES + 1}\r\nConnection: close\r\n\r\n{}`);
    expect(status).toBe(413);
    expect(rec.handled).toHaveLength(0);
  });

  it('a body cap that is not a usable number is REFUSED at construction, never absorbed', () => {
    // The bug this pins was silent and total: Math.max(1, Math.min(NaN, CEIL))
    // is NaN, and `declared > NaN` / `total > NaN` are both false, so BOTH cap
    // checks became no-ops while the class still claimed to have a cap. NaN is
    // what Number(cfg.get('mysti.desk.maxBodyBytes')) yields for a typo'd
    // machine-scoped setting, so this is the live path.
    const { deps } = makeDeps();
    for (const bad of [Number('nope'), NaN, Infinity, -Infinity, 0, -1, -DESK_MAX_BODY_BYTES]) {
      expect(() => new DeskHttpServer(deps, { maxBodyBytes: bad })).toThrow(/maxBodyBytes/);
    }
    for (const bad of ['512', null, {}, true]) {
      expect(() => new DeskHttpServer(deps, { maxBodyBytes: bad as unknown as number })).toThrow(/maxBodyBytes/);
    }
    // …while "not specified" is still the default, not an error.
    expect(() => new DeskHttpServer(deps, {})).not.toThrow();
    expect(() => new DeskHttpServer(deps, { maxBodyBytes: undefined })).not.toThrow();
    expect(() => new DeskHttpServer(deps, { maxBodyBytes: 1 })).not.toThrow();
  });

  it('a token or channel peer id that cannot authenticate anyone is refused at construction', () => {
    const { deps } = makeDeps();
    // '' is what `??` lets through — and an empty token makes the channel
    // identity unreachable while the handle still advertises one, while a short
    // one is guessable over a port with no rate limit.
    for (const bad of ['', 'short', 'fifteen-chars-x']) {
      expect(() => new DeskHttpServer(deps, { token: bad })).toThrow(/token/);
    }
    expect(() => new DeskHttpServer(deps, { token: 'sixteen-chars-ok' })).not.toThrow();
    expect(() => new DeskHttpServer(deps, { channelPeerId: '' })).toThrow(/channelPeerId/);
    expect(() => new DeskHttpServer(deps, { channelPeerId: null as unknown as string })).toThrow(/channelPeerId/);
  });

  it('installs its own socket timeouts rather than inheriting node’s 60 s / 300 s defaults', async () => {
    const { deps } = makeDeps();
    const { server } = await start(deps);
    // Asserted on the LIVE server: deleting the two assignments in _start is
    // otherwise invisible (node's defaults are 60_000/300_000 and no
    // request-level test can tell without waiting a minute).
    expect(server.socketTimeouts).toEqual({ headersMs: DESK_HEADERS_TIMEOUT_MS, requestMs: DESK_REQUEST_TIMEOUT_MS });
    expect(DESK_HEADERS_TIMEOUT_MS).toBe(10_000);
    expect(DESK_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(server.socketTimeouts!.headersMs).toBeLessThan(60_000);
    expect(server.socketTimeouts!.requestMs).toBeLessThan(300_000);
    await server.stop();
    expect(server.socketTimeouts).toBeNull();
  });
});

describe('DeskHttpServer — happy path', () => {
  it('hands a resolved peer id and the parsed body to deps.handle', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: auth(PEER_BEARER), body: '{"verb":"status","n":1}' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, echo: { verb: 'status', n: 1 } });
    expect(rec.handled).toEqual([{ peer: PEER_ID, body: { verb: 'status', n: 1 } }]);
  });

  it('a request bearing the session token is served as the reserved channel identity, never as a peer', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps, { token: 'session-token-abc' });
    const res = await raw(handle.port, { headers: auth('session-token-abc') });
    expect(res.status).toBe(200);
    expect(rec.handled[0].peer).toBe(DESK_CHANNEL_PEER_ID);
    expect(rec.handled[0].peer).not.toBe(PEER_ID);
  });

  it('the channel identity is revocable too — a pairing token is not a permanent key', async () => {
    const { deps, rec } = makeDeps({ isRevoked: (p) => p === DESK_CHANNEL_PEER_ID });
    const { handle } = await start(deps, { token: 'session-token-abc' });
    expect((await raw(handle.port, { headers: auth('session-token-abc') })).status).toBe(410);
    expect(rec.handled).toHaveLength(0);
  });

  it('responses are nosniff + no-store', async () => {
    const { deps } = makeDeps();
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: auth(PEER_BEARER) });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toBe('application/json');
  });
});

// ── The ordering property. Each test trips two gates and asserts the earlier. ──
describe('DeskHttpServer — rejection ORDER', () => {
  it('(1 before 4) a rebound Host wins over a perfectly valid bearer: 403, not 200 and not 401', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: { host: 'evil.example.com', ...auth(PEER_BEARER) } });
    expect(res.status).toBe(403);
    expect(rec.handled).toHaveLength(0);
  });

  it('(1 before 4) a rebound Host with a BAD bearer is 403, not 401 — the port never admits it speaks Desk', async () => {
    const { deps } = makeDeps();
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: { host: 'evil.example.com', ...auth('nope') } })).status).toBe(403);
  });

  it('(1 before 3) a rebound Host wins over a revoked peer: 403, not 410', async () => {
    const { deps } = makeDeps({ isRevoked: () => true });
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: { host: 'evil.example.com:8080', ...auth(PEER_BEARER) } });
    expect(res.status).toBe(403);
  });

  it('(1) a missing Host header is refused, not defaulted', async () => {
    // node always sends one, so drive the socket by hand.
    const { deps } = makeDeps();
    const { handle } = await start(deps);
    // HTTP/1.1 without a Host is rejected by node's own parser (400), so the
    // only way to reach OUR check with no Host is HTTP/1.0.
    const status = await rawSocket(handle.port,
      `POST ${DESK_PATH} HTTP/1.0\r\nAuthorization: Bearer ${PEER_BEARER}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
    expect(status).toBe(403);
  });

  it('(2 before 4) a non-loopback Origin wins over a valid bearer, and "null" counts as non-loopback', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: { origin: 'https://evil.example.com', ...auth(PEER_BEARER) } })).status).toBe(403);
    expect((await raw(handle.port, { headers: { origin: 'null', ...auth(PEER_BEARER) } })).status).toBe(403);
    expect((await raw(handle.port, { headers: { origin: 'http://localhost:3000', ...auth(PEER_BEARER) } })).status).toBe(200);
    expect(rec.handled).toHaveLength(1);
  });

  it('(3 before 4) a revoked peer is 410 even though its bearer is not the session token', async () => {
    // If the token comparison ran first, this bearer (which is NOT the token)
    // would produce a 401 — the wrong claim, and one that hides the revocation.
    const { deps, rec } = makeDeps({ isRevoked: (p) => p === PEER_ID });
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: auth(PEER_BEARER) });
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'revoked' });
    expect(rec.handled).toHaveLength(0);
  });

  it('(3 before 5) a revoked peer is 410 whatever it sends — revocation precedes routing, media type, size and parsing', async () => {
    const { deps, rec } = makeDeps({ isRevoked: () => true });
    const { handle } = await start(deps, { maxBodyBytes: 128 });
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), body: '{not json' })).status).toBe(410);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), path: '/admin' })).status).toBe(410);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), method: 'GET' })).status).toBe(410);
    expect((await raw(handle.port, { headers: { ...auth(PEER_BEARER), 'content-type': 'text/plain' } })).status).toBe(410);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), body: JSON.stringify({ a: 'x'.repeat(400) }) })).status).toBe(410);
    expect(rec.handled).toHaveLength(0);
  });

  it('(4 before 5) a bad bearer with a malformed body is 401, not 400', async () => {
    const { deps } = makeDeps();
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: auth('nope'), body: '{not json' })).status).toBe(401);
  });

  it('(4 before routing) an unauthenticated caller cannot map the surface: 401, not 404/405/415', async () => {
    const { deps } = makeDeps();
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: auth('nope'), path: '/admin' })).status).toBe(401);
    expect((await raw(handle.port, { headers: auth('nope'), method: 'GET' })).status).toBe(401);
    expect((await raw(handle.port, { headers: { ...auth('nope'), 'content-type': 'text/plain' } })).status).toBe(401);
    // …and an authenticated one gets the real answers.
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), path: '/admin' })).status).toBe(404);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), method: 'GET' })).status).toBe(405);
  });

  it('(5 before 6) a body over the cap never reaches deps.handle', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps, { maxBodyBytes: 512 });
    const res = await raw(handle.port, { headers: auth(PEER_BEARER), body: JSON.stringify({ a: 'x'.repeat(2000) }) });
    expect(res.status).toBe(413);
    expect(rec.handled).toHaveLength(0);
  });
});

describe('DeskHttpServer — bearer handling', () => {
  it('refuses a missing, malformed or wrong-scheme Authorization header — and never EXTRACTS one', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    for (const h of [{}, { authorization: '' }, { authorization: PEER_BEARER }, { authorization: `Token ${PEER_BEARER}` },
      { authorization: `Bearer${PEER_BEARER}` }, { authorization: 'Bearer ' }, { authorization: `Bearer ${PEER_BEARER} extra` }]) {
      expect((await raw(handle.port, { headers: h as Record<string, string> })).status).toBe(401);
    }
    // Pinning the 401 alone let a loosened regex survive: `Bearer <tok> extra`
    // would then EXTRACT "<tok> extra" and merely fail to resolve — same status,
    // different property. The peer book must never have been offered anything.
    expect(rec.resolveArgs).toEqual([]);
    // The scheme itself is case-insensitive per RFC 7235 — that is not a bypass.
    expect((await raw(handle.port, { headers: { authorization: `bEaReR ${PEER_BEARER}` } })).status).toBe(200);
    expect(rec.resolveArgs).toEqual([PEER_BEARER]);
  });

  it('extractBearer takes the whole token or nothing — no trailing junk, no missing separator', () => {
    expect(extractBearer(`Bearer ${PEER_BEARER}`)).toBe(PEER_BEARER);
    expect(extractBearer(`bEaReR ${PEER_BEARER}`)).toBe(PEER_BEARER);
    expect(extractBearer(`Bearer \t ${PEER_BEARER}\t `)).toBe(PEER_BEARER);
    // Each of these yields '' — never a mangled bearer that a peer book might
    // trim, normalise, or prefix-match its way back to a real identity.
    expect(extractBearer(`Bearer ${PEER_BEARER} extra`)).toBe('');
    expect(extractBearer(`Bearer ${PEER_BEARER} ${PEER_BEARER}`)).toBe('');
    expect(extractBearer(`Bearer${PEER_BEARER}`)).toBe('');
    expect(extractBearer('Bearer ')).toBe('');
    expect(extractBearer('Bearer')).toBe('');
    expect(extractBearer(`Token ${PEER_BEARER}`)).toBe('');
    expect(extractBearer(` Bearer ${PEER_BEARER}`)).toBe('');
    expect(extractBearer(PEER_BEARER)).toBe('');
    expect(extractBearer(undefined)).toBe('');
    expect(extractBearer([`Bearer ${PEER_BEARER}`, `Bearer ${PEER_BEARER}`])).toBe('');
  });

  it('the session-token compare goes through timingSafeEqual over fixed-width digests', async () => {
    const { deps } = makeDeps();
    const { handle } = await start(deps, { token: 'a'.repeat(48) });
    cryptoSpy.timingSafeEqualCalls.length = 0;

    // Same length as the real token…
    expect((await raw(handle.port, { headers: auth('b'.repeat(48)) })).status).toBe(401);
    // …and wildly different. Neither may short-circuit on length, and both must
    // be compared, so the number of bytes examined never depends on the secret.
    expect((await raw(handle.port, { headers: auth('b') })).status).toBe(401);
    expect((await raw(handle.port, { headers: auth('b'.repeat(4096)) })).status).toBe(401);
    expect((await raw(handle.port, { headers: auth('a'.repeat(48)) })).status).toBe(200);

    // Four compares, every one over two 32-byte sha256 digests. A plain
    // `a === b` (or a `length !== length -> false` guard, the classic length
    // oracle) records nothing here and turns this red.
    expect(cryptoSpy.timingSafeEqualCalls).toEqual([[32, 32], [32, 32], [32, 32], [32, 32]]);
  });

  it('an empty bearer is never offered to resolvePeer — a host that maps "" cannot be tricked into it', async () => {
    const rec: string[] = [];
    const { deps } = makeDeps({ resolvePeer: (b) => { rec.push(b); return 'p_anyone'; } });
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: { authorization: 'Bearer ' } })).status).toBe(401);
    expect((await raw(handle.port, {})).status).toBe(401);
    expect(rec).toEqual([]);
  });

  it('an absurdly long bearer is refused without a peer-book lookup', async () => {
    const rec: string[] = [];
    const { deps } = makeDeps({ resolvePeer: (b) => { rec.push(b); return PEER_ID; } });
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: auth('z'.repeat(9000)) })).status).toBe(401);
    expect(rec).toEqual([]);
  });

  it('resolvePeer throwing authenticates nobody (fail closed)', async () => {
    const { deps } = makeDeps({ resolvePeer: () => { throw new Error('peer book corrupt'); } });
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER) })).status).toBe(401);
  });

  it('a non-string or empty peer id from the host is not an identity', async () => {
    for (const bad of ['', 42, null, undefined, {}]) {
      const { deps, rec } = makeDeps({ resolvePeer: () => bad as unknown as string | null });
      const { handle } = await start(deps);
      expect((await raw(handle.port, { headers: auth(PEER_BEARER) })).status).toBe(401);
      expect(rec.handled).toHaveLength(0);
    }
  });

  it('isRevoked throwing revokes (fail closed), and a non-true answer is not a pass', async () => {
    const { deps, rec } = makeDeps({ isRevoked: () => { throw new Error('store unreadable'); } });
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER) })).status).toBe(410);
    expect(rec.handled).toHaveLength(0);

    const truthy = makeDeps({ isRevoked: () => 'yes' as unknown as boolean });
    const h2 = await start(truthy.deps);
    // A truthy non-boolean is NOT treated as revoked (=== true), so the request
    // proceeds; the point is that the coercion is explicit and tested either way.
    expect((await raw(h2.handle.port, { headers: auth(PEER_BEARER) })).status).toBe(200);
  });
});

describe('DeskHttpServer — body handling', () => {
  it('rejects malformed JSON and an empty body', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), body: '{"a":' })).status).toBe(400);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), body: '' })).status).toBe(400);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), body: 'undefined' })).status).toBe(400);
    expect(rec.handled).toHaveLength(0);
  });

  it('refuses a polluting own KEY anywhere in the parsed body — escapes included', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    // The escaped spelling is the one that mattered: it contains no literal
    // "__proto__" substring, so the old raw-text scan passed it, JSON.parse
    // materialised it as an own key, and deps.handle received it. Written with
    // \u escapes so the JSON on the wire really is escaped.
    const escapedProto = '{"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true},"verb":"status"}';
    for (const body of [
      escapedProto,
      '{"__proto__":{"polluted":true},"verb":"status"}',
      '{"verb":"status","args":{"constructor":{"prototype":{"pwn":1}}}}',   // the other classic vector
      '{"verb":"status","args":{"prototype":1}}',
      '{"verb":"status","args":[{"nested":[{"__proto__":{}}]}]}',           // nested through arrays
    ]) {
      const res = await raw(handle.port, { headers: auth(PEER_BEARER), body });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'bad_request' });
    }
    expect(rec.handled).toHaveLength(0);

    // …and a legitimate envelope that merely carries the STRING is served. The
    // old substring scan refused this, i.e. it was both bypassable and
    // over-broad. Deliberately NOT asserting ({}).polluted here: JSON.parse
    // never walks the prototype chain, so that assertion passes with the guard
    // deleted and certifies nothing.
    const ok = await raw(handle.port, { headers: auth(PEER_BEARER), body: '{"verb":"status","key":"__proto__"}' });
    expect(ok.status).toBe(200);
    expect(rec.handled).toEqual([{ peer: PEER_ID, body: { verb: 'status', key: '__proto__' } }]);
  });

  it('enforces the cap on a chunked body that declares no Content-Length', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps, { maxBodyBytes: 512 });
    const res = await raw(handle.port, {
      headers: auth(PEER_BEARER), chunked: true, body: JSON.stringify({ a: 'x'.repeat(4000) }),
    });
    expect(res.status).toBe(413);
    expect(rec.handled).toHaveLength(0);
  });

  it('refuses a LIED Content-Length that is under the cap while the body is over it', async () => {
    // Content-Length is attacker-supplied; the received-bytes counter is the
    // check that actually holds. Sent by hand so node does not fix the header.
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps, { maxBodyBytes: 256 });
    const payload = JSON.stringify({ a: 'x'.repeat(4000) });
    const status = await rawSocket(handle.port,
      `POST ${DESK_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${PEER_BEARER}\r\n` +
      `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
      `${payload.length.toString(16)}\r\n${payload}\r\n0\r\n\r\n`);
    expect(status).toBe(413);
    expect(rec.handled).toHaveLength(0);
  });

  it('accepts a body exactly at the cap (the boundary is inclusive)', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps, { maxBodyBytes: 64 });
    const body = JSON.stringify({ a: 'x'.repeat(64 - 8) });   // {"a":"x…"} === 64 bytes
    expect(Buffer.byteLength(body)).toBe(64);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), body })).status).toBe(200);
    expect((await raw(handle.port, { headers: auth(PEER_BEARER), body: body.replace('x"', 'xx"') })).status).toBe(413);
    expect(rec.handled).toHaveLength(1);
  });

  it('requires application/json — the CSRF-simple content types cannot reach the dispatcher', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const res = await raw(handle.port, { headers: { ...auth(PEER_BEARER), 'content-type': ct } });
      expect(res.status).toBe(415);
    }
    expect(rec.handled).toHaveLength(0);
    // A charset parameter is fine.
    expect((await raw(handle.port, { headers: { ...auth(PEER_BEARER), 'content-type': 'application/JSON; charset=utf-8' } })).status).toBe(200);
  });
});

describe('DeskHttpServer — handler failures leak nothing', () => {
  it('a throwing handler is a bare 500', async () => {
    const { deps } = makeDeps({ handle: async () => { throw new Error('/Users/secret/path exploded'); } });
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: auth(PEER_BEARER) });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'internal' });
    expect(res.body).not.toMatch(/secret|exploded/);
  });

  it('a non-serialisable result is a 500, not a half-written 200', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { deps } = makeDeps({ handle: async () => circular });
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: auth(PEER_BEARER) });
    expect(res.status).toBe(500);
  });

  it('a result JSON.stringify DROPS (function/symbol) is caught where it happens, not by the catch-all', async () => {
    // Both paths answer 500, so the status alone cannot tell them apart — which
    // is why the `payload === undefined` guard was a surviving mutant. Deleting
    // it hands `undefined` to Buffer.byteLength, which throws a TypeError that
    // the outer request handler catches: same 500, different log line, and a
    // failure attributed to the wrong place. The log line is the observable.
    for (const bad of [() => 'nope', Symbol('nope')]) {
      const errs: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
      try {
        let called = 0;
        const { deps } = makeDeps({ handle: async () => { called++; return bad; } });
        const { handle } = await start(deps);
        const res = await raw(handle.port, { headers: auth(PEER_BEARER) });
        expect(res.status).toBe(500);
        expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'internal' });
        expect(called).toBe(1);          // the handler ran; it is the ENCODING that failed
        expect(errs.join('\n')).toMatch(/handler result is not serialisable/);
        expect(errs.join('\n')).not.toMatch(/unhandled request error/);
      } finally { spy.mockRestore(); }
    }
  });

  it('logs a host error’s TYPE, never its message — a peer book must not be able to log a bearer', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
    try {
      const { deps } = makeDeps({
        resolvePeer: (b) => { throw new Error(`no peer for bearer ${b}`); },
        isRevoked: () => { throw new Error('store unreadable'); },
        handle: async () => { throw new Error('/Users/secret/path exploded'); },
      });
      const { handle } = await start(deps);
      expect((await raw(handle.port, { headers: auth(PEER_BEARER) })).status).toBe(401);
      const joined = errs.join('\n');
      expect(joined).toMatch(/resolvePeer threw/);
      expect(joined).toContain('(Error)');
      // The bearer is the credential the throw was ABOUT; it must not reach a
      // log the module otherwise keeps free of request-derived bytes.
      expect(joined).not.toContain(PEER_BEARER);
      expect(joined).not.toMatch(/no peer for bearer/);
    } finally { spy.mockRestore(); }
  });

  it('an undefined result serialises as null rather than an empty 200 body', async () => {
    const { deps } = makeDeps({ handle: async () => undefined });
    const { handle } = await start(deps);
    const res = await raw(handle.port, { headers: auth(PEER_BEARER) });
    expect(res.status).toBe(200);
    expect(res.body).toBe('null');
  });
});

describe('DeskHttpServer — lifecycle', () => {
  it('stop() is idempotent, safe before start, and permanent', async () => {
    const { deps } = makeDeps();
    const never = new DeskHttpServer(deps);
    await expect(never.stop()).resolves.toBeUndefined();
    await expect(never.stop()).resolves.toBeUndefined();
    await expect(never.start()).rejects.toThrow(/stopped before startup/);

    const live2 = new DeskHttpServer(deps);
    const h = await live2.start();
    await live2.stop();
    await live2.stop();
    expect(live2.isRunning).toBe(false);
    await expect(raw(h.port, { headers: auth(PEER_BEARER) })).rejects.toBeTruthy();
  });

  it('a stop() landing during startup leaves no listening socket', async () => {
    const activeHandles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles;
    const before = new Set(activeHandles.call(process));
    const { deps } = makeDeps();
    const server = new DeskHttpServer(deps);
    const starting = server.start();
    const stopping = server.stop();
    await expect(starting).rejects.toThrow(/stopped before startup/);
    await stopping;
    const leaked = activeHandles.call(process).filter(
      (h): h is http.Server => !before.has(h) && h instanceof http.Server && h.listening,
    );
    expect(leaked).toHaveLength(0);
  });

  it('concurrent start() calls share one listener', async () => {
    const { deps } = makeDeps();
    const server = new DeskHttpServer(deps);
    live.push(server);
    const [a, b] = await Promise.all([server.start(), server.start()]);
    expect(a.port).toBe(b.port);
    expect(await server.start()).toBe(a);
  });

  it('two servers mint two different tokens', () => {
    const { deps } = makeDeps();
    expect(new DeskHttpServer(deps).token).not.toBe(new DeskHttpServer(deps).token);
  });
});

describe('DeskHttpServer — the 413 answers before it drops the upload', () => {
  it('a client reads a COMPLETE 413 and then sees the socket dropped', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps, { maxBodyBytes: 1024 });
    // Declared oversize and keep-alive (no `Connection: close`), so the only
    // thing that can close this socket is the server's own req.destroy().
    const ex = await rawExchange(handle.port,
      `POST ${DESK_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${PEER_BEARER}\r\n` +
      `Content-Type: application/json\r\nContent-Length: 900000\r\nConnection: keep-alive\r\n\r\n`);

    // (a) the answer is whole — destroying the request stream BEFORE the
    // response flushes turns the 413 into an ECONNRESET the client cannot tell
    // from a crash. The decision notes record that regression actually
    // happening, and nothing was pinning it.
    expect(ex.statuses).toEqual([413]);
    expect(ex.raw).toContain('{"ok":false,"error":"too_large"}');
    expect(ex.raw).toContain('content-length: 32');
    // (b) …and then the upload is dropped rather than left welcome for the
    // remaining 900 KB.
    expect(ex.closed).toBe(true);
    expect(rec.handled).toHaveLength(0);
  });
});

describe('DeskHttpServer — Expect: 100-continue runs the same gates', () => {
  const wire = (host: string, extra: string, len: number) =>
    `POST ${DESK_PATH} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
    `${extra}Expect: 100-continue\r\nContent-Length: ${len}\r\nConnection: keep-alive\r\n\r\n`;

  it('never auto-answers 100 to a caller the gates would refuse', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    // Rebound Host, no bearer, 100 MB declared. Left to node this receives
    // "HTTP/1.1 100 Continue" as its FIRST line — a distinct pre-gate response
    // that both breaks the constant-shape refusal claim and invites an
    // unauthenticated caller to upload.
    const rebound = await rawExchange(handle.port, wire('evil.example.com', '', 99_999_999));
    expect(rebound.statuses).toEqual([403]);
    expect(rebound.raw).not.toContain('100 Continue');

    const noBearer = await rawExchange(handle.port, wire('127.0.0.1', '', 99_999_999));
    expect(noBearer.statuses).toEqual([401]);
    expect(noBearer.raw).not.toContain('100 Continue');

    // Authenticated but over the cap: still no invitation to upload.
    const tooBig = await rawExchange(handle.port,
      wire('127.0.0.1', `Authorization: Bearer ${PEER_BEARER}\r\n`, DESK_MAX_BODY_BYTES + 1));
    expect(tooBig.statuses).toEqual([413]);
    expect(tooBig.raw).not.toContain('100 Continue');
    expect(rec.handled).toHaveLength(0);
  });

  it('releases a legitimate caller with 100 and then serves it', async () => {
    const { deps, rec } = makeDeps();
    const { handle } = await start(deps);
    const body = '{"verb":"status"}';
    const ex = await rawExchange(handle.port,
      wire('127.0.0.1', `Authorization: Bearer ${PEER_BEARER}\r\n`, Buffer.byteLength(body)),
      { sendAfterContinue: body });
    expect(ex.raw).toContain('100 Continue');
    expect(ex.statuses).toEqual([100, 200]);
    expect(rec.handled).toEqual([{ peer: PEER_ID, body: { verb: 'status' } }]);
  });
});

describe('DeskHttpServer — deps.challengeFor is never called from the carrier', () => {
  it('no probe, refused or served, mints a challenge', async () => {
    const { deps, rec } = makeDeps({ isRevoked: (p) => p === 'p_revoked' });
    const { handle } = await start(deps, { token: 'session-token-abc' });
    await raw(handle.port, { headers: { host: 'evil.example.com', ...auth(PEER_BEARER) } });   // 403
    await raw(handle.port, { headers: { origin: 'null', ...auth(PEER_BEARER) } });             // 403
    await raw(handle.port, { headers: auth('nope') });                                         // 401
    await raw(handle.port, { headers: auth(PEER_BEARER), path: '/admin' });                     // 404
    await raw(handle.port, { headers: auth(PEER_BEARER), method: 'GET' });                      // 405
    await raw(handle.port, { headers: { ...auth(PEER_BEARER), 'content-type': 'text/plain' } });// 415
    await raw(handle.port, { headers: auth(PEER_BEARER), body: '{oops' });                      // 400
    await raw(handle.port, { headers: auth(PEER_BEARER) });                                     // 200
    await raw(handle.port, { headers: auth('session-token-abc') });                             // 200 (channel)
    // Wiring challengeFor in here would mint a challenge for every 403/401
    // probe, i.e. hand unauthenticated callers control of challenge state. The
    // non-call is a design decision, so it gets an assertion.
    expect(rec.challengeArgs).toEqual([]);
    expect(rec.handled).toHaveLength(2);
  });
});

// ── The rebinding/cross-site parsers, tested directly. Driving them through
// three fixed header values left both of them unpinned: an anchored-regex
// deletion and a scheme-check deletion each survived the whole suite. ─────────
describe('isLoopbackHostHeader', () => {
  it.each([
    ['127.0.0.1', true], ['localhost', true], ['[::1]', true],
    ['127.0.0.1:8080', true], ['localhost:3000', true], ['[::1]:8080', true],
    ['LOCALHOST', true], ['LocalHost:80', true],
    // The whole point: a name that merely CONTAINS a loopback label is not one.
    ['localhost.evil.com', false], ['127.0.0.1.evil.com', false],
    ['evil.com:localhost', false], ['xlocalhost', false], ['localhost.', false],
    ['evil.example.com', false], ['evil.example.com:8080', false],
    ['127.0.0.2', false], ['0.0.0.0', false], ['[::]', false],
    // A v4-mapped v6 literal is NOT on the allowlist — strict is the direction
    // we want, and an unrecognised form must fall to false, never to true.
    ['[::ffff:127.0.0.1]', false], ['[0:0:0:0:0:0:0:1]', false],
    ['localhost:80:80', false], ['127.0.0.1:', false], [':8080', false],
    ['', false], [' ', false], ['localhost ', false], [' localhost', false],
    ['user@localhost', false], ['localhost/../x', false],
  ])('%s -> %s', (host, expected) => {
    expect(isLoopbackHostHeader(host)).toBe(expected);
  });

  it('an absent Host header is not a loopback host', () => {
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it.each([
    ['http://localhost', true], ['http://localhost:3000', true],
    ['http://127.0.0.1:5173', true], ['https://localhost:8443', true],
    ['HTTP://LOCALHOST:3000', true], ['http://[::1]:9000', true],
    ['https://evil.example.com', false], ['http://localhost.evil.com', false],
    // Userinfo puts the real host after the '@' — the classic misread.
    ['http://localhost@evil.com', false], ['http://evil.com#localhost', false],
    // Non-http schemes never speak for a loopback page, and one of them is a
    // VSCode webview origin: deleting the scheme check made every one of these
    // pass, and that deletion survived the suite.
    ['file:///etc/passwd', false], ['ws://localhost:3000', false],
    ['wss://localhost', false], ['vscode-webview://localhost', false],
    ['data:text/html,x', false], ['javascript:alert(1)', false],
    ['chrome-extension://localhost', false],
    // The opaque origin of a sandboxed frame, and plain garbage.
    ['null', false], ['', false], ['localhost:3000', false], ['//localhost', false],
  ])('%s -> %s', (origin, expected) => {
    expect(isLoopbackOrigin(origin)).toBe(expected);
  });
});

/** Send a hand-written request line-by-line; returns the status code. */
function rawSocket(port: number, wire: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => { sock.write(wire); });
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => {
      data += c;
      const m = data.match(/^HTTP\/1\.\d (\d{3})/);
      if (m) { sock.destroy(); resolve(Number(m[1])); }
    });
    sock.on('error', reject);
    sock.on('close', () => { if (!data) { reject(new Error('closed with no response')); } });
  });
}

interface Exchange {
  /** Every status line seen, in order — so a stray "100 Continue" cannot hide. */
  statuses: number[];
  raw: string;
  /** True when the SERVER closed the socket (nothing here sends Connection: close). */
  closed: boolean;
}

/**
 * Like {@link rawSocket}, but reads the response to completion instead of
 * stopping at the status line, and reports whether the server dropped the
 * socket. Both are needed to tell "answered in full, then dropped the upload"
 * apart from "reset mid-answer", which is the property the 413 path turns on.
 */
function rawExchange(
  port: number,
  wire: string,
  opts: { sendAfterContinue?: string; waitMs?: number } = {},
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => { sock.write(wire); });
    let raw = '';
    let sent = false;
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ statuses: [...raw.matchAll(/HTTP\/1\.\d (\d{3})/g)].map((m) => Number(m[1])), raw, closed });
    };
    const timer = setTimeout(() => finish(false), opts.waitMs ?? 700);
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => {
      raw += c;
      if (opts.sendAfterContinue && !sent && raw.includes('100 Continue')) {
        sent = true;
        sock.write(opts.sendAfterContinue);
      }
      // A final response is complete once its body has arrived; wait for the
      // close (or the timer) to learn whether the server dropped the socket.
      if (opts.sendAfterContinue && sent && /HTTP\/1\.\d 2\d\d/.test(raw) && raw.trimEnd().endsWith('}')) {
        finish(false);
      }
    });
    sock.on('close', () => { if (raw) { finish(true); } else { reject(new Error('closed with no response')); } });
    sock.on('error', (e) => { if (!settled) { reject(e); } });
  });
}
