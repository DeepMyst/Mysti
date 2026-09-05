/**
 * Permission scoping tests (Plan 21 Phase 0, invariant I14).
 *
 * Two defects are pinned here:
 *
 * 1. "Always allow" set ONE process-wide field to full-access, permanently.
 *    Every later request — in every panel, in every conversation, for the life
 *    of the window — was auto-approved. An upgrade granted for one task must
 *    not authorise an unrelated one.
 *
 * 2. There was no way to mark a run as carrying bytes authored off this
 *    machine, so a remote-origin task inherited whatever consent the user had
 *    given earlier for their own local work.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

type Posted = { type: string; payload: { id: string } };

function harness() {
  const posted: Posted[] = [];
  const post = (m: unknown) => { posted.push(m as Posted); };
  return { posted, post };
}

/** Approve whatever card was just raised. */
function approve(pm: PermissionManager, posted: Posted[], decision: 'approve' | 'always-allow' = 'approve') {
  const last = posted[posted.length - 1];
  pm.handleResponse({ requestId: last.payload.id, decision });
}

describe('session upgrade is scoped to its owner', () => {
  let pm: PermissionManager;
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    clearMockConfig();
    pm = new PermissionManager('ask-permission');
    h = harness();
  });

  it('an always-allow in one panel does NOT auto-approve another panel', async () => {
    const p1 = pm.requestPermission('file-edit', 'Edit', 'd', {}, h.post, undefined, 'panel-1');
    approve(pm, h.posted, 'always-allow');
    expect(await p1).toBe(true);

    // Panel 2 must still raise a card.
    h.posted.length = 0;
    const p2 = pm.requestPermission('bash-command', 'Bash', 'd', {}, h.post, undefined, 'panel-2');
    expect(h.posted).toHaveLength(1);
    approve(pm, h.posted);
    expect(await p2).toBe(true);
  });

  it('an always-allow DOES auto-approve the SAME action type in the same panel', async () => {
    // Plan 27 §25: the grant is per action type. This used to request a
    // `bash-command` here and expect it approved — approving one file edit
    // authorised the shell. That escalation is the bug the change removed;
    // `permissionGrantScoping.test.ts` now asserts it cannot happen.
    const p1 = pm.requestPermission('file-edit', 'Edit', 'd', {}, h.post, undefined, 'panel-1');
    approve(pm, h.posted, 'always-allow');
    await p1;

    h.posted.length = 0;
    const result = await pm.requestPermission('file-edit', 'Edit again', 'd', {}, h.post, undefined, 'panel-1');
    expect(result).toBe(true);
    expect(h.posted).toHaveLength(0);
  });

  it('clearSessionUpgrade(panel) drops that panel’s upgrade only', async () => {
    const a = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1');
    approve(pm, h.posted, 'always-allow');
    await a;
    const b = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-2');
    approve(pm, h.posted, 'always-allow');
    await b;

    pm.clearSessionUpgrade('panel-1');

    h.posted.length = 0;
    const p1 = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1');
    expect(h.posted).toHaveLength(1); // card raised again
    approve(pm, h.posted);
    await p1;

    h.posted.length = 0;
    const r2 = await pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-2');
    expect(r2).toBe(true);
    expect(h.posted).toHaveLength(0); // panel-2's grant survives
  });

  it('resetSessionAccessLevel drops every outstanding upgrade', async () => {
    const p = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1');
    approve(pm, h.posted, 'always-allow');
    await p;

    pm.resetSessionAccessLevel('ask-permission');

    h.posted.length = 0;
    const p2 = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1');
    expect(h.posted).toHaveLength(1);
    approve(pm, h.posted);
    await p2;
  });
});

describe('session upgrade expires', () => {
  beforeEach(() => clearMockConfig());
  afterEach(() => vi.useRealTimers());

  it('stops auto-approving once the TTL has passed', async () => {
    const pm = new PermissionManager('ask-permission');
    const h = harness();

    const p = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1');
    approve(pm, h.posted, 'always-allow');
    await p;

    // Still inside the window. Same action type as the grant — Plan 27 §25
    // scoped grants per type, so probing with `bash-command` here would now be
    // testing the escalation rather than the TTL.
    h.posted.length = 0;
    expect(await pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1')).toBe(true);
    expect(h.posted).toHaveLength(0);

    // Jump past the 1h TTL.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61 * 60 * 1000;
      h.posted.length = 0;
      const later = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1');
      expect(h.posted).toHaveLength(1); // card raised again
      approve(pm, h.posted);
      expect(await later).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('remoteOrigin can never be auto-approved', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    clearMockConfig();
    h = harness();
  });

  it('raises a card even under a session full-access upgrade', async () => {
    const pm = new PermissionManager('ask-permission');
    const p = pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1');
    approve(pm, h.posted, 'always-allow');
    await p;

    // A local request of the GRANTED type is now silent…
    h.posted.length = 0;
    expect(await pm.requestPermission('file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1')).toBe(true);
    expect(h.posted).toHaveLength(0);

    // …but a remote-origin one is not, even for that same type.
    h.posted.length = 0;
    const remote = pm.requestPermission(
      'file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1', false, /* remoteOrigin */ true,
    );
    expect(h.posted).toHaveLength(1);
    approve(pm, h.posted);
    expect(await remote).toBe(true);
  });

  it('raises a card even when the manager starts at full-access', async () => {
    const pm = new PermissionManager('full-access');
    const remote = pm.requestPermission(
      'file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1', false, true,
    );
    expect(h.posted).toHaveLength(1);
    approve(pm, h.posted);
    expect(await remote).toBe(true);
  });

  it('auto-DENIES on timeout even when the policy is auto-accept', async () => {
    setMockConfig('permission.timeout', 1);
    setMockConfig('permission.timeoutBehavior', 'auto-accept');
    const pm = new PermissionManager('ask-permission');

    vi.useFakeTimers();
    try {
      const remote = pm.requestPermission(
        'bash-command', 'B', 'd', {}, h.post, undefined, 'panel-1', false, true,
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(await remote).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an always-allow on a remote-origin card does not grant a lasting upgrade', async () => {
    const pm = new PermissionManager('ask-permission');
    const remote = pm.requestPermission(
      'file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1', false, true,
    );
    approve(pm, h.posted, 'always-allow');
    await remote;

    // The scope must NOT have been upgraded by that click.
    h.posted.length = 0;
    const next = pm.requestPermission('bash-command', 'B', 'd', {}, h.post, undefined, 'panel-1');
    expect(h.posted).toHaveLength(1);
    approve(pm, h.posted);
    await next;
  });

  it('marks the request so the card can label its provenance', async () => {
    const pm = new PermissionManager('ask-permission');
    const p = pm.requestPermission(
      'file-edit', 'E', 'd', {}, h.post, undefined, 'panel-1', false, true,
    );
    const req = pm.getPendingRequest(h.posted[0].payload.id);
    expect(req?.remoteOrigin).toBe(true);
    expect(req?.forceInteractive).toBe(true);
    approve(pm, h.posted);
    await p;
  });
});
