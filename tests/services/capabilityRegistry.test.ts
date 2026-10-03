/**
 * Plan 20 Phase 3 — approval binds BYTES, not a filename.
 *
 * Registration is the one act a checkpoint does not undo, so the registry
 * stores a folder hash taken at approval time and re-checks it before every
 * call. The interesting behaviour is the refusal: a changed folder must NOT
 * silently re-pin, or the check is decorative.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CapabilityRegistry, folderMerkle, type MementoLike } from '../../src/services/CapabilityRegistry';
import type { CapabilityEntry } from '../../src/services/CapabilityManifest';

function memento(): MementoLike {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string) => store.get(k) as T | undefined,
    update: (k: string, v: unknown) => { store.set(k, v); },
  };
}

const ENTRY: CapabilityEntry = {
  name: 'build_bundle',
  description: '[user-authored capability] builds it',
  inputSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' } } },
  exec: { interpreter: 'bash', script: 'scripts/build.sh' },
  network: false,
  timeoutMs: 30_000,
};

describe('folderMerkle', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-merkle-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# a\n');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'build.sh'), 'echo hi\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is stable across repeated reads', async () => {
    expect(await folderMerkle(dir)).toBe(await folderMerkle(dir));
  });

  it('changes when any file changes', async () => {
    const before = await folderMerkle(dir);
    fs.writeFileSync(path.join(dir, 'scripts', 'build.sh'), 'echo hi\ncurl evil\n');
    expect(await folderMerkle(dir)).not.toBe(before);
  });

  it('changes when a file is ADDED', async () => {
    const before = await folderMerkle(dir);
    fs.writeFileSync(path.join(dir, 'extra.md'), 'x');
    expect(await folderMerkle(dir)).not.toBe(before);
  });

  it('is insensitive to line endings, so Windows checkouts do not false-positive', async () => {
    const before = await folderMerkle(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# a\r\n');
    expect(await folderMerkle(dir)).toBe(before);
  });
});

describe('CapabilityRegistry', () => {
  let dir: string;
  let reg: CapabilityRegistry;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-reg-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# a\n');
    reg = new CapabilityRegistry(memento(), () => 123);
    reg.register({ id: 'my-cap', dir, entries: [ENTRY], merkle: await folderMerkle(dir), verifiedBy: 'observed' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds an entry by its tool name', () => {
    expect(reg.findEntry('build_bundle')?.artifact.id).toBe('my-cap');
    expect(reg.findEntry('nope')).toBeUndefined();
  });

  it('verifies an untouched artifact', async () => {
    expect(await reg.verify('my-cap')).toBeNull();
  });

  it('REFUSES an artifact whose bytes changed after approval', async () => {
    // The time-of-check/time-of-use gap: reviewed at publish, mutated later.
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# a\nnow malicious\n');
    const reason = await reg.verify('my-cap');
    expect(reason).toMatch(/changed on disk/);
  });

  it('does not silently re-pin — a second check still refuses', async () => {
    // Re-hashing whatever is on disk now would make the pin decorative: the
    // attacker's write would simply become the new approved state.
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# tampered\n');
    expect(await reg.verify('my-cap')).toMatch(/changed on disk/);
    expect(await reg.verify('my-cap')).toMatch(/changed on disk/);
  });

  it('refuses when the folder has gone away', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await reg.verify('my-cap')).toMatch(/missing/);
  });

  it('refuses an unregistered id', async () => {
    expect(await reg.verify('never-published')).toMatch(/not a registered capability/);
  });

  it('re-registering replaces rather than duplicates', async () => {
    reg.register({ id: 'my-cap', dir, entries: [ENTRY], merkle: await folderMerkle(dir), verifiedBy: 'again' });
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].verifiedBy).toBe('again');
  });

  it('unregisters and clears', () => {
    expect(reg.unregister('my-cap')).toBe(true);
    expect(reg.unregister('my-cap')).toBe(false);
    expect(reg.list()).toEqual([]);
  });

  it('survives corrupt persisted state', () => {
    const bad: MementoLike = { get: () => ({}) as never, update: () => {} };
    expect(new CapabilityRegistry(bad).list()).toEqual([]);
  });
});
