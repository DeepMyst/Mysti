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
 * The backend's own section of the slash menu, and what picking a row does.
 *
 * The interesting property is that a native command has THREE possible fates —
 * sent to the CLI, expanded from the user's own file, or handled by Mysti —
 * and picking the wrong one fails quietly: a `/compact` sent to a CLI with no
 * headless slash parser arrives as prose the model politely answers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig, resetWindowStubs } from '../helpers/mockVscode';
import { SlashCommandManager } from '../../src/managers/SlashCommandManager';
import { NativeCommandDiscovery, type NativeCommandFs } from '../../src/services/NativeCommandDiscovery';
import type { NativeCommandSpec } from '../../src/providers/base/NativeCommands';
import type { ProviderType, WebviewMessage } from '../../src/types';

const HOME = '/home/dev';
const WORKSPACE = '/repo';

function fakeFs(files: Record<string, string>): NativeCommandFs {
  return {
    readdirSync(dir) {
      const base = dir.replace(/\/+$/, '') + '/';
      const seen = new Map<string, boolean>();
      for (const full of Object.keys(files)) {
        if (!full.startsWith(base)) { continue; }
        const rest = full.slice(base.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (name && !seen.has(name)) { seen.set(name, slash !== -1); }
      }
      if (seen.size === 0) { throw new Error(`ENOENT: ${dir}`); }
      return [...seen.entries()].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    },
    readFileSync(file) {
      const content = files[file];
      if (content === undefined) { throw new Error(`ENOENT: ${file}`); }
      return content;
    },
    statSize(file) {
      const content = files[file];
      if (content === undefined) { throw new Error(`ENOENT: ${file}`); }
      return Buffer.byteLength(content);
    },
  };
}

interface Harness {
  manager: SlashCommandManager;
  discovery: NativeCommandDiscovery;
}

function makeHarness(options: {
  files?: Record<string, string>;
  dynamic?: NativeCommandSpec[];
} = {}): Harness {
  const discovery = new NativeCommandDiscovery({
    fs: fakeFs(options.files ?? {}),
    homeDir: HOME,
    getWorkspaceRoot: () => WORKSPACE,
    ttlMs: 0,
  });

  const manager = new SlashCommandManager({
    providerManager: {
      getAllProviders: () => [],
      getAllProviderIds: () => ['claude-code', 'hermes', 'openai-codex'],
      getProviderInstance: () => ({
        id: 'stub',
        displayName: 'Stub',
        getDynamicNativeCommands: () => options.dynamic ?? [],
      }),
    } as any,
    contextManager: {} as any,
    conversationManager: {} as any,
    compactionManager: {} as any,
    memoryManager: {} as any,
    brainstormManager: {} as any,
    nativeCommandDiscovery: discovery,
  });

  return { manager, discovery };
}

function makeCallbacks(posted: Array<{ panelId: string; message: WebviewMessage }> = []) {
  return {
    postToPanel: (panelId: string, message: WebviewMessage) => posted.push({ panelId, message }),
    updateSettings: async () => {},
    getPanelProvider: () => 'claude-code',
    getPanelModel: () => 'model',
    getModelsForProvider: () => [],
    executeManualCompaction: async () => {},
  } as any;
}

function nativeRows(manager: SlashCommandManager, provider: ProviderType) {
  const { commands } = manager.getCommands('panel-1', provider, makeCallbacks());
  return commands.filter((c) => c.section === 'native');
}

beforeEach(() => {
  clearMockConfig();
  resetWindowStubs();
});

describe('the provider-native menu section', () => {
  it('is titled after the backend whose commands it holds', () => {
    const { manager } = makeHarness();
    const { sections } = manager.getCommands('panel-1', 'claude-code', makeCallbacks());
    const native = sections.find((s) => s.id === 'native');
    expect(native?.label).toBe('Claude Code commands');

    const gemini = manager.getCommands('panel-1', 'google-gemini', makeCallbacks())
      .sections.find((s) => s.id === 'native');
    expect(gemini?.label).toBe('Gemini commands');
  });

  it('shows only the active backend\'s commands', () => {
    const { manager } = makeHarness();
    const rows = nativeRows(manager, 'claude-code');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.provider === 'claude-code')).toBe(true);
    expect(rows.map((c) => c.label)).toContain('/compact');
    expect(rows.map((c) => c.label)).toContain('/security-review');
  });

  it('carries the bare name the backend knows, not the display label', () => {
    const { manager } = makeHarness();
    const compact = nativeRows(manager, 'claude-code').find((c) => c.label === '/compact');
    expect(compact?.id).toBe('native:claude-code:compact');
    expect(compact?.nativeName).toBe('compact');
  });

  /**
   * `isCliPassthrough` tells the webview "this row becomes a turn". A row that
   * runs a Mysti command must not claim it, or the composer would send text.
   */
  it('flags only the rows that actually reach the CLI as pass-through', () => {
    const { manager } = makeHarness();
    const rows = nativeRows(manager, 'claude-code');
    expect(rows.find((c) => c.label === '/compact')?.isCliPassthrough).toBe(true);
    expect(rows.find((c) => c.label === '/clear')?.isCliPassthrough).toBe(false);
  });

  it('omits the section entirely for a backend with no CLI', () => {
    const { manager } = makeHarness();
    const { sections, commands } = manager.getCommands('panel-1', 'ollama', makeCallbacks());
    expect(commands.filter((c) => c.section === 'native')).toEqual([]);
    expect(sections.find((s) => s.id === 'native')).toBeUndefined();
  });

  it('adds the user\'s own commands next to the built-ins, badged by source', async () => {
    const { manager, discovery } = makeHarness({
      files: {
        [`${WORKSPACE}/.claude/commands/deploy.md`]: '---\ndescription: Ship it\n---\nDeploy $ARGUMENTS',
        [`${HOME}/.claude/skills/design/SKILL.md`]: '---\ndescription: Create a design canvas\n---\nDesign.',
      },
    });
    await discovery.refresh('claude-code');

    const rows = nativeRows(manager, 'claude-code');
    const deploy = rows.find((c) => c.label === '/deploy');
    const design = rows.find((c) => c.label === '/design');
    expect(deploy?.origin).toBe('project');
    expect(design?.origin).toBe('user');
    expect(design?.description).toBe('Create a design canvas');
    expect(rows.find((c) => c.label === '/compact')?.origin).toBe('builtin');
  });

  /** A repo file must not be able to redefine what `/compact` means. */
  it('does not let a discovered file shadow a built-in of the same name', async () => {
    const { manager, discovery } = makeHarness({
      files: {
        [`${WORKSPACE}/.claude/commands/compact.md`]: '---\ndescription: Impostor\n---\nbody',
      },
    });
    await discovery.refresh('claude-code');

    const compacts = nativeRows(manager, 'claude-code').filter((c) => c.label === '/compact');
    expect(compacts).toHaveLength(1);
    expect(compacts[0].origin).toBe('builtin');
  });

  it('includes the commands an ACP agent reported for this session', () => {
    const { manager } = makeHarness({
      dynamic: [{
        name: 'web',
        description: 'Search the web',
        execution: { kind: 'passthrough' },
      }],
    });
    const web = nativeRows(manager, 'hermes').find((c) => c.label === '/web');
    expect(web?.origin).toBe('agent');
    expect(web?.id).toBe('native:hermes:web');
  });
});

describe('running a native command', () => {
  it('sends a verified built-in to the backend verbatim', () => {
    const { manager } = makeHarness();
    expect(manager.resolveNativeCommand('native:claude-code:compact', 'panel-1', 'claude-code', ''))
      .toEqual({ kind: 'prompt', text: '/compact' });
    expect(manager.resolveNativeCommand('native:claude-code:compact', 'panel-1', 'claude-code', 'keep the API notes'))
      .toEqual({ kind: 'prompt', text: '/compact keep the API notes' });
  });

  /**
   * Firing `/goal` with no condition wastes a turn the user cannot see. But the
   * distinction is REQUIRED (`<condition>`) versus OPTIONAL (`[instructions]`):
   * treating every hint as required would make a bare `/compact` — the single
   * most common native command — impossible to run from the menu.
   */
  it('prefills a command that requires arguments, and only that', () => {
    const { manager } = makeHarness();
    expect(manager.resolveNativeCommand('native:claude-code:goal', 'panel-1', 'claude-code', ''))
      .toEqual({ kind: 'prefill', text: '/goal ' });
    expect(manager.resolveNativeCommand('native:claude-code:goal', 'panel-1', 'claude-code', 'tests pass'))
      .toEqual({ kind: 'prompt', text: '/goal tests pass' });

    // Optional argument: runs bare.
    expect(manager.resolveNativeCommand('native:claude-code:review', 'panel-1', 'claude-code', ''))
      .toEqual({ kind: 'prompt', text: '/review' });
  });

  it('routes a mapped command to Mysti rather than to one backend', () => {
    const { manager } = makeHarness();
    expect(manager.resolveNativeCommand('native:claude-code:clear', 'panel-1', 'claude-code', ''))
      .toEqual({ kind: 'mysti', commandId: 'cmd:clear' });
    expect(manager.resolveNativeCommand('native:openai-codex:compact', 'panel-1', 'openai-codex', ''))
      .toEqual({ kind: 'mysti', commandId: 'cmd:compact' });
  });

  /**
   * Codex is the case that makes `expand` necessary: `codex exec` has no slash
   * parser, so the prompt file the user wrote is what gets sent.
   */
  it('expands a template for a backend that cannot resolve slash commands', async () => {
    const { manager, discovery } = makeHarness({
      files: { [`${HOME}/.codex/prompts/refactor.md`]: 'Refactor $ARGUMENTS carefully.' },
    });
    await discovery.refresh('openai-codex');
    expect(manager.resolveNativeCommand('native:openai-codex:refactor', 'panel-1', 'openai-codex', 'src/app.ts'))
      .toEqual({ kind: 'prompt', text: 'Refactor src/app.ts carefully.' });
  });

  it('passes a discovered command through where the CLI can expand it', async () => {
    const { manager, discovery } = makeHarness({
      files: { [`${WORKSPACE}/.claude/commands/deploy.md`]: '---\ndescription: Ship\n---\nDeploy.' },
    });
    await discovery.refresh('claude-code');
    expect(manager.resolveNativeCommand('native:claude-code:deploy', 'panel-1', 'claude-code', ''))
      .toEqual({ kind: 'prompt', text: '/deploy' });
  });

  it('refuses an id belonging to a different provider', () => {
    const { manager } = makeHarness();
    expect(manager.resolveNativeCommand('native:claude-code:compact', 'panel-1', 'google-gemini', ''))
      .toBeNull();
    expect(manager.resolveNativeCommand('cmd:clear', 'panel-1', 'claude-code', '')).toBeNull();
    expect(manager.resolveNativeCommand('native:claude-code:nope', 'panel-1', 'claude-code', ''))
      .toBeNull();
  });
});

describe('typing a native command by name', () => {
  /**
   * A typed `/name` and the same row clicked must behave identically. They did
   * not: a typed one was forwarded verbatim to the CLI, which for a Codex
   * prompt file means sending a literal `/refactor` the CLI cannot resolve.
   */
  it('resolves a typed name to the same command the menu row runs', async () => {
    const { manager, discovery } = makeHarness({
      files: { [`${HOME}/.codex/prompts/refactor.md`]: 'Refactor $ARGUMENTS.' },
    });
    await discovery.refresh('openai-codex');
    expect(manager.findNativeCommandId('refactor', 'panel-1', 'openai-codex'))
      .toBe('native:openai-codex:refactor');
    expect(manager.findNativeCommandId('compact', 'panel-1', 'claude-code'))
      .toBe('native:claude-code:compact');
  });

  it('leaves an unknown name alone so it still passes through to the backend', () => {
    const { manager } = makeHarness();
    expect(manager.findNativeCommandId('deep-research', 'panel-1', 'claude-code')).toBeNull();
    expect(manager.findNativeCommandId('', 'panel-1', 'claude-code')).toBeNull();
  });

  it('does not claim another backend\'s command', () => {
    const { manager } = makeHarness();
    expect(manager.findNativeCommandId('security-review', 'panel-1', 'google-gemini')).toBeNull();
  });

  /**
   * `/compact` exists on both sides, and Mysti's is the provider-neutral one —
   * it picks native-CLI vs client-side summarization from the backend's
   * capabilities, so it works on the eleven backends whose CLI has no compact
   * at all. Ownership cannot be judged by menu membership: `cmd:compact` has
   * no row and is reachable only by typing, so a membership test alone would
   * hand `/compact` to the backend and bypass CompactionManager entirely.
   */
  it('treats a name Mysti claims as owned even with no menu row', () => {
    const { manager } = makeHarness();
    const callbacks = makeCallbacks();
    const rows = manager.getCommands('panel-1', 'claude-code', callbacks).commands;
    expect(rows.some((c) => c.id === 'cmd:compact'), 'precondition: cmd:compact has no menu row')
      .toBe(false);
    expect(manager.isKnownCommand('cmd:compact', 'panel-1', 'claude-code', callbacks)).toBe(true);
    expect(manager.isKnownCommand('cmd:clear', 'panel-1', 'claude-code', callbacks)).toBe(true);
    // Something Mysti has never claimed still passes through to the backend.
    expect(manager.isKnownCommand('cmd:deep-research', 'panel-1', 'claude-code', callbacks)).toBe(false);
  });
});
