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
 * BaseCliProvider surfacing of a macOS execution block.
 *
 * Real failure this covers: a Codex CLI signed with OpenAI's revoked Developer
 * ID certificate is SIGKILLed by Gatekeeper before it runs. Mysti reported
 * "Codex exited with code 1" while macOS showed the user a "Malware Blocked"
 * dialog — an alarming message with nothing actionable on our side. The error
 * chunk must now carry the reinstall instruction instead.
 *
 * The safety property tested alongside it: an ordinary CLI failure must NEVER
 * be relabelled as a code-signing problem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OsExecutionBlock } from '../../src/utils/gatekeeper';

const assessExecutable = vi.fn<(cliPath: string) => Promise<OsExecutionBlock | null>>();
const looksLikeOsExecutionBlock = vi.fn<(signals: unknown) => boolean>();

vi.mock('../../src/utils/gatekeeper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/gatekeeper')>();
  return {
    ...actual,
    assessExecutable: (cliPath: string) => assessExecutable(cliPath),
    looksLikeOsExecutionBlock: (signals: unknown) => looksLikeOsExecutionBlock(signals),
  };
});

const { TestableCodexProvider } = await import('../helpers/providerFactory');

const REVOKED: OsExecutionBlock = {
  reason: 'revoked',
  binaryPath: '/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex',
  detail: 'CSSMERR_TP_CERT_REVOKED',
};

/** Reach the protected helper the two stream error branches call. */
function explain(
  provider: unknown,
  fallback: string,
  signals: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; hasOutput: boolean }
): Promise<string> {
  return (provider as {
    _explainOsExecutionBlock(f: string, s: typeof signals): Promise<string>;
  })._explainOsExecutionBlock(fallback, signals);
}

const KILLED = { exitCode: null, signal: 'SIGKILL' as NodeJS.Signals, stderr: '', hasOutput: false };

describe('BaseCliProvider._explainOsExecutionBlock', () => {
  beforeEach(() => {
    assessExecutable.mockReset();
    looksLikeOsExecutionBlock.mockReset();
  });

  it('replaces the opaque exit message with an actionable one when macOS blocked the binary', async () => {
    looksLikeOsExecutionBlock.mockReturnValue(true);
    assessExecutable.mockResolvedValue(REVOKED);
    const provider = new TestableCodexProvider();

    const message = await explain(provider, 'Codex exited with code 1', KILLED);

    expect(message).not.toBe('Codex exited with code 1');
    expect(message).toContain('macOS blocked');
    expect(message).toContain('revoked');
    // The fix must be present and provider-correct.
    expect(message).toContain(provider.getInstallCommand());
    expect(message).toContain(REVOKED.binaryPath);
  });

  it('leaves an ordinary CLI failure untouched — no false signing accusation', async () => {
    looksLikeOsExecutionBlock.mockReturnValue(false);
    assessExecutable.mockResolvedValue(REVOKED);
    const provider = new TestableCodexProvider();

    const original = 'Error: you have exceeded your usage limit';
    expect(await explain(provider, original, { exitCode: 1, signal: null, stderr: original, hasOutput: false }))
      .toBe(original);
    // Never even probes for a failure that does not look like an OS kill.
    expect(assessExecutable).not.toHaveBeenCalled();
  });

  it('keeps the original message when the failure looked like a block but spctl cleared the binary', async () => {
    looksLikeOsExecutionBlock.mockReturnValue(true);
    assessExecutable.mockResolvedValue(null);
    const provider = new TestableCodexProvider();

    expect(await explain(provider, 'Codex exited with code 137', KILLED)).toBe('Codex exited with code 137');
  });

  it('falls back to the original message when the assessment itself throws', async () => {
    looksLikeOsExecutionBlock.mockReturnValue(true);
    assessExecutable.mockRejectedValue(new Error('spctl missing'));
    const provider = new TestableCodexProvider();

    expect(await explain(provider, 'Codex exited with code 1', KILLED)).toBe('Codex exited with code 1');
  });

  it('passes the resolved CLI path to the assessment', async () => {
    looksLikeOsExecutionBlock.mockReturnValue(true);
    assessExecutable.mockResolvedValue(REVOKED);
    const provider = new TestableCodexProvider();

    await explain(provider, 'boom', KILLED);

    expect(assessExecutable).toHaveBeenCalledOnce();
    expect(assessExecutable.mock.calls[0][0]).toBeTruthy();
  });
});
