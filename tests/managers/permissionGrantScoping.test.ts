/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 §25 — "don't ask again" is per ACTION TYPE (option A), and per BINARY
 * for bash (option B).
 *
 * It used to set the whole scope to `full-access` for an hour, so approving one
 * file edit silently authorised `bash-command`, `file-delete`, `web-request`
 * and `delegate` — while the button only said "don't ask again this session".
 * The first test here is the one that would have failed before the change, and
 * it is the reason the change exists.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PermissionManager, bashGrantToken } from '../../src/managers/PermissionManager';
import type { PermissionActionType, PermissionDetails } from '../../src/types';

let pm: PermissionManager;
const post = () => {};

/** Approve `type` with "always allow", then report whether `next` is auto-approved. */
async function grantThenAsk(
  type: PermissionActionType,
  next: PermissionActionType,
  opts: { grantDetails?: PermissionDetails; nextDetails?: PermissionDetails; scope?: string } = {},
): Promise<boolean> {
  const scope = opts.scope ?? 'panel-1';
  const details = opts.grantDetails ?? ({ riskLevel: 'low' } as PermissionDetails);
  const p = pm.requestPermission(type, 't', 'd', details, post, undefined, scope);
  const id = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
  pm.handleResponse({ requestId: id, decision: 'always-allow' });
  await p;

  // A second request of `next`: resolved without a card iff it was granted.
  let settled = false;
  const q = pm.requestPermission(next, 't2', 'd2', opts.nextDetails ?? ({ riskLevel: 'low' } as PermissionDetails),
    post, undefined, scope).then(v => { settled = true; return v; });
  await Promise.resolve();
  if (!settled) {
    const pendingId = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
    if (pendingId) { pm.handleResponse({ requestId: pendingId, decision: 'deny' }); }
    await q;
    return false;
  }
  await q;
  return true;
}

beforeEach(() => { pm = new PermissionManager('ask-permission'); });
afterEach(() => { vi.useRealTimers(); });

describe('a grant does not escalate to other action types', () => {
  it('approving a file edit does NOT auto-approve a bash command', async () => {
    // THE regression. Before Plan 27 §25 this returned true.
    expect(await grantThenAsk('file-edit', 'bash-command')).toBe(false);
  });

  it('approving a file edit does NOT auto-approve delegation', async () => {
    // `delegate` spawns a sub-agent that can run arbitrary tools.
    expect(await grantThenAsk('file-edit', 'delegate')).toBe(false);
  });

  it('approving a file edit does NOT auto-approve a delete', async () => {
    expect(await grantThenAsk('file-edit', 'file-delete')).toBe(false);
  });

  it('but it DOES auto-approve the same type again', async () => {
    expect(await grantThenAsk('file-edit', 'file-edit')).toBe(true);
  });

  it('and it does not leak across scopes', async () => {
    const p = pm.requestPermission('file-edit', 't', 'd', { riskLevel: 'low' } as PermissionDetails, post, undefined, 'panel-A');
    const id = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
    pm.handleResponse({ requestId: id, decision: 'always-allow' });
    await p;

    let settled = false;
    const q = pm.requestPermission('file-edit', 't', 'd', { riskLevel: 'low' } as PermissionDetails, post, undefined, 'panel-B')
      .then(() => { settled = true; });
    await Promise.resolve();
    expect(settled, 'a grant in panel-A auto-approved panel-B').toBe(false);
    const pid = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
    pm.handleResponse({ requestId: pid, decision: 'deny' });
    await q;
  });
});

describe('bash grants are keyed on the binary (option B)', () => {
  const cmd = (command: string) => ({ riskLevel: 'low', command } as PermissionDetails);

  it('approving npm does not approve curl', async () => {
    expect(await grantThenAsk('bash-command', 'bash-command', {
      grantDetails: cmd('npm test'), nextDetails: cmd('curl http://evil'),
    })).toBe(false);
  });

  it('approving npm approves another npm invocation', async () => {
    expect(await grantThenAsk('bash-command', 'bash-command', {
      grantDetails: cmd('npm test'), nextDetails: cmd('npm run build'),
    })).toBe(true);
  });

  it('a compound command records NOTHING — the next one asks again', async () => {
    expect(await grantThenAsk('bash-command', 'bash-command', {
      grantDetails: cmd('npm test && curl http://evil'), nextDetails: cmd('npm test'),
    })).toBe(false);
  });
});

describe('bashGrantToken is conservative', () => {
  it('reads a plain binary', () => {
    expect(bashGrantToken('npm test')).toBe('npm');
    expect(bashGrantToken('/usr/bin/git status')).toBe('/usr/bin/git');
  });

  it('refuses anything with shell metacharacters or substitution', () => {
    for (const c of [
      'npm test && curl x', 'npm test; rm -rf /', 'echo $(whoami)', 'cat a | sh',
      'npm `id`', 'ls *', 'x > y', 'a & b',
    ]) {
      expect(bashGrantToken(c), `${c} must not yield a token`).toBeNull();
    }
  });

  it('refuses an env-prefixed invocation and empty input', () => {
    expect(bashGrantToken('FOO=bar npm test')).toBeNull();
    expect(bashGrantToken('')).toBeNull();
    expect(bashGrantToken(undefined)).toBeNull();
  });
});

describe('the invariants §25.5 names still hold', () => {
  it('a forced-interactive request is never auto-approved by a grant', async () => {
    const p = pm.requestPermission('file-edit', 't', 'd', { riskLevel: 'low' } as PermissionDetails, post, undefined, 'p');
    const id = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
    pm.handleResponse({ requestId: id, decision: 'always-allow' });
    await p;

    let settled = false;
    const q = pm.requestPermission('file-edit', 't', 'd', { riskLevel: 'low' } as PermissionDetails,
      post, undefined, 'p', /* forceInteractive */ true).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled, 'forceInteractive was defeated by a grant').toBe(false);
    const pid = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
    pm.handleResponse({ requestId: pid, decision: 'deny' });
    await q;
  });

  it('a remote-origin request records no grant', async () => {
    const p = pm.requestPermission('file-edit', 't', 'd', { riskLevel: 'low' } as PermissionDetails,
      post, undefined, 'p', false, /* remoteOrigin */ true);
    const id = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
    pm.handleResponse({ requestId: id, decision: 'always-allow' });
    await p;

    let settled = false;
    const q = pm.requestPermission('file-edit', 't', 'd', { riskLevel: 'low' } as PermissionDetails, post, undefined, 'p')
      .then(() => { settled = true; });
    await Promise.resolve();
    expect(settled, 'a remote-origin always-allow recorded a grant').toBe(false);
    const pid = [...(pm as unknown as { _pendingRequests: Map<string, unknown> })._pendingRequests.keys()][0];
    pm.handleResponse({ requestId: pid, decision: 'deny' });
    await q;
  });

  it('grants live only in memory — nothing is persisted', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'managers', 'PermissionManager.ts'), 'utf-8');
    // No settings write, no globalState: there must be no file a workspace could seed.
    expect(src).not.toMatch(/globalState|workspaceState|config\.update/);
  });
});
