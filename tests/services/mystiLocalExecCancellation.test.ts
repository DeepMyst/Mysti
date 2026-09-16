import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { MystiLocalExec, type LocalExecContext } from '../../src/services/MystiLocalExec';
import { MystiLocalTools } from '../../src/services/MystiLocalTools';
import type { SandboxRunOpts } from '../../src/services/MystiSandbox';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('local execution observes Stop after awaited preparation', () => {
  let root: string;
  let exec: MystiLocalExec;
  let cancelled: boolean;
  let context: LocalExecContext;
  let run: ReturnType<typeof vi.fn>;
  const kinds = ['write', 'edit', 'patch', 'bash', 'skillrun'] as const;
  type Kind = typeof kinds[number];
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mysti-stop-exec-'));
    fs.writeFileSync(path.join(root, 'existing.txt'), 'before\n');
    fs.writeFileSync(path.join(root, 'delete.txt'), 'keep\n');
    fs.mkdirSync(path.join(root, 'cap'));
    // The injected executor runs this fixed inert child, never model text or a
    // shell. Positive controls prove the process would actually change disk.
    fs.writeFileSync(path.join(root, 'cap', 'run.cjs'),
      "require('fs').writeFileSync(process.argv[2], 'child ran');");
    run = vi.fn(async () => {
      const child = spawnSync(process.execPath, [path.join(root, 'cap', 'run.cjs'), path.join(root, 'process-marker')], {
        shell: false, timeout: 5_000,
      });
      if (child.error) { throw child.error; }
      return { code: child.status, stdout: '', stderr: child.stderr.toString(), sandboxed: true, timedOut: false };
    });
    exec = new MystiLocalExec(new MystiLocalTools({ getWorkspaceRoot: () => root }), {
      available: () => true, resolveInterpreter: async () => process.execPath, run,
    });
    cancelled = false;
    context = {
      enabled: true, workspaceTrusted: true, isCancelled: () => cancelled,
      gate: vi.fn(async () => true), checkpoint: vi.fn(async () => true),
    };
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  function invoke(kind: Kind) {
    if (kind === 'write') { return exec.write('existing.txt', 'after\n', context); }
    if (kind === 'edit') { return exec.edit('existing.txt', 'before', 'after', false, context); }
    if (kind === 'patch') {
      return exec.applyPatch([
        '*** Update: existing.txt', '<<<<<<< SEARCH', 'before', '=======', 'after', '>>>>>>> REPLACE',
        '*** Add: created.txt', 'new', '*** Delete: delete.txt', '*** End',
      ].join('\n'), context);
    }
    if (kind === 'bash') { return exec.bash('node --version', context); }
    return exec.execTool({
      id: 'fixture', name: 'fixture_run', artifactDir: path.join(root, 'cap'),
      interpreter: 'node', script: 'run.cjs',
      inputSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' } } },
    }, {}, context);
  }

  function unchanged() {
    expect(read('existing.txt')).toBe('before\n');
    expect(read('delete.txt')).toBe('keep\n');
    expect(exists('created.txt')).toBe(false);
    expect(exists('process-marker')).toBe(false);
    expect(exists('.mysti/run')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  }

  it.each(kinds)('%s has a working positive control', async kind => {
    const result = await invoke(kind);
    expect(result.ok, result.output).toBe(true);
    if (kind === 'bash' || kind === 'skillrun') {
      expect(read('process-marker')).toBe('child ran');
      expect(run).toHaveBeenCalledOnce();
      if (kind === 'skillrun') { expect(fs.readdirSync(path.join(root, '.mysti/run'))).toEqual([]); }
    } else {
      expect(read('existing.txt')).toBe('after\n');
      if (kind === 'patch') { expect(exists('created.txt')).toBe(true); expect(exists('delete.txt')).toBe(false); }
    }
  });

  it.each(kinds)('%s refuses an already stopped owner without raising a gate', async kind => {
    cancelled = true;
    expect(await invoke(kind)).toMatchObject({ ok: false, denied: true, output: expect.stringMatching(/cancelled/) });
    expect(context.gate).not.toHaveBeenCalled();
    expect(context.checkpoint).not.toHaveBeenCalled();
    unchanged();
  });

  for (const stage of ['gate', 'checkpoint'] as const) {
    it.each(kinds)(`%s cannot start an effect after Stop while ${stage} waits`, async kind => {
      const entered = deferred<void>();
      const resume = deferred<boolean>();
      context[stage] = vi.fn(async () => { entered.resolve(); return resume.promise; });
      const pending = invoke(kind);
      await entered.promise;
      unchanged();
      cancelled = true;
      // Even a late approval/successful snapshot must not restart the owner.
      resume.resolve(true);
      expect(await pending).toMatchObject({ ok: false, denied: true, output: expect.stringMatching(/cancelled/) });
      unchanged();
      if (stage === 'gate') { expect(context.checkpoint).not.toHaveBeenCalled(); }
    });
  }

  it('stops the remaining patch effects and reports a partial change', async () => {
    const write = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      cancelled = true;
    });
    const result = await invoke('patch');
    expect(result).toMatchObject({ ok: false, denied: true, output: expect.stringMatching(/rewind.*partial patch/) });
    expect(read('existing.txt')).toBe('after\n');
    expect(exists('created.txt')).toBe(false);
    expect(read('delete.txt')).toBe('keep\n');
  });

  it.each(kinds)('%s also refuses an aborted signal when the transient owner flag is clear', async kind => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const resume = deferred<boolean>();
    context.signal = controller.signal;
    context.checkpoint = vi.fn(async () => { entered.resolve(); return resume.promise; });
    const pending = invoke(kind);
    await entered.promise;
    controller.abort();
    expect(cancelled).toBe(false);
    resume.resolve(true);
    expect(await pending).toMatchObject({ ok: false, denied: true, output: expect.stringMatching(/cancelled/) });
    unchanged();
  });

  it.each(['bash', 'skillrun'] as const)('%s reports incomplete cleanup even when process output is truncated', async kind => {
    run.mockResolvedValue({ code: 0, stdout: 'x'.repeat(100000), stderr: 'y'.repeat(100000), sandboxed: true, timedOut: false, cleanupIncomplete: true });
    expect(await invoke(kind)).toMatchObject({ ok: false, output: expect.stringContaining('[cleanup incomplete:') });
  });

  it.each(['bash', 'skillrun'] as const)('%s forwards its signal to active execution and cannot report cancelled exit zero as success', async kind => {
    const controller = new AbortController();
    const entered = deferred<void>();
    context.signal = controller.signal;
    run.mockImplementation(async (_command: string, opts: SandboxRunOpts) => {
      expect(opts.signal).toBe(controller.signal);
      entered.resolve();
      await new Promise<void>(resolve => opts.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { code: 0, stdout: 'partial output', stderr: '', sandboxed: true, timedOut: false, cancelled: true };
    });
    const pending = invoke(kind);
    await entered.promise;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, denied: true, output: expect.stringMatching(/\[cancelled\][\s\S]*partial output/) });
    if (kind === 'skillrun') { expect(fs.readdirSync(path.join(root, '.mysti/run'))).toEqual([]); }
  });
});
