/**
 * MystiMemoryStore (Plan 17 P2.5) — unified cross-backend project memory:
 * dedup, host/model sourcing, capped LRU-ish eviction, digest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MystiMemoryStore, type MementoLike } from '../../src/services/MystiMemoryStore';

function memento(): MementoLike & { _store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    _store: store,
    get<T>(key: string): T | undefined { return store.get(key) as T | undefined; },
    update(key: string, value: unknown) { store.set(key, value); },
  };
}

describe('MystiMemoryStore', () => {
  let clock: number;
  let store: MystiMemoryStore;
  let mem: ReturnType<typeof memento>;

  beforeEach(() => {
    clock = 1000;
    mem = memento();
    store = new MystiMemoryStore(mem, () => clock);
  });

  it('stores and lists facts most-recent-first', () => {
    store.remember('uses pnpm', 'model');
    clock = 2000;
    store.remember('tests via npm run test:unit', 'host');
    const list = store.list();
    expect(list.map(e => e.text)).toEqual(['tests via npm run test:unit', 'uses pnpm']);
    expect(list[0].source).toBe('host');
  });

  it('de-duplicates case-insensitively (bumps hits + recency, no copy)', () => {
    store.remember('Uses PNPM', 'model');
    clock = 5000;
    store.remember('uses pnpm', 'model');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].hits).toBe(1);
    expect(list[0].at).toBe(5000);
  });

  it('a host re-affirmation upgrades a model fact to host trust', () => {
    store.remember('auth in src/auth', 'model');
    store.remember('auth in src/auth', 'host');
    expect(store.list()[0].source).toBe('host');
  });

  it('caps at 40 entries, evicting the weakest (host + hits survive)', () => {
    store.remember('KEEP: host fact', 'host');
    for (let i = 0; i < 60; i++) { clock += 10; store.remember(`model fact ${i}`, 'model'); }
    const list = store.list();
    expect(list.length).toBeLessThanOrEqual(40);
    expect(list.some(e => e.text === 'KEEP: host fact')).toBe(true); // host fact not evicted
  });

  it('digest is compact and marks host facts', () => {
    store.remember('a model fact', 'model');
    store.remember('an operational fact', 'host');
    const d = store.digest();
    expect(d).toContain('- an operational fact [system]');
    expect(d).toContain('- a model fact');
  });

  it('ignores empty facts and clamps very long ones', () => {
    store.remember('   ', 'model');
    expect(store.list()).toHaveLength(0);
    store.remember('x'.repeat(1000), 'model');
    expect(store.list()[0].text.length).toBeLessThanOrEqual(400);
  });
});
