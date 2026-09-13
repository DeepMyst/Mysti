import { createPublicKey, verify } from 'crypto';
import { canonicalize, peerIdFor } from './DeskEnvelope';

const PREFIX = 'desk://iroh/';
export interface DeskIrohAddress {
  v: 1;
  endpointId: string;
  relayUrl: string;
  peerId: string;
  audience: string;
  bearer: string;
  challenge: string;
  expiresAt: number;
  verb: 'status' | 'locate';
}

/** Only an operator-configured HTTPS relay; links cannot introduce another origin. */
export function validDeskRelay(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) { return false; }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      && !url.search && !url.hash && url.pathname === '/' && url.href === value;
  } catch { return false; }
}

function validAddress(value: unknown, now: number): value is DeskIrohAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const a = value as DeskIrohAddress;
  return Object.keys(a).sort().join(',') === 'audience,bearer,challenge,endpointId,expiresAt,peerId,relayUrl,v,verb'
    && a.v === 1 && typeof a.endpointId === 'string' && /^[a-f0-9]{64}$/.test(a.endpointId)
    && validDeskRelay(a.relayUrl) && typeof a.peerId === 'string' && /^p_[a-z2-7]{16}$/.test(a.peerId)
    && typeof a.audience === 'string' && /^p_[a-z2-7]{16}$/.test(a.audience)
    && typeof a.bearer === 'string' && /^[A-Za-z0-9_-]{32}$/.test(a.bearer)
    && typeof a.challenge === 'string' && /^[A-Za-z0-9_-]{32}$/.test(a.challenge)
    && Number.isFinite(now) && Number.isFinite(a.expiresAt) && a.expiresAt > now && a.expiresAt <= now + 600_000
    && (a.verb === 'status' || a.verb === 'locate');
}

/** The pinned device signs a short-lived transport key; its private key stays in DeskIdentity. */
export async function createDeskIrohLink(address: DeskIrohAddress, now: number, sign: (bytes: string) => Promise<string>): Promise<string> {
  if (!validAddress(address, now)) { throw new Error('Desk address invalid'); }
  // Freeze the bytes before awaiting the signer, including any caller-owned object.
  const snapshot = JSON.parse(JSON.stringify(address)) as DeskIrohAddress;
  const signature = Buffer.from(await sign('mysti.desk/iroh-link/1\n' + canonicalize(snapshot)), 'base64').toString('base64url');
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) { throw new Error('Desk signature invalid'); }
  return PREFIX + Buffer.from(JSON.stringify({ address: snapshot, signature })).toString('base64url');
}

/** Authentication precedes dialing: a forged endpoint must never receive a query. */
export function verifyDeskIrohLink(link: string, opts: { now: number; publicKey: string; audience: string; relayUrl: string }): DeskIrohAddress | null {
  if (typeof link !== 'string' || link.length > 2048 || !link.startsWith(PREFIX)) { return null; }
  const encoded = link.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) { return null; }
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'address,signature'
      || !validAddress(value.address, opts.now) || value.address.audience !== opts.audience
      || value.address.relayUrl !== opts.relayUrl || peerIdFor(opts.publicKey) !== value.address.peerId
      || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) { return null; }
    const key = createPublicKey({ key: Buffer.from(opts.publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from('mysti.desk/iroh-link/1\n' + canonicalize(value.address)), key,
      Buffer.from(value.signature, 'base64url')) ? value.address : null;
  } catch { return null; }
}
