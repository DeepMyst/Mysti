/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 Phase 5 — `.agents/skills` and `.claude/skills`.
 *
 * `.agents/skills/<name>/SKILL.md` is the cross-client Agent Skills convention;
 * `.claude/skills` is Claude's. Mysti scanned only `.mysti/agents/skills`, so a
 * repository that had already written skills for another tool had none of them.
 *
 * The layout needed no structural change: the loader reads `<dir>/skills`, so
 * pointing it at `.agents` and `.claude` resolves to exactly the conventional
 * paths. Both load at `source: 'workspace'` — the LOWEST trust tier — because a
 * cloned repo can contain anything.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const LOADER = path.join(__dirname, '..', '..', 'src', 'managers', 'AgentLoader.ts');
const src = fs.readFileSync(LOADER, 'utf-8');

describe('cross-client skill directories are scanned', () => {
  it('both conventional directories are registered', () => {
    const idx = src.indexOf("for (const crossClient of ['.agents', '.claude'])");
    expect(idx, '.agents / .claude are not scanned').toBeGreaterThan(-1);
  });

  it('they resolve to <root>/.agents/skills via the existing <dir>/skills read', () => {
    // The property that makes this a two-line change instead of a refactor.
    expect(src).toContain("path.join(sourceDir.path, 'skills')");
    const idx = src.indexOf("for (const crossClient of ['.agents', '.claude'])");
    expect(src.slice(idx, idx + 260)).toContain('path.join(workspaceRoot, crossClient)');
  });

  it('they are workspace-scoped — the LOWEST trust tier, never trusted content', () => {
    const idx = src.indexOf("for (const crossClient of ['.agents', '.claude'])");
    const block = src.slice(idx, idx + 260);
    expect(block).toContain("source: 'workspace'");
    expect(block).not.toContain("source: 'core'");
    expect(block).not.toContain("source: 'user'");
  });

  it('they come AFTER .mysti/agents, so a Mysti-native skill of the same id wins', () => {
    const mysti = src.indexOf("path.join(workspaceRoot, '.mysti', 'agents')");
    const cross = src.indexOf("for (const crossClient of ['.agents', '.claude'])");
    expect(mysti).toBeGreaterThan(-1);
    expect(cross).toBeGreaterThan(mysti);
  });

  it('a missing directory is tolerated — most repos have neither', () => {
    // _collectAgentFiles wraps its readdir in try/catch, which is what makes
    // registering two usually-absent directories free.
    const idx = src.indexOf('private async _collectAgentFiles');
    expect(src.slice(idx, idx + 200)).toContain('try {');
  });
});
