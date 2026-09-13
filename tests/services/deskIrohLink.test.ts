import { describe, it, expect, vi } from 'vitest';
import { createDeskIrohLink, verifyDeskIrohLink, validDeskRelay } from '../../src/services/desk/DeskIrohLink';
import type { DeskIrohAddress } from '../../src/services/desk/DeskIrohLink';
import { generateKeyPair, peerIdFor } from '../../src/services/desk/DeskEnvelope';
import { supportsDeskIroh, bindDeskIroh } from '../../src/services/DeskIrohNative';

import * as crypto from 'crypto';
const sign = (bytes: string, key: string) => crypto.sign(null, Buffer.from(bytes), crypto.createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64');
const keys = generateKeyPair();
const other = generateKeyPair();
const now = Date.now();
const address: DeskIrohAddress = { v: 1, endpointId: 'a'.repeat(64), relayUrl: 'https://relay.example.test/',
  peerId: peerIdFor(keys.publicKey), audience: peerIdFor(other.publicKey), bearer: 'b'.repeat(32), challenge: 'c'.repeat(32), expiresAt: now + 60_000, verb: 'locate' };
const opts = { now, publicKey: keys.publicKey, audience: address.audience, relayUrl: address.relayUrl };
const make = (a = address) => createDeskIrohLink(a, now, async bytes => sign(bytes, keys.privateKey));

describe('device-signed iroh connection links', () => {
  it('authenticates the complete transport binding against an existing pin', async () => {
    expect(verifyDeskIrohLink(await make(), opts)).toEqual(address);
  });

  it.each(['endpointId', 'relayUrl', 'peerId', 'audience', 'bearer', 'challenge', 'expiresAt', 'verb'])('refuses tampering with %s', async field => {
    const link = await make(); const decoded = JSON.parse(Buffer.from(link.slice('desk://iroh/'.length), 'base64url').toString());
    decoded.address[field] = field === 'expiresAt' ? now + 100_000 : field === 'verb' ? 'status' : 'd'.repeat(32);
    expect(verifyDeskIrohLink('desk://iroh/' + Buffer.from(JSON.stringify(decoded)).toString('base64url'), opts)).toBeNull();
  });

  it('refuses expiry, wrong recipient, unapproved relay and changed pin', async () => {
    const link = await make();
    for (const patch of [{ now: address.expiresAt }, { audience: address.peerId }, { relayUrl: 'https://another.example.test/' }, { publicKey: other.publicKey }]) {
      expect(verifyDeskIrohLink(link, { ...opts, ...patch })).toBeNull();
    }
  });

  it('snapshots the signed address before awaiting the signer', async () => {
    const mutable = { ...address };
    const link = await createDeskIrohLink(mutable, now, async bytes => { mutable.endpointId = 'd'.repeat(64); return sign(bytes, keys.privateKey); });
    expect(verifyDeskIrohLink(link, opts)).toEqual(address);
  });

  it.each(['', 'desk://iroh/!', 'desk://iroh/' + 'a'.repeat(2048), 'desk://local-status/aaaa'])('refuses malformed link %s', link => {
    expect(verifyDeskIrohLink(link, opts)).toBeNull();
  });

  it.each(['http://relay.test/', 'https://user:pass@relay.test/', 'https://relay.test/path', 'https://relay.test/?key=value', 'https://relay.test/#fragment', 'https://relay.test', 'file:///tmp/relay'])('refuses unsafe or noncanonical relay %s', url => {
    expect(validDeskRelay(url)).toBe(false);
  });

  it('does not expose native loading on unsupported editor runtimes or native targets', () => {
    for (const [node, platform, arch] of [['18.17.1', 'linux', 'x64'], ['20.2.0', 'darwin', 'arm64'], ['22.20.0', 'darwin', 'x64'], ['garbage', 'linux', 'x64']]) {
      expect(supportsDeskIroh(node, platform, arch)).toBe(false);
    }
    expect(supportsDeskIroh('20.3.0', 'linux', 'x64')).toBe(true);
    expect(supportsDeskIroh('22.20.0', 'win32', 'arm64')).toBe(true);
  });

  it('rejects an absent relay before touching the injected native binding', async () => {
    await expect(bindDeskIroh(undefined as never, '')).rejects.toThrow('unsupported');
  });

  it('configures only the explicit relay and minimal preset, with no public discovery defaults', async () => {
    const endpoint = { id: vi.fn(), acceptNext: vi.fn(), close: vi.fn(), connect: vi.fn() };
    const builder = { applyMinimal: vi.fn(), applyN0: vi.fn(), relayMode: vi.fn(), alpns: vi.fn(), bind: vi.fn(async () => endpoint) };
    const native = { Endpoint: { builder: () => builder }, RelayMode: { customFromUrls: vi.fn(urls => ({ urls })) } };
    if (!supportsDeskIroh(process.versions.node, process.platform, process.arch)) { return; }
    await bindDeskIroh(native as never, address.relayUrl);
    expect(builder.applyMinimal).toHaveBeenCalledOnce(); expect(builder.applyN0).not.toHaveBeenCalled();
    expect(native.RelayMode.customFromUrls).toHaveBeenCalledWith([address.relayUrl]);
    expect(builder.relayMode).toHaveBeenCalledWith({ urls: [address.relayUrl] });
  });
});
