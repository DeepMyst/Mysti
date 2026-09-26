/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who compacts each backend, derived from the REAL provider declarations
 * (sessionKind + supportsNativeCompact + nativeInstructionFile). If a provider
 * changes its continuity or compaction semantics this table fails loudly,
 * instead of Mysti silently starting (or stopping) to compact that backend.
 */
import { describe, it, expect } from 'vitest';
import { Uri } from 'vscode';
import type * as vscode from 'vscode';
import { CompactionManager } from '../../src/managers/CompactionManager';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { ProviderType } from '../../src/types';

function context(): vscode.ExtensionContext {
  return {
    globalState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist',
    extensionUri: Uri.file('/mock/extension-does-not-exist'),
    extension: { packageJSON: { version: '0.0.0' } },
  } as unknown as vscode.ExtensionContext;
}

const pm = new ProviderManager(context());
const cm = new CompactionManager(context());

// [provider, CLI owns its history, Mysti may auto-compact, Mysti sends the whole history]
const TABLE: Array<[ProviderType, boolean, boolean, boolean]> = [
  // Resumes its own session; native /compact from Mysti.
  ['claude-code', true, true, false],
  // Resume their own sessions and compact themselves; Mysti never does.
  ['google-gemini', true, false, false],
  ['qwen-code', true, false, false],
  ['opencode', true, false, false],
  ['openclaw', true, false, false],
  ['hermes', true, false, false],
  ['kimi-code', true, false, false],
  // Replayed from the last messages; report running usage totals, not fill.
  ['openai-codex', false, false, false],
  ['cline', false, false, false],
  ['continue', false, false, false],
  ['github-copilot', false, false, false],
  // Mysti sends the whole history over HTTP, so Mysti compacts it.
  ['ollama', false, true, true],
  ['localai', false, true, true],
  ['openrouter', false, true, true],
  // sessionKind 'none' but its prompts carry no history (sendsNoHistory):
  // nothing to compact, and summarizing through cursor-agent ran ungated tools.
  ['cursor', false, false, false],
];

describe('compaction ownership per provider', () => {
  it.each(TABLE)('%s: cliOwnsHistory=%s canAutoCompact=%s mystiSendsFullHistory=%s', (id, owns, auto, full) => {
    expect(pm.getProviderInstance(id), `${id} is not registered`).toBeDefined();
    expect(cm.cliOwnsHistory(id, pm)).toBe(owns);
    expect(cm.canAutoCompact(id, pm)).toBe(auto);
    expect(cm.mystiSendsFullHistory(id, pm)).toBe(full);
  });

  it('Cursor keeps no history; the HTTP backends are not mistaken for it', () => {
    expect(cm.keepsNoHistory('cursor', pm)).toBe(true);
    expect(cm.keepsNoHistory('ollama', pm)).toBe(false);
    expect(cm.keepsNoHistory('claude-code', pm)).toBe(false);
  });

  it('declares the instruction file each CLI already loads itself', () => {
    const native = (id: ProviderType) => pm.getProviderInstance(id)?.capabilities?.nativeInstructionFile;
    expect(native('claude-code')).toBe('CLAUDE.md');
    expect(native('google-gemini')).toBe('GEMINI.md');
    expect(native('openai-codex')).toBe('AGENTS.md');
    expect(native('opencode')).toBe('AGENTS.md');
    // Unverified for the rest: they keep receiving every file.
    expect(native('qwen-code')).toBeUndefined();
    expect(native('ollama')).toBeUndefined();
  });
});
