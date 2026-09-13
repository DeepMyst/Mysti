import { randomUUID } from 'crypto';
import { DeskLocalStatus } from './DeskLocalStatus';
import type { DeskLocalStatusDeps } from './DeskLocalStatus';
import { DeskLoopbackTransport } from './DeskLoopbackTransport';
import { DeskClient } from './DeskClient';
import type { DeskCallOutcome } from './DeskClient';
import type { DeskNativeCarrier } from './DeskIrohProcess';
import { createDeskIrohLink, verifyDeskIrohLink, validDeskRelay } from './desk/DeskIrohLink';
import { validateCall } from './desk/DeskContract';
import type { DeskWorkspaceLookup } from './DeskWorkspaceLookup';
import type { DeskStatus } from './desk/DeskDispatch';

interface Channel { controller: AbortController; live(): boolean }

/** Editor-owned native lifetime; the existing local runtime retains authority. */
export class DeskCrossMachine {
  private _channels = new Map<string, Channel>();
  private _calls = new Set<AbortController>();
  private _disposed = false;
  private _epoch = 0;
  private _timer?: ReturnType<typeof setInterval>;

  constructor(private readonly _local: DeskLocalStatus,
    private readonly _deps: DeskLocalStatusDeps & { relayUrl(): string; carrier: DeskNativeCarrier }) {}

  available(): boolean {
    return !this._disposed && this._deps.enabled() && this._deps.trusted()
      && validDeskRelay(this._deps.relayUrl()) && this._deps.carrier.available();
  }

  /** Configuration/folder changes revoke immediately. Idle identity/peer changes
   * close their process within one second; every request also checks authority. */
  refresh(): void { this.stop(); }
  stop(): void {
    ++this._epoch;
    for (const channel of this._channels.values()) { channel.controller.abort(); }
    this._channels.clear();
    for (const call of this._calls) { call.abort(); }
    this._calls.clear();
    clearInterval(this._timer); this._timer = undefined;
  }
  dispose(): void { this._disposed = true; this.stop(); }

  private _sweep(): void {
    for (const [peerId, channel] of this._channels) {
      if (!channel.live()) { channel.controller.abort(); this._channels.delete(peerId); }
    }
    if (!this._channels.size) { clearInterval(this._timer); this._timer = undefined; }
  }

  async share(peerId: string, availability: DeskStatus['availability']): Promise<string> {
    return this._share(peerId, 'status', () => this._local.share(peerId, availability));
  }

  async shareLookup(peerId: string, workspace: DeskWorkspaceLookup): Promise<string> {
    return this._share(peerId, 'locate', () => this._local.shareLookup(peerId, workspace));
  }

  private async _share(peerId: string, verb: 'status' | 'locate', prepare: () => Promise<string>): Promise<string> {
    this._sweep();
    if (!this.available() || !this._deps.serving() || (this._channels.size >= 4 && !this._channels.has(peerId))) {
      throw new Error('Desk cross-machine sharing unavailable');
    }
    this._channels.get(peerId)?.controller.abort();
    const controller = new AbortController(), relayUrl = this._deps.relayUrl(), epoch = this._epoch;
    let link: string | undefined;
    const live = () => !controller.signal.aborted && this.available() && this._deps.serving()
      && this._epoch === epoch && relayUrl === this._deps.relayUrl()
      && (!link || !!this._local.sharedConnection(link, verb));
    this._channels.set(peerId, { controller, live });
    if (!this._timer) { this._timer = setInterval(() => this._sweep(), 1000); this._timer.unref(); }
    try {
      link = await prepare();
      const connection = this._local.sharedConnection(link, verb);
      if (!live() || !connection) { throw new Error('sharing changed'); }
      // A wall-clock rollback must not keep the native process alive forever.
      const expiry = setTimeout(() => controller.abort(), Math.min(600_000, connection.expiresAt - this._deps.now()));
      expiry.unref();
      controller.signal.addEventListener('abort', () => clearTimeout(expiry), { once: true });
      const server = await this._deps.carrier.serve(relayUrl, connection.bearer, async body => {
        if (!live()) { throw new Error('sharing changed'); }
        const response = await new DeskLoopbackTransport().post(connection.url, body, {
          bearer: connection.bearer, maxBytes: 65536, timeoutMs: 5000, signal: controller.signal,
        });
        if (!live()) { throw new Error('sharing changed'); }
        return response.body;
      }, controller.signal);
      if (!live()) { server.close(); throw new Error('sharing changed'); }
      const signed = await createDeskIrohLink({ v: 1, endpointId: server.endpointId, relayUrl,
        peerId: connection.peerId, audience: connection.audience, bearer: connection.bearer,
        challenge: connection.challenge, expiresAt: connection.expiresAt, verb }, this._deps.now(), bytes => this._deps.identity.sign(bytes));
      if (!live()) { throw new Error('sharing changed'); }
      return signed;
    } catch {
      controller.abort();
      if (this._channels.get(peerId)?.controller === controller) { this._channels.delete(peerId); }
      this._sweep();
      throw new Error('Desk cross-machine sharing failed');
    }
  }

  check(link: string): Promise<DeskCallOutcome> { return this._call(link, 'status', {}); }
  locate(link: string, token: string, kind: 'symbol' | 'path'): Promise<DeskCallOutcome> {
    if (!validateCall('locate', { token, kind }).ok) { return Promise.resolve({ ok: false, error: 'bad-args' }); }
    return this._call(link, 'locate', { token, kind });
  }

  private async _call(link: string, verb: 'status' | 'locate', args: Record<string, unknown>): Promise<DeskCallOutcome> {
    if (!this.available() || this._calls.size >= 4) { return { ok: false, error: 'desk-unavailable' }; }
    const controller = new AbortController(), epoch = this._epoch, relayUrl = this._deps.relayUrl();
    this._calls.add(controller);
    try {
      const own = await this._deps.identity.ensure();
      // Verification against existing pins precedes native creation or dialing.
      const address = this._deps.peerBook.listPeers().map(peer => verifyDeskIrohLink(link, {
        now: this._deps.now(), publicKey: peer.publicKey, audience: own.peerId, relayUrl,
      })).find(value => value !== null);
      if (!address || address.verb !== verb) { return { ok: false, error: 'invalid-desk-link' }; }
      const peer = this._deps.peerBook.getPeerById(address.peerId);
      const live = () => !controller.signal.aborted && this.available() && this._epoch === epoch
        && this._deps.relayUrl() === relayUrl && this._deps.identity.current()?.publicKey === own.publicKey
        && address.expiresAt > this._deps.now() && !!peer && peer.expiresAt > this._deps.now()
        && this._deps.peerBook.getPeerById(address.peerId)?.publicKey === peer.publicKey
        && !!this._deps.peerBook.getGrant(address.peerId) && !this._deps.peerBook.isRevoked(address.peerId);
      if (!live() || !peer) { return { ok: false, error: 'unpinned-peer' }; }
      const timer = setInterval(() => { if (!live()) { controller.abort(); } }, 250);
      timer.unref();
      try {
        const client = new DeskClient({ sign: bytes => this._deps.identity.sign(bytes), now: this._deps.now, newCallId: randomUUID,
          transport: { post: async (_url, body, opts) => {
            if (!live()) { throw new Error('Desk changed'); }
            const abort = () => controller.abort();
            opts.signal.addEventListener('abort', abort, { once: true });
            if (opts.signal.aborted) { abort(); }
            try { return await this._deps.carrier.post(relayUrl, address.endpointId, body, { ...opts, signal: controller.signal }); }
            finally { opts.signal.removeEventListener('abort', abort); }
          } },
        });
        const result = await client.call({ ...address, url: `iroh://${address.endpointId}/desk`, verb, args,
          deadlineMs: 5000, peerPublicKey: peer.publicKey });
        if (!live()) { return { ok: false, error: 'desk-disabled' }; }
        if (result.ok) { await this._deps.peerBook.touchOutbound(peer.peerId); }
        return live() ? result : { ok: false, error: 'desk-disabled' };
      } finally { clearInterval(timer); }
    } catch { return { ok: false, error: 'desk-transport-failed' }; }
    finally { controller.abort(); this._calls.delete(controller); }
  }
}
