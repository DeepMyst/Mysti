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
 * The reported bug: a panel switched to Codex kept answering as "Qwen3 Coder",
 * and `/model` said "Model changed to: GPT-6 Astra" without changing anything.
 * Three defects, one visible symptom:
 *
 *  1. The global `mysti.defaultModel` was left at a Qwen id from an earlier
 *     session, and `_getPanelModel` kept it for EVERY provider because it was
 *     syntactically valid — the "custom/unlisted model" rule (#39) could not
 *     tell a hand-typed model from another backend's leftover. Only Gemini and
 *     Codex guarded against that themselves, so the rest would have run
 *     `--model qwen3-coder`.
 *  2. `/model` wrote the panel override but told the webview nothing, so the
 *     webview kept its own stale copy and re-sent it with the next message —
 *     the override never survived a single turn.
 *  3. Attribution stamped `settings.model` (the picker's value) rather than the
 *     model the provider actually resolves, which a per-provider custom-model
 *     override outranks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The real PlanOptionManager constructs a ResponseClassifier, which spawns warm
// Claude CLI processes — never acceptable in a unit test run.
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() {
      return { hasPlanOptions: false, options: [], clarifyingQuestions: [] };
    }
  },
}));

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, setMockConfig, Uri } from '../helpers/mockVscode';
import type { WebviewMessage, Settings } from '../../src/types';
import { createModelRegistryStub } from '../helpers/modelRegistryStub';

// A catalog shaped like the real one in the way that matters: each provider
// owns ids the others do not, and Ollama mirrors another vendor's id verbatim.
const CATALOG: Record<string, { models: string[]; defaultModel: string }> = {
  'claude-code': { models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5' },
  'openai-codex': { models: ['gpt-5-codex', 'gpt-6-astra'], defaultModel: 'gpt-5-codex' },
  'qwen-code': { models: ['qwen3-coder', 'qwen3-coder-next'], defaultModel: 'qwen3-coder' },
  'google-gemini': { models: ['gemini-3-pro'], defaultModel: 'gemini-3-pro' },
  // Local mirrors: whatever the user pulled, including other vendors' ids.
  'ollama': { models: ['qwen3-coder', 'deepseek-r1'], defaultModel: 'deepseek-r1' },
};

interface Harness {
  provider: ChatViewProvider;
  messages: Array<{ type: string; payload?: any }>;
  panelState: any;
  /** Effective model each provider instance reports for given settings. */
  effectiveModels: Record<string, (s: Settings) => string | undefined>;
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

  const effectiveModels: Record<string, (s: Settings) => string | undefined> = {};

  const providerConfigs = Object.entries(CATALOG).map(([name, c]) => ({
    name,
    models: c.models.map(id => ({ id, name: id })),
    defaultModel: c.defaultModel,
  }));

  const providerManager: any = {
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
    getProviders: vi.fn(() => providerConfigs),
    getProvider: vi.fn((name: string) => providerConfigs.find(p => p.name === name)),
    getProviderInstance: vi.fn((name: string) =>
      effectiveModels[name]
        ? { getEffectiveModelForSettings: (s: Settings) => effectiveModels[name](s) }
        : undefined
    ),
    getAllProviders: () => [],
    getAllProviderIds: vi.fn(() => Object.keys(CATALOG)),
    getModels: vi.fn((name: string) => providerConfigs.find(p => p.name === name)?.models ?? []),
    getModelContextWindow: vi.fn(() => 200000),
    disposePersistentProcess: vi.fn(),
    clearSessionForProvider: vi.fn(),
  };

  const noop = {} as any;
  const contextManager: any = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
    onContextChanged: () => undefined,
  };
  const conversationManager: any = {
    getCurrentConversation: () => null,
    getConversation: vi.fn(() => null),
  };
  const setupManager: any = {
    getWizardStatus: async () => ({ anyReady: false, npmAvailable: true, providers: [] }),
    getWizardStatusCached: () => ({ anyReady: false, npmAvailable: true, providers: [], complete: false }),
    ensureProviderStatusFresh: async () => undefined,
    refreshWizardStatus: async () => ({ anyReady: false, npmAvailable: true, providers: [] }),
    invalidateProviderStatus: () => undefined,
    onWizardStatusUpdated: () => ({ dispose: () => {} }),
  };
  const activeModeManager: any = {
    onStatusChanged: () => undefined,
    onChannelChanged: () => undefined,
    onActivity: () => undefined,
    subscribeToChannelEvents: () => () => undefined,
    isConnected: () => false,
    isInstalled: () => false,
  };
  const compactionManager: any = {
    getStrategy: vi.fn(() => 'client-summarize'),
    getThreshold: vi.fn(() => 75),
    resetUsage: vi.fn(),
    appendHistory: vi.fn(),
  };

  const provider = new ChatViewProvider({
    extensionUri: extensionContext.extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager: noop,
    brainstormManager: noop,
    permissionManager,
    setupManager,
    telemetryManager: noop,
    autonomousManager: noop,
    memoryManager: { learnFromPermissionDecision: vi.fn() } as any,
    compactionManager,
    lifecycleManager: { onLifecycleEvent: () => undefined } as any,
    slashCommandManager: { getMenu: () => [] } as any,
    activeModeManager,
    engagementManager: { trackMessageSent: () => [] } as any,
    projectContextManager: noop,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub() as any,
    checkpointManager: undefined as any
  });

  const messages: Array<{ type: string; payload?: any }> = [];
  const panelState: any = {
    id: 'sidebar',
    webview: {
      postMessage: (m: WebviewMessage) => { messages.push(m as any); return Promise.resolve(true); },
    },
    currentConversationId: null,
    isSidebar: true,
  };
  (provider as any)._panelStates.set('sidebar', panelState);

  return {
    provider,
    messages,
    panelState,
    effectiveModels,
    dispose() {
      (provider as any)._channelBridge?.dispose?.();
      permissionManager.dispose();
    },
  };
}

/** Put the panel on `providerId` without going through updateSettings. */
function selectAgent(h: Harness, providerId: string) {
  h.panelState.settingsOverrides = { ...(h.panelState.settingsOverrides || {}), agent: providerId, provider: providerId };
}

describe('the model a panel reports is the model it runs', () => {
  let h: Harness;

  beforeEach(() => {
    clearMockConfig();
    h = createHarness();
  });
  afterEach(() => {
    h.dispose();
    clearMockConfig();
    vi.restoreAllMocks();
  });

  describe("a leftover model from another backend doesn't ride along (defect 1)", () => {
    it('the exact report: Codex selected, mysti.defaultModel still a Qwen id', () => {
      // Precisely the user's settings.json.
      setMockConfig('defaultModel', 'qwen3-coder');
      setMockConfig('defaultAgent', 'openai-codex');
      selectAgent(h, 'openai-codex');

      // Before: 'qwen3-coder' — valid-looking, so kept, and shown as the
      // panel's model on every paint.
      expect((h.provider as any)._getPanelModel('sidebar')).toBe('gpt-5-codex');
    });

    it('applies to every backend, not just the two with their own guard', () => {
      setMockConfig('defaultModel', 'qwen3-coder');
      for (const [id, entry] of Object.entries(CATALOG)) {
        if (id === 'qwen-code' || id === 'ollama') { continue; } // both legitimately own the id
        selectAgent(h, id);
        expect((h.provider as any)._getPanelModel('sidebar')).toBe(entry.defaultModel);
      }
    });

    it('keeps a hand-typed / unlisted model — issue #39 is not undone', () => {
      setMockConfig('defaultModel', 'some-unreleased-preview-42');
      selectAgent(h, 'claude-code');
      expect((h.provider as any)._getPanelModel('sidebar')).toBe('some-unreleased-preview-42');
    });

    it('keeps a model the user declared custom FOR THIS provider', () => {
      setMockConfig('defaultModel', 'gpt-5-codex');
      setMockConfig('customModels', { 'claude-code': ['gpt-5-codex'] });
      selectAgent(h, 'claude-code');
      expect((h.provider as any)._getPanelModel('sidebar')).toBe('gpt-5-codex');
    });

    it('lets a local mirror keep an id it shares with the vendor it mirrors', () => {
      // Ollama really does serve a model called `qwen3-coder`; Qwen Code owning
      // the name must not make it unusable there.
      setMockConfig('defaultModel', 'qwen3-coder');
      selectAgent(h, 'ollama');
      expect((h.provider as any)._getPanelModel('sidebar')).toBe('qwen3-coder');
    });

    it('settles the model on the SEND path, not just at panel paint', () => {
      // The webview holds its own copy and posts it back with every message, so
      // seeding a good value once was never enough.
      const settings = { provider: 'claude-code', model: 'qwen3-coder' } as unknown as Settings;
      expect((h.provider as any)._withResolvedModel(settings).model).toBe('claude-sonnet-5');
    });

    it('leaves a pseudo-agent alone — it has no backend catalog to check', () => {
      const settings = { provider: 'mysti', model: 'qwen3-coder' } as unknown as Settings;
      expect((h.provider as any)._withResolvedModel(settings)).toBe(settings);
    });
  });

  describe('a model change reaches the webview (defect 2)', () => {
    it('/model posts modelChanged, so the webview stops re-sending the old id', async () => {
      setMockConfig('defaultModel', 'qwen3-coder');
      selectAgent(h, 'openai-codex');
      h.messages.length = 0;

      // What SlashCommandManager's `model:switch` does after the QuickPick.
      await (h.provider as any)._handleUpdateSettings({ model: 'gpt-6-astra' }, 'sidebar');

      const changed = h.messages.filter(m => m.type === 'modelChanged');
      expect(changed).toHaveLength(1);
      expect(changed[0].payload).toEqual({ model: 'gpt-6-astra', provider: 'openai-codex', customModel: '' });
    });

    it('a provider switch answers with the model that provider will use', async () => {
      setMockConfig('defaultModel', 'qwen3-coder');
      selectAgent(h, 'qwen-code');
      h.messages.length = 0;

      await (h.provider as any)._handleUpdateSettings({ provider: 'claude-code' }, 'sidebar');

      const changed = h.messages.filter(m => m.type === 'modelChanged');
      expect(changed).toHaveLength(1);
      expect(changed[0].payload).toEqual({ model: 'claude-sonnet-5', provider: 'claude-code', customModel: '' });
      // …and the stored override moved with it, so nothing re-resolves later.
      expect(h.panelState.settingsOverrides.model).toBe('claude-sonnet-5');
    });

    it('a switch does NOT clobber a model the user hand-typed', async () => {
      setMockConfig('defaultModel', 'some-unreleased-preview-42');
      selectAgent(h, 'qwen-code');
      h.messages.length = 0;

      await (h.provider as any)._handleUpdateSettings({ provider: 'claude-code' }, 'sidebar');

      const changed = h.messages.filter(m => m.type === 'modelChanged');
      expect(changed[0].payload.model).toBe('some-unreleased-preview-42');
    });

    it('reports the per-provider custom model, which outranks the picker', async () => {
      // The reported configuration: mysti.codexModel is what CodexProvider will
      // actually run, so a switch onto Codex has to say "Custom…" rather than
      // name a stock model the CLI is not going to use.
      setMockConfig('defaultModel', 'qwen3-coder');
      setMockConfig('codexModel', 'gpt-6-astra');
      selectAgent(h, 'qwen-code');
      h.messages.length = 0;

      await (h.provider as any)._handleUpdateSettings({ provider: 'openai-codex' }, 'sidebar');

      const changed = h.messages.filter(m => m.type === 'modelChanged');
      expect(changed[0].payload.customModel).toBe('gpt-6-astra');
    });

    it('stays quiet when neither provider nor model was part of the update', async () => {
      selectAgent(h, 'openai-codex');
      h.messages.length = 0;
      await (h.provider as any)._handleUpdateSettings({ thinkingLevel: 'high' }, 'sidebar');
      expect(h.messages.filter(m => m.type === 'modelChanged')).toHaveLength(0);
    });
  });

  describe('the turn announces who is answering it (defect 3)', () => {
    // Source-level: the announcement has to follow the routing decision, and it
    // is far cheaper to assert that than to drive a whole streamed turn.
    const SRC = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'providers', 'ChatViewProvider.ts'), 'utf8'
    );

    // Several paths announce a turn now (the send path and Plan 29 sessions),
    // so these anchor on the send path's own announcement rather than the
    // first one in the file.
    const sendAnnounceAt = () => {
      const swapAt = SRC.indexOf('if (mentionOutranksCoordinator && mystiSelected) {');
      return { swapAt, announceAt: SRC.indexOf("type: 'responseStarted'", swapAt) };
    };

    it('responseStarted is posted AFTER the mention-outranks-coordinator swap', () => {
      // Announcing before it would put "Mysti" on a turn that "@claude fix this"
      // has just routed to Claude, for the whole time it streams.
      const { swapAt, announceAt } = sendAnnounceAt();
      expect(swapAt).toBeGreaterThan(-1);
      expect(announceAt).toBeGreaterThan(swapAt);
    });

    it('…and still before the coordinator branch, which returns on its own', () => {
      const { announceAt } = sendAnnounceAt();
      const coordinatorAt = SRC.indexOf('if ((mystiSelected || mystiMatch) && !mentionOutranksCoordinator');
      expect(coordinatorAt).toBeGreaterThan(announceAt);
    });
  });

  describe('attribution names the model that ran (defect 3)', () => {
    it("uses the provider's own resolution, so a custom-model override shows", () => {
      // mysti.codexModel = gpt-6-astra outranks the picker inside CodexProvider.
      h.effectiveModels['openai-codex'] = () => 'gpt-6-astra';
      const settings = { provider: 'openai-codex', model: 'gpt-5-codex' } as unknown as Settings;
      expect((h.provider as any)._attributionModel(settings)).toBe('gpt-6-astra');
    });

    it('reads "no --model flag" as the provider default, not as blank', () => {
      h.effectiveModels['openai-codex'] = () => undefined;
      const settings = { provider: 'openai-codex', model: 'gpt-5-codex' } as unknown as Settings;
      expect((h.provider as any)._attributionModel(settings)).toBe('gpt-5-codex');
    });

    it('falls back to the setting when the provider is not a spawnable backend', () => {
      const settings = { provider: 'mysti', model: 'qwen/qwen3-coder' } as unknown as Settings;
      expect((h.provider as any)._attributionModel(settings)).toBe('qwen/qwen3-coder');
    });

    it('never lets a label break a finished turn', () => {
      h.effectiveModels['claude-code'] = () => { throw new Error('boom'); };
      const settings = { provider: 'claude-code', model: 'claude-opus-5' } as unknown as Settings;
      expect((h.provider as any)._attributionModel(settings)).toBe('claude-opus-5');
    });
  });
});
