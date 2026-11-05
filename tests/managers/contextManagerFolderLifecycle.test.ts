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

describe('folder context lifecycle', () => {
  let root: string;
  let folder: string;
  let store: ReturnType<typeof createMockMemento>;
  let manager: ContextManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-folder-context-'));
    folder = path.join(root, 'folder');
    fs.mkdirSync(folder);
    store = createMockMemento();
    manager = new ContextManager({ workspaceState: store } as unknown as vscode.ExtensionContext);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function files(count: number, directory = folder) {
    for (let index = 0; index < count; index++) {
      fs.writeFileSync(path.join(directory, `${String(index).padStart(2, '0')}.ts`), `file-canary-${index}\n`);
    }
    return fs.readdirSync(directory).filter(name => name.endsWith('.ts')).map(name => path.join(directory, name));
  }

  for (const action of ['Clear', 'dispose'] as const) {
    for (const phase of ['enumeration', 'second file read'] as const) {
      it(`${action} during ${phase} revokes the folder add while sibling context and a later add remain usable`, async () => {
        const paths = files(3);
        const sibling = await manager.addSelectionToContext(paths[0], 'sibling-only-canary', 1, 1, 'typescript', 'sibling');
        const started = deferred(), release = deferred();
        const readFile = contextFileReader.readContextFileText.bind(contextFileReader);
        const read = vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation(async (file, options) => {
          if (phase === 'second file read' && String(file) === paths[1]) {
            started.resolve(); await release.promise;
          }
          return readFile(file, options);
        });
        const opendir = fs.promises.opendir.bind(fs.promises);
        vi.spyOn(fs.promises, 'opendir').mockImplementation(async (directory, options) => {
          if (phase === 'enumeration' && String(directory) === folder) {
            started.resolve(); await release.promise;
          }
          return opendir(directory, options);
        });
        const persist = vi.spyOn(store, 'update');
        const pending = manager.addFolderToContext(folder, 'sidebar');
        await started.promise;
        const beforeAction = manager.getContext('sidebar');
        if (action === 'Clear') manager.clearContext('sidebar');
        else manager.clearPanelContext('sidebar');
        const writesAfterAction = persist.mock.calls.length;
        release.resolve();
        const result = await pending;
        expect(beforeAction.map(item => item.path)).toEqual(phase === 'enumeration' ? [] : [paths[0]]);
        expect(result).toEqual([]);
        if (action === 'dispose') {
          expect((manager as unknown as { _panelContexts: Map<string, ContextItem[]> })._panelContexts.has('sidebar')).toBe(false);
        }
        expect(manager.getContext('sidebar')).toEqual([]);
        expect(manager.formatContextForPrompt('sidebar')).toBe('');
        expect(persist).toHaveBeenCalledTimes(writesAfterAction);
        if (action === 'Clear') expect(store._store.get('mysti.context:sidebar')).toEqual([]);
        else expect(store._store.has('mysti.context:sidebar')).toBe(false);
        expect(manager.getContext('sibling')).toEqual([sibling]);
        expect(manager.formatContextForPrompt('sibling')).toContain('sibling-only-canary');
        expect(store._store.get('mysti.context:sibling')).toEqual([sibling]);
        expect(read.mock.calls.map(call => String(call[0]))).toEqual(phase === 'enumeration' ? [] : paths.slice(0, 2));

        const recovery = path.join(root, 'recovery'); fs.mkdirSync(recovery);
        fs.writeFileSync(path.join(recovery, 'fresh.ts'), 'fresh-folder-canary');
        const fresh = await manager.addFolderToContext(recovery, 'sidebar');
        expect(fresh).toHaveLength(1);
        expect(manager.getContext('sidebar')).toEqual(fresh);
        expect(manager.formatContextForPrompt('sidebar')).toContain('fresh-folder-canary');
        expect(manager.formatContextForPrompt('sidebar')).not.toContain('file-canary-');
        expect((store._store.get('mysti.context:sidebar') as ContextItem[]).map(item => item.path)).toEqual([path.join(recovery, 'fresh.ts')]);
      });
    }
  }

  it('an already revoked caller causes no enumeration, file read or persisted state', async () => {
    files(1);
    const enumerate = vi.spyOn(fs.promises, 'opendir');
    const read = vi.spyOn(contextFileReader, 'readContextFileText');
    expect(await manager.addFolderToContext(folder, 'sidebar', () => false)).toEqual([]);
    expect(enumerate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(manager.getContext('sidebar')).toEqual([]);
    expect(store._store.has('mysti.context:sidebar')).toBe(false);
  });

  it('caller revocation during a recursive walk stops later directory visits and file additions', async () => {
    const first = path.join(folder, 'first'), later = path.join(folder, 'later');
    fs.mkdirSync(first); fs.mkdirSync(later);
    const directories = fs.readdirSync(folder).map(name => path.join(folder, name));
    for (const directory of directories) files(1, directory);
    const started = deferred(), release = deferred();
    const opendir = fs.promises.opendir.bind(fs.promises);
    const enumerate = vi.spyOn(fs.promises, 'opendir').mockImplementation(async (directory, options) => {
      if (String(directory) === directories[0]) { started.resolve(); await release.promise; }
      return opendir(directory, options);
    });
    const read = vi.spyOn(contextFileReader, 'readContextFileText');
    let current = true;
    const pending = manager.addFolderToContext(folder, 'sidebar', () => current);
    await started.promise;
    current = false; release.resolve();
    expect(await pending).toEqual([]);
    expect(enumerate.mock.calls.map(call => String(call[0]))).toEqual([folder, directories[0]]);
    expect(read).not.toHaveBeenCalled();
    expect(manager.formatContextForPrompt('sidebar')).toBe('');
    expect(store._store.has('mysti.context:sidebar')).toBe(false);
  });

  for (const count of [19, 20, 21]) {
    it(`${count} eligible files retain the first-20 cap and skip generated directories`, async () => {
      const paths = files(count);
      for (const name of ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']) {
        const ignored = path.join(folder, name); fs.mkdirSync(ignored);
        fs.writeFileSync(path.join(ignored, 'secret.ts'), 'ignored-directory-canary');
      }
      const enumerate = vi.spyOn(fs.promises, 'opendir');
      const result = await manager.addFolderToContext(folder, 'sidebar');
      expect(result.map(item => item.path)).toEqual(paths.slice(0, 20));
      expect(manager.getContext('sidebar')).toEqual(result);
      expect((store._store.get('mysti.context:sidebar') as ContextItem[]).map(item => item.path)).toEqual(paths.slice(0, 20));
      expect(manager.formatContextForPrompt('sidebar')).not.toContain('ignored-directory-canary');
      expect(enumerate.mock.calls.map(call => String(call[0]))).toEqual([folder]);
      for (const item of result) expect(item.content).toBe(fs.readFileSync(item.path, 'utf8'));
    });
  }

  it('does not visit later directories once the first 20 eligible paths have been found', async () => {
    fs.mkdirSync(path.join(folder, 'first')); fs.mkdirSync(path.join(folder, 'later'));
    const directories = fs.readdirSync(folder).map(name => path.join(folder, name));
    const expected = files(20, directories[0]); files(1, directories[1]);
    const enumerate = vi.spyOn(fs.promises, 'opendir');
    const result = await manager.addFolderToContext(folder, 'sidebar');
    expect(result.map(item => item.path)).toEqual(expected);
    expect(enumerate.mock.calls.map(call => String(call[0]))).toEqual([folder, directories[0]]);
  });

  it('folder intent supersedes a saved-context restore before enumeration completes', async () => {
    const expected = files(1);
    const savedPath = path.join(root, 'saved.ts'); fs.writeFileSync(savedPath, 'stale-restore-canary');
    store._store.set('mysti.context:sidebar', [{ id: 'saved', type: 'file', path: savedPath, enabled: true }]);
    const restoreStarted = deferred(), restoreRelease = deferred();
    const folderStarted = deferred(), folderRelease = deferred();
    const readFile = contextFileReader.readContextFileText.bind(contextFileReader);
    vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation(async (file, options) => {
      if (String(file) === savedPath) { restoreStarted.resolve(); await restoreRelease.promise; }
      return readFile(file, options);
    });
    const opendir = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, 'opendir').mockImplementation(async (directory, options) => {
      if (String(directory) === folder) { folderStarted.resolve(); await folderRelease.promise; }
      return opendir(directory, options);
    });
    const persist = vi.spyOn(store, 'update');
    const restore = manager.restorePanelContext('sidebar');
    await restoreStarted.promise;
    const addition = manager.addFolderToContext(folder, 'sidebar');
    await folderStarted.promise;
    restoreRelease.resolve();
    const restored = await restore;
    const writesDuringEnumeration = persist.mock.calls.length;
    folderRelease.resolve();
    const result = await addition;
    expect(restored).toEqual([]);
    expect(writesDuringEnumeration).toBe(0);
    expect(result.map(item => item.path)).toEqual(expected);
    expect(manager.getContext('sidebar')).toEqual(result);
    expect(manager.formatContextForPrompt('sidebar')).not.toContain('stale-restore-canary');
    expect((store._store.get('mysti.context:sidebar') as ContextItem[]).map(item => item.path)).toEqual(expected);
  });

  it('a captured guard survives additions and toggles but is revoked by remove, Clear and disposal', async () => {
    const [file] = files(1);
    const guard = manager.captureContextGuard();
    const sibling = manager.captureContextGuard('sibling');
    const item = await manager.addFileToContext(file);
    await manager.addSelectionToContext(file, 'snapshot', 1, 1);
    manager.setItemEnabled(item!.id, false);
    manager.toggleItem(item!.id);
    expect(guard()).toBe(true);
    manager.removeFromContext(item!.id);
    expect(guard()).toBe(false);
    const afterRemove = manager.captureContextGuard();
    manager.clearContext();
    expect(afterRemove()).toBe(false);
    const afterClear = manager.captureContextGuard();
    manager.clearPanelContext('default');
    expect(afterClear()).toBe(false);
    expect(sibling()).toBe(true);
    expect(manager.captureContextGuard()()).toBe(true);
  });

  it('normal restoration preserves a captured guard for the same context', async () => {
    const guard = manager.captureContextGuard('sidebar');
    const snapshot: ContextItem = { id: 'selection', type: 'selection', path: 'restored.ts', content: 'saved snapshot', enabled: true };
    store._store.set('mysti.context:sidebar', [snapshot]);
    expect(await manager.restorePanelContext('sidebar')).toEqual([snapshot]);
    expect(guard()).toBe(true);
    expect(manager.captureContextGuard('sidebar')()).toBe(true);
    expect(manager.formatContextForPrompt('sidebar')).toContain('saved snapshot');
  });

  it('duplicates and unreadable files do not expand the first-20 candidate prefix, and symlinks are skipped', async () => {
    const paths = files(21);
    const duplicate = await manager.addFileToContext(paths[0], 'sidebar');
    fs.symlinkSync(paths[20], path.join(folder, '00-linked-file.ts'));
    const linkedDirectory = path.join(root, 'linked'); fs.mkdirSync(linkedDirectory);
    fs.writeFileSync(path.join(linkedDirectory, 'secret.ts'), 'symlink-target-canary');
    fs.symlinkSync(linkedDirectory, path.join(folder, '00-linked-directory'));
    const readFile = contextFileReader.readContextFileText.bind(contextFileReader);
    const read = vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation(async (file, options) => {
      if (String(file) === paths[1]) { throw new Error('fixture read failure'); }
      return readFile(file, options);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await manager.addFolderToContext(folder, 'sidebar');
    expect(result.map(item => item.path)).toEqual(paths.slice(2, 20));
    expect(read.mock.calls.map(call => String(call[0]))).toEqual(paths.slice(1, 20));
    expect(manager.getContext('sidebar')).toEqual([duplicate, ...result]);
    expect(manager.formatContextForPrompt('sidebar')).not.toContain('symlink-target-canary');
    expect((store._store.get('mysti.context:sidebar') as ContextItem[]).map(item => item.path)).toEqual([paths[0], ...paths.slice(2, 20)]);
  });
});
