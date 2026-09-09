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
 * Plan 01 Phase 4 — automatic model-list updates reach OPEN panels.
 *
 * The registry already refreshed each agent's model list in the background
 * after activation, but nothing forwarded the result to the webview: a panel
 * kept whatever list it was painted with at initialState, so a freshly
 * discovered model only appeared after a reload. These tests pin the wiring
 * that closes that gap — the registry's onDidUpdateModels event must land on
 * every open panel as a 'modelsUpdated' message — plus the webview-initiated
 * 'requestModels' path (agent switch / explicit refresh).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real PlanOptionManager constructs a ResponseClassifier, which spawns
// warm Claude CLI processes — never acceptable in a unit test run.
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
import { createModelRegistryStub, type ModelRegistryStub } from '../helpers/modelRegistryStub';
import type { WebviewMessage } from '../../src/types';

interface PanelLog {
  id: string;
  messages: Array<{ type: string; payload?: any }>;
}

interface Harness {
  provider: ChatViewProvider;
  modelRegistry: ModelRegistryStub;
  sidebar: PanelLog;
  tab: PanelLog;
  permissionManager: PermissionManager;
  dispose(): void;
}

const WIZARD_STATUS = { anyReady: false, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] };

/** The registry's merged view for claude-code once discovery has landed. */
const DISCOVERED = {
  models: [
    { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', source: 'curated' as const, contextWindow: 200000 },
    { id: 'claude-opus-4-6-20260401', name: 'Opus 4.6', source: 'discovered' as const, contextWindow: 250000 },
  ],
  defaultModel: 'claude-sonnet-4-5-20250929',
  fetchedAt: 1_700_000_000_000,
  discoveryStatus: 'cached' as const,
};

function createHarness(): Harness {
  const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;
  const extensionContext = {
    globalState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    workspaceState: { get: (_k: string, d?: unknown) => d, update: async () => undefined },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist',
    extensionUri,
    extension: { packageJSON: { version: '0.0.0' } },
  } as any;

  const permissionManager = new PermissionManager('ask-permission');
  const modelRegistry = createModelRegistryStub({ 'claude-code': DISCOVERED });

  const noop = {} as any;
  const provider = new ChatViewProvider({
    extensionUri,
    extensionContext,
    contextManager: { getContext: () => [], setAutoContext: () => undefined, clearPanelContext: () => undefined } as any,
    conversationManager: { getCurrentConversation: () => null } as any,
    providerManager: { setAgentContextManager: () => undefined, getProvider: () => undefined, getProviderInstance: () => undefined } as any,
    suggestionManager: noop,
    brainstormManager: noop,
    permissionManager,
    setupManager: {
      getWizardStatus: async () => ({ ...WIZARD_STATUS }),
      getWizardStatusCached: () => ({ ...WIZARD_STATUS, complete: false }),
      ensureProviderStatusFresh: async () => undefined,
      refreshWizardStatus: async () => ({ ...WIZARD_STATUS }),
      invalidateProviderStatus: () => undefined,
      onWizardStatusUpdated: () => ({ dispose: () => {} }),
    } as any,
    telemetryManager: noop,
    autonomousManager: noop,
    memoryManager: { learnFromPermissionDecision: vi.fn() } as any,
    compactionManager: noop,
    lifecycleManager: { onLifecycleEvent: () => undefined } as any,
    slashCommandManager: noop,
    activeModeManager: {
      onStatusChanged: () => undefined,
      onChannelChanged: () => undefined,
      onActivity: () => undefined,
      subscribeToChannelEvents: () => () => undefined,
      isConnected: () => false,
      isInstalled: () => false,
    } as any,
    engagementManager: { trackCustomPersonaCreated: () => undefined, trackCustomSkillCreated: () => undefined } as any,
    projectContextManager: noop,
    visualTestManager: noop,
    modelRegistry: modelRegistry as any,
    checkpointManager: undefined as any
  }   // modelRegistry
  );

  const makePanel = (id: string, isSidebar: boolean): PanelLog => {
    const messages: Array<{ type: string; payload?: any }> = [];
    (provider as any)._panelStates.set(id, {
      id,
      webview: {
        postMessage: (message: WebviewMessage) => {
          messages.push(message as any);
          return Promise.resolve(true);
        },
      },
      currentConversationId: null,
      isSidebar,
    });
    return { id, messages };
  };

  return {
    provider,
    modelRegistry,
    sidebar: makePanel('sidebar', true),
    tab: makePanel('tab-1', false),
    permissionManager,
    dispose() {
      (provider as any)._channelBridge?.dispose?.();
      permissionManager.dispose();
    },
  };
}

describe('automatic model-list updates reach open panels (Plan 01 Phase 4)', () => {
  let h: Harness;

  beforeEach(() => {
    clearMockConfig();
    h = createHarness();
  });

  afterEach(() => {
    h.dispose();
    clearMockConfig();
  });

  it('broadcasts modelsUpdated to EVERY open panel when discovery lands', () => {
    // What the background warm-up does when a probe returns a fresh list.
    h.modelRegistry.emit('claude-code');

    for (const panel of [h.sidebar, h.tab]) {
      const updates = panel.messages.filter(m => m.type === 'modelsUpdated');
      expect(updates).toHaveLength(1);
      expect(updates[0].payload).toEqual({
        provider: 'claude-code',
        models: DISCOVERED.models,
        defaultModel: DISCOVERED.defaultModel,
        discoveryStatus: 'cached',
        fetchedAt: DISCOVERED.fetchedAt,
      });
    }
  });

  it('carries the newly discovered model, not just the curated seed', () => {
    h.modelRegistry.emit('claude-code');
    const payload = h.sidebar.messages.find(m => m.type === 'modelsUpdated')!.payload;
    expect(payload.models.map((m: any) => m.id)).toContain('claude-opus-4-6-20260401');
    expect(payload.models.find((m: any) => m.id === 'claude-opus-4-6-20260401').source).toBe('discovered');
  });

  it('answers requestModels on the asking panel only, without probing', async () => {
    await (h.provider as any)._handleMessage({
      type: 'requestModels',
      panelId: 'tab-1',
      payload: { provider: 'claude-code' },
    });

    expect(h.tab.messages.filter(m => m.type === 'modelsUpdated')).toHaveLength(1);
    expect(h.sidebar.messages.filter(m => m.type === 'modelsUpdated')).toHaveLength(0);
    // No force => the panel is answered from the merged view; the registry's own
    // stale-while-revalidate decides whether a probe is warranted.
    expect(h.modelRegistry.refreshCalls).toEqual([]);
  });

  it('forces a refresh when the webview asks for one explicitly', async () => {
    await (h.provider as any)._handleMessage({
      type: 'requestModels',
      panelId: 'sidebar',
      payload: { provider: 'claude-code', force: true },
    });

    // Answered immediately AND a forced probe kicked off (its result arrives
    // later as another modelsUpdated via onDidUpdateModels).
    expect(h.sidebar.messages.filter(m => m.type === 'modelsUpdated')).toHaveLength(1);
    expect(h.modelRegistry.refreshCalls).toEqual([{ providerId: 'claude-code', force: true }]);
  });

  it('ignores a requestModels with no provider', async () => {
    await (h.provider as any)._handleMessage({
      type: 'requestModels',
      panelId: 'sidebar',
      payload: {},
    });

    expect(h.sidebar.messages.filter(m => m.type === 'modelsUpdated')).toHaveLength(0);
    expect(h.modelRegistry.refreshCalls).toEqual([]);
  });
});
