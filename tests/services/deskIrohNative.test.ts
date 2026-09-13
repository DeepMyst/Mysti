import { afterEach, describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type * as Native from '@number0/iroh/index';
import { DeskIrohServer, DeskIrohTransport, IROH_ALPN } from '../../src/services/DeskIrohTransport';
import type { IrohEndpoint } from '../../src/services/DeskIrohTransport';
import { supportsDeskIroh } from '../../src/services/DeskIrohNative';
import { DeskLocalStatus } from '../../src/services/DeskLocalStatus';
import { DeskLoopbackTransport } from '../../src/services/DeskLoopbackTransport';
import { DeskWorkspaceLookup } from '../../src/services/DeskWorkspaceLookup';
import { DeskClient } from '../../src/services/DeskClient';
import { DeskIdentity } from '../../src/services/desk/DeskIdentity';
import { DeskPeerBook } from '../../src/managers/DeskPeerBook';
import { createDeskIrohLink, verifyDeskIrohLink } from '../../src/services/desk/DeskIrohLink';

const supported = supportsDeskIroh(process.versions.node, process.platform, process.arch);
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) { await fn(); } });

async function fixture() {
  // Load the pinned platform binary directly: no NAPI_RS override, ldd subprocess,
  // or broken package.main fallback from the upstream generated JS loader.
  const target = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;
  const sdk = require(`@number0/iroh-${target}`) as typeof Native;
  const endpoints = new Map<string, Native.Endpoint>();
  const bind = async (): Promise<IrohEndpoint> => {
    const builder = sdk.Endpoint.builder(); builder.applyMinimal(); builder.relayMode(sdk.RelayMode.disabled());
    builder.bindAddr('127.0.0.1:0'); builder.alpns([IROH_ALPN]);
    const endpoint = await builder.bind(); endpoints.set(endpoint.id().toString(), endpoint);
    close.push(() => endpoint.close());
    return { id: () => endpoint.id(), acceptNext: () => endpoint.acceptNext(), close: () => endpoint.close(),
      connect: id => endpoint.connect(new sdk.EndpointAddr(sdk.EndpointId.fromString(id), null,
        endpoints.get(id)!.boundSockets().filter(socket => socket.startsWith('127.0.0.1:'))), IROH_ALPN) };
  };
  const makeIdentity = () => {
    const vault = new Map<string, string>();
    return new DeskIdentity({ get: async key => vault.get(key), store: async (key, value) => { vault.set(key, value); }, delete: async key => { vault.delete(key); } });
  };
  const identity = makeIdentity(), caller = makeIdentity();
  const own = await identity.ensure(), remote = await caller.ensure();
  const state = new Map<string, unknown>();
  const book = new DeskPeerBook({ get: <T>(key: string) => state.get(key) as T | undefined, update: async (key, value) => { state.set(key, value); } });
  await book.addPeer({ ...remote, alias: 'caller', trustDomain: 'fixture', pairedAt: Date.now(), expiresAt: Date.now() + 3600_000 },
    { peerId: remote.peerId, verbs: ['status', 'locate'], scope: ['src'], expiresAt: Date.now() + 3600_000, maxCalls: 5, budgetUsd: 0, minRetentionClass: 'zero-retention' });
  const runtime = new DeskLocalStatus({ identity, peerBook: book, now: Date.now, enabled: () => true, trusted: () => true, serving: () => true });
  close.push(() => runtime.stop());
  const serve = async (localLink: string) => {
    const local = JSON.parse(Buffer.from(localLink.slice(localLink.lastIndexOf('/') + 1), 'base64url').toString());
    const endpoint = await bind();
    const server = new DeskIrohServer(endpoint, local.bearer, async body => {
      const response = await new DeskLoopbackTransport().post(local.url, body, { bearer: local.bearer, maxBytes: 65536, timeoutMs: 5000, signal: new AbortController().signal });
      return response.body;
    });
    close.push(() => server.stop()); server.start();
    // The relay URL is signed fixture metadata only; this test dials the
    // explicitly supplied local socket and disables all relay/discovery use.
    const address = { v: 1 as const, endpointId: endpoint.id().toString(), relayUrl: 'https://relay.example.test/',
      peerId: own.peerId, audience: remote.peerId, bearer: local.bearer, challenge: local.challenge, expiresAt: local.expiresAt, verb: (localLink.startsWith('desk://local-lookup/') ? 'locate' : 'status') as 'status' | 'locate' };
    const link = await createDeskIrohLink(address, Date.now(), text => identity.sign(text));
    expect(verifyDeskIrohLink(link, { now: Date.now(), publicKey: own.publicKey, audience: remote.peerId, relayUrl: address.relayUrl })).toEqual(address);
    const callerEndpoint = await bind();
    const client = new DeskClient({ sign: bytes => caller.sign(bytes), now: Date.now, newCallId: crypto.randomUUID,
      transport: new DeskIrohTransport(callerEndpoint, address.endpointId) });
    return { client, local, url: `iroh://${address.endpointId}/desk`, server };
  };
  return { runtime, book, remote, own, serve, bind };
}

describe.skipIf(!supported)('native iroh encrypted local protocol acceptance (no relay or discovery)', () => {
  it('carries pinned signed status through the production dispatcher and call ledger', async () => {
    const f = await fixture(); const s = await f.serve(await f.runtime.share(f.remote.peerId, 'busy'));
    expect(await s.client.call({ ...s.local, url: s.url, verb: 'status', args: {}, deadlineMs: 5000, peerPublicKey: f.own.publicKey }))
      .toEqual({ ok: true, verified: true, payload: { availability: 'busy', focus: null } });
    expect(f.book.callsUsed(f.remote.peerId)).toBe(1);
  });

  it('carries scoped workspace coordinates through real encrypted streams', async () => {
    const f = await fixture();
    const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(process.platform === 'win32' ? process.cwd() : os.tmpdir(), 'mysti-iroh-')));
    close.push(() => fs.promises.rm(root, { recursive: true, force: true }));
    await fs.promises.mkdir(path.join(root, '.mysti')); await fs.promises.mkdir(path.join(root, 'src'));
    await fs.promises.writeFile(path.join(root, '.mysti/desk-share.json'), '{"allow":["src"]}');
    await fs.promises.writeFile(path.join(root, 'src/shared.ts'), 'export function NativeLookup() {}');
    const s = await f.serve(await f.runtime.shareLookup(f.remote.peerId, new DeskWorkspaceLookup({ root, ceiling: () => ['src'], active: () => true })));
    expect(await s.client.call({ ...s.local, url: s.url, verb: 'locate', args: { token: 'NativeLookup', kind: 'symbol' }, deadlineMs: 5000, peerPublicKey: f.own.publicKey }))
      .toEqual({ ok: true, verified: true, payload: { hits: [{ path: 'src/shared.ts', line: 1, symbol: 'NativeLookup' }] } });
    expect(f.book.callsUsed(f.remote.peerId)).toBe(1);
  });

  it('refuses a revoked peer without spending a call', async () => {
    const f = await fixture(); const s = await f.serve(await f.runtime.share(f.remote.peerId, 'busy'));
    await f.book.revoke(f.remote.peerId);
    expect((await s.client.call({ ...s.local, url: s.url, verb: 'status', args: {}, deadlineMs: 5000, peerPublicKey: f.own.publicKey })).ok).toBe(false);
    expect(f.book.callsUsed(f.remote.peerId)).toBe(0);
  });

  it('closes an idle native accept loop when its owner stops', async () => {
    const f = await fixture(); const server = new DeskIrohServer(await f.bind(), 'b'.repeat(32), async () => ({}));
    server.start(); await server.stop(); await server.stop();
  });
});
