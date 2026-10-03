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
 */

/**
 * macOS Gatekeeper / XProtect execution-block detection.
 *
 * When macOS refuses to execute a CLI's native binary, the process is SIGKILLed
 * by the kernel before a single byte of the CLI's own code runs. Mysti saw only
 * "exited with code 1" / "No response received from CLI" and told the user
 * nothing they could act on, while macOS separately showed a "Malware Blocked"
 * dialog that appears to blame Mysti.
 *
 * The real-world trigger for this is not malware. OpenAI revoked its own
 * "Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)" certificate in April
 * 2026 after a compromised `axios` build dependency reached the workflow that
 * held its macOS signing material. Everything signed with it — including every
 * @openai/codex build before CLI 0.119.0 — now fails Gatekeeper with
 * CSSMERR_TP_CERT_REVOKED, which macOS words as "contains malware". The fix is
 * to reinstall the CLI, so that is what this module makes the extension say.
 *
 * Design constraints:
 * - NEVER guess. A message accusing a user's binary of being blocked is only
 *   emitted after `spctl` confirms it, and only for the verdicts that actually
 *   stop execution (revoked / malware, or unnotarized WITH a quarantine flag).
 *   Ad-hoc and locally built binaries are routinely "rejected" by spctl and run
 *   perfectly well; those are not reported.
 * - Cheap by default. The `spctl` probe only runs after a failure that already
 *   looks like an OS kill, and every verdict is cached for the session.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/** Assessment reasons that genuinely prevent execution. */
export type OsBlockReason = 'revoked' | 'malware' | 'unnotarized' | 'unsigned' | 'unknown';

export interface OsExecutionBlock {
  reason: OsBlockReason;
  /** The Mach-O that was assessed (may be a vendored binary behind a shim). */
  binaryPath: string;
  /** Raw `spctl` output, for logs. */
  detail: string;
}

/** Signals available at the point a CLI run failed. */
export interface ExecutionFailureSignals {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stderr: string;
  hasOutput: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Phrases macOS (or a launcher shim reporting on its child) emits when the
 * kernel refuses to execute a binary. Matching one is enough on its own to
 * warrant the `spctl` probe.
 */
const OS_BLOCK_STDERR_PATTERNS: RegExp[] = [
  /killed:\s*9/i,
  /\bcode\s?signature\b/i,
  /\bcodesign\b/i,
  /contains malware/i,
  /malicious software/i,
  /was not opened/i,
  /cannot be opened because/i,
  /developer cannot be verified/i,
  /\bgatekeeper\b/i,
  /\bxprotect\b/i,
  // spawn(2) refusals for a file that exists but the kernel will not exec.
  /\b(EACCES|EPERM|ENOEXEC)\b/,
];

/** 128 + SIGKILL(9); shells report an OS-killed child this way. */
const EXIT_SIGKILLED = 137;
/** POSIX "found but not executable". */
const EXIT_NOT_EXECUTABLE = 126;

const MACH_O_MAGICS = new Set([
  0xfeedface, // 32-bit
  0xfeedfacf, // 64-bit
  0xcefaedfe, // 32-bit, byte-swapped
  0xcffaedfe, // 64-bit, byte-swapped
  0xcafebabe, // universal ("fat")
  0xbebafeca, // universal, byte-swapped
]);

/** Session cache: a revocation does not change while the window is open. */
const _assessmentCache = new Map<string, OsExecutionBlock | null>();

/** Test seam — the cache would otherwise leak verdicts across cases. */
export function _resetGatekeeperCacheForTests(): void {
  _assessmentCache.clear();
}

/**
 * Does this failure look like the OS killed the binary rather than the CLI
 * failing on its own? Deliberately permissive: it only decides whether the
 * `spctl` probe is worth running, and `assessExecutable` makes the real call.
 */
export function looksLikeOsExecutionBlock(signals: ExecutionFailureSignals): boolean {
  const platform = signals.platform ?? process.platform;
  if (platform !== 'darwin') { return false; }

  if (OS_BLOCK_STDERR_PATTERNS.some(re => re.test(signals.stderr))) { return true; }
  if (signals.exitCode === EXIT_SIGKILLED || signals.exitCode === EXIT_NOT_EXECUTABLE) { return true; }
  // A SIGKILL we did not send, with nothing streamed first, is the signature of
  // a kernel-level refusal — a CLI that got far enough to do real work would
  // normally have emitted something.
  if (signals.signal === 'SIGKILL' && !signals.hasOutput) { return true; }
  return false;
}

/** Read the first four bytes and test them against the Mach-O magics. */
function isMachO(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) { return false; }
    return MACH_O_MAGICS.has(buf.readUInt32BE(0)) || MACH_O_MAGICS.has(buf.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Bounded search for a Mach-O named `name` under `dir`. */
function findMachO(dir: string, name: string, depth: number): string | null {
  if (depth < 0) { return null; }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(full);
    } else if (entry.isFile() && entry.name === name && isMachO(full)) {
      return full;
    }
  }
  for (const sub of subdirs) {
    const hit = findMachO(sub, name, depth - 1);
    if (hit) { return hit; }
  }
  return null;
}

/**
 * The Mach-O that macOS would actually assess for `cliPath`.
 *
 * Many CLIs ship as an npm shim (`<pkg>/bin/<name>.js`) that execs a vendored
 * native binary (`<pkg>/vendor/<triple>/<name>/<name>` for @openai/codex).
 * Gatekeeper blocks the *vendored* binary, so assessing the shim would report
 * nothing. Resolve the symlink, and if the target is a script, search the
 * package root's `vendor/` and `bin/` trees for a same-named Mach-O.
 */
export function resolveAssessableBinary(cliPath: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(cliPath);
  } catch {
    return null;
  }
  if (isMachO(real)) { return real; }

  const name = path.basename(real, path.extname(real));
  // <pkg>/bin/<name>.js -> <pkg>
  const packageRoot = path.dirname(path.dirname(real));
  for (const sub of ['vendor', 'bin']) {
    const candidate = path.join(packageRoot, sub);
    const hit = findMachO(candidate, name, 4);
    if (hit) { return hit; }
  }
  return null;
}

/**
 * True when the file carries the quarantine flag macOS sets on downloaded
 * content. Node exposes no xattr API, so this shells out to `xattr -p`, which
 * exits non-zero when the attribute is absent. Async on purpose: this runs on
 * the extension host, where a synchronous exec would stall the event loop.
 */
function isQuarantined(binaryPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('xattr', ['-p', 'com.apple.quarantine', binaryPath], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

function execFileText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}${stderr ?? ''}`);
    });
  });
}

/**
 * Ask macOS whether it would let this binary run. Returns null when the binary
 * is fine, cannot be found, or is merely ad-hoc signed (rejected by `spctl` but
 * perfectly runnable) — only verdicts that genuinely stop execution come back.
 */
export async function assessExecutable(
  cliPath: string,
  deps: {
    platform?: NodeJS.Platform;
    run?: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
    resolve?: (cliPath: string) => string | null;
    quarantined?: (binaryPath: string) => boolean | Promise<boolean>;
  } = {}
): Promise<OsExecutionBlock | null> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') { return null; }

  const resolver = deps.resolve ?? resolveAssessableBinary;
  const binaryPath = resolver(cliPath);
  if (!binaryPath) { return null; }

  if (_assessmentCache.has(binaryPath)) {
    return _assessmentCache.get(binaryPath) ?? null;
  }

  const run = deps.run ?? execFileText;
  const output = await run('spctl', ['--assess', '--type', 'execute', binaryPath], 5000);

  let verdict: OsExecutionBlock | null = null;
  if (/CSSMERR_TP_CERT_REVOKED/i.test(output)) {
    verdict = { reason: 'revoked', binaryPath, detail: output.trim() };
  } else if (/malware|malicious/i.test(output)) {
    verdict = { reason: 'malware', binaryPath, detail: output.trim() };
  } else if (/rejected/i.test(output)) {
    // An unnotarized or unsigned binary only actually fails to launch when it
    // carries the quarantine flag. Ad-hoc signed binaries (every locally built
    // tool, and vendored helpers like ripgrep) are "rejected" here and run fine,
    // so reporting them would be a false accusation.
    const reason: OsBlockReason = /notariz/i.test(output)
      ? 'unnotarized'
      : /not signed/i.test(output) ? 'unsigned' : 'unknown';
    const quarantined = deps.quarantined ?? isQuarantined;
    verdict = (await quarantined(binaryPath)) ? { reason, binaryPath, detail: output.trim() } : null;
  }

  _assessmentCache.set(binaryPath, verdict);
  return verdict;
}

/**
 * The user-facing explanation. Names the OS as the actor (macOS blocked it, the
 * CLI never ran), gives the reason, and leads with the action that fixes it.
 */
export function describeOsExecutionBlock(
  displayName: string,
  block: OsExecutionBlock,
  installCommand?: string
): string {
  const why: Record<OsBlockReason, string> = {
    revoked: `its code-signing certificate has been revoked by Apple (the vendor re-signed later builds, so an update fixes it)`,
    malware: `macOS flagged the binary itself`,
    unnotarized: `the binary is not notarized and is quarantined`,
    unsigned: `the binary is unsigned and is quarantined`,
    unknown: `macOS rejected its signature`,
  };

  const lines = [
    `macOS blocked the ${displayName} CLI from running — ${why[block.reason]}. ${displayName} never started, so this is not a Mysti or ${displayName} error, and nothing ran on your machine.`,
    ``,
    `Blocked binary: ${block.binaryPath}`,
  ];

  if (installCommand) {
    lines.push(``, `Reinstall the CLI to get a build with a valid signature:`, `    ${installCommand}`);
  }
  lines.push(``, `Verify at any time with:`, `    spctl --assess -vv --type execute "${block.binaryPath}"`);

  return lines.join('\n');
}
