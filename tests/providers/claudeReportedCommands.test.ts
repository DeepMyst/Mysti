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
 * Claude Code reports its own `/commands`, and Mysti has to read them.
 *
 * A curated list cannot be right for this backend. The set depends on the
 * installed version, the enabled plugins, the bundled skills and any MCP
 * prompts — and the bundled skills (`/design` and the rest) are compiled into
 * the binary as `SKILL-<hash>.md.zst` and extracted at runtime, so they appear
 * in NO directory Mysti could scan. The `system`/`init` event is the only
 * accurate source, and Mysti was already parsing that event for its session id
 * while discarding the command list beside it.
 *
 * The payload below is a real one, captured from `claude -p --output-format
 * stream-json --verbose` on a developer machine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClaudeProvider } from '../helpers/providerFactory';
import { createClaudeSession } from '../helpers/sessionFactory';
import type { ClaudeSessionState } from '../../src/providers/claude/ClaudeCodeProvider';

/** Captured verbatim from a live run; trimmed to the fields Mysti reads. */
const REAL_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: '6b1e4f52-0000-4000-8000-abcdef123456',
  cwd: '/repo',
  model: 'claude-opus-4-8',
  permissionMode: 'default',
  tools: ['Bash', 'Read', 'Edit'],
  agents: ['Explore', 'Plan'],
  plugins: [],
  // 54 commands, 20 of them skills — captured from Claude Code 2.1.263. The
  // same machine on 2.1.154 reported 27 and no `design` at all, which is the
  // whole argument against a hard-coded list.
  slash_commands: [
    'advisor', 'agents', 'artifact-capabilities', 'artifact-diagramming',
    'auto-mode-setup', 'autocompact', 'batch', 'claude-api', 'clear',
    'code-review', 'color', 'compact', 'config', 'context', 'dataviz', 'debug',
    'deep-research', 'design', 'design-consent', 'design-revoke', 'design-sync',
    'doctor', 'effort', 'extra-usage', 'fast', 'fewer-permission-prompts',
    'goal', 'heapdump', 'import', 'init', 'insights', 'list-agents', 'loop',
    'mcp', 'model', 'recap', 'reload-plugins', 'reload-skills', 'rename', 'run',
    'run-skill-generator', 'schedule', 'security-review', 'simplify',
    'skill-doctor', 'team-onboarding', 'ultrareview', 'update-config', 'usage',
    'usage-credits', 'verify', 'workflow-authoring', 'workflow-launch-exec',
    '__remote-workflow',
  ],
  skills: [
    'artifact-capabilities', 'artifact-diagramming', 'batch', 'claude-api',
    'code-review', 'dataviz', 'debug', 'deep-research', 'design', 'design-sync',
    'doctor', 'fewer-permission-prompts', 'loop', 'run', 'run-skill-generator',
    'schedule', 'simplify', 'update-config', 'verify', 'workflow-authoring',
  ],
});

let provider: TestableClaudeProvider;
let session: ClaudeSessionState;

beforeEach(() => {
  provider = new TestableClaudeProvider();
  session = createClaudeSession('panel-1');
  // The provider answers getDynamicNativeCommands from its own session map.
  (provider as unknown as { _panelSessions: Map<string, ClaudeSessionState> })
    ._panelSessions.set('panel-1', session);
});

describe('Claude Code reported commands', () => {
  it('still extracts the session id from the same event', () => {
    const chunk = provider.parseStreamLine(REAL_INIT, session);
    expect(chunk).toEqual({ type: 'session_active', sessionId: '6b1e4f52-0000-4000-8000-abcdef123456' });
    expect(session.sessionId).toBe('6b1e4f52-0000-4000-8000-abcdef123456');
  });

  it('captures the command list that used to be discarded', () => {
    provider.parseStreamLine(REAL_INIT, session);
    const names = provider.getDynamicNativeCommands('panel-1').map((c) => c.name);
    // 54 reported, 53 offered: `__remote-workflow` is an internal command whose
    // leading underscore the name validator rejects, so it never reaches the menu.
    expect(names).toHaveLength(53);
    expect(names).not.toContain('__remote-workflow');
    expect(names).toContain('compact');
    expect(names).toContain('security-review');
    // Reported by 2.1.263 and NOT by 2.1.154 — the report is what makes the
    // difference, not a table in this repo.
    expect(names).toContain('effort');
    expect(names).toContain('rename');
  });

  /**
   * The command that started all of this. `/design` is a bundled skill; it is
   * in no directory Mysti scans, and it was absent from 2.1.154 entirely.
   */
  it('surfaces /design, the command this work started from', () => {
    provider.parseStreamLine(REAL_INIT, session);
    const design = provider.getDynamicNativeCommands('panel-1').find((c) => c.name === 'design');
    expect(design).toBeDefined();
    expect(design!.isSkill).toBe(true);
    expect(design!.execution).toEqual({ kind: 'passthrough' });
  });

  /**
   * The whole point. `/code-review` is a bundled skill living inside the
   * binary; every directory Mysti scans for Claude commands is empty on a
   * stock machine, so this is the only way it can ever appear in the menu.
   */
  it('surfaces bundled skills, which exist in no directory on disk', () => {
    provider.parseStreamLine(REAL_INIT, session);
    const commands = provider.getDynamicNativeCommands('panel-1');
    const skill = commands.find((c) => c.name === 'code-review');
    expect(skill).toBeDefined();
    expect(skill!.description).toContain('Skill');
    expect(skill!.execution).toEqual({ kind: 'passthrough' });

    // A non-skill command from the same report is not labelled as one.
    expect(commands.find((c) => c.name === 'compact')!.description).not.toContain('Skill');
  });

  /**
   * `hasReportedNativeCommands` is what makes the report authoritative over the
   * curated catalog. Before the first turn it must be false, or the menu would
   * be filtered against a list that has not arrived and come out empty.
   */
  it('reports nothing until the init event actually arrives', () => {
    expect(provider.hasReportedNativeCommands('panel-1')).toBe(false);
    expect(provider.getDynamicNativeCommands('panel-1')).toEqual([]);

    provider.parseStreamLine(REAL_INIT, session);
    expect(provider.hasReportedNativeCommands('panel-1')).toBe(true);
  });

  it('is per-panel — one panel\'s report is not another\'s', () => {
    provider.parseStreamLine(REAL_INIT, session);
    expect(provider.hasReportedNativeCommands('panel-2')).toBe(false);
    expect(provider.getDynamicNativeCommands(undefined)).toEqual([]);
  });

  /**
   * A session that genuinely has no commands must be distinguishable from one
   * that has not reported: the first empties the menu section, the second falls
   * back to the catalog.
   */
  it('treats an empty reported list as a real answer', () => {
    provider.parseStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', slash_commands: [] }),
      session,
    );
    expect(provider.hasReportedNativeCommands('panel-1')).toBe(true);
    expect(provider.getDynamicNativeCommands('panel-1')).toEqual([]);
  });

  it('leaves the fallback in place when the event carries no command list', () => {
    provider.parseStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      session,
    );
    expect(provider.hasReportedNativeCommands('panel-1')).toBe(false);
  });

  /**
   * Upgrading the CLI must not break the stream parser. Claude Code 2.1.263
   * emits a `rate_limit_event` that 2.1.154 did not; an unknown event type has
   * to be ignored, not treated as text or thrown on.
   */
  it('ignores stream events a newer CLI added', () => {
    const chunk = provider.parseStreamLine(
      JSON.stringify({ type: 'rate_limit_event', rate_limit: { status: 'allowed' } }),
      session,
    );
    expect(chunk).toBeNull();
  });

  it('survives a malformed init event without throwing', () => {
    expect(() => provider.parseStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', slash_commands: { not: 'an array' } }),
      session,
    )).not.toThrow();
    expect(provider.hasReportedNativeCommands('panel-1')).toBe(false);
  });

  /**
   * A re-spawn (model change, permission change) emits a fresh init. The new
   * report replaces the old one rather than accumulating, so a command removed
   * by a CLI upgrade mid-session actually disappears.
   */
  it('replaces the previous report rather than merging into it', () => {
    provider.parseStreamLine(REAL_INIT, session);
    expect(provider.getDynamicNativeCommands('panel-1')).toHaveLength(53);

    provider.parseStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2', slash_commands: ['compact'] }),
      session,
    );
    expect(provider.getDynamicNativeCommands('panel-1').map((c) => c.name)).toEqual(['compact']);
  });
});
