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
 * macOS Gatekeeper execution-block detection.
 *
 * A Gatekeeper block SIGKILLs a CLI before it runs, so Mysti only ever saw
 * "exited with code 1" while macOS separately told the user the binary
 * "contains malware" — an alarming dialog with no actionable explanation on
 * our side. These tests pin two properties that matter more than the happy
 * path: the probe never fires off-darwin, and a binary is NEVER reported as
 * blocked unless `spctl` confirms a verdict that actually stops execution
 * (ad-hoc signed binaries are routinely "rejected" and run perfectly well).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  looksLikeOsExecutionBlock,
  assessExecutable,
  describeOsExecutionBlock,
  resolveAssessableBinary,
  _resetGatekeeperCacheForTests,
} from '../../src/utils/gatekeeper';

/** The exact spctl output for the revoked OpenAI Developer ID certificate. */
const REVOKED_OUTPUT =
  '/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex: CSSMERR_TP_CERT_REVOKED';

beforeEach(() => _resetGatekeeperCacheForTests());
afterEach(() => _resetGatekeeperCacheForTests());

describe('looksLikeOsExecutionBlock', () => {
  const base = { exitCode: 1, stderr: '', hasOutput: false, platform: 'darwin' as NodeJS.Platform };

  it('never fires off macOS — Gatekeeper does not exist there', () => {
    expect(looksLikeOsExecutionBlock({
      ...base,
      platform: 'linux',
      exitCode: 137,
      stderr: 'Killed: 9 — contains malware',
    })).toBe(false);
    expect(looksLikeOsExecutionBlock({ ...base, platform: 'win32', exitCode: 137 })).toBe(false);
  });

  it('fires on a SIGKILL that produced no output (the kernel-refusal signature)', () => {
    expect(looksLikeOsExecutionBlock({ ...base, exitCode: null, signal: 'SIGKILL' })).toBe(true);
  });

  it('does NOT fire on a SIGKILL that came after real output — that is our own cancel', () => {
    expect(looksLikeOsExecutionBlock({
      ...base, exitCode: null, signal: 'SIGKILL', hasOutput: true,
    })).toBe(false);
  });

  it('fires on shell-reported SIGKILL (137) and not-executable (126)', () => {
    expect(looksLikeOsExecutionBlock({ ...base, exitCode: 137 })).toBe(true);
    expect(looksLikeOsExecutionBlock({ ...base, exitCode: 126 })).toBe(true);
  });

  it('fires on the phrases macOS and npm shims emit for a blocked child', () => {
    for (const stderr of [
      'Killed: 9',
      'dyld: code signature invalid',
      '"codex" was not opened because it contains malware',
      'the developer cannot be verified',
      'spawn EACCES',
    ]) {
      expect(looksLikeOsExecutionBlock({ ...base, stderr }), stderr).toBe(true);
    }
  });

  it('does not fire on an ordinary CLI failure', () => {
    expect(looksLikeOsExecutionBlock({
      ...base,
      exitCode: 1,
      stderr: 'Error: model "gpt-5" is not available on your plan',
    })).toBe(false);
  });
});

describe('assessExecutable', () => {
  const deps = (output: string, quarantined = false) => ({
    platform: 'darwin' as NodeJS.Platform,
    run: async () => output,
    resolve: () => '/fake/codex',
    quarantined: () => quarantined,
  });

  it('reports a revoked signing certificate — the real @openai/codex failure', async () => {
    const block = await assessExecutable('codex', deps(REVOKED_OUTPUT));
    expect(block).toEqual({
      reason: 'revoked',
      binaryPath: '/fake/codex',
      detail: REVOKED_OUTPUT,
    });
  });

  it('reports an explicit malware verdict', async () => {
    const block = await assessExecutable('x', deps('/fake/codex: rejected (malware detected)'));
    expect(block?.reason).toBe('malware');
  });

  it('returns nothing for an accepted binary', async () => {
    expect(await assessExecutable('x', deps('/fake/codex: accepted\nsource=Notarized Developer ID'))).toBeNull();
  });

  it('does NOT accuse an ad-hoc signed binary that is merely "rejected"', async () => {
    // Every locally built tool and vendored helper (the ripgrep shipped inside
    // @openai/codex, for one) is linker/ad-hoc signed: spctl rejects it, and it
    // runs fine. Reporting these would be a false accusation.
    const block = await assessExecutable('x', deps('/fake/rg: rejected', /* quarantined */ false));
    expect(block).toBeNull();
  });

  it('DOES report an unnotarized binary once it is quarantined — that one really is blocked', async () => {
    const block = await assessExecutable(
      'x',
      deps('/fake/tool: rejected\nsource=Unnotarized Developer ID', /* quarantined */ true)
    );
    expect(block?.reason).toBe('unnotarized');
  });

  it('never probes off macOS', async () => {
    let ran = false;
    const block = await assessExecutable('codex', {
      platform: 'linux',
      run: async () => { ran = true; return REVOKED_OUTPUT; },
      resolve: () => '/fake/codex',
    });
    expect(block).toBeNull();
    expect(ran).toBe(false);
  });

  it('returns nothing when no assessable binary can be resolved', async () => {
    expect(await assessExecutable('codex', {
      platform: 'darwin',
      run: async () => REVOKED_OUTPUT,
      resolve: () => null,
    })).toBeNull();
  });

  it('caches per binary so a failing turn does not re-shell out to spctl', async () => {
    let calls = 0;
    const d = {
      platform: 'darwin' as NodeJS.Platform,
      run: async () => { calls++; return REVOKED_OUTPUT; },
      resolve: () => '/fake/codex',
    };
    await assessExecutable('codex', d);
    await assessExecutable('codex', d);
    await assessExecutable('codex', d);
    expect(calls).toBe(1);
  });
});

describe('resolveAssessableBinary', () => {
  let tmp: string;

  /** Minimal 64-bit Mach-O magic — enough for the sniffing this module does. */
  function writeMachO(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(0xfeedfacf, 0);
    fs.writeFileSync(filePath, buf);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-gatekeeper-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sees through an npm shim to the vendored native binary macOS actually blocks', () => {
    // The @openai/codex layout: bin/codex.js execs vendor/<triple>/codex/codex.
    const pkg = path.join(tmp, 'node_modules', '@openai', 'codex');
    const shim = path.join(pkg, 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '#!/usr/bin/env node\n');
    const native = path.join(pkg, 'vendor', 'aarch64-apple-darwin', 'codex', 'codex');
    writeMachO(native);

    expect(resolveAssessableBinary(shim)).toBe(fs.realpathSync(native));
  });

  it('follows the PATH symlink npm installs, not just the literal path', () => {
    const pkg = path.join(tmp, 'pkg');
    const shim = path.join(pkg, 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '#!/usr/bin/env node\n');
    writeMachO(path.join(pkg, 'vendor', 'x86_64-apple-darwin', 'codex', 'codex'));

    const binDir = path.join(tmp, 'usr-local-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, 'codex');
    fs.symlinkSync(shim, link);

    expect(resolveAssessableBinary(link)).toContain(path.join('vendor', 'x86_64-apple-darwin'));
  });

  it('returns a directly-installed native binary as-is', () => {
    const native = path.join(tmp, 'bin', 'claude');
    writeMachO(native);
    expect(resolveAssessableBinary(native)).toBe(fs.realpathSync(native));
  });

  it('returns null for a pure script with no vendored binary', () => {
    const shim = path.join(tmp, 'pkg', 'bin', 'tool.js');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '#!/usr/bin/env node\nconsole.log(1)\n');
    expect(resolveAssessableBinary(shim)).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    expect(resolveAssessableBinary(path.join(tmp, 'nope'))).toBeNull();
  });
});

describe('describeOsExecutionBlock', () => {
  const block = { reason: 'revoked' as const, binaryPath: '/usr/local/.../codex', detail: REVOKED_OUTPUT };

  it('names macOS as the actor and clears Mysti and the CLI of blame', () => {
    const msg = describeOsExecutionBlock('Codex', block, 'npm install -g @openai/codex');
    expect(msg).toContain('macOS blocked the Codex CLI');
    expect(msg).toContain('not a Mysti or Codex error');
    expect(msg).toContain('nothing ran on your machine');
  });

  it('leads with the fix and shows the blocked binary', () => {
    const msg = describeOsExecutionBlock('Codex', block, 'npm install -g @openai/codex');
    expect(msg).toContain('npm install -g @openai/codex');
    expect(msg).toContain('/usr/local/.../codex');
    expect(msg).toContain('spctl --assess');
  });

  it('explains a revoked certificate as fixable by updating', () => {
    expect(describeOsExecutionBlock('Codex', block)).toContain('revoked');
    expect(describeOsExecutionBlock('Codex', block)).toContain('re-signed later builds');
  });

  it('still produces a usable message with no install command', () => {
    const msg = describeOsExecutionBlock('Cursor', { ...block, reason: 'malware' });
    expect(msg).toContain('macOS blocked the Cursor CLI');
    expect(msg).not.toContain('undefined');
  });
});
