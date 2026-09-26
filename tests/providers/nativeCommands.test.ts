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
 * The provider-native command catalog.
 *
 * Two things can quietly rot here and neither shows up at runtime as an error:
 * a `mysti` mapping that points at a command id nobody handles (the menu row
 * answers "Unknown command"), and a new provider added without a catalog entry.
 * The Record<ProviderType, …> type catches the second at `tsc` time; these
 * tests catch the first, and pin the id grammar the dispatcher depends on.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  NATIVE_COMMANDS,
  NATIVE_COMMAND_SOURCES,
  nativeCommandId,
  parseNativeCommandId,
  parseAcpAvailableCommands,
  parseClaudeInitCommands,
} from '../../src/providers/base/NativeCommands';

const PROVIDER_IDS = Object.keys(NATIVE_COMMANDS);

describe('native command catalog', () => {
  it('covers every provider in both manifests', () => {
    expect(Object.keys(NATIVE_COMMAND_SOURCES).sort()).toEqual(PROVIDER_IDS.slice().sort());
    expect(PROVIDER_IDS.length).toBeGreaterThanOrEqual(15);
  });

  it('never lists the same command twice for one provider', () => {
    for (const [provider, commands] of Object.entries(NATIVE_COMMANDS)) {
      const names = commands.map((c) => c.name);
      expect(new Set(names).size, `${provider} declares a duplicate command`).toBe(names.length);
    }
  });

  it('uses bare command names — the slash is added when rendering', () => {
    for (const [provider, commands] of Object.entries(NATIVE_COMMANDS)) {
      for (const cmd of commands) {
        expect(cmd.name.startsWith('/'), `${provider}/${cmd.name} keeps its slash`).toBe(false);
        expect(cmd.name).toMatch(/^[a-z0-9][a-z0-9_:-]*$/);
        expect(cmd.description.length, `${provider}/${cmd.name} has no description`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The one that actually bites. A `mysti` mapping is a promise that
   * SlashCommandManager.executeCommand has a `case` for that id; without one
   * the row silently degrades to "Unknown command: …".
   */
  it('every mysti mapping names a command SlashCommandManager handles', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'managers', 'SlashCommandManager.ts'),
      'utf8'
    );
    const handled = new Set(
      [...source.matchAll(/case '([a-z-]+:[a-z-]+)':/g)].map((m) => m[1])
    );
    expect(handled.size, 'the case-scanner matched nothing — fix the regex').toBeGreaterThan(10);

    const dangling: string[] = [];
    for (const [provider, commands] of Object.entries(NATIVE_COMMANDS)) {
      for (const cmd of commands) {
        if (cmd.execution.kind === 'mysti' && !handled.has(cmd.execution.commandId)) {
          dangling.push(`${provider}/${cmd.name} -> ${cmd.execution.commandId}`);
        }
      }
    }
    expect(dangling, 'These map onto a Mysti command that executeCommand has no case for.').toEqual([]);
  });

  it('marks argument-taking commands so they prefill instead of firing early', () => {
    const goal = NATIVE_COMMANDS['claude-code'].find((c) => c.name === 'goal');
    expect(goal?.argumentHint).toBe('<condition>');
  });

  /**
   * `/effort` and `/rename` are the case metadata-only exists for: BOTH were run
   * against a live CLI, and the answer depends on the release — 2.1.154 says
   * "isn't available in this environment", 2.1.263 runs them. So they carry a
   * real description for when the CLI reports them, and are never offered on
   * their own. `/review` is different: it was removed outright in 2.1.263, so it
   * is gone from the catalog and arrives only if the code-review plugin is installed.
   */
  it('offers no Claude command whose availability varies by release', () => {
    const byName = new Map(NATIVE_COMMANDS['claude-code'].map((c) => [c.name, c]));
    expect(byName.get('effort')?.metadataOnly).toBe(true);
    expect(byName.get('rename')?.metadataOnly).toBe(true);
    expect(byName.has('review')).toBe(false);
  });

  /**
   * The catalog is a pre-first-turn fallback for Claude Code, so what it offers
   * UNPROMPTED must stay small and verified — every entry below was run against
   * the CLI and worked on both 2.1.154 and 2.1.263.
   */
  it('keeps the Claude fallback to commands confirmed against the live CLI', () => {
    const offered = NATIVE_COMMANDS['claude-code']
      .filter((c) => c.execution.kind === 'passthrough' && !c.metadataOnly)
      .map((c) => c.name)
      .sort();
    expect(offered).toEqual(
      ['compact', 'context', 'goal', 'init', 'reload-skills', 'security-review', 'usage']
    );
  });

  /** Metadata-only entries are descriptions, so each needs a real one. */
  it('gives every metadata-only entry a genuine description', () => {
    for (const [provider, commands] of Object.entries(NATIVE_COMMANDS)) {
      for (const cmd of commands.filter((c) => c.metadataOnly)) {
        expect(cmd.description.length, `${provider}/${cmd.name}`).toBeGreaterThan(10);
        expect(cmd.description, `${provider}/${cmd.name}`).not.toMatch(/^Claude Code command$/);
      }
    }
  });

  /**
   * Every command here was checked against the installed CLI. Passthrough is
   * only correct where that CLI's HEADLESS entry point expands slash commands
   * — `codex exec` and `cn -p` do not, so a passthrough entry for them would
   * send `/compact` to the model as prose.
   */
  it('declares no passthrough for backends whose headless mode cannot expand one', () => {
    for (const provider of ['openai-codex', 'github-copilot', 'cursor', 'cline', 'continue', 'openclaw'] as const) {
      const bad = NATIVE_COMMANDS[provider].filter((c) => c.execution.kind === 'passthrough');
      expect(bad.map((c) => c.name), `${provider} has no headless slash parser`).toEqual([]);
    }
  });

  /**
   * Every CLI's command set was re-verified against its LATEST release, not the
   * version that happened to be installed — the two had drifted badly (Gemini
   * 0.28 -> 0.58, Copilot 0.0.372 -> 1.0.83, Qwen 0.11 -> 0.23, Cline 1.0 -> 3.0).
   * These are the entries that only exist in the newer releases; they are all
   * Mysti-mapped, so they stay correct on an older CLI too.
   */
  it('carries the commands the latest CLI releases added', () => {
    const gemini = NATIVE_COMMANDS['google-gemini'].find((c) => c.name === 'plan');
    expect(gemini?.execution).toEqual({ kind: 'mysti', commandId: 'settings:mode' });

    const qwen = NATIVE_COMMANDS['qwen-code'].find((c) => c.name === 'plan');
    expect(qwen?.execution).toEqual({ kind: 'mysti', commandId: 'settings:mode' });

    const copilot = NATIVE_COMMANDS['github-copilot'].find((c) => c.name === 'compact');
    expect(copilot?.execution).toEqual({ kind: 'mysti', commandId: 'cmd:compact' });
  });

  /**
   * Skills directories appeared in four more CLIs since this catalog was first
   * written. Where the CLI resolves `/name` itself the skill passes through;
   * where its headless mode has no slash parser the skill's own text is sent.
   */
  it('discovers skills for every CLI that grew a skills directory', () => {
    const dirOf = (p: keyof typeof NATIVE_COMMAND_SOURCES) =>
      NATIVE_COMMAND_SOURCES[p].filter((src) => src.skillDirs);

    expect(dirOf('claude-code').map((s) => s.dir)).toContain('.claude/skills');
    expect(dirOf('google-gemini').map((s) => s.dir)).toContain('.gemini/skills');
    expect(dirOf('qwen-code').map((s) => s.dir)).toContain('.qwen/skills');
    expect(dirOf('continue').map((s) => s.dir)).toContain('.continue/skills');
    expect(dirOf('openclaw').map((s) => s.dir)).toContain('.openclaw/skills');

    // Gemini and Qwen resolve a skill by name; Continue and OpenClaw cannot.
    expect(dirOf('google-gemini').every((s) => s.execution.kind === 'passthrough')).toBe(true);
    expect(dirOf('continue').every((s) => s.execution.kind === 'expand')).toBe(true);
    expect(dirOf('openclaw').every((s) => s.execution.kind === 'expand')).toBe(true);
  });

  it('gives API-only providers no CLI commands at all', () => {
    for (const provider of ['ollama', 'localai', 'openrouter'] as const) {
      expect(NATIVE_COMMANDS[provider]).toEqual([]);
      expect(NATIVE_COMMAND_SOURCES[provider]).toEqual([]);
    }
  });
});

describe('native command ids', () => {
  it('round-trips a plain name', () => {
    expect(parseNativeCommandId(nativeCommandId('claude-code', 'compact')))
      .toEqual({ provider: 'claude-code', name: 'compact' });
  });

  /**
   * Claude and Gemini both namespace a nested command directory as `dir:name`,
   * so the name itself contains a colon. Splitting on the LAST separator (or on
   * every one) would address the wrong command.
   */
  it('keeps a namespaced command name intact', () => {
    expect(parseNativeCommandId(nativeCommandId('claude-code', 'frontend:audit')))
      .toEqual({ provider: 'claude-code', name: 'frontend:audit' });
  });

  it('rejects ids that are not native commands', () => {
    expect(parseNativeCommandId('cmd:clear')).toBeNull();
    expect(parseNativeCommandId('native:')).toBeNull();
    expect(parseNativeCommandId('native:claude-code')).toBeNull();
    expect(parseNativeCommandId('native:claude-code:')).toBeNull();
    expect(parseNativeCommandId('native::compact')).toBeNull();
  });
});

describe("Claude Code's system/init report", () => {
  /**
   * The only accurate source for Claude Code. Bundled skills — `/design` and the
   * rest — are compiled into the binary as `SKILL-<hash>.md.zst` and extracted
   * at runtime, so no directory scan can ever see them; the CLI naming them in
   * `slash_commands` is how they reach the menu.
   */
  it('reads the reported commands and labels the skills among them', () => {
    const parsed = parseClaudeInitCommands(
      ['compact', 'context', 'design', 'code-review'],
      ['design', 'code-review'],
    );
    expect(parsed?.map((c) => c.name)).toEqual(['compact', 'context', 'design', 'code-review']);
    const design = parsed!.find((c) => c.name === 'design')!;
    expect(design.description).toContain('Skill');
    expect(design.execution).toEqual({ kind: 'passthrough' });
    expect(parsed!.find((c) => c.name === 'compact')!.description).not.toContain('Skill');
  });

  /**
   * `null` (no report yet) and `[]` (a session with no commands) are different
   * claims: the first falls back to the catalog, the second empties the section.
   */
  it('separates "not reported yet" from "reported nothing"', () => {
    expect(parseClaudeInitCommands(undefined, undefined)).toBeNull();
    expect(parseClaudeInitCommands('not-an-array', [])).toBeNull();
    expect(parseClaudeInitCommands([], [])).toEqual([]);
  });

  it('tolerates a leading slash, duplicates and junk entries', () => {
    const parsed = parseClaudeInitCommands(['/compact', 'compact', 42, '', 'bad name', 'ok'], null);
    expect(parsed?.map((c) => c.name)).toEqual(['compact', 'ok']);
  });

  it('bounds the reported list', () => {
    const many = Array.from({ length: 500 }, (_, i) => `cmd${i}`);
    expect(parseClaudeInitCommands(many, [])!.length).toBeLessThanOrEqual(200);
  });
});

describe('ACP available_commands_update', () => {
  it('reads the agent-reported list, camelCase or snake_case', () => {
    const camel = parseAcpAvailableCommands({
      availableCommands: [{ name: 'web', description: 'Search the web' }],
    });
    expect(camel).toEqual([
      expect.objectContaining({ name: 'web', description: 'Search the web' }),
    ]);
    expect(parseAcpAvailableCommands({
      available_commands: [{ name: 'web', description: 'Search the web' }],
    })).toHaveLength(1);
  });

  it('treats an input hint as "this command takes arguments"', () => {
    const [cmd] = parseAcpAvailableCommands({
      availableCommands: [{ name: 'ask', description: 'Ask', input: { hint: '<question>' } }],
    });
    expect(cmd.argumentHint).toBe('<question>');
  });

  it('passes agent commands through to the backend', () => {
    const [cmd] = parseAcpAvailableCommands({ availableCommands: [{ name: 'web' }] });
    expect(cmd.execution).toEqual({ kind: 'passthrough' });
    expect(cmd.description).toContain('web');
  });

  /**
   * The payload comes from a separate agent process. A name that is not a valid
   * slash command is DROPPED rather than cleaned up — sanitizing `rm -rf /`
   * into `rmrf` would run a different command than the agent named.
   */
  it('drops entries whose name is not addressable as a command', () => {
    const parsed = parseAcpAvailableCommands({
      availableCommands: [
        { name: '/leading-slash' },
        { name: 'has space' },
        { name: '' },
        { name: 'a'.repeat(200) },
        { name: 42 },
        null,
        'not-an-object',
        { name: 'good-one' },
      ],
    });
    expect(parsed.map((c) => c.name)).toEqual(['good-one']);
  });

  it('bounds the list and the text so one agent cannot flood the menu', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      name: `cmd${i}`,
      description: 'x'.repeat(1000),
    }));
    const parsed = parseAcpAvailableCommands({ availableCommands: many });
    expect(parsed.length).toBeLessThanOrEqual(100);
    expect(parsed[0].description.length).toBeLessThanOrEqual(160);
  });

  it('returns nothing for a malformed update instead of throwing', () => {
    expect(parseAcpAvailableCommands({})).toEqual([]);
    expect(parseAcpAvailableCommands({ availableCommands: 'nope' })).toEqual([]);
    expect(parseAcpAvailableCommands({ availableCommands: null })).toEqual([]);
  });
});
