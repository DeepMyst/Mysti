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

function newMgr(store?: Map<string, unknown>): ContextManager {
  const ws = {
    get: (k: string) => store?.get(k),
    update: (k: string, v: unknown) => { store?.set(k, v); return Promise.resolve(); },
  };
  return new ContextManager({ workspaceState: ws } as unknown as vscode.ExtensionContext);
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

  it('persists across instances and re-reads file content on restore (A5)', async () => {
    const store = new Map<string, unknown>();
    const m1 = newMgr(store);
    const item = await m1.addFileToContext(file, 'sidebar');
    m1.setItemEnabled(item!.id, false, 'sidebar'); // deactivate → flag must survive

    // New instance (simulates reload) sharing the same workspaceState.
    const m2 = newMgr(store);
    const restored = await m2.restorePanelContext('sidebar');
    expect(restored).toHaveLength(1);
    expect(restored[0].enabled).toBe(false);          // flag preserved
    expect(restored[0].content).toContain('export const x'); // content re-read fresh
  });

  it('drops restored items whose files no longer exist', async () => {
    const store = new Map<string, unknown>();
    const m1 = newMgr(store);
    await m1.addFileToContext(file, 'sidebar');
    fs.rmSync(file); // delete the backing file

    const m2 = newMgr(store);
    const restored = await m2.restorePanelContext('sidebar');
    expect(restored).toHaveLength(0);
  });

  it('restore does not clobber a live in-memory session', async () => {
    const store = new Map<string, unknown>();
    const m = newMgr(store);
    await m.addFileToContext(file, 'sidebar');
    // Already has in-memory context → restore returns it without touching store.
    const restored = await m.restorePanelContext('sidebar');
    expect(restored).toHaveLength(1);
  });
});
