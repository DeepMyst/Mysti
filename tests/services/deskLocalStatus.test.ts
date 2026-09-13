import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeskWorkspaceLookup } from '../../src/services/DeskWorkspaceLookup';
import { DeskIdentity } from '../../src/services/desk/DeskIdentity';
import { DeskPeerBook } from '../../src/managers/DeskPeerBook';
import { DeskLocalStatus } from '../../src/services/DeskLocalStatus';
import { DeskLoopbackTransport } from '../../src/services/DeskLoopbackTransport';
import { canonicalize } from '../../src/services/desk/DeskEnvelope';
import type { DeskEnvelope } from '../../src/services/desk/DeskEnvelope';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) { await close(); } });

async function fixture(maxCalls = 100) {
  let clock = Date.now();
  const make = () => {
    const vault = new Map<string, string>();
    const get = vi.fn(async (key: string) => vault.get(key));
    const identity = new DeskIdentity({ get, store: async (k, v) => { vault.set(k, v); }, delete: async k => { vault.delete(k); } });
    const state = new Map<string, unknown>();
    const update = vi.fn(async (k: string, v: unknown) => { state.set(k, structuredClone(v)); });
    const peerBook = new DeskPeerBook({ get: <T>(k: string) => state.get(k) as T | undefined, update }, () => clock);
    const flags = { enabled: true, serving: true, trusted: true };
    const runtime = new DeskLocalStatus({ identity, peerBook, now: () => clock,
      enabled: () => flags.enabled, serving: () => flags.serving, trusted: () => flags.trusted });
    cleanup.push(() => runtime.stop());
    return { identity, peerBook, flags, runtime, get, update };
  };
  const a = make(), b = make();
  const aKey = await a.identity.ensure(), bKey = await b.identity.ensure();
  const pair = async (owner: typeof a, key: typeof aKey, alias: string) => owner.peerBook.addPeer({
    ...key, alias, trustDomain: 'test', pairedAt: clock, expiresAt: clock + 3600_000,
  }, { peerId: key.peerId, verbs: ['status', 'locate'], scope: ['src'], expiresAt: clock + 3600_000,
    budgetUsd: 0, maxCalls, minRetentionClass: 'zero-retention' });
  await pair(a, bKey, 'caller'); await pair(b, aKey, 'server');
  return { a, b, aKey, bKey, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

function decode(link: string): Record<string, string> {
  return JSON.parse(Buffer.from(link.slice(link.lastIndexOf('/') + 1), 'base64url').toString('utf8'));
}
function change(link: string, patch: Record<string, unknown>): string {
  return 'desk://local-status/' + Buffer.from(JSON.stringify({ ...decode(link), ...patch })).toString('base64url');
}
async function wire(f: Awaited<ReturnType<typeof fixture>>, link: string, patch: Partial<DeskEnvelope> = {}) {
  const c = decode(link);
  const envelope: DeskEnvelope = { protocol: 'mysti.desk/1', callId: crypto.randomUUID(), verb: 'status', args: {},
    challenge: c.challenge, issuedAt: f.now(), deadlineMs: 5000, ...patch };
  const body = { envelope, signature: await f.b.identity.sign(canonicalize(envelope)) };
  const send = (value: unknown = body) => new DeskLoopbackTransport().post(c.url, value, {
    bearer: c.bearer, timeoutMs: 2000, maxBytes: 65536, signal: new AbortController().signal,
  });
  return { send, body };
}

async function lookupWorkspace() {
  // Windows system temp is inside AppData, an intentionally unshareable store.
  // Keep Windows fixtures in a fresh directory under the isolated checkout.
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(process.platform === 'win32' ? process.cwd() : os.tmpdir(), 'mysti-desk-http-')));
  cleanup.push(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(root, '.mysti'));
  await fs.promises.mkdir(path.join(root, 'src'));
  await fs.promises.writeFile(path.join(root, '.mysti/desk-share.json'), '{"allow":["src"]}');
  await fs.promises.writeFile(path.join(root, 'src/example.ts'), 'export function SharedThing() {}\nconst privateValue = "fixture-only";');
  const flags = { ceiling: ['src'], active: true };
  return { root, flags, reader: new DeskWorkspaceLookup({ root, ceiling: () => flags.ceiling, active: () => flags.active }) };
}

describe('production Desk explicit local workspace lookup over HTTP', () => {
  it('returns only signed coordinates and charges one zero-cost call', async () => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    const link = await f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader);
    expect(link.startsWith('desk://local-lookup/')).toBe(true);
    expect(await f.b.runtime.locate(link, 'SharedThing', 'symbol')).toEqual({ ok: true, verified: true,
      payload: { hits: [{ path: 'src/example.ts', line: 1, symbol: 'SharedThing' }] } });
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
    expect(f.a.peerBook.spentTodayAll()).toBe(0);
    expect(JSON.stringify(decode(link))).not.toContain(workspace.root);
    const opens = vi.spyOn(fs.promises, 'open');
    expect(await f.b.runtime.locate(link, 'Shared', 'symbol')).toMatchObject({ ok: true, payload: { hits: [] } });
    expect(await f.b.runtime.locate(link, 'example.ts', 'path')).toMatchObject({ ok: true, payload: { hits: [{ path: 'src/example.ts', line: 0 }] } });
    expect(opens.mock.calls.every(([name]) => String(name).endsWith('desk-share.json'))).toBe(true);
    opens.mockRestore();
  });

  it('never upgrades a status link to workspace authority, even with a locate grant', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    const w = await wire(f, link, { verb: 'locate', args: { token: 'example', kind: 'path' } });
    expect((await w.send()).body).toMatchObject({ ok: false, error: 'unknown-verb' });
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(0);
    expect((await f.b.runtime.locate(link.replace('local-status/', 'local-lookup/'), 'example', 'path')).ok).toBe(false);
  });

  it('serves and deduplicates the last granted lookup without another debit', async () => {
    const f = await fixture(1); const workspace = await lookupWorkspace();
    const link = await f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader);
    const w = await wire(f, link, { verb: 'locate', args: { token: 'SharedThing', kind: 'symbol' } });
    const [first, second] = await Promise.all([w.send(), w.send()]);
    expect(first.body).toMatchObject({ ok: true }); expect(second).toEqual(first);
    expect(await w.send()).toEqual(first);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
    expect((await f.b.runtime.locate(link, 'example', 'path')).ok).toBe(false);
  });

  it.each(['scope', 'source', 'ceiling', 'workspace', 'configuration', 'revoke'] as const)('refuses cached lookup and new calls after %s changes', async change => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    const link = await f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader);
    const w = await wire(f, link, { verb: 'locate', args: { token: 'SharedThing', kind: 'symbol' } });
    expect((await w.send()).body).toMatchObject({ ok: true });
    if (change === 'scope') { await fs.promises.writeFile(path.join(workspace.root, '.mysti/desk-share.json'), '{"allow":[]}'); }
    if (change === 'source') { await fs.promises.writeFile(path.join(workspace.root, 'src/example.ts'), 'function Changed() {}'); }
    if (change === 'ceiling') { workspace.flags.ceiling = []; }
    if (change === 'workspace') { workspace.flags.active = false; }
    if (change === 'configuration') { f.a.runtime.invalidateLookups(); }
    if (change === 'revoke') { await f.a.peerBook.revoke(f.bKey.peerId); }
    expect((await w.send()).body).not.toMatchObject({ ok: true });
    expect((await f.b.runtime.locate(link, 'SharedThing', 'symbol')).ok).toBe(false);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
  });

  it('discards coordinates if the scope changes while signing the reply', async () => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    const link = await f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader);
    const sign = f.a.identity.signBytes.bind(f.a.identity);
    vi.spyOn(f.a.identity, 'signBytes').mockImplementationOnce(async bytes => {
      workspace.flags.ceiling = []; return sign(bytes);
    });
    expect((await f.b.runtime.locate(link, 'SharedThing', 'symbol')).ok).toBe(false);
  });

  it('refuses an expired lookup session', async () => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    const link = await f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader); f.advance(600_001);
    expect((await f.b.runtime.locate(link, 'SharedThing', 'symbol')).ok).toBe(false);
  });

  it('invalidates preparation if the owner changes workspace configuration mid-build', async () => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    const prepare = workspace.reader.prepare.bind(workspace.reader);
    vi.spyOn(workspace.reader, 'prepare').mockImplementation(async (...args) => {
      const snapshot = await prepare(...args); f.a.runtime.invalidateLookups(); return snapshot;
    });
    await expect(f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader)).rejects.toThrow();
  });

  it('does not prepare a workspace for a peer without locate permission', async () => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    const grant = f.a.peerBook.getGrant(f.bKey.peerId)!;
    vi.spyOn(f.a.peerBook, 'getGrant').mockReturnValue({ ...grant, verbs: ['status'] });
    const prepare = vi.spyOn(workspace.reader, 'prepare');
    await expect(f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader)).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('checks cached request deadlines after asynchronous snapshot validation', async () => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    const prepare = workspace.reader.prepare.bind(workspace.reader);
    let expire = false;
    vi.spyOn(workspace.reader, 'prepare').mockImplementation(async (...args) => {
      const snapshot = await prepare(...args); const current = snapshot.isCurrent;
      snapshot.isCurrent = async () => {
        const result = await current(); if (expire) { f.advance(5001); } return result;
      };
      return snapshot;
    });
    const link = await f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader);
    const w = await wire(f, link, { verb: 'locate', args: { token: 'SharedThing', kind: 'symbol' } });
    expect((await w.send()).body).toMatchObject({ ok: true }); expire = true;
    expect((await w.send()).body).toEqual({ ok: false, error: 'denied' });
  });

  it('refuses a credential-shaped filename at egress', async () => {
    const f = await fixture(); const workspace = await lookupWorkspace();
    // Synthetic detector fixture, never a real credential.
    const name = 'AKIA' + 'A'.repeat(16);
    await fs.promises.writeFile(path.join(workspace.root, 'src', name + '.ts'), 'function Ordinary() {}');
    const link = await f.a.runtime.shareLookup(f.bKey.peerId, workspace.reader);
    expect((await f.b.runtime.locate(link, name, 'path')).ok).toBe(false);
  });
});

describe('production Desk local status over real loopback HTTP', () => {
  it('serves a pinned, verified owner status without exporting a private key or reading files', async () => {
    const f = await fixture();
    const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    expect(await f.b.runtime.check(link)).toEqual({ ok: true, verified: true, payload: { availability: 'busy', focus: null } });
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
    expect(f.a.peerBook.spentTodayAll()).toBe(0);
    expect(JSON.stringify(decode(link))).not.toMatch(/privateKey|src|vault/);
  });

  it.each(['enabled', 'serving', 'trusted'] as const)('does not start when %s is false', async flag => {
    const f = await fixture(); f.a.flags[flag] = false;
    const keyReads = f.a.get.mock.calls.length;
    await expect(f.a.runtime.share(f.bKey.peerId, 'available')).rejects.toThrow();
    expect(f.a.get.mock.calls.length).toBe(keyReads);
  });

  it('rotates the recipient link and rejects an expired link', async () => {
    const f = await fixture(); const old = await f.a.runtime.share(f.bKey.peerId, 'busy');
    const link = await f.a.runtime.share(f.bKey.peerId, 'available');
    expect((await f.b.runtime.check(old)).ok).toBe(false);
    expect((await f.b.runtime.check(link)).ok).toBe(true);
    f.advance(600_001);
    expect(await f.b.runtime.check(link)).toEqual({ ok: false, error: 'invalid-local-link' });
  });

  it('requires both the pinned recipient and the pinned responder', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    expect((await f.b.runtime.check(change(link, { audience: f.aKey.peerId }))).ok).toBe(false);
    expect((await f.b.runtime.check(change(link, { peerId: f.bKey.peerId }))).ok).toBe(false);
    await f.b.peerBook.revoke(f.aKey.peerId);
    expect((await f.b.runtime.check(link)).ok).toBe(false);
  });

  it.each(['http://localhost:8000/desk', 'http://127.0.0.2:8000/desk', 'http://2130706433:80/desk',
    'http://127.0.0.1:80/desk?x=1', 'https://127.0.0.1:80/desk', 'http://127.0.0.1:80@evil.test/desk'])('refuses endpoint substitution %s', async url => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    expect(await f.b.runtime.check(change(link, { url }))).toEqual({ ok: false, error: 'invalid-local-link' });
  });

  it('rejects a stolen channel token without the recipient signature', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    const w = await wire(f, link);
    const wrong = { ...w.body, signature: await f.a.identity.sign(canonicalize(w.body.envelope)) };
    expect((await w.send(wrong)).body).toEqual({ ok: false, error: 'denied' });
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(0);
  });

  it('deduplicates concurrent signed retries and refuses reusing their call ID for different bytes', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    const w = await wire(f, link);
    const [first, second] = await Promise.all([w.send(), w.send()]);
    expect(first.body).toEqual(second.body);
    expect((first.body as { ok: boolean }).ok).toBe(true);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
    const changed = await wire(f, link, { callId: w.body.envelope.callId, verb: 'locate', args: { token: 'foo', kind: 'symbol' } });
    expect((await changed.send()).body).toEqual({ ok: false, error: 'denied' });
  });

  it('serves the final allowed call, then refuses further work', async () => {
    const f = await fixture(1); const link = await f.a.runtime.share(f.bKey.peerId, 'available');
    expect((await f.b.runtime.check(link)).ok).toBe(true);
    expect((await f.b.runtime.check(link)).ok).toBe(false);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
  });

  it('returns the cached final call without another debit', async () => {
    const f = await fixture(1); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    const w = await wire(f, link);
    const first = await w.send();
    expect((first.body as { ok: boolean }).ok).toBe(true);
    expect(await w.send()).toEqual(first);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
  });

  it('throttles cached retries at the channel boundary without debiting them again', async () => {
    const f = await fixture(1); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    const w = await wire(f, link);
    for (let i = 0; i < 32; i++) { expect((await w.send()).status).toBe(200); }
    expect((await w.send()).status).toBe(401);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
  });

  it('bounds invalid signed frames and replenishes capacity only after the rate window', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    const w = await wire(f, link);
    for (let i = 0; i < 32; i++) { expect((await w.send({})).status).toBe(200); }
    expect((await w.send()).status).toBe(401);
    f.advance(-1000);
    expect((await w.send()).status).toBe(401);
    f.advance(61_000);
    expect((await f.b.runtime.check(link)).ok).toBe(true);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(1);
  });

  it('charges channel capacity before parsing malformed JSON', async () => {
    const f = await fixture(); const c = decode(await f.a.runtime.share(f.bKey.peerId, 'busy'));
    const malformed = () => new Promise<number>((resolve, reject) => {
      const request = http.request(c.url, { method: 'POST', agent: false,
        headers: { authorization: `Bearer ${c.bearer}`, 'content-type': 'application/json' },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      request.on('error', reject);
      request.setTimeout(2000, () => request.destroy(new Error('timeout')));
      request.end('{');
    });
    for (let i = 0; i < 32; i++) { expect(await malformed()).toBe(400); }
    expect(await malformed()).toBe(401);
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(0);
  });

  it('refuses stale challenges and deadlines before debiting', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    for (const patch of [{ challenge: 'a'.repeat(32) }, { issuedAt: f.now() - 5001 }, { deadlineMs: 10001 }]) {
      const w = await wire(f, link, patch);
      expect((await w.send()).body).toEqual({ ok: false, error: 'denied' });
    }
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(0);
  });

  it('does not resurrect a listener when disabled during identity loading', async () => {
    const f = await fixture();
    const ensure = f.a.identity.ensure.bind(f.a.identity);
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(f.a.identity, 'ensure').mockImplementationOnce(async () => { await paused; return ensure(); });
    const pending = f.a.runtime.refresh();
    f.a.flags.enabled = false; await f.a.runtime.refresh(); resume(); await pending;
    await expect(f.a.runtime.share(f.bKey.peerId, 'busy')).rejects.toThrow();
    f.a.flags.enabled = true;
    expect((await f.b.runtime.check(await f.a.runtime.share(f.bKey.peerId, 'available'))).ok).toBe(true);
  });

  it('refuses unimplemented locate without charging or returning coordinates', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'available');
    const w = await wire(f, link, { verb: 'locate', args: { token: 'secret', kind: 'symbol' } });
    expect((await w.send()).body).toMatchObject({ ok: false, error: 'unknown-verb' });
    expect(f.a.peerBook.callsUsed(f.bKey.peerId)).toBe(0);
  });

  it.each(['enabled', 'serving', 'trusted'] as const)('closes the socket and invalidates old links when %s is removed', async flag => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    f.a.flags[flag] = false; await f.a.runtime.refresh();
    expect((await f.b.runtime.check(link)).ok).toBe(false);
    f.a.flags[flag] = true; await f.a.runtime.refresh();
    expect((await f.b.runtime.check(link)).ok).toBe(false);
    expect((await f.b.runtime.check(await f.a.runtime.share(f.bKey.peerId, 'available'))).ok).toBe(true);
  });

  it('revocation defeats a previously successful cached request', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy'); const w = await wire(f, link);
    expect((await w.send()).status).toBe(200);
    await f.a.peerBook.revoke(f.bKey.peerId);
    expect((await w.send()).status).toBe(410);
  });

  it('drops an in-flight response when trust is removed during the ledger write', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    f.a.update.mockImplementationOnce(async () => { f.a.flags.trusted = false; });
    expect((await f.b.runtime.check(link)).ok).toBe(false);
  });

  it('fails closed on persistence failure', async () => {
    const f = await fixture(); const link = await f.a.runtime.share(f.bKey.peerId, 'busy');
    f.a.update.mockRejectedValueOnce(new Error('private store failure text'));
    const result = await f.b.runtime.check(link);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private store');
  });

  it('cannot restart after disposal', async () => {
    const f = await fixture(); f.a.runtime.dispose();
    await expect(f.a.runtime.share(f.bKey.peerId, 'busy')).rejects.toThrow();
  });

  it('signs a snapshot of binary response digests', async () => {
    const f = await fixture(); const bytes = Buffer.from([0, 128, 255, 65]);
    const pending = f.a.identity.signBytes(bytes); bytes.fill(1);
    const signature = await pending;
    expect(crypto.verify(null, Buffer.from([0, 128, 255, 65]), crypto.createPublicKey({
      key: Buffer.from(f.aKey.publicKey, 'base64'), type: 'spki', format: 'der',
    }), Buffer.from(signature, 'base64'))).toBe(true);
  });
});

describe('loopback carrier bounds', () => {
  async function endpoint(listener: http.RequestListener) {
    const server = http.createServer(listener);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/desk`;
  }
  const options = () => ({ bearer: 'test-token', timeoutMs: 1000, maxBytes: 64, signal: new AbortController().signal });
  it('aborts the response read at its byte cap', async () => {
    const url = await endpoint((_req, res) => { res.writeHead(200); res.write('x'.repeat(65)); });
    await expect(new DeskLoopbackTransport().post(url, {}, options())).rejects.toThrow('too large');
  });
  it('does not follow redirects', async () => {
    const url = await endpoint((_req, res) => { res.writeHead(302, { location: 'https://example.com' }); res.end(); });
    expect(await new DeskLoopbackTransport().post(url, {}, options())).toEqual({ status: 302, body: null });
  });
  it('cancels a hanging request when its caller aborts', async () => {
    const controller = new AbortController();
    const url = await endpoint(() => { controller.abort(); });
    await expect(new DeskLoopbackTransport().post(url, {}, { ...options(), signal: controller.signal })).rejects.toThrow('cancelled');
  });
});
