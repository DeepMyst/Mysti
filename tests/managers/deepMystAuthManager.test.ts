/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for DeepMystAuthManager (Plan 04). Covers the deep-link/paste
 * completion path (validate -> store -> event), rejection of bad keys,
 * sign-out, persistence across reload, and exposed state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as vscode from 'vscode';
import { DeepMystAuthManager } from '../../src/managers/DeepMystAuthManager';
import { createMockSecretStorage } from '../helpers/mockVscode';

const GOOD_KEY = 'dm_live_abcdef1234567890';

function makeContext() {
  const secrets = createMockSecretStorage();
  const context = { secrets } as unknown as vscode.ExtensionContext;
  return { context, secrets };
}

describe('DeepMystAuthManager', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts signed out', async () => {
    const { context } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();
    expect(mgr.isSignedIn()).toBe(false);
    expect(mgr.getApiKey()).toBeUndefined();
    expect(mgr.getState().signedIn).toBe(false);
    mgr.dispose();
  });

  it('completeSignIn validates, stores the key, and fires onDidChangeAuth', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { context, secrets } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();

    const events: boolean[] = [];
    mgr.onDidChangeAuth(s => events.push(s.signedIn));

    const ok = await mgr.completeSignIn(GOOD_KEY);
    expect(ok).toBe(true);
    expect(mgr.isSignedIn()).toBe(true);
    expect(mgr.getApiKey()).toBe(GOOD_KEY);
    expect(secrets._store.get('mysti.deepmyst.apiKey')).toBe(GOOD_KEY);
    expect(events).toEqual([true]);
    mgr.dispose();
  });

  it('rejects a key DeepMyst returns 401 for (no store, no event)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const { context, secrets } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();

    const events: boolean[] = [];
    mgr.onDidChangeAuth(s => events.push(s.signedIn));

    const ok = await mgr.completeSignIn(GOOD_KEY);
    expect(ok).toBe(false);
    expect(mgr.isSignedIn()).toBe(false);
    expect(secrets._store.has('mysti.deepmyst.apiKey')).toBe(false);
    expect(events).toEqual([]);
    mgr.dispose();
  });

  it('rejects a syntactically invalid key without a network call', async () => {
    const { context } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();
    const ok = await mgr.completeSignIn('not-a-dm-key');
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    mgr.dispose();
  });

  it('signOut clears the key and fires the event', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { context, secrets } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();
    await mgr.completeSignIn(GOOD_KEY);

    const events: boolean[] = [];
    mgr.onDidChangeAuth(s => events.push(s.signedIn));

    await mgr.signOut();
    expect(mgr.isSignedIn()).toBe(false);
    expect(secrets._store.has('mysti.deepmyst.apiKey')).toBe(false);
    expect(events).toEqual([false]);
    mgr.dispose();
  });

  it('loads a previously-stored key on initialize (persists across reload)', async () => {
    const { context, secrets } = makeContext();
    await secrets.store('mysti.deepmyst.apiKey', GOOD_KEY);

    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();
    expect(mgr.isSignedIn()).toBe(true);
    expect(mgr.getApiKey()).toBe(GOOD_KEY);
    mgr.dispose();
  });

  it('exposes the configured (default) URLs in state', async () => {
    const { context } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();
    const state = mgr.getState();
    expect(state.apiUrl).toContain('deepmyst');
    expect(state.webUrl).toContain('deepmyst');
    mgr.dispose();
  });
});
