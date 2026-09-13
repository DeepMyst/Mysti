import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DeskCrossMachine } from '../../src/services/DeskCrossMachine';
import { DeskLocalStatus } from '../../src/services/DeskLocalStatus';
import { DeskIdentity } from '../../src/services/desk/DeskIdentity';
import { DeskPeerBook } from '../../src/managers/DeskPeerBook';
import { DeskWorkspaceLookup } from '../../src/services/DeskWorkspaceLookup';
import type { DeskNativeCarrier } from '../../src/services/DeskIrohProcess';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) { await close(); } });

async function fixture() {
  let clock = Date.now(), count = 0;
  const servers = new Map<string, { handle(body: unknown): Promise<unknown>; signal: AbortSignal }>();
  const make = () => {
    const vault = new Map<string, string>(), state = new Map<string, unknown>();
    const identity = new DeskIdentity({ get: async key => vault.get(key), store: async (key, value) => { vault.set(key, value); }, delete: async key => { vault.delete(key); } });
    const peerBook = new DeskPeerBook({ get: <T>(key: string) => state.get(key) as T | undefined, update: async (key, value) => { state.set(key, value); } }, () => clock);
    const flags = { enabled: true, serving: true, trusted: true, relay: 'https://relay.example.test/', available: true };
    const serve = vi.fn<DeskNativeCarrier['serve']>(async (_relay, _bearer, handle, signal) => {
      const endpointId = (++count).toString(16).padStart(64, '0');
      servers.set(endpointId, { handle, signal });
      return { endpointId, close() {} };
    });
    const post = vi.fn<DeskNativeCarrier['post']>(async (_relay, id, body, opts) => {
      const server = servers.get(id)!;
      if (server.signal.aborted || opts.signal.aborted) { throw new Error('stopped'); }
      return { status: 200, body: await server.handle(body) };
    });
    const carrier: DeskNativeCarrier = { available: () => flags.available, serve, post };
    const deps = { identity, peerBook, now: () => clock, enabled: () => flags.enabled, serving: () => flags.serving, trusted: () => flags.trusted };
    const local = new DeskLocalStatus(deps);
    const remote = new DeskCrossMachine(local, { ...deps, relayUrl: () => flags.relay, carrier });
    cleanup.push(() => local.stop(), () => remote.dispose());
    return { identity, peerBook, flags, serve, post, local, remote };
  };
  const a = make(), b = make(), ak = await a.identity.ensure(), bk = await b.identity.ensure();
  const pair = async (owner: typeof a, key: typeof ak, alias: string) => owner.peerBook.addPeer({ ...key, alias, trustDomain: 'fixture', pairedAt: clock, expiresAt: clock + 3600_000 },
    { peerId: key.peerId, verbs: ['status', 'locate'], scope: ['src'], expiresAt: clock + 3600_000, maxCalls: 20, budgetUsd: 0, minRetentionClass: 'zero-retention' });
  await pair(a, bk, 'b'); await pair(b, ak, 'a');
  return { a, b, ak, bk, servers, advance: (ms: number) => { clock += ms; } };
}

function mutate(link: string, patch: Record<string, unknown>) {
  const parsed = JSON.parse(Buffer.from(link.slice('desk://iroh/'.length), 'base64url').toString());
  Object.assign(parsed.address, patch);
  return 'desk://iroh/' + Buffer.from(JSON.stringify(parsed)).toString('base64url');
}

describe('cross-machine production owner over the existing signed dispatcher', () => {
  it('bounds simultaneous native calls while earlier calls are pending', async () => {
    const f = await fixture(); const link = await f.a.remote.share(f.bk.peerId, 'available');
    const finish: (() => void)[] = [];
    f.b.post.mockImplementation(() => new Promise(resolve => { finish.push(() => resolve({ status: 200, body: {} })); }));
    const pending = Array.from({ length: 4 }, () => f.b.remote.check(link));
    await vi.waitFor(() => expect(f.b.post).toHaveBeenCalledTimes(4));
    expect((await f.b.remote.check(link)).ok).toBe(false); expect(f.b.post).toHaveBeenCalledTimes(4);
    f.b.remote.stop(); finish.forEach(resolve => resolve()); await Promise.all(pending);
  });

  it('bounds serving processes across separately pinned recipients', async () => {
    const f = await fixture(); const ids = [f.bk.peerId];
    for (let i = 0; i < 4; ++i) {
      const vault = new Map<string, string>();
      const key = await new DeskIdentity({ get: async name => vault.get(name),
        store: async (name, value) => { vault.set(name, value); }, delete: async name => { vault.delete(name); } }).ensure();
      await f.a.peerBook.addPeer({ ...key, alias: `fixture-${i}`, trustDomain: 'fixture', pairedAt: Date.now(), expiresAt: Date.now() + 3600_000 },
        { peerId: key.peerId, verbs: ['status'], scope: [], expiresAt: Date.now() + 3600_000, maxCalls: 20, budgetUsd: 0, minRetentionClass: 'zero-retention' });
      ids.push(key.peerId);
    }
    for (const id of ids.slice(0, 4)) { await f.a.remote.share(id, 'available'); }
    await expect(f.a.remote.share(ids[4], 'available')).rejects.toThrow('unavailable');
    expect(f.a.serve).toHaveBeenCalledTimes(4);
  });

  it('serves a verified status and consumes exactly one inbound call', async () => {
    const f = await fixture();
    const link = await f.a.remote.share(f.bk.peerId, 'busy');
    expect(await f.b.remote.check(link)).toEqual({ ok: true, verified: true, payload: { availability: 'busy', focus: null } });
    expect(f.a.peerBook.callsUsed(f.bk.peerId)).toBe(1);
    expect(f.a.peerBook.spentTodayAll()).toBe(0);
  });

  it.each(['endpointId', 'relayUrl', 'audience', 'verb', 'signature'] as const)('refuses a forged %s before native dialing', async field => {
    const f = await fixture(); const link = await f.a.remote.share(f.bk.peerId, 'available');
    const bad = field === 'signature' ? link.slice(0, -8) + 'AAAAAAAA' : mutate(link, { [field]: field === 'endpointId' ? 'f'.repeat(64) : 'forged' });
    expect((await f.b.remote.check(bad)).ok).toBe(false); expect(f.b.post).not.toHaveBeenCalled();
  });

  it.each(['relay', 'runtime', 'trust', 'disabled'] as const)('refuses %s configuration before creating a native server', async change => {
    const f = await fixture();
    if (change === 'relay') { f.a.flags.relay = ''; }
    if (change === 'runtime') { f.a.flags.available = false; }
    if (change === 'trust') { f.a.flags.trusted = false; }
    if (change === 'disabled') { f.a.flags.enabled = false; }
    await expect(f.a.remote.share(f.bk.peerId, 'available')).rejects.toThrow(); expect(f.a.serve).not.toHaveBeenCalled();
  });

  it.each(['reset', 'revoke', 'expire', 'rotate-local', 'disable', 'relay', 'stop'] as const)('refuses an existing channel after %s', async change => {
    const f = await fixture(); const link = await f.a.remote.share(f.bk.peerId, 'available');
    if (change === 'reset') { await f.a.identity.reset(); await f.a.identity.ensure(); }
    if (change === 'revoke') { await f.a.peerBook.revoke(f.bk.peerId, 'fixture'); }
    if (change === 'expire') { f.advance(600_001); }
    if (change === 'rotate-local') { await f.a.local.share(f.bk.peerId, 'busy'); }
    if (change === 'disable') { f.a.flags.enabled = false; f.a.remote.refresh(); }
    if (change === 'relay') { f.a.flags.relay = 'https://different.example.test/'; f.a.remote.refresh(); }
    if (change === 'stop') { f.a.remote.stop(); }
    expect((await f.b.remote.check(link)).ok).toBe(false); expect(f.a.peerBook.callsUsed(f.bk.peerId)).toBe(0);
  });

  it('discards a late native bind after serving is stopped', async () => {
    const f = await fixture(); let finish!: (server: { endpointId: string; close(): void }) => void;
    f.a.serve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const task = f.a.remote.share(f.bk.peerId, 'available');
    await vi.waitFor(() => expect(f.a.serve).toHaveBeenCalled());
    f.a.remote.stop(); const close = vi.fn(); finish({ endpointId: 'a'.repeat(64), close });
    await expect(task).rejects.toThrow(); expect(close).toHaveBeenCalled();
    expect(f.a.serve.mock.calls[0][3].aborted).toBe(true);
  });

  it('closes idle revoked channels within one second', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(); await f.a.remote.share(f.bk.peerId, 'available');
    await f.a.peerBook.revoke(f.bk.peerId, 'fixture');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.a.serve.mock.calls[0][3].aborted).toBe(true);
  });

  it('aborts a pending call on configuration change and refuses the late result', async () => {
    const f = await fixture(); const link = await f.a.remote.share(f.bk.peerId, 'available');
    let finish!: () => void;
    f.b.post.mockImplementationOnce((_relay, _id, _body, opts) => new Promise(resolve => {
      finish = () => { expect(opts.signal.aborted).toBe(true); resolve({ status: 200, body: {} }); };
    }));
    const call = f.b.remote.check(link); await vi.waitFor(() => expect(f.b.post).toHaveBeenCalled());
    f.b.remote.refresh(); finish(); expect((await call).ok).toBe(false);
  });

  it('serves scoped coordinates and rejects the same link after scope changes', async () => {
    const f = await fixture();
    const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(process.platform === 'win32' ? process.cwd() : os.tmpdir(), 'mysti-cross-machine-')));
    cleanup.push(() => fs.promises.rm(root, { recursive: true, force: true }));
    await fs.promises.mkdir(path.join(root, '.mysti')); await fs.promises.mkdir(path.join(root, 'src'));
    await fs.promises.writeFile(path.join(root, '.mysti/desk-share.json'), '{"allow":["src"]}');
    await fs.promises.writeFile(path.join(root, 'src/shared.ts'), 'export function SharedCoordinate() {}');
    const link = await f.a.remote.shareLookup(f.bk.peerId, new DeskWorkspaceLookup({ root, ceiling: () => ['src'], active: () => true }));
    expect(await f.b.remote.locate(link, 'SharedCoordinate', 'symbol')).toEqual({ ok: true, verified: true,
      payload: { hits: [{ path: 'src/shared.ts', line: 1, symbol: 'SharedCoordinate' }] } });
    expect((await f.b.remote.check(link)).ok).toBe(false);
    await fs.promises.writeFile(path.join(root, '.mysti/desk-share.json'), '{"allow":[]}');
    expect((await f.b.remote.locate(link, 'SharedCoordinate', 'symbol')).ok).toBe(false);
  });
});
