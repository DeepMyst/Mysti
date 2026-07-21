/**
 * MystiLocalTools (Plan 17 P0.1) — read-only local tools for the Mysti
 * coordinator. Focus: workspace fencing (no traversal/symlink escapes), caps,
 * and formatting contracts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MystiLocalTools } from '../../src/services/MystiLocalTools';

describe('MystiLocalTools', () => {
  let root: string;
  let outside: string;
  let tools: MystiLocalTools;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-tools-ws-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-tools-out-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'line one\nline two has parseStreamLine\nline three\n');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'nothing here\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
    tools = new MystiLocalTools({
      getWorkspaceRoot: () => root,
      findFiles: async (_include, _exclude, max) => {
        const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
          e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
        return walk(root).slice(0, max);
      },
      getDiagnostics: () => [
        { fsPath: path.join(root, 'src', 'a.ts'), diags: [
          { line: 1, severity: 1, message: 'unused variable' },
          { line: 0, severity: 0, message: 'type error' },
        ] },
        { fsPath: path.join(outside, 'other.ts'), diags: [{ line: 0, severity: 0, message: 'outside noise' }] },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  // ── read ──

  it('reads a file with line numbers', async () => {
    const r = await tools.read('src/a.ts');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('1→line one');
    expect(r.output).toContain('(4 lines)'); // trailing newline ⇒ 4 split entries
  });

  it('honors a line range', async () => {
    const r = await tools.read('src/a.ts', 2, 2);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('2→line two');
    expect(r.output).not.toContain('1→line one');
  });

  it('REJECTS .. traversal and absolute paths outside the workspace', async () => {
    expect((await tools.read('../' + path.basename(outside) + '/secret.txt')).ok).toBe(false);
    expect((await tools.read(path.join(outside, 'secret.txt'))).ok).toBe(false);
  });

  it('REJECTS a symlink escaping the workspace', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'sneaky.txt'));
    const r = await tools.read('sneaky.txt');
    expect(r.ok).toBe(false);
    expect(r.output).not.toContain('TOP SECRET');
  });

  it('rejects binary files and clamps huge files head+tail', async () => {
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    expect((await tools.read('bin.dat')).ok).toBe(false);
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(50) + '\n'.repeat(1) + 'y'.repeat(30000) + '\nTAIL-MARKER');
    const r = await tools.read('big.txt');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('[clamped');
    expect(r.output).toContain('TAIL-MARKER');
  });

  // ── ls ──

  it('lists a directory (dirs first) and rejects outside paths', async () => {
    const r = await tools.ls('.');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('src/');
    expect((await tools.ls('../')).ok).toBe(false);
  });

  // ── grep ──

  it('finds matches with file:line and treats an invalid regex as a literal', async () => {
    const r = await tools.grep('parseStreamLine');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('src/a.ts:2');
    const bad = await tools.grep('([unclosed');
    expect(bad.ok).toBe(true); // literal fallback, no throw
  });

  it('reports zero matches without erroring', async () => {
    const r = await tools.grep('zzz_not_present_zzz');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('no matches');
  });

  // ── diag ──

  it('reports diagnostics errors-first and filters outside-workspace noise', async () => {
    const r = await tools.diag('all');
    expect(r.ok).toBe(true);
    const errIdx = r.output.indexOf('type error');
    const warnIdx = r.output.indexOf('unused variable');
    expect(errIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(errIdx); // errors sorted first
    expect(r.output).not.toContain('outside noise');
  });

  it('filters diagnostics to a single file target', async () => {
    const r = await tools.diag('src/b.ts');
    expect(r.output).toContain('no diagnostics');
  });

  // ── security hardening (P0 review [0]/[1]/[2]) ──

  it('read BLOCKS credential/secret files', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=hunter2');
    fs.mkdirSync(path.join(root, 'keys'));
    fs.writeFileSync(path.join(root, 'keys', 'server.pem'), 'PRIVATE KEY');
    expect((await tools.read('.env')).ok).toBe(false);
    expect((await tools.read('.env')).output).toContain('credentials');
    expect((await tools.read('keys/server.pem')).ok).toBe(false);
    // ordinary files still read
    expect((await tools.read('src/a.ts')).ok).toBe(true);
  });

  it('grep skips a symlink escaping the workspace (does not leak external contents)', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'EXFILTRATED_LINE');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const r = await tools.grep('EXFILTRATED_LINE');
    expect(r.ok).toBe(true);
    // A leak would surface a `link.txt:N: EXFILTRATED_LINE` hit line.
    expect(r.output).not.toContain('link.txt:');
    expect(r.output).toContain('no matches');
  });

  it('grep skips secret files it would otherwise match', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'API_TOKEN=abcdef');
    const r = await tools.grep('API_TOKEN');
    expect(r.output).not.toContain('.env');
  });

  it('grep neutralizes catastrophic-backtracking patterns incl. alternation-overlap (re-review HIGH)', async () => {
    fs.writeFileSync(path.join(root, 'evil.txt'), 'a'.repeat(60) + '!');
    for (const evil of ['(a+)+$', '(a|a)+$', '(a|a|a|a)+$', '(a+){10,}', '(.*)*$']) {
      const started = Date.now();
      const r = await tools.grep(evil);
      expect(Date.now() - started).toBeLessThan(1500); // did not hang
      expect(r.ok).toBe(true); // literalized, no freeze
    }
  });

  it('grep does NOT literalize a safe char-class quantifier (re-review MEDIUM false-positive)', async () => {
    fs.writeFileSync(path.join(root, 'names.txt'), 'const parseStreamLine = 1;\n');
    // [a-z]+ is linear/safe — must run as a real regex, matching lowercase runs.
    const r = await tools.grep('[a-z]+Stream');
    expect(r.output).toContain('names.txt:1');
  });

  it('read blocks a symlink pointing at a secret even under an innocuous name (re-review MEDIUM)', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'notes.txt'));
    const r = await tools.read('notes.txt');
    expect(r.ok).toBe(false);
    expect(r.output).not.toContain('SECRET=1');
  });

  it('secret filter does NOT over-block source files named like credentials', async () => {
    fs.writeFileSync(path.join(root, 'credentialStore.ts'), 'export const x = 1;\n');
    expect((await tools.read('credentialStore.ts')).ok).toBe(true);
    // …but a credentials CONFIG file is still blocked
    fs.writeFileSync(path.join(root, 'credentials.json'), '{"key":"v"}');
    expect((await tools.read('credentials.json')).ok).toBe(false);
  });

  // ── resolveWriteTarget: symlink write escape (round-4 HIGH #1) ──
  it('resolveWriteTarget resolves a normal new path but REJECTS symlink leaves', async () => {
    // a normal (non-existent) target is fine
    const ok = await tools.resolveWriteTarget('src/new.ts');
    expect(ok.ok).toBe(true);

    // a DANGLING symlink pointing outside the workspace must be refused — else a
    // write would follow it and create a file outside the workspace.
    const escapeTarget = path.join(outside, 'evil.txt'); // does NOT exist
    fs.symlinkSync(escapeTarget, path.join(root, 'sneaky.txt'));
    const dangling = await tools.resolveWriteTarget('sneaky.txt');
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) { expect(dangling.output).toMatch(/symlink/i); }

    // an EXISTING in-workspace symlink is also refused as a write target.
    fs.writeFileSync(path.join(root, 'real.ts'), 'x');
    fs.symlinkSync(path.join(root, 'real.ts'), path.join(root, 'alias.ts'));
    expect((await tools.resolveWriteTarget('alias.ts')).ok).toBe(false);
  });
});
