import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

describe('PermissionManager', () => {
  let pm: PermissionManager;
  let webviewMessages: unknown[];
  const postToWebview = (msg: unknown) => { webviewMessages.push(msg); };

  beforeEach(() => {
    clearMockConfig();
    vi.useFakeTimers();
    webviewMessages = [];
    pm = new PermissionManager('ask-permission');
  });

  afterEach(() => {
    pm.dispose();
    vi.useRealTimers();
  });

  describe('session access level', () => {
    it('should start with the configured access level', () => {
      expect(pm.sessionAccessLevel).toBe('ask-permission');
    });

    it('should allow resetting session access level', () => {
      pm.resetSessionAccessLevel('full-access');
      expect(pm.sessionAccessLevel).toBe('full-access');
    });
  });

  describe('requestPermission — immediate returns', () => {
    it('should auto-approve file-read actions', async () => {
      const result = await pm.requestPermission('file-read', 'Read', 'desc', {}, postToWebview);
      expect(result).toBe(true);
      expect(webviewMessages).toHaveLength(0); // No UI shown
    });

    it('should auto-approve when session upgraded to full-access', async () => {
      pm.resetSessionAccessLevel('full-access');
      const result = await pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);
      expect(result).toBe(true);
      expect(webviewMessages).toHaveLength(0);
    });
  });

  describe('requestPermission — blocking flow', () => {
    it('should post permissionRequest to webview and block', async () => {
      let resolved = false;
      const promise = pm.requestPermission('file-edit', 'Edit file', 'desc', {}, postToWebview)
        .then(val => { resolved = true; return val; });

      // Should have posted the permission request
      expect(webviewMessages).toHaveLength(1);
      const msg = webviewMessages[0] as { type: string; payload: { id: string; actionType: string; status: string } };
      expect(msg.type).toBe('permissionRequest');
      expect(msg.payload.actionType).toBe('file-edit');
      expect(msg.payload.status).toBe('pending');

      // Should NOT have resolved yet
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // Approve it
      pm.handleResponse({ requestId: msg.payload.id, decision: 'approve' });
      const result = await promise;
      expect(result).toBe(true);
    });

    it('should resolve false on deny', async () => {
      const promise = pm.requestPermission('bash-command', 'Run cmd', 'desc', {}, postToWebview);
      const msg = webviewMessages[0] as { type: string; payload: { id: string } };

      pm.handleResponse({ requestId: msg.payload.id, decision: 'deny' });
      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe('always-allow decision', () => {
    it('should upgrade session to full-access', async () => {
      const promise = pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);
      const msg = webviewMessages[0] as { type: string; payload: { id: string } };

      pm.handleResponse({ requestId: msg.payload.id, decision: 'always-allow' });
      const result = await promise;
      expect(result).toBe(true);
      expect(pm.sessionAccessLevel).toBe('full-access');
    });

    it('should auto-approve all subsequent requests after always-allow', async () => {
      // First request: always-allow
      const promise1 = pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);
      const msg = webviewMessages[0] as { type: string; payload: { id: string } };
      pm.handleResponse({ requestId: msg.payload.id, decision: 'always-allow' });
      await promise1;

      // Second request: auto-approved without UI
      webviewMessages.length = 0;
      const result = await pm.requestPermission('bash-command', 'Bash', 'desc', {}, postToWebview);
      expect(result).toBe(true);
      expect(webviewMessages).toHaveLength(0);
    });
  });

  describe('timeout behavior', () => {
    it('should auto-reject after timeout (default behavior)', async () => {
      setMockConfig('permission.timeout', 5);
      setMockConfig('permission.timeoutBehavior', 'auto-reject');
      pm = new PermissionManager('ask-permission');

      const promise = pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;
      expect(result).toBe(false);

      // Should have posted permissionExpired
      const expired = webviewMessages.find((m: any) => m.type === 'permissionExpired') as any;
      expect(expired).toBeTruthy();
      expect(expired.payload.approved).toBe(false);
    });

    it('should auto-accept after timeout when configured', async () => {
      setMockConfig('permission.timeout', 5);
      setMockConfig('permission.timeoutBehavior', 'auto-accept');
      pm = new PermissionManager('ask-permission');

      const promise = pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;
      expect(result).toBe(true);

      const expired = webviewMessages.find((m: any) => m.type === 'permissionExpired') as any;
      expect(expired.payload.approved).toBe(true);
    });

    it('should wait forever with require-action', async () => {
      setMockConfig('permission.timeout', 5);
      setMockConfig('permission.timeoutBehavior', 'require-action');
      pm = new PermissionManager('ask-permission');

      let resolved = false;
      pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview)
        .then(() => { resolved = true; });

      // Even after timeout period, should not resolve
      await vi.advanceTimersByTimeAsync(10000);
      expect(resolved).toBe(false);
    });

    it('should clear timeout when user responds before timeout', async () => {
      setMockConfig('permission.timeout', 30);
      setMockConfig('permission.timeoutBehavior', 'auto-reject');
      pm = new PermissionManager('ask-permission');

      const promise = pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);
      const msg = webviewMessages[0] as { type: string; payload: { id: string } };

      // Respond before timeout
      pm.handleResponse({ requestId: msg.payload.id, decision: 'approve' });
      const result = await promise;
      expect(result).toBe(true);

      // Advance past original timeout — should NOT post permissionExpired
      webviewMessages.length = 0;
      await vi.advanceTimersByTimeAsync(30000);
      expect(webviewMessages.find((m: any) => m.type === 'permissionExpired')).toBeUndefined();
    });
  });

  describe('handleResponse edge cases', () => {
    it('should no-op for unknown request IDs', () => {
      pm.handleResponse({ requestId: 'nonexistent', decision: 'approve' });
      // No error thrown
      expect(pm.getPendingCount()).toBe(0);
    });
  });

  describe('cancelRequest', () => {
    it('should resolve pending request as denied', async () => {
      const promise = pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);
      const msg = webviewMessages[0] as { type: string; payload: { id: string } };

      pm.cancelRequest(msg.payload.id);
      const result = await promise;
      expect(result).toBe(false);
      expect(pm.getPendingCount()).toBe(0);
    });
  });

  describe('cancelAllRequests', () => {
    it('should resolve all pending requests as denied', async () => {
      const p1 = pm.requestPermission('file-edit', 'Edit 1', 'desc', {}, postToWebview);
      const p2 = pm.requestPermission('bash-command', 'Bash 1', 'desc', {}, postToWebview);

      pm.cancelAllRequests();
      expect(await p1).toBe(false);
      expect(await p2).toBe(false);
      expect(pm.getPendingCount()).toBe(0);
    });
  });

  describe('risk classification', () => {
    it.each([
      ['file-read', 'low'],
      ['file-create', 'medium'],
      ['file-edit', 'medium'],
      ['web-request', 'medium'],
      ['file-delete', 'high'],
      ['bash-command', 'high'],
      ['multi-file-edit', 'high'],
    ] as const)('should classify %s as %s risk', (actionType, expected) => {
      expect(PermissionManager.classifyRisk(actionType)).toBe(expected);
    });
  });

  describe('dispose', () => {
    it('should reject all pending promises and clear state', async () => {
      const promise = pm.requestPermission('file-edit', 'Edit', 'desc', {}, postToWebview);
      pm.dispose();
      const result = await promise;
      expect(result).toBe(false);
      expect(pm.getPendingCount()).toBe(0);
    });
  });
});
