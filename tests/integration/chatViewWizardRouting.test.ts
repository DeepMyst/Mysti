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
 * Integration tests for ChatViewProvider message routing fixes:
 *
 * - B2: the setup wizard used to run with panelId=null, so every wizard
 *   response was posted to a non-existent panel and silently dropped.
 *   Fixed by (a) including the real panelId in the `showWizard` payload and
 *   (b) defaulting `msg.panelId ?? 'sidebar'` at the top of `_handleMessage`.
 *
 * - B15: `_handlePermissionResponse` used to call
 *   `PermissionManager.handleResponse()` (which deletes the pending request)
 *   BEFORE `getPendingRequest()`, so `learnFromPermissionDecision` never ran.
 *   Fixed by reading the request first.
 *
 * - #39 stopgap: the write-side providerModelKeys map omitted 'qwen-code',
 *   so qwen custom models could never be saved from the UI.
 *
 * These tests instantiate the real ChatViewProvider with minimal stub
 * collaborators and drive its private handlers directly.
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
import { clearMockConfig, getMockConfigUpdates, Uri } from '../helpers/mockVscode';
import type { WebviewMessage, Settings } from '../../src/types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  provider: ChatViewProvider;
  permissionManager: PermissionManager;
  memoryManager: { learnFromPermissionDecision: ReturnType<typeof vi.fn> };
  /** Messages posted to the sidebar panel's webview. */
  sidebarMessages: Array<{ type: string; payload?: any }>;
  dispose(): void;
}

const WIZARD_STATUS = {
  anyReady: false,
  npmAvailable: true,
  nodeVersion: 'v20.0.0',
  providers: [],
};

function createHarness(): Harness {
  const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;

  const extensionContext = {
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
    extensionUri,
    extension: { packageJSON: { version: '0.0.0' } },
  } as any;

  const permissionManager = new PermissionManager('ask-permission');
  const memoryManager = { learnFromPermissionDecision: vi.fn() };

  const contextManager = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
  } as any;
  const conversationManager = {
    getCurrentConversation: () => null,
  } as any;
  const providerManager = {
    setAgentContextManager: () => undefined,
    getProvider: () => undefined,
    getProviderInstance: () => undefined,
  } as any;
  const setupManager = {
    getWizardStatus: async () => ({ ...WIZARD_STATUS }),
    // Plan 03 Phase 3a surface: cached reads + background-refresh event
    getWizardStatusCached: () => ({ ...WIZARD_STATUS, complete: false }),
    ensureProviderStatusFresh: async () => undefined,
    refreshWizardStatus: async () => ({ ...WIZARD_STATUS }),
    invalidateProviderStatus: () => undefined,
    onWizardStatusUpdated: () => ({ dispose: () => {} }),
  } as any;
  const lifecycleManager = {
    onLifecycleEvent: () => undefined,
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

  const provider = new ChatViewProvider(
    extensionUri,
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
    memoryManager as any,  // memoryManager
    noop,                  // compactionManager
    lifecycleManager,
    noop,                  // slashCommandManager
    activeModeManager,
    engagementManager,
    noop,                  // projectContextManager
    noop,                  // visualTestManager
    noop                   // canvasManager
  );

  // Register a fake sidebar panel (normally done in resolveWebviewView)
  const sidebarMessages: Array<{ type: string; payload?: any }> = [];
  (provider as any)._panelStates.set('sidebar', {
    id: 'sidebar',
    webview: {
      postMessage: (message: WebviewMessage) => {
        sidebarMessages.push(message as any);
        return Promise.resolve(true);
      },
    },
    currentConversationId: null,
    isSidebar: true,
  });

  return {
    provider,
    permissionManager,
    memoryManager,
    sidebarMessages,
    dispose() {
      (provider as any)._channelBridge?.dispose?.();
      permissionManager.dispose();
    },
  };
}

describe('ChatViewProvider message routing', () => {
  let h: Harness;

  beforeEach(() => {
    clearMockConfig();
    h = createHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  // =========================================================================
  // B2 — Setup wizard panelId round trip
  // =========================================================================
  describe('setup wizard panelId (B2)', () => {
    it('should include the real panelId in the showWizard payload', async () => {
      await (h.provider as any)._sendInitialState('sidebar');

      const showWizard = h.sidebarMessages.find(m => m.type === 'showWizard');
      expect(showWizard).toBeDefined();
      expect(showWizard!.payload.panelId).toBe('sidebar');
      // Original wizard status fields must be preserved
      expect(showWizard!.payload.anyReady).toBe(false);
      expect(showWizard!.payload.npmAvailable).toBe(true);
    });

    it('should default a null panelId to the sidebar so wizard replies are not dropped', async () => {
      // Pre-fix scenario: the wizard webview never received initialState, so
      // it posts every message with panelId=null. The reply used to go to
      // _postToPanel(null) — a non-existent panel — and vanish.
      await (h.provider as any)._handleMessage({
        type: 'requestWizardStatus',
        panelId: null,
      });

      const reply = h.sidebarMessages.find(m => m.type === 'wizardStatus');
      expect(reply).toBeDefined();
      expect(reply!.payload.anyReady).toBe(false);
    });

    it('should default an undefined panelId to the sidebar as well', async () => {
      await (h.provider as any)._handleMessage({ type: 'requestWizardStatus' });

      expect(h.sidebarMessages.some(m => m.type === 'wizardStatus')).toBe(true);
    });

    it('should survive the full round trip: showWizard -> webview echoes panelId -> reply reaches the same panel', async () => {
      // Hop 1: extension shows the wizard, payload carries the panelId
      await (h.provider as any)._sendInitialState('sidebar');
      const showWizard = h.sidebarMessages.find(m => m.type === 'showWizard');
      const learnedPanelId = showWizard!.payload.panelId;
      expect(learnedPanelId).toBe('sidebar');

      // Hop 2: webview stores it (handleShowWizard) and stamps it on every
      // outgoing message (postMessageWithPanelId) — simulated here.
      h.sidebarMessages.length = 0;
      await (h.provider as any)._handleMessage({
        type: 'requestWizardStatus',
        panelId: learnedPanelId,
      });

      // Hop 3: the reply must arrive on the panel the wizard lives in
      const reply = h.sidebarMessages.find(m => m.type === 'wizardStatus');
      expect(reply).toBeDefined();
    });
  });

  // =========================================================================
  // B15 — Permission learning ordering
  // =========================================================================
  describe('permission-decision learning (B15)', () => {
    function startPendingRequest(): { requestId: string; gate: Promise<boolean> } {
      const posted: any[] = [];
      const gate = h.permissionManager.requestPermission(
        'file-edit',
        'Edit file',
        'Modify src/example.ts',
        { filePath: 'src/example.ts' },
        (msg: unknown) => { posted.push(msg); }
      );
      const requestId = posted[0].payload.id as string;
      return { requestId, gate };
    }

    it('should feed the user decision to MemoryManager (approve)', async () => {
      const { requestId, gate } = startPendingRequest();

      (h.provider as any)._handlePermissionResponse({ requestId, decision: 'approve' });

      expect(await gate).toBe(true);
      expect(h.memoryManager.learnFromPermissionDecision).toHaveBeenCalledTimes(1);
      const [request, response] = h.memoryManager.learnFromPermissionDecision.mock.calls[0];
      expect(request.id).toBe(requestId);
      expect(request.actionType).toBe('file-edit');
      expect(response.decision).toBe('approve');
    });

    it('should feed the user decision to MemoryManager (deny)', async () => {
      const { requestId, gate } = startPendingRequest();

      (h.provider as any)._handlePermissionResponse({ requestId, decision: 'deny' });

      expect(await gate).toBe(false);
      expect(h.memoryManager.learnFromPermissionDecision).toHaveBeenCalledTimes(1);
      const [request, response] = h.memoryManager.learnFromPermissionDecision.mock.calls[0];
      expect(request.id).toBe(requestId);
      expect(response.decision).toBe('deny');
    });

    it('regression guard: handleResponse deletes the pending request, so reading after it would learn nothing', () => {
      // This is the exact property that made the pre-fix order (handleResponse
      // first, getPendingRequest second) permanently dead.
      const { requestId } = startPendingRequest();

      expect(h.permissionManager.getPendingRequest(requestId)).toBeDefined();
      h.permissionManager.handleResponse({ requestId, decision: 'approve' });
      expect(h.permissionManager.getPendingRequest(requestId)).toBeUndefined();
    });

    it('should not learn anything for an unknown requestId', () => {
      (h.provider as any)._handlePermissionResponse({ requestId: 'nope', decision: 'approve' });
      expect(h.memoryManager.learnFromPermissionDecision).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // #39 stopgap — qwen-code in the write-side providerModelKeys map
  // =========================================================================
  describe('qwen-code custom model persistence (#39 stopgap)', () => {
    it('should save a custom qwen-code model to mysti.qwenCodeModel', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { provider: 'qwen-code', customModel: 'qwen3-coder-plus' } as Partial<Settings>,
        'sidebar'
      );

      // Pre-fix: 'qwen-code' was missing from the write-side map, so no
      // config.update was ever issued for qwenCodeModel.
      expect(getMockConfigUpdates()['qwenCodeModel']).toBe('qwen3-coder-plus');
    });

    it('should clear the custom qwen-code model when an empty string is sent', async () => {
      await (h.provider as any)._handleUpdateSettings(
        { provider: 'qwen-code', customModel: '' } as Partial<Settings>,
        'sidebar'
      );

      expect(getMockConfigUpdates()['qwenCodeModel']).toBe('');
    });
  });
});
