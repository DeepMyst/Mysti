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
 * Plan 27 lane G (G-2) — `mysti.context:<panelId>` keys must not leak forever.
 *
 * `ContextManager._persist` writes one workspaceState key per panel, and
 * ChatViewProvider mints a fresh `panel_<Date.now()>` id for every tab it
 * opens. Before this fix `clearPanelContext` (the tab-dispose path) only
 * deleted the in-memory entry, and nothing ever enumerated the store, so every
 * tab ever opened left a key behind. These tests pin: the dispose path deletes
 * the key; construction sweeps orphans (bounded, logged, never throwing); the
 * stable sidebar/default keys survive the sweep so Plan 07 A5 restore still
 * works after a reload.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ContextManager, CONTEXT_SWEEP_LIMIT } from '../../src/managers/ContextManager';
import { createMockMemento } from '../helpers/mockVscode';

const KEY = (panelId: string) => `mysti.context:${panelId}`;

function newMgr(ws: unknown): ContextManager {
  return new ContextManager({ workspaceState: ws } as unknown as vscode.ExtensionContext);
}

/** Flush the microtask queue so `void workspaceState.update(...)` settles. */
const settle = () => new Promise<void>(r => setTimeout(r, 0));

describe('ContextManager — persisted per-panel keys do not leak (G-2)', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ctx-keys-'));
    file = path.join(tmp, 'a.ts');
    fs.writeFileSync(file, 'export const x = 1;\n');
    vi.restoreAllMocks();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('clearPanelContext deletes the persisted key, not just the in-memory entry', async () => {
    const ws = createMockMemento();
    const m = newMgr(ws);
    await m.addFileToContext(file, 'panel_1700000000000');
    await settle();
    expect(ws._store.has(KEY('panel_1700000000000'))).toBe(true);

    m.clearPanelContext('panel_1700000000000');
    await settle();
    expect(ws._store.has(KEY('panel_1700000000000'))).toBe(false);
    expect(m.getContext('panel_1700000000000')).toEqual([]);
  });

  it('construction sweeps orphaned tab keys but keeps sidebar/default and unrelated keys', async () => {
    const ws = createMockMemento();
    ws._store.set(KEY('panel_1700000000001'), [{ id: 'a', type: 'file', path: file, enabled: true }]);
    ws._store.set(KEY('panel_1700000000002'), []);
    ws._store.set(KEY('canvas-1700000000003'), []);
    ws._store.set(KEY('sidebar'), [{ id: 's', type: 'file', path: file, enabled: true }]);
    ws._store.set(KEY('default'), [{ id: 'd', type: 'file', path: file, enabled: true }]);
    ws._store.set('mysti.hasPromptedTeamOnboarding', true);
    ws._store.set('mysti.conversations', { conversations: [] });

    newMgr(ws);
    await settle();

    expect(ws._store.has(KEY('panel_1700000000001'))).toBe(false);
    expect(ws._store.has(KEY('panel_1700000000002'))).toBe(false);
    expect(ws._store.has(KEY('canvas-1700000000003'))).toBe(false);
    expect(ws._store.has(KEY('sidebar'))).toBe(true);
    expect(ws._store.has(KEY('default'))).toBe(true);
    expect(ws._store.get('mysti.hasPromptedTeamOnboarding')).toBe(true);
    expect(ws._store.has('mysti.conversations')).toBe(true);
  });

  it('the sidebar context still restores after a reload that swept tab keys (A5 guard)', async () => {
    const ws = createMockMemento();
    const m1 = newMgr(ws);
    await m1.addFileToContext(file, 'sidebar');
    await m1.addFileToContext(file, 'panel_1700000000004');
    await settle();

    const m2 = newMgr(ws); // reload
    await settle();
    const restored = await m2.restorePanelContext('sidebar');
    expect(restored).toHaveLength(1);
    expect(restored[0].content).toContain('export const x');
    expect(ws._store.has(KEY('panel_1700000000004'))).toBe(false);
  });

  it('the sweep is bounded per activation and logs the count once', async () => {
    const ws = createMockMemento();
    const total = CONTEXT_SWEEP_LIMIT + 250;
    for (let i = 0; i < total; i++) { ws._store.set(KEY(`panel_${1700000000000 + i}`), []); }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    newMgr(ws);
    await settle();

    const remaining = [...ws._store.keys()].filter(k => k.startsWith('mysti.context:')).length;
    expect(remaining).toBe(total - CONTEXT_SWEEP_LIMIT);
    const sweepLogs = log.mock.calls.filter(c => String(c[0]).includes('[Mysti]') && String(c.join(' ')).includes('swept'));
    expect(sweepLogs).toHaveLength(1);
    expect(sweepLogs[0].join(' ')).toContain(String(CONTEXT_SWEEP_LIMIT));

    // A second activation drains the rest.
    log.mockClear();
    newMgr(ws);
    await settle();
    expect([...ws._store.keys()].filter(k => k.startsWith('mysti.context:'))).toHaveLength(0);
  });

  it('does not log when there is nothing to sweep', async () => {
    const ws = createMockMemento();
    ws._store.set(KEY('sidebar'), []);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    newMgr(ws);
    await settle();
    expect(log.mock.calls.filter(c => String(c.join(' ')).includes('swept'))).toHaveLength(0);
  });

  it('never throws: a memento without keys(), a keys() that throws, and an update() that rejects', async () => {
    // 1. Legacy / minimal mock without keys() (the shape the older tests use).
    const store = new Map<string, unknown>();
    const noKeys = {
      get: (k: string) => store.get(k),
      update: (k: string, v: unknown) => { if (v === undefined) { store.delete(k); } else { store.set(k, v); } return Promise.resolve(); },
    };
    expect(() => newMgr(noKeys)).not.toThrow();

    // 2. keys() throws.
    const throwingKeys = { ...createMockMemento(), keys: () => { throw new Error('boom'); } };
    expect(() => newMgr(throwingKeys)).not.toThrow();

    // 3. update() rejects during the sweep and during clearPanelContext.
    const rejecting = createMockMemento();
    rejecting._store.set(KEY('panel_1700000000005'), []);
    rejecting.update = async () => { throw new Error('disk full'); };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let m: ContextManager | undefined;
      expect(() => { m = newMgr(rejecting); }).not.toThrow();
      expect(() => m!.clearPanelContext('panel_1700000000005')).not.toThrow();
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
