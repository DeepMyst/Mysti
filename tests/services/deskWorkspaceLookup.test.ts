import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeskWorkspaceLookup } from '../../src/services/DeskWorkspaceLookup';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) { await fs.promises.rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  // Windows system temp is inside AppData, an intentionally unshareable store.
  // Keep Windows fixtures in a fresh directory under the isolated checkout.
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(process.platform === 'win32' ? process.cwd() : os.tmpdir(), 'mysti-desk-scope-')));
  roots.push(root);
  const write = async (name: string, text: string) => {
    await fs.promises.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.promises.writeFile(path.join(root, name), text);
  };
  await write('.mysti/desk-share.json', JSON.stringify({ allow: ['src'] }));
  await write('src/shared.ts', 'export function SharedThing() {}\nconst another = 1;');
  const flags = { active: true, live: true, ceiling: ['src'] as unknown };
  const reader = new DeskWorkspaceLookup({ root, ceiling: () => flags.ceiling, active: () => flags.active });
  const prepare = (scope = ['src']) => reader.prepare(scope, () => flags.live);
  return { root, write, flags, reader, prepare };
}

describe('Desk owner-prepared workspace coordinates', () => {
  it('intersects all three scopes before opening source bytes; retains coordinates only', async () => {
    const f = await fixture();
    await f.write('src/private/hidden.ts', 'function HiddenThing() {}');
    await f.write('other/outside.ts', 'function OutsideThing() {}');
    await f.write('.mysti/desk-share.json', JSON.stringify({ allow: ['*'] }));
    f.flags.ceiling = ['src'];
    const opens = vi.spyOn(fs.promises, 'open');
    const snapshot = await f.prepare(['src/shared.ts']);
    expect(snapshot.index.lookup('SharedThing', 'symbol')).toEqual([{ path: 'src/shared.ts', line: 1, symbol: 'SharedThing' }]);
    expect(snapshot.index.lookup('HiddenThing', 'symbol')).toEqual([]);
    expect(snapshot.index.lookup('OutsideThing', 'symbol')).toEqual([]);
    expect(opens.mock.calls.every(([name]) => ['.mysti/desk-share.json', 'src/shared.ts'].includes(path.relative(f.root, String(name)).split(path.sep).join('/')))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('const another');
  });

  it.each([undefined, [], ['other'], '*', { allow: ['src'] }])('fails closed for missing, malformed or nonintersecting ceiling %j', async ceiling => {
    const f = await fixture(); f.flags.ceiling = ceiling;
    await expect(f.prepare()).rejects.toThrow();
  });

  it.each(['null', '{}', '{', '{"allow":["../outside"]}', '{"allow":[]}'])('fails closed for malformed or empty share file %s', async raw => {
    const f = await fixture(); await f.write('.mysti/desk-share.json', raw);
    await expect(f.prepare()).rejects.toThrow();
  });

  it('never reads hidden, credential, transcript, vendored or generated files even under wildcard scope', async () => {
    const f = await fixture();
    const excluded = ['.codex/session.ts', 'src/.env.ts', 'src/credentials.ts', 'src/secrets/token.ts',
      'src/transcripts/saved.ts', 'src/sessions/session.ts', 'node_modules/lib.ts', 'dist/bundle.ts', 'src/id_rsa'];
    for (const name of excluded) { await f.write(name, 'function NeverReadThis() {}'); }
    await f.write('.mysti/desk-share.json', '{"allow":["*"]}'); f.flags.ceiling = ['*'];
    const opens = vi.spyOn(fs.promises, 'open');
    const snapshot = await f.prepare(['*']);
    expect(snapshot.index.lookup('NeverReadThis', 'symbol')).toEqual([]);
    expect(opens.mock.calls.every(([name]) => !excluded.includes(path.relative(f.root, String(name)).split(path.sep).join('/')))).toBe(true);
    expect(snapshot.index.lookup('id_rsa', 'path')).toEqual([]);
  });

  it('skips linked files and directories without opening their targets', async () => {
    const f = await fixture();
    await f.write('outside/hidden.ts', 'function NeverReadThis() {}');
    await fs.promises.symlink(path.join(f.root, 'outside'), path.join(f.root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    // Directory links work without elevated Windows symlink privilege.
    const opens = vi.spyOn(fs.promises, 'open');
    const snapshot = await f.prepare();
    expect(snapshot.index.lookup('NeverReadThis', 'symbol')).toEqual([]);
    expect(opens.mock.calls.some(([name]) => String(name).includes('linked') || String(name).includes('outside'))).toBe(false);
  });

  it('refuses hard-linked files before opening their bytes', async () => {
    const f = await fixture(); await f.write('outside.ts', 'function NeverReadThis() {}');
    await fs.promises.link(path.join(f.root, 'outside.ts'), path.join(f.root, 'src/linked.ts'));
    const opens = vi.spyOn(fs.promises, 'open');
    await expect(f.prepare()).rejects.toThrow();
    expect(opens.mock.calls.some(([name]) => String(name).endsWith('linked.ts'))).toBe(false);
  });

  it('refuses a linked share configuration before opening its target', async () => {
    const f = await fixture();
    await fs.promises.rename(path.join(f.root, '.mysti'), path.join(f.root, 'outside'));
    await fs.promises.symlink(path.join(f.root, 'outside'), path.join(f.root, '.mysti'), process.platform === 'win32' ? 'junction' : 'dir');
    const opens = vi.spyOn(fs.promises, 'open');
    await expect(f.prepare()).rejects.toThrow(); expect(opens).not.toHaveBeenCalled();
  });

  it('refuses replacement of a regular file between inspection and open before reading', async () => {
    const f = await fixture(); await f.write('replacement.ts', 'function NeverReadThis() {}');
    const open = fs.promises.open.bind(fs.promises);
    let reads = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (name, flags, mode) => {
      if (String(name).endsWith('shared.ts')) {
        await fs.promises.rename(path.join(f.root, 'src/shared.ts'), path.join(f.root, 'original.ts'));
        await fs.promises.rename(path.join(f.root, 'replacement.ts'), path.join(f.root, 'src/shared.ts'));
        const handle = await open(name, flags, mode);
        vi.spyOn(handle, 'read').mockImplementation(async () => { reads++; throw new Error('unexpected read'); });
        return handle;
      }
      return open(name, flags, mode);
    });
    await expect(f.prepare()).rejects.toThrow(); expect(reads).toBe(0);
  });

  it.each(['scope', 'ceiling', 'source', 'added-file', 'trust', 'revocation'] as const)('invalidates snapshots after %s changes', async change => {
    const f = await fixture(); const snapshot = await f.prepare();
    expect(await snapshot.isCurrent()).toBe(true);
    if (change === 'scope') { await f.write('.mysti/desk-share.json', '{"allow":[]}'); }
    if (change === 'ceiling') { f.flags.ceiling = []; }
    if (change === 'source') { await f.write('src/shared.ts', 'function Replacement() {}'); }
    if (change === 'added-file') { await f.write('src/new.ts', 'function NewThing() {}'); }
    if (change === 'trust') { f.flags.active = false; }
    if (change === 'revocation') { f.flags.live = false; }
    expect(await snapshot.isCurrent()).toBe(false);
  });

  it('keeps an unchanged snapshot usable beyond the build deadline', async () => {
    const f = await fixture(); const snapshot = await f.prepare(); const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    expect(await snapshot.isCurrent()).toBe(true);
  });

  it('does not revive a snapshot after removing and restoring the share file', async () => {
    const f = await fixture(); const snapshot = await f.prepare();
    await f.write('.mysti/desk-share.json', '{"allow":[]}');
    await f.write('.mysti/desk-share.json', JSON.stringify({ allow: ['src'] }));
    expect(await snapshot.isCurrent()).toBe(false);
  });

  it('refuses a parent replaced by a directory link between inspection and open before reading', async () => {
    const f = await fixture(); await f.write('outside/shared.ts', 'function NeverReadThis() {}');
    const open = fs.promises.open.bind(fs.promises);
    let reads = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (name, flags, mode) => {
      if (String(name).endsWith('shared.ts')) {
        await fs.promises.rename(path.join(f.root, 'src'), path.join(f.root, 'original'));
        await fs.promises.symlink(path.join(f.root, 'outside'), path.join(f.root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
        const handle = await open(name, flags, mode);
        vi.spyOn(handle, 'read').mockImplementation(async () => { reads++; throw new Error('unexpected read'); });
        return handle;
      }
      return open(name, flags, mode);
    });
    await expect(f.prepare()).rejects.toThrow(); expect(reads).toBe(0);
  });

  it('refuses oversize source instead of publishing a silently incomplete index', async () => {
    const f = await fixture(); await f.write('src/large.ts', 'x'.repeat(512 * 1024 + 1));
    const opens = vi.spyOn(fs.promises, 'open');
    await expect(f.prepare()).rejects.toThrow();
    expect(opens.mock.calls.some(([name]) => String(name).endsWith('large.ts'))).toBe(false);
  });

  it('refuses a scope with too many files instead of publishing partial coordinates', async () => {
    const f = await fixture();
    for (let i = 0; i < 1024; i++) { await f.write(`src/f${i}.md`, 'fixture'); }
    await expect(f.prepare()).rejects.toThrow('limit');
  });

  it('refuses a hidden credential-store root without opening anything', async () => {
    const f = await fixture(); await f.write('.codex/src/example.ts', 'fixture');
    const opens = vi.spyOn(fs.promises, 'open');
    await expect(new DeskWorkspaceLookup({ root: path.join(f.root, '.codex'), ceiling: () => ['*'], active: () => true })
      .prepare(['*'], () => true)).rejects.toThrow();
    expect(opens).not.toHaveBeenCalled();
  });

  it.each(['AppData', 'Library'])('refuses a workspace inside the %s profile store before opening files', async store => {
    const f = await fixture(); await f.write(`${store}/Temp/workspace/src/example.ts`, 'fixture');
    const opens = vi.spyOn(fs.promises, 'open');
    await expect(new DeskWorkspaceLookup({ root: path.join(f.root, store, 'Temp/workspace'), ceiling: () => ['*'], active: () => true })
      .prepare(['*'], () => true)).rejects.toThrow('root unavailable');
    expect(opens).not.toHaveBeenCalled();
  });
});
