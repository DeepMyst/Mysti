/**
 * MystiLocalExec (Plan 19 Phase 0) — the gated local write/edit chokepoint for
 * the Mysti coordinator. Focus: the security invariants — fail-closed guards
 * (disabled / untrusted), workspace-scoping + secret-blocking, gate routing
 * (deny = no write), and checkpoint-before-mutation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MystiLocalTools } from '../../src/services/MystiLocalTools';
import { MystiLocalExec, type LocalExecContext } from '../../src/services/MystiLocalExec';
import type { SandboxRunner, SandboxResult } from '../../src/services/MystiSandbox';

/** Deterministic fake sandbox — never spawns a real process. */
function fakeSandbox(available: boolean, over: Partial<SandboxResult> = {}): SandboxRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    available: () => available,
    run: vi.fn(async (command: string): Promise<SandboxResult> =>
      ({ code: 0, stdout: `ran: ${command}`, stderr: '', sandboxed: available, timedOut: false, ...over })),
  };
}

describe('MystiLocalExec', () => {
  let root: string;
  let tools: MystiLocalTools;
  let exec: MystiLocalExec;
  let gate: ReturnType<typeof vi.fn>;
  let checkpoint: ReturnType<typeof vi.fn>;

  const rd = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));
  const ctx = (over: Partial<LocalExecContext> = {}): LocalExecContext =>
    ({ enabled: true, workspaceTrusted: true, gate, checkpoint, ...over });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-exec-ws-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const x = 1;\nconst y = 2;\n');
    tools = new MystiLocalTools({ getWorkspaceRoot: () => root });
    exec = new MystiLocalExec(tools);
    gate = vi.fn(async () => true);
    checkpoint = vi.fn(async () => { /* noop */ });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // ── fail-closed guards ──
  it('refuses (no write, no gate) when local execution is disabled', async () => {
    const r = await exec.write('src/new.ts', 'x', ctx({ enabled: false }));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/disabled/i);
    expect(exists('src/new.ts')).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
  it('refuses in an untrusted workspace', async () => {
    const r = await exec.write('src/new.ts', 'x', ctx({ workspaceTrusted: false }));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/untrusted/i);
    expect(gate).not.toHaveBeenCalled();
  });

  // ── workspace-scoping + secret-blocking (before the gate) ──
  it('rejects a path that escapes the workspace (../)', async () => {
    const r = await exec.write('../escape.ts', 'x', ctx());
    expect(r.ok).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });
  it('blocks writing a secret file (.env)', async () => {
    const r = await exec.write('.env', 'SECRET=1', ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/secret/i);
    expect(exists('.env')).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });

  // ── write ──
  it('creates a new file, gated + checkpointed', async () => {
    const r = await exec.write('src/new.ts', 'hello\n', ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/created/);
    expect(rd('src/new.ts')).toBe('hello\n');
    expect(gate).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });
  it('overwrites an existing file', async () => {
    const r = await exec.write('src/a.ts', 'replaced\n', ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/overwrote/);
    expect(rd('src/a.ts')).toBe('replaced\n');
  });
  it('snapshots the OLD content BEFORE writing (checkpoint ordering)', async () => {
    let seen: string | null = 'unset';
    checkpoint.mockImplementation(async () => { seen = exists('src/a.ts') ? rd('src/a.ts') : null; });
    await exec.write('src/a.ts', 'NEW', ctx());
    expect(seen).toBe('const x = 1;\nconst y = 2;\n'); // pre-write snapshot
  });
  it('a gate DENY writes nothing and never checkpoints', async () => {
    gate.mockResolvedValue(false);
    const r = await exec.write('src/new.ts', 'x', ctx());
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
    expect(exists('src/new.ts')).toBe(false);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('REFUSES to write through a dangling symlink (no out-of-workspace file) — round-4 HIGH #1', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-exec-out-'));
    const escapeTarget = path.join(outside, 'evil.txt'); // absent
    fs.symlinkSync(escapeTarget, path.join(root, 'sneaky.txt'));
    try {
      const r = await exec.write('sneaky.txt', 'PWNED', ctx());
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/symlink/i);
      expect(fs.existsSync(escapeTarget)).toBe(false); // nothing created outside
      expect(gate).not.toHaveBeenCalled();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  // ── edit ──
  it('applies a unique targeted edit', async () => {
    const r = await exec.edit('src/a.ts', 'const x = 1;', 'const x = 42;', false, ctx());
    expect(r.ok).toBe(true);
    expect(rd('src/a.ts')).toBe('const x = 42;\nconst y = 2;\n');
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });
  it('fails when old_string is not found (before the gate)', async () => {
    const r = await exec.edit('src/a.ts', 'nope', 'x', false, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not found/i);
    expect(gate).not.toHaveBeenCalled();
  });
  it('fails on a non-unique old_string unless replace="all"', async () => {
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a\na\na\n');
    const r = await exec.edit('src/a.ts', 'a', 'b', false, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not unique/i);
    const r2 = await exec.edit('src/a.ts', 'a', 'b', true, ctx());
    expect(r2.ok).toBe(true);
    expect(rd('src/a.ts')).toBe('b\nb\nb\n');
  });
  it('refuses to edit a non-existent file (suggests write)', async () => {
    const r = await exec.edit('src/missing.ts', 'x', 'y', false, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/does not exist/i);
    expect(gate).not.toHaveBeenCalled();
  });
  it('a gate DENY on edit leaves the file unchanged', async () => {
    gate.mockResolvedValue(false);
    const r = await exec.edit('src/a.ts', 'const x = 1;', 'const x = 9;', false, ctx());
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
    expect(rd('src/a.ts')).toBe('const x = 1;\nconst y = 2;\n');
    expect(checkpoint).not.toHaveBeenCalled();
  });
});

describe('MystiLocalExec.applyPatch', () => {
  let root: string;
  let tools: MystiLocalTools;
  let exec: MystiLocalExec;
  let gate: ReturnType<typeof vi.fn>;
  let checkpoint: ReturnType<typeof vi.fn>;
  const rd = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));
  const ctx = (over: Partial<LocalExecContext> = {}): LocalExecContext =>
    ({ enabled: true, workspaceTrusted: true, gate, checkpoint, ...over });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-patch-ws-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const old = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'gone.ts'), 'bye\n');
    tools = new MystiLocalTools({ getWorkspaceRoot: () => root });
    exec = new MystiLocalExec(tools);
    gate = vi.fn(async () => true);
    checkpoint = vi.fn(async () => { /* noop */ });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const patch = (s: string[]) => s.join('\n');

  it('applies add + update + delete + move atomically, gated + checkpointed once', async () => {
    const r = await exec.applyPatch(patch([
      '*** Add: src/new.ts', 'export const n = 1;',
      '*** Update: src/a.ts', '<<<<<<< SEARCH', 'const old = 1;', '=======', 'const neu = 2;', '>>>>>>> REPLACE',
      '*** Delete: src/gone.ts',
      '*** Move: src/new.ts >>> src/moved.ts',
      '*** End',
    ]), ctx());
    expect(r.ok).toBe(true);
    expect(exists('src/new.ts')).toBe(false);          // moved away
    expect(rd('src/moved.ts')).toBe('export const n = 1;');
    expect(rd('src/a.ts')).toBe('const neu = 2;\n');
    expect(exists('src/gone.ts')).toBe(false);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it('rejects the WHOLE patch (no writes) if ANY path escapes the workspace', async () => {
    const r = await exec.applyPatch(patch([
      '*** Update: src/a.ts', '<<<<<<< SEARCH', 'const old = 1;', '=======', 'X', '>>>>>>> REPLACE',
      '*** Add: ../escape.ts', 'evil',
      '*** End',
    ]), ctx());
    expect(r.ok).toBe(false);
    expect(rd('src/a.ts')).toBe('const old = 1;\n'); // untouched — atomic
    expect(gate).not.toHaveBeenCalled();
  });

  it('rejects the whole patch if any target is a secret file', async () => {
    const r = await exec.applyPatch(patch(['*** Add: .env', 'SECRET=1', '*** End']), ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/secret/i);
    expect(exists('.env')).toBe(false);
  });

  it('rejects the whole patch if an Update SEARCH is not found (nothing written)', async () => {
    const r = await exec.applyPatch(patch([
      '*** Add: src/new.ts', 'ok',
      '*** Update: src/a.ts', '<<<<<<< SEARCH', 'NOT THERE', '=======', 'X', '>>>>>>> REPLACE',
      '*** End',
    ]), ctx());
    expect(r.ok).toBe(false);
    expect(exists('src/new.ts')).toBe(false); // the valid Add is not applied either — atomic
  });

  it('Add on an existing file errors (use Update)', async () => {
    const r = await exec.applyPatch(patch(['*** Add: src/a.ts', 'x', '*** End']), ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/already exists/i);
  });

  it('a gate DENY writes nothing', async () => {
    gate.mockResolvedValue(false);
    const r = await exec.applyPatch(patch(['*** Add: src/new.ts', 'x', '*** End']), ctx());
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
    expect(exists('src/new.ts')).toBe(false);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('refuses when disabled', async () => {
    const r = await exec.applyPatch(patch(['*** Add: src/new.ts', 'x', '*** End']), ctx({ enabled: false }));
    expect(r.ok).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });

  it('rejects the whole patch if an Add targets a symlink (round-4 HIGH #1)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-patch-out-'));
    fs.symlinkSync(path.join(outside, 'evil.txt'), path.join(root, 'sneaky.txt'));
    try {
      const r = await exec.applyPatch(patch(['*** Add: sneaky.txt', 'PWNED', '*** End']), ctx());
      expect(r.ok).toBe(false);
      expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
      expect(gate).not.toHaveBeenCalled();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('applies writes BEFORE removals so a Move never loses its source (#6)', async () => {
    fs.writeFileSync(path.join(root, 'src', 'from.ts'), 'important\n');
    const r = await exec.applyPatch(patch(['*** Move: src/from.ts >>> src/to.ts', '*** End']), ctx());
    expect(r.ok).toBe(true);
    expect(rd('src/to.ts')).toBe('important\n');
    expect(exists('src/from.ts')).toBe(false);
  });

  it('deletes a directory via patch without an EISDIR mid-batch throw (#6)', async () => {
    fs.mkdirSync(path.join(root, 'src', 'dir'));
    fs.writeFileSync(path.join(root, 'src', 'dir', 'f.ts'), 'x');
    const r = await exec.applyPatch(patch(['*** Add: src/new.ts', 'ok', '*** Delete: src/dir', '*** End']), ctx());
    expect(r.ok).toBe(true);
    expect(exists('src/dir')).toBe(false);
    expect(rd('src/new.ts')).toBe('ok');
  });
});

describe('MystiLocalExec.bash', () => {
  let root: string;
  let tools: MystiLocalTools;
  let gate: ReturnType<typeof vi.fn>;
  let checkpoint: ReturnType<typeof vi.fn>;
  const ctx = (over: Partial<LocalExecContext> = {}): LocalExecContext =>
    ({ enabled: true, workspaceTrusted: true, gate, checkpoint, ...over });
  const makeExec = (sandbox: SandboxRunner) => new MystiLocalExec(tools, sandbox);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-bash-ws-'));
    tools = new MystiLocalTools({ getWorkspaceRoot: () => root });
    gate = vi.fn(async () => true);
    checkpoint = vi.fn(async () => { /* noop */ });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('HARD-blocks a destructive command (no gate, no run)', async () => {
    const sb = fakeSandbox(true);
    const r = await makeExec(sb).bash('rm -rf /', ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/refused|blocked/i);
    expect(gate).not.toHaveBeenCalled();
    expect(sb.run).not.toHaveBeenCalled();
  });
  it('runs a normal command in the sandbox after the gate, checkpointing first', async () => {
    const sb = fakeSandbox(true);
    const r = await makeExec(sb).bash('npm test', ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain('ran: npm test');
    expect(gate).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(sb.run).toHaveBeenCalledTimes(1);
    // network flag threads through from ctx
    expect(sb.run.mock.calls[0][1]).toMatchObject({ cwd: expect.any(String), network: false });
  });
  it('threads bashNetwork through to the sandbox AND the gate card (#8)', async () => {
    const sb = fakeSandbox(true);
    await makeExec(sb).bash('npm test', ctx({ bashNetwork: true }));
    expect(sb.run.mock.calls[0][1]).toMatchObject({ network: true });
    expect(gate.mock.calls[0][0]).toMatchObject({ network: true }); // card can't lie about network
    gate.mockClear();
    const sb2 = fakeSandbox(true);
    await new MystiLocalExec(tools, sb2).bash('npm test', ctx());
    expect(gate.mock.calls[0][0]).toMatchObject({ network: false });
  });
  it('flags remote-effect commands to the gate (Phase 3 modal); local ones are not flagged', async () => {
    const sb = fakeSandbox(true);
    await makeExec(sb).bash('git push origin main', ctx());
    expect(gate.mock.calls[0][0]).toMatchObject({ kind: 'bash', remoteEffect: true });
    gate.mockClear();
    const sb2 = fakeSandbox(true);
    await new MystiLocalExec(tools, sb2).bash('npm test', ctx());
    expect(gate.mock.calls[0][0]).toMatchObject({ remoteEffect: false });
  });
  it('a gate DENY does not run', async () => {
    const sb = fakeSandbox(true);
    gate.mockResolvedValue(false);
    const r = await makeExec(sb).bash('npm test', ctx());
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
    expect(sb.run).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it('when NO sandbox is available, only genuinely READ-ONLY commands run', async () => {
    const sb = fakeSandbox(false);
    const ok = await makeExec(sb).bash('git status', ctx()); // read-only
    expect(ok.ok).toBe(true);
    expect(sb.run).toHaveBeenCalledTimes(1);

    // A build/test command (runs repo code) is REFUSED without a sandbox.
    const sb2 = fakeSandbox(false);
    const build = await new MystiLocalExec(tools, sb2).bash('npm test', ctx());
    expect(build.ok).toBe(false);
    expect(build.output).toMatch(/no OS sandbox/i);
    expect(sb2.run).not.toHaveBeenCalled();

    // A redirect (write) is likewise refused.
    const sb3 = fakeSandbox(false);
    const denied = await new MystiLocalExec(tools, sb3).bash('echo hi > file', ctx());
    expect(denied.ok).toBe(false);
    expect(sb3.run).not.toHaveBeenCalled();
  });
  it('a compound command is never auto-safe (must still gate) and refused without a sandbox', async () => {
    const sb = fakeSandbox(false);
    const r = await makeExec(sb).bash('ls && whoami', ctx()); // compound → not safe-listed
    expect(r.ok).toBe(false);
    expect(sb.run).not.toHaveBeenCalled();
  });
  it('reports a non-zero exit as not-ok', async () => {
    const sb = fakeSandbox(true, { code: 1, stdout: '', stderr: 'boom' });
    const r = await makeExec(sb).bash('npm test', ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain('exit 1');
    expect(r.output).toContain('boom');
  });
  it('refuses when disabled or untrusted (no screen, no run)', async () => {
    const sb = fakeSandbox(true);
    expect((await makeExec(sb).bash('npm test', ctx({ enabled: false }))).ok).toBe(false);
    expect((await makeExec(sb).bash('npm test', ctx({ workspaceTrusted: false }))).ok).toBe(false);
    expect(sb.run).not.toHaveBeenCalled();
  });
});
