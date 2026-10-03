/**
 * DeskLedger tests (Plan 21 Phase 5, invariant I20).
 *
 * The property under test is a REFUSAL that never expires. Delivery is
 * at-least-once and applying a patch is not idempotent, so the failure this
 * file guards is "the same remote effect lands twice, the second time on top
 * of a human's edits". Every test here is written to go red if the branch it
 * covers is deleted; the happy path is one test, and the rest are the ways a
 * ledger quietly stops being a ledger -- a forgotten row, a NaN timestamp that
 * JSON-serialises to null, a second window that never sees the first one's
 * write, an unreadable row treated as no row, and above all a WRITE made from
 * a map that could not be reconciled with the store, which does not degrade
 * the ledger but erases it.
 *
 * Hostile characters are built with String.fromCharCode rather than typed.
 * A literal bidi override in a test file reorders the file for the next human
 * who reads it, which is the attack itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { DeskLedger } from '../../../src/services/desk/DeskLedger';
import type { LedgerStore, LedgerEntry } from '../../../src/services/desk/DeskLedger';

const PEER = 'peer_bob';
const OTHER_PEER = 'peer_alice';
const EFFECT = 'e_01JD7';
const BASE = 'a'.repeat(40);
const BASE2 = 'b'.repeat(40);
const BASE_256 = 'c'.repeat(64);
const STORE_KEY = 'mysti.desk.ledger.v1';

/** U+202E right-to-left override: renders the text after it reversed. */
const RLO = String.fromCharCode(0x202E);
/** U+200B zero-width space: invisible, enough to hide a discriminator in an id. */
const ZWSP = String.fromCharCode(0x200B);
/** U+001B escape: the first byte of every terminal control sequence. */
const ESC = String.fromCharCode(0x1B);

/** The canonical label shape; the peer half is not decoration (see labelFor). */
function canon(peer: string, effect: string): string {
  return `desk:${peer}:${effect}`;
}

/** A well-formed stored row. */
function row(peer: string, effect: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { peerId: peer, effectId: effect, baseSha: BASE, appliedAt: 1, label: canon(peer, effect), ...over };
}

/** Silence and capture the module's own console.error for a block. */
function quiet(): { restore: () => void } {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return { restore: () => spy.mockRestore() };
}

/**
 * A globalState stand-in. The JSON round-trip is deliberate, not decoration:
 * vscode serialises what it stores, which is how a NaN becomes null and takes
 * a consumed effect with it.
 */
class FakeStore implements LedgerStore {
  data = new Map<string, unknown>();
  writes = 0;
  failWrite: Error | null = null;
  readThrows = false;
  /** Runs before every successful read; lets a test simulate another window. */
  onGet: ((gets: number) => void) | null = null;
  gets = 0;

  get<T>(key: string): T | undefined {
    this.gets++;
    if (this.readThrows) { throw new Error('store read exploded'); }
    this.onGet?.(this.gets);
    const v = this.data.get(key);
    return (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.writes++;
    if (this.failWrite) { throw this.failWrite; }
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }

  blob(): Record<string, unknown> {
    return (this.data.get(STORE_KEY) ?? {}) as Record<string, unknown>;
  }

  rows(): Record<string, unknown> {
    const blob = this.data.get(STORE_KEY) as { entries?: Record<string, unknown> } | undefined;
    return blob?.entries ?? {};
  }

  /** Seed a blob in the shape this build writes, with a caller-chosen stamp. */
  seed(entries: Record<string, unknown>, over: Record<string, unknown> = {}): void {
    this.data.set(STORE_KEY, { v: 1, stamp: 's1', entries, ...over });
  }
}

/**
 * A store that hands back LIVE objects rather than a JSON round-trip. The
 * LedgerStore contract does not promise serialisation, and shapes that cannot
 * survive JSON -- an array carrying row fields, a proxy -- are exactly the
 * ones the structural guards exist for.
 */
class RawStore implements LedgerStore {
  constructor(private readonly _value: unknown) {}
  updates = 0;
  get<T>(): T | undefined { return this._value as T; }
  async update(): Promise<void> { this.updates++; }
}

function ledger(store: LedgerStore, now?: () => number): DeskLedger {
  return new DeskLedger(store, now);
}

function labelled(l: DeskLedger, peer = PEER, effect = EFFECT, baseSha = BASE) {
  return { peerId: peer, effectId: effect, baseSha, label: l.labelFor(peer, effect) };
}

/** The private maps, for pinning invariants that have no public surface. */
function internalEntries(l: DeskLedger): Map<string, LedgerEntry> {
  return (l as unknown as { _entries: Map<string, LedgerEntry> })._entries;
}

function internalPending(l: DeskLedger): Set<string> {
  return (l as unknown as { _pending: Set<string> })._pending;
}

describe('DeskLedger -- the fresh path', () => {
  it('admits an effect it has never seen', () => {
    const l = ledger(new FakeStore());
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
  });

  it('keys by (peerId, effectId): the same effectId from another peer is fresh', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    expect(l.check(PEER, EFFECT, BASE).ok).toBe(false);
    // Two peers minting the same opaque id are two different effects, each
    // gated by its own peer's approval. Collapsing them would let one peer
    // suppress another's handoff by burning the id first.
    expect(l.check(OTHER_PEER, EFFECT, BASE)).toEqual({ ok: true });
  });

  it('accepts a sha256 object id as a base', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l, PEER, EFFECT, BASE_256));
    expect(l.check(PEER, EFFECT, BASE_256)).toMatchObject({ ok: false, reason: 'replayed' });
  });
});

describe('DeskLedger -- replay is refused forever (I20)', () => {
  it('refuses a second apply at the same base', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    const d = l.check(PEER, EFFECT, BASE);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('replayed');
    expect(d.ok === false && d.detail).toContain(EFFECT);
  });

  it('refuses regardless of how much time has passed -- there is no dedupe window', async () => {
    const store = new FakeStore();
    let clock = 1_000;
    const l = ledger(store, () => clock);
    await l.record(labelled(l));
    // A year later. Any TTL-shaped implementation goes green here and is
    // exactly the bug: the attacker's move is to redeliver AFTER the window.
    clock += 365 * 24 * 60 * 60 * 1000;
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('survives a restart: a fresh ledger over the same store still refuses', async () => {
    const store = new FakeStore();
    const first = ledger(store);
    await first.record(labelled(first));
    const second = ledger(store);
    expect(second.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('refuses an effect another WINDOW consumed after this one loaded', async () => {
    const store = new FakeStore();
    const windowB = ledger(store);          // loaded while the store was empty
    const windowA = ledger(store);
    await windowA.record(labelled(windowA));
    // windowB has never seen this row in memory. If check answered from memory
    // alone this is a double-apply with no hostile peer involved at all.
    expect(windowB.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('reads a legacy blob (no version, no stamp) written by an earlier build', () => {
    const store = new FakeStore();
    store.data.set(STORE_KEY, { entries: { [`${PEER}${'|'}${EFFECT}`]: row(PEER, EFFECT) } });
    const l = ledger(store);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
  });
});

describe('DeskLedger -- check is a reservation, not a query', () => {
  it('refuses a second check while the first apply is still in flight', () => {
    const l = ledger(new FakeStore());
    // The redelivery BURST: two copies of one handoff racing between check and
    // record. Admitting both puts two patches down and leaves record() to
    // report the damage after the fact.
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'in-flight' });
  });

  it('reserves only the key it admitted', () => {
    const l = ledger(new FakeStore());
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
    expect(l.check(PEER, 'e_other', BASE)).toEqual({ ok: true });
    expect(l.check(OTHER_PEER, EFFECT, BASE)).toEqual({ ok: true });
  });

  it('release gives the key back when the apply never happened', () => {
    const l = ledger(new FakeStore());
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
    l.release(PEER, EFFECT);
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
  });

  it('release can never resurrect a CONSUMED effect', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
    await l.record(labelled(l));
    l.release(PEER, EFFECT);
    l.release(PEER, EFFECT);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('record clears the reservation, so the refusal comes from the row', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
    await l.record(labelled(l));
    // 'replayed' rather than 'in-flight': a stale marker would hide the fact
    // that the effect is durably consumed behind a transient-looking reason.
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
    // The row now refuses forever, so keeping the marker would be a per-effect
    // in-memory leak that no later call can ever observe or clear.
    expect(internalPending(l).has(`${PEER}|${EFFECT}`)).toBe(false);
  });

  it('release ignores a malformed id rather than throwing (it is not the gate)', () => {
    const l = ledger(new FakeStore());
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
    expect(() => l.release('bad peer', EFFECT)).not.toThrow();
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'in-flight' });
  });

  it('an append-only rejection also clears the reservation', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    const other = ledger(store);
    expect(other.check(PEER, 'e_two', BASE)).toEqual({ ok: true });
    await expect(other.record(labelled(other, PEER, EFFECT))).rejects.toThrow(/append-only/);
    // The reservation for e_two is untouched by another key's rejection.
    expect(other.check(PEER, 'e_two', BASE)).toMatchObject({ ok: false, reason: 'in-flight' });
  });
});

describe('DeskLedger -- base drift needs a human (I20)', () => {
  it('refuses with base-drift when the tree has moved since the effect was applied', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    const d = l.check(PEER, EFFECT, BASE2);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('base-drift');
    // The recorded base has to be NAMED, or the human cannot make the
    // decision the refusal is asking them to make.
    expect(d.ok === false && d.detail).toContain(BASE);
    expect(d.ok === false && d.detail).toContain(BASE2);
  });

  it('never auto-rebases: drift stays a refusal on every subsequent check', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    expect(l.check(PEER, EFFECT, BASE2).ok).toBe(false);
    expect(l.check(PEER, EFFECT, BASE2).ok).toBe(false);
    // And the recorded base is untouched by having been checked against.
    expect(l.entriesFor(PEER)[0].baseSha).toBe(BASE);
  });

  it('fails closed on a row it cannot parse: an unreadable row is not "no row"', () => {
    const store = new FakeStore();
    store.seed({ [`${PEER}|${EFFECT}`]: { peerId: PEER, effectId: EFFECT, shape: 'from a newer build' } });
    const l = ledger(store);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
  });
});

describe('DeskLedger -- malformed input fails closed', () => {
  const cases: [string, string, string, string][] = [
    ['peerId with a space', 'peer bob', EFFECT, BASE],
    ['empty peerId', '', EFFECT, BASE],
    ['peerId with a path segment', '../peer', EFFECT, BASE],
    ['over-long effectId', PEER, 'e'.repeat(65), BASE],
    ['effectId with a bidi override', PEER, `e${RLO}ff`, BASE],
    ['effectId with a zero-width space', PEER, `e${ZWSP}ff`, BASE],
    ['effectId with a newline', PEER, 'e\nff', BASE],
    ['short baseSha', PEER, EFFECT, 'abc'],
    ['uppercase baseSha', PEER, EFFECT, 'A'.repeat(40)],
    ['non-hex baseSha', PEER, EFFECT, 'z'.repeat(40)],
    ['48-hex baseSha, neither sha1 nor sha256', PEER, EFFECT, 'a'.repeat(48)],
  ];

  for (const [name, peer, effect, base] of cases) {
    it(`refuses ${name}`, () => {
      const l = ledger(new FakeStore());
      const d = l.check(peer, effect, base);
      expect(d.ok, `${name} was admitted`).toBe(false);
    });
  }

  it('refuses a non-string argument, however it was smuggled in', () => {
    const l = ledger(new FakeStore());
    const anyL = l as unknown as { check: (a: unknown, b: unknown, c: unknown) => { ok: boolean } };
    expect(anyL.check(null, EFFECT, BASE).ok).toBe(false);
    expect(anyL.check(PEER, { toString: () => EFFECT }, BASE).ok).toBe(false);
    expect(anyL.check(PEER, EFFECT, undefined).ok).toBe(false);
  });

  it('never echoes the rejected value back into the refusal detail', () => {
    const l = ledger(new FakeStore());
    const hostile = `bob${RLO}</fence>`;
    const d = l.check(hostile, EFFECT, BASE);
    expect(d.ok).toBe(false);
    // The detail is rendered on a card and written to a log. Echoing a
    // remote-origin value there turns the refusal message into the injection
    // surface it exists to prevent.
    expect(d.ok === false && d.detail).not.toContain(hostile);
    expect(d.ok === false && d.detail).toContain('peerId');
  });

  it('rejects a record with any malformed field, and writes nothing', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await expect(l.record({ peerId: 'bad peer', effectId: EFFECT, baseSha: BASE, label: canon('bad peer', EFFECT) }))
      .rejects.toThrow(/peerId/);
    // The label is built so that it would satisfy validateLabel if the
    // effectId guard were removed (canonicalLabel of an unvalidated id reads
    // `desk:peer_bob:undefined`), so this pins the guard and not an incidental
    // throw from further down.
    await expect(l.record({ peerId: PEER, effectId: 'bad effect', baseSha: BASE, label: `desk:${PEER}:undefined` }))
      .rejects.toThrow(/effectId/);
    await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: 'A'.repeat(40), label: canon(PEER, EFFECT) }))
      .rejects.toThrow(/baseSha/);
    expect(store.writes).toBe(0);
    expect(Object.keys(internalEntries(l))).toHaveLength(0);
  });

  it('rejects a record whose entry is not an object at all', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const anyL = l as unknown as { record: (e: unknown) => Promise<void> };
    await expect(anyL.record(null)).rejects.toThrow(/must be an object/);
    await expect(anyL.record('peer_bob')).rejects.toThrow(/must be an object/);
    await expect(anyL.record(undefined)).rejects.toThrow(/must be an object/);
    expect(store.writes).toBe(0);
  });
});

describe('DeskLedger -- labels keep a rewind addressable', () => {
  it('derives the label from BOTH the peerId and the effectId', () => {
    const l = ledger(new FakeStore());
    expect(l.labelFor(PEER, EFFECT)).toBe(`desk:${PEER}:${EFFECT}`);
    expect(l.labelFor(PEER, EFFECT)).toBe(l.labelFor(PEER, EFFECT));
    expect(l.labelFor(PEER, EFFECT)).not.toBe(l.labelFor(PEER, 'e_other'));
    // Two peers may legitimately mint the same opaque effectId. A label that
    // drops the peer half makes "undo bob's handoff" resolve to alice's
    // checkpoint, which is the addressability half of I20 failing silently.
    expect(l.labelFor(PEER, EFFECT)).not.toBe(l.labelFor(OTHER_PEER, EFFECT));
  });

  it('throws rather than returning a label built from unvalidated bytes', () => {
    const l = ledger(new FakeStore());
    expect(() => l.labelFor('peer bob', EFFECT)).toThrow();
    expect(() => l.labelFor(PEER, `e${RLO}x`)).toThrow();
    expect(() => l.labelFor(PEER, 'e\nx')).toThrow();
  });

  it('refuses a label that drops the effectId -- the rewind would be unaddressable', async () => {
    const l = ledger(new FakeStore());
    await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label: `desk:${PEER}:` }))
      .rejects.toThrow(/label/);
  });

  it('refuses a label that drops the PEER half, even though it names the effect', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    // The exact shape the old rule blessed: it contains the effectId, so it
    // read as addressable, while resolving to whichever peer got there first.
    await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label: `undo handoff ${EFFECT}` }))
      .rejects.toThrow(/label/);
    await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label: canon(OTHER_PEER, EFFECT) }))
      .rejects.toThrow(/label/);
    expect(store.writes).toBe(0);
  });

  it('refuses a label carrying a newline, a terminal escape or a bidi override', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const core = canon(PEER, EFFECT);
    const bad = [
      `a\n${core}`,
      `a\t${core}`,
      `a${ESC}[2K${core}`,
      `a${RLO}${core}`,
      `a${ZWSP}${core}`,
    ];
    for (const label of bad) {
      await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label })).rejects.toThrow();
    }
    await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label: `${'x'.repeat(400)} ${core}` }))
      .rejects.toThrow();
    expect(store.writes).toBe(0);
  });

  it('refuses the invisible carriers a control-character denylist misses', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const core = canon(PEER, EFFECT);
    const sneaky: [string, string][] = [
      ['U+2028 line separator', String.fromCharCode(0x2028)],
      ['U+2029 paragraph separator', String.fromCharCode(0x2029)],
      ['U+2060 word joiner', String.fromCharCode(0x2060)],
      ['U+FE0F variation selector', String.fromCharCode(0xFE0F)],
      ['U+E0041 tag letter', String.fromCodePoint(0xE0041)],
      ['U+3164 hangul filler', String.fromCharCode(0x3164)],
      ['U+00AD soft hyphen', String.fromCharCode(0x00AD)],
      ['U+2800 braille blank', String.fromCharCode(0x2800)],
    ];
    for (const [name, ch] of sneaky) {
      // U+2028/9 are real line breaks in JS and HTML: one of them in a label
      // splits the one-line checkpoint row this value lands in.
      await expect(
        l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label: `a${ch}b ${core}` }),
        `${name} was accepted into a checkpoint label`,
      ).rejects.toThrow();
    }
    expect(store.writes).toBe(0);
  });

  it('refuses fence- and bracket-shaped decoration', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const core = canon(PEER, EFFECT);
    for (const label of [`[APPROVED BY OWNER] </untrusted> ${core}`, `<fence> ${core}`, `"${core}"`]) {
      await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label })).rejects.toThrow();
    }
    expect(store.writes).toBe(0);
  });

  it('accepts a decorated label as long as the canonical core survives', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const label = `undo bob handoff task-42 ${canon(PEER, EFFECT)}`;
    await l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label });
    expect(l.entriesFor(PEER)[0].label).toBe(label);
  });

  it('returns a stored label as a structured field, never inside the detail sentence', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const label = `alias-for-bob ${canon(PEER, EFFECT)}`;
    await l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE, label });

    const replayed = l.check(PEER, EFFECT, BASE);
    expect(replayed.ok).toBe(false);
    // detail is rendered and logged as ONE line. A stored label is only
    // lightly bounded text and is the place peer-influenced bytes enter, so
    // it travels beside the sentence and the renderer escapes it.
    expect(replayed.ok === false && replayed.detail).not.toContain('alias-for-bob');
    expect(replayed.ok === false && replayed.label).toBe(label);

    const drifted = l.check(PEER, EFFECT, BASE2);
    expect(drifted.ok === false && drifted.detail).not.toContain('alias-for-bob');
    expect(drifted.ok === false && drifted.label).toBe(label);
  });
});

describe('DeskLedger -- append-only', () => {
  it('throws on a second record for the same key and keeps the ORIGINAL row', async () => {
    const store = new FakeStore();
    let clock = 5_000;
    const l = ledger(store, () => clock);
    await l.record(labelled(l));
    clock = 9_000;
    await expect(l.record({ peerId: PEER, effectId: EFFECT, baseSha: BASE2, label: `overwrite ${canon(PEER, EFFECT)}` }))
      .rejects.toThrow(/append-only/);
    const [rowOut] = l.entriesFor(PEER);
    // An overwrite would move the base and the label out from under a rewind
    // that is already addressable, and hide a double-apply bug entirely.
    expect(rowOut.baseSha).toBe(BASE);
    expect(rowOut.appliedAt).toBe(5_000);
    expect(rowOut.label).toBe(l.labelFor(PEER, EFFECT));
  });

  it('will not overwrite an unreadable row either', async () => {
    const store = new FakeStore();
    store.seed({ [`${PEER}|${EFFECT}`]: { junk: true } });
    const l = ledger(store);
    await expect(l.record(labelled(l))).rejects.toThrow(/append-only/);
  });

  it('preserves rows it cannot parse across its own writes (downgrade safety)', async () => {
    const store = new FakeStore();
    const foreignKey = `${OTHER_PEER}|e_future`;
    store.seed({
      [foreignKey]: { peerId: OTHER_PEER, effectId: 'e_future', v2: 'shape this build cannot read' },
    });
    const l = ledger(store);
    await l.record(labelled(l));
    // Dropping the row would make an older build FORGET a consumed effect the
    // newer one recorded, which is a downgrade-shaped replay hole.
    expect(store.rows()[foreignKey]).toBeTruthy();
    expect(store.rows()[`${PEER}|${EFFECT}`]).toBeTruthy();
  });

  it('will not flatten a newer-shaped row it already holds a parsed row for', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const key = `${PEER}|${EFFECT}`;
    await l.record(labelled(l));

    // A newer build rewrites the SAME key in a shape this build cannot read.
    const blob = store.blob() as { entries: Record<string, unknown>; stamp: string };
    const newer = { peerId: PEER, effectId: EFFECT, baseSha: BASE, appliedAt: 1, label: canon(PEER, EFFECT), v2: { rebasedOnto: BASE2 } };
    blob.entries[key] = newer;
    blob.stamp = 'written-by-a-newer-build';
    store.data.set(STORE_KEY, blob);

    const q = quiet();
    // It is still a consumed effect, and this build cannot say at which base.
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
    // And the next write must not replace the newer row with the older shape:
    // the consumption would survive, but the newer build's own record would
    // not, which is the narrow case the retain-verbatim machinery exists for.
    await l.record(labelled(l, PEER, 'e_other'));
    q.restore();
    expect(store.rows()[key]).toEqual(newer);
  });

  it('never drops a sibling row written by another window between load and write', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const foreignKey = `${OTHER_PEER}|e_sibling`;
    // Inject the other window's row only once this ledger has read AND has
    // already run its own pre-record refresh (get 1 = construction, get 2 =
    // record's refresh), so nothing but the pre-WRITE re-merge can preserve it.
    store.onGet = (n) => {
      if (n < 3) { return; }
      const blob = (store.data.get(STORE_KEY) ?? { entries: {} }) as { entries: Record<string, unknown> };
      blob.entries[foreignKey] = {
        peerId: OTHER_PEER, effectId: 'e_sibling', baseSha: BASE2, appliedAt: 10, label: canon(OTHER_PEER, 'e_sibling'),
      };
      store.data.set(STORE_KEY, blob);
    };
    await l.record(labelled(l));
    expect(store.rows()[foreignKey]).toBeTruthy();
    expect(store.rows()[`${PEER}|${EFFECT}`]).toBeTruthy();
  });

  it('treats two disagreeing rows for one key as a fault, not as a merge', async () => {
    const store = new FakeStore();
    store.failWrite = new Error('globalState is full');
    const l = ledger(store, () => 5_000);
    // The row exists in memory but never reached the store.
    await expect(l.record(labelled(l))).rejects.toThrow();
    store.failWrite = null;

    // Another window records the SAME effect at a different base, with the
    // appliedAt 0 a clamped (NaN, negative or throwing) clock produces. A
    // merge that picked the earlier timestamp would hand the checkpoint a
    // human is looking at to whichever window has the most broken clock.
    store.seed({ [`${PEER}|${EFFECT}`]: row(PEER, EFFECT, { baseSha: BASE2, appliedAt: 0 }) }, { stamp: 'other-window' });

    const q = quiet();
    const d = l.check(PEER, EFFECT, BASE);
    q.restore();
    expect(d).toMatchObject({ ok: false, reason: 'base-drift' });
    expect(d.ok === false && d.detail).toContain('disagreeing');
    // First consumption wins: the row this window recorded is untouched.
    expect(l.entriesFor(PEER)[0].baseSha).toBe(BASE);
    expect(l.entriesFor(PEER)[0].appliedAt).toBe(5_000);
  });

  it('keeps the earliest timestamp when two windows agree on the row', async () => {
    const store = new FakeStore();
    store.failWrite = new Error('nope');
    const l = ledger(store, () => 9_000);
    await expect(l.record(labelled(l))).rejects.toThrow();
    store.failWrite = null;
    store.seed({ [`${PEER}|${EFFECT}`]: row(PEER, EFFECT, { appliedAt: 42 }) }, { stamp: 'other-window' });
    expect(l.entriesFor(PEER)[0].appliedAt).toBe(42);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
  });
});

describe('DeskLedger -- a write is never made from a partial map', () => {
  it('REJECTS when the store write fails', async () => {
    const store = new FakeStore();
    store.failWrite = new Error('globalState is full');
    const l = ledger(store);
    // Resolving here is the worst outcome available: the caller believes the
    // effect is consumed, the next restart disagrees, and the patch lands a
    // second time over whatever the human did in between.
    await expect(l.record(labelled(l))).rejects.toThrow('globalState is full');
  });

  it('keeps the in-memory row after a failed write -- the stricter of the two states', async () => {
    const store = new FakeStore();
    store.failWrite = new Error('nope');
    const l = ledger(store);
    await expect(l.record(labelled(l))).rejects.toThrow();
    expect(l.check(PEER, EFFECT, BASE).ok).toBe(false);
  });

  it('a failed write does not poison later writes', async () => {
    const store = new FakeStore();
    store.failWrite = new Error('transient');
    const l = ledger(store);
    await expect(l.record(labelled(l))).rejects.toThrow();
    store.failWrite = null;
    await l.record(labelled(l, PEER, 'e_second'));
    expect(Object.keys(store.rows())).toContain(`${PEER}|e_second`);
  });

  it('does NOT erase the stored rows when its own read is wedged', async () => {
    const store = new FakeStore();
    const first = ledger(store);
    await first.record(labelled(first, PEER, 'e_first'));
    await first.record(labelled(first, PEER, 'e_second'));

    const q = quiet();
    // A fresh window (empty memory) whose store read fails. The write here is
    // a FULL REPLACEMENT, so persisting from memory would not degrade the
    // ledger, it would delete both consumed effects and hand back every replay
    // they refused.
    store.readThrows = true;
    const wedged = ledger(store);
    await expect(wedged.record(labelled(wedged, PEER, 'e_third'))).rejects.toThrow(/could not be read/);
    store.readThrows = false;
    q.restore();

    expect(Object.keys(store.rows()).sort()).toEqual([`${PEER}|e_first`, `${PEER}|e_second`]);
    const reloaded = ledger(store);
    expect(reloaded.check(PEER, 'e_first', BASE)).toMatchObject({ ok: false, reason: 'replayed' });
    expect(reloaded.check(PEER, 'e_second', BASE)).toMatchObject({ ok: false, reason: 'replayed' });
    // And the effect whose record was refused was never applied, so the wedged
    // window must not be left holding a row that blocks it forever.
    expect(wedged.check(PEER, 'e_third', BASE)).toEqual({ ok: true });
  });

  it('refuses to write while the read is wedged even when memory is complete', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l, PEER, 'e_first'));
    const q = quiet();
    store.readThrows = true;
    const writesBefore = store.writes;
    await expect(l.record(labelled(l, PEER, 'e_second'))).rejects.toThrow();
    q.restore();
    expect(store.writes).toBe(writesBefore);
  });

  it('refuses the WRITE when the read fails after record has already checked', async () => {
    const store = new FakeStore();
    const first = ledger(store);
    await first.record(labelled(first, PEER, 'e_first'));

    const l = ledger(store);                       // get 1 = construction
    // Wedge the read from get 3 on: get 2 is record's own pre-check, get 3 is
    // the re-read inside the write step. The row is already in memory by then,
    // so only the WRITE path can still refuse -- and it must, because this
    // write replaces the whole blob with what one instance happens to hold.
    store.onGet = (n) => { if (n >= 2) { store.readThrows = true; } };
    const q = quiet();
    const writesBefore = store.writes;
    await expect(l.record(labelled(l, PEER, 'e_second'))).rejects.toThrow(/refusing to write/);
    q.restore();

    expect(store.writes).toBe(writesBefore);
    expect(Object.keys(store.rows())).toEqual([`${PEER}|e_first`]);
  });

  it('recovers once the store can be read again', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    const q = quiet();
    store.readThrows = true;
    await expect(l.record(labelled(l))).rejects.toThrow();
    expect(l.check(PEER, 'e_other', BASE).ok).toBe(false);
    store.readThrows = false;
    q.restore();
    // A transient hiccup must not brick every handoff on the machine forever.
    expect(l.check(PEER, 'e_other', BASE)).toEqual({ ok: true });
    await l.record(labelled(l, PEER, 'e_other'));
    expect(Object.keys(store.rows())).toContain(`${PEER}|e_other`);
  });
});

describe('DeskLedger -- an unreadable store proves nothing, so it admits nothing', () => {
  it('refuses a NEVER-SEEN effect when the store read explodes', async () => {
    const store = new FakeStore();
    const first = ledger(store);
    await first.record(labelled(first));

    const q = quiet();
    store.readThrows = true;
    // A fresh window after a restart holds nothing in memory. Answering
    // "fresh" here is the double-apply, with the row sitting in the store the
    // whole time saying otherwise.
    const restarted = ledger(store);
    expect(() => restarted.check(PEER, EFFECT, BASE)).not.toThrow();
    expect(restarted.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
    expect(restarted.check(PEER, 'e_never_seen', BASE).ok).toBe(false);
    q.restore();
  });

  it('does not throw out of the constructor when the read explodes', () => {
    const store = new FakeStore();
    store.readThrows = true;
    const q = quiet();
    expect(() => ledger(store)).not.toThrow();
    q.restore();
  });

  it('does not let a throw from MERGING the blob escape the read path', () => {
    // Object.entries on this blob throws; the documented failure mode is a
    // loud log and a refusal, not a throw out of the constructor, out of
    // check(), and out of every caller above them.
    const hostile = { v: 1, entries: new Proxy({}, { ownKeys() { throw new Error('boom'); } }) };
    const store = new RawStore(hostile);
    const q = quiet();
    let l: DeskLedger | undefined;
    expect(() => { l = ledger(store); }).not.toThrow();
    expect(l!.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
    expect(() => l!.entriesFor(PEER)).not.toThrow();
    q.restore();
  });
});

describe('DeskLedger -- an unrecognised blob is quarantined, not overwritten', () => {
  const key = `${PEER}|${EFFECT}`;

  const shapes: [string, unknown][] = [
    ['a newer version', { v: 2, entries: { [key]: row(PEER, EFFECT) } }],
    ['an unknown top-level field', { v: 1, entries: { [key]: row(PEER, EFFECT) }, rows: { alpha: 1 } }],
    ['an opaque entries encoding', { v: 1, entries: 'opaque-v3-encoding' }],
    ['entries as a number', { v: 1, entries: 42 }],
    ['entries as an array', { entries: [] }],
    ['entries missing', { nope: 1 }],
    ['a string blob', 'not an object'],
    ['an array blob', []],
  ];

  for (const [name, blob] of shapes) {
    it(`refuses every check over ${name}, and never writes over it`, async () => {
      const store = new FakeStore();
      store.data.set(STORE_KEY, blob);
      const before = JSON.stringify(store.data.get(STORE_KEY));
      const q = quiet();

      expect(() => ledger(store)).not.toThrow();
      const l = ledger(store);
      // Reading the rows inside as absent is the replay; overwriting the blob
      // is the permanent erasure. Both are refusals here.
      expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
      expect(l.check(OTHER_PEER, 'e_new', BASE).ok).toBe(false);
      await expect(l.record(labelled(l, OTHER_PEER, 'e_new'))).rejects.toThrow(/does not recognise/);
      q.restore();

      expect(store.writes).toBe(0);
      expect(JSON.stringify(store.data.get(STORE_KEY))).toBe(before);
    });
  }

  it('treats an absent or cleared blob as an EMPTY ledger, not an unreadable one', async () => {
    const absent = new FakeStore();
    expect(ledger(absent).check(PEER, EFFECT, BASE)).toEqual({ ok: true });

    const cleared = new FakeStore();
    cleared.data.set(STORE_KEY, null);
    const l = ledger(cleared);
    // A machine that has simply never applied a handoff must not be bricked.
    expect(l.check(PEER, EFFECT, BASE)).toEqual({ ok: true });
    await l.record(labelled(l));
    expect(Object.keys(cleared.rows())).toContain(`${PEER}|${EFFECT}`);
  });

  it('writes a versioned blob so a future build can recognise this one', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    const blob = store.blob();
    expect(blob.v).toBe(1);
    expect(typeof blob.stamp).toBe('string');
    expect(Object.keys(blob).sort()).toEqual(['entries', 'stamp', 'v']);
  });
});

describe('DeskLedger -- unreadable rows are bounded but never dropped', () => {
  function junk(count: number, size = 8): Record<string, unknown> {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      entries[`${OTHER_PEER}|e_junk${i}`] = { shape: 'x'.repeat(size), n: i };
    }
    return entries;
  }

  it('carries a reasonable number of them and still works', async () => {
    const store = new FakeStore();
    store.seed(junk(20));
    const l = ledger(store);
    await l.record(labelled(l));
    expect(Object.keys(store.rows())).toHaveLength(21);
  });

  it('refuses -- rather than dropping -- once there are more than it will carry', async () => {
    const store = new FakeStore();
    store.seed(junk(1_001));
    const q = quiet();
    const l = ledger(store);
    // Dropping them is the replay hole; growing without bound is the
    // exhaustion primitive. Refusing is the only option that is neither, so
    // both the gate and the write refuse and every junk row stays put.
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
    await expect(l.record(labelled(l))).rejects.toThrow(/unreadable rows/);
    q.restore();
    expect(store.writes).toBe(0);
    expect(Object.keys(store.rows())).toHaveLength(1_001);
  });

  it('refuses once they are larger than it will carry, however few', async () => {
    const store = new FakeStore();
    store.seed(junk(10, 40_000));
    const q = quiet();
    const l = ledger(store);
    expect(l.check(PEER, EFFECT, BASE).ok).toBe(false);
    await expect(l.record(labelled(l))).rejects.toThrow(/unreadable rows/);
    q.restore();
    expect(store.writes).toBe(0);
  });
});

describe('DeskLedger -- cross-window reads stay honest', () => {
  it('two windows each see the other rows after writing their own', async () => {
    const store = new FakeStore();
    const w1 = ledger(store);
    const w2 = ledger(store);
    await w1.record(labelled(w1, PEER, 'e_one'));
    await w2.record(labelled(w2, PEER, 'e_two'));

    // Any cheap "has the blob changed?" token that two windows can both mint
    // (a counter, a length, a row count) collides here: w2 writes the token w1
    // last wrote, w1 skips the merge, and the effect w2 consumed is admitted a
    // second time. The token must be unguessable by another window.
    expect(w1.check(PEER, 'e_two', BASE)).toMatchObject({ ok: false, reason: 'replayed' });
    expect(w2.check(PEER, 'e_one', BASE)).toMatchObject({ ok: false, reason: 'replayed' });
    expect(Object.keys(store.rows()).sort()).toEqual([`${PEER}|e_one`, `${PEER}|e_two`]);
  });

  it('entriesFor re-reads too, so a roster is never stale', async () => {
    const store = new FakeStore();
    const reader = ledger(store);
    const writer = ledger(store);
    await writer.record(labelled(writer));
    // A stale roster is how a human ends up rewinding a checkpoint that is
    // not the one the list showed them.
    expect(reader.entriesFor(PEER).map(r => r.effectId)).toEqual([EFFECT]);
  });

  it('picks up a row written under a NEW stamp after it has already merged', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    store.seed(
      { ...store.rows(), [`${PEER}|e_later`]: row(PEER, 'e_later') },
      { stamp: 'a-later-write' },
    );
    expect(l.check(PEER, 'e_later', BASE)).toMatchObject({ ok: false, reason: 'replayed' });
  });
});

describe('DeskLedger -- stored rows are validated, not trusted', () => {
  const key = `${PEER}|${EFFECT}`;

  it('drops rows whose key does not follow from their own fields', () => {
    const store = new FakeStore();
    // A hand-edited or corrupted key. Re-keying it would silently merge two
    // rows into one and lose a consumed effect.
    store.seed({ 'wrong|key': row(PEER, EFFECT) });
    const l = ledger(store);
    expect(l.entriesFor(PEER)).toHaveLength(0);
  });

  it('holds a stored row whose own fields are malformed as unreadable, not as absent', () => {
    const store = new FakeStore();
    store.seed({ [key]: row(PEER, EFFECT, { baseSha: 'A'.repeat(40) }) });
    const l = ledger(store);
    expect(l.entriesFor(PEER)).toHaveLength(0);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
  });

  it.each([
    ['null (what a NaN becomes through JSON)', null],
    ['a string', '1700000000000'],
    ['negative', -1],
    ['missing', undefined],
  ])('holds a row whose appliedAt is %s as unreadable', (_name, appliedAt) => {
    const store = new FakeStore();
    store.seed({ [key]: row(PEER, EFFECT, { appliedAt }) });
    const l = ledger(store);
    // This is the guard the clock clamp exists to satisfy: a row that fails
    // reload validation is a consumed effect this machine has FORGOTTEN, so
    // it must be held as unreadable rather than parsed or discarded.
    expect(l.entriesFor(PEER)).toHaveLength(0);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
  });

  it('holds a row whose label drops the peer half as unreadable', () => {
    const store = new FakeStore();
    store.seed({ [key]: row(PEER, EFFECT, { label: `undo handoff ${EFFECT}` }) });
    const l = ledger(store);
    expect(l.entriesFor(PEER)).toHaveLength(0);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
  });

  it('refuses a row whose VALUE is not a plain object, even one carrying row fields', () => {
    // An array with the right properties passes every field validator. Only
    // the structural guard stops it from becoming a row, and the store
    // contract does not promise a JSON round-trip that would flatten it.
    // Empty, so its only own enumerable keys ARE the row fields: no other
    // guard can catch this one on the way past.
    const arrayRow = Object.assign([] as unknown[], row(PEER, EFFECT));
    const store = new RawStore({ v: 1, entries: { [key]: arrayRow } });
    const l = ledger(store);
    expect(l.entriesFor(PEER)).toHaveLength(0);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
  });

  it.each([
    ['a number', 42],
    ['a string', 'consumed'],
    ['null', null],
    ['an array', []],
  ])('holds a row whose value is %s as unreadable', (_name, value) => {
    const store = new FakeStore();
    store.seed({ [key]: value });
    const l = ledger(store);
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
  });

  it('holds a row carrying a field this build does not know as unreadable, verbatim', async () => {
    const store = new FakeStore();
    const newer = row(PEER, EFFECT, { rebasedOnto: BASE2 });
    store.seed({ [key]: newer });
    const l = ledger(store);
    // Parsing it would read fine and then silently TRIM `rebasedOnto` on the
    // next write, so the newer build's own record of what it did is gone while
    // the consumption survives. Held verbatim and routed to a human instead.
    expect(l.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'base-drift' });
    await l.record(labelled(l, PEER, 'e_other'));
    expect(store.rows()[key]).toEqual(newer);
  });

  it('does not pollute Object.prototype from a hostile stored key', () => {
    const store = new FakeStore();
    store.seed(JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"polluted": true}}'));
    const l = ledger(store);
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined();
    expect(l.entriesFor(PEER)).toHaveLength(0);
  });

  it('never writes a dangerous key back into the store', async () => {
    const store = new FakeStore();
    store.seed(JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}'));
    const l = ledger(store);
    await l.record(labelled(l));
    // Round-tripping a `__proto__` row keeps a live prototype-shaped key in
    // persisted state for every later reader of this blob to trip over.
    const persisted = store.rows();
    expect(Object.prototype.hasOwnProperty.call(persisted, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(persisted, 'constructor')).toBe(false);
  });

  it('freezes every row it holds, whether recorded here or loaded from the store', async () => {
    const store = new FakeStore();
    const l = ledger(store);
    await l.record(labelled(l));
    const held = internalEntries(l).get(key)!;
    expect(Object.isFrozen(held)).toBe(true);
    expect(() => { (held as unknown as { baseSha: string }).baseSha = BASE2; }).toThrow();

    const reloaded = ledger(store);
    expect(Object.isFrozen(internalEntries(reloaded).get(key)!)).toBe(true);
  });
});

describe('DeskLedger -- the clock cannot break the ledger', () => {
  it('clamps a NaN clock so the row survives JSON serialisation', async () => {
    const store = new FakeStore();
    const l = ledger(store, () => NaN);
    await l.record(labelled(l));
    // NaN would serialise to null through globalState, fail the reload
    // validation, and take a CONSUMED EFFECT with it -- the replay is then
    // free on the next restart.
    const reloaded = ledger(store);
    expect(reloaded.check(PEER, EFFECT, BASE)).toMatchObject({ ok: false, reason: 'replayed' });
    expect(reloaded.entriesFor(PEER)[0].appliedAt).toBe(0);
  });

  it('clamps a negative clock', async () => {
    const store = new FakeStore();
    const negative = ledger(store, () => -5);
    await negative.record(labelled(negative));
    expect(negative.entriesFor(PEER)[0].appliedAt).toBe(0);
  });

  it('clamps to 0 -- not to a real clock -- when the clock THROWS', async () => {
    const store = new FakeStore();
    const q = quiet();
    const throwing = ledger(store, () => { throw new Error('no clock'); });
    await throwing.record(labelled(throwing));
    q.restore();
    // Falling back to Date.now() here would be a second clock the caller never
    // asked for, and would make the "clocks clamp to 0" claim untrue in the
    // one case where the injected clock is provably unusable.
    expect(throwing.entriesFor(PEER)[0].appliedAt).toBe(0);
    expect(ledger(store).check(PEER, EFFECT, BASE).ok).toBe(false);
  });

  it('falls back to a real clock when now is an explicit undefined or a non-function', async () => {
    const store = new FakeStore();
    // A config read of an unset key hands you undefined; a constructor that
    // trusted it would throw at the first call, or worse, record undefined.
    const l = new DeskLedger(store, undefined);
    await l.record(labelled(l));
    expect(l.entriesFor(PEER)[0].appliedAt).toBeGreaterThan(0);

    const store2 = new FakeStore();
    const bad = new DeskLedger(store2, 42 as unknown as () => number);
    await bad.record(labelled(bad));
    expect(bad.entriesFor(PEER)[0].appliedAt).toBeGreaterThan(0);
  });
});

describe('DeskLedger -- entriesFor', () => {
  it('returns one peer rows, oldest first, and never the internal objects', async () => {
    const store = new FakeStore();
    let clock = 100;
    const l = ledger(store, () => clock);
    await l.record(labelled(l, PEER, 'e_b'));
    clock = 50;
    await l.record(labelled(l, PEER, 'e_a'));
    clock = 200;
    await l.record(labelled(l, OTHER_PEER, 'e_c'));

    const rows = l.entriesFor(PEER);
    expect(rows.map(r => r.effectId)).toEqual(['e_a', 'e_b']);

    // Copies, and frozen copies: a caller that mutates what it was handed
    // finds out loudly rather than silently editing a consumed-effect record.
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(() => { (rows[0] as unknown as { baseSha: string }).baseSha = BASE2; }).toThrow();
    rows.length = 0;
    expect(l.entriesFor(PEER)[0].baseSha).toBe(BASE);
    expect(l.entriesFor(PEER)).toHaveLength(2);
  });

  it('breaks appliedAt ties deterministically', async () => {
    const store = new FakeStore();
    const l = ledger(store, () => 7);
    await l.record(labelled(l, PEER, 'e_z'));
    await l.record(labelled(l, PEER, 'e_a'));
    expect(l.entriesFor(PEER).map(r => r.effectId)).toEqual(['e_a', 'e_z']);
  });

  it('returns empty for a malformed peerId rather than throwing (it is not the gate)', () => {
    const l = ledger(new FakeStore());
    expect(l.entriesFor('bad peer')).toEqual([]);
  });
});
