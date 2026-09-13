import { createHash, randomBytes, randomUUID } from 'crypto';
import { DeskPeerBook } from '../managers/DeskPeerBook';
import { DeskIdentity } from './desk/DeskIdentity';
import { canonicalize, newChallenge, verify } from './desk/DeskEnvelope';
import type { SignedEnvelope } from './desk/DeskEnvelope';
import { dispatch } from './desk/DeskDispatch';
import type { DeskStatus } from './desk/DeskDispatch';
import { DeskIndex } from './desk/DeskIndex';
import { EMPTY_SCOPE } from './desk/DeskScope';
import { validateCall } from './desk/DeskContract';
import { screenOutbound } from './desk/DeskRedactor';
import type { DeskWorkspaceLookup, DeskLookupSnapshot } from './DeskWorkspaceLookup';
import { DeskHttpServer } from './DeskHttpServer';
import type { DeskHttpHandle } from './DeskHttpServer';
import { DeskClient } from './DeskClient';
import type { DeskCallOutcome } from './DeskClient';
import { DeskLoopbackTransport, isDeskLoopbackUrl } from './DeskLoopbackTransport';

const SESSION_MS = 10 * 60_000;
const MAX_SESSIONS = 32;
const MAX_CALLS = 128;
const CHANNEL_REQUESTS_PER_MINUTE = 32;
const LINK_PREFIX = 'desk://local-status/';
const LOOKUP_PREFIX = 'desk://local-lookup/';
const emptyIndex = DeskIndex.build(EMPTY_SCOPE, { paths: [], readText: () => null });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface Connection {
  v: 1;
  url: string;
  bearer: string;
  challenge: string;
  peerId: string;
  audience: string;
  expiresAt: number;
}

interface Session {
  verb: 'status' | 'locate';
  lookup?: DeskLookupSnapshot;
  peerId: string;
  publicKey: string;
  challenge: string;
  expiresAt: number;
  calls: Map<string, { hash: string; result: Promise<unknown> }>;
  windowStartedAt: number;
  requestsRemaining: number;
}

export interface DeskLocalStatusDeps {
  identity: DeskIdentity;
  peerBook: DeskPeerBook;
  enabled(): boolean;
  serving(): boolean;
  trusted(): boolean;
  now(): number;
}

/**
 * Production T0 composition: one expiring channel per pinned recipient, signed
 * requests/replies, and owner-selected status or workspace coordinates.
 * The channel descriptor is transferred by the local human, never persisted.
 * Workspace snapshots are prepared only by an explicit local sharing command.
 */
export class DeskLocalStatus {
  private _server?: DeskHttpServer;
  private _handle?: DeskHttpHandle;
  private _starting?: Promise<void>;
  private _epoch = 0;
  private _disposed = false;
  private _sessions = new Map<string, Session>();
  private _outbound = new Set<AbortController>();
  private _availability: DeskStatus['availability'] = 'offline';

  constructor(private readonly _deps: DeskLocalStatusDeps) {}

  private _allowed(): boolean {
    return !this._disposed && this._deps.enabled() === true && this._deps.trusted() === true;
  }

  private _canServe(): boolean { return this._allowed() && this._deps.serving() === true; }

  /** Configuration/trust changes take effect without reloading the extension. */
  refresh(): Promise<void> {
    if (!this._canServe()) { return this.stop(); }
    if (this._server) { return this._starting ?? Promise.resolve(); }
    const epoch = ++this._epoch;
    const server = new DeskHttpServer({
      resolvePeer: bearer => this._sessionFor(bearer)?.peerId ?? null,
      challengeFor: () => '', // Challenges belong to recipient-specific sessions.
      isRevoked: peerId => this._deps.peerBook.isRevoked(peerId),
      handle: (peerId, body) => this._receive(peerId, body),
    }, { maxBodyBytes: 65536 });
    this._server = server;
    const starting = (async () => {
      try {
        await this._deps.identity.ensure();
        if (this._epoch !== epoch || !this._canServe()) { await server.stop(); return; }
        const handle = await server.start('loopback');
        if (this._epoch !== epoch || !this._canServe()) { await server.stop(); return; }
        this._handle = handle;
      } catch {
        if (this._epoch === epoch) { this._server = undefined; this._handle = undefined; }
        await server.stop();
        throw new Error('Desk local status could not start');
      }
    })();
    this._starting = starting;
    void starting.finally(() => {
      if (this._starting === starting) { this._starting = undefined; }
    }).catch(() => { /* The caller owns the startup error. */ });
    return starting;
  }

  async stop(): Promise<void> {
    ++this._epoch;
    this._sessions.clear();
    for (const controller of this._outbound) { controller.abort(); }
    this._outbound.clear();
    const server = this._server;
    this._server = undefined;
    this._handle = undefined;
    this._starting = undefined;
    this._availability = 'offline';
    await server?.stop();
  }

  dispose(): void {
    this._disposed = true;
    void this.stop().catch(() => { /* Authority was already cleared synchronously. */ });
  }

  /** Rotates this recipient's previous link. No bearer is saved in the peer book. */
  async share(peerId: string, availability: DeskStatus['availability']): Promise<string> {
    if (!['available', 'busy', 'dnd', 'offline'].includes(availability)) { throw new Error('Invalid Desk status'); }
    const link = await this._share(peerId, 'status');
    this._availability = availability;
    return link;
  }

  /** Sharing a workspace is separate from publishing availability. */
  async shareLookup(peerId: string, workspace: DeskWorkspaceLookup): Promise<string> {
    return this._share(peerId, 'locate', workspace);
  }

  /** Configuration/workspace changes revoke snapshots without widening status links. */
  invalidateLookups(): void {
    ++this._lookupEpoch;
    for (const [key, session] of this._sessions) {
      if (session.verb === 'locate') { this._sessions.delete(key); }
    }
  }

  private _lookupEpoch = 0;

  private async _share(peerId: string, verb: 'status' | 'locate', workspace?: DeskWorkspaceLookup): Promise<string> {
    await this.refresh();
    const own = this._deps.identity.current();
    const peer = this._deps.peerBook.getPeerById(peerId);
    const grant = this._deps.peerBook.getGrant(peerId);
    if (!this._canServe() || !this._handle || !own || !peer || !grant?.verbs.includes(verb)) {
      throw new Error('Enable Desk serving in a trusted window with a live peer grant');
    }
    const epoch = this._epoch, lookupEpoch = this._lookupEpoch;
    const live = () => this._canServe() && this._epoch === epoch && this._lookupEpoch === lookupEpoch
      && !this._deps.peerBook.isRevoked(peerId) && grant.expiresAt > this._deps.now() && peer.expiresAt > this._deps.now()
      && this._deps.peerBook.getPeerById(peerId)?.publicKey === peer.publicKey;
    const lookup = verb === 'locate' ? await workspace?.prepare(grant.scope, live) : undefined;
    if (!live() || !this._deps.peerBook.getGrant(peerId) || (verb === 'locate' && !lookup)) { throw new Error('Desk sharing changed'); }
    const now = this._deps.now();
    for (const [key, session] of this._sessions) {
      if (session.expiresAt <= now || session.peerId === peerId) { this._sessions.delete(key); }
    }
    if (this._sessions.size >= MAX_SESSIONS) { throw new Error('Desk local connection limit reached'); }
    const bearer = randomBytes(24).toString('base64url');
    const connection: Connection = {
      v: 1, url: this._handle.url, bearer, challenge: newChallenge(), peerId: own.peerId,
      audience: peerId, expiresAt: Math.min(now + SESSION_MS, grant.expiresAt, peer.expiresAt),
    };
    this._sessions.set(hash(bearer), {
      verb, lookup,
      peerId, publicKey: peer.publicKey, challenge: connection.challenge,
      expiresAt: connection.expiresAt, calls: new Map(),
      windowStartedAt: now, requestsRemaining: CHANNEL_REQUESTS_PER_MINUTE,
    });
    return (verb === 'locate' ? LOOKUP_PREFIX : LINK_PREFIX) + Buffer.from(JSON.stringify(connection)).toString('base64url');
  }

  private _sessionFor(bearer: string): Session | undefined {
    if (!this._canServe()) { return undefined; }
    const session = this._sessions.get(hash(bearer));
    const now = this._deps.now();
    if (!session || session.expiresAt <= now) { return undefined; }
    // This resolver runs before the carrier reads/parses a body. Malformed
    // frames and cached retries consume channel capacity too, independently
    // of the grant's debit and unique-call rate limit. Clock rollback cannot
    // replenish a window. Reissuing a link requires a local human command.
    if (now - session.windowStartedAt >= 60_000) {
      session.windowStartedAt = now;
      session.requestsRemaining = CHANNEL_REQUESTS_PER_MINUTE;
    }
    if (session.requestsRemaining <= 0) { return undefined; }
    --session.requestsRemaining;
    return session;
  }

  private async _receive(peerId: string, body: unknown): Promise<unknown> {
    const denied = { ok: false, error: 'denied' };
    if (!this._canServe()) { return denied; }
    // One live session per peer. A channel token alone grants no authority.
    const session = [...this._sessions.values()].find(s => s.peerId === peerId);
    const peer = this._deps.peerBook.getPeerById(peerId);
    const grant = this._deps.peerBook.getGrant(peerId);
    const now = this._deps.now();
    if (!session || session.expiresAt <= now || !peer || peer.publicKey !== session.publicKey
      || peer.expiresAt <= now || this._deps.peerBook.isRevoked(peerId)) { return denied; }
    const signed = body as SignedEnvelope;
    if (!verify(signed, { publicKey: peer.publicKey, expectedChallenge: session.challenge, now }).ok) { return denied; }
    const envelope = signed.envelope;
    if (envelope.deadlineMs > 10_000 || envelope.issuedAt + envelope.deadlineMs <= now) { return denied; }
    const fingerprint = hash(canonicalize(signed));
    // Check again after awaiting a cached reply: revocation or scope changes
    // during signing must also discard an already-computed coordinate result.
    const current = async () => envelope.verb !== 'locate' || !session.lookup || await session.lookup.isCurrent();
    const epoch = this._epoch;
    const live = () => this._canServe() && this._epoch === epoch
      && [...this._sessions.values()].includes(session) && session.expiresAt > this._deps.now()
      && !this._deps.peerBook.isRevoked(peerId)
      && this._deps.peerBook.getPeerById(peerId)?.publicKey === peer.publicKey
      && envelope.issuedAt + envelope.deadlineMs > this._deps.now();
    const prior = session.calls.get(envelope.callId);
    if (prior) {
      if (prior.hash !== fingerprint || !await current()) { return denied; }
      const cached = await prior.result;
      return await current() && live() ? cached : denied;
    }
    if (!grant || session.calls.size >= MAX_CALLS || !this._deps.peerBook.checkRate(peerId, now).allowed) { return denied; }
    const result = (async () => {
      const permitted = envelope.verb === session.verb && grant.verbs.includes(session.verb);
      if (permitted && !await current()) { return denied; }
      if (permitted && !await this._deps.peerBook.trySpend(peerId, 0)) { return denied; }
      // getGrant() would reject the final permitted call after its atomic debit.
      // Recheck revocation, identity, expiry and lifecycle separately instead.
      if (!live()) { return denied; }
      const served = permitted ? dispatch(envelope.verb, envelope.args, {
        scope: session.lookup?.scope ?? EMPTY_SCOPE, index: session.lookup?.index ?? emptyIndex, grant,
        status: { availability: this._availability, focus: null }, now: this._deps.now(),
      }) : { ok: false, error: 'unknown verb' };
      const screened = screenOutbound(served);
      const safe = screened.ok ? served : { ok: false, error: 'withheld' };
      const response = {
        protocol: 'mysti.desk/1', callId: envelope.callId, verb: envelope.verb,
        ...safe,
        ...(safe.error ? { error: safe.error === 'unknown verb' ? 'unknown-verb'
          : safe.error === 'withheld' ? 'withheld' : 'bad-args' } : {}),
        complete: true, policy: { withheld: [], redactions: 0 },
      };
      const digest = createHash('sha256').update(session.challenge).update(envelope.callId)
        .update(canonicalize(response)).digest();
      const sig = await this._deps.identity.signBytes(digest);
      if (!await current() || !live()) { return denied; }
      return { ...response, sig: 'ed25519:' + Buffer.from(sig, 'base64').toString('base64url') };
    })().catch(() => denied);
    session.calls.set(envelope.callId, { hash: fingerprint, result });
    return result;
  }

  /** Only a human-pasted link can select an endpoint; pinned identity is mandatory. */
  async check(link: string): Promise<DeskCallOutcome> {
    return this._call(link, 'status', {});
  }

  async locate(link: string, token: string, kind: 'symbol' | 'path'): Promise<DeskCallOutcome> {
    if (!validateCall('locate', { token, kind }).ok) { return { ok: false, error: 'bad-args' }; }
    return this._call(link, 'locate', { token, kind });
  }

  private async _call(link: string, verb: 'status' | 'locate', args: Record<string, unknown>): Promise<DeskCallOutcome> {
    if (!this._allowed()) { return { ok: false, error: 'desk-disabled' }; }
    const connection = parseConnection(link, this._deps.now(), verb === 'locate' ? LOOKUP_PREFIX : LINK_PREFIX);
    if (!connection) { return { ok: false, error: 'invalid-local-link' }; }
    try {
      const own = await this._deps.identity.ensure();
      const peer = this._deps.peerBook.getPeerById(connection.peerId);
      const live = () => this._allowed() && connection.expiresAt > this._deps.now()
        && !!peer && peer.expiresAt > this._deps.now() && !this._deps.peerBook.isRevoked(peer.peerId)
        && !!this._deps.peerBook.getGrant(peer.peerId)
        && this._deps.peerBook.getPeerById(peer.peerId)?.publicKey === peer.publicKey;
      if (own.peerId !== connection.audience || !peer || !live()) { return { ok: false, error: 'unpinned-peer' }; }
      const transport = new DeskLoopbackTransport();
      const client = new DeskClient({
        sign: bytes => this._deps.identity.sign(bytes), now: this._deps.now, newCallId: randomUUID,
        transport: { post: async (url, body, opts) => {
          if (!live()) { throw new Error('Desk disabled'); }
          const controller = new AbortController();
          const abort = () => controller.abort();
          opts.signal.addEventListener('abort', abort, { once: true });
          if (opts.signal.aborted) { abort(); }
          this._outbound.add(controller);
          try { return await transport.post(url, body, { ...opts, signal: controller.signal }); }
          finally { this._outbound.delete(controller); opts.signal.removeEventListener('abort', abort); }
        } },
      });
      const result = await client.call({ ...connection, verb, args, deadlineMs: 5000, peerPublicKey: peer.publicKey });
      if (!live()) { return { ok: false, error: 'desk-disabled' }; }
      if (result.ok) { await this._deps.peerBook.touchOutbound(peer.peerId); }
      if (!live()) { return { ok: false, error: 'desk-disabled' }; }
      return result;
    } catch { return { ok: false, error: 'local-status-failed' }; }
  }
}

function parseConnection(link: string, now: number, prefix: string): Connection | null {
  if (typeof link !== 'string' || link.length > 2048 || !link.startsWith(prefix)) { return null; }
  const encoded = link.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) { return null; }
  try {
    const c = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Connection;
    if (!c || Object.keys(c).sort().join(',') !== 'audience,bearer,challenge,expiresAt,peerId,url,v'
      || c.v !== 1 || typeof c.url !== 'string' || !isDeskLoopbackUrl(c.url)
      || typeof c.bearer !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(c.bearer)
      || typeof c.challenge !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(c.challenge)
      || typeof c.peerId !== 'string' || !/^p_[a-z2-7]{16}$/.test(c.peerId)
      || typeof c.audience !== 'string' || !/^p_[a-z2-7]{16}$/.test(c.audience)
      || !Number.isFinite(c.expiresAt) || c.expiresAt <= now || c.expiresAt > now + SESSION_MS) { return null; }
    return c;
  } catch { return null; }
}
