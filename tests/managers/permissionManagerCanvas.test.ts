/**
 * Plan 20 §3.6 — PermissionManager's half of the canvas permission class.
 *
 * `canvas-read` is never a privileged act, so it must short-circuit
 * `requestPermission` the way `file-read` does — but WITHOUT becoming a way
 * around the Plan 19 `forceInteractive` invariant. `canvas-edit` is a low-risk,
 * invertible write into `.mysti/canvas/<id>/`, so it must not inherit the
 * source-tree risk labels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type { PermissionActionType, PermissionDetails, PermissionRequest } from '../../src/types';

const details = (): PermissionDetails => ({ riskLevel: 'low' });

function capture() {
  const posted: Array<{ type: string; payload: PermissionRequest }> = [];
  return {
    posted,
    post: (msg: unknown) => { posted.push(msg as { type: string; payload: PermissionRequest }); },
  };
}

describe('PermissionManager — canvas action types', () => {
  beforeEach(() => {
    clearMockConfig();
    // No timeout: a raised card stays pending until the test answers it.
    setMockConfig('permission.timeout', 0);
    setMockConfig('permission.timeoutBehavior', 'require-action');
  });

  afterEach(() => {
    clearMockConfig();
    vi.useRealTimers();
  });

  it('auto-approves canvas-read without ever posting a card', async () => {
    const mgr = new PermissionManager('ask-permission');
    const { posted, post } = capture();

    await expect(mgr.requestPermission('canvas-read', 'Read the canvas', '', details(), post))
      .resolves.toBe(true);
    expect(posted).toHaveLength(0);
    expect(mgr.getPendingRequests()).toHaveLength(0);
  });

  it('auto-approves canvas-read even under the strictest access level', async () => {
    const mgr = new PermissionManager('read-only');
    const { post } = capture();
    await expect(mgr.requestPermission('canvas-read', 'Read the canvas', '', details(), post))
      .resolves.toBe(true);
  });

  it('does NOT let canvas-read bypass a forced interactive card', async () => {
    const mgr = new PermissionManager('ask-permission');
    const { posted, post } = capture();

    let settled = false;
    const pending = mgr.requestPermission(
      'canvas-read', 'Read the canvas', '', details(), post, undefined, undefined, true,
    );
    void pending.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(posted).toHaveLength(1);
    expect(posted[0].payload.forceInteractive).toBe(true);

    mgr.handleResponse({ requestId: posted[0].payload.id, decision: 'deny' });
    await expect(pending).resolves.toBe(false);
  });

  it('still raises a card for canvas-edit when one is requested', async () => {
    const mgr = new PermissionManager('ask-permission');
    const { posted, post } = capture();

    const pending = mgr.requestPermission('canvas-edit', 'Edit the canvas', '', details(), post);
    await Promise.resolve();

    expect(posted).toHaveLength(1);
    expect(posted[0].payload.actionType).toBe('canvas-edit');

    mgr.handleResponse({ requestId: posted[0].payload.id, decision: 'approve' });
    await expect(pending).resolves.toBe(true);
  });

  describe('classifyRisk', () => {
    it('rates both canvas classes low — scoped, invertible, no shell, no network', () => {
      expect(PermissionManager.classifyRisk('canvas-read')).toBe('low');
      expect(PermissionManager.classifyRisk('canvas-edit')).toBe('low');
    });

    it('leaves the source-tree risk ladder untouched', () => {
      const unchanged: Array<[PermissionActionType, string]> = [
        ['file-read', 'low'],
        ['file-edit', 'medium'],
        ['file-create', 'medium'],
        ['web-request', 'medium'],
        ['file-delete', 'high'],
        ['bash-command', 'high'],
        ['multi-file-edit', 'high'],
        ['delegate', 'high'],
      ];
      for (const [action, risk] of unchanged) {
        expect(PermissionManager.classifyRisk(action)).toBe(risk);
      }
    });
  });

  describe('getActionTitle', () => {
    it('names the canvas actions instead of falling back to "Perform action"', () => {
      expect(PermissionManager.getActionTitle('canvas-read')).toBe('Read the canvas');
      expect(PermissionManager.getActionTitle('canvas-edit')).toBe('Edit the canvas');
    });

    it('does not confuse a canvas edit with a file edit', () => {
      expect(PermissionManager.getActionTitle('canvas-edit'))
        .not.toBe(PermissionManager.getActionTitle('file-edit'));
    });
  });
});
