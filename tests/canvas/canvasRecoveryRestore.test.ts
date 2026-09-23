/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Restoring failed-close recovery copies (followup to R8d). Restore is always
 * an explicit action, never overwrites newer edits, never silently resurrects
 * a deleted design, and only offers copies that belong to this workspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import {
  listCanvasRecoveryCopies, offerCanvasRecovery, promptCanvasRecoveryRestore,
  restoreCanvasRecoveryCopy, retainUnsavedCanvasDesign, sameWorkspace,
} from '../../src/canvas/CanvasCloseRecovery';
import type { CanvasArtifact } from '../../src/types';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let root: string;
let storage: string;
let store: ArtifactStore;
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeEach(() => {
  root = tempDir('mysti-recover-ws-');
  storage = tempDir('mysti-recover-storage-');
  store = new ArtifactStore({ getRoot: () => root });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A saved design with one image, and a separate in-memory copy carrying unsaved edits. */
async function savedDesignWithUnsavedEdits(name = 'Brand') {
  const design = store.createArtifact({ name, kind: 'screens' });
  const asset = await store.addAsset(design, PNG_B64, 'image/png', { role: 'image' });
  store.insertPage(design, store.makePage({ mode: 'jsx', jsxSource: `function Page(){ return <img src="${asset!.ref}" />; }` }));
  await store.save(design);
  const unsaved = structuredClone(design);
  unsaved.name = `${name} edited`;
  store.insertPage(unsaved, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){ return <p>unsaved</p>; }' }));
  return { design, unsaved, ref: asset!.ref };
}

async function retain(artifact: CanvasArtifact, withStore = store): Promise<string> {
  const message = await retainUnsavedCanvasDesign(storage, withStore, artifact, new Error('disk full'));
  const file = /recovery copy: (.+?\.json)/.exec(message)?.[1];
  expect(file, message).toBeTruthy();
  return file!;
}

const never = { isOpen: () => false, confirmResurrect: vi.fn(async () => false) };
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('canvas recovery copies: restore', () => {
  it('records the workspace and the on-disk design the copy would replace', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const onDisk = await store.load(design.id);
    const copy = readJson(await retain(unsaved));
    expect(copy.mystiRecovery).toMatchObject({
      workspace: path.resolve(root),
      base: { version: onDisk!.version, updatedAt: onDisk!.updatedAt },
    });
    expect(copy).toMatchObject({ id: design.id, name: 'Brand edited', schemaVersion: 1 });
  });

  it('restores an untouched design in place and retires the copy', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const file = await retain(unsaved);
    const outcome = await restoreCanvasRecoveryCopy(file, store, never);
    expect(outcome).toMatchObject({ ok: true, mode: 'in-place', artifactId: design.id });
    const restored = await store.load(design.id);
    expect(restored!.name).toBe('Brand edited');
    expect(restored!.pages).toHaveLength(2);
    expect(await store.list()).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(file), 'restored', path.basename(file)))).toBe(true);
    expect(await listCanvasRecoveryCopies(storage, store)).toEqual([]);
  });

  it('restores as a NEW design, with its images, when the design on disk is newer', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const file = await retain(unsaved);
    design.name = 'Brand newer';
    await store.save(design);

    const outcome = await restoreCanvasRecoveryCopy(file, store, never);
    expect(outcome).toMatchObject({ ok: true, mode: 'new', name: 'Brand edited (recovered)' });
    if (!outcome.ok) { return; }
    expect(outcome.artifactId).not.toBe(design.id);
    expect((await store.load(design.id))!.name).toBe('Brand newer');
    const recovered = (await store.load(outcome.artifactId))!;
    expect(recovered.pages).toHaveLength(2);
    const text = JSON.stringify(recovered);
    expect(text).not.toContain(`asset://${design.id}/`);
    const ref = recovered.assets[0].ref;
    expect(ref.startsWith(`asset://${outcome.artifactId}/assets/`)).toBe(true);
    expect((await store.readAssetBytes(ref))?.toString('base64')).toBe(PNG_B64);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('asks before bringing back a design deleted after the copy was made, and restores it as new', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const file = await retain(unsaved);
    await store.delete(design.id);

    const declined = vi.fn(async () => false);
    const refused = await restoreCanvasRecoveryCopy(file, store, { isOpen: () => false, confirmResurrect: declined });
    expect(declined).toHaveBeenCalledExactlyOnceWith('Brand edited');
    expect(refused).toMatchObject({ ok: false, reason: 'declined' });
    expect(await store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);

    const accepted = vi.fn(async () => true);
    const outcome = await restoreCanvasRecoveryCopy(file, store, { isOpen: () => false, confirmResurrect: accepted });
    expect(accepted).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ ok: true, mode: 'new', name: 'Brand edited (recovered)' });
    expect(outcome.ok && outcome.artifactId).not.toBe(design.id);
    expect(await store.load(design.id)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('restores a never-saved design in place without asking', async () => {
    const fresh = store.createArtifact({ name: 'Draft' });
    const file = await retain(fresh);
    expect(readJson(file).mystiRecovery.base).toBeNull();
    const confirm = vi.fn(async () => true);
    const outcome = await restoreCanvasRecoveryCopy(file, store, { isOpen: () => false, confirmResurrect: confirm });
    expect(outcome).toMatchObject({ ok: true, mode: 'in-place', artifactId: fresh.id });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rejects an invalid copy through the store validation and leaves it in place', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const file = await retain(unsaved);
    const broken = readJson(file);
    broken.pages = 'not pages';
    fs.writeFileSync(file, JSON.stringify(broken));
    const before = fs.readFileSync(path.join(root, '.mysti', 'canvas', design.id, 'artifact.json'), 'utf8');

    expect(await restoreCanvasRecoveryCopy(file, store, never)).toMatchObject({ ok: false, reason: 'invalid' });
    const tooNew = { ...broken, pages: [], schemaVersion: 99 };
    fs.writeFileSync(file, JSON.stringify(tooNew));
    expect(await restoreCanvasRecoveryCopy(file, store, never)).toMatchObject({ ok: false, reason: 'invalid' });

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(path.join(root, '.mysti', 'canvas', design.id, 'artifact.json'), 'utf8')).toBe(before);
    expect(await store.list()).toHaveLength(1);
  });

  it('never offers or restores another workspace\'s copy, or a copy with no workspace identity', async () => {
    const otherRoot = tempDir('mysti-recover-other-');
    const other = new ArtifactStore({ getRoot: () => otherRoot });
    const foreign = await retain(other.createArtifact({ name: 'Theirs' }), other);
    const legacy = path.join(storage, 'canvas-recovery', 'legacy-1.json');
    fs.writeFileSync(legacy, JSON.stringify({ ...store.createArtifact({ name: 'Old' }), schemaVersion: 1 }));
    const mine = await retain(store.createArtifact({ name: 'Mine' }));

    expect((await listCanvasRecoveryCopies(storage, store)).map(c => c.file)).toEqual([mine]);
    expect(await restoreCanvasRecoveryCopy(foreign, store, never)).toMatchObject({ ok: false, reason: 'foreign' });
    expect(await restoreCanvasRecoveryCopy(legacy, store, never)).toMatchObject({ ok: false, reason: 'foreign' });
    expect(fs.existsSync(foreign) && fs.existsSync(legacy)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it('restores as new, leaving the live design alone, when that design is open in a view', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const file = await retain(unsaved);
    const liveBefore = JSON.stringify(design);
    const outcome = await restoreCanvasRecoveryCopy(file, store, { ...never, isOpen: id => id === design.id });
    expect(outcome).toMatchObject({ ok: true, mode: 'new' });
    expect(JSON.stringify(design)).toBe(liveBefore);
    expect((await store.load(design.id))!.name).toBe('Brand');
  });

  it('a save queued by a concurrent session wins the queue and the copy is restored as new', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const file = await retain(unsaved);
    design.name = 'Saved by the open view';
    const saving = store.save(design);
    const restoring = restoreCanvasRecoveryCopy(file, store, never);
    await saving;
    expect(await restoring).toMatchObject({ ok: true, mode: 'new' });
    expect((await store.load(design.id))!.name).toBe('Saved by the open view');
  });

  it('replaceIfUnchanged re-checks inside the queue, so a save queued first is never overwritten', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const onDisk = (await store.load(design.id))!;
    design.name = 'Queued first';
    const saving = store.save(design);
    const replaced = store.replaceIfUnchanged(unsaved, { version: onDisk.version, updatedAt: onDisk.updatedAt });
    await saving;
    expect(await replaced).toBe(false);
    expect((await store.load(design.id))!.name).toBe('Queued first');
  });

  it('keeps the copy and reports it when the restored design cannot be retired', async () => {
    const fresh = store.createArtifact({ name: 'Draft' });
    const file = await retain(fresh);
    fs.writeFileSync(path.join(path.dirname(file), 'restored'), 'not a directory');
    const outcome = await restoreCanvasRecoveryCopy(file, store, never);
    expect(outcome).toMatchObject({ ok: true, mode: 'in-place' });
    expect(outcome.ok && outcome.retireError).toBeTruthy();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('compares workspace identity case-insensitively on Windows only', () => {
    const a = path.resolve('Work', 'Space');
    const b = path.resolve('work', 'space');
    expect(sameWorkspace(a, b, 'win32')).toBe(true);
    expect(sameWorkspace(a, b, 'linux')).toBe(false);
    expect(sameWorkspace(a, b, 'darwin')).toBe(false);
    expect(sameWorkspace(a, a, 'linux')).toBe(true);
  });
});

describe('canvas recovery copies: prompts', () => {
  it('on open, mentions this workspace\'s copies and restores only when the user clicks', async () => {
    await retain(store.createArtifact({ name: 'Mine' }));
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const restore = vi.fn(async () => undefined);
    await offerCanvasRecovery(storage, store, restore);
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0][0])).toContain('"Mine"');
    expect(restore).not.toHaveBeenCalled();

    info.mockResolvedValue('Restore…' as never);
    await offerCanvasRecovery(storage, store, restore);
    expect(restore).toHaveBeenCalledOnce();
  });

  it('on open, says nothing when this workspace has no copies', async () => {
    const other = new ArtifactStore({ getRoot: () => tempDir('mysti-recover-other-') });
    await retain(other.createArtifact({ name: 'Theirs' }), other);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await offerCanvasRecovery(storage, store, vi.fn());
    expect(info).not.toHaveBeenCalled();
  });

  it('the command asks with a modal before resurrecting a deleted design', async () => {
    const { design, unsaved } = await savedDesignWithUnsavedEdits();
    const file = await retain(unsaved);
    await store.delete(design.id);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items: any) => (await items)[0]);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const outcome = await promptCanvasRecoveryRestore(storage, store, () => false);
    expect(outcome).toMatchObject({ ok: false, reason: 'declined' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toEqual({ modal: true });
    expect(fs.existsSync(file)).toBe(true);
  });
});
