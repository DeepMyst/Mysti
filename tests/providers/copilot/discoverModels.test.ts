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
 * Plan 01 Phase 3 — CopilotProvider.discoverModels.
 *
 * The Copilot CLI has no `list models` subcommand, but `--model` is a CLOSED
 * enum whose choices are printed in `copilot --help`. The fixture below is
 * verbatim (hard wrapping included) from `copilot --help` so the parser is
 * tested against the shape it actually meets, not a tidied-up one.
 */
import { describe, it, expect, vi } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';

/** Verbatim slice of real `copilot --help` output, wrapping preserved. */
const REAL_HELP = [
  '  --agent <agent>                     Specify a custom agent to use, only in',
  '                                      prompt mode',
  '  --model <model>                     Set the AI model to use (choices:',
  '                                      "claude-sonnet-4.5", "claude-haiku-4.5",',
  '                                      "claude-opus-4.5", "claude-sonnet-4",',
  '                                      "gpt-5.1-codex-max", "gpt-5.1-codex",',
  '                                      "gpt-5.2", "gpt-5.1", "gpt-5",',
  '                                      "gpt-5.1-codex-mini", "gpt-5-mini",',
  '                                      "gpt-4.1", "gemini-3-pro-preview")',
  '  --no-auto-update                    Disable downloading CLI update',
  '                                      automatically',
].join('\n');

function withHelpOutput(provider: TestableCopilotProvider, output: string | null) {
  const spy = vi.fn(async () => output);
  (provider as unknown as { _runCliForDiscovery: unknown })._runCliForDiscovery = spy;
  return spy;
}

describe('CopilotProvider.discoverModels (Plan 01 Phase 3)', () => {
  it('parses every --model choice out of the hard-wrapped help text', async () => {
    const provider = new TestableCopilotProvider();
    const spy = withHelpOutput(provider, REAL_HELP);

    const models = await provider.discoverModels(5000);

    expect(spy).toHaveBeenCalledWith(['--help'], 5000);
    expect(models?.map(m => m.id)).toEqual([
      'claude-sonnet-4.5', 'claude-haiku-4.5', 'claude-opus-4.5', 'claude-sonnet-4',
      'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.2', 'gpt-5.1', 'gpt-5',
      'gpt-5.1-codex-mini', 'gpt-5-mini', 'gpt-4.1', 'gemini-3-pro-preview',
    ]);
    // Every entry is self-labelled (the help text carries no display names).
    expect(models?.every(m => m.name === m.id)).toBe(true);
  });

  it('returns null when the CLI is unavailable (registry keeps the curated list)', async () => {
    const provider = new TestableCopilotProvider();
    withHelpOutput(provider, null);
    await expect(provider.discoverModels(5000)).resolves.toBeNull();
  });

  it('returns null when the help text no longer advertises a choices list', async () => {
    const provider = new TestableCopilotProvider();
    // A reworded --model line (free-form, no enum) must NOT be mis-parsed into
    // garbage model ids — better to keep serving curated than to invent a list.
    withHelpOutput(provider, '  --model <model>   Set the AI model to use\n  --banner   Show the banner');
    await expect(provider.discoverModels(5000)).resolves.toBeNull();
  });

  it('dedupes repeated ids', async () => {
    const provider = new TestableCopilotProvider();
    withHelpOutput(provider, '--model <model> Set the AI model to use (choices: "gpt-5", "gpt-5", "gpt-4.1")');
    const models = await provider.discoverModels(5000);
    expect(models?.map(m => m.id)).toEqual(['gpt-5', 'gpt-4.1']);
  });
});
