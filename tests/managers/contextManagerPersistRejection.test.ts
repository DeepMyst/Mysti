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
 * Plan 27 §21.6c #11 / lane P (P-2) — `ContextManager._persist` used to be a
 * bare `void workspaceState.update(...)`. A rejected write (disk full, storage
 * locked, host tearing down) therefore surfaced as an *unhandled* rejection —
 * the one failure shape an extension must never emit, because the host logs it
 * as a crash of the extension rather than a lost context write. The write must
 * fail quietly: log with the `[Mysti]` prefix, never throw, never leave a
 * rejection unhandled. `_forgetPersisted` already had this contract; this pins
 * the same contract on the write path.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ContextManager } from '../../src/managers/ContextManager';
import { createMockMemento } from '../helpers/mockVscode';

function newMgr(ws: unknown): ContextManager {
  return new ContextManager({ workspaceState: ws } as unknown as vscode.ExtensionContext);
}

/** Flush the microtask queue twice so a floated rejection has time to surface. */
const settle = async () => { await new Promise<void>(r => setTimeout(r, 0)); await new Promise<void>(r => setTimeout(r, 0)); };

describe('ContextManager._persist — a rejected workspaceState.update is handled, logged, never thrown (P-2)', () => {
  let tmp: string;
  let file: string;
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ctx-persist-'));
    file = path.join(tmp, 'a.ts');
    fs.writeFileSync(file, 'export const x = 1;\n');
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('addFileToContext / clearContext against a rejecting store: no throw, no unhandled rejection, one [Mysti] log each', async () => {
    const ws = createMockMemento();
    ws.update = async () => { throw new Error('disk full'); };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = newMgr(ws);
    await settle(); // construction sweep (nothing to sweep here)
    log.mockClear();

    await expect(m.addFileToContext(file, 'sidebar')).resolves.not.toBeNull();
    expect(() => m.clearContext('sidebar')).not.toThrow();
    await settle();

    expect(unhandled).toEqual([]);
    const persistLogs = log.mock.calls.filter(c => String(c[0]).startsWith('[Mysti]') && String(c.join(' ')).includes('persist'));
    expect(persistLogs).toHaveLength(2);
    expect(persistLogs[0].join(' ')).toContain('disk full');
    // The in-memory state is still authoritative even though the write failed.
    expect(m.getContext('sidebar')).toEqual([]);
  });

  it('a store whose update() returns a non-thenable (legacy shim) is tolerated', async () => {
    const store = new Map<string, unknown>();
    const ws = { get: (k: string) => store.get(k), update: (k: string, v: unknown) => { store.set(k, v); } };
    const m = newMgr(ws);
    await expect(m.addFileToContext(file, 'sidebar')).resolves.not.toBeNull();
    await settle();
    expect(unhandled).toEqual([]);
    expect(store.has('mysti.context:sidebar')).toBe(true);
  });
});
