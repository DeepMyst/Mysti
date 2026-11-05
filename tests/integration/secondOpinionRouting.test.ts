/** PC-06: actual host second-opinion dispatch, original source and attachment ownership. */
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
import { createModelRegistryStub } from '../helpers/modelRegistryStub';

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
    setNativeApprovalHandler: () => ({ dispose() {} }), setAgentContextManager: () => undefined,
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
    getCrossVendorInstructions: () => [],
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
    // Smart-compaction (Plan 08) additions the done-handler calls unconditionally.
    appendHistory: () => undefined,
    isSmartActive: () => false,
    evaluateCompaction: () => ({ act: false, smart: false }),
    canAutoCompact: () => true,
    cliOwnsHistory: () => false,
    mystiSendsFullHistory: () => false,
    getThreshold: () => 75,
  } as any;

  const contextManager = {
    getContext: () => [],
    setAutoContext: () => undefined,
    clearPanelContext: () => undefined,
  } as any;

  const noop = {} as any;

  const provider = new ChatViewProvider({
    extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager,
    brainstormManager: noop,
    permissionManager,
    setupManager,
    telemetryManager: noop,
    autonomousManager,
    memoryManager,
    compactionManager,
    lifecycleManager,
    slashCommandManager: noop,
    activeModeManager,
    engagementManager,
    projectContextManager,
    visualTestManager: noop,
    modelRegistry: createModelRegistryStub() as any,
    checkpointManager: { snapshot: async () => null, isAvailable: async () => false, rewindTo: async () => null } as any
  });

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


describe('PC-06 second-opinion host routing', () => {
  let h: Harness, host: any, original: any, dispatch: any;
  beforeEach(() => {
    clearMockConfig(); h = createHarness(); host = h.provider as any;
    original = { id: 'question-a', role: 'user', content: '@claude Review **retry**.\n\n```js\nreturn base * 2 ** n;\n```',
      context: [{ id: 'ctx-a', type: 'file', path: '/fixture/requirements.txt', content: 'cap=500' }],
      attachments: [{ id: 'file-a', type: 'file', fileName: 'requirements.txt', filePath: '/fixture/requirements.txt', size: 7 }] };
    host._panelStates.get('sidebar').currentConversationId = 'chat-a';
    host._conversationManager.getConversation = (id: string) => id === 'chat-a' ? { id, messages: [original] } : null;
    host._providerManager.getProvider = (id: string) => ['claude-code', 'openai-codex'].includes(id)
      ? { id, name: id, defaultModel: id === 'openai-codex' ? 'codex-test' : 'claude-test' } : undefined;
    host._providerManager.getModels = (id: string) => [{ id: id === 'openai-codex' ? 'codex-test' : 'claude-test' }];
    host._providerManager.getProviders = () => [{ name: 'claude-code', models: [{ id: SETTINGS.model }] }, { name: 'openai-codex', models: [{ id: 'codex-test' }] }];
    host._providerManager.getAllProviderIds = () => ['claude-code', 'openai-codex'];
    dispatch = host._providerManager.sendMessage;
    h.setStream([{ type: 'text', content: 'Independent review.' }, { type: 'done' }]);
  });
  afterEach(async () => { await host._agentInitPromise; h.dispose(); });
  const request = () => ({ content: 'untrusted replacement text', context: [{ id: 'wrong', type: 'file', path: '/draft/private.txt' }],
    settings: { ...SETTINGS }, secondOpinion: { provider: 'openai-codex', messageId: 'question-a' } });

  it.each(['@claude', '@mysti'])('dispatches original source and files once to only the selected respondent with its own model despite %s', async priorAgent => {
    original.content = original.content.replace('@claude', priorAgent);
    await host._handleSendMessage(request(), 'sidebar');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const args = dispatch.mock.calls[0];
    expect(args[0]).toBe(original.content);
    expect(args[1]).toEqual(original.context);
    expect(args[2]).toMatchObject({ provider: 'openai-codex', model: 'codex-test' });
    expect(args[7]).toEqual(original.attachments);
    expect(h.persistedCalls.filter(c => c[1] === 'user').map(c => c[2])).toEqual([original.content]);
    expect(h.sidebarMessages.filter(m => m.type === 'responseStarted')[0].payload).toMatchObject({ provider: 'openai-codex', model: 'codex-test' });
    expect(host._panelStates.get('sidebar').settingsOverrides).toBeUndefined();
  });

  it.each(['missing-message', 'assistant-message', 'other-conversation', 'unknown-provider'])(
    'rejects a stale or invalid target before dispatch: %s', async fault => {
      const payload = request();
      if (fault === 'missing-message') payload.secondOpinion.messageId = 'missing';
      if (fault === 'assistant-message') original.role = 'assistant';
      if (fault === 'other-conversation') host._panelStates.get('sidebar').currentConversationId = 'chat-b';
      if (fault === 'unknown-provider') payload.secondOpinion.provider = 'unregistered';
      await host._handleSendMessage(payload, 'sidebar');
      expect(dispatch).not.toHaveBeenCalled();
      expect(h.persistedCalls).toHaveLength(0);
      expect(h.sidebarMessages.filter(m => m.type === 'error')).toHaveLength(1);
    });

  it('refuses a restored clipboard image whose bytes were not persisted rather than silently omit it', async () => {
    original.attachments = [{ id: 'image-a', type: 'image', fileName: 'clipboard.png', mimeType: 'image/png', size: 4 }];
    await host._handleSendMessage(request(), 'sidebar');
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.sidebarMessages.find(m => m.type === 'error')?.payload).toMatch(/attach/i);
  });

  it('refuses a respondent that cannot receive the original attachments instead of answering without them', async () => {
    h.setCapabilities({ supportsImages: true, supportsFileAttachments: false });
    await host._handleSendMessage(request(), 'sidebar');
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.sidebarMessages.find(m => m.type === 'error')?.payload).toMatch(/attach/i);
  });

  it('uses matching in-memory clipboard bytes while keeping unrelated draft files out', async () => {
    original.attachments = [{ id: 'image-a', type: 'image', fileName: 'clipboard.png', mimeType: 'image/png', size: 4 }];
    await host._handleSendMessage({ ...request(), attachments: [
      { ...original.attachments[0], base64Data: 'dGVzdA==' },
      { id: 'draft-only', type: 'file', filePath: '/draft/private.txt', fileName: 'private.txt', size: 12 },
    ] }, 'sidebar');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][7]).toEqual([{ ...original.attachments[0], base64Data: 'dGVzdA==' }]);
  });
  it.each(['saved', 'matching live', 'saved with replacement live'])('preserves an empty attachment from %s bytes', async source => {
    original.attachments = [{ id: 'empty-a', type: 'file', fileName: 'empty.txt', mimeType: 'text/plain', size: 0,
      ...(source === 'matching live' ? {} : { base64Data: '' }) }];
    const payload = { ...request(), attachments: source === 'saved' ? undefined : [
      { ...original.attachments[0], base64Data: source === 'matching live' ? '' : 'cmVwbGFjZW1lbnQ=' },
    ] };
    await host._handleSendMessage(payload, 'sidebar');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][7]).toEqual([{ ...original.attachments[0], base64Data: '' }]);
  });
  it('does not invent empty bytes from size metadata when both the snapshot and source path are missing', async () => {
    original.attachments = [{ id: 'empty-a', type: 'file', fileName: 'empty.txt', mimeType: 'text/plain', size: 0 }];
    await host._handleSendMessage(request(), 'sidebar');
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.sidebarMessages.find(m => m.type === 'error')?.payload).toMatch(/attach/i);
  });
});
