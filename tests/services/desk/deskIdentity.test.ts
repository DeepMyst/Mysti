/**
 * DeskIdentity tests (Plan 21 Phase 3, invariants I12/I13).
 *
 * Six properties carry the security weight, and each has a test that goes red
 * if the corresponding branch is deleted:
 *
 *  1. A vault this module cannot read is a HARD ERROR, never a fresh identity.
 *     `peerId` is the key fingerprint, so quietly minting a new key drops every
 *     pinned peer with no message anywhere.
 *  2. The private key is unreachable from the object graph, so no incidental
 *     `console.log(manager)` or error serializer can print a signing key — and
 *     that includes the vault's OWN error on the one call that hands it the key.
 *  3. `peerId` is DERIVED from the stored public key and never read out of the
 *     stored record, so a blob that claims an identity does not get one (I12).
 *  4. `reset()` really resets: work that was already in flight cannot put the
 *     identity back, and a `sign()` already past its `await ensure()` fails
 *     closed rather than signing with the key the user just destroyed.
 *  5. Exactly one `store()` per generated identity, on every interleaving —
 *     including reset-then-ensure, the one path that used to walk around the
 *     promise memo.
 *  6. The safety number is symmetric AND its exact digits are pinned by a
 *     golden vector. It is a wire format between two independently built copies
 *     of Mysti: a number that depended on who initiated pairing, or that
 *     changed with a build, makes honest comparisons fail — and people who
 *     learn that a mismatch is normal stop treating a mismatch as an attack.
 */
import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import * as util from 'util';
import {
  DESK_DEVICE_KEY,
  DeskIdentity,
  DeskIdentityError,
  safetyNumber,
} from '../../../src/services/desk/DeskIdentity';
import type { SecretVault } from '../../../src/services/desk/DeskIdentity';
import { generateKeyPair, peerIdFor } from '../../../src/services/desk/DeskEnvelope';

const KEYS_A = generateKeyPair();
const KEYS_B = generateKeyPair();

function storedBlob(k: { publicKey: string; privateKey: string }, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, publicKey: k.publicKey, privateKey: k.privateKey, ...over });
}

/** A well-formed PKCS8/SPKI key of an algorithm that can never sign for Desk. */
function foreignKeys(type: 'x25519' | 'rsa'): { publicKey: string; privateKey: string } {
  const pair = type === 'rsa'
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('x25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Records every call so tests can assert what was NOT done, not only what was. */
class FakeVault implements SecretVault {
  readonly values = new Map<string, string>();
  readonly getCalls: string[] = [];
  readonly storeCalls: { key: string; value: string }[] = [];
  readonly deleteCalls: string[] = [];
  getError: Error | null = null;
  /** Built from the value it was handed, the way a real quota error would be. */
  storeError: ((value: string) => Error) | null = null;
  deleteError: Error | null = null;
  delayMs = 0;
  /** Overrides delayMs for delete() only, so a test can order the two calls. */
  deleteDelayMs: number | null = null;
  /** When set, store() persists this instead of what it was given. */
  hijackStoreWith: string | null = null;

  private async _tick(ms = this.delayMs): Promise<void> {
    if (ms > 0) { await new Promise(r => setTimeout(r, ms)); }
    else { await Promise.resolve(); }
  }

  async get(key: string): Promise<string | undefined> {
    this.getCalls.push(key);
    await this._tick();
    if (this.getError) { throw this.getError; }
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.storeCalls.push({ key, value });
    await this._tick();
    if (this.storeError) { throw this.storeError(value); }
    this.values.set(key, this.hijackStoreWith ?? value);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    await this._tick(this.deleteDelayMs ?? this.delayMs);
    if (this.deleteError) { throw this.deleteError; }
    this.values.delete(key);
  }
}

/** Reject with a DeskIdentityError carrying this code, and nothing else. */
async function expectFailure(p: Promise<unknown>, code: string): Promise<DeskIdentityError> {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err, 'expected a rejection').toBeInstanceOf(DeskIdentityError);
  expect((err as DeskIdentityError).code).toBe(code);
  return err as DeskIdentityError;
}

// ---------------------------------------------------------------------------
// ensure()
// ---------------------------------------------------------------------------

describe('DeskIdentity.ensure', () => {
  it('generates and stores on first use, under exactly the documented key', async () => {
    const vault = new FakeVault();
    const id = await new DeskIdentity(vault).ensure();

    expect(vault.storeCalls).toHaveLength(1);
    expect(vault.storeCalls[0].key).toBe(DESK_DEVICE_KEY);
    expect(id.peerId).toBe(peerIdFor(id.publicKey));
    expect(id.peerId).toMatch(/^p_[a-z2-7]{16}$/);
  });

  it('loads an existing identity instead of minting a second one', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));

    const id = await new DeskIdentity(vault).ensure();

    expect(id.publicKey).toBe(KEYS_A.publicKey);
    expect(id.peerId).toBe(peerIdFor(KEYS_A.publicKey));
    expect(vault.storeCalls, 'loading must never rewrite the vault').toHaveLength(0);
  });

  it('DERIVES peerId from the stored public key and ignores one the record claims', async () => {
    // I12, on the load path. Red if `_adopt` ever prefers a stored `peerId`
    // over `peerIdFor(publicKey)`: identity would become something a record can
    // assert rather than something a key can demonstrate, and every pin in the
    // system is keyed by this string. The generate path cannot cover this —
    // there is no stored blob there to carry a competing claim.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A, {
      peerId: 'p_attackerclaimed', publicKeyDer: KEYS_B.publicKey, id: 'p_attackerclaimed',
    }));

    const id = await new DeskIdentity(vault).ensure();

    expect(id.peerId).toBe(peerIdFor(KEYS_A.publicKey));
    expect(id.peerId).not.toBe('p_attackerclaimed');
    expect(Object.keys(id)).toEqual(['peerId', 'publicKey']);
  });

  it('is idempotent: a second call re-reads nothing and re-stores nothing', async () => {
    const vault = new FakeVault();
    const idm = new DeskIdentity(vault);

    const first = await idm.ensure();
    // Absolute, not captured-from-the-implementation: one read of the empty
    // slot and one read back after the write. A test that snapshots whatever
    // the implementation happened to do cannot notice the read-back going away.
    expect(vault.getCalls).toHaveLength(2);
    expect(vault.storeCalls).toHaveLength(1);

    const second = await idm.ensure();

    expect(second).toEqual(first);
    expect(vault.storeCalls).toHaveLength(1);
    expect(vault.getCalls).toHaveLength(2);
  });

  it('is concurrency-safe: simultaneous callers share ONE generated identity', async () => {
    // Red without the promise memo: all three callers pass the `_current` check
    // before any of them awaits, each generates a keypair, and the last write
    // silently replaces a key that peers may already have pinned.
    const vault = new FakeVault();
    vault.delayMs = 5;
    const idm = new DeskIdentity(vault);

    const [a, b, c] = await Promise.all([idm.ensure(), idm.ensure(), idm.ensure()]);

    expect(vault.storeCalls).toHaveLength(1);
    expect(a.peerId).toBe(b.peerId);
    expect(b.peerId).toBe(c.peerId);
  });

  it('hands each caller its own object, so one mutation cannot corrupt another view', async () => {
    const vault = new FakeVault();
    const idm = new DeskIdentity(vault);

    const first = await idm.ensure();
    const original = first.peerId;
    (first as { peerId: string }).peerId = 'p_attackerchosen';

    expect((await idm.ensure()).peerId).toBe(original);
    expect(idm.current()!.peerId).toBe(original);

    // And again on the CACHED path, which returns by a different route than
    // the first call and would otherwise hand out the live record.
    const cached = await idm.ensure();
    (cached as { publicKey: string }).publicKey = 'attacker-supplied';
    expect((await idm.ensure()).publicKey).not.toBe('attacker-supplied');
    expect(idm.current()!.publicKey).not.toBe('attacker-supplied');
  });

  it('treats an empty-string slot as empty rather than as corruption', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, '');

    const id = await new DeskIdentity(vault).ensure();

    expect(id.peerId).toMatch(/^p_/);
    expect(vault.storeCalls).toHaveLength(1);
  });

  it('adopts the vault value after a concurrent window won the write race, and SAYS so', async () => {
    // Red without the read-back: the loser keeps a private key that no longer
    // matches the stored one, and every signature it makes verifies against a
    // public key nobody else believes it owns.
    //
    // The warning is the other half. Under the stated threat model the storage
    // layer is trusted, so this is a benign lost race — but a lost race and a
    // substituted record are indistinguishable from inside this module, and
    // adopting a record we did not write must not be silent.
    const vault = new FakeVault();
    vault.hijackStoreWith = storedBlob(KEYS_B);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const id = await new DeskIdentity(vault).ensure();

      expect(id.publicKey).toBe(KEYS_B.publicKey);
      const said = warn.mock.calls.map(c => String(c[0])).join('\n');
      expect(said).toContain(peerIdFor(KEYS_B.publicKey));
      expect(said, 'a public fingerprint may be logged; key material may not')
        .not.toContain(KEYS_B.privateKey);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the read-back is the record it just wrote', async () => {
    const vault = new FakeVault();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await new DeskIdentity(vault).ensure();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('signs with the identity it adopted after losing the race, not the one it minted', async () => {
    const vault = new FakeVault();
    vault.hijackStoreWith = storedBlob(KEYS_B);
    const idm = new DeskIdentity(vault);

    const id = await idm.ensure();
    const signature = await idm.sign('hello');

    expect(crypto.verify(
      null,
      Buffer.from('hello', 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(id.publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(signature, 'base64'),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corruption is fatal, never a silent regeneration
// ---------------------------------------------------------------------------

describe('DeskIdentity refuses to regenerate over a bad vault', () => {
  const cases: { name: string; value: string; code: string; message?: RegExp }[] = [
    { name: 'unparseable text', value: 'LEAKME_ABC not json at all', code: 'stored-identity-corrupt' },
    { name: 'a JSON array', value: '[1,2,3]', code: 'stored-identity-corrupt' },
    { name: 'a JSON string', value: '"just a string"', code: 'stored-identity-corrupt' },
    { name: 'JSON null', value: 'null', code: 'stored-identity-corrupt' },
    { name: 'an unknown format version', value: storedBlob(KEYS_A, { v: 2 }), code: 'stored-identity-corrupt' },
    // The four below pin the STRUCTURAL guard in _read, not merely "something
    // rejected". Every one of them is also rejected downstream by Buffer.from
    // or by the key importers, so asserting only the code proves nothing about
    // which check ran; the message says which one did.
    {
      name: 'a missing private half', code: 'stored-identity-corrupt', message: /missing a key half/,
      value: JSON.stringify({ v: 1, publicKey: KEYS_A.publicKey }),
    },
    {
      name: 'a non-string private half', code: 'stored-identity-corrupt', message: /missing a key half/,
      value: JSON.stringify({ v: 1, publicKey: KEYS_A.publicKey, privateKey: 42 }),
    },
    {
      name: 'a non-string public half', code: 'stored-identity-corrupt', message: /missing a key half/,
      value: JSON.stringify({ v: 1, publicKey: 42, privateKey: KEYS_A.privateKey }),
    },
    {
      name: 'an empty key half', code: 'stored-identity-corrupt', message: /missing a key half/,
      value: JSON.stringify({ v: 1, publicKey: KEYS_A.publicKey, privateKey: '' }),
    },
    { name: 'a public key that is not a key', value: storedBlob({ publicKey: 'bm90LWEta2V5', privateKey: KEYS_A.privateKey }), code: 'stored-identity-corrupt' },
    { name: 'a private key that is not a key', value: storedBlob({ publicKey: KEYS_A.publicKey, privateKey: 'bm90LWEta2V5' }), code: 'stored-identity-corrupt' },
  ];

  for (const c of cases) {
    it(`throws on ${c.name} and leaves the stored bytes untouched`, async () => {
      const vault = new FakeVault();
      vault.values.set(DESK_DEVICE_KEY, c.value);

      const err = await expectFailure(new DeskIdentity(vault).ensure(), c.code);
      if (c.message) { expect(err.message).toMatch(c.message); }

      expect(vault.storeCalls, 'must not overwrite a record a human may recover').toHaveLength(0);
      expect(vault.deleteCalls, 'must not destroy a record a human may recover').toHaveLength(0);
      expect(vault.values.get(DESK_DEVICE_KEY)).toBe(c.value);
    });
  }

  it('refuses key halves that do not belong to the same identity', async () => {
    // Red without the keypair probe: the device would advertise A's fingerprint
    // while signing with B's key, so every peer rejects every call and nothing
    // in the system says why.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob({ publicKey: KEYS_A.publicKey, privateKey: KEYS_B.privateKey }));

    await expectFailure(new DeskIdentity(vault).ensure(), 'stored-identity-mismatched');
    expect(vault.storeCalls).toHaveLength(0);
  });

  for (const type of ['x25519', 'rsa'] as const) {
    it(`refuses a well-formed ${type} PRIVATE key with the code that names the real fault`, async () => {
      // Red without _importPrivate's algorithm check: an X25519 or RSA PKCS8
      // key parses cleanly, and the failure surfaces two steps later from the
      // keypair probe as 'stored-identity-mismatched' — telling the user their
      // key halves disagree when the truth is the stored key cannot sign at all.
      const vault = new FakeVault();
      vault.values.set(DESK_DEVICE_KEY,
        storedBlob({ publicKey: KEYS_A.publicKey, privateKey: foreignKeys(type).privateKey }));

      const err = await expectFailure(new DeskIdentity(vault).ensure(), 'stored-identity-corrupt');
      expect(err.message).toMatch(/not Ed25519/);
    });

    it(`refuses a well-formed ${type} PUBLIC key in the stored record`, async () => {
      // Red without _importPublic's algorithm check on the STORED path (the
      // safetyNumber path's identical check is covered separately): the blob
      // imports, and the failure degrades into 'stored-identity-mismatched'.
      const vault = new FakeVault();
      vault.values.set(DESK_DEVICE_KEY,
        storedBlob({ publicKey: foreignKeys(type).publicKey, privateKey: KEYS_A.privateKey }));

      const err = await expectFailure(new DeskIdentity(vault).ensure(), 'stored-identity-corrupt');
      expect(err.message).toMatch(/not a usable Ed25519 key/);
    });
  }

  it('refuses an implausibly large but well-formed record', async () => {
    // Red without the size cap: the record parses and is adopted, so an
    // attacker-sized blob becomes an unbounded JSON.parse on every startup.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A, { pad: 'x'.repeat(5000) }));

    await expectFailure(new DeskIdentity(vault).ensure(), 'stored-identity-corrupt');
  });

  it('measures the size cap in UTF-8 bytes, not UTF-16 code units', async () => {
    // Red if the guard compares `raw.length`: an astral-plane character is two
    // code units and four bytes, so a blob that is comfortably "under 4096" by
    // length is ~7.7KB on the wire — a 4x overshoot of the parse-cost bound the
    // guard exists to enforce, and the constant's name becomes a lie.
    const vault = new FakeVault();
    const blob = storedBlob(KEYS_A, { pad: '\u{1D11E}'.repeat(1900) });
    vault.values.set(DESK_DEVICE_KEY, blob);

    expect(blob.length, 'must be under the cap by the WRONG measure').toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(blob, 'utf8'), 'and over it by the right one').toBeGreaterThan(4096);
    await expectFailure(new DeskIdentity(vault).ensure(), 'stored-identity-corrupt');
  });

  it('treats a throwing vault as unreadable, NOT as empty', async () => {
    // Red without the try/catch: the raw error escapes as a non-DeskIdentityError
    // — or, with a naive `catch { return undefined }`, a transient storage fault
    // silently rotates the device identity.
    const vault = new FakeVault();
    vault.getError = new Error('keychain locked');

    await expectFailure(new DeskIdentity(vault).ensure(), 'vault-unreadable');
    expect(vault.storeCalls).toHaveLength(0);
  });

  it('lets a later call retry once the vault recovers', async () => {
    const vault = new FakeVault();
    vault.getError = new Error('keychain locked');
    const idm = new DeskIdentity(vault);

    await expectFailure(idm.ensure(), 'vault-unreadable');
    vault.getError = null;

    // Red if the in-flight memo is not cleared on failure: the rejected promise
    // is handed to every subsequent caller forever.
    const id = await idm.ensure();
    expect(id.peerId).toMatch(/^p_/);
  });

  it('reports a manager with no storage attached as a wiring bug, not a locked keychain', async () => {
    // Red if `_secretsOf` reuses 'vault-unreadable': a caller branching on that
    // code shows "unlock your keychain and retry" for a condition no retry can
    // ever clear. The enum is documented as the thing callers branch on, so
    // overloading one entry is a contract break, not a cosmetic one.
    const orphan = Object.create(DeskIdentity.prototype) as DeskIdentity;

    await expectFailure(orphan.ensure(), 'not-initialized');
  });
});

// ---------------------------------------------------------------------------
// The private key never escapes
// ---------------------------------------------------------------------------

describe('DeskIdentity keeps the private key unreachable', () => {
  it('is absent from the returned identity, the instance, and any serialization of it', async () => {
    // Red if the key is held in a `private _privateKey` field: TypeScript's
    // modifier is erased, so the property survives into JSON.stringify and
    // util.inspect and one stray log prints the device's signing key.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);

    const id = await idm.ensure();
    const secret = KEYS_A.privateKey;

    expect(Object.keys(id)).toEqual(['peerId', 'publicKey']);
    expect(JSON.stringify(id)).not.toContain(secret);
    expect(JSON.stringify(idm)).not.toContain(secret);
    expect(util.inspect(idm, { depth: 10, showHidden: true })).not.toContain(secret);
    expect(JSON.stringify(idm.current())).not.toContain(secret);
    // Sanity: the assertions above would pass trivially against an empty string.
    expect(secret.length).toBeGreaterThan(40);
  });

  it('does not expose the vault itself on the instance', async () => {
    // Red if the vault is kept as a normal field: inspecting the manager walks
    // into whatever the vault holds in memory, so the guarantee would depend on
    // which vault implementation the wiring layer happened to pass.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);
    await idm.ensure();

    const dump = util.inspect(idm, { depth: 10, showHidden: true });
    expect(dump).not.toContain(KEYS_A.privateKey);
    expect(dump).not.toContain(DESK_DEVICE_KEY);
  });

  it('refuses a vault missing a required method, at construction', () => {
    // A half-implemented vault whose `store` is absent would look like it
    // persisted and then mint a fresh identity on every window open.
    for (const bad of [{}, { get: () => undefined }, { get: () => undefined, store: () => undefined }]) {
      let err: unknown;
      try { new DeskIdentity(bad as unknown as SecretVault); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(DeskIdentityError);
      expect((err as DeskIdentityError).code, 'a wiring bug, not a locked keychain').toBe('not-initialized');
    }
  });

  it('never puts stored bytes into an error message or stack', async () => {
    // V8 quotes a prefix of the input in JSON.parse's SyntaxError. Propagating
    // that error would print stored key material wherever it is caught.
    const marker = `LEAKME_${KEYS_A.privateKey.slice(0, 24)}`;
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, `${marker} not json`);

    const err = await expectFailure(new DeskIdentity(vault).ensure(), 'stored-identity-corrupt');

    expect(err.message).not.toContain(marker);
    expect(String(err.stack)).not.toContain(marker);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('never puts a valid stored key into a mismatch error', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob({ publicKey: KEYS_A.publicKey, privateKey: KEYS_B.privateKey }));

    const err = await expectFailure(new DeskIdentity(vault).ensure(), 'stored-identity-mismatched');

    expect(err.message).not.toContain(KEYS_B.privateKey);
    expect(err.message).not.toContain(KEYS_A.publicKey);
    expect(String(err.stack)).not.toContain(KEYS_B.privateKey);
  });

  it('does not let a failing store() carry the freshly minted PRIVATE key back out', async () => {
    // The sharpest edge in the module: store() is the ONE call that hands the
    // private key to caller-supplied foreign code, and echoing the argument in
    // a rejection is an ordinary shape for a quota or serialization error. Red
    // if the vault's error propagates raw — the code becomes undefined, so a
    // caller branching on it falls to its default modal, and the device signing
    // key rides out inside an Error nobody downstream expects to be sensitive.
    const vault = new FakeVault();
    vault.storeError = (value: string) => new Error(`disk full while writing ${value}`);

    const err = await expectFailure(new DeskIdentity(vault).ensure(), 'vault-unwritable');

    const minted = JSON.parse(vault.storeCalls[0].value) as { privateKey: string };
    expect(minted.privateKey.length, 'sanity: there IS a key to leak').toBeGreaterThan(40);
    expect(err.message).not.toContain(minted.privateKey);
    expect(String(err.stack)).not.toContain(minted.privateKey);
    expect(err.message).not.toContain('disk full');
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('does not let a failing delete() propagate raw either', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);
    await idm.ensure();
    vault.deleteError = new Error(`keychain locked holding ${KEYS_A.privateKey}`);

    const err = await expectFailure(idm.reset(), 'vault-unwritable');

    expect(err.message).not.toContain(KEYS_A.privateKey);
    expect(String(err.stack)).not.toContain(KEYS_A.privateKey);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();

    // And the failure is honest about what is still out there: the slot was
    // never cleared, so the next ensure() loads the same identity back rather
    // than minting one over it. Also red if a failed reset leaves `_resetting`
    // set — ensure() would wait on it forever.
    const again = await idm.ensure();
    expect(again.publicKey).toBe(KEYS_A.publicKey);
    expect(vault.storeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sign()
// ---------------------------------------------------------------------------

describe('DeskIdentity.sign', () => {
  const publicOf = (b64: string) =>
    crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

  it('produces a signature that verifies under the advertised public key', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);

    const sig = await idm.sign('{"verb":"locate"}');

    expect(crypto.verify(null, Buffer.from('{"verb":"locate"}', 'utf8'),
      publicOf(KEYS_A.publicKey), Buffer.from(sig, 'base64'))).toBe(true);
  });

  it('does not verify for different bytes or a different key', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const sig = Buffer.from(await new DeskIdentity(vault).sign('a'), 'base64');

    expect(crypto.verify(null, Buffer.from('b', 'utf8'), publicOf(KEYS_A.publicKey), sig)).toBe(false);
    expect(crypto.verify(null, Buffer.from('a', 'utf8'), publicOf(KEYS_B.publicKey), sig)).toBe(false);
  });

  it('bootstraps the identity when called before ensure()', async () => {
    const vault = new FakeVault();
    const idm = new DeskIdentity(vault);

    const sig = await idm.sign('x');

    expect(idm.current()).not.toBeNull();
    expect(crypto.verify(null, Buffer.from('x', 'utf8'),
      publicOf(idm.current()!.publicKey), Buffer.from(sig, 'base64'))).toBe(true);
  });

  it('signs bytes, not characters: multi-byte input round-trips as UTF-8', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const msg = 'café — 日本語';

    const sig = await new DeskIdentity(vault).sign(msg);

    expect(crypto.verify(null, Buffer.from(msg, 'utf8'),
      publicOf(KEYS_A.publicKey), Buffer.from(sig, 'base64'))).toBe(true);
  });

  it('refuses to sign through an unreadable vault rather than signing with nothing', async () => {
    const vault = new FakeVault();
    vault.getError = new Error('keychain locked');

    await expectFailure(new DeskIdentity(vault).sign('x'), 'vault-unreadable');
  });

  it('fails closed when a reset lands between its ensure() and its use of the key', async () => {
    // The window is real and one microtask wide: sign() awaits ensure(), which
    // resolves immediately off the cache, and reset() runs its destroy
    // synchronously in between. Red if reset() stops deleting the WeakMap
    // entry (the signature would be made with the key the user just destroyed)
    // and red if sign()'s `!priv` guard is removed (a raw TypeError from
    // Buffer.from instead of a DeskIdentityError, so nothing can branch on it).
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);
    await idm.ensure();

    const signing = idm.sign('x');
    const failed = expectFailure(signing, 'stored-identity-corrupt');
    await idm.reset();

    const err = await failed;
    expect(err.message).toMatch(/unavailable for signing/);
  });
});

// ---------------------------------------------------------------------------
// current() / invalidate() / reset()
// ---------------------------------------------------------------------------

describe('DeskIdentity.current and reset', () => {
  it('is null before ensure and a copy afterwards', async () => {
    const vault = new FakeVault();
    const idm = new DeskIdentity(vault);

    expect(idm.current()).toBeNull();
    const id = await idm.ensure();
    const snapshot = idm.current()!;
    (snapshot as { publicKey: string }).publicKey = 'tampered';

    expect(idm.current()!.publicKey).toBe(id.publicKey);
  });

  it('reset clears the vault slot, the cache, and the signing key', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);
    await idm.ensure();

    await idm.reset();

    expect(vault.deleteCalls).toEqual([DESK_DEVICE_KEY]);
    expect(idm.current()).toBeNull();
    expect(vault.values.has(DESK_DEVICE_KEY)).toBe(false);
  });

  it('reset yields a genuinely NEW identity, and the old key can no longer sign', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);
    const before = await idm.ensure();

    await idm.reset();
    const after = await idm.ensure();
    const sig = Buffer.from(await idm.sign('m'), 'base64');

    expect(after.peerId).not.toBe(before.peerId);
    expect(crypto.verify(null, Buffer.from('m', 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(before.publicKey, 'base64'), format: 'der', type: 'spki' }), sig)).toBe(false);
    expect(crypto.verify(null, Buffer.from('m', 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(after.publicKey, 'base64'), format: 'der', type: 'spki' }), sig)).toBe(true);
  });

  it('defeats an ensure() that was already in flight: nothing is minted or left behind', async () => {
    // The headline: reset() used to null the in-flight promise and delete, so
    // the abandoned load's store() landed AFTER the delete and put the identity
    // straight back — a user who reset because they suspected a compromise went
    // on signing with the key they believed was gone. Red on `storeCalls` if
    // the load is allowed to mint under a raised generation, and red on the
    // vault/current assertions if reset() stops waiting the load out.
    const vault = new FakeVault();
    vault.delayMs = 5;
    const idm = new DeskIdentity(vault);

    const inflight = idm.ensure();
    const failed = expectFailure(inflight, 'identity-reset');
    await idm.reset();
    await failed;

    expect(vault.storeCalls, 'a reset identity must never be written at all').toHaveLength(0);
    expect(vault.values.has(DESK_DEVICE_KEY)).toBe(false);
    expect(vault.deleteCalls).toEqual([DESK_DEVICE_KEY]);
    expect(idm.current()).toBeNull();
  });

  it('defeats an in-flight ensure() that was LOADING an existing identity', async () => {
    // The other half of the same race: here the load has a record to adopt, so
    // without the generation check it installs `_current` and the signing key
    // and hands the caller an identity the user just destroyed.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    vault.delayMs = 5;
    const idm = new DeskIdentity(vault);

    const inflight = idm.ensure();
    const failed = expectFailure(inflight, 'identity-reset');
    await idm.reset();
    await failed;

    expect(idm.current()).toBeNull();
    expect(vault.values.has(DESK_DEVICE_KEY)).toBe(false);
    expect(vault.storeCalls).toHaveLength(0);
  });

  it('keeps "exactly one store per identity" across reset-then-ensure', async () => {
    // reset() was the one code path that walked around the promise memo: it
    // nulled `_pending` without awaiting it, so the next ensure() started a
    // SECOND concurrent generate-and-store. Red with two stores if it does.
    const vault = new FakeVault();
    vault.delayMs = 5;
    const idm = new DeskIdentity(vault);

    const abandoned = idm.ensure();
    const failed = expectFailure(abandoned, 'identity-reset');
    await idm.reset();
    await failed;

    const id = await idm.ensure();

    expect(vault.storeCalls).toHaveLength(1);
    expect((JSON.parse(vault.storeCalls[0].value) as { publicKey: string }).publicKey).toBe(id.publicKey);
  });

  it('coalesces concurrent resets into one delete', async () => {
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    vault.delayMs = 5;
    const idm = new DeskIdentity(vault);
    await idm.ensure();

    await Promise.all([idm.reset(), idm.reset(), idm.reset()]);

    expect(vault.deleteCalls).toEqual([DESK_DEVICE_KEY]);
    expect(idm.current()).toBeNull();
  });

  it('makes an ensure() that arrives DURING a reset wait for it, then start clean', async () => {
    // The delete is deliberately the SLOW operation here. Red without the
    // deferral: the arriving ensure() reads the slot while the delete is still
    // in flight, finds KEYS_A, and re-adopts the identity the user is in the
    // middle of destroying — after which the delete lands and the vault and
    // the cache disagree about who this device is. With equal delays the
    // mutant survives on timing luck, which is exactly why they are not equal.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    vault.delayMs = 1;
    vault.deleteDelayMs = 40;
    const idm = new DeskIdentity(vault);
    await idm.ensure();

    const resetting = idm.reset();
    const during = idm.ensure();
    await resetting;
    const id = await during;

    expect(id.publicKey, 'must not re-adopt the identity being destroyed').not.toBe(KEYS_A.publicKey);
    expect(vault.storeCalls).toHaveLength(1);
    expect(vault.values.get(DESK_DEVICE_KEY)).toBe(vault.storeCalls[0].value);
    expect(idm.current()!.publicKey).toBe(id.publicKey);
  });

  it('invalidate() re-reads a slot another window rotated, without touching it', async () => {
    // Without an invalidation hook the identity is cached for the life of the
    // process: ensure() short-circuits on `_current` and never looks at the
    // vault again, so a window that was open when another window reset keeps
    // signing with a key its peers have already dropped, with no local signal.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);
    await idm.ensure();

    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_B));
    expect((await idm.ensure()).publicKey, 'cached by design until invalidated').toBe(KEYS_A.publicKey);

    idm.invalidate();
    const after = await idm.ensure();
    const sig = Buffer.from(await idm.sign('m'), 'base64');

    expect(after.publicKey).toBe(KEYS_B.publicKey);
    expect(after.peerId).toBe(peerIdFor(KEYS_B.publicKey));
    expect(vault.storeCalls, 'invalidate must never mint or rewrite').toHaveLength(0);
    expect(vault.deleteCalls).toHaveLength(0);
    expect(crypto.verify(null, Buffer.from('m', 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(KEYS_B.publicKey, 'base64'), format: 'der', type: 'spki' }), sig)).toBe(true);
    expect(crypto.verify(null, Buffer.from('m', 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(KEYS_A.publicKey, 'base64'), format: 'der', type: 'spki' }), sig)).toBe(false);
  });

  it('invalidate() does not start a second concurrent generate-and-store', async () => {
    // The reason it leaves `_pending` alone. Red with two stores if it drops
    // the memo: the in-flight load has already read the vault, so joining it is
    // exactly what a re-read would produce, and abandoning it is how a second
    // keypair gets minted and one of the two silently overwritten.
    const vault = new FakeVault();
    vault.delayMs = 5;
    const idm = new DeskIdentity(vault);

    const first = idm.ensure();
    idm.invalidate();
    const second = idm.ensure();
    const [a, b] = await Promise.all([first, second]);

    expect(vault.storeCalls).toHaveLength(1);
    expect(a.peerId).toBe(b.peerId);
  });

  it('does not write the destroyed peerId into the log', async () => {
    // peerId is public and derived, so this is not key material — but writing
    // the identity a user just asked to destroy into a persistent extension log
    // is the opposite of what they asked for.
    const vault = new FakeVault();
    vault.values.set(DESK_DEVICE_KEY, storedBlob(KEYS_A));
    const idm = new DeskIdentity(vault);
    await idm.ensure();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await idm.reset();
      const said = log.mock.calls.map(c => String(c[0])).join('\n');
      expect(said).toContain('reset');
      expect(said).not.toContain(peerIdFor(KEYS_A.publicKey));
    } finally {
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// safetyNumber
// ---------------------------------------------------------------------------

describe('safetyNumber', () => {
  const NUMBER_RE = /^\d{5}(?: \d{5}){11}$/;

  /**
   * A golden vector. Two fixed Ed25519 public keys and the exact digits they
   * must produce, forever.
   *
   * Every other test here is a relational property — symmetric, deterministic,
   * changes on rotation — and every one of them stays green if the domain
   * string, the iteration count, the group geometry, the digest or the
   * truncation changes. That is the failure this pins: two Mysti builds
   * producing different numbers for the same key pair is indistinguishable, to
   * the two people reading them aloud, from a substituted key. The number is a
   * wire format; changing it is a protocol break, and a protocol break should
   * fail a test rather than a pairing ceremony.
   */
  const GOLDEN_A = 'MCowBQYDK2VwAyEA85HkyhzsJfvhHcsvLZOdtu+rwmMI/pTpyokK84ext/A=';
  const GOLDEN_B = 'MCowBQYDK2VwAyEA2o8rgJGTEHs37HslQuSW6gBhnAr7SJpGEx5lZtZwvwU=';
  const GOLDEN_NUMBER = '02789 76529 88801 98784 77274 41130 52624 86813 37649 72686 16056 62472';

  it('matches its golden vector exactly, from either side', () => {
    expect(safetyNumber(GOLDEN_A, GOLDEN_B)).toBe(GOLDEN_NUMBER);
    expect(safetyNumber(GOLDEN_B, GOLDEN_A)).toBe(GOLDEN_NUMBER);
  });

  it('renders 12 groups of 5 digits', () => {
    expect(safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey)).toMatch(NUMBER_RE);
  });

  it('drops no digits: the groups reassemble into the full 60', () => {
    // Red if the final split can silently discard a remainder, or hand back an
    // empty string. An empty or short safety number is the worst possible
    // failure shape for this ceremony: it compares EQUAL on both machines, so
    // two people confirming '' against '' finish having verified nothing.
    const groups = safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey).split(' ');

    expect(groups).toHaveLength(12);
    for (const g of groups) { expect(g).toMatch(/^\d{5}$/); }
    expect(groups.join('')).toHaveLength(60);
  });

  it('is symmetric — argument order cannot change what two people read aloud', () => {
    // Red without the ordering step. This is the single most important
    // assertion in the file: an asymmetric number makes every honest
    // comparison fail, which trains people to ignore a mismatch.
    expect(safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey))
      .toBe(safetyNumber(KEYS_B.publicKey, KEYS_A.publicKey));
  });

  it('is deterministic across calls', () => {
    expect(safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey))
      .toBe(safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey));
  });

  it('changes when either side rotates its key', () => {
    const base = safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey);
    const rotated = generateKeyPair();

    expect(safetyNumber(rotated.publicKey, KEYS_B.publicKey)).not.toBe(base);
    expect(safetyNumber(KEYS_A.publicKey, rotated.publicKey)).not.toBe(base);
  });

  it('binds to the key bytes, not to their base64 spelling', () => {
    // Red if the digest is taken over the base64 string: one side pasting a
    // line-wrapped key would read a different number and abort a correct pairing.
    const wrapped = `${KEYS_A.publicKey.slice(0, 8)}\n ${KEYS_A.publicKey.slice(8)}`;

    expect(safetyNumber(wrapped, KEYS_B.publicKey))
      .toBe(safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey));
  });

  it('is well-defined for a degenerate self-pairing', () => {
    expect(safetyNumber(KEYS_A.publicKey, KEYS_A.publicKey)).toMatch(NUMBER_RE);
  });

  it('does not simply repeat one half for two distinct keys', () => {
    const n = safetyNumber(KEYS_A.publicKey, KEYS_B.publicKey).replace(/ /g, '');
    expect(n.slice(0, 30)).not.toBe(n.slice(30));
  });

  it('refuses input that is not an Ed25519 public key', () => {
    for (const bad of ['', 'not-base64!!', Buffer.from('short').toString('base64')]) {
      expect(() => safetyNumber(bad, KEYS_B.publicKey)).toThrow(DeskIdentityError);
      expect(() => safetyNumber(KEYS_A.publicKey, bad)).toThrow(DeskIdentityError);
    }
  });

  it('refuses a well-formed SPKI key of the wrong algorithm', () => {
    // Red without the asymmetricKeyType check: an X25519 or RSA SPKI blob
    // parses cleanly, so the ceremony would succeed over a key that can never
    // sign and every later call would fail for no stated reason.
    for (const bad of [foreignKeys('x25519').publicKey, foreignKeys('rsa').publicKey]) {
      expect(() => safetyNumber(bad, KEYS_B.publicKey)).toThrow(/not Ed25519/);
    }
  });

  it('reports the failure code callers branch on', () => {
    try {
      safetyNumber('', KEYS_B.publicKey);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as DeskIdentityError).code).toBe('invalid-public-key');
    }
  });
});
