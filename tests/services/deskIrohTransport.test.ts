import { afterEach, describe, it, expect, vi } from 'vitest';
import { DeskIrohServer, DeskIrohTransport } from '../../src/services/DeskIrohTransport';
import type { IrohConnection, IrohEndpoint, IrohIncoming } from '../../src/services/DeskIrohTransport';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const id = 'a'.repeat(64), bearer = 'b'.repeat(32), url = `iroh://${id}/desk`;
const opts = () => ({ bearer, timeoutMs: 100, maxBytes: 65536, signal: new AbortController().signal });
const tick = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); } };

function fixture() {
  const stream = { send: { writeAll: vi.fn(async () => {}), finish: vi.fn(async () => {}) },
    recv: { readExact: vi.fn(async () => Array.from(Buffer.from(bearer))), readToEnd: vi.fn(async () => Array.from(Buffer.from('{"ok":true}'))) } };
  const connection = { openBi: vi.fn(async () => stream), acceptBi: vi.fn(async () => stream), remoteId: () => ({ toString: () => id }),
    close: vi.fn(), closed: vi.fn(async () => 'closed') };
  const incoming = { accept: vi.fn(async () => ({ connect: async () => connection })), refuse: vi.fn(async () => {}) };
  let deliver: ((value: IrohIncoming | null) => void) | undefined;
  const endpoint: IrohEndpoint = { id: () => ({ toString: () => id }), connect: vi.fn(async () => connection),
    acceptNext: vi.fn(() => new Promise(resolve => { deliver = resolve; })), close: vi.fn(async () => { deliver?.(null); }) };
  const handle = vi.fn(async () => ({ ok: true }));
  const server = new DeskIrohServer(endpoint, bearer, handle);
  const receive = async () => { deliver!(incoming); await tick(); };
  return { stream, connection, incoming, endpoint, handle, server, receive, client: new DeskIrohTransport(endpoint, id) };
}

describe('iroh transport resource and authentication boundary', () => {
  it('pins the native responder before writing the bearer or body', async () => {
    const f = fixture(); f.connection.remoteId = () => ({ toString: () => 'd'.repeat(64) });
    await expect(f.client.post(url, {}, opts())).rejects.toThrow();
    expect(f.stream.send.writeAll).not.toHaveBeenCalled(); expect(f.endpoint.close).toHaveBeenCalled();
  });

  it.each([{ maxBytes: 65537 }, { maxBytes: NaN }, { timeoutMs: 0 }, { timeoutMs: 10001 }, { bearer: 'invalid' }])('refuses invalid bounds/channel %j before dialing', async patch => {
    const f = fixture(); await expect(f.client.post(url, {}, { ...opts(), ...patch })).rejects.toThrow();
    expect(f.endpoint.connect).not.toHaveBeenCalled(); expect(f.endpoint.close).toHaveBeenCalled();
  });

  it('refuses another endpoint URL before sending', async () => {
    const f = fixture(); await expect(f.client.post('https://attacker.test/', {}, opts())).rejects.toThrow();
    expect(f.endpoint.connect).not.toHaveBeenCalled();
  });

  it('refuses a large or non-JSON request before dialing', async () => {
    for (const body of ['x'.repeat(65536), { value: 1n }]) {
      const f = fixture(); await expect(f.client.post(url, body, opts())).rejects.toThrow();
      expect(f.endpoint.connect).not.toHaveBeenCalled(); expect(f.endpoint.close).toHaveBeenCalled();
    }
  });

  it('caps replies even if an injected backend ignores its read limit', async () => {
    const f = fixture(); f.stream.recv.readToEnd.mockResolvedValue(new Array(65537).fill(32));
    await expect(f.client.post(url, {}, opts())).rejects.toThrow(); expect(f.endpoint.close).toHaveBeenCalled();
  });

  it('closes the endpoint to abort a pending native dial and closes a late connection', async () => {
    const f = fixture(); const controller = new AbortController();
    let connected!: (connection: IrohConnection) => void;
    vi.mocked(f.endpoint.connect).mockImplementation(() => new Promise(resolve => { connected = resolve; }));
    const result = f.client.post(url, {}, { ...opts(), signal: controller.signal });
    controller.abort(); await expect(result).rejects.toThrow();
    expect(f.endpoint.close).toHaveBeenCalled(); connected(f.connection); await tick();
    expect(f.connection.close).toHaveBeenCalled(); expect(f.stream.send.writeAll).not.toHaveBeenCalled();
  });

  it('aborts an unresponsive dial at the call deadline', async () => {
    vi.useFakeTimers(); const f = fixture();
    vi.mocked(f.endpoint.connect).mockImplementation(() => new Promise(() => {}));
    const rejected = expect(f.client.post(url, {}, opts())).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(101); await rejected; expect(f.endpoint.close).toHaveBeenCalled();
  });

  it('returns a complete response and releases the connection and endpoint', async () => {
    const f = fixture(); expect(await f.client.post(url, { fixture: true }, opts())).toEqual({ status: 200, body: { ok: true } });
    expect(f.connection.close).toHaveBeenCalled(); expect(f.endpoint.close).toHaveBeenCalled();
  });

  it.each(['wrong', 'high-bit'])('authenticates the exact raw header before reading/parsing a body: %s', async mode => {
    const f = fixture(); f.stream.recv.readExact.mockResolvedValue(new Array(32).fill(mode === 'wrong' ? 97 : 226));
    f.server.start(); await f.receive(); await f.server.stop();
    expect(f.stream.recv.readToEnd).not.toHaveBeenCalled(); expect(f.handle).not.toHaveBeenCalled();
  });

  it('counts malformed frames against the channel rate and refuses the next handshake', async () => {
    vi.useFakeTimers(); const f = fixture(); f.stream.recv.readToEnd.mockResolvedValue([123]);
    f.server.start(); for (let i = 0; i < 33; i++) { await f.receive(); }
    expect(f.incoming.accept).toHaveBeenCalledTimes(32); expect(f.incoming.refuse).toHaveBeenCalledTimes(1);
    expect(f.handle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001); await f.receive(); expect(f.incoming.accept).toHaveBeenCalledTimes(33);
    await f.server.stop();
  });

  it('refuses oversize input before dispatch', async () => {
    const f = fixture(); f.stream.recv.readToEnd.mockResolvedValue(new Array(65537).fill(32));
    f.server.start(); await f.receive(); await f.server.stop(); expect(f.handle).not.toHaveBeenCalled();
  });

  it('discards a dispatch result that completes after shutdown', async () => {
    const f = fixture(); let finish!: (body: { ok: boolean }) => void;
    f.handle.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.server.start(); await f.receive(); await f.server.stop(); finish({ ok: true }); await tick();
    expect(f.stream.send.writeAll).not.toHaveBeenCalled();
  });

  it('caps pending handshakes and closes their endpoint at the shared deadline', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.incoming.accept.mockImplementation(async () => ({ connect: () => new Promise(() => {}) }));
    f.server.start(); for (let i = 0; i < 5; i++) { await f.receive(); }
    expect(f.incoming.accept).toHaveBeenCalledTimes(4); expect(f.incoming.refuse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_001); expect(f.endpoint.close).toHaveBeenCalled();
    await f.server.stop();
  });
});
