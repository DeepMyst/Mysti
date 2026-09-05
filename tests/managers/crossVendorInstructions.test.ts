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
 * Plan 27 Phase 5 — AGENTS.md / CLAUDE.md / GEMINI.md.
 *
 * `AGENTS.md` is the open convention (agents.md) that Codex, Cursor, Jules and
 * VS Code's own agent mode read. Mysti read only the `mysti.md` it invented for
 * the same job, so a repo that had already written its conventions down for
 * every other tool got none of them here.
 *
 * The Phase 3 fencing (D-7) was the HARD prerequisite: these files are by
 * construction present in cloned third-party repositories, so reading them
 * unfenced would hand any clone the system position.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectContextManager } from '../../src/managers/ProjectContextManager';
import { workspace as mockWorkspace } from '../helpers/mockVscode';

let root: string;
let mgr: ProjectContextManager;
let originalFolders: unknown;

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-crossvendor-'));
  // The manager takes the root from vscode.workspace, not its constructor.
  originalFolders = (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders;
  (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders =
    [{ uri: { fsPath: root }, name: 'test', index: 0 }];
  mgr = new ProjectContextManager({} as never);
  // The root is captured in initialize(), not the constructor.
  await mgr.initialize();
});
afterEach(() => {
  (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = originalFolders;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cross-vendor instruction files are read', () => {
  it('reads AGENTS.md — the convention every other agent already honours', () => {
    write('AGENTS.md', '# Conventions\nUse tabs.');
    const out = mgr.getCrossVendorInstructions();
    expect(out.map(o => o.label)).toEqual(['AGENTS.md']);
    expect(out[0].content).toContain('Use tabs.');
  });

  it('reads all three families, in convention order', () => {
    write('AGENTS.md', 'a');
    write('CLAUDE.md', 'c');
    write('GEMINI.md', 'g');
    expect(mgr.getCrossVendorInstructions().map(o => o.label)).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  });

  it('falls back to .claude/CLAUDE.md, and the root file wins when both exist', () => {
    write(path.join('.claude', 'CLAUDE.md'), 'nested');
    expect(mgr.getCrossVendorInstructions()[0].label).toBe(path.join('.claude', 'CLAUDE.md'));

    write('CLAUDE.md', 'root');
    const both = mgr.getCrossVendorInstructions();
    expect(both).toHaveLength(1);
    expect(both[0].label).toBe('CLAUDE.md');
    expect(both[0].content).toBe('root');
  });

  it('returns nothing when no such file exists', () => {
    expect(mgr.getCrossVendorInstructions()).toEqual([]);
  });

  it('ignores an empty file rather than injecting a blank section', () => {
    write('AGENTS.md', '   \n  ');
    expect(mgr.getCrossVendorInstructions()).toEqual([]);
  });

  it('caps a huge third-party file and SAYS it truncated', () => {
    write('AGENTS.md', 'x'.repeat(20_000));
    const [only] = mgr.getCrossVendorInstructions();
    expect(only.content.length).toBeLessThan(20_000);
    expect(only.content).toContain('[truncated');
    expect(only.content).toContain('more characters not shown');
  });
});

describe('they are fenced, not trusted', () => {
  it('the producer adds them to the SAME fenced array as mysti.md', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'providers', 'ChatViewProvider.ts'), 'utf-8');
    // Anchor on the CALL SITE: the first bare occurrence is the definition.
    const idx = src.indexOf('const projectInstructions = this._fenceUntrustedSystemBlock(');
    expect(idx, 'the projectInstructions fence call was not found').toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1400);
    expect(block).toContain('getCrossVendorInstructions()');
    // Inside the fence call's array argument — not appended to
    // fullSystemContext as a separate, unfenced entry.
    const call = block.slice(0, block.indexOf(');') + 2);
    expect(call, 'the call is outside the fence argument list').toContain('getCrossVendorInstructions()');
  });

  it('they respect the existing projectContext gate — no new setting', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'providers', 'ChatViewProvider.ts'), 'utf-8');
    expect(src).toContain('projectContextEnabled ? this._projectContextManager.getCrossVendorInstructions() : []');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const props = Object.keys(pkg.contributes.configuration.properties);
    expect(props.filter(k => /agentsMd|claudeMd|geminiMd|crossVendor/i.test(k))).toEqual([]);
  });
});
