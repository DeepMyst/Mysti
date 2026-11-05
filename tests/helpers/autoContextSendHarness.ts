// Adapted from the established chatViewMessagePersistence integration harness.
// Product construction and send orchestration remain real; auxiliary managers
// use the same deterministic collaborators. No extension activation occurs.
import { vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { ContextManager } from '../../src/managers/ContextManager';
import { createMockMemento, Uri } from './mockVscode';
import { createModelRegistryStub } from './modelRegistryStub';
import type { StreamChunk, WebviewMessage } from '../../src/types';

/** Test-local window events; the shared VS Code mock file remains unchanged. */
export function installEditorWindowFixture() {
  const window = vscode.window as any;
  const keys = ['activeTextEditor', 'visibleTextEditors', 'onDidChangeActiveTextEditor', 'createWebviewPanel'];
  const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(window, key)]));
  const listeners = new Set<(editor: any) => void>();
  const set = (key: string, value: unknown) => Object.defineProperty(window, key, { configurable: true, writable: true, value });
  set('activeTextEditor', undefined); set('visibleTextEditors', []);
  set('onDidChangeActiveTextEditor', (listener: (editor: any) => void) => {
    listeners.add(listener); return { dispose: () => listeners.delete(listener) };
  });
  const activate = (editor?: any, visible: any[] = editor ? [editor] : []) => {
    window.visibleTextEditors = visible;
    window.activeTextEditor = editor;
    for (const listener of [...listeners]) listener(editor);
  };
  return {
    activate,
    focusChat() { activate(undefined, window.visibleTextEditors); },
    setVisible(editors: any[]) { window.visibleTextEditors = editors; },
    listenerCount: () => listeners.size,
    installDetachedPanels(host: any) {
      const panels: any[] = [];
      let nextConversation = 0;
      host._conversationManager.createNewConversation = () => ({ id: `owned-detached-${++nextConversation}`, messages: [] });
      // Focus, owner registration and the actual send path remain production
      // code. Rendering/bootstrap and prewarming are unrelated to this fixture.
      host._sendInitialState = vi.fn(async () => {});
      host._tryPreSpawnPersistentProcess = vi.fn();
      set('createWebviewPanel', () => {
        let disposed = false;
        const focusListeners = new Set<(event: any) => void>();
        const disposeListeners = new Set<() => void>();
        const incoming = new Set<(message: unknown) => void>();
        const panel: any = {
          active: true, visible: true,
          webview: { html: '', options: {}, postMessage: vi.fn(async () => true),
            onDidReceiveMessage(callback: (message: unknown) => void) { incoming.add(callback); return { dispose: () => incoming.delete(callback) }; } },
          onDidChangeViewState(callback: (event: any) => void) { focusListeners.add(callback); return { dispose: () => focusListeners.delete(callback) }; },
          onDidDispose(callback: () => void) { disposeListeners.add(callback); return { dispose: () => disposeListeners.delete(callback) }; },
          focus() {
            activate(undefined, window.visibleTextEditors);
            for (const sibling of panels) sibling.active = sibling === panel;
            for (const callback of focusListeners) callback({ webviewPanel: panel });
          },
          dispose() {
            if (disposed) return;
            disposed = true; panel.active = false; panel.visible = false;
            for (const callback of [...disposeListeners]) callback();
            disposeListeners.clear(); focusListeners.clear(); incoming.clear();
          },
        };
        for (const sibling of panels) sibling.active = false;
        panels.push(panel);
        // VS Code can report undefined synchronously while creating the webview.
        activate(undefined, window.visibleTextEditors);
        return panel;
      });
      return panels;
    },
    restore() {
      listeners.clear();
      for (const key of keys) {
        const descriptor = original.get(key);
        if (descriptor) Object.defineProperty(window, key, descriptor);
        else delete window[key];
      }
    },
  };
}

export function createHarness() {
  const extensionUri = Uri.file('/mock/extension-does-not-exist') as any;
  const extensionContext = {
    globalState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    },
    workspaceState: createMockMemento(),
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
    getAllProviders: () => [],
    dispose: () => undefined,
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
    removeSession: () => undefined,
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
    trackConversationStarted: () => [],
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
    resetUsage: () => undefined,
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

  const contextManager = new ContextManager(extensionContext);

  const noop = {} as any;

  const provider = new ChatViewProvider({
    extensionUri,
    extensionContext,
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager,
    brainstormManager: { cancelSession() {}, clearSession() {} } as any,
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
    visualTestManager: { disposePanel: async () => {} } as any,
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
    providerManager,
    conversationManager,
    contextManager,
    extensionContext,
    persistedCalls,
    sidebarMessages,
    setStream(chunks: StreamChunk[]) { streamChunks = chunks; },
    setCapabilities(caps: Record<string, unknown> | undefined) { capabilities = caps; },
    dispose() {
      provider.dispose();
      permissionManager.dispose();
      for (const disposable of extensionContext.subscriptions) disposable?.dispose?.();
    },
  };
}
