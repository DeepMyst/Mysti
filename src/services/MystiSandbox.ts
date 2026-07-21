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

export interface SandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Whether the command actually ran under an OS sandbox. */
  sandboxed: boolean;
  timedOut: boolean;
}

export interface SandboxRunOpts {
  cwd: string;
  /** Allow network egress (default false). */
  network?: boolean;
  timeoutMs?: number;
}

/** The contract MystiLocalExec depends on (so tests can inject a fake). */
export interface SandboxRunner {
  available(): boolean;
  run(command: string, opts: SandboxRunOpts): Promise<SandboxResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

export class MystiSandbox implements SandboxRunner {
  /** Whether a real OS sandbox is available on this platform. */
  available(): boolean {
    if (process.platform === 'darwin') { return fs.existsSync('/usr/bin/sandbox-exec'); }
    if (process.platform === 'linux') { return this._onPath('bwrap'); }
    return false; // win32 — no primitive
  }

  async run(command: string, opts: SandboxRunOpts): Promise<SandboxResult> {
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
    try {
      const plan = this._buildSpawn(command, cwd, network, scratch);
      // Scrub the extension host's secrets from the shell env — the coordinator
      // model is untrusted, and a command like `env` / `printenv` / `node -e`
      // could otherwise dump the `dm_` gateway key or API tokens into output
      // that re-enters the model (review HIGH-3c). Also drops SSH_AUTH_SOCK so a
      // sandboxed command cannot borrow the user's ssh-agent.
      const env = this._scrubEnv(process.env);
      if (scratch) { env.TMPDIR = scratch; env.TMP = scratch; env.TEMP = scratch; }
      return await this._exec(plan.file, plan.args, cwd, env, timeoutMs, plan.sandboxed);
    } finally {
      if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ } }
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
        '--tmpfs', '/tmp',
        '--tmpfs', '/run',        // hides /run/docker.sock etc. (review H)
        '--tmpfs', '/var/run',    // and /var/run when it is a real dir, not a /run symlink (review MED-6)
      );
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
    lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (literal "/dev/tty"))');
    return lines.join('\n');
  }

  private _exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, sandboxed: boolean): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const opts: SpawnOptions = { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
      let child: ReturnType<typeof spawn>;
      const finish = (code: number | null) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout: this._cap(stdout), stderr: this._cap(stderr), sandboxed, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try { child?.kill('SIGKILL'); } catch { /* already gone */ }
        finish(null);
      }, timeoutMs);
      try {
        child = spawn(file, args, opts);
      } catch (e) {
        clearTimeout(timer);
        resolve({ code: null, stdout: '', stderr: `sandbox: failed to spawn — ${e instanceof Error ? e.message : e}`, sandboxed, timedOut: false });
        return;
      }
      child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT_CHARS * 2) { stdout += d.toString(); } });
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT_CHARS * 2) { stderr += d.toString(); } });
      child.on('error', (e) => { stderr += `\n${e instanceof Error ? e.message : e}`; finish(null); });
      child.on('close', (code) => finish(code));
    });
  }

  private _cap(s: string): string {
    if (s.length <= MAX_OUTPUT_CHARS) { return s; }
    return s.slice(0, MAX_OUTPUT_CHARS) + `\n… [output truncated at ${MAX_OUTPUT_CHARS} chars]`;
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
      if (SECRET_KEY.test(k) || k === 'SSH_AUTH_SOCK') { continue; }
      if (typeof v === 'string' && SECRET_VALUE.test(v)) { continue; }
      out[k] = v;
    }
    return out;
  }
}
