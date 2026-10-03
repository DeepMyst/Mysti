/**
 * MCP config git guard (Plan 21 Phase 0, invariant I6).
 *
 * Claude Code's adapter is the one whose config path is INSIDE the user's
 * repository (`<workspace>/.mcp.json`), and the entry Mysti writes there
 * carries `Authorization: Bearer dm_…` — a live account credential. Nothing
 * stopped that file being committed.
 *
 * The guard is fail-closed: a credential written into a tracked file cannot be
 * un-leaked, whereas a refused write is a visible, recoverable error. The
 * already-tracked case is surfaced rather than silently "fixed", because a
 * .gitignore rule does NOT untrack an existing file — git keeps versioning it
 * and the key still gets committed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureGitIgnored } from '../../src/services/McpConfigManager';

describe('ensureGitIgnored', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-gitguard-'));
  });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  const initRepo = () => fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  const readIgnore = () =>
    fs.existsSync(path.join(ws, '.gitignore')) ? fs.readFileSync(path.join(ws, '.gitignore'), 'utf8') : '';

  it('passes when the directory is not a git repo (nothing can be committed)', () => {
    expect(ensureGitIgnored(ws, '.mcp.json')).toEqual({ ok: true });
    // And it does not litter a .gitignore into a non-repo.
    expect(readIgnore()).toBe('');
  });

  it('creates .gitignore and adds the rule in a fresh repo', () => {
    initRepo();
    expect(ensureGitIgnored(ws, '.mcp.json').ok).toBe(true);
    expect(readIgnore()).toContain('.mcp.json');
  });

  it('explains WHY the rule is there, for whoever reads the diff', () => {
    initRepo();
    ensureGitIgnored(ws, '.mcp.json');
    expect(readIgnore().toLowerCase()).toContain('credential');
  });

  it('appends to an existing .gitignore without destroying it', () => {
    initRepo();
    fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules\ndist\n');
    ensureGitIgnored(ws, '.mcp.json');
    const out = readIgnore();
    expect(out).toContain('node_modules');
    expect(out).toContain('dist');
    expect(out).toContain('.mcp.json');
  });

  it('does not append a newline-less file into a broken rule', () => {
    initRepo();
    fs.writeFileSync(path.join(ws, '.gitignore'), 'dist'); // no trailing newline
    ensureGitIgnored(ws, '.mcp.json');
    const lines = readIgnore().split('\n').map(l => l.trim());
    expect(lines).toContain('dist');
    expect(lines).toContain('.mcp.json');
  });

  it('is idempotent — a second call adds nothing', () => {
    initRepo();
    ensureGitIgnored(ws, '.mcp.json');
    const first = readIgnore();
    ensureGitIgnored(ws, '.mcp.json');
    expect(readIgnore()).toBe(first);
  });

  it('recognises an existing rule written with a leading slash', () => {
    initRepo();
    fs.writeFileSync(path.join(ws, '.gitignore'), '/.mcp.json\n');
    ensureGitIgnored(ws, '.mcp.json');
    expect(readIgnore()).toBe('/.mcp.json\n');
  });

  it('REFUSES when the file is already tracked by git', () => {
    initRepo();
    // A real index is binary; the path appears as a UTF-8 run inside it.
    fs.writeFileSync(
      path.join(ws, '.git', 'index'),
      Buffer.concat([Buffer.from([0x44, 0x49, 0x52, 0x43]), Buffer.from('.mcp.json', 'utf8'), Buffer.from([0x00])]),
    );
    const res = ensureGitIgnored(ws, '.mcp.json');
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toContain('already tracked');
  });

  it('does not confuse an unrelated tracked file for this one', () => {
    initRepo();
    fs.writeFileSync(
      path.join(ws, '.git', 'index'),
      Buffer.concat([Buffer.from('src/index.ts', 'utf8'), Buffer.from([0x00])]),
    );
    expect(ensureGitIgnored(ws, '.mcp.json').ok).toBe(true);
  });

  it('fails closed when .gitignore cannot be written', () => {
    initRepo();
    // A directory where the file must go makes both read and append fail.
    fs.mkdirSync(path.join(ws, '.gitignore'));
    const res = ensureGitIgnored(ws, '.mcp.json');
    expect(res.ok).toBe(false);
  });
});
