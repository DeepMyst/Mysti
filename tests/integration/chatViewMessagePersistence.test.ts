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
 * Plan 02 Phase 3 — done-handler persistence + exit_plan_mode routing.
 *
 * Drives the real ChatViewProvider._handleSendMessage with a scripted
 * provider stream and asserts:
 *  - item 3: the assistant message persisted on `done` carries provider,
 *    model, toolCalls (merged across Claude's duplicate tool_use emission,
 *    resolved by tool_result), structured thinking, and ordered segments
 *  - item 5: an exit_plan_mode chunk routes into the existing plan-selection
 *    flow — the webview receives the same `planOptions` message shape it
 *    already renders, tagged source: 'exit-plan-mode'.
 *
 * Harness follows tests/integration/chatViewWizardRouting.test.ts: real
 * ChatViewProvider + minimal stub collaborators, sidebar panel injected
 * directly into _panelStates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real PlanOptionManager constructs a ResponseClassifier, which spawns
// warm Claude CLI processes — never acceptable in a unit test run.
vi.mock('../../src/managers/PlanOptionManager', () => ({
  PlanOptionManager: class {
    async classifyResponse() {
      return { questions: [], planOptions: [], context: '' };
    }
  },
}));

import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { clearMockConfig, Uri } from '../helpers/mockVscode';
import type { Settings, StreamChunk, WebviewMessage } from '../../src/types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const SETTINGS: Settings = {
  mode: 'edit-automatically',
  thinkingLevel: 'medium',
  accessLevel: 'full-access',
  contextMode: 'manual',
  model: 'claude-opus-4-6',
  provider: 'claude-code',
};

interface Harness {
  provider: ChatViewProvider;
  /** Args of every addMessageToConversation call. */
  persistedCalls: any[][];
  /** Messages posted to the sidebar panel's webview. */
  sidebarMessages: Array<{ type: string; payload?: any }>;
  /** Replace the chunks the provider stream yields. */
  setStream(chunks: StreamChunk[]): void;
  /** Override the capabilities reported by getProviderInstance. */
  setCapabilities(caps: Record<string, unknown> | undefined): void;
  dispose(): void;
}

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

  let streamChunks: StreamChunk[] = [];
  let capabilities: Record<string, unknown> | undefined = {
    supportsImages: true,
    supportsFileAttachments: true,
    thinkingStyle: 'streamed',
  };

  const persistedCalls: any[][] = [];
  let messageCounter = 0;
  const conversationManager = {
    getCurrentConversation: () => null,
    getConversation: () => null,
    getAgentConfig: () => undefined,
    isFirstUserMessage: () => false,
    addMessageToConversation: vi.fn((...args: any[]) => {
      persistedCalls.push(args);
      const [, role, content, context, attachments, thinking, extras] = args;
      return {
        id: `msg-${++messageCounter}`,
        role,
        content,
        timestamp: Date.now(),
        context,
        attachments,
        thinking,
        ...(extras || {}),
      };
    }),
  } as any;

  const providerManager = {
    setAgentContextManager: () => undefined,
    getProvider: () => undefined,
    getProviderInstance: () => (capabilities ? { capabilities } : undefined),
    getModelContextWindow: () => 200000,
    setChannelSystemContext: () => undefined,
    cancelRequest: () => undefined,
    sendMessage: vi.fn(async function* () {
      for (const chunk of streamChunks) {
        yield chunk;
      }
    }),
  } as any;

  const setupManager = {
    getWizardStatus: async () => ({ anyReady: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
    getWizardStatusCached: () => ({ anyReady: true, complete: true, npmAvailable: true, nodeVersion: 'v20.0.0', providers: [] }),
    ensureProviderStatusFresh: async () => undefined,
    refreshWizardStatus: async () => ({ anyReady: true }),
    invalidateProviderStatus: () => undefined,
    onWizardStatusUpdated: () => ({ dispose: () => {} }),
  } as any;

  const lifecycleManager = {
    onLifecycleEvent: () => undefined,
    touchSession: () => undefined,
    markBusy: () => undefined,
    markIdle: () => undefined,
    registerSession: () => undefined,
  } as any;

  const activeModeManager = {
    onStatusChanged: () => undefined,
    onChannelChanged: () => undefined,
    onActivity: () => undefined,
    subscribeToChannelEvents: () => () => undefined,
    isConnected: () => false,
    isInstalled: () => false,
    isIntegrationEnabled: () => false,
  } as any;

  const engagementManager = {
    trackCustomPersonaCreated: () => undefined,
    trackCustomSkillCreated: () => undefined,
    trackMessageSent: () => [],
    trackSuccessfulResponse: () => undefined,
  } as any;

  const memoryManager = {
    learnFromPermissionDecision: () => undefined,
    getProjectMemoryContent: () => '',
    recordProjectLearning: () => undefined,
  } as any;

  const projectContextManager = {
    readRules: () => '',
    getMystiMdContent: () => '',
  } as any;

  const suggestionManager = {
    generateSuggestions: async () => [],
  } as any;

  const autonomousManager = {
    isActive: () => false,
  } as any;

  const compactionManager = {
    shouldCompact: () => false,
    recordUsage: () => undefined,
  } as any;

  const contextManager = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
  } as any;

  const noop = {} as any;

  const provider = new ChatViewProvider(
    extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager,
    noop,                  // brainstormManager
    permissionManager,
    setupManager,
    noop,                  // telemetryManager
    autonomousManager,
    memoryManager,
    compactionManager,
    lifecycleManager,
    noop,                  // slashCommandManager
    activeModeManager,
    engagementManager,
    projectContextManager,
    noop,                  // visualTestManager
    noop                   // canvasManager
  );

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
    persistedCalls,
    sidebarMessages,
    setStream(chunks) { streamChunks = chunks; },
    setCapabilities(caps) { capabilities = caps; },
    dispose() {
      (provider as any)._channelBridge?.dispose?.();
      permissionManager.dispose();
    },
  };
}

function getAssistantPersistCall(h: Harness): any[] {
  const call = h.persistedCalls.find(args => args[1] === 'assistant');
  expect(call).toBeDefined();
  return call!;
}

async function send(h: Harness, content = 'do the thing'): Promise<void> {
  await (h.provider as any)._handleSendMessage(
    { content, context: [], settings: { ...SETTINGS } },
    'sidebar'
  );
}

describe('ChatViewProvider done-handler persistence (Plan 02 Phase 3)', () => {
  let h: Harness;

  beforeEach(() => {
    clearMockConfig();
    h = createHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it('persists provider, model, structured thinking, merged toolCalls, and ordered segments on done', async () => {
    h.setStream([
      { type: 'thinking', content: 'let me think' },
      { type: 'text', content: 'Reading the file. ' },
      // Claude's duplicate emission: content_block_start (empty input) then
      // content_block_stop (full input) — must merge into ONE tool call.
      { type: 'tool_use', toolCall: { id: 'tu-1', name: 'Read', input: {}, status: 'running' } },
      { type: 'tool_use', toolCall: { id: 'tu-1', name: 'Read', input: { file_path: '/src/a.ts' }, status: 'running', kind: 'read' } },
      { type: 'tool_result', toolCall: { id: 'tu-1', name: 'Read', input: { file_path: '/src/a.ts' }, output: 'contents', status: 'completed' } },
      { type: 'text', content: 'Done.' },
      { type: 'done' },
    ]);

    await send(h);

    const [, role, content, , , thinking, extras] = getAssistantPersistCall(h);
    expect(role).toBe('assistant');
    expect(content).toBe('Reading the file. Done.');

    // Structured thinking: provider declares thinkingStyle 'streamed'
    expect(thinking).toEqual({ style: 'streamed', content: 'let me think' });

    expect(extras.provider).toBe('claude-code');
    expect(extras.model).toBe('claude-opus-4-6');

    // One merged tool call, resolved by tool_result
    expect(extras.toolCalls).toHaveLength(1);
    expect(extras.toolCalls[0]).toMatchObject({
      id: 'tu-1',
      name: 'Read',
      input: { file_path: '/src/a.ts' },
      output: 'contents',
      status: 'completed',
      kind: 'read',
    });

    // Ordered segments replay the stream: thinking → text → tool → text
    expect(extras.segments).toEqual([
      { type: 'thinking', content: 'let me think' },
      { type: 'text', content: 'Reading the file. ' },
      { type: 'tool', toolCallId: 'tu-1' },
      { type: 'text', content: 'Done.' },
    ]);
  });

  it('marks tool calls that never received a tool_result as completed at persist time (no eternal spinners)', async () => {
    h.setStream([
      { type: 'tool_use', toolCall: { id: 'tu-2', name: 'Read', input: { file_path: '/b.ts' }, status: 'running' } },
      { type: 'text', content: 'ok' },
      { type: 'done' },
    ]);

    await send(h);

    const [, , , , , , extras] = getAssistantPersistCall(h);
    expect(extras.toolCalls).toHaveLength(1);
    expect(extras.toolCalls[0].status).toBe('completed');
  });

  it('falls back to legacy plain-string thinking when the provider thinkingStyle is unknown', async () => {
    h.setCapabilities(undefined); // getProviderInstance returns undefined
    h.setStream([
      { type: 'thinking', content: 'hidden reasoning' },
      { type: 'text', content: 'answer' },
      { type: 'done' },
    ]);

    await send(h);

    const [, , , , , thinking] = getAssistantPersistCall(h);
    expect(thinking).toBe('hidden reasoning');
  });

  it('persists a text-only response with no thinking/toolCalls and a single text segment', async () => {
    h.setStream([
      { type: 'text', content: 'just text' },
      { type: 'done' },
    ]);

    await send(h);

    const [, , , , , thinking, extras] = getAssistantPersistCall(h);
    expect(thinking).toBeUndefined();
    expect(extras.toolCalls).toBeUndefined();
    // A single text segment is still recorded (content === segment text)
    expect(extras.segments).toEqual([{ type: 'text', content: 'just text' }]);
  });

  it('consecutive same-type chunks merge into one segment', async () => {
    h.setStream([
      { type: 'text', content: 'part one, ' },
      { type: 'text', content: 'part two' },
      { type: 'done' },
    ]);

    await send(h);

    const [, , , , , , extras] = getAssistantPersistCall(h);
    expect(extras.segments).toEqual([{ type: 'text', content: 'part one, part two' }]);
  });
});

describe('ChatViewProvider exit_plan_mode routing (Plan 02 Phase 3.5)', () => {
  let h: Harness;

  beforeEach(() => {
    clearMockConfig();
    h = createHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it('routes exit_plan_mode into the existing planOptions flow with the streamed response as plan content', async () => {
    const planText = '# Refactor Plan\nSplit the module into three files.';
    h.setStream([
      { type: 'text', content: planText },
      { type: 'exit_plan_mode', planFilePath: null },
      { type: 'done' },
    ]);

    await send(h);

    const planMsg = h.sidebarMessages.find(m => m.type === 'planOptions');
    expect(planMsg).toBeDefined();
    expect(planMsg!.payload.source).toBe('exit-plan-mode');
    expect(planMsg!.payload.planFilePath).toBeNull();
    expect(planMsg!.payload.options).toHaveLength(1);
    expect(planMsg!.payload.options[0].title).toBe('Refactor Plan');
    expect(planMsg!.payload.options[0].approach).toBe(planText);
    expect(planMsg!.payload.options[0].summary).toContain('Split the module');
    // Same contract as detected plans: messageId + syntheticPlanId present
    expect(planMsg!.payload.messageId).toBeTruthy();
    expect(planMsg!.payload.syntheticPlanId).toMatch(/^plan-/);

    // The plan moment blocks the suggestion/detection pass for this response
    expect((h.provider as any)._pendingPlanSelections.has('sidebar')).toBe(true);
    expect(h.sidebarMessages.some(m => m.type === 'suggestionsLoading')).toBe(false);
  });

  it('does not post a plan card when exit_plan_mode arrives with no plan content at all', async () => {
    h.setStream([
      { type: 'exit_plan_mode', planFilePath: null },
      { type: 'done' },
    ]);

    await send(h);

    expect(h.sidebarMessages.some(m => m.type === 'planOptions')).toBe(false);
    expect((h.provider as any)._pendingPlanSelections.has('sidebar')).toBe(false);
  });

  it('without exit_plan_mode, no planOptions message is posted (regression guard)', async () => {
    h.setStream([
      { type: 'text', content: 'normal answer' },
      { type: 'done' },
    ]);

    await send(h);

    expect(h.sidebarMessages.some(m => m.type === 'planOptions')).toBe(false);
  });
});
