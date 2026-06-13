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
 * CanvasSecrets tests (Plan 05 Phase 0, F-11): SecretStorage-backed key store
 * with one-time migration from the legacy mysti.canvas.*ApiKey settings.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CanvasSecrets } from '../../src/services/CanvasSecrets';
import {
  createMockSecretStorage,
  createMockMemento,
  setMockConfig,
  clearMockConfig,
  getMockConfigUpdates,
} from '../helpers/mockVscode';

afterEach(() => {
  clearMockConfig();
});

describe('CanvasSecrets', () => {
  it('get() returns empty string when nothing is stored', async () => {
    const secrets = createMockSecretStorage();
    const memento = createMockMemento();
    const cs = new CanvasSecrets(secrets as any, memento as any);

    expect(await cs.get('openai')).toBe('');
    expect(await cs.get('gemini')).toBe('');
    expect(await cs.get('stitch')).toBe('');
  });

  it('set() stores a key under a namespaced SecretStorage key, get() reads it back', async () => {
    const secrets = createMockSecretStorage();
    const memento = createMockMemento();
    const cs = new CanvasSecrets(secrets as any, memento as any);

    await cs.set('openai', 'sk-abc123');
    expect(await cs.get('openai')).toBe('sk-abc123');
    expect(secrets._store.get('mysti.canvas.openaiApiKey')).toBe('sk-abc123');
  });

  it('set() trims whitespace and deletes on empty value', async () => {
    const secrets = createMockSecretStorage();
    const cs = new CanvasSecrets(secrets as any, createMockMemento() as any);

    await cs.set('gemini', '  key-with-spaces  ');
    expect(await cs.get('gemini')).toBe('key-with-spaces');

    await cs.set('gemini', '');
    expect(await cs.get('gemini')).toBe('');
    expect(secrets._store.has('mysti.canvas.geminiApiKey')).toBe(false);
  });

  it('delete() removes a stored key', async () => {
    const secrets = createMockSecretStorage();
    const cs = new CanvasSecrets(secrets as any, createMockMemento() as any);

    await cs.set('stitch', 'AQ.xxx');
    expect(await cs.get('stitch')).toBe('AQ.xxx');

    await cs.delete('stitch');
    expect(await cs.get('stitch')).toBe('');
  });

  it('migrate() copies plaintext settings into SecretStorage and clears the settings', async () => {
    setMockConfig('canvas.openaiApiKey', 'sk-from-settings');
    setMockConfig('canvas.geminiApiKey', 'gem-from-settings');
    setMockConfig('canvas.stitchApiKey', 'AQ.from-settings');

    const secrets = createMockSecretStorage();
    const memento = createMockMemento();
    const cs = new CanvasSecrets(secrets as any, memento as any);

    const migrated = await cs.migrate();

    expect(migrated.sort()).toEqual(['gemini', 'openai', 'stitch']);
    expect(await cs.get('openai')).toBe('sk-from-settings');
    expect(await cs.get('gemini')).toBe('gem-from-settings');
    expect(await cs.get('stitch')).toBe('AQ.from-settings');

    // Settings cleared (recorded as update(key, undefined)).
    const updates = getMockConfigUpdates();
    expect('canvas.openaiApiKey' in updates).toBe(true);
    expect(updates['canvas.openaiApiKey']).toBeUndefined();
    expect('canvas.geminiApiKey' in updates).toBe(true);
    expect('canvas.stitchApiKey' in updates).toBe(true);
  });

  it('migrate() is a no-op when no legacy settings exist', async () => {
    const secrets = createMockSecretStorage();
    const cs = new CanvasSecrets(secrets as any, createMockMemento() as any);

    const migrated = await cs.migrate();
    expect(migrated).toEqual([]);
    expect(secrets._store.size).toBe(0);
  });

  it('migrate() runs only once (guarded by globalState flag)', async () => {
    setMockConfig('canvas.openaiApiKey', 'sk-first');

    const secrets = createMockSecretStorage();
    const memento = createMockMemento();
    const cs = new CanvasSecrets(secrets as any, memento as any);

    const first = await cs.migrate();
    expect(first).toEqual(['openai']);

    // Even if a new legacy setting appears, the second run is skipped.
    setMockConfig('canvas.geminiApiKey', 'gem-late');
    const second = await cs.migrate();
    expect(second).toEqual([]);
    expect(await cs.get('gemini')).toBe('');
  });

  it('migrate() does not overwrite a key already in SecretStorage', async () => {
    setMockConfig('canvas.openaiApiKey', 'sk-from-settings');

    const secrets = createMockSecretStorage();
    const cs = new CanvasSecrets(secrets as any, createMockMemento() as any);

    // User already moved a key into SecretStorage via set().
    await cs.set('openai', 'sk-already-secret');

    const migrated = await cs.migrate();
    // Nothing migrated (existing secret preserved), but the stale setting is still cleared.
    expect(migrated).toEqual([]);
    expect(await cs.get('openai')).toBe('sk-already-secret');
    expect('canvas.openaiApiKey' in getMockConfigUpdates()).toBe(true);
  });
});
