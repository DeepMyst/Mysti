/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for ContextManager's Plan 07 activate/deactivate behavior: a
 * deactivated item stays in the list but is excluded from the prompt.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import { ContextManager } from '../../src/managers/ContextManager';

function newMgr(): ContextManager {
  return new ContextManager({} as unknown as vscode.ExtensionContext);
}

describe('ContextManager — activate/deactivate (Plan 07)', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ctx-'));
    file = path.join(tmp, 'a.ts');
    fs.writeFileSync(file, 'export const x = 1;\n');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('new file items default to enabled', async () => {
    const m = newMgr();
    const item = await m.addFileToContext(file, 'p1');
    expect(item).not.toBeNull();
    expect(item!.enabled).toBe(true);
  });

  it('deactivating keeps the item listed but excludes it from the prompt', async () => {
    const m = newMgr();
    const item = await m.addFileToContext(file, 'p1');
    expect(m.formatContextForPrompt('p1')).toContain('a.ts');

    expect(m.setItemEnabled(item!.id, false, 'p1')).toBe(false);
    expect(m.getContext('p1')).toHaveLength(1);                  // still in the list
    expect(m.formatContextForPrompt('p1')).toBe('');            // excluded from prompt

    expect(m.setItemEnabled(item!.id, true, 'p1')).toBe(true);
    expect(m.formatContextForPrompt('p1')).toContain('a.ts');   // back in
  });

  it('toggleItem flips the active state', async () => {
    const m = newMgr();
    const item = await m.addFileToContext(file, 'p1');
    expect(m.toggleItem(item!.id, 'p1')).toBe(false);
    expect(m.toggleItem(item!.id, 'p1')).toBe(true);
  });

  it('setItemEnabled/toggleItem return null for an unknown id', () => {
    const m = newMgr();
    expect(m.setItemEnabled('nope', false, 'p1')).toBeNull();
    expect(m.toggleItem('nope', 'p1')).toBeNull();
  });

  it('is per-panel — disabling in one panel does not affect another', async () => {
    const m = newMgr();
    const a = await m.addFileToContext(file, 'p1');
    await m.addFileToContext(file, 'p2');
    m.setItemEnabled(a!.id, false, 'p1');
    expect(m.formatContextForPrompt('p1')).toBe('');
    expect(m.formatContextForPrompt('p2')).toContain('a.ts');
  });
});
