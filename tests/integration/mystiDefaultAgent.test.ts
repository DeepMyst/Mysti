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
 * Plan 25 — Mysti as the default agent, and recoverable credential failures.
 *
 * Two separate things used to be one string, `mysti.defaultProvider`:
 * the agent the user TALKS TO and the CLI backend that SPAWNS. Because 'mysti'
 * is a pseudo-agent with no registry entry, conflating them meant the coordinator
 * could not be selected durably at all — `_getPanelProvider` rejected it, and
 * `_sendInitialState` demoted it to the first installed CLI on every panel open.
 *
 * The invariant these tests defend: `_getPanelAgent()` MAY return a pseudo-agent;
 * `_getPanelProvider()` NEVER may — everything downstream of it spawns a process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
import {
  clearMockConfig,
  setMockConfig,
  setMockConfigInspect,
  getMockConfigUpdates,
  Uri,
} from '../helpers/mockVscode';
import type { WebviewMessage } from '../../src/types';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Registered (spawnable) providers this harness pretends to know. */
const REGISTERED = ['claude-code', 'openai-codex', 'cursor'];

interface HarnessOptions {
  /** Which registered providers report as installed in the wizard status. */
  installed?: string[];
  /** Whether the cached wizard status is authoritative (`complete`). */
  complete?: boolean;
  /** Coordinator readiness (signed in to DeepMyst, or an OpenRouter key set). */
  coordinatorReady?: boolean;
  credentials?: { hasDeepMystKey: boolean; usingOpenRouter: boolean };
}

interface Harness {
  provider: any;
  sidebarMessages: Array<{ type: string; payload?: any }>;
  dispose(): void;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const installed = options.installed ?? ['claude-code', 'openai-codex'];
  const complete = options.complete ?? true;
  const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;

  const wizardStatus = {
    anyReady: installed.length > 0,
    npmAvailable: true,
    nodeVersion: 'v20.0.0',
    providers: REGISTERED.map(id => ({
      providerId: id,
      displayName: id,
      installed: installed.includes(id),
      authenticated: installed.includes(id),
      installCommand: `npm i -g ${id}`,
      authCommand: `${id} login`,
      authInstructions: [],
    })),
  };

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

  const contextManager = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
    restorePanelContext: () => Promise.resolve([]),
  } as any;
  const conversationManager = {
    getCurrentConversation: () => null,
    getConversation: () => null,
  } as any;
  const providerManager = {
    setAgentContextManager: () => undefined,
    // Only REGISTERED ids resolve — this is what makes 'mysti' unspawnable.
    getProvider: (id: string) =>
      REGISTERED.includes(id) ? ({ name: id, displayName: id, defaultModel: 'm1' } as any) : undefined,
    getProviderInstance: () => undefined,
    getAllProviderIds: () => [...REGISTERED],
    getProviders: () => REGISTERED.map(id => ({ name: id, displayName: id, defaultModel: 'm1', models: [] })),
    getModels: () => [],
    getRegistry: () => ({ getAll: () => [] }),
  } as any;
  const setupManager = {
    getWizardStatus: async () => ({ ...wizardStatus }),
    getWizardStatusCached: () => ({ ...wizardStatus, complete }),
    ensureProviderStatusFresh: async () => undefined,
    refreshWizardStatus: async () => ({ ...wizardStatus }),
    invalidateProviderStatus: () => undefined,
    onWizardStatusUpdated: () => ({ dispose: () => {} }),
  } as any;
  const lifecycleManager = {
    onLifecycleEvent: () => undefined,
    markIdle: () => undefined,
    markBusy: () => undefined,
    touchSession: () => undefined,
  } as any;
  const activeModeManager = {
    onStatusChanged: () => undefined,
    onChannelChanged: () => undefined,
    onActivity: () => undefined,
    subscribeToChannelEvents: () => () => undefined,
    isConnected: () => false,
    isInstalled: () => false,
    getDaemonStatus: () => ({ running: false }),
  } as any;
  const engagementManager = {
    trackCustomPersonaCreated: () => undefined,
    trackCustomSkillCreated: () => undefined,
    getUsageStats: () => ({}),
    getAllBadges: () => [],
    getUnlockedCount: () => 0,
  } as any;
  const noop = {} as any;

  const provider: any = new ChatViewProvider(
    extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    noop,
    noop,
    permissionManager,
    setupManager,
    noop,
    noop,
    noop,
    noop,
    lifecycleManager,
    noop,
    activeModeManager,
    engagementManager,
    noop,
    noop,
    noop,
    createModelRegistryStub() as any,
  );

  // Checkpoint availability is probed on every panel open (fire-and-forget).
  provider._checkpointManager = { isAvailable: async () => false };

  // Coordinator stub — readiness + which credential a turn would use.
  provider._mystiCoordinator = {
    status: () => ({ ready: options.coordinatorReady ?? true }),
    credentialState: () =>
      options.credentials ?? { hasDeepMystKey: true, usingOpenRouter: false },
  };

  const sidebarMessages: Array<{ type: string; payload?: any }> = [];
  provider._panelStates.set('sidebar', {
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
    sidebarMessages,
    dispose() {
      provider._channelBridge?.dispose?.();
      permissionManager.dispose();
    },
  };
}

describe('Plan 25 — agent selection vs backend provider', () => {
  let h: Harness;

  beforeEach(() => {
    clearMockConfig();
    h = createHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  // =========================================================================
  // Resolution
  // =========================================================================
  describe('_getPanelAgent', () => {
    it('defaults to Mysti for a user who has configured nothing', () => {
      expect(h.provider._getPanelAgent('sidebar')).toBe('mysti');
    });

    it('respects an explicitly chosen legacy provider instead of hijacking it', () => {
      // Migration rule: someone who deliberately picked a CLI backend before
      // `defaultAgent` existed must not be silently moved onto Mysti.
      setMockConfigInspect('defaultProvider', { globalValue: 'cursor' });
      expect(h.provider._getPanelAgent('sidebar')).toBe('cursor');
    });

    it('does NOT treat the packaged default as an explicit choice', () => {
      // `defaultValue` alone means the user never touched the setting.
      setMockConfigInspect('defaultProvider', { defaultValue: 'claude-code' });
      expect(h.provider._getPanelAgent('sidebar')).toBe('mysti');
    });

    it('lets an explicit defaultAgent win over the legacy provider', () => {
      setMockConfigInspect('defaultProvider', { globalValue: 'cursor' });
      setMockConfigInspect('defaultAgent', { globalValue: 'mysti' });
      expect(h.provider._getPanelAgent('sidebar')).toBe('mysti');
    });

    it('prefers a per-panel override over every global setting', () => {
      setMockConfigInspect('defaultAgent', { globalValue: 'claude-code' });
      h.provider._panelStates.get('sidebar').settingsOverrides = { agent: 'mysti' };
      expect(h.provider._getPanelAgent('sidebar')).toBe('mysti');
    });

    it('ignores an unknown agent id rather than handing it downstream', () => {
      setMockConfigInspect('defaultAgent', { globalValue: 'not-a-real-agent' });
      expect(h.provider._getPanelAgent('sidebar')).toBe('mysti');
    });
  });

  describe('_getPanelProvider — never a pseudo-agent (the load-bearing invariant)', () => {
    it('falls through a Mysti selection to a spawnable backend', () => {
      setMockConfigInspect('defaultAgent', { globalValue: 'mysti' });
      setMockConfig('defaultAgent', 'mysti');
      const backend = h.provider._getPanelProvider('sidebar');
      expect(backend).not.toBe('mysti');
      expect(REGISTERED).toContain(backend);
    });

    it('falls through a pseudo-agent panel override too', () => {
      h.provider._panelStates.get('sidebar').settingsOverrides = { agent: 'brainstorm' };
      const backend = h.provider._getPanelProvider('sidebar');
      expect(backend).not.toBe('brainstorm');
      expect(REGISTERED).toContain(backend);
    });

    it('uses the selected agent as the backend when that agent IS a real provider', () => {
      // Without this, a reloaded panel showed Cursor while compaction, prompt
      // enhancement and visual looks all quietly ran on `defaultProvider`.
      setMockConfig('defaultAgent', 'cursor');
      expect(h.provider._getPanelProvider('sidebar')).toBe('cursor');
    });
  });

  // =========================================================================
  // Persistence — the reason picking Mysti never used to stick
  // =========================================================================
  describe('_handleUpdateSettings', () => {
    it('persists a pseudo-agent selection globally without touching defaultProvider', async () => {
      await h.provider._handleUpdateSettings({ provider: 'mysti' }, 'sidebar');

      const updates = getMockConfigUpdates();
      expect(updates['defaultAgent']).toBe('mysti');
      // The BACKEND must not move: it is what Mysti delegates to.
      expect(updates['defaultProvider']).toBeUndefined();
    });

    it('keeps a pseudo-agent out of the panel\'s provider override', async () => {
      await h.provider._handleUpdateSettings({ provider: 'mysti' }, 'sidebar');

      const overrides = h.provider._panelStates.get('sidebar').settingsOverrides;
      expect(overrides.agent).toBe('mysti');
      expect(overrides.provider).toBeUndefined();
      expect(h.provider._getPanelProvider('sidebar')).not.toBe('mysti');
    });

    it('records both agent and provider when a real backend is picked', async () => {
      await h.provider._handleUpdateSettings({ provider: 'cursor' }, 'sidebar');

      const overrides = h.provider._panelStates.get('sidebar').settingsOverrides;
      expect(overrides.agent).toBe('cursor');
      expect(overrides.provider).toBe('cursor');
      expect(getMockConfigUpdates()['defaultAgent']).toBe('cursor');
    });

    it('refuses to persist an unknown agent id', async () => {
      await h.provider._handleUpdateSettings({ provider: 'totally-made-up' }, 'sidebar');
      expect(getMockConfigUpdates()['defaultAgent']).toBeUndefined();
    });
  });

  // =========================================================================
  // Panel open — the demotion bug
  // =========================================================================
  describe('_sendInitialState', () => {
    it('keeps Mysti selected instead of demoting it to the first installed CLI', async () => {
      setMockConfigInspect('defaultAgent', { globalValue: 'mysti' });
      setMockConfig('defaultAgent', 'mysti');

      await h.provider._sendInitialState('sidebar');

      const initial = h.sidebarMessages.find(m => m.type === 'initialState');
      expect(initial).toBeDefined();
      // Pre-fix this was 'claude-code': 'mysti' has no wizard entry, so the
      // "configured provider not installed" rescue replaced it on every open.
      expect(initial!.payload.settings.provider).toBe('mysti');
    });

    it('still rescues a real provider that is not installed', async () => {
      const h2 = createHarness({ installed: ['openai-codex'] });
      setMockConfigInspect('defaultAgent', { globalValue: 'cursor' });
      setMockConfig('defaultAgent', 'cursor');
      try {
        await h2.provider._sendInitialState('sidebar');
        const initial = h2.sidebarMessages.find(m => m.type === 'initialState');
        expect(initial!.payload.settings.provider).toBe('openai-codex');
      } finally {
        h2.dispose();
      }
    });

    it('does not block a coordinator-ready user behind the install wizard', async () => {
      // No CLI installed at all, but the user is signed in to DeepMyst: Mysti
      // needs no local CLI, so they get a chat rather than an install wall.
      const h2 = createHarness({ installed: [], coordinatorReady: true });
      try {
        await h2.provider._sendInitialState('sidebar');
        expect(h2.sidebarMessages.some(m => m.type === 'showWizard')).toBe(false);
        expect(h2.sidebarMessages.some(m => m.type === 'initialState')).toBe(true);
      } finally {
        h2.dispose();
      }
    });

    it('still shows the wizard when nothing at all is usable', async () => {
      const h2 = createHarness({ installed: [], coordinatorReady: false });
      try {
        await h2.provider._sendInitialState('sidebar');
        expect(h2.sidebarMessages.some(m => m.type === 'showWizard')).toBe(true);
      } finally {
        h2.dispose();
      }
    });
  });

  // =========================================================================
  // Delegation targets
  // =========================================================================
  describe('_availableMystiBackends', () => {
    it('reports no backends when the cache PROVES nothing is installed', () => {
      const h2 = createHarness({ installed: [], complete: true });
      try {
        expect(h2.provider._availableMystiBackends()).toEqual([]);
      } finally {
        h2.dispose();
      }
    });

    it('falls back to the full list only while the cache is still cold', () => {
      const h2 = createHarness({ installed: [], complete: false });
      try {
        expect(h2.provider._availableMystiBackends().length).toBeGreaterThan(0);
      } finally {
        h2.dispose();
      }
    });

    it('lists exactly the installed backends when some are installed', () => {
      expect(h.provider._availableMystiBackends().sort()).toEqual(['claude-code', 'openai-codex']);
    });
  });

  // =========================================================================
  // The action card
  // =========================================================================
  describe('recoverable failures', () => {
    it('turns a rejected stored key into a card with buttons, not a red sentence', () => {
      h.provider._postMystiFailure('sidebar', 'HTTP 401 Unauthorized');

      const card = h.sidebarMessages.find(m => m.type === 'mystiActionRequired');
      expect(card).toBeDefined();
      expect(card!.payload.reason).toBe('auth-rejected');
      expect(card!.payload.actions).toContain('signInAgain');
      expect(card!.payload.actions).toContain('switchAgent');
      expect(h.sidebarMessages.some(m => m.type === 'error')).toBe(false);
    });

    it('offers only installed agents to switch to', () => {
      h.provider._postMystiFailure('sidebar', 'HTTP 401 Unauthorized');
      const card = h.sidebarMessages.find(m => m.type === 'mystiActionRequired');
      const ids = card!.payload.agents.map((a: any) => a.id);
      expect(ids).toEqual(['claude-code', 'openai-codex']);
      expect(ids).not.toContain('cursor'); // installed:false in this harness
      expect(ids).not.toContain('mysti');  // never offers itself as the escape
    });

    it('blames OpenRouter, not DeepMyst, when that is the credential in play', () => {
      const h2 = createHarness({ credentials: { hasDeepMystKey: false, usingOpenRouter: true } });
      try {
        h2.provider._postMystiFailure('sidebar', '401 invalid api key');
        const card = h2.sidebarMessages.find(m => m.type === 'mystiActionRequired');
        expect(card!.payload.reason).toBe('openrouter-rejected');
        expect(card!.payload.actions).toContain('openRouterSettings');
        expect(card!.payload.message).not.toMatch(/sign in/i);
      } finally {
        h2.dispose();
      }
    });

    it('offers a top-up on 402 rather than a pointless re-auth', () => {
      h.provider._postMystiFailure('sidebar', 'HTTP 402 payment required');
      const card = h.sidebarMessages.find(m => m.type === 'mystiActionRequired');
      expect(card!.payload.reason).toBe('credits');
      expect(card!.payload.actions).toContain('topUp');
    });

    it('leaves a non-credential failure on the plain error path', () => {
      h.provider._postMystiFailure('sidebar', '502 provider returned error');
      expect(h.sidebarMessages.some(m => m.type === 'mystiActionRequired')).toBe(false);
      expect(h.sidebarMessages.some(m => m.type === 'error')).toBe(true);
    });

    it('never marks a no-credential card retryable (there is nothing to retry with)', () => {
      const h2 = createHarness({ credentials: { hasDeepMystKey: false, usingOpenRouter: false } });
      try {
        h2.provider._postMystiFailure('sidebar', '401 unauthorized');
        const card = h2.sidebarMessages.find(m => m.type === 'mystiActionRequired');
        expect(card!.payload.reason).toBe('signin');
        expect(card!.payload.retryable).toBe(false);
      } finally {
        h2.dispose();
      }
    });
  });

  // =========================================================================
  // Every failure EXIT of the coordinator run must reach the card.
  //
  // The first pass of this work converted the `ev.error` event path and missed
  // the `catch` path right below it, so a credential failure that arrived as a
  // THROW still rendered the old dead-end string. This scans the shipped source
  // of `_runMystiAgentic` so that gap cannot silently reopen.
  // =========================================================================
  describe('no failure path left as a bare error string', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'providers', 'ChatViewProvider.ts'),
      'utf8',
    );

    /**
     * Source of one method: from its signature to the next class member at the
     * same indent. Brace matching is NOT usable here — the coordinator's system
     * prompt embeds tag/JSON examples full of unbalanced braces inside strings.
     */
    function methodBody(name: string): string {
      const start = source.indexOf(`private async ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const rest = source.slice(start);
      const next = rest.slice(1).search(/\n  (?:private|public|protected|\/\*\*)/);
      expect(next).toBeGreaterThan(-1);
      return rest.slice(0, next + 1);
    }

    it('routes every coordinator failure in _runMystiAgentic through the card helper', () => {
      const body = methodBody('_runMystiAgentic');

      // Both exits — the streamed `ev.error` event and a thrown rejection —
      // hand the raw error to the card helper. Distance-based matching is not
      // used: the comments explaining WHY sit between the catch and the call.
      expect(body).toMatch(/if \(ev\.error\)[^\n]*_postMystiFailure\(panelId, ev\.error\)/);
      expect(body).toMatch(/errorMsg = bg \? this\._friendlyMystiError\(raw\) : this\._postMystiFailure\(panelId, raw\)/);
      expect(body.match(/_postMystiFailure\(/g) ?? []).toHaveLength(2);

      // And nothing posts a bare `type: 'error'` from inside the run any more:
      // that is precisely what rendered as red text with nothing to click.
      expect(body).not.toMatch(/type: 'error'/);
    });

    it('keeps the old dead-end wording out of the tree entirely', () => {
      // The exact string from the bug report. Its only correct form now names
      // what actually failed and is accompanied by buttons.
      expect(source).not.toContain('try signing in again');
      expect(source).not.toContain('run “DeepMyst: Sign In”');
    });
  });

  describe('switchAgentAndRetry', () => {
    it('switches the panel and tells the webview, without a retry when none was sent', async () => {
      await h.provider._handleSwitchAgentAndRetry({ agentId: 'openai-codex' }, 'sidebar');

      expect(h.provider._getPanelAgent('sidebar')).toBe('openai-codex');
      expect(h.sidebarMessages.some(m => m.type === 'agentChanged')).toBe(true);
    });

    it('rejects an unknown agent id instead of switching to nothing', async () => {
      await h.provider._handleSwitchAgentAndRetry({ agentId: 'nope' }, 'sidebar');

      expect(h.sidebarMessages.some(m => m.type === 'error')).toBe(true);
      expect(h.sidebarMessages.some(m => m.type === 'agentChanged')).toBe(false);
    });
  });
});
