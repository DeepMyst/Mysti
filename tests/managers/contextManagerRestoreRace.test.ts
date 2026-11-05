/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'fs';
import * as contextFileReader from '../../src/services/ContextFileReader';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ContextManager } from '../../src/managers/ContextManager';
import type { ContextItem } from '../../src/types';
import { createMockMemento } from '../helpers/mockVscode';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Context restoration keeps newer user actions authoritative', () => {
  let directory: string;
  let savedPath: string;
  let freshPath: string;
  let store: ReturnType<typeof createMockMemento>;
  let manager: ContextManager;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-context-restore-'));
    savedPath = path.join(directory, 'saved.ts');
    freshPath = path.join(directory, 'fresh.ts');
    fs.writeFileSync(savedPath, 'export const saved = "old-context-canary";\n');
    fs.writeFileSync(freshPath, 'export const fresh = "new-context-canary";\n');
    store = createMockMemento();
    store._store.set('mysti.context:sidebar', [{ id: 'saved-file', type: 'file', path: savedPath, enabled: true }]);
    manager = new ContextManager({ workspaceState: store } as unknown as vscode.ExtensionContext);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function pauseReads(paths: string[]) {
    const reads = new Map(paths.map(file => [file, { started: deferred(), release: deferred() }]));
    const readFile = contextFileReader.readContextFileText.bind(contextFileReader);
    vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation(async (file, options) => {
      const held = reads.get(String(file));
      if (held) { held.started.resolve(); await held.release.promise; }
      return readFile(file, options);
    });
    return reads;
  }

  it('Clear during a saved-file read stays empty and a later file add still works', async () => {
    const held = pauseReads([savedPath]).get(savedPath)!;
    const restore = manager.restorePanelContext('sidebar');
    await held.started.promise;
    manager.clearContext('sidebar');
    held.release.resolve();
    expect(await restore).toEqual([]);
    expect(manager.getContext('sidebar')).toEqual([]);
    expect(manager.formatContextForPrompt('sidebar')).toBe('');
    expect(store._store.get('mysti.context:sidebar')).toEqual([]);
    const fresh = await manager.addFileToContext(freshPath, 'sidebar');
    expect(fresh?.content).toContain('new-context-canary');
    expect(manager.getContext('sidebar')).toEqual([fresh]);
    expect(manager.formatContextForPrompt('sidebar')).not.toContain('old-context-canary');
  });

  it('disposing a panel during restoration never recreates its persisted key or changes a sibling', async () => {
    const sibling = await manager.addSelectionToContext(freshPath, 'sibling-only-canary', 2, 3, 'typescript', 'sibling');
    const held = pauseReads([savedPath]).get(savedPath)!;
    const restore = manager.restorePanelContext('sidebar');
    await held.started.promise;
    manager.clearPanelContext('sidebar');
    held.release.resolve();
    expect(await restore).toEqual([]);
    expect(store._store.has('mysti.context:sidebar')).toBe(false);
    expect(manager.getContext('sidebar')).toEqual([]);
    expect(manager.getContext('sibling')).toEqual([sibling]);
    expect(manager.formatContextForPrompt('sibling')).toContain('sibling-only-canary');
    expect(store._store.get('mysti.context:sibling')).toEqual([sibling]);
  });

  it('a selection added while restoration waits retains its exact snapshot and enabled state', async () => {
    const held = pauseReads([savedPath]).get(savedPath)!;
    const restore = manager.restorePanelContext('sidebar');
    await held.started.promise;
    const selection = await manager.addSelectionToContext(freshPath, 'selected العربية 👩🏽‍💻\nnext line', 4, 5, 'typescript', 'sidebar');
    manager.setItemEnabled(selection.id, false, 'sidebar');
    held.release.resolve();
    expect(await restore).toEqual([selection]);
    expect(manager.getContext('sidebar')).toEqual([selection]);
    expect(store._store.get('mysti.context:sidebar')).toEqual([selection]);
    expect(manager.formatContextForPrompt('sidebar')).toBe('');
    manager.setItemEnabled(selection.id, true, 'sidebar');
    expect(manager.formatContextForPrompt('sidebar')).toContain(selection.content);
    expect(manager.formatContextForPrompt('sidebar')).not.toContain('old-context-canary');
  });

  it('a newly added file is not overwritten by a slower saved-file restoration', async () => {
    const held = pauseReads([savedPath]).get(savedPath)!;
    const restore = manager.restorePanelContext('sidebar');
    await held.started.promise;
    const fresh = await manager.addFileToContext(freshPath, 'sidebar');
    held.release.resolve();
    expect(await restore).toEqual([fresh]);
    expect(manager.getContext('sidebar')).toEqual([fresh]);
    expect(manager.formatContextForPrompt('sidebar')).toContain('new-context-canary');
    expect(manager.formatContextForPrompt('sidebar')).not.toContain('old-context-canary');
    expect((store._store.get('mysti.context:sidebar') as ContextItem[]).map(item => item.path)).toEqual([freshPath]);
  });

  it('starting an explicit file add also supersedes restoration when the new file read finishes last', async () => {
    const held = pauseReads([savedPath, freshPath]);
    const restore = manager.restorePanelContext('sidebar');
    await held.get(savedPath)!.started.promise;
    const add = manager.addFileToContext(freshPath, 'sidebar');
    await held.get(freshPath)!.started.promise;
    held.get(savedPath)!.release.resolve();
    const restored = await restore;
    held.get(freshPath)!.release.resolve();
    const fresh = await add;
    expect(restored).toEqual([]);
    expect(fresh?.content).toContain('new-context-canary');
    expect(manager.getContext('sidebar')).toEqual([fresh]);
    expect((store._store.get('mysti.context:sidebar') as ContextItem[]).map(item => item.path)).toEqual([freshPath]);
  });

  it('a slower older restoration cannot replace the newer restored bytes or persist again', async () => {
    const reads = [0, 1].map(() => ({ started: deferred(), release: deferred() }));
    const readFile = contextFileReader.readContextFileText.bind(contextFileReader);
    let readIndex = 0;
    vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation(async (file, options) => {
      const content = await readFile(file, options);
      if (String(file) === savedPath) {
        const held = reads[readIndex++];
        held.started.resolve();
        await held.release.promise;
      }
      return content;
    });
    const persist = vi.spyOn(store, 'update');
    const older = manager.restorePanelContext('sidebar');
    await reads[0].started.promise;
    fs.writeFileSync(savedPath, 'newer disk contents');
    const newer = manager.restorePanelContext('sidebar');
    await reads[1].started.promise;
    reads[1].release.resolve();
    const restored = await newer;
    const writes = persist.mock.calls.length;
    reads[0].release.resolve();
    const late = await older;
    expect(restored[0].content).toBe('newer disk contents');
    expect(late).toEqual(restored);
    expect(manager.getContext('sidebar')).toEqual(restored);
    expect(manager.formatContextForPrompt('sidebar')).not.toContain('old-context-canary');
    expect(persist).toHaveBeenCalledTimes(writes);
    expect(store._store.get('mysti.context:sidebar')).toEqual([{ ...restored[0], content: undefined }]);
  });

  it('normal restoration rereads files, preserves disabled selections and prunes missing files', async () => {
    const selection: ContextItem = { id: 'snapshot', type: 'selection', path: savedPath, content: 'original snapshot', startLine: 1, endLine: 1, enabled: false };
    store._store.set('mysti.context:sidebar', [
      { id: 'saved-file', type: 'file', path: savedPath, enabled: true }, selection,
      { id: 'missing', type: 'file', path: path.join(directory, 'missing.ts'), enabled: true },
    ]);
    fs.writeFileSync(savedPath, 'fresh disk contents');
    const restored = await manager.restorePanelContext('sidebar');
    expect(restored).toHaveLength(2);
    expect(restored[0].content).toBe('fresh disk contents');
    expect(restored[1]).toEqual(selection);
    expect(manager.formatContextForPrompt('sidebar')).toContain('fresh disk contents');
    expect(manager.formatContextForPrompt('sidebar')).not.toContain('original snapshot');
    expect((store._store.get('mysti.context:sidebar') as ContextItem[]).map(item => item.id)).toEqual(['saved-file', 'snapshot']);
  });
});
