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
import { createMockSecretStorage, env as mockEnv, window as mockWindow } from '../helpers/mockVscode';

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
    expect(state.apiUrl).toBe('https://api.v2.deepmyst.com');
    expect(state.webUrl).toBe('https://v2.deepmyst.com');
    mgr.dispose();
  });

  it('browser sign-in opens the connect URL and stores the key from the link-back', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const openSpy = vi.spyOn(mockEnv, 'openExternal').mockResolvedValue(true);
    const { context, secrets } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();

    const signInPromise = mgr.signIn();
    // Let signIn arm the pending callback + open the browser.
    await new Promise((r) => setTimeout(r, 0));

    expect(openSpy).toHaveBeenCalled();
    const opened = String((openSpy.mock.calls[0][0] as any).toString());
    expect(opened).toContain('https://v2.deepmyst.com/connect/vscode');
    expect(opened).toContain('redirect_uri=');
    const state = new URLSearchParams(opened.split('?')[1]).get('state');
    expect(state).toBeTruthy();

    // Simulate the browser link-back with the matching state.
    await mgr.completeSignIn(GOOD_KEY, state!);
    const ok = await signInPromise;

    expect(ok).toBe(true);
    expect(mgr.isSignedIn()).toBe(true);
    expect(secrets._store.get('mysti.deepmyst.apiKey')).toBe(GOOD_KEY);
    mgr.dispose();
  });

  it('handles repeated sign-in clicks: a link-back from an EARLIER tab still completes (and supersedes the rest)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const openSpy = vi.spyOn(mockEnv, 'openExternal').mockResolvedValue(true);
    const inputSpy = vi.spyOn(mockWindow, 'showInputBox');
    const { context, secrets } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();

    // Three "Sign in" clicks → three tabs, three distinct states, all tracked.
    const p1 = mgr.signIn();
    await new Promise((r) => setTimeout(r, 0));
    const p2 = mgr.signIn();
    await new Promise((r) => setTimeout(r, 0));
    const p3 = mgr.signIn();
    await new Promise((r) => setTimeout(r, 0));

    const stateOf = (i: number) =>
      new URLSearchParams(String((openSpy.mock.calls[i][0] as any).toString()).split('?')[1]).get('state')!;
    const [s1, s2, s3] = [stateOf(0), stateOf(1), stateOf(2)];
    expect(new Set([s1, s2, s3]).size).toBe(3);

    // User completes the FIRST tab (oldest state). The old single-slot model
    // rejected this as a mismatch and hung all three notifications forever.
    const accepted = await mgr.completeSignIn(GOOD_KEY, s1);
    expect(accepted).toBe(true);

    const [r1] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(true);                       // the matching attempt stored the key
    expect(mgr.isSignedIn()).toBe(true);
    expect(secrets._store.get('mysti.deepmyst.apiKey')).toBe(GOOD_KEY);
    expect(inputSpy).not.toHaveBeenCalled();     // superseded tabs don't prompt manual entry
    mgr.dispose();
  });

  it('an ?error= link-back ends the waiting sign-in at once, without a manual-entry prompt', async () => {
    const openSpy = vi.spyOn(mockEnv, 'openExternal').mockResolvedValue(true);
    const inputSpy = vi.spyOn(mockWindow, 'showInputBox');
    const errorSpy = vi.spyOn(mockWindow, 'showErrorMessage');
    const { context } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();

    const signInPromise = mgr.signIn();
    await new Promise((r) => setTimeout(r, 0));
    const opened = String((openSpy.mock.calls[0][0] as any).toString());
    const state = new URLSearchParams(opened.split('?')[1]).get('state')!;

    // Before: the toast showed but "Waiting…" spun for 5 minutes, then asked
    // for a key the same account could not mint either.
    mgr.failSignIn('You do not have permission to create API keys.', state);

    expect(await signInPromise).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('DeepMyst sign-in failed: You do not have permission to create API keys.');
    mgr.dispose();
  });

  it('explains a generic browser 403 without claiming the key is invalid', () => {
    const errorSpy = vi.spyOn(mockWindow, 'showErrorMessage');
    const mgr = new DeepMystAuthManager(makeContext().context);
    mgr.failSignIn('Request failed with status code 403');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('active organization and API-key permissions'));
    mgr.dispose();
  });

  it('rejects a link-back whose state does not match the in-flight sign-in', async () => {
    const openSpy = vi.spyOn(mockEnv, 'openExternal').mockResolvedValue(true);
    const { context } = makeContext();
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();

    const signInPromise = mgr.signIn();
    await new Promise((r) => setTimeout(r, 0));

    const accepted = await mgr.completeSignIn(GOOD_KEY, 'wrong-state');
    expect(accepted).toBe(false);
    expect(mgr.isSignedIn()).toBe(false);

    // The in-flight signIn is still pending; cancel it by completing with the
    // real state so the test doesn't leak. Capture it from the open call.
    const opened = String((openSpy.mock.calls[0][0] as any).toString());
    const realState = new URLSearchParams(opened.split('?')[1]).get('state');
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await mgr.completeSignIn(GOOD_KEY, realState!);
    await signInPromise;
    mgr.dispose();
  });
});

describe('DeepMystAuthManager entitlement (fails closed)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const flush = () => new Promise(r => setImmediate(r));
  const answer = (body: Record<string, unknown>) =>
    ({ ok: true, status: 200, json: async () => body });

  async function signedIn() {
    const { context, secrets } = makeContext();
    await secrets.store('mysti.deepmyst.apiKey', GOOD_KEY);
    const mgr = new DeepMystAuthManager(context);
    await mgr.initialize();
    return mgr;
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is false before any answer, and starts only one check however often it is asked', async () => {
    fetchMock.mockResolvedValue(answer({ entitled: true, tier: 'pro' }));
    const mgr = await signedIn();
    expect(mgr.hasEntitlement()).toBe(false);
    expect(mgr.hasEntitlement()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush();
    expect(mgr.hasEntitlement()).toBe(true);
    mgr.dispose();
  });

  it.each([
    ['a 503', () => fetchMock.mockResolvedValue({ ok: false, status: 503 })],
    ['a 404', () => fetchMock.mockResolvedValue({ ok: false, status: 404 })],
    ['a network error', () => fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))],
  ])('treats %s as NOT entitled', async (_label, arrange) => {
    arrange();
    const mgr = await signedIn();
    const e = await mgr.ensureActiveAccount();
    expect(e.entitled).toBe(false);
    expect(mgr.hasEntitlement()).toBe(false);
    mgr.dispose();
  });

  it('retries a failed check after 30s, not 5 minutes', async () => {
    const t0 = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(answer({ entitled: true, tier: 'pro' }));
    const mgr = await signedIn();
    await mgr.ensureActiveAccount();
    now.mockReturnValue(t0 + 29_000);
    expect(mgr.hasEntitlement()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + 31_000);
    mgr.hasEntitlement();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mgr.hasEntitlement()).toBe(true);
    mgr.dispose();
  });

  it('keeps a stale server "yes" while it refreshes, so a paying user is not flipped off', async () => {
    const t0 = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    fetchMock.mockResolvedValue(answer({ entitled: true, tier: 'pro' }));
    const mgr = await signedIn();
    await mgr.ensureActiveAccount();
    now.mockReturnValue(t0 + 6 * 60_000);
    expect(mgr.hasEntitlement()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    mgr.dispose();
  });

  it('derives NOT entitled when the server omits both `entitled` and a balance', async () => {
    fetchMock.mockResolvedValue(answer({ tier: 'free' }));
    const mgr = await signedIn();
    expect((await mgr.ensureActiveAccount()).entitled).toBe(false);
    mgr.dispose();
  });
});
