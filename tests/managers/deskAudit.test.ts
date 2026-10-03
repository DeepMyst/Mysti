/**
 * DeskAudit tests (Plan 21, invariant I22).
 *
 * The properties under test are the ones an attacker would attack:
 *   - split retention — an effect-bearing row can never be aged out, capped
 *     out, or crowded out by a flood of `status` polls;
 *   - fail-closed classification — an unrecognised verb or kind is RETAINED,
 *     so a peer cannot erase its trail by sending something we do not parse;
 *   - retention is decided by what the CALLER ASSERTED, never by what survived
 *     sanitizing: a path that scrubs to nothing and a bytesOut that clamps to
 *     zero must not be able to change a row's retention class;
 *   - the retained class is BOUNDED, so an unrecognised verb is not a remote
 *     storage-exhaustion primitive, and an eviction is recorded in the trail;
 *   - no row is ever lost to hostile input, and no row is ever mutated after
 *     it is written;
 *   - the export is byte-stable, and its header never names a chain other than
 *     the one that was actually queried.
 *
 * Every security-relevant branch has a test here that goes red if the branch
 * is deleted. Where a test's name states an invariant, the test asserts that
 * invariant and not merely a side effect of it — several tests in the first
 * version of this file asserted a sanitized VALUE while their names claimed to
 * guard a RETENTION property, and the retention property was in fact broken.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeskAudit,
  DESK_AUDIT_KEY,
  AUDIT_RETENTION_MS,
  AUDIT_MAX_VOLATILE_ROWS,
  AUDIT_MAX_ROWS,
  AUDIT_INTEGRITY_ORIGIN,
  PRUNABLE_VERBS,
  isVolatile,
  isPermanent,
} from '../../src/managers/DeskAudit';
import type { AuditRecord, AuditRow, AuditStore } from '../../src/managers/DeskAudit';
import { DESK_VERB_NAMES } from '../../src/services/desk/DeskContract';

const NOW = 1_800_000_000_000;

class MemStore implements AuditStore {
  data = new Map<string, unknown>();
  writes = 0;
  failWrites = false;
  throwOnRead = false;

  get<T>(key: string): T | undefined {
    if (this.throwOnRead) { throw new Error('memento exploded'); }
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.writes++;
    if (this.failWrites) { throw new Error('disk full'); }
    // Round-trip through JSON the way globalState does, so a test that passes
    // here cannot be relying on shared object identity with the live rows.
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

function makeAudit(store = new MemStore(), now = () => NOW): { audit: DeskAudit; store: MemStore } {
  return { audit: new DeskAudit(store, now), store };
}

/** Seed the store directly, bypassing record(), so `at` can be chosen. */
async function seedStore(store: MemStore, rows: Partial<AuditRow>[]): Promise<DeskAudit> {
  await store.update(DESK_AUDIT_KEY, rows);
  store.writes = 0;
  return new DeskAudit(store, () => NOW);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('mintOriginId', () => {
  it('is unique, prefixed, and matches the id charset the CLI flag accepts', () => {
    const { audit } = makeAudit();
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) { ids.add(audit.mintOriginId()); }
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(id.startsWith('o_')).toBe(true);
      expect(/^[A-Za-z0-9_.:-]{1,64}$/.test(id)).toBe(true);
    }
  });

  it('carries the UUIDv4 version and variant bits — a PRNG substitute fails here', () => {
    // Uniqueness and charset are satisfied by any hex generator, so the first
    // version of this test could not tell crypto.randomUUID from
    // Math.random().toString(16). The v4 shape can: nibble 13 is '4' and
    // nibble 17 is one of 8/9/a/b. Over 500 ids a generator that does not
    // produce them fails with probability ~1.
    const { audit } = makeAudit();
    const v4 = /^o_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
    for (let i = 0; i < 500; i++) {
      expect(audit.mintOriginId()).toMatch(v4);
    }
  });

  it('actually calls crypto.randomUUID', async () => {
    // The shape test above is statistical; this one is structural.
    vi.resetModules();
    let calls = 0;
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return { ...actual, randomUUID: () => { calls++; return actual.randomUUID(); } };
    });
    try {
      const mod = await import('../../src/managers/DeskAudit');
      const audit = new mod.DeskAudit(new MemStore(), () => NOW);
      const id = audit.mintOriginId();
      expect(calls).toBe(1);
      expect(id).toMatch(/^o_[0-9a-f]{32}$/);
    } finally {
      vi.doUnmock('crypto');
      vi.resetModules();
    }
  });
});

describe('record + chain', () => {
  it('reconstructs one causal chain in recorded order and excludes other chains', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p_alice', verb: 'consult' });
    await audit.record({ originId: 'o_b', kind: 'inbound', peerId: 'p_bob', verb: 'status' });
    await audit.record({ originId: 'o_a', kind: 'permission', peerId: 'p_alice', verb: 'consult' });
    await audit.record({ originId: 'o_a', kind: 'effect', peerId: 'p_alice', verb: 'handoff', effect: { paths: ['src/a.ts'] } });

    const chain = audit.chain('o_a');
    expect(chain.map(r => r.kind)).toEqual(['inbound', 'permission', 'effect']);
    expect(chain.every(r => r.originId === 'o_a')).toBe(true);
    expect(audit.chain('o_b')).toHaveLength(1);
    expect(audit.chain('o_missing')).toEqual([]);
  });

  it('refuses an out-of-charset chain query instead of filtering on it', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status' });
    // Every stored originId matched ORIGIN_RE at write time, so a query that
    // does not is unanswerable rather than merely empty. Saying so here is
    // what stops exportChain naming a chain it did not query.
    expect(audit.chain('o_a\u202Eevil')).toEqual([]);
    expect(audit.chain('o_a' + 'z'.repeat(200))).toEqual([]);
    expect(audit.chain(42 as unknown as string)).toEqual([]);
  });

  it('keeps recorded order even when the clock steps backwards', async () => {
    let t = NOW;
    const { audit } = makeAudit(new MemStore(), () => t);
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'consult', detail: 'first' });
    t = NOW - 60_000; // NTP correction mid-chain
    await audit.record({ originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff', detail: 'second', effect: { bytesOut: 10 } });

    expect(audit.chain('o_a').map(r => r.detail)).toEqual(['first', 'second']);
  });

  it('stamps `at` from the local clock, not from anything the caller passes', async () => {
    const { audit } = makeAudit();
    // A peer-supplied `at` is not even in the parameter type; force one through.
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status', at: 1 } as unknown as AuditRecord);
    expect(audit.all()[0].at).toBe(NOW);
  });

  it('falls back to a real clock when the injected one returns garbage', async () => {
    // A NaN `at` is the fail-OPEN direction: `now - NaN <= RETENTION` is false,
    // so prune() would DELETE every volatile row the moment the clock went bad.
    const { audit } = makeAudit(new MemStore(), () => NaN);
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status' });
    const at = audit.all()[0].at;
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThan(0);
    expect(await audit.prune()).toBe(0);
  });

  it('returns a defensive copy from all() — pushing into it does not extend the trail', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status' });
    const rows = audit.all();
    rows.push({ originId: 'o_evil', kind: 'inbound', at: NOW, peerId: 'x', verb: 'status' });
    expect(audit.all()).toHaveLength(1);
  });

  it('writes exactly once per record, with or without a cap enforcement', async () => {
    // The overflow path used to `return` after delegating to prune(), which
    // persisted only when prune() happened to drop something. One write per
    // record is the durability contract for the row just appended.
    const store = new MemStore();
    const audit = new DeskAudit(store, () => NOW);
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status' });
    expect(store.writes).toBe(1);
    expect(store.get<AuditRow[]>(DESK_AUDIT_KEY)).toHaveLength(1);
  });
});

describe('immutability — a row is never mutated after write', () => {
  it('freezes the row, its effect block and its paths array', async () => {
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff',
      effect: { paths: ['src/a.ts'], bytesOut: 12, sha256: 'a'.repeat(64) },
    });
    const row = audit.all()[0];

    expect(() => { (row as { detail?: string }).detail = 'tampered'; }).toThrow();
    expect(() => { (row.effect as { bytesOut?: number }).bytesOut = 0; }).toThrow();
    expect(() => { (row.effect!.paths as string[]).push('etc/passwd'); }).toThrow();

    expect(row.detail).toBeUndefined();
    expect(row.effect!.bytesOut).toBe(12);
    expect(row.effect!.paths).toEqual(['src/a.ts']);
  });

  it('copies the caller object — record() neither writes to it nor keeps it', async () => {
    const { audit } = makeAudit();
    const input = {
      originId: 'o_a', kind: 'effect' as const, peerId: 'p', verb: 'handoff',
      effect: { paths: ['src/a.ts'] },
      detail: 'wrote one file',
    };
    await audit.record(input);

    // The copy at record() is what this test is named for, so assert it
    // directly: stamping `at` into the caller's object would be a visible
    // mutation of someone else's data, and the rebuilt row must not be the
    // caller's object or share its effect block.
    expect('at' in input).toBe(false);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.effect)).toBe(false);
    const row = audit.all()[0];
    expect(row as unknown).not.toBe(input);
    expect(row.effect as unknown).not.toBe(input.effect);

    // And history does not move when the caller mutates afterwards.
    input.detail = 'wrote nothing';
    input.effect.paths.push('src/secret.ts');
    expect(row.detail).toBe('wrote one file');
    expect(row.effect!.paths).toEqual(['src/a.ts']);
  });
});

describe('retention class is decided by what the CALLER asserted (I22)', () => {
  const OLD_AT = NOW - AUDIT_RETENTION_MS - 1;

  it('keeps an effect row permanent when every path scrubs away to nothing', async () => {
    // The hole this closes: `.filter(p => p.length > 0)` emptied the path list,
    // which emptied the effect block, which made hasEffect() false, which made
    // the row VOLATILE — a peer-controlled string deciding whether the row it
    // appears in is append-only.
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'locate',
      effect: { paths: ['\u202E\u200E', '\u0007'] },
    });
    const row = audit.all()[0];
    expect(row.effect!.paths).toEqual(['<unprintable>', '<unprintable>']);
    expect(row.effectAsserted).toBe(true);
    expect(isVolatile(row)).toBe(false);
    expect(isPermanent(row)).toBe(true);
  });

  it('never ages out or caps out a row whose paths all scrubbed away', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, [
      { originId: 'o_a', kind: 'inbound', at: OLD_AT, peerId: 'p', verb: 'locate', effect: { paths: ['\u202E'] } },
    ]);
    expect(await audit.prune()).toBe(0);
    expect(audit.all()).toHaveLength(1);
    expect(audit.all()[0].effectAsserted).toBe(true);
  });

  it('keeps the egress fact when bytesOut clamps to zero, and keeps the row', async () => {
    // -4096 and 0.9 both clamp to 0, and `(bytesOut ?? 0) > 0` then made the
    // row volatile: the clamp was silently changing the retention class. The
    // VALUE may round; the FACT that bytes left may not.
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'status', effect: { bytesOut: -4096 } });
    await audit.record({ originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'status', effect: { bytesOut: 0.9 } });
    const [neg, frac] = audit.all();

    expect(neg.effect!.bytesOut).toBe(0);
    expect(frac.effect!.bytesOut).toBe(0);
    for (const row of [neg, frac]) {
      expect(row.effectAsserted).toBe(true);
      expect(isVolatile(row)).toBe(false);
      expect(isPermanent(row)).toBe(true);
    }
  });

  it('survives the round trip: a clamped-to-zero egress row is still permanent after a reload', async () => {
    const store = new MemStore();
    const first = new DeskAudit(store, () => NOW);
    await first.record({ originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'status', effect: { bytesOut: -4096 } });
    // Re-date it beyond the retention window and reload from the store.
    const persisted = (store.get<AuditRow[]>(DESK_AUDIT_KEY) ?? []).map(r => ({ ...r, at: OLD_AT }));
    const second = await seedStore(store, persisted);
    expect(second.all()[0].effectAsserted).toBe(true);
    expect(await second.prune()).toBe(0);
  });

  it('treats a literal bytesOut of 0 as no egress — an honest zero is not an effect', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'status', effect: { bytesOut: 0 } });
    const row = audit.all()[0];
    expect(row.effectAsserted).toBeUndefined();
    expect(isVolatile(row)).toBe(true);
  });

  it('retains a row whose effect block is a shape we do not recognise', async () => {
    // An array carrying effect-looking properties is exactly what the
    // `Array.isArray(raw)` half of the guard exists for: without it, those
    // properties are read straight off the array. With it, the block is
    // unparseable — and unparseable means RETAIN, not "no effect".
    const { audit } = makeAudit();
    const arrayish = Object.assign([] as unknown[], { bytesOut: 4096, sha256: 'a'.repeat(64) });
    await audit.record({
      originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status',
      effect: arrayish as unknown as AuditRow['effect'],
    });
    await audit.record({
      originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status',
      effect: 'not an object' as unknown as AuditRow['effect'],
    });
    for (const row of audit.all()) {
      expect(row.effect).toBeUndefined();
      expect(row.effectAsserted).toBe(true);
      expect(isVolatile(row)).toBe(false);
    }
  });

  it('keeps a row whose sha256 was malformed — the digest was still asserted', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'locate', effect: { sha256: 'nope' } });
    const row = audit.all()[0];
    expect(row.effect).toBeUndefined();
    expect(row.effectAsserted).toBe(true);
    expect(isVolatile(row)).toBe(false);
  });

  it('does not let a caller hand itself a retention class', async () => {
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status',
      effectAsserted: true, integrity: true, evicted: 99,
    } as unknown as AuditRecord);
    const row = audit.all()[0];
    expect(row.effectAsserted).toBeUndefined();
    expect(row.integrity).toBeUndefined();
    expect(row.evicted).toBeUndefined();
    expect(isVolatile(row)).toBe(true);
  });
});

describe('prune — split retention (I22)', () => {
  const OLD = NOW - AUDIT_RETENTION_MS - 1;

  async function seedOld(audit: DeskAudit, rows: AuditRecord[], store: MemStore): Promise<DeskAudit> {
    for (const r of rows) { await audit.record(r); }
    // Re-date every seeded row to beyond the retention window by rewriting the
    // store and reloading — record() will not accept a caller timestamp.
    const persisted = (store.get<AuditRow[]>(DESK_AUDIT_KEY) ?? []).map(r => ({ ...r, at: OLD }));
    return seedStore(store, persisted);
  }

  it('drops aged-out read-only rows and keeps every effect-bearing row', async () => {
    const store = new MemStore();
    let { audit } = makeAudit(store);
    audit = await seedOld(audit, [
      { originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status' },
      { originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'locate' },
      { originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'hello' },
      { originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'status', effect: { bytesOut: 4096 } },
      { originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff', effect: { paths: ['src/a.ts'] } },
      { originId: 'o_a', kind: 'permission', peerId: 'p', verb: 'assign' },
      { originId: 'o_a', kind: 'refusal', peerId: 'p', verb: 'consult' },
    ], store);

    const dropped = await audit.prune();
    expect(dropped).toBe(3);
    expect(audit.all().map(r => `${r.kind}:${r.verb}`)).toEqual([
      'outbound:status', 'effect:handoff', 'permission:assign', 'refusal:consult',
    ]);
  });

  it('keeps a read-only row that carries a sha — the digest proves an effect', async () => {
    const store = new MemStore();
    let { audit } = makeAudit(store);
    audit = await seedOld(audit, [
      { originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'locate', effect: { sha256: 'b'.repeat(64) } },
    ], store);
    expect(await audit.prune()).toBe(0);
    expect(audit.all()).toHaveLength(1);
  });

  it('retains an UNKNOWN verb — a peer cannot erase its trail by inventing one', async () => {
    const store = new MemStore();
    let { audit } = makeAudit(store);
    audit = await seedOld(audit, [
      { originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'ping' },
      { originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'STATUS' },
      { originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status ' },
      { originId: 'o_a', kind: 'inbound', peerId: 'p', verb: '' },
    ], store);
    expect(await audit.prune()).toBe(0);
    expect(audit.all()).toHaveLength(4);
  });

  it('retains an unrecognised kind — it is coerced to `refusal`, not to a read-only kind', async () => {
    const store = new MemStore();
    let { audit } = makeAudit(store);
    audit = await seedOld(audit, [
      { originId: 'o_a', kind: 'read' as unknown as AuditRow['kind'], peerId: 'p', verb: 'status' },
    ], store);
    expect(audit.all()[0].kind).toBe('refusal');
    expect(await audit.prune()).toBe(0);
  });

  it('keeps a volatile row that is exactly at the retention boundary, drops one past it', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, [
      { originId: 'o_a', kind: 'inbound', at: NOW - AUDIT_RETENTION_MS, peerId: 'p', verb: 'status', detail: 'edge' },
      { originId: 'o_a', kind: 'inbound', at: NOW - AUDIT_RETENTION_MS - 1, peerId: 'p', verb: 'status', detail: 'past' },
    ]);
    expect(await audit.prune()).toBe(1);
    expect(audit.all().map(r => r.detail)).toEqual(['edge']);
  });

  it('keeps a volatile row dated in the future (skewed clock) rather than treating it as ancient', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, [
      { originId: 'o_a', kind: 'inbound', at: NOW + 10 * AUDIT_RETENTION_MS, peerId: 'p', verb: 'status' },
    ]);
    expect(await audit.prune()).toBe(0);
  });

  it('persists the pruned array when rows were dropped', async () => {
    // The overflow path in record() delegates its ONLY persist to prune(), so
    // this is the durability path for the row that just arrived. The first
    // version of this test asserted only the negative half.
    const store = new MemStore();
    const audit = await seedStore(store, [
      { originId: 'o_a', kind: 'inbound', at: 0, peerId: 'p', verb: 'status', detail: 'ancient' },
      { originId: 'o_a', kind: 'effect', at: 0, peerId: 'p', verb: 'handoff', effect: { paths: ['a'] } },
    ]);
    expect(await audit.prune()).toBe(1);
    expect(store.writes).toBe(1);
    const persisted = store.get<AuditRow[]>(DESK_AUDIT_KEY)!;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].verb).toBe('handoff');
    // And the store now matches memory, so a crash here loses nothing.
    expect(persisted.map(r => r.verb)).toEqual(audit.all().map(r => r.verb));
  });

  it('writes nothing when nothing was dropped', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, [
      { originId: 'o_a', kind: 'effect', at: 0, peerId: 'p', verb: 'handoff', effect: { paths: ['a'] } },
    ]);
    expect(await audit.prune()).toBe(0);
    expect(store.writes).toBe(0);
  });
});

describe('volatile cap — a status flood cannot crowd out an effect row', () => {
  it('trims the oldest volatile rows only, keeping effect rows regardless of age', async () => {
    const store = new MemStore();
    const seeded: Partial<AuditRow>[] = [
      { originId: 'o_a', kind: 'effect', at: 1, peerId: 'p', verb: 'handoff', effect: { paths: ['src/first.ts'] } },
    ];
    for (let i = 0; i < AUDIT_MAX_VOLATILE_ROWS + 50; i++) {
      seeded.push({ originId: 'o_flood', kind: 'inbound', at: NOW, peerId: 'p_bob', verb: 'status', detail: `s${i}` });
    }
    const audit = await seedStore(store, seeded);
    const rows = audit.all();
    expect(rows.filter(r => isVolatile(r))).toHaveLength(AUDIT_MAX_VOLATILE_ROWS);
    // The oldest effect row — index 0, the first thing a "keep last N" would
    // have evicted — survives.
    expect(rows[0].effect!.paths).toEqual(['src/first.ts']);
    // The oldest volatile rows went, the newest stayed.
    expect(rows.some(r => r.detail === 's0')).toBe(false);
    expect(rows.some(r => r.detail === `s${AUDIT_MAX_VOLATILE_ROWS + 49}`)).toBe(true);
  });

  it('retains every permanent row even when they alone exceed every cap', async () => {
    const store = new MemStore();
    const seeded: Partial<AuditRow>[] = [];
    for (let i = 0; i < AUDIT_MAX_ROWS + 25; i++) {
      seeded.push({ originId: 'o_a', kind: 'effect', at: 1, peerId: 'p', verb: 'handoff', effect: { paths: [`f${i}.ts`] } });
    }
    const audit = await seedStore(store, seeded);
    expect(audit.all()).toHaveLength(AUDIT_MAX_ROWS + 25);
    expect(await audit.prune()).toBe(0);
  });

  it('auto-caps on volatile overflow during record(), never touching effect rows', async () => {
    // Seeded through the store rather than through 2002 record() calls: the
    // branch under test is "record() enforces the cap", which needs the array
    // at the cap plus one write. The old shape performed 2002 whole-array
    // serialisations and went intermittently over vitest's 5 s timeout, which
    // was itself the evidence for the quadratic-cost defect.
    const store = new MemStore();
    const seeded: Partial<AuditRow>[] = [
      { originId: 'o_a', kind: 'effect', at: 1, peerId: 'p', verb: 'handoff', effect: { paths: ['keep.ts'] } },
    ];
    for (let i = 0; i < AUDIT_MAX_VOLATILE_ROWS; i++) {
      seeded.push({ originId: 'o_flood', kind: 'inbound', at: NOW, peerId: 'p', verb: 'status', detail: `s${i}` });
    }
    const audit = await seedStore(store, seeded);
    expect(audit.all().filter(r => isVolatile(r))).toHaveLength(AUDIT_MAX_VOLATILE_ROWS);

    await audit.record({ originId: 'o_flood', kind: 'inbound', peerId: 'p', verb: 'status', detail: 'newest' });
    const rows = audit.all();
    expect(rows.filter(r => isVolatile(r))).toHaveLength(AUDIT_MAX_VOLATILE_ROWS);
    expect(rows.filter(r => r.kind === 'effect')).toHaveLength(1);
    expect(rows.some(r => r.detail === 's0')).toBe(false);
    expect(rows.some(r => r.detail === 'newest')).toBe(true);
    // One write for the record, and the cap enforcement rode along with it.
    expect(store.writes).toBe(1);
    expect(store.get<AuditRow[]>(DESK_AUDIT_KEY)).toHaveLength(rows.length);
  });
});

describe('total ceiling — an unrecognised verb is not a storage-exhaustion primitive', () => {
  /** `ping` is not a Desk verb, so every one of these lands in `retained`. */
  function flood(n: number, from = 0): Partial<AuditRow>[] {
    const rows: Partial<AuditRow>[] = [];
    for (let i = from; i < from + n; i++) {
      rows.push({ originId: 'o_evil', kind: 'inbound', at: NOW, peerId: 'p_evil', verb: 'ping', detail: `n${i}` });
    }
    return rows;
  }

  it('bounds retained rows at the ceiling instead of growing forever', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, flood(AUDIT_MAX_ROWS + 200));
    // The load itself enforces the ceiling, announces it and writes back.
    expect(audit.all().length).toBeLessThanOrEqual(AUDIT_MAX_ROWS + 1);
    expect(store.writes).toBe(1);
    expect(store.get<AuditRow[]>(DESK_AUDIT_KEY)).toHaveLength(audit.all().length);

    // And record() holds the line rather than letting it creep upward.
    for (let i = 0; i < 5; i++) {
      await audit.record({ originId: 'o_evil', kind: 'inbound', peerId: 'p_evil', verb: 'ping', detail: `more${i}` });
    }
    expect(audit.all().length).toBeLessThanOrEqual(AUDIT_MAX_ROWS + 1);
    expect(audit.all().some(r => r.detail === 'more4')).toBe(true);
    expect(audit.all().some(r => r.detail === 'n0')).toBe(false);
  });

  it('records the eviction in the trail itself, coalesced into one marker row', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, flood(AUDIT_MAX_ROWS + 10));
    const markers = audit.all().filter(r => r.integrity === true);
    expect(markers).toHaveLength(1);
    expect(markers[0].originId).toBe(AUDIT_INTEGRITY_ORIGIN);
    expect(markers[0].evicted).toBe(10);
    expect(markers[0].detail).toContain('audit-truncated');
    // The marker is permanent, so it cannot itself be evicted, and it stays a
    // single row however many eviction events follow.
    expect(isPermanent(markers[0])).toBe(true);
    for (let i = 0; i < 5; i++) {
      await audit.record({ originId: 'o_evil', kind: 'inbound', peerId: 'p_evil', verb: 'ping' });
    }
    const after = audit.all().filter(r => r.integrity === true);
    expect(after).toHaveLength(1);
    // 10 at load, then 2 for the first record (the marker itself occupies a
    // slot, so the array settles one row below the ceiling) and 1 for each of
    // the remaining four. The count is cumulative, not per-event.
    expect(after[0].evicted).toBe(16);
    // It survives a reload as a permanent row, count intact.
    const reloaded = new DeskAudit(store, () => NOW);
    const kept = reloaded.all().filter(r => r.integrity === true);
    expect(kept).toHaveLength(1);
    expect(kept[0].evicted).toBe(16);
  });

  it('never evicts a permanent row to make room, even when the ceiling is blown', async () => {
    const store = new MemStore();
    const seeded: Partial<AuditRow>[] = [];
    for (let i = 0; i < 100; i++) {
      seeded.push({ originId: 'o_a', kind: 'effect', at: 1, peerId: 'p', verb: 'handoff', effect: { paths: [`keep${i}.ts`] } });
    }
    seeded.push(...flood(AUDIT_MAX_ROWS + 500));
    const audit = await seedStore(store, seeded);
    expect(audit.all().filter(r => r.kind === 'effect')).toHaveLength(100);
    expect(audit.all().filter(r => r.verb === 'ping').length).toBeLessThan(AUDIT_MAX_ROWS);
  });

  it('spends volatile rows before retained ones at the ceiling', async () => {
    const store = new MemStore();
    const seeded: Partial<AuditRow>[] = [];
    for (let i = 0; i < 100; i++) {
      seeded.push({ originId: 'o_v', kind: 'inbound', at: NOW, peerId: 'p', verb: 'status', detail: `v${i}` });
    }
    seeded.push(...flood(AUDIT_MAX_ROWS));
    const audit = await seedStore(store, seeded);
    // 100 over the ceiling, and the 100 volatile rows are what paid for it.
    expect(audit.all().filter(r => r.verb === 'status')).toHaveLength(0);
    expect(audit.all().filter(r => r.verb === 'ping')).toHaveLength(AUDIT_MAX_ROWS);
    // Volatile eviction is announced policy, so it needs no marker row.
    expect(audit.all().filter(r => r.integrity === true)).toHaveLength(0);
  });
});

describe('hostile input — sanitize, never drop', () => {
  it('records the row even when every field is garbage', async () => {
    const { audit } = makeAudit();
    await audit.record({
      originId: 42 as unknown as string,
      kind: undefined as unknown as AuditRow['kind'],
      peerId: { toString: () => 'nope' } as unknown as string,
      verb: null as unknown as string,
      detail: [] as unknown as string,
    });
    const row = audit.all()[0];
    expect(audit.all()).toHaveLength(1);
    expect(row.kind).toBe('refusal');
    expect(row.peerId).toBe('');
    expect(row.verb).toBe('');
    expect(row.effect).toBeUndefined();
    expect(row.originId.startsWith('o_')).toBe(true);
  });

  it('names the rejected kind instead of fabricating a refusal we never issued', async () => {
    // A coerced kind used to be silent, so an export showed `refusal` for a
    // row that was an inbound call with a trailing space. A defender reading
    // the chain would see "we blocked this peer" — confidently wrong.
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'inbound ' as unknown as AuditRow['kind'], peerId: 'p', verb: 'consult' });
    await audit.record({ originId: 'o_a', kind: undefined as unknown as AuditRow['kind'], peerId: 'p', verb: 'consult' });
    await audit.record({ originId: 'o_a', kind: { evil: 1 } as unknown as AuditRow['kind'], peerId: 'p', verb: 'consult' });
    const [spaced, missing, obj] = audit.all();
    expect(spaced.kind).toBe('refusal');
    expect(spaced.rejectedKind).toBe('inbound ');
    expect(missing.rejectedKind).toBe('<missing>');
    expect(obj.rejectedKind).toBe('<object>');

    // A genuine refusal carries no rejectedKind, so the two are distinguishable.
    await audit.record({ originId: 'o_a', kind: 'refusal', peerId: 'p', verb: 'consult' });
    expect(audit.all().at(-1)!.rejectedKind).toBeUndefined();
  });

  it('strips control and bidi characters from every peer-supplied string', async () => {
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_a',
      kind: 'inbound',
      peerId: 'p_\u0000alice\u202E',
      verb: 'con\u001Bsult',
      detail: 'line1\nline2\ttabbed\u000Dcarriage\u2066spoof\u2069',
      effect: { paths: ['src/\u202Etxt.exe'] },
    });
    const row = audit.all()[0];
    expect(row.peerId).toBe('p_alice');
    expect(row.verb).toBe('consult');
    // Tab and newline survive — they are legitimate in a detail string.
    expect(row.detail).toBe('line1\nline2\ttabbedcarriagespoof');
    expect(row.effect!.paths).toEqual(['src/txt.exe']);
    // eslint-disable-next-line no-control-regex -- asserting control characters are absent
    expect(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(JSON.stringify(row))).toBe(false);
  });

  it('emits no unpaired surrogate, in the input or from the length clamp', async () => {
    // A lone surrogate is not encodable as UTF-8: it survives JSON.stringify
    // as \ud83d and a strict encoder either throws or mangles it, so the
    // "diff two copies of one chain" guarantee dies on any non-BMP text.
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_a', kind: 'inbound',
      peerId: `${'a'.repeat(127)}\u{1F600}`,   // the clamp lands mid-pair
      verb: 'lone\uD83Dtail\uDE00',            // already unpaired on arrival
      detail: `ok \u{1F600} ok`,
    });
    const row = audit.all()[0];
    expect(row.peerId).toBe('a'.repeat(127));
    expect(row.verb).toBe('lonetail');
    expect(row.detail).toBe('ok \u{1F600} ok');
    const json = JSON.stringify(row);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(json)).toBe(false);
    // Round-trippable through a strict UTF-8 encoder.
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(json))).toBe(json);
  });

  it('clamps unbounded strings and path lists, and says which fields it clipped', async () => {
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_a', kind: 'effect', peerId: 'x'.repeat(5000), verb: 'v'.repeat(5000),
      detail: 'd'.repeat(100_000),
      effect: { paths: Array.from({ length: 5000 }, (_, i) => `p${i}/${'x'.repeat(4000)}`) },
    });
    const row = audit.all()[0];
    expect(row.peerId.length).toBe(128);
    expect(row.verb.length).toBe(128);
    expect(row.detail!.length).toBe(2000);
    expect(row.effect!.paths!.length).toBe(64);
    expect(row.effect!.paths!.every(p => p.length <= 512)).toBe(true);
    // Silence here is the defect: a detail of exactly 2000 characters must be
    // distinguishable from a truncated 100 KB one.
    expect(row.truncated).toEqual(['peerId', 'verb', 'detail', 'effect.path', 'effect.paths']);
    // "64 of 5000", not a bare 64 — an investigator counting paths in the
    // export must not conclude the handoff touched 64 files.
    expect(row.effect!.pathsTotal).toBe(5000);
  });

  it('marks nothing as truncated when nothing was clipped', async () => {
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff',
      detail: 'd'.repeat(2000), effect: { paths: Array.from({ length: 64 }, (_, i) => `p${i}.ts`) },
    });
    const row = audit.all()[0];
    expect(row.truncated).toBeUndefined();
    expect(row.effect!.pathsTotal).toBeUndefined();
  });

  it('drops a malformed sha256 rather than recording an unverifiable digest', async () => {
    const { audit } = makeAudit();
    for (const sha of ['', 'zz', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 123 as unknown as string]) {
      await audit.record({ originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff', effect: { sha256: sha } });
    }
    expect(audit.all().every(r => r.effect?.sha256 === undefined)).toBe(true);

    await audit.record({ originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff', effect: { sha256: 'A'.repeat(64) } });
    expect(audit.all().at(-1)!.effect!.sha256).toBe('a'.repeat(64));
  });

  it('drops a non-finite bytesOut but keeps the row permanent', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'status', effect: { bytesOut: Infinity } });
    await audit.record({ originId: 'o_a', kind: 'outbound', peerId: 'p', verb: 'status', effect: { bytesOut: NaN } });
    for (const row of audit.all()) {
      expect(row.effect).toBeUndefined();
      expect(row.effectAsserted).toBe(true);
      expect(isVolatile(row)).toBe(false);
    }
  });

  it('re-keys an out-of-charset originId per row and reports it structurally', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: '../../etc/passwd', kind: 'inbound', peerId: 'p', verb: 'status' });
    await audit.record({ originId: 'o_x'.repeat(100), kind: 'inbound', peerId: 'p', verb: 'status' });
    await audit.record({ originId: '', kind: 'inbound', peerId: 'p', verb: 'status' });

    const ids = audit.all().map(r => r.originId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) { expect(/^o_[0-9a-f]{32}$/.test(id)).toBe(true); }
    // The rejected value is preserved for the reader in a field the peer
    // cannot supply — NOT as a prefix on peer-controlled `detail`.
    expect(audit.all()[0].rejectedOrigin).toBe('../../etc/passwd');
    expect(audit.all()[0].detail).toBeUndefined();
    expect(audit.all()[2].rejectedOrigin).toBe('<empty>');
  });

  it('a peer cannot forge a rejection note through `detail`', async () => {
    // The old note lived in `detail`, which the peer writes, so a peer could
    // author a byte-identical "origin-rejected:o_victim" claim on a row whose
    // originId was perfectly valid.
    const { audit } = makeAudit();
    await audit.record({
      originId: 'o_good', kind: 'inbound', peerId: 'p', verb: 'consult',
      detail: 'origin-rejected:o_victim',
    });
    const row = audit.all()[0];
    expect(row.originId).toBe('o_good');
    expect(row.detail).toBe('origin-rejected:o_victim');
    expect(row.rejectedOrigin).toBeUndefined();
  });

  it('accepts a well-formed originId untouched', async () => {
    const { audit } = makeAudit();
    await audit.record({ originId: 'o_01JD8Q.a:b-c', kind: 'inbound', peerId: 'p', verb: 'status' });
    expect(audit.all()[0].originId).toBe('o_01JD8Q.a:b-c');
    expect(audit.all()[0].detail).toBeUndefined();
    expect(audit.all()[0].rejectedOrigin).toBeUndefined();
  });
});

describe('persistence', () => {
  it('survives a reload and keeps effect rows across the round trip', async () => {
    const store = new MemStore();
    const first = new DeskAudit(store, () => NOW);
    await first.record({ originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff', effect: { paths: ['src/a.ts'], bytesOut: 9, sha256: 'c'.repeat(64) } });

    const second = new DeskAudit(store, () => NOW);
    expect(second.chain('o_a')).toEqual(first.chain('o_a'));
  });

  it('keeps the row in memory when the store write fails — the trail is not lost', async () => {
    const store = new MemStore();
    store.failWrites = true;
    const audit = new DeskAudit(store, () => NOW);
    await expect(audit.record({ originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff', effect: { paths: ['a'] } })).resolves.toBeUndefined();
    expect(audit.all()).toHaveLength(1);
  });

  it('starts empty when the store read throws instead of propagating', () => {
    const store = new MemStore();
    store.throwOnRead = true;
    expect(() => new DeskAudit(store, () => NOW)).not.toThrow();
    expect(new DeskAudit(store, () => NOW).all()).toEqual([]);
  });

  it('ignores a non-array persisted value and non-object entries within one', async () => {
    const store = new MemStore();
    await store.update(DESK_AUDIT_KEY, { not: 'an array' });
    expect(new DeskAudit(store, () => NOW).all()).toEqual([]);

    await store.update(DESK_AUDIT_KEY, [null, 'str', 7, ['nested'], { originId: 'o_a', kind: 'effect', at: NOW, peerId: 'p', verb: 'handoff', effect: { paths: ['a'] } }]);
    const audit = new DeskAudit(store, () => NOW);
    expect(audit.all()).toHaveLength(1);
    expect(audit.all()[0].verb).toBe('handoff');
  });

  it('dates a persisted row with an unusable `at` to 0 so garbage ages out promptly', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, [{ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status' }]);
    expect(audit.all()[0].at).toBe(0);
    expect(await audit.prune()).toBe(1);
  });

  it('re-sanitizes rows loaded from a tampered store', async () => {
    const store = new MemStore();
    const audit = await seedStore(store, [
      { originId: 'o_a', kind: 'inbound', at: NOW, peerId: 'p\u0007', verb: 'status', effect: { sha256: 'nope' } },
    ]);
    const row = audit.all()[0];
    expect(row.peerId).toBe('p');
    expect(row.effect).toBeUndefined();
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('announces and re-persists rows dropped at load instead of losing them silently', async () => {
    // Dropping at construction with no log and no write left the store holding
    // rows memory no longer had; the next record() then deleted them with
    // nothing in the log to attribute the loss to.
    const store = new MemStore();
    const logged: string[] = [];
    (console.log as unknown as { mockImplementation: (f: (m: string) => void) => void })
      .mockImplementation((m: string) => { logged.push(String(m)); });

    const seeded: Partial<AuditRow>[] = [];
    for (let i = 0; i < AUDIT_MAX_VOLATILE_ROWS + 500; i++) {
      seeded.push({ originId: 'o_flood', kind: 'inbound', at: NOW, peerId: 'p', verb: 'status', detail: `s${i}` });
    }
    const audit = await seedStore(store, seeded);

    expect(audit.all()).toHaveLength(AUDIT_MAX_VOLATILE_ROWS);
    expect(logged.some(m => m.includes('dropped 500 over-cap row(s) while loading'))).toBe(true);
    expect(store.writes).toBe(1);
    expect(store.get<AuditRow[]>(DESK_AUDIT_KEY)).toHaveLength(AUDIT_MAX_VOLATILE_ROWS);
  });
});

describe('exportChain', () => {
  async function seed(audit: DeskAudit): Promise<void> {
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p_alice', verb: 'consult', detail: 'asked about billing' });
    await audit.record({ originId: 'o_b', kind: 'inbound', peerId: 'p_bob', verb: 'status' });
    await audit.record({ originId: 'o_a', kind: 'effect', peerId: 'p_alice', verb: 'handoff', effect: { paths: ['src/a.ts'], bytesOut: 120, sha256: 'd'.repeat(64) } });
  }

  it('is byte-stable across two audits holding the same chain', async () => {
    const a = new DeskAudit(new MemStore(), () => NOW);
    const b = new DeskAudit(new MemStore(), () => NOW);
    await seed(a);
    await seed(b);
    expect(a.exportChain('o_a')).toBe(b.exportChain('o_a'));
    // Repeated calls are identical too — no timestamp, no ordering nondeterminism.
    expect(a.exportChain('o_a')).toBe(a.exportChain('o_a'));
  });

  it('does not depend on the key order of the recorded object', async () => {
    const a = new DeskAudit(new MemStore(), () => NOW);
    const b = new DeskAudit(new MemStore(), () => NOW);
    await a.record({ originId: 'o_a', kind: 'effect', peerId: 'p', verb: 'handoff', detail: 'x', effect: { sha256: 'e'.repeat(64), paths: ['a.ts'], bytesOut: 3 } });
    await b.record({ detail: 'x', effect: { bytesOut: 3, paths: ['a.ts'], sha256: 'e'.repeat(64) }, verb: 'handoff', peerId: 'p', kind: 'effect', originId: 'o_a' });
    expect(a.exportChain('o_a')).toBe(b.exportChain('o_a'));
  });

  it('carries only the requested chain and stays parseable', async () => {
    const audit = new DeskAudit(new MemStore(), () => NOW);
    await seed(audit);
    const doc = JSON.parse(audit.exportChain('o_a'));
    expect(doc.protocol).toBe('mysti.desk/1');
    expect(doc.originId).toBe('o_a');
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows.map((r: { verb: string }) => r.verb)).toEqual(['consult', 'handoff']);
    expect(audit.exportChain('o_a')).not.toContain('p_bob');
    expect(audit.exportChain('o_a').endsWith('\n')).toBe(true);
  });

  it('exports an empty but valid document for an unknown chain', () => {
    const audit = new DeskAudit(new MemStore(), () => NOW);
    const doc = JSON.parse(audit.exportChain('o_nothing'));
    expect(doc.originId).toBe('o_nothing');
    expect(doc.rows).toEqual([]);
  });

  it('refuses a hostile query id rather than emitting a header naming another chain', async () => {
    // The scrubbed header used to say `"originId": "o_a"` with zero rows —
    // byte-identical to a genuine export of an empty chain o_a, while the real
    // o_a's rows were never queried. An operator diffing that against a
    // teammate's copy would find it clean and conclude nothing happened.
    const audit = new DeskAudit(new MemStore(), () => NOW);
    await audit.record({ originId: 'o_a', kind: 'inbound', peerId: 'p', verb: 'status', detail: 'plain' });

    const genuine = audit.exportChain('o_a');
    expect(genuine).toContain('"originId": "o_a"');
    expect(JSON.parse(genuine).rows).toHaveLength(1);

    for (const hostile of ['o_a\u202Eevil\u0007', 'o_a' + 'z'.repeat(200), '../../etc/passwd', '']) {
      const out = audit.exportChain(hostile);
      const doc = JSON.parse(out);
      expect(doc.originId).toBeNull();
      expect(doc.rejectedQuery).toBeTruthy();
      expect(doc.rows).toEqual([]);
      // It can never be mistaken for a genuine export of any chain.
      expect(out).not.toContain('"originId": "o_a"');
      // eslint-disable-next-line no-control-regex -- asserting control characters are absent
      expect(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(out)).toBe(false);
    }
    // A rejection is byte-stable too, so two copies of it still diff clean.
    expect(audit.exportChain('o_a\u202Eevil')).toBe(audit.exportChain('o_a\u202Eevil'));
  });

  it('shows the reader everything sanitizing had to do', async () => {
    const audit = new DeskAudit(new MemStore(), () => NOW);
    await audit.record({
      originId: 'bad id', kind: 'inbound ' as unknown as AuditRow['kind'], peerId: 'p', verb: 'handoff',
      detail: 'd'.repeat(9000),
      effect: { paths: Array.from({ length: 100 }, (_, i) => `s${i}.ts`), bytesOut: -1 },
    });
    const doc = JSON.parse(audit.exportChain(audit.all()[0].originId));
    const row = doc.rows[0];
    expect(row.effectAsserted).toBe(true);
    expect(row.rejectedKind).toBe('inbound ');
    expect(row.rejectedOrigin).toBe('bad id');
    expect(row.truncated).toEqual(['detail', 'effect.paths']);
    expect(row.effect.pathsTotal).toBe(100);
    expect(row.effect.bytesOut).toBe(0);
  });
});

describe('isVolatile — the predicate itself', () => {
  const base: AuditRow = { originId: 'o_a', kind: 'inbound', at: NOW, peerId: 'p', verb: 'status' };

  it('classifies only effect-free read-only inbound/outbound rows as volatile', () => {
    expect(isVolatile(base)).toBe(true);
    expect(isVolatile({ ...base, verb: 'locate' })).toBe(true);
    expect(isVolatile({ ...base, verb: 'hello' })).toBe(true);
    expect(isVolatile({ ...base, kind: 'outbound' })).toBe(true);

    expect(isVolatile({ ...base, verb: 'consult' })).toBe(false);
    expect(isVolatile({ ...base, verb: 'followup' })).toBe(false);
    expect(isVolatile({ ...base, verb: 'cancel' })).toBe(false);
    expect(isVolatile({ ...base, kind: 'permission' })).toBe(false);
    expect(isVolatile({ ...base, kind: 'effect' })).toBe(false);
    expect(isVolatile({ ...base, kind: 'refusal' })).toBe(false);
    expect(isVolatile({ ...base, effect: { paths: ['a'] } })).toBe(false);
    expect(isVolatile({ ...base, effect: { bytesOut: 1 } })).toBe(false);
    expect(isVolatile({ ...base, effect: { sha256: 'f'.repeat(64) } })).toBe(false);
    expect(isVolatile({ ...base, effectAsserted: true })).toBe(false);
    expect(isVolatile({ ...base, integrity: true })).toBe(false);
  });

  it('treats an empty effect block as no effect — an empty paths array is not an effect', () => {
    expect(isVolatile({ ...base, effect: {} })).toBe(true);
    expect(isVolatile({ ...base, effect: { paths: [], bytesOut: 0 } })).toBe(true);
  });

  it('fails closed on a bytesOut that is not a plain zero', () => {
    // A hand-built row can carry anything; every one of these must RETAIN.
    expect(isVolatile({ ...base, effect: { bytesOut: -1 } })).toBe(false);
    expect(isVolatile({ ...base, effect: { bytesOut: NaN } })).toBe(false);
    expect(isVolatile({ ...base, effect: { bytesOut: 0.4 } })).toBe(false);
  });

  it('prunes only verbs the wire contract actually defines', () => {
    // PRUNABLE_VERBS is typed ReadonlySet<DeskVerb | DeskProtocolVerb>, so tsc
    // catches a renamed verb. This catches the other half: a name that type
    // checks but no longer exists as a real verb in DESK_VERBS.
    const protocolVerbs = ['hello', 'cancel']; // src/types.ts DeskProtocolVerb
    for (const verb of PRUNABLE_VERBS) {
      expect(
        (DESK_VERB_NAMES as readonly string[]).includes(verb) || protocolVerbs.includes(verb),
        `${verb} is prunable but is not a Desk verb`,
      ).toBe(true);
    }
    // Consequential verbs must never drift onto the prunable side.
    for (const verb of ['consult', 'review', 'handoff', 'assign', 'followup', 'cancel']) {
      expect(PRUNABLE_VERBS.has(verb as never), `${verb} must not be prunable`).toBe(false);
    }
  });
});
