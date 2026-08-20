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
 * CanvasSecrets tests (Plan 05 Phase 0, F-11 + Plan 20 §3.6): SecretStorage-backed
 * key store whose one-time migration adopts a **user (Global)** value only — a
 * workspace-scoped key comes from the checked-out repository, not from the
 * person using it, so it is reported and cleared, never adopted.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { CanvasSecrets } from '../../src/services/CanvasSecrets';
import {
  createMockSecretStorage,
  createMockMemento,
  workspace,
  window,
  ConfigurationTarget,
} from '../helpers/mockVscode';

/** A per-scope settings fake with a real `inspect()`, like VS Code's. */
function fakeConfig(scopes: Partial<Record<'global' | 'workspace' | 'folder', Record<string, string>>>) {
  const global = { ...(scopes.global ?? {}) };
  const ws = { ...(scopes.workspace ?? {}) };
  const folder = { ...(scopes.folder ?? {}) };
  const updates: Array<{ key: string; value: unknown; target: number | undefined }> = [];
  return {
    updates,
    global, ws, folder,
    config: {
      // `get` collapses the scopes exactly like VS Code does — which is why
      // migrate() must not use it.
      get<T>(key: string, defaultValue?: T): T {
        const v = folder[key] ?? ws[key] ?? global[key];
        return (v === undefined ? defaultValue : v) as T;
      },
      has(key: string): boolean { return key in global || key in ws || key in folder; },
      inspect<T>(key: string) {
        return {
          key: `mysti.${key}`,
          globalValue: global[key] as T | undefined,
          workspaceValue: ws[key] as T | undefined,
          workspaceFolderValue: folder[key] as T | undefined,
        };
      },
      async update(key: string, value: unknown, target?: number): Promise<void> {
        updates.push({ key, value, target });
        if (value === undefined) {
          if (target === ConfigurationTarget.Workspace) { delete ws[key]; }
          else if (target === ConfigurationTarget.WorkspaceFolder) { delete folder[key]; }
          else { delete global[key]; }
        }
      },
    },
  };
}

let restoreConfig: (() => void) | null = null;

/** Point `vscode.workspace.getConfiguration('mysti')` at the fake. */
function useConfig(cfg: ReturnType<typeof fakeConfig>) {
  const spy = vi.spyOn(workspace, 'getConfiguration').mockReturnValue(cfg.config as never);
  restoreConfig = () => spy.mockRestore();
  return cfg;
}

afterEach(() => {
  restoreConfig?.();
  restoreConfig = null;
  vi.restoreAllMocks();
});

describe('CanvasSecrets', () => {
  it('get() returns empty string when nothing is stored', async () => {
    const cs = new CanvasSecrets(createMockSecretStorage() as never, createMockMemento() as never);
    expect(await cs.get('openai')).toBe('');
    expect(await cs.get('gemini')).toBe('');
    expect(await cs.get('stitch')).toBe('');
  });

  it('set() stores a key under a namespaced SecretStorage key, get() reads it back', async () => {
    const secrets = createMockSecretStorage();
    const cs = new CanvasSecrets(secrets as never, createMockMemento() as never);

    await cs.set('openai', 'sk-abc123');
    expect(await cs.get('openai')).toBe('sk-abc123');
    expect(secrets._store.get('mysti.canvas.openaiApiKey')).toBe('sk-abc123');
  });

  it('set() trims whitespace and deletes on empty value', async () => {
    const secrets = createMockSecretStorage();
    const cs = new CanvasSecrets(secrets as never, createMockMemento() as never);

    await cs.set('gemini', '  key-with-spaces  ');
    expect(await cs.get('gemini')).toBe('key-with-spaces');

    await cs.set('gemini', '');
    expect(await cs.get('gemini')).toBe('');
    expect(secrets._store.has('mysti.canvas.geminiApiKey')).toBe(false);
  });

  it('delete() removes a stored key', async () => {
    const secrets = createMockSecretStorage();
    const cs = new CanvasSecrets(secrets as never, createMockMemento() as never);

    await cs.set('stitch', 'AQ.xxx');
    expect(await cs.get('stitch')).toBe('AQ.xxx');

    await cs.delete('stitch');
    expect(await cs.get('stitch')).toBe('');
  });
});

describe('CanvasSecrets.migrate (user scope only)', () => {
  let secrets: ReturnType<typeof createMockSecretStorage>;
  let memento: ReturnType<typeof createMockMemento>;

  beforeEach(() => {
    secrets = createMockSecretStorage();
    memento = createMockMemento();
  });

  it('copies a USER-scoped plaintext setting into SecretStorage and clears it', async () => {
    const cfg = useConfig(fakeConfig({
      global: {
        'canvas.openaiApiKey': 'sk-from-settings',
        'canvas.geminiApiKey': 'gem-from-settings',
        'canvas.stitchApiKey': 'AQ.from-settings',
      },
    }));
    const cs = new CanvasSecrets(secrets as never, memento as never);

    expect((await cs.migrate()).sort()).toEqual(['gemini', 'openai', 'stitch']);
    expect(await cs.get('openai')).toBe('sk-from-settings');
    expect(await cs.get('gemini')).toBe('gem-from-settings');
    expect(await cs.get('stitch')).toBe('AQ.from-settings');

    const cleared = cfg.updates.filter(u => u.value === undefined && u.target === ConfigurationTarget.Global);
    expect(cleared.map(u => u.key).sort()).toEqual(['canvas.geminiApiKey', 'canvas.openaiApiKey', 'canvas.stitchApiKey']);
  });

  it('NEVER adopts a workspace-scoped key — it is cleared and reported', async () => {
    const warn = vi.spyOn(window, 'showWarningMessage');
    const cfg = useConfig(fakeConfig({
      workspace: { 'canvas.openaiApiKey': 'sk-attacker-planted-in-the-repo' },
    }));
    const cs = new CanvasSecrets(secrets as never, memento as never);

    expect(await cs.migrate()).toEqual([]);
    expect(await cs.get('openai')).toBe('');            // not adopted
    expect(secrets._store.size).toBe(0);
    expect(cfg.ws['canvas.openaiApiKey']).toBeUndefined();  // cleared
    expect(cfg.updates).toContainEqual({ key: 'canvas.openaiApiKey', value: undefined, target: ConfigurationTarget.Workspace });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('mysti.canvas.openaiApiKey');
  });

  it('clears a workspace-FOLDER value too', async () => {
    const cfg = useConfig(fakeConfig({ folder: { 'canvas.stitchApiKey': 'AQ.repo' } }));
    const cs = new CanvasSecrets(secrets as never, memento as never);

    expect(await cs.migrate()).toEqual([]);
    expect(await cs.get('stitch')).toBe('');
    expect(cfg.updates).toContainEqual({ key: 'canvas.stitchApiKey', value: undefined, target: ConfigurationTarget.WorkspaceFolder });
  });

  it('adopts the user value even when a workspace value shadows it', async () => {
    // `config.get()` would return the workspace value here — the whole reason
    // migrate() reads `inspect().globalValue`.
    const cfg = useConfig(fakeConfig({
      global: { 'canvas.openaiApiKey': 'sk-mine' },
      workspace: { 'canvas.openaiApiKey': 'sk-theirs' },
    }));
    expect(cfg.config.get('canvas.openaiApiKey')).toBe('sk-theirs');

    const cs = new CanvasSecrets(secrets as never, memento as never);
    expect(await cs.migrate()).toEqual(['openai']);
    expect(await cs.get('openai')).toBe('sk-mine');
  });

  it('purges workspace keys on EVERY activation, not just the migration run', async () => {
    // First activation: nothing anywhere → flag set.
    const first = useConfig(fakeConfig({}));
    const cs = new CanvasSecrets(secrets as never, memento as never);
    expect(await cs.migrate()).toEqual([]);
    expect(first.updates).toHaveLength(0);
    restoreConfig?.();

    // Later: the user clones a repo whose .vscode/settings.json plants a key.
    const later = useConfig(fakeConfig({ workspace: { 'canvas.geminiApiKey': 'planted' } }));
    expect(await cs.migrate()).toEqual([]);
    expect(await cs.get('gemini')).toBe('');
    expect(later.updates).toContainEqual({ key: 'canvas.geminiApiKey', value: undefined, target: ConfigurationTarget.Workspace });
  });

  it('migrate() is a no-op when no legacy settings exist', async () => {
    useConfig(fakeConfig({}));
    const cs = new CanvasSecrets(secrets as never, memento as never);
    expect(await cs.migrate()).toEqual([]);
    expect(secrets._store.size).toBe(0);
  });

  it('migrate() adopts only once (guarded by the globalState flag)', async () => {
    const cfg = useConfig(fakeConfig({ global: { 'canvas.openaiApiKey': 'sk-first' } }));
    const cs = new CanvasSecrets(secrets as never, memento as never);
    expect(await cs.migrate()).toEqual(['openai']);

    // Even if a new legacy setting appears, the second run adopts nothing.
    cfg.global['canvas.geminiApiKey'] = 'gem-late';
    expect(await cs.migrate()).toEqual([]);
    expect(await cs.get('gemini')).toBe('');
  });

  it('does not overwrite a key already in SecretStorage', async () => {
    const cfg = useConfig(fakeConfig({ global: { 'canvas.openaiApiKey': 'sk-from-settings' } }));
    const cs = new CanvasSecrets(secrets as never, memento as never);
    await cs.set('openai', 'sk-already-secret');

    expect(await cs.migrate()).toEqual([]);
    expect(await cs.get('openai')).toBe('sk-already-secret');
    // …but the stale plaintext setting is still cleared.
    expect(cfg.updates).toContainEqual({ key: 'canvas.openaiApiKey', value: undefined, target: ConfigurationTarget.Global });
  });

  it('adopts nothing (and leaves the flag unset) when the host has no inspect()', async () => {
    const cfg = fakeConfig({ global: { 'canvas.openaiApiKey': 'sk-x' } });
    delete (cfg.config as { inspect?: unknown }).inspect;
    useConfig(cfg);

    const cs = new CanvasSecrets(secrets as never, memento as never);
    expect(await cs.migrate()).toEqual([]);
    expect(await cs.get('openai')).toBe('');
    expect(cfg.updates).toHaveLength(0);
    expect(memento._store.has('mysti.canvas.secretsMigrated')).toBe(false);
  });

  it('ignores a non-string setting value', async () => {
    const cfg = fakeConfig({});
    (cfg.global as Record<string, unknown>)['canvas.openaiApiKey'] = { toString: () => 'sk-object' };
    (cfg.ws as Record<string, unknown>)['canvas.geminiApiKey'] = 42;
    useConfig(cfg);

    const cs = new CanvasSecrets(secrets as never, memento as never);
    expect(await cs.migrate()).toEqual([]);
    expect(secrets._store.size).toBe(0);
  });

  it('survives a read-only workspace config (update throws) without adopting', async () => {
    const cfg = fakeConfig({ workspace: { 'canvas.openaiApiKey': 'planted' } });
    cfg.config.update = async () => { throw new Error('read-only'); };
    useConfig(cfg);

    const cs = new CanvasSecrets(secrets as never, memento as never);
    await expect(cs.migrate()).resolves.toEqual([]);
    expect(await cs.get('openai')).toBe('');
  });
});
