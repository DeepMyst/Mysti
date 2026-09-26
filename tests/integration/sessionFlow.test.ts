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
 * Plan 29 — the chain from the picker's Run to the one message that lands.
 *
 * SessionManager is unit-tested on its own; this covers the seam either side of
 * it: what `startSession` accepts from the webview, and what the panel is left
 * holding afterwards. Both ends are where a multi-agent feature goes quietly
 * wrong — an unvalidated agent id substituting a default backend at one end, an
 * unattributed message at the other.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() {
      return { hasPlanOptions: false, options: [], clarifyingQuestions: [] };
    }
  },
}));

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, Uri } from '../helpers/mockVscode';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';
import type { WebviewMessage } from '../../src/types';

const PROVIDER_IDS = ['claude-code', 'openai-codex', 'google-gemini'];

interface Harness {
  provider: any;
  messages: Array<{ type: string; payload?: any }>;
  added: Array<{ role: string; content: string; attribution?: any }>;
  sends: Array<{ providerId: string; content: string }>;
  dispose(): void;
}

function createHarness(): Harness {
  const extensionContext: any = {
    globalState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist',
    extensionUri: Uri.file('/mock/extension-does-not-exist'),
    extension: { packageJSON: { version: '0.0.0' } },
  };
  const permissionManager = new PermissionManager('ask-permission');
  const noop = {} as any;

  const sends: Array<{ providerId: string; content: string }> = [];
  const configs = PROVIDER_IDS.map(name => ({ name, models: [], defaultModel: `${name}-default` }));

  const providerManager: any = {
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
    getProviders: vi.fn(() => configs),
    getProvider: vi.fn((n: string) => configs.find(c => c.name === n)),
    getProviderInstance: () => undefined,
    getAllProviders: () => [],
    getAllProviderIds: vi.fn(() => [...PROVIDER_IDS]),
    getModels: vi.fn(() => []),
    getModelContextWindow: vi.fn(() => 200000),
    getProviderDefaultModel: (n: string) => `${n}-default`,
    getProviderStatus: async () => ({ found: true, authenticated: true, path: '/x' }),
    cancelRequest: vi.fn(),
    suspendRequest: () => false,
    resumeRequest: () => false,
    disposePersistentProcessForProvider: vi.fn(),
    async *sendMessageToProvider(providerId: string, content: string) {
      sends.push({ providerId, content });
      yield { type: 'text', content: `[{"title":"Finding from ${providerId}","severity":"high","location":"a.ts:1"}]` };
      yield { type: 'done' };
    },
  };

  const added: Array<{ role: string; content: string; attribution?: any }> = [];
  const conversationManager: any = {
    getCurrentConversation: () => null,
    getConversation: vi.fn(() => null),
    addMessageToConversation: vi.fn((_id: any, role: string, content: string, _c: any, _a: any, _t: any, attribution: any) => {
      added.push({ role, content, attribution });
      return { id: `m${added.length}`, role, content, ...(attribution || {}) };
    }),
  };

  const provider: any = new ChatViewProvider({
    extensionUri: extensionContext.extensionUri,
    extensionContext,
    contextManager: { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined } as any,
    conversationManager,
    providerManager,
    suggestionManager: noop,
    brainstormManager: noop,
    permissionManager,
    setupManager: {
      getWizardStatus: async () => ({ anyReady: false, providers: [] }),
      getWizardStatusCached: () => ({ anyReady: false, providers: [], complete: false }),
      ensureProviderStatusFresh: async () => undefined,
      onWizardStatusUpdated: () => ({ dispose: () => {} }),
    } as any,
    telemetryManager: noop,
    autonomousManager: noop,
    memoryManager: { learnFromPermissionDecision: vi.fn() } as any,
    compactionManager: { getStrategy: () => 'client-summarize', resetUsage: vi.fn(), appendHistory: vi.fn() } as any,
    lifecycleManager: { onLifecycleEvent: () => undefined, touchSession: vi.fn(), markBusy: vi.fn(), markIdle: vi.fn() } as any,
    slashCommandManager: { getMenu: () => [] } as any,
    activeModeManager: {
      onStatusChanged: () => undefined, onChannelChanged: () => undefined, onActivity: () => undefined,
      subscribeToChannelEvents: () => () => undefined, isConnected: () => false, isInstalled: () => false,
    } as any,
    engagementManager: { trackMessageSent: () => [] } as any,
    projectContextManager: noop,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub() as any,
    checkpointManager: undefined as any
  });

  const messages: Array<{ type: string; payload?: any }> = [];
  provider._panelStates.set('sidebar', {
    id: 'sidebar',
    webview: { postMessage: (m: WebviewMessage) => { messages.push(m as any); return Promise.resolve(true); } },
    currentConversationId: 'conv-1',
    isSidebar: true,
  });

  return {
    provider, messages, added, sends,
    dispose() {
      provider._channelBridge?.dispose?.();
      permissionManager.dispose();
    },
  };
}

async function start(h: Harness, payload: Record<string, unknown>) {
  await h.provider._handleStartSession(
    { settings: { provider: 'claude-code', model: 'x', mode: 'default', accessLevel: 'full-access' }, ...payload },
    'sidebar',
  );
}

describe('a session, end to end', () => {
  let h: Harness;

  beforeEach(() => { clearMockConfig(); h = createHarness(); });
  afterEach(() => { h.dispose(); clearMockConfig(); vi.restoreAllMocks(); });

  it('runs the picked agents and leaves exactly one assistant message', async () => {
    await start(h, { shape: 'review', agentIds: ['claude-code', 'openai-codex'], brief: 'read the diff' });

    expect(h.sends.map(s => s.providerId).sort()).toEqual(['claude-code', 'openai-codex']);
    const assistant = h.added.filter(m => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toContain('Review');
  });

  it('attributes the message to the SESSION, not to the panel', async () => {
    await start(h, { shape: 'review', agentIds: ['claude-code', 'openai-codex'], brief: 'x' });
    const assistant = h.added.find(m => m.role === 'assistant')!;
    // `provider` is the shape and `model` the agents that ran, so the header
    // says "Review · Claude Code, Codex" rather than borrowing the panel's agent.
    expect(assistant.attribution.provider).toBe('review');
    expect(assistant.attribution.model).toContain('Claude');
    expect(assistant.attribution.model).toContain('Codex');
  });

  it('announces who is answering before the lanes start', async () => {
    await start(h, { shape: 'review', agentIds: ['claude-code', 'openai-codex'], brief: 'x' });
    const started = h.messages.find(m => m.type === 'responseStarted')!;
    expect(started.payload.provider).toBe('review');
    expect(started.payload.model).toContain('Claude');
  });

  it('an agent id nothing registers is refused, never substituted', async () => {
    // The ids come from the webview. An unknown one must not fall through to
    // the default provider — the failure mode that makes a card name one agent
    // while another answers.
    await start(h, { shape: 'review', agentIds: ['claude-code', 'not-a-provider'], brief: 'x' });

    expect(h.sends).toHaveLength(0);
    const err = h.messages.find(m => m.type === 'sessionError');
    expect(err).toBeDefined();
    expect(err!.payload.message).toContain('at least 2');
    expect(h.added.filter(m => m.role === 'assistant')).toHaveLength(0);
  });

  it('refuses a shape that does not exist rather than guessing', async () => {
    await start(h, { shape: 'consensus', agentIds: PROVIDER_IDS, brief: 'x' });
    expect(h.sends).toHaveLength(0);
    expect(h.messages.find(m => m.type === 'sessionError')).toBeDefined();
  });

  it('refuses below the shape floor even when the picker sent it', async () => {
    await start(h, { shape: 'panel', agentIds: ['claude-code', 'openai-codex'], brief: 'x' });
    expect(h.sends).toHaveLength(0);
    const err = h.messages.find(m => m.type === 'sessionError')!;
    expect(err.payload.message).toContain('at least 3');
  });

  it('streams lane events the webview can render', async () => {
    await start(h, { shape: 'review', agentIds: ['claude-code', 'openai-codex'], brief: 'x' });
    const events = h.messages.filter(m => m.type === 'sessionEvent').map(m => m.payload.type);
    expect(events).toContain('session_started');
    expect(events).toContain('lane_update');
    expect(events).toContain('session_findings');
    expect(events).toContain('session_complete');
    // Every event carries the run id, which is what per-lane Stop targets.
    for (const m of h.messages.filter(x => x.type === 'sessionEvent')) {
      expect(typeof m.payload.runId).toBe('string');
    }
  });

  it('ends the turn even when every lane fails', async () => {
    (h.provider._providerManager as any).getProviderStatus = async () => ({
      found: false, authenticated: false, path: '',
    });
    await start(h, { shape: 'review', agentIds: ['claude-code', 'openai-codex'], brief: 'x' });
    expect(h.messages.some(m => m.type === 'responseComplete')).toBe(true);
    expect(h.added.filter(m => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('the picker and the dispatcher agree on the catalog', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const js = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');

  it('the webview reads the minimum from the shipped catalog, never a copy', () => {
    // A second hard-coded floor in the webview is how the picker starts
    // offering a run the dispatcher then refuses.
    expect(js).toContain('shape.minAgents');
    // No literal floor and no literal rate table anywhere in the webview —
    // both would be a second copy of the catalog, free to drift.
    expect(js).not.toMatch(/minAgents\s*[:=]\s*\d/);
    expect(js).not.toMatch(/costRate\s*:\s*[\d.]/);
  });

  it('the picker prices the run before Run goes live', () => {
    expect(js).toContain('shape.costRate');
    expect(js).toContain('you pay for every agent, kept or not');
  });

  it('Run stays dead below the floor', () => {
    expect(js).toContain('if (agentIds.length < picker.shape.minAgents) return;');
  });
});
