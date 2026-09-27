/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan 32 H2: a permission card names the agent that raised it, so the agent
 * map can attach the need to that agent. The origin is descriptive only and
 * is posted as-is on the card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type { CollaboratorSpec, PermissionOrigin, PermissionRequest, Settings, ToolCall, WebviewMessage } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

interface OriginHost {
  requestPermissionInline: ChatViewProvider['requestPermissionInline'];
  _requestCollaboratorPermission(spec: CollaboratorSpec, toolCall: ToolCall, panelId: string, ownerKey: string, nativeRequest?: unknown, parentToolId?: string): Promise<boolean>;
  _gateSubAgentToolUse(chunk: { agentId?: string; toolCall?: ToolCall }, settings: Settings, panelId: string): Promise<boolean>;
}

function harness() {
  const permissions = new PermissionManager('ask-permission');
  const posted: WebviewMessage[] = [];
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _permissionManager: permissions,
    _panelStates: new Map([['a', { id: 'a' }]]),
    _autonomousManager: { isActive: () => false },
    _backgroundJobManager: { get: () => undefined },
    _providerManager: { getProviderInstance: () => undefined, suspendRequest: () => false, resumeRequest: () => false, cancelRequest: vi.fn() },
    _postToPanel: (_panelId: string, message: WebviewMessage) => { posted.push(message); return true; },
  }) as OriginHost;
  const card = () => (posted.find(m => m.type === 'permissionRequest')?.payload as PermissionRequest | undefined);
  const settle = () => { for (const r of permissions.getPendingRequests()) { permissions.handleResponse({ requestId: r.id, decision: 'deny' }); } };
  return { host, permissions, card, settle };
}

describe('permission origin', () => {
  afterEach(() => clearMockConfig());

  it('PermissionManager posts the origin exactly as given, and omits it when absent', async () => {
    setMockConfig('permission.timeoutBehavior', 'require-action');
    const pm = new PermissionManager('ask-permission');
    const posted: PermissionRequest[] = [];
    const post = (m: unknown) => posted.push((m as { payload: PermissionRequest }).payload);
    const origin: PermissionOrigin = { kind: 'paid', label: 'Advisor' };
    const a = pm.requestPermission('file-edit', 'Edit', 'd', {}, post, 't1', 'a', false, false, origin);
    const b = pm.requestPermission('file-edit', 'Edit', 'd', {}, post, 't2', 'a');
    expect(posted[0].origin).toEqual(origin);
    expect('origin' in posted[1]).toBe(false);
    for (const r of pm.getPendingRequests()) { pm.handleResponse({ requestId: r.id, decision: 'deny' }); }
    await Promise.all([a, b]);
    pm.dispose();
  });

  it('a collaborator card carries its member identity and the delegate card it came from', async () => {
    setMockConfig('permission.timeoutBehavior', 'require-action');
    const h = harness();
    const spec: CollaboratorSpec = { collaboratorId: 'deleg-a-codex', agentId: 'openai-codex', role: 'critic', label: 'Codex', prompt: 'p', access: 'gated-write' };
    const gate = h.host._requestCollaboratorPermission(spec, { id: 'tc', name: 'Write', input: { path: 'x' } }, 'a', 'a', undefined, 'mysti-deleg-r-0');
    expect(h.card()?.origin).toEqual({
      kind: 'collaborator', agentId: 'openai-codex', collaboratorId: 'deleg-a-codex', role: 'critic', label: 'Codex', parentToolId: 'mysti-deleg-r-0',
    });
    h.settle();
    expect(await gate).toBe(false);
    h.permissions.dispose();
  });

  it('a mention sub-agent card names its backend', async () => {
    const h = harness();
    const spy = vi.spyOn(h.host, 'requestPermissionInline').mockResolvedValue(true);
    const settings = { accessLevel: 'ask-permission', mode: 'ask-before-edit' } as Settings;
    await h.host._gateSubAgentToolUse({ agentId: 'google-gemini', toolCall: { id: 'tc', name: 'Write', input: { path: 'x' } } }, settings, 'a');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0].at(-1)).toEqual({ kind: 'mention', agentId: 'google-gemini' });
    h.permissions.dispose();
  });
});
