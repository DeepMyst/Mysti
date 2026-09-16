/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * MystiSandbox (Plan 19 Phase 2, hardened after an adversarial review) — an
 * OS-level sandbox for the Mysti coordinator's `bash` tool. Two goals, enforced
 * by the kernel: (1) NO filesystem writes outside the workspace (+ a private
 * per-run temp dir), (2) NO network — unless network is explicitly enabled.
 *
 *  - macOS  → Seatbelt via `sandbox-exec`. DENY-network, DENY-writes-except
 *             workspace/private-temp, and crucially DENY AppleEvents +
 *             LaunchServices mach-lookup so `open`/`osascript` cannot hand work
 *             to an UNsandboxed launchd child (review C1).
 *  - Linux  → `bwrap --unshare-all` (pid+net+ipc+…; `--share-net` re-adds net
 *             only when requested), read-only root, workspace bind rw, private
 *             `--tmpfs /tmp` and `--tmpfs /run` (hides daemon unix sockets like
 *             docker.sock — review H). `--new-session` blocks TIOCSTI.
 *  - Windows / Linux-without-bwrap → NO primitive. `available()` is false; the
 *             CALLER (MystiLocalExec) then runs ONLY genuinely read-only
 *             allowlisted commands — never arbitrary shell.
 *
 * Read access is broad (builds need system libs); only WRITE and NETWORK (and
 * the launch/daemon escape vectors) are constrained.
 */

import { spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { killProcessTree } from '../utils/processKill';

export interface SandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Whether the command actually ran under an OS sandbox. */
  sandboxed: boolean;
  timedOut: boolean;
  /** The owning run stopped before this command completed. */
  cancelled?: boolean;
  /** Teardown could not confirm closure; surviving descendants may remain. */
  cleanupIncomplete?: boolean;
}

export interface SandboxRunOpts {
  cwd: string;
  /** Allow network egress (default false). */
  network?: boolean;
  timeoutMs?: number;
  /** Run ownership, including cancellation after an approval/checkpoint wait. */
  signal?: AbortSignal;
}

/** The contract MystiLocalExec depends on (so tests can inject a fake). */
export interface SandboxRunner {
  available(): boolean;
  run(command: string, opts: SandboxRunOpts): Promise<SandboxResult>;
  /**
   * Resolve one of the FIXED interpreter keys to an absolute path, or null when
   * it is not installed (Plan 20 Phase 4).
   *
   * Deliberately a closed map rather than a lookup of whatever string an
   * artifact supplies: if a capability could name its own interpreter, it could
   * name any binary on the machine and the permission card would be describing
   * something other than what runs.
   */
  resolveInterpreter(key: 'bash' | 'python3' | 'node'): Promise<string | null>;
}

/**
 * Credential directories a sandboxed command may not read (Plan 20 Phase 4).
 *
 * The profile is allow-by-default for reads because builds legitimately need
 * system libraries, so the interesting secrets have to be carved back out by
 * name. This is not exhaustive and is not claimed to be — it covers the stores
 * an exfiltration attempt reaches for first.
 */
const SANDBOX_DENIED_READ_DIRS = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.config', 'gh'),
  path.join(os.homedir(), '.kube'),
  path.join(os.homedir(), '.docker'),
  path.join(os.homedir(), '.mysti'),
];

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
const CLOSE_GRACE_MS = 1000;

export class MystiSandbox implements SandboxRunner {
  /** Whether a real OS sandbox is available on this platform. */
  available(): boolean {
    if (process.platform === 'darwin') { return fs.existsSync('/usr/bin/sandbox-exec'); }
    if (process.platform === 'linux') { return this._onPath('bwrap'); }
    return false; // win32 — no primitive
  }

  async run(command: string, opts: SandboxRunOpts): Promise<SandboxResult> {
    if (opts.signal?.aborted) {
      return { code: null, stdout: '', stderr: '', sandboxed: false, timedOut: false, cancelled: true };
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const network = !!opts.network;
    // Real path so the profile's subpath rule matches writes under a symlinked
    // workspace (macOS /var → /private/var).
    let cwd = opts.cwd;
    try { cwd = fs.realpathSync(opts.cwd); } catch { /* keep lexical */ }

    // A newline in the cwd or command could inject SBPL rules / smuggle a second
    // bwrap-shell line — refuse rather than sandbox it unsafely (review low).
    if (/[\n\r]/.test(cwd) || /[\n\r]/.test(command)) {
      return { code: null, stdout: '', stderr: 'sandbox: refusing a command or workspace path containing a newline.', sandboxed: false, timedOut: false };
    }

    // macOS: a PRIVATE per-run temp dir (so TMPDIR writes don't need a broad
    // /tmp allow — review medium). Linux uses a private `--tmpfs /tmp` instead.
    let scratch: string | null = null;
    if (process.platform === 'darwin' && this.available()) {
      try { scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-bash-'))); } catch { scratch = null; }
    }
    let preserveScratch = false;
    try {
      const plan = this._buildSpawn(command, cwd, network, scratch);
      // Scrub the extension host's secrets from the shell env — the coordinator
      // model is untrusted, and a command like `env` / `printenv` / `node -e`
      // could otherwise dump the `dm_` gateway key or API tokens into output
      // that re-enters the model (review HIGH-3c). Also drops SSH_AUTH_SOCK so a
      // sandboxed command cannot borrow the user's ssh-agent.
      const env = this._scrubEnv(process.env);
      if (scratch) { env.TMPDIR = scratch; env.TMP = scratch; env.TEMP = scratch; }
      const result = await this._exec(plan.file, plan.args, cwd, env, timeoutMs, plan.sandboxed, opts.signal);
      preserveScratch = !!result.cleanupIncomplete;
      return result;
    } finally {
      if (scratch && !preserveScratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }
  }

  private _buildSpawn(command: string, cwd: string, network: boolean, scratch: string | null): { file: string; args: string[]; sandboxed: boolean } {
    if (process.platform === 'darwin' && this.available()) {
      return { file: '/usr/bin/sandbox-exec', args: ['-p', this._seatbeltProfile(cwd, network, scratch), '/bin/sh', '-c', command], sandboxed: true };
    }
    if (process.platform === 'linux' && this.available()) {
      const args = ['--unshare-all'];
      if (network) { args.push('--share-net'); }
      args.push(
        '--ro-bind', '/', '/',
        '--bind', cwd, cwd,
        // Keep .git/config (remote URLs) + .git/hooks (code-on-git-op) READ-ONLY
        // inside the writable workspace, so a sandboxed command can't redirect
        // `origin` or install a hook that fires on the user's next git op
        // (review round-3 class fix). .git/index etc. stay writable.
        '--ro-bind-try', path.join(cwd, '.git', 'config'), path.join(cwd, '.git', 'config'),
        '--ro-bind-try', path.join(cwd, '.git', 'hooks'), path.join(cwd, '.git', 'hooks'),
        // Plan 20 Phase 4 (I4): agent artifacts read-only, same reasoning as the
        // Seatbelt rule above. The args file a capability reads is written by the
        // HOST before the sandbox starts, so read-only is sufficient.
        '--ro-bind-try', path.join(cwd, '.mysti'), path.join(cwd, '.mysti'),
        '--tmpfs', '/tmp',
        '--tmpfs', '/run',        // hides /run/docker.sock etc. (review H)
        '--tmpfs', '/var/run',    // and /var/run when it is a real dir, not a /run symlink (review MED-6)
      );
      // Credential stores hidden behind empty tmpfs mounts.
      for (const secretDir of SANDBOX_DENIED_READ_DIRS) {
        if (fs.existsSync(secretDir)) { args.push('--tmpfs', secretDir); }
      }
      const xdg = process.env.XDG_RUNTIME_DIR;
      if (xdg && /^\/[^\n\r]*$/.test(xdg)) { args.push('--tmpfs', xdg); }
      args.push(
        '--dev', '/dev',
        '--proc', '/proc',
        '--chdir', cwd,
        '--new-session',
        '--die-with-parent',
        '--', '/bin/sh', '-c', command,
      );
      return { file: 'bwrap', args, sandboxed: true };
    }
    // No sandbox — the caller guarantees only READ-ONLY allowlisted commands here.
    if (process.platform === 'win32') {
      return { file: process.env.COMSPEC || 'cmd.exe', args: ['/c', command], sandboxed: false };
    }
    return { file: '/bin/sh', args: ['-c', command], sandboxed: false };
  }

  /**
   * SBPL profile. Allow-by-default (reads + process-exec a build needs just
   * work) then DENY: network, AppleEvents, and LaunchServices/AppleEvents
   * mach-lookup (so `open`/`osascript` can't launch an unsandboxed sibling —
   * review C1), then DENY all writes and re-allow only workspace + private
   * scratch + std streams. Last matching SBPL rule wins.
   */
  private _seatbeltProfile(cwd: string, network: boolean, scratch: string | null): string {
    const esc = (p: string) => p.replace(/["\\]/g, '\\$&');
    const lines = [
      '(version 1)',
      '(allow default)',
      network ? '(allow network*)' : '(deny network*)',
      // Cut the hand-off-to-launchd escape paths (defense-in-depth; the command
      // block-list also refuses open/osascript).
      '(deny appleevent-send)',
      '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb") (global-name "com.apple.appleeventsd") (global-name "com.apple.coreservices.appleevents"))',
      '(deny file-write*)',
      `(allow file-write* (subpath "${esc(cwd)}"))`,
    ];
    if (scratch) { lines.push(`(allow file-write* (subpath "${esc(scratch)}"))`); }
    // Re-DENY .git/config + .git/hooks inside the allowed workspace (last SBPL
    // match wins) — no sandboxed command can repoint `origin` or plant a hook
    // (review round-3 class fix). .git/index stays writable so `git status` works.
    lines.push(`(deny file-write* (subpath "${esc(path.join(cwd, '.git', 'hooks'))}"))`);
    lines.push(`(deny file-write* (literal "${esc(path.join(cwd, '.git', 'config'))}"))`);
    // Plan 20 Phase 4 (invariant I4): the agent-artifact tree is READ-ONLY to a
    // sandboxed command. `resolveWriteTarget` protects the write/edit/patch
    // directives, but a `bash` command bypasses it entirely — the sandbox is the
    // only real enforcement point for anything a script can touch. Without this
    // a capability could copy itself from staging into the live tree, or forge
    // its own verification record, with one `cp`.
    lines.push(`(deny file-write* (subpath "${esc(path.join(cwd, '.mysti'))}"))`);
    // Credential stores stay unreadable. Reads are allow-by-default here (builds
    // need system libs), so these are carved back out explicitly.
    for (const secretDir of SANDBOX_DENIED_READ_DIRS) {
      lines.push(`(deny file-read* (subpath "${esc(secretDir)}"))`);
    }
    lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (literal "/dev/tty"))');
    return lines.join('\n');
  }

  private _exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, sandboxed: boolean, signal?: AbortSignal): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let cleanupIncomplete = false;
      let settled = false;
      let stopping: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      // Only a detached POSIX spawn owns the negative-pid process group. Never
      // signal the extension host's shared group; Windows uses taskkill /T.
      const opts: SpawnOptions = { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
      let child: ReturnType<typeof spawn>;
      const finish = (code: number | null) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        timer = undefined;
        clearTimeout(closeTimer);
        closeTimer = undefined;
        signal?.removeEventListener('abort', onAbort);
        resolve({ code: timedOut || cancelled || cleanupIncomplete ? null : code, stdout: this._cap(stdout), stderr: this._cap(stderr), sandboxed, timedOut, ...(cancelled ? { cancelled: true } : {}), ...(cleanupIncomplete ? { cleanupIncomplete: true } : {}) });
      };
      const stop = (reason: 'cancelled' | 'timeout') => {
        if (settled || stopping) { return; }
        cancelled = reason === 'cancelled';
        timedOut = reason === 'timeout';
        clearTimeout(timer);
        timer = undefined;
        // A Windows root may already have exited, or a POSIX descendant may
        // have escaped the owned process group while retaining our pipes. Do
        // not guess another PID or hang forever waiting for an unknown tree.
        closeTimer = setTimeout(() => {
          if (settled) { return; }
          cleanupIncomplete = true;
          stderr = 'sandbox: cleanup incomplete — process closure could not be confirmed; descendants may still be running. The sandbox temporary directory, if created, was preserved.\n' + stderr;
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(null);
        }, CLOSE_GRACE_MS);
        // Kill the group even when its leader exited: descendants may still
        // hold stdout/stderr open. The shared helper intentionally skips dead
        // root processes, which would leave this particular group orphaned.
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          try {
            process.kill(-child.pid, 'SIGKILL');
            stopping = Promise.resolve();
            return;
          } catch { /* no group remains, or fall back to the owned child */ }
        }
        stopping = killProcessTree(child, 250, { initialSignal: 'SIGKILL', label: 'coordinator sandbox' });
      };
      const onAbort = () => stop('cancelled');
      if (signal?.aborted) { cancelled = true; finish(null); return; }
      try {
        child = spawn(file, args, opts);
      } catch (e) {
        stderr = `sandbox: failed to spawn — ${e instanceof Error ? e.message : e}`;
        finish(null);
        return;
      }
      child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT_CHARS * 2) { stdout += d.toString(); } });
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT_CHARS * 2) { stderr += d.toString(); } });
      child.on('error', (e) => {
        stderr += `\n${e instanceof Error ? e.message : e}`;
        if (child.pid === undefined) {
          // No process was created, so no descendant can retain the scratch.
          child.stdout?.destroy(); child.stderr?.destroy(); finish(null);
        }
      });
      // close, unlike exit, means inherited output pipes have also closed.
      // Prefer confirmed closure and Windows tree termination; the watchdog
      // reports unconfirmed cleanup without deleting the private temp dir.
      child.on('close', (code) => { void Promise.resolve(stopping).then(() => finish(code)); });
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); }
    });
  }

  private _cap(s: string): string {
    if (s.length <= MAX_OUTPUT_CHARS) { return s; }
    return s.slice(0, MAX_OUTPUT_CHARS) + `\n… [output truncated at ${MAX_OUTPUT_CHARS} chars]`;
  }

  /**
   * Absolute path for a fixed interpreter key. Only these three keys exist; the
   * artifact never supplies a path, so there is no way to point execution at an
   * arbitrary binary.
   */
  async resolveInterpreter(key: 'bash' | 'python3' | 'node'): Promise<string | null> {
    const candidates: Record<string, string[]> = {
      bash: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
      python3: ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'],
      node: ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'],
    };
    for (const abs of candidates[key] || []) {
      if (fs.existsSync(abs)) { return abs; }
    }
    // Fall back to PATH, but still return an ABSOLUTE path so the command that
    // is approved is the command that runs.
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) { continue; }
      const abs = path.join(dir, key);
      if (fs.existsSync(abs)) { return abs; }
    }
    return null;
  }

  private _onPath(bin: string): boolean {
    const dirs = (process.env.PATH || '').split(path.delimiter);
    return dirs.some(d => d && fs.existsSync(path.join(d, bin)));
  }

  /**
   * Drop secret-bearing env vars (and the ssh-agent socket) before handing the
   * environment to a sandboxed shell — the coordinator model is untrusted and
   * must not be able to read the host's API keys / gateway key out of the env.
   */
  private _scrubEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|PRIVATE)/i;
    const SECRET_VALUE = /^(dm_[a-z0-9]|sk-[a-zA-Z0-9]|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-)/;
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(base)) {
      if (SECRET_KEY.test(k) || k === 'SSH_AUTH_SOCK' || k.startsWith('GIT_')) {
        continue;
      }
      if (typeof v === 'string' && SECRET_VALUE.test(v)) { continue; }
      out[k] = v;
    }
    return out;
  }
}
