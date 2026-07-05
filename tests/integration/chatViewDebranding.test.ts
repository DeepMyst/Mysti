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
 * Plan 02 Phase 2 — extension-side de-branding tests:
 *
 * - C1: the write-side providerModelKeys map is gone; custom-model saves
 *   resolve their setting key through the Provider Manifest
 *   (getCustomModelSettingKey), keeping the Batch 1 qwen-code fix semantics.
 * - C2: ProviderManager.getAllProviderIds() derives ids from the registry,
 *   and ChatViewProvider's brainstorm-agent validation consumes it instead
 *   of a hard-coded 11-element array.
 * - C3: shutdownAgent lifecycle events post the panel's ACTUAL provider id.
 * - C7: legacy /compact maps to provider-neutral 'cmd:compact', which routes
 *   through CompactionManager (strategy from supportsNativeCompact) rather
 *   than a Claude-only CLI passthrough.
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
import { ProviderManager } from '../../src/managers/ProviderManager';
import { SlashCommandManager, type SlashCommandCallbacks } from '../../src/managers/SlashCommandManager';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { DEFAULT_PROVIDER } from '../../src/constants';
import { clearMockConfig, getMockConfigUpdates, Uri } from '../helpers/mockVscode';
import type { WebviewMessage, Settings } from '../../src/types';

const ALL_PROVIDER_IDS = [
  'claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot',
  'cursor', 'openclaw', 'opencode', 'ollama', 'localai', 'qwen-code',
];

// ---------------------------------------------------------------------------
// Test harness (modeled on chatViewWizardRouting.test.ts)
// ---------------------------------------------------------------------------

interface Harness {
  provider: ChatViewProvider;
  providerManager: {
    getAllProviderIds: ReturnType<typeof vi.fn>;
    getProvider: ReturnType<typeof vi.fn>;
    getModelContextWindow: ReturnType<typeof vi.fn>;
  };
  compactionManager: {
    getStrategy: ReturnType<typeof vi.fn>;
    getThreshold: ReturnType<typeof vi.fn>;
    getUsage: ReturnType<typeof vi.fn>;
    executeClientSummarization: ReturnType<typeof vi.fn>;
    updateUsageAfterCompaction: ReturnType<typeof vi.fn>;
  };
  conversationManager: { getConversation: ReturnType<typeof vi.fn> };
  lifecycleManager: { requestShutdown: ReturnType<typeof vi.fn> };
  slashCommandManager: SlashCommandManager;
  /** Messages posted to the sidebar panel's webview. */
  sidebarMessages: Array<{ type: string; payload?: any }>;
  sidebarPanelState: any;
  dispose(): void;
}

const WIZARD_STATUS = {
  anyReady: false,
  npmAvailable: true,
  nodeVersion: 'v20.0.0',
  providers: [],
};

function createMockExtensionContext(): any {
  return {
    globalState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    },
    workspaceState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    },
    subscriptions: [] as { dispose(): void }[],
    extensionPath: '/mock/extension-does-not-exist',
    extensionUri: Uri.file('/mock/extension-does-not-exist'),
    extension: { packageJSON: { version: '0.0.0' } },
  };
}

function createHarness(): Harness {
  const extensionContext = createMockExtensionContext();
  const permissionManager = new PermissionManager('ask-permission');

  const contextManager = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
  } as any;
  const conversationManager = {
    getCurrentConversation: () => null,
    getConversation: vi.fn(() => null),
  } as any;
  const providerManager = {
    setAgentContextManager: () => undefined,
    // Known ids resolve to a minimal config so per-panel provider overrides
    // survive _getPanelProvider's registry validation.
    getProvider: vi.fn((name: string) =>
      ALL_PROVIDER_IDS.includes(name)
        ? { name, models: [], defaultModel: 'mock-default-model' }
        : undefined
    ),
    getProviderInstance: () => undefined,
    getAllProviders: () => [],
    getAllProviderIds: vi.fn(() => [...ALL_PROVIDER_IDS]),
    getModelContextWindow: vi.fn(() => 200000),
    // Plan 01: _getPanelModel now resolves the active model through the
    // registry-aware getModels() (empty list here = no built-in models, so the
    // keep-validated/custom precedence is exercised) instead of reading
    // providerConfig.models directly.
    getModels: vi.fn(() => []),
  } as any;
  const compactionManager = {
    getStrategy: vi.fn(() => 'client-summarize'),
    getThreshold: vi.fn(() => 75),
    getUsage: vi.fn(() => ({
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    })),
    executeClientSummarization: vi.fn(async () => ({
      success: true, beforeTokens: 1000, afterTokens: 200, duration: 5,
    })),
    updateUsageAfterCompaction: vi.fn(),
    resetUsage: vi.fn(),
    isSmartActive: vi.fn(() => false),
    evaluateCompaction: vi.fn(() => ({ act: false, smart: false })),
    appendHistory: vi.fn(),
  } as any;
  const setupManager = {
    getWizardStatus: async () => ({ ...WIZARD_STATUS }),
    getWizardStatusCached: () => ({ ...WIZARD_STATUS, complete: false }),
    ensureProviderStatusFresh: async () => undefined,
    refreshWizardStatus: async () => ({ ...WIZARD_STATUS }),
    invalidateProviderStatus: () => undefined,
    onWizardStatusUpdated: () => ({ dispose: () => {} }),
  } as any;
  const lifecycleManager = {
    onLifecycleEvent: () => undefined,
    requestShutdown: vi.fn(async () => ({
      blocked: true, reason: 'child processes running', childPids: [123],
    })),
  } as any;
  const activeModeManager = {
    onStatusChanged: () => undefined,
    onChannelChanged: () => undefined,
    onActivity: () => undefined,
    subscribeToChannelEvents: () => () => undefined,
    isConnected: () => false,
    isInstalled: () => false,
  } as any;
  const engagementManager = {
    trackCustomPersonaCreated: () => undefined,
    trackCustomSkillCreated: () => undefined,
  } as any;
  const noop = {} as any;

  // Real SlashCommandManager so /compact mapping + execution are exercised
  const slashCommandManager = new SlashCommandManager({
    providerManager,
    contextManager,
    conversationManager,
    compactionManager,
    memoryManager: noop,
    brainstormManager: noop,
  });

  const provider = new ChatViewProvider(
    extensionContext.extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    noop,                  // suggestionManager
    noop,                  // brainstormManager
    permissionManager,
    setupManager,
    noop,                  // telemetryManager
    noop,                  // autonomousManager
    { learnFromPermissionDecision: vi.fn() } as any,
    compactionManager,
    lifecycleManager,
    slashCommandManager,
    activeModeManager,
    engagementManager,
    noop,                  // projectContextManager
    noop,                  // visualTestManager
    noop,                  // canvasManager
    noop                   // modelRegistry (Plan 01) — threaded; not used by these tests
  );

  // Register a fake sidebar panel (normally done in resolveWebviewView)
  const sidebarMessages: Array<{ type: string; payload?: any }> = [];
  const sidebarPanelState = {
    id: 'sidebar',
    webview: {
      postMessage: (message: WebviewMessage) => {
        sidebarMessages.push(message as any);
        return Promise.resolve(true);
      },
    },
    currentConversationId: null,
    isSidebar: true,
  };
  (provider as any)._panelStates.set('sidebar', sidebarPanelState);

  return {
    provider,
    providerManager,
    compactionManager,
    conversationManager,
    lifecycleManager,
    slashCommandManager,
    sidebarMessages,
    sidebarPanelState,
    dispose() {
      (provider as any)._channelBridge?.dispose?.();
      permissionManager.dispose();
    },
  };
}

describe('ChatViewProvider de-branding (Plan 02 Phase 2)', () => {
  let h: Harness;

  beforeEach(() => {
    clearMockConfig();
    h = createHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  // =========================================================================
  // C1 — custom-model saves resolve the setting key via the Provider Manifest
  // =========================================================================
  describe('custom model persistence via manifest (C1)', () => {
    it('saves a custom qwen-code model to mysti.qwenCodeModel', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { provider: 'qwen-code', customModel: 'qwen3-coder-plus' } as Partial<Settings>,
        'sidebar'
      );

      // Pre-Phase-1: 'qwen-code' was missing from the deleted write-side map,
      // so no config.update was ever issued for qwenCodeModel.
      expect(getMockConfigUpdates()['qwenCodeModel']).toBe('qwen3-coder-plus');
    });

    it('saves a custom cursor model to mysti.cursorModel', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { provider: 'cursor', customModel: 'cursor-fast-1' } as Partial<Settings>,
        'sidebar'
      );

      expect(getMockConfigUpdates()['cursorModel']).toBe('cursor-fast-1');
    });

    it('clears the custom model when an empty string is sent', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { provider: 'qwen-code', customModel: '' } as Partial<Settings>,
        'sidebar'
      );

      expect(getMockConfigUpdates()['qwenCodeModel']).toBe('');
    });

    it('is a no-op for a provider unknown to the manifest', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { provider: 'not-a-provider', customModel: 'whatever' } as any,
        'sidebar'
      );

      // No *Model key may be written for an unknown provider
      const writtenKeys = Object.keys(getMockConfigUpdates());
      expect(writtenKeys.filter(k => k.endsWith('Model'))).toEqual([]);
    });
  });

  // =========================================================================
  // C2 — registry-derived ids replace the hard-coded allAgentIds arrays
  // =========================================================================
  describe('registry-derived provider ids (C2)', () => {
    it('brainstorm agent validation consumes getAllProviderIds()', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { 'brainstorm.agents': ['qwen-code', 'openclaw'] } as any,
        'sidebar'
      );

      expect(h.providerManager.getAllProviderIds).toHaveBeenCalled();
      expect(getMockConfigUpdates()['brainstorm.agents']).toEqual(['qwen-code', 'openclaw']);
    });

    it('rejects brainstorm agents outside the registry', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { 'brainstorm.agents': ['qwen-code', 'manus'] } as any,
        'sidebar'
      );

      // 'manus' is unregistered → filtered list has 1 entry → no update
      expect(getMockConfigUpdates()['brainstorm.agents']).toBeUndefined();
    });
  });

  // =========================================================================
  // C3 — shutdownAgent posts the panel's actual provider id
  // =========================================================================
  describe('shutdownAgent provider attribution (C3)', () => {
    it('posts the default provider when no per-panel override exists', async () => {
      await (h.provider as any)._handleMessage({ type: 'shutdownAgent', panelId: 'sidebar' });

      const evt = h.sidebarMessages.find(m => m.type === 'lifecycleEvent');
      expect(evt).toBeDefined();
      expect(evt!.payload.providerId).toBe(DEFAULT_PROVIDER);
    });

    it('posts the per-panel provider override, not a hard-coded id', async () => {
      h.sidebarPanelState.settingsOverrides = { provider: 'openai-codex' };

      await (h.provider as any)._handleMessage({ type: 'shutdownAgent', panelId: 'sidebar' });

      const evt = h.sidebarMessages.find(m => m.type === 'lifecycleEvent');
      expect(evt).toBeDefined();
      expect(evt!.payload.providerId).toBe('openai-codex');
    });
  });

  // =========================================================================
  // C7 — /compact routes through CompactionManager, provider-neutrally
  // =========================================================================
  describe('provider-neutral /compact (C7)', () => {
    it('maps legacy /compact to cmd:compact (not claude:compact)', () => {
      expect(h.slashCommandManager.mapLegacyCommand('compact')).toBe('cmd:compact');
    });

    it('cmd:compact invokes the executeManualCompaction callback', async () => {
      const callbacks: SlashCommandCallbacks = {
        postToPanel: vi.fn(),
        updateSettings: vi.fn(async () => undefined),
        getPanelProvider: vi.fn(() => 'cursor'),
        getPanelModel: vi.fn(() => 'mock-model'),
        executeManualCompaction: vi.fn(async () => undefined),
      };

      const result = await h.slashCommandManager.executeCommand(
        'cmd:compact', '', 'sidebar', callbacks
      );

      expect(callbacks.executeManualCompaction).toHaveBeenCalledWith('sidebar');
      expect(result).toBe('Compacting conversation...');
    });

    it('typed /compact reaches CompactionManager.getStrategy for the panel provider', async () => {
      // No conversation on the panel → _handleManualCompact takes the
      // synchronous error path, which still consults CompactionManager for
      // the strategy — proving the route is CompactionManager, not a
      // Claude-only CLI passthrough.
      await (h.provider as any)._handleSlashCommand({ command: 'compact' }, 'sidebar');

      expect(h.compactionManager.getStrategy).toHaveBeenCalled();
      const status = h.sidebarMessages.find(m => m.type === 'compactionStatus');
      expect(status).toBeDefined();
      expect(status!.payload.strategy).toBe('client-summarize');
      expect(status!.payload.error).toBe('Not enough conversation history to compact');
    });

    it('executeManualCompaction runs client summarization for non-native providers', async () => {
      h.sidebarPanelState.currentConversationId = 'c1';
      h.conversationManager.getConversation.mockReturnValue({
        id: 'c1',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
        ],
      });

      const callbacks = (h.provider as any)._getSlashCommandCallbacks();
      await callbacks.executeManualCompaction('sidebar');

      expect(h.compactionManager.executeClientSummarization).toHaveBeenCalled();
      const complete = h.sidebarMessages.find(
        m => m.type === 'compactionStatus' && m.payload?.status === 'complete'
      );
      expect(complete).toBeDefined();
      expect(complete!.payload.strategy).toBe('client-summarize');
    });
  });
});

// ===========================================================================
// C2 — the accessor itself, against the real registry
// ===========================================================================
describe('ProviderManager.getAllProviderIds (C2 accessor)', () => {
  it('returns every registered provider id, derived from the registry', () => {
    const manager = new ProviderManager(createMockExtensionContext());
    const ids = manager.getAllProviderIds();

    expect(ids.length).toBe(ALL_PROVIDER_IDS.length);
    for (const id of ALL_PROVIDER_IDS) {
      expect(ids, `missing provider id ${id}`).toContain(id);
    }
  });
});
