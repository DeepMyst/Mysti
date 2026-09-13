import type { DeskTransport } from './DeskClient';
import { timingSafeEqual } from 'crypto';

// A structural boundary keeps the native binding out of the sealed dispatcher
// and makes lifecycle/limit failures testable without loading a native library.
export interface IrohStream {
  send: { writeAll(bytes: number[]): Promise<void>; finish(): Promise<void> };
  recv: { readExact(size: number): Promise<number[]>; readToEnd(limit: number): Promise<number[]> };
}
export interface IrohConnection {
  openBi(): Promise<IrohStream>;
  acceptBi(): Promise<IrohStream>;
  remoteId(): { toString(): string };
  close(code: bigint, reason: number[]): void;
  closed(): Promise<string>;
}
export interface IrohIncoming {
  accept(): Promise<{ connect(): Promise<IrohConnection> }>;
  refuse(): Promise<void>;
}
export interface IrohEndpoint {
  id(): { toString(): string };
  connect(id: string): Promise<IrohConnection>;
  acceptNext(): Promise<IrohIncoming | null>;
  close(): Promise<void>;
}

export const IROH_ALPN = Array.from(Buffer.from('mysti.desk/1'));
export const IROH_BODY_LIMIT = 65536;

/** One endpoint per outbound call: cancellation also cancels native dialing. */
export class DeskIrohTransport implements DeskTransport {
  constructor(private readonly _endpoint: IrohEndpoint, private readonly _remoteId: string) {}

  async post(url: string, body: unknown, opts: Parameters<DeskTransport['post']>[2]): ReturnType<DeskTransport['post']> {
    if (!/^[a-f0-9]{64}$/.test(this._remoteId) || url !== `iroh://${this._remoteId}/desk`
      || !/^[A-Za-z0-9_-]{32}$/.test(opts.bearer) || opts.signal.aborted
      || !Number.isInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > IROH_BODY_LIMIT
      || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 10_000) {
      await this._endpoint.close(); throw new Error('Desk transport refused');
    }
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(body)); }
    catch { await this._endpoint.close(); throw new Error('Desk request invalid'); }
    if (bytes.length > IROH_BODY_LIMIT) { await this._endpoint.close(); throw new Error('Desk request too large'); }
    let connection: IrohConnection | undefined;
    let cancelled = false;
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => {
      cancelled = true;
      connection?.close(1n, []);
      void this._endpoint.close().catch(() => {});
      rejectAbort(new Error('Desk transport cancelled'));
    };
    const timer = setTimeout(abort, opts.timeoutMs);
    opts.signal.addEventListener('abort', abort, { once: true });
    try {
      const work = (async () => {
        const connected = await this._endpoint.connect(this._remoteId);
        connection = connected;
        if (cancelled || connected.remoteId().toString() !== this._remoteId) {
          connected.close(1n, []); throw new Error('Desk transport identity mismatch');
        }
        const stream = await connected.openBi();
        if (cancelled) { throw new Error('Desk transport cancelled'); }
        await stream.send.writeAll(Array.from(Buffer.concat([Buffer.from(opts.bearer), bytes])));
        await stream.send.finish();
        const reply = await stream.recv.readToEnd(opts.maxBytes);
        if (cancelled || reply.length > opts.maxBytes) { throw new Error('Desk response too large'); }
        return { status: 200, body: JSON.parse(Buffer.from(reply).toString('utf8')) as unknown };
      })();
      if (opts.signal.aborted) { abort(); }
      return await Promise.race([work, aborted]);
    } catch { throw new Error('Desk transport failed'); }
    finally {
      clearTimeout(timer); opts.signal.removeEventListener('abort', abort);
      cancelled = true;
      connection?.close(0n, []);
      await this._endpoint.close();
    }
  }
}

/** Bounded one-request connections. Authority remains in the existing runtime. */
export class DeskIrohServer {
  private _stopped = false;
  private _connections = new Set<IrohConnection>();
  private _pending = 0;
  private _window = Date.now();
  private _remaining = 32;
  private _loop?: Promise<void>;

  constructor(private readonly _endpoint: IrohEndpoint, private readonly _bearer: string,
    private readonly _handle: (body: unknown) => Promise<unknown>) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(_bearer)) { throw new Error('Desk channel invalid'); }
  }

  start(): void {
    if (this._loop || this._stopped) { return; }
    this._loop = this._accept().catch(() => { void this.stop().catch(() => {}); });
  }

  async stop(): Promise<void> {
    this._stopped = true;
    for (const connection of this._connections) { connection.close(1n, []); }
    this._connections.clear();
    await this._endpoint.close();
  }

  private async _accept(): Promise<void> {
    while (!this._stopped) {
      const incoming = await this._endpoint.acceptNext();
      if (!incoming) { return; }
      const now = Date.now();
      if (now - this._window >= 60_000) { this._window = now; this._remaining = 32; }
      if (this._stopped || this._pending >= 4 || this._remaining <= 0) { await incoming.refuse(); continue; }
      --this._remaining; ++this._pending;
      void this._serve(incoming).finally(() => { --this._pending; }).catch(() => {});
    }
  }

  private async _serve(incoming: IrohIncoming): Promise<void> {
    let connection: IrohConnection | undefined;
    let expired = false;
    // Handshake, header, body, local dispatch and delivery share one deadline.
    const timer = setTimeout(() => {
      expired = true;
      if (connection) { connection.close(1n, []); }
      // The binding cannot cancel an accepting handshake individually. Closing
      // this channel's endpoint cancels it; never strand its admission slot.
      else { void this.stop().catch(() => {}); }
    }, 10_000);
    try {
      connection = await (await incoming.accept()).connect();
      if (expired || this._stopped) { return; }
      this._connections.add(connection);
      const stream = await connection.acceptBi();
      const header = Buffer.from(await stream.recv.readExact(32));
      if (header.length !== 32 || !timingSafeEqual(header, Buffer.from(this._bearer)) || expired || this._stopped) { return; }
      const body = await stream.recv.readToEnd(IROH_BODY_LIMIT);
      if (body.length > IROH_BODY_LIMIT || expired || this._stopped) { return; }
      const result = await this._handle(JSON.parse(Buffer.from(body).toString('utf8')));
      if (expired || this._stopped) { return; }
      const reply = Buffer.from(JSON.stringify(result));
      if (reply.length > IROH_BODY_LIMIT) { return; }
      await stream.send.writeAll(Array.from(reply));
      await stream.send.finish();
      await connection.closed();
    } catch { /* Native/parser errors never expose request or key material. */ }
    finally {
      clearTimeout(timer);
      if (connection) { this._connections.delete(connection); connection.close(0n, []); }
    }
  }
}
