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
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ContextManager } from '../managers/ContextManager';
import { ConversationManager } from '../managers/ConversationManager';
import { ProviderManager } from '../managers/ProviderManager';
import { SuggestionManager } from '../managers/SuggestionManager';
import { BrainstormManager } from '../managers/BrainstormManager';
import { MentionRouter } from '../managers/MentionRouter';
import { PermissionManager } from '../managers/PermissionManager';
import { PlanOptionManager } from '../managers/PlanOptionManager';
import { SetupManager, type WizardStatusResult } from '../managers/SetupManager';
import { TelemetryManager } from '../managers/TelemetryManager';
import { AgentLoader } from '../managers/AgentLoader';
import { AgentContextManager } from '../managers/AgentContextManager';
import { AutonomousManager } from '../managers/AutonomousManager';
import { MemoryManager } from '../managers/MemoryManager';
import { CompactionManager } from '../managers/CompactionManager';
import { AgentLifecycleManager } from '../managers/AgentLifecycleManager';
import { SlashCommandManager, type SlashCommandCallbacks } from '../managers/SlashCommandManager';
import { ActiveModeManager } from '../managers/ActiveModeManager';
import { EngagementManager } from '../managers/EngagementManager';
import { ProjectContextManager } from '../managers/ProjectContextManager';
import { VisualTestManager } from '../managers/VisualTestManager';
import { ChannelBridge } from '../managers/ChannelBridge';
import { DeepMystAuthManager } from '../managers/DeepMystAuthManager';
import { getWebviewContent } from '../webview/webviewContent';
import { getVisualTestDashboardContent } from '../webview/visualTestDashboardContent';
import { getCanvasContent } from '../webview/canvasContent';
import { CanvasManager } from '../managers/CanvasManager';
import { ImageGenerationService } from '../services/ImageGenerationService';
import { VideoGenerationService } from '../services/VideoGenerationService';
import type { ModelRegistryService } from '../services/ModelRegistryService';
import type { CanvasSecrets } from '../services/CanvasSecrets';
import { BrowserManager } from '../services/BrowserManager';
import { ScreenshotService } from '../services/ScreenshotService';
import { DevServerManager } from '../managers/DevServerManager';
import type { WebviewMessage, Settings, ContextItem, Attachment, QuickActionSuggestion, Message, MessageSegment, MessageThinking, MessageThinkingStyle, ToolCall, PermissionResponse, PlanSelectionResult, QuestionSubmission, ClarifyingQuestion, AgentConfiguration, ProviderType, Mention, MentionTask, MentionTaskList, SubAgentResponse, AgentType, AskUserQuestionData, AskUserQuestionItem, CompactionEvent, UsageStats, Conversation, PlanOption, AuthMethodType, SubAgentQuestionCallback, VisualTestConfig, VisualTestTrigger, VisualTestStreamChunk } from '../types';
import { AUTONOMOUS_CONTINUATION_DELAY_MS, DEFAULT_PROVIDER, DEFAULT_FALLBACK_MODEL, SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S } from '../constants';
import { DEVELOPER_PERSONAS, DEVELOPER_SKILLS } from './base/IProvider';
import {
  buildProviderManifestPayload,
  getCustomModelSettingKey,
  getManifestAffectingSettingKeys
} from './base/ProviderManifest';
import type { ProviderManifestPayload, StitchScreenRef } from '../types';
import { validateModelName, validateProfileName } from '../utils/validation';
import { classifyToolAction, shouldGateToolUse } from '../utils/permissionClassifier';
import { PerfTracker } from '../utils/PerfTracker';

/**
 * Extended message type that includes the panelId field sent by the webview
 * alongside every WebviewMessage. This avoids `(message as any).panelId` casts.
 */
interface WebviewMessageWithPanel extends WebviewMessage {
  panelId: string;
}

/**
 * Max characters read from an exit_plan_mode plan file before it is routed
 * into the plan-selection flow (Plan 02 Phase 3.5) — the plan content becomes
 * part of the follow-up prompt on approval, so it must stay bounded.
 */
const EXIT_PLAN_FILE_MAX_CHARS = 20000;

interface PanelState {
  id: string;
  webview: vscode.Webview;
  panel?: vscode.WebviewPanel;
  currentConversationId: string | null;
  isSidebar: boolean;
  /** Per-panel settings overrides (provider, model) so panels don't contaminate each other */
  settingsOverrides?: Partial<Pick<Settings, 'provider' | 'model'>>;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _panelStates: Map<string, PanelState> = new Map();
  private readonly _sidebarId = 'sidebar';
  private _extensionUri: vscode.Uri;
  private _extensionContext: vscode.ExtensionContext;
  private _contextManager: ContextManager;
  private _conversationManager: ConversationManager;
  private _providerManager: ProviderManager;
  private _suggestionManager: SuggestionManager;
  private _brainstormManager: BrainstormManager;
  private _permissionManager: PermissionManager;
  private _planOptionManager: PlanOptionManager;
  private _setupManager: SetupManager;
  private _telemetryManager: TelemetryManager;
  private _agentLoader: AgentLoader;
  private _agentContextManager: AgentContextManager;
  private _mentionRouter: MentionRouter;
  private _autonomousManager: AutonomousManager;
  private _memoryManager: MemoryManager;
  private _compactionManager: CompactionManager;
  private _lifecycleManager: AgentLifecycleManager;
  private _slashCommandManager: SlashCommandManager;
  private _activeModeManager: ActiveModeManager;
  private _engagementManager: EngagementManager;
  private _projectContextManager: ProjectContextManager;
  private _visualTestManager: VisualTestManager;
  private _channelBridge: ChannelBridge;
  // Canvas tracking
  private _canvasManager: CanvasManager;
  // Plan 01: model registry — single authority for per-provider model lists +
  // context windows. Threaded in here for the consumer agent (Phase 4) to drive
  // the dynamic dropdown / modelsUpdated / requestModels wiring.
  private _modelRegistry: ModelRegistryService;
  private _imageGenService: ImageGenerationService;
  private _videoGenService: VideoGenerationService;
  private _codeGenService: any; // Lazy-loaded CodeGenerationService
  // F-11: SecretStorage-backed canvas API keys. Injected from extension.ts so
  // a single instance (constructed once at activation, after migrate()) is
  // shared with the generation services and StitchService.
  private _canvasSecrets: CanvasSecrets | null = null;
  private _canvasBrowserManager: BrowserManager = new BrowserManager();
  private _canvasScreenshotService: ScreenshotService = new ScreenshotService();
  private _canvasDevServerManager: DevServerManager = new DevServerManager();
  private _canvasPanelId: string | null = null;
  private _canvasChatOrigin: string | null = null;
  // Visual test dashboard tracking
  private _vtDashboardPanelId: string | null = null;
  private _vtDashboardChatOrigin: string | null = null;
  private _vtTriggeredThisResponse: boolean = false;
  // Plan 04 Phase 4: DeepMyst auth (set post-construction in extension.ts). Used
  // to (a) inject the in-chat connect convention into the system prompt and
  // (b) resolve the web URL for the "Link <service>" connect action.
  private _deepMystAuth?: DeepMystAuthManager;
  // Services for which we've already emitted a connect card this response, so the
  // per-chunk scan over the accumulated text doesn't re-post the same card.
  private _connectServicesThisResponse: Set<string> = new Set();
  // Short-lived cache of the user's DeepMyst connection names (lowercased) for
  // already-linked suppression; refreshed at most once per TTL.
  private _connectionsCache?: { at: number; names: string[] };
  // Per-panel cancel tracking for isolated cancellation
  private _cancelledPanels: Set<string> = new Set();
  // Perf (Plan 03 Phase 1): panels whose webview has not yet posted `uiReady`.
  // Guards `panel.timeToUsable` against duplicate/stale `uiReady` messages.
  private _pendingUiReadyPanels: Set<string> = new Set();
  // Track which panels have an active stream (for ChannelBridge inbound routing)
  private _runningPanels: Set<string> = new Set();
  // Track most recently active panel for channel message routing
  private _lastActivePanelId: string | null = null;
  // Track last user message per panel for plan selection follow-up
  private _lastUserMessage: Map<string, string> = new Map();
  // Store mention context per panel for sub-agent retry support
  private _lastMentionContext: Map<string, { content: string; mentions: Mention[]; context: ContextItem[]; settings: Settings }> = new Map();
  // Track if agents have been loaded
  private _agentsLoaded: boolean = false;
  private _agentInitPromise: Promise<void>;
  // Track panels with pending AskUserQuestion (to suppress plan options/suggestions)
  private _pendingAskUserQuestions: Set<string> = new Set();
  // Store pending question data for memory learning when user answers
  private _pendingQuestionData: Map<string, AskUserQuestionData> = new Map();
  // Semi-autonomous question timeout handles (toolCallId -> timeout)
  private _semiAutoQuestionTimeouts: Map<string, NodeJS.Timeout> = new Map();
  // Pending sub-agent questions awaiting user answers (key: panelId-toolCallId -> resolver)
  private _pendingSubAgentQuestions: Map<string, {
    resolve: (value: { answers: Record<string, string | string[]> } | null) => void;
  }> = new Map();
  // Track panels with pending plan option selections (to block autonomous continuation)
  private _pendingPlanSelections: Set<string> = new Set();
  // Store pending plan data for semi-auto timeout (syntheticPlanId -> plan data)
  private _pendingPlanData: Map<string, { options: PlanOption[]; messageId: string; originalQuery: string }> = new Map();
  // Semi-autonomous plan selection timeout handles (syntheticPlanId -> timeout)
  private _semiAutoPlanTimeouts: Map<string, NodeJS.Timeout> = new Map();
  // Track per-panel autonomy level (source of truth for semi-auto checks)
  private _panelAutonomyLevel: Map<string, string> = new Map();
  // Track files touched per panel for auto-memory learning
  private _panelFilesRead: Map<string, Set<string>> = new Map();
  private _panelFilesWritten: Map<string, Set<string>> = new Map();
  // M6: Debounced workspace file cache refresh
  private _fileCacheRefreshTimer: NodeJS.Timeout | null = null;

  constructor(
    extensionUri: vscode.Uri,
    extensionContext: vscode.ExtensionContext,
    contextManager: ContextManager,
    conversationManager: ConversationManager,
    providerManager: ProviderManager,
    suggestionManager: SuggestionManager,
    brainstormManager: BrainstormManager,
    permissionManager: PermissionManager,
    setupManager: SetupManager,
    telemetryManager: TelemetryManager,
    autonomousManager: AutonomousManager,
    memoryManager: MemoryManager,
    compactionManager: CompactionManager,
    lifecycleManager: AgentLifecycleManager,
    slashCommandManager: SlashCommandManager,
    activeModeManager: ActiveModeManager,
    engagementManager: EngagementManager,
    projectContextManager: ProjectContextManager,
    visualTestManager: VisualTestManager,
    canvasManager: CanvasManager,
    modelRegistry: ModelRegistryService
  ) {
    this._extensionUri = extensionUri;
    this._extensionContext = extensionContext;
    this._contextManager = contextManager;
    this._conversationManager = conversationManager;
    this._providerManager = providerManager;
    this._suggestionManager = suggestionManager;
    this._brainstormManager = brainstormManager;
    this._permissionManager = permissionManager;
    this._setupManager = setupManager;
    this._telemetryManager = telemetryManager;
    this._autonomousManager = autonomousManager;
    this._memoryManager = memoryManager;
    this._compactionManager = compactionManager;
    this._lifecycleManager = lifecycleManager;
    this._slashCommandManager = slashCommandManager;
    this._activeModeManager = activeModeManager;
    this._engagementManager = engagementManager;
    this._projectContextManager = projectContextManager;
    this._visualTestManager = visualTestManager;
    this._canvasManager = canvasManager;
    this._modelRegistry = modelRegistry;
    this._imageGenService = new ImageGenerationService();
    this._videoGenService = new VideoGenerationService();
    this._channelBridge = new ChannelBridge(activeModeManager);
    this._planOptionManager = new PlanOptionManager();
    this._mentionRouter = new MentionRouter(this._providerManager);

    // Initialize agent system (three-tier loading)
    this._agentLoader = new AgentLoader(extensionContext);
    this._agentContextManager = new AgentContextManager(extensionContext, this._agentLoader);

    // Connect agent context manager to provider manager
    this._providerManager.setAgentContextManager(this._agentContextManager);

    // Listen for lifecycle events and forward to all active panels
    this._lifecycleManager.onLifecycleEvent(event => {
      this._postToPanel(event.panelId, {
        type: 'lifecycleEvent',
        payload: event
      });

      // Clean up persistent processes when session expires or shuts down
      if (event.type === 'session-expired' || event.type === 'session-shutdown') {
        this._providerManager.disposePersistentProcess(event.panelId);
      }
    });

    // Register semi-autonomous timeout callback on permission manager
    this._permissionManager.onSemiAutonomousTimeout(
      (requestId, postToWebview) => this._handleSemiAutonomousPermissionTimeout(requestId, postToWebview)
    );

    // Plan 03 Phase 3a: when a background CLI discovery refresh completes,
    // push the updated provider availability to every open panel —
    // initialState may have been built from cached/incomplete statuses, so
    // the webview must treat provider badges as updatable after first paint.
    this._setupManager.onWizardStatusUpdated((status) => {
      this._broadcastToAll({
        type: 'providerAvailability',
        payload: { providerAvailability: this._buildProviderAvailability(status) }
      });
      // Plan 02 Phase 1: availability changes ride the same event — re-ship
      // the Provider Manifest so cached webviews stay in sync.
      this._broadcastManifestUpdated();
    });

    // Plan 02 Phase 1: re-broadcast the manifest when a setting backing a
    // declared provider settings section changes (endpoints, gateway URL,
    // Codex profile, Cursor API key).
    const manifestSettingIds = getManifestAffectingSettingKeys().map((key) => `mysti.${key}`);
    extensionContext.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (manifestSettingIds.some((id) => e.affectsConfiguration(id))) {
          this._broadcastManifestUpdated();
        }
      })
    );

    // Subscribe to ActiveModeManager events and broadcast to all panels
    this._activeModeManager.onStatusChanged(status => {
      this._broadcastToAll({
        type: 'activeModeStatus',
        payload: { installed: this._activeModeManager.isInstalled(), status }
      });
    });
    this._activeModeManager.onChannelChanged(channels => {
      this._broadcastToAll({ type: 'activeModeChannels', payload: channels });
    });
    this._activeModeManager.onActivity(entry => {
      this._broadcastToAll({ type: 'activeModeActivity', payload: entry });
    });

    // M6: Refresh workspace file cache on FS changes
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    fileWatcher.onDidCreate(() => this._refreshWorkspaceFileCacheDebounced());
    fileWatcher.onDidDelete(() => this._refreshWorkspaceFileCacheDebounced());
    extensionContext.subscriptions.push(fileWatcher);

    // Set up ChannelBridge delegate for inbound message routing
    this._channelBridge.setDelegate({
      hasPendingQuestion: (panelId: string) => this._pendingAskUserQuestions.has(panelId),
      getPendingQuestionToolCallId: (panelId: string) => {
        if (!this._pendingAskUserQuestions.has(panelId)) { return null; }
        for (const [toolCallId] of this._pendingQuestionData) {
          return toolCallId;
        }
        return null;
      },
      answerPendingQuestion: (panelId: string, toolCallId: string, answer: string) => {
        // Clear semi-autonomous timer if running
        const timer = this._semiAutoQuestionTimeouts.get(toolCallId);
        if (timer) {
          clearTimeout(timer);
          this._semiAutoQuestionTimeouts.delete(toolCallId);
        }
        const originalQuestion = this._pendingQuestionData.get(toolCallId);
        this._pendingQuestionData.delete(toolCallId);
        this._handleAskUserQuestionResponse(
          { toolCallId, answers: { '0': answer } },
          panelId,
          originalQuestion
        );
      },
      cancelPanelRequest: (panelId: string) => {
        this._cancelledPanels.add(panelId);
        this._providerManager.cancelRequest(panelId);
        this._brainstormManager.cancelSession(panelId);
        this._postToPanel(panelId, { type: 'requestCancelled' });
      },
      injectChannelMessage: (panelId: string, channelName: string, content: string, sender?: string) => {
        // Post inbound card to webview
        this._postToPanel(panelId, {
          type: 'channelAction',
          payload: { action: 'inbound', channel: channelName, sender, content: content.substring(0, 100) }
        });

        const senderLabel = sender ? ` from ${sender}` : '';
        const config = vscode.workspace.getConfiguration('mysti');
        const settings: Settings = {
          mode: config.get('defaultMode', 'ask-before-edit') as Settings['mode'],
          thinkingLevel: config.get('defaultThinkingLevel', 'none') as Settings['thinkingLevel'],
          accessLevel: config.get('accessLevel', 'ask-permission') as Settings['accessLevel'],
          contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
          model: this._getPanelModel(panelId),
          provider: this._getPanelProvider(panelId) as Settings['provider']
        };
        this._handleSendMessage(
          {
            content: `[Via ${channelName}${senderLabel}]: ${content}`,
            context: this._contextManager.getContext(panelId),
            settings
          },
          panelId
        );
      },
      isRunning: (panelId: string) => this._runningPanels.has(panelId),
      getActivePanelId: () => this._lastActivePanelId || this._sidebarId,
    });

    // Load agents asynchronously and track the promise
    this._agentInitPromise = this._initializeAgents();
  }

  /**
   * Initialize the agent system by loading all agent metadata
   */
  private async _initializeAgents(): Promise<void> {
    try {
      const { personas, skills } = await this._agentLoader.loadAllMetadata();
      this._agentsLoaded = true;

      // Detect custom (user/workspace) personas and skills for engagement badges
      const hasCustomPersona = personas.some(p => p.source === 'user' || p.source === 'workspace');
      const hasCustomSkill = skills.some(s => s.source === 'user' || s.source === 'workspace');
      if (hasCustomPersona) {
        this._engagementManager.trackCustomPersonaCreated();
      }
      if (hasCustomSkill) {
        this._engagementManager.trackCustomSkillCreated();
      }

      console.log('[Mysti] Agent system initialized');
    } catch (error) {
      console.error('[Mysti] Failed to initialize agent system:', error);
    }
  }

  /**
   * Get the effective provider for a panel (per-panel override or global default)
   */
  private _getPanelProvider(panelId: string): string {
    const panelState = this._panelStates.get(panelId);
    const provider = panelState?.settingsOverrides?.provider
      || vscode.workspace.getConfiguration('mysti').get<string>('defaultProvider', DEFAULT_PROVIDER);
    // Validate provider exists in registry; fall back to the default if stale/removed
    if (provider && this._providerManager.getProvider(provider)) {
      return provider;
    }
    console.warn(`[Mysti] Provider '${provider}' not found in registry, falling back to ${DEFAULT_PROVIDER}`);
    return DEFAULT_PROVIDER;
  }

  /**
   * Id of the provider that handles channel delegation, derived from
   * `capabilities.supportsChannels` (Plan 02 Phase 2, C4) — undefined when
   * no registered provider supports channels.
   */
  private _getChannelProviderId(): string | undefined {
    return this._providerManager.getAllProviders()
      .find(p => p.capabilities.supportsChannels)?.id;
  }

  /**
   * Get the effective model for a panel (per-panel override or global default)
   */
  private _getPanelModel(panelId: string): string {
    const panelState = this._panelStates.get(panelId);
    const config = vscode.workspace.getConfiguration('mysti');
    const model = panelState?.settingsOverrides?.model
      || config.get<string>('defaultModel', DEFAULT_FALLBACK_MODEL);
    // #39 precedence (Plan 01 §4): keep the user's model unless it is genuinely
    // unusable. Only fall back to the provider default when the model is neither
    // a known model for this provider, a user-declared custom model, nor even a
    // syntactically valid id. A valid hand-typed / custom / unlisted model is
    // KEPT (previously any non-built-in model was silently reset — issue #39).
    const provider = this._getPanelProvider(panelId);
    const providerConfig = this._providerManager.getProvider(provider);
    if (providerConfig) {
      if (this._providerManager.getModels(provider).some(m => m.id === model)) {
        return model;
      }
      const customModels = config.get<Record<string, string[]>>('customModels', {});
      if (Array.isArray(customModels?.[provider]) && customModels[provider].includes(model)) {
        return model;
      }
      if (validateModelName(model).valid) {
        console.warn(`[Mysti] Model '${model}' is not in '${provider}' built-in list but is valid — keeping it (custom/unlisted).`);
        return model;
      }
      console.warn(`[Mysti] Model '${model}' is invalid for provider '${provider}', using default '${providerConfig.defaultModel}'`);
      return providerConfig.defaultModel;
    }
    return model;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    // Perf: panel.timeToUsable (coarse, always-on) = resolveWebviewView entry
    // → webview posts `uiReady` (first rAF after its initial render).
    PerfTracker.mark(`panel.resolveStart.${this._sidebarId}`);
    this._pendingUiReadyPanels.add(this._sidebarId);

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    const version = this._extensionContext.extension.packageJSON.version || '0.0.0';
    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri, version);

    // Register sidebar in panel states
    const currentConversation = this._conversationManager.getCurrentConversation();
    this._panelStates.set(this._sidebarId, {
      id: this._sidebarId,
      webview: webviewView.webview,
      currentConversationId: currentConversation?.id || null,
      isSidebar: true
    });

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this._handleMessage(message);
    });

    // Send initial state with panelId
    this._sendInitialState(this._sidebarId);

    // Pre-spawn persistent process so first message is instant
    this._tryPreSpawnPersistentProcess(this._sidebarId);
  }

  private async _sendInitialState(panelId: string) {
    // Critical: Wait for agents to load before building initial state
    await this._agentInitPromise;

    // First-run stall fix: every discovery/network step on the way to the first
    // post is BOUNDED so the "Preparing your workspace" overlay can never get
    // stuck (it did on a cold cache because a CLI probe could hang with no
    // timeout; reopening was fast only because discovery was already cached).
    // On timeout we proceed with whatever the cache has — the
    // onWizardStatusUpdated subscription posts a provider-availability follow-up
    // once discovery settles. The GitHub star count is read from cache (never
    // awaited) and refreshed in the background.
    const activeProviderId = this._getPanelProvider(panelId);
    // Bound the active-provider refresh (cold cache → single CLI probe).
    await this._withTimeout(this._setupManager.ensureProviderStatusFresh(activeProviderId), 4000);

    let wizardStatus: WizardStatusResult = this._setupManager.getWizardStatusCached();

    // Cold-start wizard decision: show the wizard only if no provider is
    // installed. The cache can't prove this on first run, so confirm with a full
    // probe — but BOUND it. On timeout, fall through and build initialState; the
    // background availability refresh surfaces the wizard later if needed.
    const wizardDismissed = this._extensionContext.globalState.get('mysti.setupWizardDismissed', false);
    if (!wizardDismissed && !wizardStatus.anyReady) {
      const fullStatus = await this._withTimeout(this._setupManager.getWizardStatus(), 6000);
      if (fullStatus) {
        if (!fullStatus.anyReady) {
          // No providers installed — show the setup wizard. Include panelId so
          // wizard responses route to the right panel (B2).
          this._postToPanel(panelId, { type: 'showWizard', payload: { ...fullStatus, panelId } });
          return;
        }
        wizardStatus = fullStatus;
      }
      // fullStatus === null → the probe timed out; fall through to initialState.
    }

    const config = vscode.workspace.getConfiguration('mysti');

    // Get the configured provider — use per-panel override if set, else global config
    let selectedProvider: ProviderType = activeProviderId as ProviderType;
    const configuredProviderStatus = wizardStatus.providers.find(p => p.providerId === selectedProvider);

    if (!configuredProviderStatus?.installed) {
      // Current provider is not available, find first installed one
      const firstInstalled = wizardStatus.providers.find(p => p.installed);
      if (firstInstalled) {
        selectedProvider = firstInstalled.providerId as ProviderType;
        console.log(`[Mysti] Auto-selected provider: ${selectedProvider} (configured provider not available)`);
      }
    }

    const settings: Settings = {
      mode: config.get('defaultMode', 'ask-before-edit'),
      thinkingLevel: config.get('defaultThinkingLevel', 'none'),
      accessLevel: config.get('accessLevel', 'ask-permission'),
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: this._getPanelModel(panelId),
      provider: selectedProvider
    };

    // Read provider-specific custom model and profile settings.
    // Plan 02 Phase 1: key comes from the Provider Manifest module (single
    // source replacing the duplicated providerModelKeys maps, C1).
    const customModelKey = getCustomModelSettingKey(selectedProvider);
    const providerSettings = {
      customModel: customModelKey ? config.get<string>(customModelKey, '') : '',
      codexProfile: config.get<string>('codexProfile', '')
    };

    const permissionSettings = {
      timeoutBehavior: config.get<string>('permission.timeoutBehavior', 'auto-reject'),
      semiAutonomousTimeout: config.get<number>('semiAutonomous.timeout', SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S)
    };

    const panelState = this._panelStates.get(panelId);
    const conversation = panelState?.currentConversationId
      ? this._conversationManager.getConversation(panelState.currentConversationId)
      : this._conversationManager.getCurrentConversation();

    // Get workspace path for relative path display
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';

    // Get available agents from the dynamic loader if available, fall back to static
    const availablePersonas = this._agentsLoaded
      ? this._agentContextManager.getAllPersonas().map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          icon: p.icon || '👤',
          keyCharacteristics: '', // Loaded on demand via three-tier system
          category: p.category,
          source: p.source
        }))
      : Object.values(DEVELOPER_PERSONAS);

    const availableSkills = this._agentsLoaded
      ? this._agentContextManager.getAllSkills().map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          instructions: '', // Loaded on demand via three-tier system
          category: s.category,
          source: s.source
        }))
      : Object.values(DEVELOPER_SKILLS);

    // Get agent settings
    const agentConfig = vscode.workspace.getConfiguration('mysti');
    const agentSettings = {
      autoSuggest: this._agentsLoaded ? this._agentContextManager.isAutoSuggestEnabled() : false,
      maxTokenBudget: this._agentsLoaded ? this._agentContextManager.getTokenBudget() : 2000,
      showSuggestions: agentConfig.get<boolean>('showSuggestions', true)
    };

    // Get brainstorm agent configuration
    const mystiConfig = vscode.workspace.getConfiguration('mysti');
    const brainstormAgents = mystiConfig.get<string[]>('brainstorm.agents', ['claude-code', 'openai-codex']);
    const brainstormStrategy = mystiConfig.get<string>('brainstorm.strategy', 'quick');

    // Provider availability from the cached wizard statuses — no probing
    // here (Plan 03 Phase 3a). Statuses may still be incomplete at this
    // point; the background refresh posts a follow-up 'providerAvailability'
    // message once discovery settles.
    // Plan 01 Phase 1: source each provider's model list + default from the
    // registry's merged view (curated + discovered + custom) instead of the
    // raw bundled ProviderConfig, so custom models appear in the dropdown and
    // Phase 3 discovery flows through with no further wiring. Phase 1 output is
    // byte-identical when no cache/custom models exist.
    const providers = this._providerManager.getProviders().map(p => {
      const registryState = this._modelRegistry.getModels(p.name);
      return {
        ...p,
        models: registryState.models,
        defaultModel: registryState.defaultModel
      };
    });
    const providerAvailability = this._buildProviderAvailability(wizardStatus);

    this._postToPanel(panelId, {
      type: 'initialState',
      payload: {
        panelId,
        settings,
        context: this._contextManager.getContext(panelId),
        conversation,
        providers,
        providerAvailability,
        // Plan 02 Phase 1: capability manifest — the webview renders from
        // capabilities, never from provider-name literals (Phase 2 consumes).
        providerManifest: this._buildManifestPayload(),
        slashCommands: [], // Slash commands are now fetched on-demand via requestSlashCommands
        quickActions: this._getQuickActions(),
        workspacePath,
        agentConfig: conversation?.agentConfig,
        availablePersonas,
        availableSkills,
        agentSettings,
        brainstormAgents,
        brainstormStrategy,
        providerSettings,
        permissionSettings,
        githubStarCount: this._getCachedGithubStarCount(),
        usageStats: this._engagementManager.getUsageStats(),
        badges: this._engagementManager.getAllBadges(),
        badgeCounts: this._engagementManager.getUnlockedCount(),
        // Perf (Plan 03 Phase 1): enables the webview-side perf harness
        // (chunk ring buffer, heap sampling). Coarse marks (uiReady,
        // firstChunkRendered) are posted regardless of this flag.
        performanceLogging: config.get<boolean>('debug.performanceLogging', false)
      }
    });

    // Send active mode initial state (provider-independent)
    this._postToPanel(panelId, {
      type: 'activeModeStatus',
      payload: {
        installed: this._activeModeManager.isInstalled(),
        status: this._activeModeManager.getDaemonStatus()
      }
    });
    if (this._activeModeManager.isInstalled()) {
      this._postToPanel(panelId, {
        type: 'activeModeChannels',
        payload: this._activeModeManager.getChannels()
      });
    }

    // Warm the GitHub star cache in the background (never blocks the render —
    // the payload above used the cached value).
    void this._getGithubStarCount();
  }

  /**
   * Race a promise against a timeout. Resolves to the promise's value, or null
   * if it doesn't settle within `ms` (or rejects). Used to bound discovery
   * probes on the initial-render path so a hung CLI can't stall the webview.
   */
  private _withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
      p.catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  }

  /**
   * Synchronous, network-free read of the cached GitHub star count (or 0).
   * Used in the initial payload so the render never waits on the network;
   * `_getGithubStarCount()` is kicked in the background to warm the cache.
   */
  private _getCachedGithubStarCount(): number {
    const cached = this._extensionContext.globalState.get<{ count: number; fetchedAt: number }>('mysti.githubStarCount');
    return cached?.count ?? 0;
  }

  /**
   * Map wizard provider statuses to the webview's providerAvailability shape
   * (keyed by provider id; installCommand only when unavailable — matches
   * what initialState has always carried).
   */
  private _buildProviderAvailability(
    status: WizardStatusResult
  ): Record<string, { available: boolean; installCommand?: string }> {
    const availability: Record<string, { available: boolean; installCommand?: string }> = {};
    for (const provider of status.providers) {
      availability[provider.providerId] = {
        available: provider.installed,
        installCommand: provider.installed ? undefined : provider.installCommand
      };
    }
    return availability;
  }

  /**
   * Plan 02 Phase 1: build the Provider Manifest payload from the live
   * registry (capabilities + models + display metadata + settings sections).
   */
  private _buildManifestPayload(): ProviderManifestPayload {
    return buildProviderManifestPayload(this._providerManager.getRegistry());
  }

  /**
   * Plan 02 Phase 1: push a fresh manifest to every open panel — called on
   * provider availability changes and manifest-relevant setting changes.
   */
  private _broadcastManifestUpdated(): void {
    this._broadcastToAll({
      type: 'manifestUpdated',
      payload: this._buildManifestPayload()
    });
  }

  private async _handleMessage(message: WebviewMessage) {
    // Cast once: the webview always sends panelId alongside every message
    const msg = message as WebviewMessageWithPanel;
    // B2: a webview that never received initialState (e.g. the setup wizard
    // shown before any provider is ready) posts messages with panelId=null.
    // Default to the sidebar — the only panel that exists in that scenario —
    // so wizard responses are not routed to a non-existent panel and dropped.
    if (!msg.panelId) {
      msg.panelId = this._sidebarId;
    }
    switch (msg.type) {
      case 'sendMessage':
        await this._handleSendMessage(
          msg.payload as {
            content: string;
            context: ContextItem[];
            settings: Settings;
            mentions?: Mention[];
          },
          msg.panelId
        );
        break;

      case 'quickActionWithConfig':
        {
          const panelId = msg.panelId;
          const payload = msg.payload as {
            content: string;
            context: ContextItem[];
            settings: Settings;
            suggestedPersona: string | null;
            suggestedSkills: string[];
          };

          // Apply auto-selected persona and skills configuration
          if (panelId && (payload.suggestedPersona || payload.suggestedSkills?.length)) {
            const newConfig: AgentConfiguration = {
              personaId: (payload.suggestedPersona as AgentConfiguration['personaId']) || null,
              enabledSkills: (payload.suggestedSkills as AgentConfiguration['enabledSkills']) || []
            };

            // Save config to conversation
            this._conversationManager.updateAgentConfig(panelId, newConfig);

            // Notify webview to update UI
            this._postToPanel(panelId, {
              type: 'agentConfigUpdated',
              payload: newConfig
            });

            console.log('[Mysti] Quick action auto-configured persona:', payload.suggestedPersona, 'skills:', payload.suggestedSkills);
          }

          // Send the message as usual
          await this._handleSendMessage(
            {
              content: payload.content,
              context: payload.context,
              settings: payload.settings
            },
            panelId
          );
        }
        break;

      case 'cancelRequest':
        {
          const panelId = msg.panelId;
          if (panelId) {
            // Add to cancelled panels set for per-panel tracking
            this._cancelledPanels.add(panelId);
            // Cancel only this panel's request
            this._providerManager.cancelRequest(panelId);
            this._brainstormManager.cancelSession(panelId);
            // Cancel any running sub-agent processes from @-mentions
            // (C2: derive ids from the registry, never a hard-coded list)
            this._mentionRouter.cancelSubAgents(panelId, this._providerManager.getAllProviderIds());
            // Resolve any pending sub-agent questions with null (skip)
            this._cancelPendingSubAgentQuestions(panelId);
            // Notify webview to reset UI state
            this._postToPanel(panelId, { type: 'requestCancelled' });
          }
        }
        break;

      case 'retrySubAgent':
        {
          const retryPanelId = msg.panelId;
          const retryPayload = msg.payload as { agentId: AgentType };
          if (retryPanelId && retryPayload?.agentId) {
            const mentionCtx = this._lastMentionContext.get(retryPanelId);
            if (mentionCtx) {
              // Re-dispatch to just this single agent by creating a single-agent mention
              const singleMention = mentionCtx.mentions.find(m => m.value === retryPayload.agentId);
              if (singleMention) {
                const retryMentions = [singleMention];
                const retryConversation = (() => {
                  const ps = this._panelStates.get(retryPanelId);
                  const cId = ps?.currentConversationId;
                  return cId ? this._conversationManager.getConversation(cId) : null;
                })();

                // Reset the card UI
                this._postToPanel(retryPanelId, {
                  type: 'subAgentStarted',
                  payload: { agentId: retryPayload.agentId }
                });

                const retryStream = this._mentionRouter.processMentions(
                  mentionCtx.content, retryMentions, mentionCtx.context, mentionCtx.settings,
                  retryConversation, retryPanelId
                );

                for await (const chunk of retryStream) {
                  if (this._cancelledPanels.has(retryPanelId)) { break; }
                  switch (chunk.type) {
                    case 'subagent_text':
                      this._postToPanel(retryPanelId, {
                        type: 'subAgentChunk',
                        payload: { agentId: chunk.agentId, content: chunk.content, chunkType: 'text' }
                      });
                      break;
                    case 'subagent_thinking':
                      this._postToPanel(retryPanelId, {
                        type: 'subAgentChunk',
                        payload: { agentId: chunk.agentId, content: chunk.content, chunkType: 'thinking' }
                      });
                      break;
                    case 'subagent_tool_use':
                      // Permission gate for sub-agent write operations (retry path)
                      if (chunk.toolCall && this._shouldGateToolUse(mentionCtx.settings, chunk.toolCall.name)) {
                        const retryGateAction = this._classifyToolAction(chunk.toolCall.name);
                        if (retryGateAction !== 'file-read') {
                          const retryInputPreview = JSON.stringify(chunk.toolCall.input || {}, null, 2).slice(0, 500);
                          const retryRiskLevel = PermissionManager.classifyRisk(retryGateAction);
                          const retryApproved = await this.requestPermissionInline(
                            retryGateAction,
                            chunk.toolCall.name,
                            `${chunk.agentId || 'Sub-agent'} wants to: ${chunk.toolCall.name}`,
                            { command: retryInputPreview, riskLevel: retryRiskLevel },
                            retryPanelId,
                            chunk.toolCall.id
                          );
                          if (!retryApproved) {
                            this._providerManager.cancelRequest(retryPanelId);
                            break;
                          }
                        }
                      }
                      this._postToPanel(retryPanelId, {
                        type: 'subAgentToolUse',
                        payload: { agentId: chunk.agentId, toolCall: chunk.toolCall }
                      });
                      break;
                    case 'subagent_tool_result':
                      this._postToPanel(retryPanelId, {
                        type: 'subAgentToolResult',
                        payload: { agentId: chunk.agentId, toolCall: chunk.toolCall }
                      });
                      break;
                    case 'subagent_complete':
                      this._postToPanel(retryPanelId, {
                        type: 'subAgentComplete',
                        payload: { agentId: chunk.agentId, hasError: chunk.hasError }
                      });
                      break;
                    case 'subagent_error':
                      this._postToPanel(retryPanelId, {
                        type: 'subAgentError',
                        payload: { agentId: chunk.agentId, error: chunk.content }
                      });
                      break;
                    case 'subagent_retry':
                      this._postToPanel(retryPanelId, {
                        type: 'subAgentRetry',
                        payload: { agentId: chunk.agentId, retryCount: chunk.retryCount }
                      });
                      break;
                    // Skip intent_classified, files_resolved, main_start for retry
                  }
                }
              }
            }
          }
        }
        break;

      case 'sendBrainstormMessage':
        await this._handleBrainstormMessage(
          msg.payload as {
            content: string;
            context: ContextItem[];
            settings: Settings;
          },
          msg.panelId
        );
        break;

      case 'updateSettings':
        await this._handleUpdateSettings(msg.payload as Partial<Settings>, msg.panelId);
        break;

      case 'addToContext':
        await this._handleAddToContext(
          msg.payload as { path: string; type: string },
          msg.panelId
        );
        break;

      case 'requestFileAttachment':
        await this._handleRequestFileAttachment(msg.panelId);
        break;

      case 'removeFromContext':
        {
          const panelId = msg.panelId;
          this._contextManager.removeFromContext(msg.payload as string, panelId);
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'contextUpdated',
              payload: this._contextManager.getContext(panelId)
            });
          }
        }
        break;

      case 'clearContext':
        {
          const panelId = msg.panelId;
          this._contextManager.clearContext(panelId);
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'contextUpdated',
              payload: []
            });
          }
        }
        break;

      case 'requestSlashCommands': {
        const reqPayload = msg.payload as { query: string; panelId: string };
        const reqPanelId = reqPayload.panelId || msg.panelId;
        if (reqPanelId) {
          const callbacks = this._getSlashCommandCallbacks();
          const activeProvider = this._getPanelProvider(reqPanelId) as ProviderType;
          const menuData = this._slashCommandManager.getCommands(
            reqPanelId, activeProvider, callbacks, reqPayload.query
          );
          this._postToPanel(reqPanelId, {
            type: 'slashCommandMenu',
            payload: menuData
          });
        }
        break;
      }

      case 'executeSlashCommand':
        this._emitBadgeUnlocks(msg.panelId, this._engagementManager.trackSlashCommandUsed());
        await this._handleSlashCommand(
          msg.payload as { command?: string; commandId?: string; args?: string },
          msg.panelId
        );
        break;

      case 'openExternal': {
        const url = (msg.payload as { url: string })?.url;
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
          // Track engagement for specific external link types
          if (url.includes('github.com/DeepMyst/Mysti') && !url.includes('issues') && !url.includes('CHANGELOG')) {
            this._emitBadgeUnlocks(msg.panelId, this._engagementManager.trackStarClick());
          } else if (url.includes('marketplace.visualstudio.com') && url.includes('review')) {
            this._emitBadgeUnlocks(msg.panelId, this._engagementManager.trackReviewClick());
          } else if (url.includes('twitter.com') || url.includes('x.com')) {
            this._emitBadgeUnlocks(msg.panelId, this._engagementManager.trackShareClick());
          }
        }
        break;
      }

      case 'executeQuickAction':
        await this._handleQuickAction(msg.payload as string, msg.panelId);
        break;

      case 'executeSuggestion':
        await this._handleExecuteSuggestion(
          msg.payload as QuickActionSuggestion,
          msg.panelId
        );
        break;

      case 'enhancePrompt':
        await this._handleEnhancePrompt(msg.payload as string, msg.panelId);
        break;

      case 'newConversation':
        {
          const panelId = msg.panelId;
          const panelState = this._panelStates.get(panelId);

          // Cancel any running request on this panel before starting fresh
          this._cancelledPanels.add(panelId);
          this._providerManager.cancelRequest(panelId);
          this._brainstormManager.cancelSession(panelId);
          // C2: derive ids from the registry, never a hard-coded list
          this._mentionRouter.cancelSubAgents(panelId, this._providerManager.getAllProviderIds());
          this._cancelPendingSubAgentQuestions(panelId);

          this._providerManager.clearSession(panelId);  // Clear provider session for this panel
          this._compactionManager.resetUsage(panelId);  // Reset compaction tracking
          this._lifecycleManager.removeSession(panelId);  // Clear lifecycle tracking
          const newConv = this._conversationManager.createNewConversation();

          if (panelState) {
            panelState.currentConversationId = newConv.id;
          }

          // Track engagement: new conversation started
          this._emitBadgeUnlocks(panelId, this._engagementManager.trackConversationStarted());

          this._postToPanel(panelId, {
            type: 'conversationChanged',
            payload: newConv
          });
          this._postToPanel(panelId, {
            type: 'sessionCleared',
            payload: { message: 'Session cleared' }
          });
        }
        break;

      case 'clearSession':
        {
          const panelId = msg.panelId;
          if (panelId) {
            // Cancel any running request before clearing the session
            this._cancelledPanels.add(panelId);
            this._providerManager.cancelRequest(panelId);
            this._brainstormManager.cancelSession(panelId);
          }
          this._providerManager.clearSession(panelId);
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'sessionCleared',
              payload: { message: 'Session cleared' }
            });
          }
        }
        break;

      case 'shutdownAgent':
        {
          const panelId = msg.panelId;
          const force = (msg.payload as { force?: boolean } | undefined)?.force === true;
          const result = await this._lifecycleManager.requestShutdown(panelId, force);
          if (result.blocked) {
            this._postToPanel(panelId, {
              type: 'lifecycleEvent',
              payload: {
                type: 'shutdown-blocked',
                panelId,
                // C3: report the panel's actual provider, not a hard-coded id
                providerId: this._getPanelProvider(panelId),
                detail: result.reason,
                childPids: result.childPids,
              }
            });
          } else if (result.success) {
            this._providerManager.disposePersistentProcess(panelId);
            this._providerManager.clearSession(panelId);
            this._postToPanel(panelId, {
              type: 'sessionCleared',
              payload: { message: 'Agent session shut down' }
            });
          }
        }
        break;

      case 'manualCompact':
        this._handleManualCompact(msg.panelId);
        break;

      case 'requestPermission':
        await this._handlePermissionRequest(
          msg.payload as { action: string; details: string },
          msg.panelId
        );
        break;

      case 'permissionResponse':
        this._handlePermissionResponse(
          msg.payload as PermissionResponse
        );
        break;

      case 'permissionCustomInstruction':
        {
          const customText = (msg.payload as { text: string }).text;
          if (customText) {
            // The permission deny was already handled — now send the custom instruction as a new message
            const ciConfig = vscode.workspace.getConfiguration('mysti');
            const ciProvider = ciConfig.get<string>('defaultProvider', DEFAULT_PROVIDER) as Settings['provider'];
            const ciSettings: Settings = {
              mode: ciConfig.get('defaultMode', 'default') as Settings['mode'],
              thinkingLevel: ciConfig.get('defaultThinkingLevel', 'none') as Settings['thinkingLevel'],
              accessLevel: ciConfig.get('defaultAccessLevel', 'ask-permission') as Settings['accessLevel'],
              contextMode: ciConfig.get('autoContext', true) ? 'auto' : 'manual',
              model: this._getPanelModel(msg.panelId),
              provider: ciProvider
            };
            const ciContext = this._contextManager.getContext(msg.panelId);
            await this._handleSendMessage(
              { content: customText, context: ciContext, settings: ciSettings },
              msg.panelId
            );
          }
        }
        break;

      case 'planOptionSelected':
        // Clear suggestions before handling plan selection
        this._postToPanel(msg.panelId, { type: 'clearSuggestions' });

        await this._handlePlanOptionSelected(
          msg.payload as PlanSelectionResult,
          msg.panelId
        );
        break;

      case 'questionAnswered':
        // Clear suggestions before handling question answers
        this._postToPanel(msg.panelId, { type: 'clearSuggestions' });

        await this._handleQuestionAnswered(
          msg.payload as QuestionSubmission,
          msg.panelId
        );
        break;

      case 'openFile':
        await this._handleOpenFile(msg.payload as { path: string; line?: number });
        break;

      case 'applyEdit':
        await this._handleApplyEdit(
          msg.payload as {
            path: string;
            content: string;
            startLine?: number;
            endLine?: number;
          },
          msg.panelId
        );
        break;

      case 'getWorkspaceFiles':
        await this._handleGetWorkspaceFiles(msg.panelId);
        break;

      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(msg.payload as string);
        break;

      case 'revertFileEdit':
        await this._handleRevertFileEdit(
          msg.payload as { path: string },
          msg.panelId
        );
        break;

      case 'getFileLineNumber':
        {
          // Support both msg.payload and direct properties on message
          const fileLinePayload = (msg.payload || msg) as { filePath: string; searchText: string };
          await this._handleGetFileLineNumber(
            {
              filePath: fileLinePayload.filePath,
              searchText: fileLinePayload.searchText
            },
            msg.panelId
          );
        }
        break;

      case 'openInNewTab':
        vscode.commands.executeCommand('mysti.openInNewTab');
        break;

      case 'openConnections':
        vscode.commands.executeCommand('mysti.openConnections');
        break;

      case 'connectService':
        await this._handleConnectService((msg as { service?: string }).service);
        break;

      case 'checkSetup':
        await this._handleCheckSetup(msg.panelId);
        break;

      case 'retrySetup':
        await this._handleRetrySetup(
          (msg.payload as { providerId: string }).providerId,
          msg.panelId
        );
        break;

      case 'authConfirm':
        await this._handleAuthConfirm(
          (msg.payload as { providerId: string }).providerId,
          msg.panelId
        );
        break;

      case 'authSkip':
        await this._handleAuthSkip(
          (msg.payload as { providerId: string }).providerId,
          msg.panelId
        );
        break;

      case 'skipSetup':
        this._handleSkipSetup(msg.panelId);
        break;

      case 'requestWizardStatus':
        await this._handleRequestWizardStatus(msg.panelId);
        break;

      case 'startProviderSetup':
        await this._handleStartProviderSetup(
          msg.payload as { providerId: string; autoInstall?: boolean },
          msg.panelId
        );
        break;

      case 'selectAuthMethod':
        await this._handleSelectAuthMethod(
          msg.payload as { providerId: string; method: string; apiKey?: string },
          msg.panelId
        );
        break;

      case 'selectProvider':
        await this._handleSelectProvider(
          (msg.payload as { providerId: string }).providerId,
          msg.panelId
        );
        break;

      case 'dismissWizard':
        this._handleDismissWizard(
          msg.panelId,
          (msg.payload as { dontShowAgain?: boolean } | undefined)?.dontShowAgain
        );
        break;

      case 'refreshProviderDetection':
        await this._handleRefreshProviderDetection(msg.panelId);
        break;

      case 'runDiagnostics':
        await this._handleRunDiagnostics(msg.panelId);
        break;

      case 'openTerminal':
        {
          // Handle both object payload (providerId + command) and string payload (auth command)
          const terminalPayload = msg.payload;
          if (typeof terminalPayload === 'string') {
            const terminal = vscode.window.createTerminal('Authenticate Provider');
            terminal.show();
            terminal.sendText(terminalPayload);
          } else {
            this._handleOpenTerminal(
              terminalPayload as { providerId: string; command: string }
            );
          }
        }
        break;

      case 'requestProviderInstallInfo':
        await this._handleRequestProviderInstallInfo(
          msg.payload as { providerId: string },
          msg.panelId
        );
        break;

      case 'getConversationHistory':
        {
          const panelId = msg.panelId;
          const panelState = this._panelStates.get(panelId);
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'conversationHistory',
              payload: {
                conversations: this._conversationManager.getAllConversations(),
                currentId: panelState?.currentConversationId
              }
            });
          }
        }
        break;

      case 'switchConversation':
        {
          const panelId = msg.panelId;
          const switchId = (msg.payload as { id: string }).id;
          const panelState = this._panelStates.get(panelId);

          if (panelState) {
            // Update only this panel's conversation
            panelState.currentConversationId = switchId;
            const conversation = this._conversationManager.getConversation(switchId);
            if (conversation) {
              this._postToPanel(panelId, {
                type: 'conversationChanged',
                payload: conversation
              });
            }
          }
        }
        break;

      case 'updateAgentConfig':
        {
          const panelId = msg.panelId;
          const config = msg.payload as AgentConfiguration;
          const panelState = this._panelStates.get(panelId);

          if (panelState?.currentConversationId) {
            this._conversationManager.updateAgentConfig(
              panelState.currentConversationId,
              config
            );
            this._postToPanel(panelId, {
              type: 'agentConfigUpdated',
              payload: config
            });

            // Track engagement: persona and skill selections
            if (config.personaId) {
              this._emitBadgeUnlocks(panelId, this._engagementManager.trackPersonaSelected(config.personaId));
            }
            if (config.enabledSkills?.length) {
              for (const skillId of config.enabledSkills) {
                this._emitBadgeUnlocks(panelId, this._engagementManager.trackSkillActivated(skillId));
              }
            }
          }
        }
        break;

      case 'deleteConversation':
        {
          const panelId = msg.panelId;
          const deleteId = (msg.payload as { id: string }).id;
          const panelState = this._panelStates.get(panelId);

          this._conversationManager.deleteConversation(deleteId);

          // If this panel was viewing the deleted conversation, create a new one
          if (panelState?.currentConversationId === deleteId) {
            const newConv = this._conversationManager.createNewConversation();
            panelState.currentConversationId = newConv.id;
            this._postToPanel(panelId, {
              type: 'conversationChanged',
              payload: newConv
            });
          }

          // Refresh history for the requesting panel
          this._postToPanel(panelId, {
            type: 'conversationHistory',
            payload: {
              conversations: this._conversationManager.getAllConversations(),
              currentId: panelState?.currentConversationId
            }
          });
        }
        break;

      case 'getAgentRecommendations':
        {
          const panelId = msg.panelId;
          const query = (msg.payload as { query: string }).query;

          // Only provide recommendations if auto-suggest is enabled in settings
          if (this._agentsLoaded && this._agentContextManager.isAutoSuggestEnabled()) {
            const recommendations = this._agentContextManager.getRecommendations(query, 5);
            this._postToPanel(panelId, {
              type: 'agentRecommendations',
              payload: {
                recommendations: recommendations.map(r => ({
                  agent: {
                    id: r.agent.id,
                    name: r.agent.name,
                    description: r.agent.description,
                    icon: r.agent.icon,
                    category: r.agent.category,
                    source: r.agent.source,
                    activationTriggers: r.agent.activationTriggers
                  },
                  type: r.type,
                  confidence: r.confidence,
                  matchedTriggers: r.matchedTriggers,
                  reason: r.reason
                })),
                query
              }
            });
          }
        }
        break;

      case 'getAgentDetails':
        {
          const panelId = msg.panelId;
          const agentId = (msg.payload as { agentId: string }).agentId;

          if (this._agentsLoaded) {
            const details = await this._agentContextManager.getAgentDetails(agentId);
            if (details) {
              this._postToPanel(panelId, {
                type: 'agentDetails',
                payload: {
                  agentId: details.id,
                  name: details.name,
                  description: details.description,
                  instructions: details.instructions,
                  bestPractices: details.bestPractices,
                  antiPatterns: details.antiPatterns,
                  codeExamples: details.codeExamples
                }
              });
            }
          }
        }
        break;

      case 'askUserQuestionResponse':
        {
          const aqPayload = msg.payload as { toolCallId: string; answers: Record<string, string | string[]> };

          // Cancel semi-autonomous timer if running (user answered in time)
          const semiAutoTimeout = this._semiAutoQuestionTimeouts.get(aqPayload.toolCallId);
          if (semiAutoTimeout) {
            clearTimeout(semiAutoTimeout);
            this._semiAutoQuestionTimeouts.delete(aqPayload.toolCallId);
          }

          const originalQuestion = this._pendingQuestionData.get(aqPayload.toolCallId);
          this._pendingQuestionData.delete(aqPayload.toolCallId);
          await this._handleAskUserQuestionResponse(
            aqPayload,
            msg.panelId,
            originalQuestion
          );
        }
        break;

      case 'askUserQuestionSkipped':
        {
          const skipPayload = msg.payload as { toolCallId: string };
          const skipPanelId = msg.panelId;
          const skipTimer = this._semiAutoQuestionTimeouts.get(skipPayload.toolCallId);
          if (skipTimer) {
            clearTimeout(skipTimer);
            this._semiAutoQuestionTimeouts.delete(skipPayload.toolCallId);
          }
          const skippedQuestion = this._pendingQuestionData.get(skipPayload.toolCallId);
          this._pendingQuestionData.delete(skipPayload.toolCallId);
          this._pendingAskUserQuestions.delete(skipPanelId);

          // Send a decline response so the CLI process doesn't hang waiting for input
          if (skippedQuestion) {
            await this._handleAskUserQuestionResponse(
              { toolCallId: skipPayload.toolCallId, answers: { '0': 'User declined to answer this question. Please continue without this information or make a reasonable assumption.' } },
              skipPanelId,
              skippedQuestion
            );
          }
        }
        break;

      case 'subAgentQuestionResponse':
        {
          const saqPayload = msg.payload as { toolCallId: string; agentId: string; answers: Record<string, string | string[]> };
          const saqKey = `${msg.panelId}-${saqPayload.toolCallId}`;
          const pendingSaq = this._pendingSubAgentQuestions.get(saqKey);
          if (pendingSaq) {
            pendingSaq.resolve({ answers: saqPayload.answers });
            this._pendingSubAgentQuestions.delete(saqKey);
          }
        }
        break;

      case 'subAgentQuestionSkipped':
        {
          const saqSkipPayload = msg.payload as { toolCallId: string; agentId: string };
          const saqSkipKey = `${msg.panelId}-${saqSkipPayload.toolCallId}`;
          const pendingSaqSkip = this._pendingSubAgentQuestions.get(saqSkipKey);
          if (pendingSaqSkip) {
            pendingSaqSkip.resolve(null);
            this._pendingSubAgentQuestions.delete(saqSkipKey);
          }
        }
        break;

      case 'planOptionsSkipped':
        {
          const skipPlanPayload = msg.payload as { syntheticPlanId: string };
          const skipPlanPanelId = msg.panelId;
          const planTimer = this._semiAutoPlanTimeouts.get(skipPlanPayload.syntheticPlanId);
          if (planTimer) {
            clearTimeout(planTimer);
            this._semiAutoPlanTimeouts.delete(skipPlanPayload.syntheticPlanId);
          }
          this._pendingPlanData.delete(skipPlanPayload.syntheticPlanId);
          this._pendingPlanSelections.delete(skipPlanPanelId);
        }
        break;

      // ---- Autonomous Mode Messages ----

      case 'toggleAutonomous':
        await this._handleToggleAutonomous(msg.panelId);
        break;

      case 'confirmAutonomousActivation':
        await this._handleConfirmAutonomous(
          msg.payload as { goal?: string; tasks?: string[] },
          msg.panelId
        );
        break;

      case 'cancelAutonomousActivation':
        this._postToPanel(msg.panelId, {
          type: 'autonomousDeactivated',
          payload: null
        });
        break;

      case 'deactivateAutonomous':
        {
          const stats = this._autonomousManager.deactivate();
          this._postToPanel(msg.panelId, {
            type: 'autonomousDeactivated',
            payload: stats
          });
        }
        break;

      case 'autonomyLevelChanged':
        {
          const levelPayload = msg.payload as { level: string };
          const lvlPanelId = msg.panelId;
          this._panelAutonomyLevel.set(lvlPanelId, levelPayload.level);
          console.log(`[Mysti] Autonomy level changed for panel ${lvlPanelId}: ${levelPayload.level}`);
        }
        break;

      case 'getAuditLog':
        this._postToPanel(msg.panelId, {
          type: 'auditLog',
          payload: this._autonomousManager.getAuditLog()
        });
        break;

      case 'getAutonomousStats':
        this._postToPanel(msg.panelId, {
          type: 'autonomousStats',
          payload: this._autonomousManager.getSessionStats()
        });
        break;

      // --- Active Mode (provider-independent OpenClaw daemon) ---

      case 'connectChannel':
        {
          const { channelType } = msg.payload as { channelType: string };
          // Open a terminal so the user can run the interactive OpenClaw channel setup
          const terminal = vscode.window.createTerminal({
            name: `OpenClaw: ${channelType}`,
            shellPath: process.env.SHELL || '/bin/zsh',
          });
          terminal.show();
          terminal.sendText(`openclaw configure --section channels`);
        }
        break;

      case 'disconnectChannel':
        {
          const { channelId } = msg.payload as { channelId: string };
          await this._activeModeManager.disconnectChannel(channelId);
        }
        break;

      case 'toggleIntegration':
        {
          const { enabled } = msg.payload as { enabled: boolean };
          this._activeModeManager.setIntegrationEnabled(enabled);
        }
        break;

      case 'refreshActiveMode':
        await this._activeModeManager.refreshStatus();
        this._postToPanel(msg.panelId, {
          type: 'activeModeStatus',
          payload: {
            installed: this._activeModeManager.isInstalled(),
            status: this._activeModeManager.getDaemonStatus()
          }
        });
        this._postToPanel(msg.panelId, {
          type: 'activeModeChannels',
          payload: this._activeModeManager.getChannels()
        });
        break;

      case 'startDaemon':
        {
          const started = await this._activeModeManager.startDaemon();
          this._postToPanel(msg.panelId, {
            type: 'daemonStartResult',
            payload: { success: started }
          });
        }
        break;

      // ---- Engagement & Badge Messages ----

      case 'requestBadges':
        this._postToPanel(msg.panelId, {
          type: 'badgesUpdate',
          payload: {
            badges: this._engagementManager.getAllBadges(),
            counts: this._engagementManager.getUnlockedCount(),
            stats: this._engagementManager.getUsageStats()
          }
        });
        break;

      case 'getBadgeShareText':
        {
          const badgeId = (msg.payload as { badgeId: string })?.badgeId;
          const shareText = this._engagementManager.getBadgeShareText(badgeId);
          if (shareText) {
            await vscode.env.clipboard.writeText(shareText);
            this._postToPanel(msg.panelId, {
              type: 'badgeShareCopied',
              payload: { badgeId, shareText }
            });
          }
        }
        break;

      // ---- Conversation Export Messages ----

      case 'exportConversation':
        {
          const exportPanelId = msg.panelId;
          const panelState = this._panelStates.get(exportPanelId);
          const conversationId = panelState?.currentConversationId;
          if (conversationId) {
            const markdown = this._conversationManager.exportToMarkdown(conversationId);
            if (markdown) {
              await vscode.env.clipboard.writeText(markdown);
              this._postToPanel(exportPanelId, {
                type: 'exportResult',
                payload: { success: true, markdown }
              });
              // Track export for engagement badges
              const exportBadges = this._engagementManager.trackExport();
              this._emitBadgeUnlocks(exportPanelId, exportBadges);
              console.log('[Mysti] Conversation exported to clipboard');
            } else {
              this._postToPanel(exportPanelId, {
                type: 'exportResult',
                payload: { success: false, error: 'Conversation not found' }
              });
            }
          }
        }
        break;

      case 'copyMessageMarkdown':
        {
          const copyMsgPanelId = msg.panelId;
          const copyPayload = msg.payload as { messageId: string };
          const copyPanelState = this._panelStates.get(copyMsgPanelId);
          const copyConvId = copyPanelState?.currentConversationId;
          if (copyConvId && copyPayload?.messageId) {
            const markdown = this._conversationManager.exportMessageToMarkdown(
              copyConvId,
              copyPayload.messageId
            );
            if (markdown) {
              await vscode.env.clipboard.writeText(markdown);
              this._postToPanel(copyMsgPanelId, {
                type: 'exportResult',
                payload: { success: true, markdown }
              });
              console.log('[Mysti] Message exported to clipboard');
            } else {
              this._postToPanel(copyMsgPanelId, {
                type: 'exportResult',
                payload: { success: false, error: 'Message not found' }
              });
            }
          }
        }
        break;

      // ---- File Import/Export Messages ----

      case 'exportToFile':
        {
          const expPanelId = msg.panelId;
          const expFormat = (msg.payload as { format: string })?.format || 'json';
          const expPanelState = this._panelStates.get(expPanelId);
          const expConvId = expPanelState?.currentConversationId;
          if (expConvId) {
            const isMarkdown = expFormat === 'markdown';
            const content = isMarkdown
              ? this._conversationManager.exportToMarkdown(expConvId)
              : this._conversationManager.exportToJson(expConvId);
            if (content) {
              const uri = await vscode.window.showSaveDialog({
                filters: isMarkdown
                  ? { 'Markdown': ['md'] }
                  : { 'Mysti JSON': ['mysti.json'], 'JSON': ['json'] },
                defaultUri: vscode.Uri.file(`conversation.${isMarkdown ? 'md' : 'mysti.json'}`)
              });
              if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
                this._emitBadgeUnlocks(expPanelId, this._engagementManager.trackExport());
                this._postToPanel(expPanelId, {
                  type: 'exportResult',
                  payload: { success: true }
                });
                console.log(`[Mysti] Conversation exported to file: ${uri.fsPath}`);
              }
            }
          }
        }
        break;

      case 'importFromFile':
        {
          const impPanelId = msg.panelId;
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: {
              'Conversation Files': ['mysti.json', 'json', 'jsonl', 'md']
            }
          });
          if (uris && uris.length > 0) {
            const fileContent = await vscode.workspace.fs.readFile(uris[0]);
            const text = Buffer.from(fileContent).toString('utf-8');
            const fileName = uris[0].fsPath;
            const imported = this._conversationManager.importFromContent(text, fileName);
            if (imported) {
              const impPanelState = this._panelStates.get(impPanelId);
              if (impPanelState) {
                impPanelState.currentConversationId = imported.id;
              }
              this._postToPanel(impPanelId, {
                type: 'conversationChanged',
                payload: imported
              });
              console.log(`[Mysti] Conversation imported from: ${fileName}`);
            } else {
              vscode.window.showErrorMessage('Failed to import conversation: unrecognized format');
            }
          }
        }
        break;

      case 'triggerShareLink':
        {
          const sharePanelId = msg.panelId;
          const sharePanelState = this._panelStates.get(sharePanelId);
          const shareConvId = sharePanelState?.currentConversationId;
          if (shareConvId) {
            const data = this._conversationManager.exportToShareable(shareConvId);
            if (data) {
              const uri = `vscode://DeepMyst.mysti/import?data=${data}`;
              if (uri.length > 2000) {
                // Too long for a URI — fall back to clipboard with JSON
                const json = this._conversationManager.exportToJson(shareConvId);
                await vscode.env.clipboard.writeText(json);
                vscode.window.showInformationMessage('Conversation too long for a deep link — full JSON copied to clipboard instead.');
              } else {
                await vscode.env.clipboard.writeText(uri);
                vscode.window.showInformationMessage('Share link copied to clipboard!');
              }
              this._emitBadgeUnlocks(sharePanelId, this._engagementManager.trackConversationShared());
              console.log('[Mysti] Share link generated');
            }
          }
        }
        break;

      case 'triggerInitTeam':
        {
          await this._initTeamWorkspace(msg.panelId);
        }
        break;

      case 'triggerOpenMemory':
        {
          await this._openProjectMemory();
        }
        break;

      case 'triggerOpenRules':
        {
          await this._openProjectRules();
        }
        break;

      case 'startVisualTest':
        {
          // Open the visual test dashboard (separate editor tab)
          const panelId = msg.panelId;
          const payload = msg.payload as {
            config: VisualTestConfig;
            settings: Settings;
          };
          if (panelId && payload?.config) {
            this.openVisualTestDashboard(payload.config, panelId);
          }
        }
        break;

      case 'openVisualTestDashboard':
        {
          const panelId = msg.panelId;
          this.openVisualTestDashboard(undefined, panelId);
        }
        break;

      case 'openCanvas':
        {
          const panelId = msg.panelId;
          this.openCanvas(undefined, panelId);
        }
        break;

      case 'cancelVisualTest':
        {
          const panelId = msg.panelId;
          if (panelId) {
            this._visualTestManager.cancelTest(panelId);
          }
          // Also cancel via dashboard if running
          if (this._vtDashboardPanelId) {
            this._visualTestManager.cancelTest(this._vtDashboardPanelId);
            this._postToPanel(this._vtDashboardPanelId, { type: 'visualTestDashboardCancelled' } as any);
          }
        }
        break;

      case 'getVisualTestReport':
        {
          const panelId = msg.panelId;
          if (panelId) {
            const report = this._visualTestManager.getReport(panelId);
            this._postToPanel(panelId, {
              type: 'visualTestReport',
              payload: report
            });
          }
        }
        break;

      case 'stopVisualTestServer':
        {
          const panelId = msg.panelId;
          if (panelId) {
            await this._visualTestManager.stopDevServer(panelId);
            this._postToPanel(panelId, {
              type: 'visualTestServerStopped',
              payload: {}
            });
          }
        }
        break;

      // === Perf instrumentation (Plan 03 Phase 1) ===

      case 'uiReady':
        // Posted unconditionally by the webview after its initial render's
        // rAF. Completes the coarse panel.timeToUsable measure started at
        // resolveWebviewView entry. The pending-set guard ignores stale or
        // duplicate uiReady posts (and panels we never marked, e.g. tabs).
        if (this._pendingUiReadyPanels.delete(msg.panelId)) {
          PerfTracker.measure('panel.timeToUsable', `panel.resolveStart.${msg.panelId}`);
        }
        break;

      case 'perfMark':
        {
          // {type:'perfMark', name:'firstChunkRendered', sentAt} — posted by
          // the webview inside the rAF after the first text chunk painted.
          // Recording via measure() against the mark set when perfSentAt was
          // attached yields the same quantity as Date.now() - sentAt (both
          // ends captured at the same instants), on the monotonic clock.
          const pm = msg as unknown as { name?: string; sentAt?: number; panelId: string };
          if (pm.name === 'firstChunkRendered') {
            PerfTracker.measure('send.ttftRender', `send.firstChunkSent.${msg.panelId}`);
          }
        }
        break;

      case 'perfReport':
        {
          // Webview perf harness reports: heap-only samples (reason:'heap',
          // at init/60s) and per-response summaries on done (chunkCount/p50/
          // p95/max/heapUsed). Only sent when performanceLogging is enabled.
          const pr = msg as unknown as {
            reason?: string;
            chunkCount?: number;
            p50?: number;
            p95?: number;
            max?: number;
            heapUsed?: number;
            panelId: string;
          };
          if (typeof pr.heapUsed === 'number' && isFinite(pr.heapUsed)) {
            PerfTracker.sample('heap.webview', pr.heapUsed);
          }
          if (pr.reason !== 'heap') {
            console.log(
              `[Mysti][perf] webview report (${msg.panelId}): ` +
              `chunks=${pr.chunkCount ?? 0} ` +
              `p50=${typeof pr.p50 === 'number' ? pr.p50.toFixed(1) : 'n/a'}ms ` +
              `p95=${typeof pr.p95 === 'number' ? pr.p95.toFixed(1) : 'n/a'}ms ` +
              `max=${typeof pr.max === 'number' ? pr.max.toFixed(1) : 'n/a'}ms ` +
              `heapUsed=${typeof pr.heapUsed === 'number' ? pr.heapUsed : 'n/a'}`
            );
            if (typeof pr.p95 === 'number' && isFinite(pr.p95)) {
              PerfTracker.sample('render.chunk.p95', pr.p95);
            }
            // Forward coarse aggregate numbers through the existing
            // telemetry opt-in gate (trackPerf drops absent/non-finite).
            const perfSnapshot = PerfTracker.report();
            this._telemetryManager.trackPerf({
              activationMs: perfSnapshot.measures['activation.total'],
              ttftMs: perfSnapshot.measures['send.ttftRender'],
              chunkP95: pr.p95,
              panelUsableMs: perfSnapshot.measures['panel.timeToUsable']
            });
          }
        }
        break;
    }
  }

  /**
   * Scaffold .mysti/ team workspace config directory.
   * Scans workspace to generate real mysti.md content (like Claude Code's /init).
   */
  private async _initTeamWorkspace(_panelId: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('No workspace folder open. Open a project first.');
      return;
    }

    const rootUri = workspaceFolders[0].uri;
    const projectName = workspaceFolders[0].name;
    const mystiDir = vscode.Uri.joinPath(rootUri, '.mysti');
    const teamJson = vscode.Uri.joinPath(mystiDir, 'team.json');
    const personasDir = vscode.Uri.joinPath(mystiDir, 'agents', 'personas');
    const skillsDir = vscode.Uri.joinPath(mystiDir, 'agents', 'skills');
    const promptsDir = vscode.Uri.joinPath(mystiDir, 'prompts');
    const rulesDir = vscode.Uri.joinPath(mystiDir, 'rules');

    // Create directories (including new rules/ directory)
    await vscode.workspace.fs.createDirectory(personasDir);
    await vscode.workspace.fs.createDirectory(skillsDir);
    await vscode.workspace.fs.createDirectory(promptsDir);
    await vscode.workspace.fs.createDirectory(rulesDir);

    // Create team.json if it doesn't exist
    try {
      await vscode.workspace.fs.stat(teamJson);
      console.log('[Mysti] team.json already exists, skipping');
    } catch {
      const config = vscode.workspace.getConfiguration('mysti');
      const provider = config.get<string>('defaultProvider', DEFAULT_PROVIDER);
      const version = this._extensionContext.extension.packageJSON.version || '0.0.0';
      const teamData = {
        teamName: projectName,
        defaultProvider: provider,
        version,
        setupUrl: 'https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti'
      };
      await vscode.workspace.fs.writeFile(teamJson, Buffer.from(JSON.stringify(teamData, null, 2), 'utf-8'));
    }

    // Create mysti.md with real project data from workspace scan (like Claude Code's /init)
    const mystiMd = vscode.Uri.joinPath(rootUri, 'mysti.md');
    try {
      await vscode.workspace.fs.stat(mystiMd);
      console.log('[Mysti] mysti.md already exists, skipping');
    } catch {
      const scan = await this._projectContextManager.scanWorkspace();
      const content = this._projectContextManager.generateMystiMdContent(projectName, scan);
      await vscode.workspace.fs.writeFile(mystiMd, Buffer.from(content, 'utf-8'));
    }

    // Create default rules file if rules/ directory is empty
    const defaultRules = vscode.Uri.joinPath(rulesDir, 'general.md');
    try {
      await vscode.workspace.fs.stat(defaultRules);
    } catch {
      const rulesContent = [
        '# Project Rules',
        '',
        '<!-- Rules Mysti should always follow in this project -->',
        '<!-- Example: "Always use TypeScript strict mode" -->',
        '<!-- Example: "Never modify files in vendor/" -->',
        '',
        '<!-- For path-specific rules, add YAML frontmatter: -->',
        '<!-- --- -->',
        '<!-- paths: -->',
        '<!--   - "src/api/**" -->',
        '<!-- --- -->',
        '',
      ].join('\n');
      await vscode.workspace.fs.writeFile(defaultRules, Buffer.from(rulesContent, 'utf-8'));
    }

    // Also add to workspace recommendations
    const extJsonUri = vscode.Uri.joinPath(rootUri, '.vscode', 'extensions.json');
    try {
      const existing = await vscode.workspace.fs.readFile(extJsonUri);
      const parsed = JSON.parse(Buffer.from(existing).toString('utf-8'));
      if (!parsed.recommendations?.includes('DeepMyst.mysti')) {
        parsed.recommendations = parsed.recommendations || [];
        parsed.recommendations.push('DeepMyst.mysti');
        await vscode.workspace.fs.writeFile(extJsonUri, Buffer.from(JSON.stringify(parsed, null, 2), 'utf-8'));
      }
    } catch {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(rootUri, '.vscode'));
      const newExtJson = { recommendations: ['DeepMyst.mysti'] };
      await vscode.workspace.fs.writeFile(extJsonUri, Buffer.from(JSON.stringify(newExtJson, null, 2), 'utf-8'));
    }

    // Reload project context to pick up the new mysti.md and rules
    await this._projectContextManager.reload();

    // Initialize per-project auto-memory
    this._memoryManager.initProjectMemory(workspaceFolders[0].uri.fsPath);

    this._emitBadgeUnlocks(_panelId, this._engagementManager.trackWorkspaceRecommendation());
    this._emitBadgeUnlocks(_panelId, this._engagementManager.trackTeamInitialized());
    vscode.window.showInformationMessage(
      'Project configured for Mysti. Created .mysti/, mysti.md, and rules/ — commit these so collaborators can discover Mysti.'
    );
    console.log('[Mysti] Team workspace initialized with mysti.md + rules');
  }

  /**
   * Open the project's MEMORY.md file in the editor.
   * Creates the file with a default template if it doesn't exist.
   */
  private async _openProjectMemory(): Promise<void> {
    const memoryPath = this._memoryManager.getProjectMemoryPath();
    if (!memoryPath) {
      // Initialize project memory if not yet done
      if (vscode.workspace.workspaceFolders?.length) {
        this._memoryManager.initProjectMemory(vscode.workspace.workspaceFolders[0].uri.fsPath);
      }
      const retryPath = this._memoryManager.getProjectMemoryPath();
      if (!retryPath) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      // Create default MEMORY.md
      this._memoryManager.writeProjectMemory('# Mysti Project Memory\n\n<!-- Mysti writes learnings here as it works on your project -->\n');
      const doc = await vscode.workspace.openTextDocument(retryPath);
      await vscode.window.showTextDocument(doc);
      return;
    }

    // Create if it doesn't exist
    const fsPath = vscode.Uri.file(memoryPath);
    try {
      await vscode.workspace.fs.stat(fsPath);
    } catch {
      this._memoryManager.writeProjectMemory('# Mysti Project Memory\n\n<!-- Mysti writes learnings here as it works on your project -->\n');
    }

    const doc = await vscode.workspace.openTextDocument(memoryPath);
    await vscode.window.showTextDocument(doc);
  }

  /**
   * Open the .mysti/rules/ directory or the first rule file in the editor.
   * Creates a template rule file if the directory is empty.
   */
  private async _openProjectRules(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('No workspace folder open.');
      return;
    }

    const rootUri = workspaceFolders[0].uri;
    const rulesDir = vscode.Uri.joinPath(rootUri, '.mysti', 'rules');
    const defaultRulesFile = vscode.Uri.joinPath(rulesDir, 'general.md');

    // Create directory and template if they don't exist
    try {
      await vscode.workspace.fs.stat(rulesDir);
    } catch {
      await vscode.workspace.fs.createDirectory(rulesDir);
    }

    try {
      await vscode.workspace.fs.stat(defaultRulesFile);
    } catch {
      const template = [
        '# Project Rules',
        '',
        '<!-- Rules Mysti should always follow in this project -->',
        '<!-- Example: "Always use TypeScript strict mode" -->',
        '<!-- Example: "Never modify files in vendor/" -->',
        '',
      ].join('\n');
      await vscode.workspace.fs.writeFile(defaultRulesFile, Buffer.from(template, 'utf-8'));
    }

    const doc = await vscode.workspace.openTextDocument(defaultRulesFile.fsPath);
    await vscode.window.showTextDocument(doc);
  }

  /**
   * Track tool_use events for auto-memory learning.
   * Categorizes file reads/writes by directory to learn project structure.
   */
  private _trackToolUseForMemory(panelId: string, toolName: string, toolInput: Record<string, unknown>): void {
    const name = toolName.toLowerCase();
    const filePath = (toolInput.file_path || toolInput.path || toolInput.filePath) as string | undefined;

    if (!filePath) { return; }

    if (name.includes('read') || name.includes('view') || name === 'cat') {
      if (!this._panelFilesRead.has(panelId)) {
        this._panelFilesRead.set(panelId, new Set());
      }
      this._panelFilesRead.get(panelId)!.add(filePath);
    } else if (name.includes('write') || name.includes('edit') || name.includes('create') || name.includes('patch')) {
      if (!this._panelFilesWritten.has(panelId)) {
        this._panelFilesWritten.set(panelId, new Set());
      }
      this._panelFilesWritten.get(panelId)!.add(filePath);
    }
  }

  /**
   * Record project learnings from the current session's tool_use patterns.
   * Extracts directory structure insights and records them in auto-memory.
   */
  private _recordProjectLearningsFromSession(panelId: string): void {
    const config = vscode.workspace.getConfiguration('mysti');
    if (!config.get('autoMemory.enabled', true)) { return; }

    const filesRead = this._panelFilesRead.get(panelId);
    const filesWritten = this._panelFilesWritten.get(panelId);

    if (!filesRead?.size && !filesWritten?.size) { return; }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return; }

    // Extract unique top-level directories that were touched
    const touchedDirs = new Set<string>();
    const allFiles = [...(filesRead || []), ...(filesWritten || [])];

    for (const file of allFiles) {
      const relative = path.relative(workspaceRoot, file);
      if (relative.startsWith('..')) { continue; } // Outside workspace
      const topDir = relative.split(path.sep)[0];
      if (topDir && !topDir.startsWith('.')) {
        touchedDirs.add(topDir);
      }
    }

    // Record directory usage patterns
    for (const dir of touchedDirs) {
      this._memoryManager.recordProjectLearning('Key Paths', `\`${dir}/\` — actively used`);
    }

    // Clear per-panel tracking for next message cycle
    this._panelFilesRead.delete(panelId);
    this._panelFilesWritten.delete(panelId);
  }

  /**
   * Send badge unlock events to the webview for toast notifications.
   */
  private _emitBadgeUnlocks(panelId: string, events: import('../managers/EngagementManager').BadgeUnlockEvent[]): void {
    for (const event of events) {
      if (event.isNew) {
        this._postToPanel(panelId, {
          type: 'badgeUnlocked',
          payload: event.badge
        });
      }
    }
  }

  // ---- File Modification Tracking (for commit signatures + file decorations) ----

  private _fileModifiedListeners: ((filePath: string, provider: string) => void)[] = [];

  /**
   * Register a callback to be notified when Mysti modifies a file.
   * Used by CommitSignatureManager and MystiFileDecorationProvider.
   */
  public onFileModified(listener: (filePath: string, provider: string) => void): void {
    this._fileModifiedListeners.push(listener);
  }

  private _onFileModifiedByMysti(filePath: string, provider: string): void {
    for (const listener of this._fileModifiedListeners) {
      listener(filePath, provider);
    }
  }

  private _aiCommitListeners: ((toolName: string, toolInput: Record<string, unknown>) => void)[] = [];

  /**
   * Register a callback to be notified when the AI executes a tool_use.
   * Used by CommitSignatureManager to detect AI-initiated git commits.
   */
  public onToolUseDetected(listener: (toolName: string, toolInput: Record<string, unknown>) => void): void {
    this._aiCommitListeners.push(listener);
  }

  private _onToolUseDetected(toolName: string, toolInput: Record<string, unknown>): void {
    for (const listener of this._aiCommitListeners) {
      listener(toolName, toolInput);
    }
  }

  private async _handleGetFileLineNumber(
    payload: { filePath: string; searchText: string },
    panelId?: string
  ) {
    // Guard against missing filePath
    if (!payload?.filePath) {
      console.warn('[Mysti] getFileLineNumber called without filePath');
      return;
    }

    try {
      // Security: Path validation is handled in _resolveFilePath
      const resolvedPath = this._resolveFilePath(payload.filePath);
      const content = await fs.promises.readFile(resolvedPath, 'utf-8');
      let lineNumber = 1;
      const searchIndex = content.indexOf(payload.searchText);
      if (searchIndex !== -1) {
        // Count newlines before the match to get line number
        for (let i = 0; i < searchIndex; i++) {
          if (content[i] === '\n') {lineNumber++;}
        }
      }
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'fileLineNumber',
          payload: { filePath: payload.filePath, lineNumber }
        });
      }
    } catch {
      // If file can't be read, return line 1 as default
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'fileLineNumber',
          payload: { filePath: payload.filePath, lineNumber: 1 }
        });
      }
    }
  }

  private async _handleRevertFileEdit(payload: { path: string }, panelId?: string) {
    try {
      const uri = vscode.Uri.file(this._resolveFilePath(payload.path));

      // Try to use git to revert the file
      try {
        await vscode.commands.executeCommand('git.clean', uri);
      } catch {
        // If git clean fails, try checkout
        await vscode.commands.executeCommand('git.checkout', uri);
      }

      if (panelId) {
        this._postToPanel(panelId, {
          type: 'fileReverted',
          payload: { path: payload.path, success: true }
        });
      }

      vscode.window.showInformationMessage(`Reverted changes to ${payload.path}`);
    } catch (error) {
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'fileReverted',
          payload: {
            path: payload.path,
            success: false,
            error: error instanceof Error ? error.message : 'Failed to revert'
          }
        });
      }

      vscode.window.showErrorMessage(`Failed to revert ${payload.path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async _handleAskUserQuestionResponse(
    payload: { toolCallId: string; answers: Record<string, string | string[]> },
    panelId: string,
    originalQuestion?: AskUserQuestionData
  ): Promise<void> {
    // Clear the pending AskUserQuestion tracking
    this._pendingAskUserQuestions.delete(panelId);

    // Learn from the user's answer (passive memory building)
    if (originalQuestion) {
      this._memoryManager.learnFromQuestionAnswer(originalQuestion, payload.answers);
    }

    // Send tool_result only for explicit tool-based questions (not text-detected)
    if (originalQuestion?.source !== 'detected') {
      this._postToPanel(panelId, {
        type: 'toolResult',
        payload: {
          id: payload.toolCallId,
          name: 'AskUserQuestion',
          input: {},
          output: 'User provided answers',
          status: 'completed'
        }
      });
    }

    // Format answers into a readable message for Claude
    const parts = ['Here are my answers:\n'];
    for (const [questionHeader, answer] of Object.entries(payload.answers)) {
      const formattedAnswer = Array.isArray(answer) ? answer.join(', ') : answer;
      parts.push(`**${questionHeader}**: ${formattedAnswer}`);
    }
    parts.push('\nPlease proceed based on these choices.');

    // Get settings from config (use per-panel provider/model)
    const config = vscode.workspace.getConfiguration('mysti');
    const settings: Settings = {
      mode: config.get('defaultMode', 'ask-before-edit') as Settings['mode'],
      thinkingLevel: config.get('defaultThinkingLevel', 'none') as Settings['thinkingLevel'],
      accessLevel: config.get('accessLevel', 'ask-permission') as Settings['accessLevel'],
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: this._getPanelModel(panelId),
      provider: this._getPanelProvider(panelId) as Settings['provider']
    };

    // Send as follow-up message
    await this._handleSendMessage(
      {
        content: parts.join('\n'),
        context: this._contextManager.getContext(panelId),
        settings
      },
      panelId
    );
  }

  // ---- Sub-Agent Question Callback ----

  /**
   * Create a callback for MentionRouter that shows sub-agent questions to the user
   * and returns a Promise that resolves when the user answers (or skips).
   */
  private _createSubAgentQuestionCallback(panelId: string): SubAgentQuestionCallback {
    return (agentId: AgentType, questionData: AskUserQuestionData) => {
      return new Promise((resolve) => {
        const key = `${panelId}-${questionData.toolCallId}`;
        this._pendingSubAgentQuestions.set(key, { resolve });

        // Post question UI to webview (rendered inside the sub-agent card)
        this._postToPanel(panelId, {
          type: 'subAgentAskUserQuestion',
          payload: { agentId, questionData }
        });
      });
    };
  }

  /**
   * Resolve all pending sub-agent questions for a panel with null (skip).
   * Called when the user cancels the request.
   */
  private _cancelPendingSubAgentQuestions(panelId: string): void {
    for (const [key, pending] of this._pendingSubAgentQuestions) {
      if (key.startsWith(`${panelId}-`)) {
        pending.resolve(null);
        this._pendingSubAgentQuestions.delete(key);
      }
    }
  }

  // ---- Autonomous Mode Handlers ----

  /**
   * Handle toggle request from webview or command palette
   */
  private async _handleToggleAutonomous(panelId?: string): Promise<void> {
    const targetPanel = panelId || this._sidebarId;

    if (this._autonomousManager.isActive()) {
      // Deactivate
      const stats = this._autonomousManager.deactivate();
      this._postToPanel(targetPanel, {
        type: 'autonomousDeactivated',
        payload: stats
      });
      // Track engagement: autonomous session completed
      this._emitBadgeUnlocks(targetPanel, this._engagementManager.trackAutonomousSession());
      console.log('[Mysti] Autonomous mode deactivated');
    } else {
      // Show confirmation dialog in webview
      this._postToPanel(targetPanel, {
        type: 'showAutonomousConfirm',
        payload: {
          safetyMode: this._autonomousManager.getConfig().safetyMode,
          continuationMode: this._autonomousManager.getConfig().continuationMode,
        }
      });
    }
  }

  /**
   * Handle user confirming autonomous activation
   */
  private async _handleConfirmAutonomous(
    payload: { goal?: string; tasks?: string[] },
    panelId?: string
  ): Promise<void> {
    const targetPanel = panelId || this._sidebarId;

    const activated = this._autonomousManager.activate({
      goal: payload.goal,
      tasks: payload.tasks,
    });

    if (activated) {
      // Set up decision callback to push decisions to the UI
      this._autonomousManager.onDecision((decision) => {
        this._postToPanel(targetPanel, {
          type: 'autonomousDecision',
          payload: decision
        });
      });

      this._postToPanel(targetPanel, {
        type: 'autonomousActivated',
        payload: {
          goal: payload.goal,
          tasks: payload.tasks,
          config: this._autonomousManager.getConfig(),
        }
      });

      console.log('[Mysti] Autonomous mode activated' + (payload.goal ? ` with goal: "${payload.goal}"` : ''));
    }
  }

  /**
   * Public method for command palette toggle
   */
  public toggleAutonomousMode(): void {
    this._handleToggleAutonomous();
  }

  private async _handleSendMessage(
    payload: {
      content: string;
      context: ContextItem[];
      settings: Settings;
      mentions?: Mention[];
      attachments?: Attachment[];
    },
    panelId: string
  ) {
    // Cancel any running/suspended request on this panel before starting a new one.
    // This handles the case where the user sends a new message while a permission
    // card is pending (e.g., typing "yes" in chat instead of clicking the permission button).
    if (this._runningPanels.has(panelId)) {
      console.log(`[Mysti] New message while panel ${panelId} is running — cancelling previous request`);
      this._cancelledPanels.add(panelId);
      this._providerManager.cancelRequest(panelId);
      // Dismiss any pending permission cards so the old gate resolves (denied)
      this._permissionManager.cancelAllRequests();
      this._postToPanel(panelId, { type: 'permissionDismissed', payload: {} });
      // Brief yield to let the cancelled for-await loop exit before we start a new one
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Perf (Plan 03 Phase 1): formalized send-path timing. The mark is
    // panel-scoped so concurrent sends on different panels don't clobber
    // each other. Detailed measures below only log/store when
    // mysti.debug.performanceLogging is enabled.
    const _sendStartMark = `send.start.${panelId}`;
    PerfTracker.mark(_sendStartMark);

    // Clear cancel flag for this panel
    this._cancelledPanels.delete(panelId);

    // Clear any pending interactive states — a new message implicitly dismisses them
    this._pendingPlanSelections.delete(panelId);
    this._pendingAskUserQuestions.delete(panelId);

    const { content, context, mentions, attachments } = payload;
    let { settings } = payload;

    // Track the user's message for plan selection follow-up
    this._lastUserMessage.set(panelId, content);

    // Track engagement: message sent
    const badgeEvents = this._engagementManager.trackMessageSent(settings.provider);
    this._emitBadgeUnlocks(panelId, badgeEvents);

    // Get the panel's conversation
    const panelState = this._panelStates.get(panelId);
    const conversationId = panelState?.currentConversationId;
    const conversation = conversationId
      ? this._conversationManager.getConversation(conversationId)
      : null;

    // Add user message to this panel's conversation (strip base64 data for storage)
    const storedAttachments = attachments?.map(a => ({
      ...a,
      base64Data: undefined  // Don't persist large base64 data in globalState
    }));
    const userMessage = this._conversationManager.addMessageToConversation(
      conversationId,
      'user',
      content,
      context,
      storedAttachments
    );
    // Post to webview WITH base64 for immediate image rendering
    // (storedAttachments in globalState have base64 stripped to save space)
    const displayMessage = attachments?.length
      ? { ...userMessage, attachments }
      : userMessage;
    this._postToPanel(panelId, {
      type: 'messageAdded',
      payload: displayMessage
    });

    // Generate AI title for first user message
    if (conversationId && this._conversationManager.isFirstUserMessage(conversationId)) {
      this._generateTitleAsync(conversationId, content, panelId);
    }

    // Mark agent as busy for lifecycle tracking
    this._lifecycleManager.touchSession(panelId);
    this._lifecycleManager.markBusy(panelId);

    PerfTracker.measure('send.setup', _sendStartMark);

    // Stream response from provider
    try {
      this._postToPanel(panelId, { type: 'responseStarted' });

      // Get agent configuration for this conversation
      const agentConfig = conversationId
        ? this._conversationManager.getAgentConfig(conversationId)
        : undefined;

      // === Process @-mentions before main agent ===
      let enrichedContent = content;
      const enrichedContext = [...context];

      let mentionTaskList: MentionTaskList | undefined;
      let mainProviderTaskDescriptions: MentionTask[] = [];

      if (mentions && mentions.length > 0) {
        // M2: Enforce maximum mentions per message
        const { MAX_MENTIONS_PER_MESSAGE } = await import('../constants');
        const agentMentionCount = mentions.filter(m => m.type === 'agent').length;
        let effectiveMentions = mentions;
        if (agentMentionCount > MAX_MENTIONS_PER_MESSAGE) {
          console.warn(`[Mysti] Too many agent mentions (${agentMentionCount}), truncating to ${MAX_MENTIONS_PER_MESSAGE}`);
          let kept = 0;
          effectiveMentions = mentions.filter(m => {
            if (m.type !== 'agent') { return true; }
            if (kept < MAX_MENTIONS_PER_MESSAGE) { kept++; return true; }
            return false;
          });
          this._postToPanel(panelId, {
            type: 'mentionWarning',
            payload: { message: `Too many @-mentions (${agentMentionCount}). Only the first ${MAX_MENTIONS_PER_MESSAGE} agent mentions will be processed.` }
          });
        }
        PerfTracker.measure('send.mentionStart', _sendStartMark);
        console.log('[Mysti] Processing mentions:', effectiveMentions.length, 'mentions for panel:', panelId);
        const subAgentResponses = new Map<AgentType, SubAgentResponse>();

        // Store mention context for retry support
        this._lastMentionContext.set(panelId, { content, mentions: effectiveMentions, context, settings });

        const subAgentQuestionCallback = this._createSubAgentQuestionCallback(panelId);
        const mentionStream = this._mentionRouter.processMentions(
          content, effectiveMentions, context, settings, conversation, panelId, subAgentQuestionCallback
        );

        for await (const chunk of mentionStream) {
          if (this._cancelledPanels.has(panelId)) { break; }
          console.log('[Mysti] Mention chunk:', chunk.type, chunk.agentId || '');

          switch (chunk.type) {
            case 'files_resolved':
              if (chunk.resolvedFiles) {
                enrichedContext.push(...chunk.resolvedFiles);
              }
              break;

            case 'file_resolution_warning':
              // M7: Show warning about unresolvable file mentions
              this._postToPanel(panelId, {
                type: 'mentionWarning',
                payload: { message: chunk.content || 'Some file mentions could not be resolved.' }
              });
              break;

            case 'task_list_generated':
              mentionTaskList = chunk.taskList;
              this._postToPanel(panelId, {
                type: 'mentionTaskListGenerated',
                payload: { tasks: chunk.taskList?.tasks || [] }
              });
              break;

            case 'task_started': {
              this._postToPanel(panelId, {
                type: 'mentionTaskStarted',
                payload: { taskIndex: chunk.taskIndex, agentId: chunk.agentId, task: chunk.taskDescription }
              });

              // Handle switch task type inline
              if (chunk.taskDescription === 'switch provider' && chunk.agentId) {
                const config = vscode.workspace.getConfiguration('mysti');
                await config.update('defaultProvider', chunk.agentId, vscode.ConfigurationTarget.Global);
                this._postToPanel(panelId, {
                  type: 'providerSwitched',
                  payload: { provider: chunk.agentId }
                });
                settings = { ...settings, provider: chunk.agentId as ProviderType };
                enrichedContent = this._mentionRouter.stripMentions(content, mentions);
              }
              break;
            }

            case 'task_complete':
              this._postToPanel(panelId, {
                type: 'mentionTaskComplete',
                payload: { taskIndex: chunk.taskIndex, agentId: chunk.agentId, hasError: chunk.hasError }
              });
              break;

            case 'subagent_started':
              this._postToPanel(panelId, {
                type: 'subAgentStarted',
                payload: { agentId: chunk.agentId }
              });
              break;

            case 'subagent_text':
              if (chunk.agentId) {
                const resp = subAgentResponses.get(chunk.agentId) || {
                  agentId: chunk.agentId, content: '', status: 'streaming' as const
                };
                resp.content += chunk.content || '';
                subAgentResponses.set(chunk.agentId, resp);
              }
              this._postToPanel(panelId, {
                type: 'subAgentChunk',
                payload: { agentId: chunk.agentId, content: chunk.content, chunkType: 'text' }
              });
              break;

            case 'subagent_thinking':
              this._postToPanel(panelId, {
                type: 'subAgentChunk',
                payload: { agentId: chunk.agentId, content: chunk.content, chunkType: 'thinking' }
              });
              break;

            case 'subagent_tool_use':
              // Permission gate for sub-agent write operations
              if (chunk.toolCall && this._shouldGateToolUse(settings, chunk.toolCall.name)) {
                const subGateAction = this._classifyToolAction(chunk.toolCall.name);
                if (subGateAction !== 'file-read') {
                  const subInputPreview = JSON.stringify(chunk.toolCall.input || {}, null, 2).slice(0, 500);
                  const subRiskLevel = PermissionManager.classifyRisk(subGateAction);
                  const subApproved = await this.requestPermissionInline(
                    subGateAction,
                    chunk.toolCall.name,
                    `${chunk.agentId || 'Sub-agent'} wants to: ${chunk.toolCall.name}`,
                    { command: subInputPreview, riskLevel: subRiskLevel },
                    panelId,
                    chunk.toolCall.id
                  );
                  if (!subApproved) {
                    this._providerManager.cancelRequest(panelId);
                    break;
                  }
                }
              }
              this._postToPanel(panelId, {
                type: 'subAgentToolUse',
                payload: { agentId: chunk.agentId, toolCall: chunk.toolCall }
              });
              break;

            case 'subagent_tool_result':
              this._postToPanel(panelId, {
                type: 'subAgentToolResult',
                payload: { agentId: chunk.agentId, toolCall: chunk.toolCall }
              });
              break;

            case 'subagent_retry':
              this._postToPanel(panelId, {
                type: 'subAgentRetry',
                payload: { agentId: chunk.agentId, retryCount: chunk.retryCount }
              });
              break;

            case 'subagent_complete':
              if (chunk.agentId) {
                const resp = subAgentResponses.get(chunk.agentId);
                if (resp) {
                  resp.status = chunk.hasError ? 'error' : 'complete';
                }
              }
              this._postToPanel(panelId, {
                type: 'subAgentComplete',
                payload: { agentId: chunk.agentId, hasError: chunk.hasError }
              });
              break;

            case 'subagent_error':
              if (chunk.agentId) {
                const resp = subAgentResponses.get(chunk.agentId) || {
                  agentId: chunk.agentId, content: '', status: 'error' as const
                };
                resp.status = 'error';
                resp.error = chunk.content;
                subAgentResponses.set(chunk.agentId, resp);
              }
              this._postToPanel(panelId, {
                type: 'subAgentError',
                payload: { agentId: chunk.agentId, error: chunk.content }
              });
              break;

            case 'subagent_ask_user_question':
              // Sub-agent card status update — the actual question UI is posted by the callback
              this._postToPanel(panelId, {
                type: 'subAgentStatus',
                payload: { agentId: chunk.agentId, status: 'Waiting for your answer...' }
              });
              break;

            case 'main_tasks': {
              // Store main-provider tasks to fold into the main agent prompt
              mainProviderTaskDescriptions = chunk.mainProviderTasks || [];
              break;
            }

            case 'main_start': {
              // Enrich main agent content with sub-agent responses + main-provider tasks
              const cleanContent = this._mentionRouter.stripMentions(content, mentions);
              const promptParts: string[] = [];

              if (subAgentResponses.size > 0) {
                const subAgentContext = this._mentionRouter.formatSubAgentContext(subAgentResponses);
                if (subAgentContext) {
                  promptParts.push(subAgentContext);
                }
              }

              if (mainProviderTaskDescriptions.length > 0) {
                const taskInstructions = mainProviderTaskDescriptions
                  .map((t, i) => `${i + 1}. ${t.task}`)
                  .join('\n');
                promptParts.push(`Your tasks:\n${taskInstructions}`);
              }

              promptParts.push(`User query: ${cleanContent}`);
              enrichedContent = promptParts.join('\n\n');
              break;
            }
          }
        }

        console.log('[Mysti] Mention processing complete');

        // If cancelled during mention processing, stop
        if (this._cancelledPanels.has(panelId)) {
          this._postToPanel(panelId, { type: 'requestCancelled' });
          return;
        }

        // Single-task short-circuit: if there was exactly 1 execute task,
        // the sub-agent's streamed output IS the final response — skip main agent
        if (mentionTaskList && mentionTaskList.tasks.length === 1 &&
            mentionTaskList.tasks[0].taskType === 'execute' && subAgentResponses.size > 0) {
          const singleResponse = subAgentResponses.values().next().value;
          if (singleResponse && singleResponse.status === 'complete' && singleResponse.content) {
            console.log('[Mysti] Single-task short-circuit: using sub-agent response as final answer');

            // Save to conversation
            const assistantMessage = this._conversationManager.addMessageToConversation(
              conversationId,
              'assistant',
              singleResponse.content
            );
            this._postToPanel(panelId, {
              type: 'responseComplete',
              payload: { message: assistantMessage }
            });

            this._lastMentionContext.delete(panelId);
            return;
          }
        }
      }
      // === End @-mention processing ===

      // Augment settings with autonomous mode flag if active
      const effectiveSettings = this._autonomousManager.isActive()
        ? { ...settings, autonomousMode: true }
        : settings;

      // Pass panelId for per-panel process tracking
      // Filter attachments based on provider capabilities
      let effectiveAttachments = attachments;
      if (attachments && attachments.length > 0) {
        const provider = this._providerManager.getProviderInstance(effectiveSettings.provider);
        if (provider) {
          const warnings: string[] = [];

          if (!provider.capabilities.supportsImages) {
            const imageCount = attachments.filter(a => a.type === 'image').length;
            if (imageCount > 0) {
              console.log(`[Mysti] Provider ${effectiveSettings.provider} does not support images, stripping ${imageCount} image attachments`);
              warnings.push(`${imageCount} image(s) removed — ${effectiveSettings.provider} does not support images.`);
              effectiveAttachments = (effectiveAttachments || []).filter(a => a.type !== 'image');
            }
          }

          if (!provider.capabilities.supportsFileAttachments) {
            const fileCount = (effectiveAttachments || []).filter(a => a.type === 'file').length;
            if (fileCount > 0) {
              console.log(`[Mysti] Provider ${effectiveSettings.provider} does not support file attachments, stripping ${fileCount} file attachments`);
              warnings.push(`${fileCount} file(s) removed — ${effectiveSettings.provider} does not support file attachments.`);
              effectiveAttachments = (effectiveAttachments || []).filter(a => a.type !== 'file');
            }
          }

          if (warnings.length > 0) {
            this._postToPanel(panelId, {
              type: 'attachmentWarning',
              payload: { message: warnings.join(' ') }
            });
          }
        }
      }

      PerfTracker.measure('send.preprocess', _sendStartMark);

      // Set channel context + project context as system instructions (injected at top of prompt by buildPromptAsync)
      const _tCtx = Date.now();
      const channelSnippet = this._channelBridge.getChannelPromptSnippet();
      console.log(`[Mysti] ⏱️ Channel snippet in ${Date.now() - _tCtx}ms`);
      const replyContext = this._channelBridge.getReplyContext(panelId);
      const channelContext = [channelSnippet, replyContext].filter(Boolean).join('\n\n');

      // Inject mysti.md project instructions + .mysti/rules/ (like CLAUDE.md + .claude/rules/)
      const mystiConfig = vscode.workspace.getConfiguration('mysti');
      const projectContextEnabled = mystiConfig.get('projectContext.enabled', true);
      const autoMemoryEnabled = mystiConfig.get('autoMemory.enabled', true);
      const _tRules = Date.now();
      const projectRules = projectContextEnabled ? this._projectContextManager.readRules() : '';
      console.log(`[Mysti] ⏱️ Project rules in ${Date.now() - _tRules}ms`);
      const _tMd = Date.now();
      const mystiMdContent = projectContextEnabled ? this._projectContextManager.getMystiMdContent() : '';
      console.log(`[Mysti] ⏱️ mysti.md in ${Date.now() - _tMd}ms`);
      const _tMem = Date.now();
      const autoMemory = autoMemoryEnabled ? this._memoryManager.getProjectMemoryContent() : '';
      console.log(`[Mysti] ⏱️ Auto-memory in ${Date.now() - _tMem}ms`);
      const deepMystConnect = this._deepMystConnectSnippet();
      const fullSystemContext = [projectRules, channelContext, mystiMdContent, autoMemory, deepMystConnect].filter(Boolean).join('\n\n');

      if (fullSystemContext) {
        this._providerManager.setChannelSystemContext(panelId, fullSystemContext, effectiveSettings.provider);
        console.log('[Mysti] System context set (' + fullSystemContext.length + ' chars' +
          (mystiMdContent ? ', mysti.md: ' + mystiMdContent.length : '') +
          (projectRules ? ', rules: ' + projectRules.length : '') +
          (autoMemory ? ', memory: ' + autoMemory.length : '') + ')');
      }

      // Reset channel bridge marker tracking for this new response
      this._channelBridge.resetForNewResponse(panelId);
      this._lastActivePanelId = panelId;

      PerfTracker.measure('send.contextBuilt', _sendStartMark);
      const stream = this._providerManager.sendMessage(
        enrichedContent,
        enrichedContext,
        effectiveSettings,
        conversation,
        undefined,
        panelId,
        agentConfig,
        effectiveAttachments
      );

      let assistantContent = '';
      let thinkingContent = '';
      this._vtTriggeredThisResponse = false;
      this._connectServicesThisResponse.clear();
      let lastUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;

      // Plan 02 Phase 3: accumulate render-relevant structure extension-side
      // so the persisted assistant message (done handler) can be replayed by
      // the webview exactly as it streamed. Tool calls are keyed by id —
      // Claude emits two tool_use chunks per tool (content_block_start with
      // empty input, content_block_stop with full input), which must merge
      // into one persisted entry/segment.
      const responseToolCalls = new Map<string, ToolCall>();
      const responseSegments: MessageSegment[] = [];
      const appendContentSegment = (type: 'text' | 'thinking', content: string) => {
        if (!content) { return; }
        const last = responseSegments[responseSegments.length - 1];
        if (last && last.type !== 'tool' && last.type === type) {
          last.content += content;
        } else {
          responseSegments.push({ type, content });
        }
      };
      // Native plan moment (Claude exit_plan_mode) recorded mid-stream,
      // routed into the plan-selection flow from the done handler.
      let pendingExitPlan: { planFilePath: string | null } | null = null;

      // Send context window info when starting
      this._postToPanel(panelId, {
        type: 'contextWindowInfo',
        payload: {
          contextWindow: this._providerManager.getModelContextWindow(settings.provider, settings.model)
        }
      });

      this._runningPanels.add(panelId);
      let _firstChunkSeen = false;
      let _firstTextChunkSent = false;
      for await (const chunk of stream) {
        if (!_firstChunkSeen) {
          _firstChunkSeen = true;
          // Extension-side TTFT: send entry → first stream chunk received.
          const ttftExtMs = PerfTracker.measure('send.ttftExtension', _sendStartMark);
          if (ttftExtMs >= 0) {
            PerfTracker.sample('send.ttftExtension', ttftExtMs);
          }
        }
        // Check if THIS panel's request was cancelled
        if (this._cancelledPanels.has(panelId)) {break;}

        switch (chunk.type) {
          case 'text': {
            assistantContent += chunk.content || '';
            appendContentSegment('text', chunk.content || '');
            const textPayload: { type: string; content?: string; perfSentAt?: number } = {
              type: 'text',
              content: chunk.content
            };
            if (!_firstTextChunkSent) {
              _firstTextChunkSent = true;
              // First text chunk of this response: stamp wall-clock send time
              // (echoed back by the webview's firstChunkRendered perfMark) and
              // set the monotonic mark that send.ttftRender measures from.
              textPayload.perfSentAt = Date.now();
              PerfTracker.mark(`send.firstChunkSent.${panelId}`);
            }
            this._postToPanel(panelId, {
              type: 'responseChunk',
              payload: textPayload
            });

            // Detect completed channel markers and execute send/ask actions
            {
              const actions = this._channelBridge.detectMarkers(panelId, assistantContent);
              for (const action of actions) {
                if (action.type === 'send') {
                  const ok = await this._channelBridge.executeSend(action);
                  this._postToPanel(panelId, {
                    type: 'channelAction',
                    payload: { action: 'send', channel: action.channel, to: action.to, success: ok }
                  });
                } else if (action.type === 'ask') {
                  const ok = await this._channelBridge.executeAsk(action, panelId);
                  this._postToPanel(panelId, {
                    type: 'channelAction',
                    payload: { action: 'ask', channel: action.channel, to: action.to, askId: action.askId, success: ok }
                  });
                } else if (action.type === 'delegate') {
                  // C4: channel delegation is a capability, not a provider
                  // name — route to whichever registered provider declares
                  // supportsChannels (today: OpenClaw's gateway daemon).
                  const channelProviderId = this._getChannelProviderId();
                  if (channelProviderId) {
                    const ok = await this._channelBridge.executeDelegate(action);
                    this._postToPanel(panelId, {
                      type: 'channelAction',
                      payload: { action: 'delegate', channel: channelProviderId, success: ok }
                    });
                  } else {
                    console.warn('[Mysti] Channel delegate marker detected, but no registered provider supports channels — skipping');
                  }
                }
              }
            }

            // Plan 04 Phase 4: detect DeepMyst connect markers
            // (<<<MYSTI_CONNECT:slug>>>) and surface a "Link <service>" card.
            {
              const connectRe = /<<<MYSTI_CONNECT:([a-z0-9][a-z0-9._-]*)>>>/gi;
              // Ignore the literal placeholder tokens from the system-prompt
              // example so a model echoing the instruction doesn't spawn a card.
              const placeholders = new Set(['slug', 'service', 'name', 'servicename']);
              let cm: RegExpExecArray | null;
              while ((cm = connectRe.exec(assistantContent)) !== null) {
                const service = cm[1].toLowerCase();
                if (placeholders.has(service)) { continue; }
                if (!this._connectServicesThisResponse.has(service)) {
                  this._connectServicesThisResponse.add(service);
                  void this._emitConnectionCard(panelId, service);
                }
              }
            }

            // Detect visual test trigger from AI (```visual-test\n{...}\n```)
            if (!this._vtTriggeredThisResponse) {
              const trigger = this._detectVisualTestTrigger(assistantContent);
              if (trigger) {
                this._vtTriggeredThisResponse = true;
                const vtConfig: VisualTestConfig = {
                  url: trigger.url || 'http://localhost:3000',
                  devServerCommand: trigger.devServerCommand,
                  requirements: trigger.requirements,
                  maxIterations: trigger.maxIterations || 5,
                  screenshotMode: (trigger.screenshotMode as any) || 'viewport',
                  elementSelector: trigger.elementSelector,
                  browser: 'chromium',
                  headless: true,
                  viewportWidth: 1280,
                  viewportHeight: 720,
                  interactionsEnabled: true
                };
                const effectiveSettings = this._getSettingsForPanel(panelId);
                if (trigger.showDashboard) {
                  const dashPanelId = this.openVisualTestDashboard(vtConfig, panelId);
                  this._runVisualTestWithDashboard(dashPanelId, vtConfig, panelId, effectiveSettings);
                } else {
                  this._runVisualTestHeadless(vtConfig, panelId, effectiveSettings);
                }
              }
            }
            break;
          }

          case 'thinking':
            thinkingContent += chunk.content || '';
            appendContentSegment('thinking', chunk.content || '');
            this._postToPanel(panelId, {
              type: 'responseChunk',
              payload: { type: 'thinking', content: chunk.content }
            });
            break;

          case 'tool_use': {
            // Permission gate: block write operations when mode/access requires approval.
            // Uses SIGSTOP to freeze the CLI process BEFORE tool execution, ensuring
            // the tool cannot run until the user explicitly approves.
            // NOTE: Claude emits two tool_use chunks per tool (content_block_start with empty input,
            // then content_block_stop with full input). We skip gating for chunks with empty input
            // to avoid double-gating and to show meaningful input preview in the permission card.
            const hasInput = chunk.toolCall?.input && Object.keys(chunk.toolCall.input).length > 0;
            if (chunk.toolCall && hasInput && this._shouldGateToolUse(effectiveSettings, chunk.toolCall.name)) {
              const gateActionType = this._classifyToolAction(chunk.toolCall.name);
              if (gateActionType !== 'file-read') {
                // Freeze the CLI process immediately to prevent tool execution.
                // SIGSTOP halts the process at the OS level — no further instructions
                // run until SIGCONT is sent. Returns false on Windows.
                const wasSuspended = this._providerManager.suspendRequest(panelId);

                const inputPreview = JSON.stringify(chunk.toolCall.input || {}, null, 2).slice(0, 500);
                const riskLevel = PermissionManager.classifyRisk(gateActionType);
                const gateApproved = await this.requestPermissionInline(
                  gateActionType,
                  chunk.toolCall.name,
                  `Mysti wants to: ${chunk.toolCall.name}`,
                  { command: inputPreview, riskLevel, suspended: wasSuspended },
                  panelId,
                  chunk.toolCall.id
                );
                if (gateApproved) {
                  // Resume the frozen CLI process so tool execution proceeds
                  if (wasSuspended) {
                    this._providerManager.resumeRequest(panelId);
                  }
                } else {
                  // User denied or a new message superseded this request.
                  // If cancelled by a new message, skip error posting — the new message
                  // already cancelled the process and the user expects a fresh response.
                  if (!this._cancelledPanels.has(panelId)) {
                    this._providerManager.cancelRequest(panelId);
                    this._postToPanel(panelId, {
                      type: 'toolResult',
                      payload: {
                        id: chunk.toolCall.id,
                        name: chunk.toolCall.name,
                        output: 'Permission denied by user',
                        status: 'failed'
                      }
                    });
                    this._postToPanel(panelId, {
                      type: 'error',
                      payload: `Operation "${chunk.toolCall.name}" was denied. Request cancelled.`
                    });
                  }
                  return;
                }
              }
            }
            // Plan 02 Phase 3: accumulate for persistence. Merge duplicate
            // emissions for the same tool id (Claude's start/stop pair) into
            // a single tool call + a single ordered segment.
            if (chunk.toolCall) {
              const tracked = responseToolCalls.get(chunk.toolCall.id);
              if (tracked) {
                if (hasInput) { tracked.input = chunk.toolCall.input; }
                tracked.status = chunk.toolCall.status;
                if (chunk.toolCall.fileChange) { tracked.fileChange = chunk.toolCall.fileChange; }
                if (chunk.toolCall.kind) { tracked.kind = chunk.toolCall.kind; }
              } else {
                responseToolCalls.set(chunk.toolCall.id, { ...chunk.toolCall });
                responseSegments.push({ type: 'tool', toolCallId: chunk.toolCall.id });
              }
            }
            this._postToPanel(panelId, {
              type: 'toolUse',
              payload: chunk.toolCall
            });
            // Track file modifications for file decorations
            if (chunk.toolCall?.fileChange?.filePath) {
              const filePath = chunk.toolCall.fileChange.filePath;
              this._onFileModifiedByMysti(filePath, settings.provider);
            }
            // Track AI-initiated git commits for badge
            if (chunk.toolCall) {
              this._onToolUseDetected(chunk.toolCall.name, chunk.toolCall.input);
              // Track files for auto-memory learning
              this._trackToolUseForMemory(panelId, chunk.toolCall.name, chunk.toolCall.input);
            }
            break;
          }

          case 'tool_result':
            // Plan 02 Phase 3: resolve the tracked tool call for persistence
            if (chunk.toolCall) {
              const resolved = responseToolCalls.get(chunk.toolCall.id);
              if (resolved) {
                if (chunk.toolCall.output !== undefined) { resolved.output = chunk.toolCall.output; }
                resolved.status = chunk.toolCall.status || 'completed';
              }
            }
            this._postToPanel(panelId, {
              type: 'toolResult',
              payload: chunk.toolCall
            });
            break;

          case 'exit_plan_mode':
            // Plan 02 Phase 3.5: Claude's native plan moment (ExitPlanMode
            // tool). Record it here; the plan card is posted from the done
            // handler once the assistant message has been persisted, because
            // the webview attaches plan cards to a message element by id.
            console.log('[Mysti] exit_plan_mode chunk received, plan file:', chunk.planFilePath);
            pendingExitPlan = { planFilePath: chunk.planFilePath ?? null };
            break;

          case 'error':
            this._postToPanel(panelId, {
              type: 'error',
              payload: chunk.content
            });
            break;

          case 'auth_error':
            this._postToPanel(panelId, {
              type: 'authError',
              payload: {
                error: chunk.content,
                authCommand: chunk.authCommand,
                providerName: chunk.providerName
              }
            });
            break;

          case 'session_active':
            this._lifecycleManager.registerSession(panelId, settings.provider, chunk.sessionId || null);
            this._postToPanel(panelId, {
              type: 'sessionActive',
              payload: { sessionId: chunk.sessionId }
            });
            break;

          case 'ask_user_question':
            // Autonomous mode: try to auto-answer the question
            if (this._autonomousManager.isActive() && chunk.askUserQuestion) {
              const autoResult = this._autonomousManager.generateAutoAnswer(chunk.askUserQuestion);
              if (autoResult) {
                // Show the auto-answer decision in the UI
                this._postToPanel(panelId, {
                  type: 'autonomousDecision',
                  payload: autoResult.decision
                });
                // Send the auto-answer back as if the user responded
                await this._handleAskUserQuestionResponse(
                  { toolCallId: chunk.askUserQuestion.toolCallId, answers: autoResult.answers },
                  panelId,
                  chunk.askUserQuestion
                );
                break;
              }
              // Auto-answer not confident enough — fall through to user UI
            }

            // Track that this panel has a pending question (suppresses plan options/suggestions)
            this._pendingAskUserQuestions.add(panelId);
            // Store question data for memory learning when user answers
            if (chunk.askUserQuestion) {
              this._pendingQuestionData.set(chunk.askUserQuestion.toolCallId, chunk.askUserQuestion);
            }
            // Show tool_use with pending status so user sees it's waiting for their input
            this._postToPanel(panelId, {
              type: 'toolUse',
              payload: {
                id: chunk.askUserQuestion?.toolCallId || 'ask-user-question',
                name: 'AskUserQuestion',
                input: { questions: chunk.askUserQuestion?.questions },
                status: 'pending'
              }
            });
            // Send the question UI
            this._postToPanel(panelId, {
              type: 'askUserQuestion',
              payload: chunk.askUserQuestion
            });

            // Semi-autonomous: set up timer for AI to answer if user doesn't respond
            if (this._isSemiAutonomousEnabled(panelId) && chunk.askUserQuestion) {
              const questionTimeout = this._getSemiAutonomousTimeout();
              const expiresAt = Date.now() + (questionTimeout * 1000);

              // Tell webview to show countdown on the question card
              this._postToPanel(panelId, {
                type: 'semiAutonomousQuestionTimer',
                payload: {
                  toolCallId: chunk.askUserQuestion.toolCallId,
                  timeout: questionTimeout,
                  expiresAt,
                }
              });

              // Set up server-side timeout
              const toolCallId = chunk.askUserQuestion.toolCallId;
              const questionData = chunk.askUserQuestion;
              const timeoutHandle = setTimeout(() => {
                this._handleSemiAutonomousQuestionTimeout(panelId, questionData);
              }, questionTimeout * 1000);
              this._semiAutoQuestionTimeouts.set(toolCallId, timeoutHandle);
            }
            break;

          case 'done': {
            // Capture usage stats if present in this chunk
            if (chunk.usage) {
              lastUsage = chunk.usage;
              console.log('[Mysti] Done chunk has usage:', chunk.usage);
            } else {
              console.log('[Mysti] Done chunk has NO usage');
            }
            // Plan 02 Phase 3: persist render-relevant structure with the
            // message — provider/model attribution, resolved tool calls,
            // structured thinking, and ordered segments for exact replay.
            // Any tool call the stream never resolved is marked completed so
            // restored messages don't show eternal spinners (providers with
            // emitsToolResults=false never send tool_result).
            const persistedToolCalls = Array.from(responseToolCalls.values()).map(tc =>
              (tc.status === 'pending' || tc.status === 'running')
                ? { ...tc, status: 'completed' as const }
                : tc
            );
            const thinkingStyle = this._getThinkingStyleForProvider(effectiveSettings.provider);
            const persistedThinking: string | MessageThinking | undefined = thinkingContent
              ? (thinkingStyle ? { style: thinkingStyle, content: thinkingContent } : thinkingContent)
              : undefined;
            // Plan 04 Phase 4: keep the connect marker out of persisted history
            // (it's already been turned into a card); the webview also strips it
            // from the live stream so the user never sees the raw marker.
            const persistedContent = assistantContent.replace(/<<<MYSTI_CONNECT:[a-z0-9._-]*>>>/gi, '').replace(/\n{3,}/g, '\n\n');
            const assistantMessage = this._conversationManager.addMessageToConversation(
              conversationId,
              'assistant',
              persistedContent,
              undefined,
              undefined,
              persistedThinking,
              {
                provider: effectiveSettings.provider,
                model: effectiveSettings.model,
                toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : undefined,
                segments: responseSegments.length > 0 ? responseSegments : undefined
              }
            );
            console.log('[Mysti] Sending responseComplete with usage:', lastUsage);
            this._postToPanel(panelId, {
              type: 'responseComplete',
              payload: {
                message: assistantMessage,
                usage: lastUsage
              }
            });

            // Track successful response for engagement (review prompts + badges)
            this._engagementManager.trackSuccessfulResponse();

            // Auto-memory: record project learnings from tool_use patterns
            // This is lightweight — only records when tool_use detected file patterns
            this._recordProjectLearningsFromSession(panelId);

            // Mark first completion for workspace recommendation flow
            if (!this._extensionContext.globalState.get<boolean>('mysti.hasCompletedSetup')) {
              this._extensionContext.globalState.update('mysti.hasCompletedSetup', true);
            }

            // Mark panel as no longer running and drain queued channel messages
            this._runningPanels.delete(panelId);
            {
              const queued = this._channelBridge.drainQueuedMessages(panelId);
              if (queued.length > 0) {
                for (const qMsg of queued) {
                  const qSenderLabel = qMsg.sender ? ` from ${qMsg.sender}` : '';
                  this._postToPanel(panelId, {
                    type: 'channelAction',
                    payload: { action: 'inbound', channel: qMsg.channelName, sender: qMsg.sender, content: qMsg.content.substring(0, 100) }
                  });
                  // Inject as new user message after a short delay
                  setTimeout(() => {
                    const config = vscode.workspace.getConfiguration('mysti');
                    const qSettings: Settings = {
                      mode: config.get('defaultMode', 'ask-before-edit') as Settings['mode'],
                      thinkingLevel: config.get('defaultThinkingLevel', 'none') as Settings['thinkingLevel'],
                      accessLevel: config.get('accessLevel', 'ask-permission') as Settings['accessLevel'],
                      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
                      model: this._getPanelModel(panelId),
                      provider: this._getPanelProvider(panelId) as Settings['provider']
                    };
                    this._handleSendMessage(
                      {
                        content: `[Via ${qMsg.channelName}${qSenderLabel}]: ${qMsg.content}`,
                        context: this._contextManager.getContext(panelId),
                        settings: qSettings
                      },
                      panelId
                    );
                  }, 500);
                }
              }
            }

            // Evaluate compaction threshold
            if (lastUsage) {
              const contextWindow = this._providerManager.getModelContextWindow(settings.provider, settings.model);
              const updatedConversation = conversationId
                ? this._conversationManager.getConversation(conversationId)
                : null;
              const messageCount = updatedConversation ? updatedConversation.messages.length : 0;

              if (this._compactionManager.shouldCompact(panelId, lastUsage, contextWindow, messageCount)) {
                // Run compaction asynchronously (don't block the response flow)
                this._executeCompaction(panelId, settings, updatedConversation, lastUsage, contextWindow);
              } else {
                this._compactionManager.recordUsage(panelId, lastUsage, contextWindow);
              }
            }

            // Plan 02 Phase 3.5: native plan moment (exit_plan_mode) routes
            // into the existing plan-selection flow. This marks the panel in
            // _pendingPlanSelections, which suppresses the AI plan-detection
            // and suggestion pass below and blocks autonomous continuation
            // until the user (or autonomous auto-select) picks.
            if (pendingExitPlan) {
              await this._handleExitPlanMode(pendingExitPlan.planFilePath, assistantMessage, panelId);
              pendingExitPlan = null;
            }

            // Skip plan options and suggestions if there's a pending AskUserQuestion or plan selection
            if (!this._pendingAskUserQuestions.has(panelId) && !this._pendingPlanSelections.has(panelId)) {
              // Run classification and suggestions fully async (non-blocking) for faster perceived response
              this._generateSuggestionsAsync(assistantMessage, panelId);

              const mystiConfig = vscode.workspace.getConfiguration('mysti');
              const planDetectionEnabled = mystiConfig.get('planDetection.enabled', true);
              if (planDetectionEnabled) {
                this._detectAndSendPlanOptions(assistantMessage, panelId).then(hasInteractiveElements => {
                  if (hasInteractiveElements) {
                    this.postMessage({ type: 'clearSuggestions' } as WebviewMessage, panelId);
                  }
                });
              }
            }

            // Autonomous mode: check if we should auto-continue
            // Only continue if no pending questions or plan selections
            if (this._autonomousManager.isActive() && !this._pendingAskUserQuestions.has(panelId) && !this._pendingPlanSelections.has(panelId)) {
              const followUp = this._autonomousManager.shouldContinue(assistantContent);
              if (followUp) {
                const autoConfig = vscode.workspace.getConfiguration('mysti');
                // B13: Do NOT force edit-automatically + full-access here — that
                // blanket bypass disabled the permission gate (and with it the
                // SafetyClassifier) for the entire continuation. Carry the user's
                // configured mode/access and flag the turn as autonomous so the
                // gate stays active (see _shouldGateToolUse) and every write/bash
                // tool is routed through the SafetyClassifier.
                const autoSettings: Settings = {
                  mode: autoConfig.get('mode', 'default') as Settings['mode'],
                  thinkingLevel: autoConfig.get('defaultThinkingLevel', 'none') as Settings['thinkingLevel'],
                  accessLevel: autoConfig.get('accessLevel', 'ask-permission') as Settings['accessLevel'],
                  contextMode: autoConfig.get('autoContext', true) ? 'auto' : 'manual',
                  model: this._getPanelModel(panelId),
                  provider: this._getPanelProvider(panelId) as Settings['provider'],
                  autonomousMode: true,
                };
                setTimeout(() => {
                  this._handleSendMessage(
                    {
                      content: followUp,
                      context: this._contextManager.getContext(panelId),
                      settings: autoSettings
                    },
                    panelId
                  );
                }, AUTONOMOUS_CONTINUATION_DELAY_MS);
              } else {
                // Goal complete or no more tasks — deactivate
                const finalStats = this._autonomousManager.deactivate();
                this._postToPanel(panelId, {
                  type: 'autonomousDeactivated',
                  payload: finalStats
                });
              }
            }

            // Mark session idle after response completes
            this._lifecycleManager.markIdle(panelId);
            break;
          }
        }
      }
    } catch (error) {
      this._lifecycleManager.markIdle(panelId);
      this._postToPanel(panelId, {
        type: 'error',
        payload: error instanceof Error ? error.message : 'An unknown error occurred'
      });
    }
  }

  /**
   * Execute compaction for a panel when token usage exceeds the threshold.
   * Runs asynchronously to avoid blocking the response flow.
   */
  /**
   * Provider-neutral manual compaction entry point (Plan 02 Phase 2, C7).
   *
   * Reached from both the webview's 'manualCompact' message and the /compact
   * slash command ('cmd:compact'). Delegates to _executeCompaction, whose
   * strategy comes from CompactionManager (native-cli when the provider
   * declares supportsNativeCompact, client-summarize otherwise).
   */
  private async _handleManualCompact(panelId: string): Promise<void> {
    const panelState = this._panelStates.get(panelId);
    const conversation = panelState?.currentConversationId
      ? this._conversationManager.getConversation(panelState.currentConversationId)
      : null;

    const config = vscode.workspace.getConfiguration('mysti');
    const provider = this._getPanelProvider(panelId) as Settings['provider'];
    const model = this._getPanelModel(panelId);
    const contextWindow = this._providerManager.getModelContextWindow(provider, model);

    if (!conversation || conversation.messages.length < 2) {
      this._postToPanel(panelId, {
        type: 'compactionStatus',
        payload: {
          status: 'error',
          strategy: this._compactionManager.getStrategy(provider, this._providerManager),
          beforeTokens: 0,
          contextWindow,
          threshold: this._compactionManager.getThreshold(),
          error: 'Not enough conversation history to compact',
        } as CompactionEvent,
      });
      return;
    }

    const settings: Settings = {
      mode: config.get('defaultMode', 'default') as Settings['mode'],
      thinkingLevel: config.get('defaultThinkingLevel', 'none') as Settings['thinkingLevel'],
      accessLevel: config.get('defaultAccessLevel', 'ask-permission') as Settings['accessLevel'],
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model,
      provider,
    };

    // Build usage from CompactionManager's tracked data
    const tracked = this._compactionManager.getUsage(panelId);
    const usage: UsageStats = {
      input_tokens: tracked?.totalInputTokens || 0,
      output_tokens: tracked?.totalOutputTokens || 0,
      cache_read_input_tokens: tracked?.totalCacheReadTokens || 0,
      cache_creation_input_tokens: tracked?.totalCacheCreationTokens || 0,
    };

    console.log(`[Mysti] Manual compaction requested for panel ${panelId}`);
    await this._executeCompaction(panelId, settings, conversation, usage, contextWindow);
  }

  private async _executeCompaction(
    panelId: string,
    settings: Settings,
    conversation: Conversation | null,
    usage: UsageStats,
    contextWindow: number,
  ): Promise<void> {
    const strategy = this._compactionManager.getStrategy(settings.provider, this._providerManager);
    const beforeTokens = usage.input_tokens + (usage.cache_read_input_tokens || 0);

    // Notify webview that compaction is starting
    this._postToPanel(panelId, {
      type: 'compactionStatus',
      payload: {
        status: 'compacting',
        strategy,
        beforeTokens,
        contextWindow,
        threshold: this._compactionManager.getThreshold(),
      } as CompactionEvent,
    });

    try {
      if (strategy === 'native-cli') {
        // Native /compact: send the command to the CLI
        console.log(`[Mysti] Executing native /compact for panel ${panelId}`);
        const stream = this._compactionManager.executeNativeCompaction(
          this._providerManager, settings, conversation, panelId
        );

        // Process the compact response stream — capture text and usage
        let afterTokens: number | undefined;
        const summaryParts: string[] = [];
        for await (const chunk of stream) {
          if (chunk.type === 'text' && chunk.content) {
            summaryParts.push(chunk.content);
          }
          if (chunk.type === 'done' && chunk.usage) {
            const tokens = chunk.usage.input_tokens + (chunk.usage.cache_read_input_tokens || 0);
            if (tokens > 0) {
              afterTokens = tokens;
            }
          }
        }
        const summary = summaryParts.join('').trim();

        this._postToPanel(panelId, {
          type: 'compactionStatus',
          payload: {
            status: 'complete',
            strategy,
            beforeTokens,
            afterTokens,
            contextWindow,
            threshold: this._compactionManager.getThreshold(),
            summary: summary || undefined,
          } as CompactionEvent,
        });

        // Update webview context usage with post-compaction tokens
        if (afterTokens !== undefined && afterTokens > 0) {
          this._postToPanel(panelId, {
            type: 'contextWindowInfo',
            payload: { contextWindow },
          });
          this._compactionManager.updateUsageAfterCompaction(panelId, afterTokens);
        } else {
          // Native CLI /compact returns zero usage; reset tracking so
          // next response re-populates with accurate post-compaction tokens
          this._compactionManager.resetUsage(panelId);
        }

        console.log(`[Mysti] Native compaction complete: ${beforeTokens} -> ${afterTokens ?? '?'} tokens`);

      } else {
        // Client-side summarization
        if (!conversation) {
          console.warn('[Mysti] Cannot perform client-side compaction without conversation');
          return;
        }

        const result = await this._compactionManager.executeClientSummarization(
          this._providerManager,
          this._conversationManager,
          settings,
          conversation,
          panelId,
        );

        this._postToPanel(panelId, {
          type: 'compactionStatus',
          payload: {
            status: result.success ? 'complete' : 'error',
            strategy,
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
            contextWindow,
            threshold: this._compactionManager.getThreshold(),
            error: result.error,
          } as CompactionEvent,
        });

        if (result.success) {
          this._compactionManager.updateUsageAfterCompaction(panelId, result.afterTokens);
          console.log(`[Mysti] Client-side compaction: ${result.beforeTokens} -> ${result.afterTokens} tokens (${result.duration}ms)`);
        } else {
          console.warn(`[Mysti] Client-side compaction failed: ${result.error}`);
        }
      }
    } catch (error) {
      console.error('[Mysti] Compaction failed:', error);
      this._postToPanel(panelId, {
        type: 'compactionStatus',
        payload: {
          status: 'error',
          strategy,
          beforeTokens,
          contextWindow,
          threshold: this._compactionManager.getThreshold(),
          error: error instanceof Error ? error.message : 'Unknown compaction error',
        } as CompactionEvent,
      });
    }
  }

  /**
   * Generate conversation title asynchronously using AI
   */
  private async _generateTitleAsync(conversationId: string, userMessage: string, panelId?: string) {
    try {
      const title = await this._suggestionManager.generateTitle(userMessage);
      this._conversationManager.updateConversationTitle(conversationId, title);
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'titleUpdated',
          payload: { conversationId, title }
        });
      } else {
        this.postMessage({
          type: 'titleUpdated',
          payload: { conversationId, title }
        });
      }
    } catch (error) {
      console.error('[Mysti] Failed to generate title:', error);
    }
  }

  /**
   * Handle brainstorm mode messages
   */
  private async _handleBrainstormMessage(
    payload: {
      content: string;
      context: ContextItem[];
      settings: Settings;
    },
    panelId: string
  ) {
    // Clear cancel flag for this panel
    this._cancelledPanels.delete(panelId);
    const { content, context, settings } = payload;

    // Get the panel's conversation
    const panelState = this._panelStates.get(panelId);
    const conversationId = panelState?.currentConversationId;

    // Add user message to this panel's conversation
    const userMessage = this._conversationManager.addMessageToConversation(
      conversationId,
      'user',
      content,
      context
    );
    this._postToPanel(panelId, {
      type: 'messageAdded',
      payload: userMessage
    });

    // Generate AI title for first user message
    if (conversationId && this._conversationManager.isFirstUserMessage(conversationId)) {
      this._generateTitleAsync(conversationId, content, panelId);
    }

    // Start brainstorm session
    this._postToPanel(panelId, {
      type: 'brainstormStarted',
      payload: {
        sessionId: panelId,
        query: content,
        agents: this._brainstormManager.getCurrentSession(panelId)?.agents || [],
        strategy: this._brainstormManager.getCurrentSession(panelId)?.strategy || 'quick'
      }
    });

    try {
      // Pass panelId for per-panel session tracking
      const stream = this._brainstormManager.startBrainstormSession(
        content,
        context,
        settings,
        panelId
      );

      for await (const chunk of stream) {
        // Check if THIS panel's request was cancelled
        if (this._cancelledPanels.has(panelId)) {break;}

        switch (chunk.type) {
          case 'phase_change':
            this._postToPanel(panelId, {
              type: 'brainstormPhaseChange',
              payload: { phase: chunk.phase, strategy: chunk.strategy }
            });
            break;

          case 'agent_text':
            this._postToPanel(panelId, {
              type: 'brainstormAgentChunk',
              payload: { agentId: chunk.agentId, content: chunk.content, type: 'text' }
            });
            break;

          case 'agent_thinking':
            this._postToPanel(panelId, {
              type: 'brainstormAgentChunk',
              payload: { agentId: chunk.agentId, content: chunk.content, type: 'thinking' }
            });
            break;

          case 'agent_complete':
            // Record per-agent usage for compaction tracking
            if (chunk.usage && chunk.agentId) {
              const agentPanelId = `${panelId}-brainstorm-${chunk.agentId}`;
              const agentContextWindow = this._providerManager.getModelContextWindow(
                chunk.agentId, this._providerManager.getProviderDefaultModel(chunk.agentId)
              );
              this._compactionManager.recordUsage(agentPanelId, chunk.usage, agentContextWindow);
            }
            this._postToPanel(panelId, {
              type: 'brainstormAgentComplete',
              payload: { agentId: chunk.agentId }
            });
            break;

          case 'agent_error':
            this._postToPanel(panelId, {
              type: 'brainstormAgentError',
              payload: { agentId: chunk.agentId, error: chunk.content }
            });
            break;

          case 'discussion_text':
            this._postToPanel(panelId, {
              type: 'brainstormDiscussionChunk',
              payload: { agentId: chunk.agentId, content: chunk.content, role: chunk.discussionRole, roundNumber: chunk.roundNumber }
            });
            break;

          case 'discussion_round_start':
            this._postToPanel(panelId, {
              type: 'brainstormDiscussionRoundStart',
              payload: { roundNumber: chunk.roundNumber, role: chunk.discussionRole, label: chunk.content, agentId: chunk.agentId }
            });
            break;

          case 'convergence_update':
            this._postToPanel(panelId, {
              type: 'brainstormConvergenceUpdate',
              payload: { convergence: chunk.convergence, roundNumber: chunk.roundNumber }
            });
            break;

          case 'discussion_error':
            this._postToPanel(panelId, {
              type: 'brainstormDiscussionError',
              payload: { agentId: chunk.agentId, error: chunk.content, role: chunk.discussionRole, roundNumber: chunk.roundNumber }
            });
            break;

          case 'synthesis_text':
            this._postToPanel(panelId, {
              type: 'brainstormSynthesisChunk',
              payload: { content: chunk.content }
            });
            break;

          case 'synthesis_fallback':
            // B3: Show fallback notice in the synthesis area
            this._postToPanel(panelId, {
              type: 'brainstormSynthesisChunk',
              payload: { content: `*${chunk.content}*\n\n` }
            });
            break;

          case 'done': {
            const session = this._brainstormManager.getCurrentSession(panelId);
            // Track engagement: brainstorm completed
            const brainstormStrategy = session?.strategy || 'quick';
            this._emitBadgeUnlocks(panelId, this._engagementManager.trackBrainstormCompleted(brainstormStrategy));

            // Add unified solution as assistant message
            if (session?.unifiedSolution) {
              const assistantMessage = this._conversationManager.addMessageToConversation(
                conversationId,
                'assistant',
                session.unifiedSolution
              );
              this._postToPanel(panelId, {
                type: 'brainstormComplete',
                payload: {
                  unifiedSolution: session.unifiedSolution,
                  message: assistantMessage
                }
              });
              // Generate quick action suggestions for brainstorm result
              this._generateSuggestionsAsync(assistantMessage, panelId);
            } else {
              this._postToPanel(panelId, { type: 'brainstormComplete', payload: {} });
            }
            break;
          }
        }
      }
    } catch (error) {
      this._postToPanel(panelId, {
        type: 'brainstormError',
        payload: { error: error instanceof Error ? error.message : 'An unknown error occurred' }
      });
    }
  }

  private async _handleUpdateSettings(settings: Partial<Settings>, panelId?: string) {
    const config = vscode.workspace.getConfiguration('mysti');

    if (settings.mode !== undefined) {
      await config.update('defaultMode', settings.mode, vscode.ConfigurationTarget.Global);
    }
    if (settings.thinkingLevel !== undefined) {
      await config.update('defaultThinkingLevel', settings.thinkingLevel, vscode.ConfigurationTarget.Global);
    }
    if (settings.accessLevel !== undefined) {
      await config.update('accessLevel', settings.accessLevel, vscode.ConfigurationTarget.Global);
    }
    if (settings.contextMode !== undefined) {
      await config.update('autoContext', settings.contextMode === 'auto', vscode.ConfigurationTarget.Global);
      this._contextManager.setAutoContext(settings.contextMode === 'auto');
    }
    if (settings.model !== undefined) {
      if (panelId) {
        // Store per-panel — don't contaminate other panels
        const panelState = this._panelStates.get(panelId);
        if (panelState) {
          if (!panelState.settingsOverrides) { panelState.settingsOverrides = {}; }
          panelState.settingsOverrides.model = settings.model;
        }
      } else {
        await config.update('defaultModel', settings.model, vscode.ConfigurationTarget.Global);
      }
    }
    if (settings.provider !== undefined) {
      // Capture the provider the panel was on BEFORE applying the switch, so the
      // auto-switch below can distinguish an old-provider built-in model (safe to
      // replace) from a user's hand-typed / custom model (keep it).
      const previousProvider = panelId ? this._getPanelProvider(panelId) : config.get<string>('defaultProvider', DEFAULT_PROVIDER);
      if (panelId) {
        // Store per-panel — don't contaminate other panels
        const panelState = this._panelStates.get(panelId);
        if (panelState) {
          if (!panelState.settingsOverrides) { panelState.settingsOverrides = {}; }
          panelState.settingsOverrides.provider = settings.provider;
        }
      } else {
        await config.update('defaultProvider', settings.provider, vscode.ConfigurationTarget.Global);
      }

      // Auto-switch to a compatible model for the new provider — but only when
      // the current model is a stale OLD-provider built-in (#39/Plan 01 §4.2):
      // a model the user hand-typed or declared as custom is preserved across
      // the switch instead of being clobbered with the new provider's default.
      const newProviderConfig = this._providerManager.getProvider(settings.provider);
      if (newProviderConfig) {
        const currentModel = panelId ? this._getPanelModel(panelId) : config.get<string>('defaultModel', '');
        const validModels = this._providerManager.getModels(settings.provider).map(m => m.id);
        const customModels = config.get<Record<string, string[]>>('customModels', {});
        const isCustomForNew = Array.isArray(customModels?.[settings.provider]) && customModels[settings.provider].includes(currentModel);
        const wasOldProviderBuiltin = this._providerManager.getModels(previousProvider).some(m => m.id === currentModel);
        const needsSwitch = !validModels.includes(currentModel) && !isCustomForNew && wasOldProviderBuiltin;

        // If current model is a stale old-provider built-in, switch to the new provider's default
        if (needsSwitch) {
          const newModel = newProviderConfig.defaultModel;
          if (panelId) {
            const panelState = this._panelStates.get(panelId);
            if (panelState) {
              if (!panelState.settingsOverrides) { panelState.settingsOverrides = {}; }
              panelState.settingsOverrides.model = newModel;
            }
          } else {
            await config.update('defaultModel', newModel, vscode.ConfigurationTarget.Global);
          }
          console.log(`[Mysti] Auto-switched model to ${newModel} for ${settings.provider}`);

          // Notify only the originating panel of the model change
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'modelChanged',
              payload: { model: newModel, provider: settings.provider }
            });
          } else {
            this.postMessage({
              type: 'modelChanged',
              payload: { model: newModel, provider: settings.provider }
            });
          }
        }
      }
    }

    // Handle custom model updates per provider.
    // Plan 02 Phase 2 (C1): the setting key comes from the Provider Manifest —
    // the same lookup the read side uses in _sendInitialState — replacing the
    // duplicated write-side providerModelKeys map whose drift silently
    // dropped 'qwen-code' custom models.
    const settingsAny = settings as Record<string, unknown>;
    if ('customModel' in settingsAny) {
      const customModel = settingsAny['customModel'] as string;
      const provider = settings.provider || config.get<string>('defaultProvider', DEFAULT_PROVIDER);
      const settingKey = getCustomModelSettingKey(provider);
      if (settingKey) {
        if (!customModel) {
          // Empty string clears the custom model
          await config.update(settingKey, '', vscode.ConfigurationTarget.Global);
          console.log(`[Mysti] Cleared custom model for ${provider}`);
        } else {
          const validation = validateModelName(customModel);
          if (validation.valid) {
            await config.update(settingKey, customModel, vscode.ConfigurationTarget.Global);
            console.log(`[Mysti] Set custom model for ${provider}: ${customModel}`);
          } else {
            console.warn(`[Mysti] Invalid custom model "${customModel}": ${validation.error}`);
            this.postMessage({ type: 'settingsError', payload: { error: validation.error || 'Invalid model name' } });
          }
        }
      }
    }

    // Handle Codex profile updates
    if ('codexProfile' in settingsAny) {
      const profile = settingsAny['codexProfile'] as string;
      if (!profile) {
        await config.update('codexProfile', '', vscode.ConfigurationTarget.Global);
        console.log('[Mysti] Cleared Codex profile');
      } else {
        const validation = validateProfileName(profile);
        if (validation.valid) {
          await config.update('codexProfile', profile, vscode.ConfigurationTarget.Global);
          console.log(`[Mysti] Set Codex profile: ${profile}`);
        } else {
          console.warn(`[Mysti] Invalid Codex profile "${profile}": ${validation.error}`);
          this.postMessage({ type: 'settingsError', payload: { error: validation.error || 'Invalid profile name' } });
        }
      }
    }

    // Handle agent settings (passed with dot notation keys)
    if ('agents.autoSuggest' in settingsAny) {
      await config.update('agents.autoSuggest', settingsAny['agents.autoSuggest'], vscode.ConfigurationTarget.Global);
    }
    if ('agents.maxTokenBudget' in settingsAny) {
      await config.update('agents.maxTokenBudget', settingsAny['agents.maxTokenBudget'], vscode.ConfigurationTarget.Global);
    }
    if ('showSuggestions' in settingsAny) {
      await config.update('showSuggestions', settingsAny['showSuggestions'], vscode.ConfigurationTarget.Global);
    }

    // Handle brainstorm agent selection
    if ('brainstorm.agents' in settingsAny) {
      const agents = settingsAny['brainstorm.agents'] as string[];
      // Validate: exactly 2 agents from the registry (C2 — no hard-coded list)
      const validAgents: string[] = this._providerManager.getAllProviderIds();
      const filtered = agents.filter(a => validAgents.includes(a));
      if (filtered.length === 2) {
        await config.update('brainstorm.agents', filtered, vscode.ConfigurationTarget.Global);
        console.log(`[Mysti] Updated brainstorm agents to: ${filtered.join(', ')}`);
      }
    }

    // Handle brainstorm strategy selection
    if ('brainstorm.strategy' in settingsAny) {
      const strategy = settingsAny['brainstorm.strategy'] as string;
      const validStrategies = ['quick', 'debate', 'red-team', 'perspectives', 'delphi'];
      if (validStrategies.includes(strategy)) {
        await config.update('brainstorm.strategy', strategy, vscode.ConfigurationTarget.Global);
        console.log(`[Mysti] Updated brainstorm strategy to: ${strategy}`);
      }
    }

    // Handle permission timeout behavior
    if ('permission.timeoutBehavior' in settingsAny) {
      const behavior = settingsAny['permission.timeoutBehavior'] as string;
      const validBehaviors = ['auto-accept', 'auto-reject', 'require-action', 'semi-autonomous'];
      if (validBehaviors.includes(behavior)) {
        await config.update('permission.timeoutBehavior', behavior, vscode.ConfigurationTarget.Global);
        this._permissionManager.refreshConfig();
        console.log(`[Mysti] Updated permission timeout behavior to: ${behavior}`);
      }
    }

    // Handle semi-autonomous timeout
    if ('semiAutonomous.timeout' in settingsAny) {
      const timeout = settingsAny['semiAutonomous.timeout'] as number;
      if (timeout >= 10 && timeout <= 300) {
        await config.update('semiAutonomous.timeout', timeout, vscode.ConfigurationTarget.Global);
        this._permissionManager.refreshConfig();
        console.log(`[Mysti] Updated semi-autonomous timeout to: ${timeout}s`);
      }
    }

    // Pre-spawn persistent process when provider, model, or spawn-affecting settings change
    if (settings.provider !== undefined || settings.model !== undefined ||
        settings.mode !== undefined || settings.accessLevel !== undefined ||
        settings.thinkingLevel !== undefined) {
      const pid = panelId || this._lastActivePanelId;
      if (pid) {
        this._tryPreSpawnPersistentProcess(pid);
      }
    }

  }

  /**
   * Pre-spawn a persistent CLI process for the active provider on a panel.
   * Called when provider/model/mode changes so the process is warm before the user sends a message.
   */
  private _tryPreSpawnPersistentProcess(panelId: string): void {
    const providerType = this._getPanelProvider(panelId) as Settings['provider'];
    const provider = this._providerManager.getProviderInstance(providerType);
    if (!provider?.capabilities.supportsPersistentProcess) {
      return;
    }
    if (typeof provider.preSpawnPersistentProcess !== 'function') {
      return;
    }

    const config = vscode.workspace.getConfiguration('mysti');
    const settings: Settings = {
      mode: config.get('defaultMode', 'default') as Settings['mode'],
      thinkingLevel: config.get('defaultThinkingLevel', 'none') as Settings['thinkingLevel'],
      accessLevel: config.get('accessLevel', 'ask-permission') as Settings['accessLevel'],
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: this._getPanelModel(panelId),
      provider: providerType
    };

    provider.preSpawnPersistentProcess(panelId, settings).catch((err: unknown) => {
      console.error(`[Mysti] Pre-spawn persistent process failed:`, err);
    });
  }

  private async _handleRequestFileAttachment(panelId?: string) {
    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      title: 'Select files to attach'
    });

    if (!fileUris || fileUris.length === 0) {
      return;
    }

    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
    const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
    const attachments: Attachment[] = [];

    for (const fileUri of fileUris) {
      try {
        const filePath = fileUri.fsPath;
        const fileName = path.basename(filePath);
        const stat = await fs.promises.stat(filePath);

        if (stat.size > MAX_FILE_SIZE) {
          console.log(`[Mysti] Skipping oversized file: ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
          continue;
        }

        const buffer = await fs.promises.readFile(filePath);
        const base64Data = buffer.toString('base64');
        const ext = path.extname(fileName).slice(1).toLowerCase();
        const isImage = IMAGE_EXTENSIONS.includes(ext);

        attachments.push({
          id: `att-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
          type: isImage ? 'image' : 'file',
          fileName,
          mimeType: isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream',
          base64Data,
          filePath,
          size: stat.size
        });
      } catch (error) {
        console.error(`[Mysti] Error reading file ${fileUri.fsPath}:`, error);
      }
    }

    if (panelId && attachments.length > 0) {
      this._postToPanel(panelId, {
        type: 'fileAttachmentSelected',
        payload: { attachments }
      });
    }
  }

  private async _handleAddToContext(
    payload: { path: string; type: string },
    panelId?: string
  ) {
    if (payload.type === 'file') {
      await this._contextManager.addFileToContext(payload.path, panelId);
    } else if (payload.type === 'folder') {
      await this._contextManager.addFolderToContext(payload.path, panelId);
    }
    if (panelId) {
      this._postToPanel(panelId, {
        type: 'contextUpdated',
        payload: this._contextManager.getContext(panelId)
      });
    }
  }

  /**
   * Build callbacks that the SlashCommandManager needs to interact with
   * ChatViewProvider internals (posting messages, updating settings, etc.)
   */
  private _getSlashCommandCallbacks(): SlashCommandCallbacks {
    return {
      postToPanel: (pid: string, msg: WebviewMessage) => this._postToPanel(pid, msg),
      updateSettings: (settings: Record<string, unknown>, pid?: string) =>
        this._handleUpdateSettings(settings as Partial<Settings>, pid),
      getPanelProvider: (pid: string) => this._getPanelProvider(pid),
      getPanelModel: (pid: string) => this._getPanelModel(pid),
      // Plan 01 Phase 1: registry-backed merged model list (curated + discovered
      // + custom) so the /model QuickPick matches the dropdown.
      getModelsForProvider: (providerId: string) => this._modelRegistry.getModels(providerId).models,
      // C7: provider-neutral /compact — CompactionManager picks native-cli
      // vs client-summarize from the provider's supportsNativeCompact flag.
      executeManualCompaction: (pid: string) => this._handleManualCompact(pid),
    };
  }

  private async _handleSlashCommand(
    payload: { command?: string; commandId?: string; args?: string },
    panelId?: string
  ) {
    if (!panelId) {return;}
    // Support both old format {command} and new format {commandId}
    const commandId = payload.commandId || this._slashCommandManager.mapLegacyCommand(payload.command || '');
    const callbacks = this._getSlashCommandCallbacks();
    const result = await this._slashCommandManager.executeCommand(
      commandId, payload.args || '', panelId, callbacks
    );
    if (result) {
      this._postToPanel(panelId, {
        type: 'slashCommandResult',
        payload: { command: commandId, result }
      });
    }
  }

  private async _handleQuickAction(actionId: string, panelId?: string) {
    const actions = this._getQuickActions();
    const action = actions.find(a => a.id === actionId);
    if (action && panelId) {
      this._postToPanel(panelId, {
        type: 'insertPrompt',
        payload: action.prompt
      });
    }
  }

  private async _handleExecuteSuggestion(
    suggestion: QuickActionSuggestion,
    panelId?: string
  ) {
    if (!panelId) {return;}

    // Detect mode change suggestions
    const lowerMessage = suggestion.message.toLowerCase();

    // Check if this is an "exit plan mode" suggestion
    if (lowerMessage.includes('exit plan mode') ||
        lowerMessage.includes('exit planning') ||
        lowerMessage.includes('leave plan mode')) {

      // Auto-detect and execute mode change
      const config = vscode.workspace.getConfiguration('mysti');
      const currentMode = config.get<string>('defaultMode');
      const currentProvider = this._getPanelProvider(panelId);

      if (currentMode === 'quick-plan' || currentMode === 'detailed-plan') {
        console.log(`[Mysti] Auto-exiting ${currentMode} mode via suggestion (provider: ${currentProvider})`);

        // Clear any pending plan options or questions from UI
        this._postToPanel(panelId, { type: 'clearPlanOptions' });
        this._postToPanel(panelId, { type: 'clearSuggestions' });

        // Update mode setting
        this._handleUpdateSettings({ mode: 'ask-before-edit' });

        // Broadcast mode change to all panels
        this.postMessage({
          type: 'modeChanged',
          payload: { mode: 'ask-before-edit' }
        });

        // Show confirmation message
        this._postToPanel(panelId, {
          type: 'info',
          payload: `Exited ${currentMode}. Switched to: ask-before-edit\n(Ready for implementation with ${currentProvider})`
        });
        return; // Don't insert text, just change mode
      }
    }

    // Default behavior: insert prompt text
    this._postToPanel(panelId, {
      type: 'insertPrompt',
      payload: suggestion.message
    });
  }

  private async _generateSuggestionsAsync(lastMessage: Message, panelId?: string) {
    // Don't generate suggestions if this panel's request was cancelled
    if (panelId && this._cancelledPanels.has(panelId)) {return;}

    // Get conversation for this panel or fallback to current
    let conversation;
    if (panelId) {
      const panelState = this._panelStates.get(panelId);
      const conversationId = panelState?.currentConversationId;
      conversation = conversationId
        ? this._conversationManager.getConversation(conversationId)
        : null;
    } else {
      conversation = this._conversationManager.getCurrentConversation();
    }
    if (!conversation) {return;}

    // Notify UI to show loading skeleton - route to specific panel if provided
    if (panelId) {
      this._postToPanel(panelId, { type: 'suggestionsLoading' });
    } else {
      this.postMessage({ type: 'suggestionsLoading' });
    }

    try {
      const suggestions = await this._suggestionManager.generateSuggestions(
        conversation,
        lastMessage
      );

      if (panelId) {
        this._postToPanel(panelId, {
          type: 'suggestionsReady',
          payload: { suggestions }
        });
      } else {
        this.postMessage({
          type: 'suggestionsReady',
          payload: { suggestions }
        });
      }
    } catch (error) {
      console.error('[Mysti] Suggestion generation failed:', error);
      if (panelId) {
        this._postToPanel(panelId, { type: 'suggestionsError' });
      } else {
        this.postMessage({ type: 'suggestionsError' });
      }
    }
  }

  private async _handleEnhancePrompt(prompt: string, panelId?: string) {
    try {
      // Send to AI to enhance the prompt
      const enhancedPrompt = await this._providerManager.enhancePrompt(prompt);
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'promptEnhanced',
          payload: enhancedPrompt
        });
      }
    } catch (error) {
      console.error('[Mysti] Error enhancing prompt:', error);
      // Send error message to reset the UI
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'promptEnhanceError',
          payload: error instanceof Error ? error.message : 'Failed to enhance prompt'
        });
      }
    }
  }

  private async _handlePermissionRequest(
    payload: { action: string; details: string },
    panelId?: string
  ) {
    const result = await vscode.window.showInformationMessage(
      `Mysti wants to ${payload.action}: ${payload.details}`,
      { modal: true },
      'Allow',
      'Deny'
    );
    if (panelId) {
      this._postToPanel(panelId, {
        type: 'permissionResult',
        payload: { action: payload.action, allowed: result === 'Allow' }
      });
    }
  }

  /**
   * Handle permission response from the webview
   * This is called when user responds to an inline permission card
   */
  private _handlePermissionResponse(response: PermissionResponse): void {
    console.log('[Mysti] Permission response received:', response);
    // B15: read the pending request BEFORE handleResponse() — it deletes the
    // request from the pending map, so reading afterwards always returned
    // undefined and permission-decision learning never ran.
    const request = this._permissionManager.getPendingRequest(response.requestId);

    this._permissionManager.handleResponse(response);

    // Learn from the user's permission decision (passive memory building)
    if (request) {
      this._memoryManager.learnFromPermissionDecision(request, response);
    }
  }

  /**
   * Handle semi-autonomous permission timeout.
   * Uses AutonomousManager to make an intelligent decision when the user
   * doesn't respond to a permission request within the timeout.
   */
  private _handleSemiAutonomousPermissionTimeout(
    requestId: string,
    postToWebview: (msg: unknown) => void
  ): void {
    const request = this._permissionManager.getPendingRequest(requestId);
    if (!request || request.status !== 'pending') {
      return;
    }

    // Use AutonomousManager for an intelligent decision
    const decision = this._autonomousManager.shouldAutoApprovePermission(request);

    // If AutonomousManager returns 'require-user', default to deny
    // (the user already had their chance during the countdown)
    const approved = decision.decision === 'require-user'
      ? false
      : decision.type === 'permission-approve';

    // Notify webview of the AI decision
    postToWebview({
      type: 'semiAutonomousDecision',
      payload: {
        requestId,
        targetType: 'permission',
        approved,
        reasoning: decision.reasoning,
        safetyLevel: decision.safetyLevel,
      }
    });

    // Learn from this decision
    this._memoryManager.learnFromPermissionDecision(request, {
      requestId,
      decision: approved ? 'approve' : 'deny',
    });

    // Resolve the permission promise
    this._permissionManager.resolveSemiAutonomous(requestId, approved);

    console.log(`[Mysti] Semi-autonomous permission decision: ${requestId} -> ${approved ? 'approved' : 'denied'} (${decision.reasoning})`);
  }

  /**
   * Handle semi-autonomous question timeout.
   * Uses AutonomousManager to answer when user doesn't respond in time.
   */
  private async _handleSemiAutonomousQuestionTimeout(
    panelId: string,
    question: AskUserQuestionData
  ): Promise<void> {
    // Check if user already answered
    if (!this._pendingAskUserQuestions.has(panelId)) {
      return;
    }

    this._semiAutoQuestionTimeouts.delete(question.toolCallId);

    // Try AutonomousManager's intelligent answer
    const autoResult = this._autonomousManager.generateAutoAnswer(question);

    let answers: Record<string, string | string[]>;
    let reasoning: string;

    if (autoResult) {
      answers = autoResult.answers;
      reasoning = autoResult.decision.reasoning;
    } else {
      // Fallback: select first option for each question
      answers = {};
      for (const q of question.questions) {
        if (q.options && q.options.length > 0) {
          answers[q.header] = q.multiSelect ? [q.options[0].label] : q.options[0].label;
        }
      }
      reasoning = 'AI could not determine a confident answer; selected first available option as fallback';
    }

    // Notify webview of the AI decision
    this._postToPanel(panelId, {
      type: 'semiAutonomousDecision',
      payload: {
        requestId: question.toolCallId,
        targetType: 'question',
        approved: true,
        reasoning,
        safetyLevel: 'caution',
      }
    });

    // Submit the answer as if the user responded
    this._pendingQuestionData.delete(question.toolCallId);
    await this._handleAskUserQuestionResponse(
      { toolCallId: question.toolCallId, answers },
      panelId,
      question
    );

    console.log(`[Mysti] Semi-autonomous question answer: ${question.toolCallId} (${reasoning})`);
  }

  /**
   * Handle semi-autonomous timeout for plan option selection.
   * Auto-selects the first plan option with edit-automatically mode.
   */
  private async _handleSemiAutonomousPlanTimeout(
    panelId: string,
    syntheticPlanId: string
  ): Promise<void> {
    // Check if user already selected a plan
    if (!this._pendingPlanSelections.has(panelId)) {
      return;
    }

    this._semiAutoPlanTimeouts.delete(syntheticPlanId);
    const planData = this._pendingPlanData.get(syntheticPlanId);
    if (!planData) {
      return;
    }

    // Auto-select first plan with edit-automatically mode
    const selectedPlan = planData.options[0];
    const reasoning = `AI auto-selected "${selectedPlan.title}" after semi-autonomous timeout`;

    // Notify webview of AI decision
    this._postToPanel(panelId, {
      type: 'semiAutonomousDecision',
      payload: {
        requestId: syntheticPlanId,
        targetType: 'plan',
        approved: true,
        reasoning,
        safetyLevel: 'caution',
      }
    });

    // Clean up pending state
    this._pendingPlanData.delete(syntheticPlanId);
    this._pendingPlanSelections.delete(panelId);

    // Execute the auto-selected plan
    await this._handlePlanOptionSelected(
      { selectedPlan, originalQuery: planData.originalQuery, messageId: planData.messageId, executionMode: 'edit-automatically', customInstructions: '' },
      panelId
    );

    console.log(`[Mysti] Semi-autonomous plan selection: ${selectedPlan.title} (${reasoning})`);
  }

  /**
   * Check if semi-autonomous mode is enabled via permission timeout behavior setting
   */
  private _isSemiAutonomousEnabled(panelId: string): boolean {
    return this._panelAutonomyLevel.get(panelId) === 'semi-autonomous';
  }

  /**
   * Get the configured semi-autonomous timeout in seconds
   */
  private _getSemiAutonomousTimeout(): number {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<number>('semiAutonomous.timeout', SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S);
  }

  /**
   * Request permission for an action and show inline card in webview
   * Returns a promise that resolves when user responds or timeout occurs
   */
  public async requestPermissionInline(
    actionType: import('../types').PermissionActionType,
    title: string,
    description: string,
    details: import('../types').PermissionDetails,
    panelId: string,
    toolCallId?: string
  ): Promise<boolean> {
    // Autonomous mode: try to auto-decide on permission
    if (this._autonomousManager.isActive()) {
      const request = {
        id: `auto_${Date.now()}`,
        actionType,
        title,
        description,
        details,
        status: 'pending' as const,
        createdAt: Date.now(),
        expiresAt: 0,
        toolCallId,
      };
      const decision = this._autonomousManager.shouldAutoApprovePermission(request);

      // If not 'require-user' (i.e., safe auto-approve, auto-deny, or blocked)
      if (decision.decision !== 'require-user') {
        this._postToPanel(panelId, {
          type: 'autonomousDecision',
          payload: decision
        });
        return decision.type === 'permission-approve';
      }
      // Fall through to normal permission flow for caution/require-user
    }

    return this._permissionManager.requestPermission(
      actionType,
      title,
      description,
      details,
      (message) => this._postToPanel(panelId, message as WebviewMessage),
      toolCallId
    );
  }

  /**
   * Get the permission manager instance
   */
  public get permissionManager(): PermissionManager {
    return this._permissionManager;
  }

  /**
   * Classify a tool name into a PermissionActionType.
   * Delegates to the extracted pure function in utils/permissionClassifier.
   */
  private _classifyToolAction(toolName: string): import('../types').PermissionActionType {
    return classifyToolAction(toolName);
  }

  /**
   * Determine if a tool_use should be gated with a permission card.
   * Delegates to the extracted pure function in utils/permissionClassifier.
   *
   * B13: During autonomous sessions (initial turn AND continuations) the gate
   * must stay ACTIVE regardless of the mode/access settings — autonomous
   * continuations previously forced edit-automatically + full-access, which
   * made shouldGateToolUse() return false for everything and bypassed the
   * SafetyClassifier entirely. We keep the gate active for every write/bash
   * tool (anything that isn't read-only) so requestPermissionInline() routes
   * each one through AutonomousManager.shouldAutoApprovePermission (which calls
   * the SafetyClassifier: auto-approve 'safe', block 'blocked', honor the
   * configured safety mode for 'caution'). Read-only tools still skip the gate.
   */
  private _shouldGateToolUse(settings: Settings, toolName: string): boolean {
    if (settings.autonomousMode) {
      // Read-only operations are never gated; everything else flows through
      // the SafetyClassifier-backed autonomous decision path.
      return this._classifyToolAction(toolName) !== 'file-read';
    }
    return shouldGateToolUse(settings, toolName);
  }

  /**
   * Convert text-detected ClarifyingQuestions into AskUserQuestionData format
   * so they can be routed through the same UI and handling path as explicit questions.
   */
  private _convertClarifyingToAuq(
    questions: ClarifyingQuestion[],
    messageId: string
  ): AskUserQuestionData {
    const syntheticToolCallId = `detected-${messageId}-${Date.now()}`;

    const convertedQuestions: AskUserQuestionItem[] = questions.map(q => ({
      question: q.question,
      header: q.question,
      options: (q.options || []).map(opt => ({
        label: opt.label,
        description: opt.description || ''
      })),
      multiSelect: q.inputType === 'checkbox',
    }));

    return {
      toolCallId: syntheticToolCallId,
      questions: convertedQuestions,
      source: 'detected',
      messageId,
    };
  }

  /**
   * Handle text-detected questions through the unified AskUserQuestion path.
   * Supports autonomous auto-answer, semi-autonomous timeout, and the tabbed UI.
   */
  private async _handleDetectedQuestions(
    auqData: AskUserQuestionData,
    panelId: string
  ): Promise<void> {
    // Autonomous mode: try to auto-answer
    if (this._autonomousManager.isActive()) {
      const autoResult = this._autonomousManager.generateAutoAnswer(auqData);
      if (autoResult) {
        this._postToPanel(panelId, {
          type: 'autonomousDecision',
          payload: autoResult.decision
        });
        await this._handleAskUserQuestionResponse(
          { toolCallId: auqData.toolCallId, answers: autoResult.answers },
          panelId,
          auqData
        );
        return;
      }
      // Not confident enough — fall through to user UI
    }

    // Track pending question (blocks autonomous continuation)
    this._pendingAskUserQuestions.add(panelId);
    this._pendingQuestionData.set(auqData.toolCallId, auqData);

    // Send the tabbed question UI to webview (no toolUse message — no actual tool was called)
    this._postToPanel(panelId, {
      type: 'askUserQuestion',
      payload: auqData
    });

    // Semi-autonomous: set up timer for AI to answer if user doesn't respond
    if (this._isSemiAutonomousEnabled(panelId)) {
      const questionTimeout = this._getSemiAutonomousTimeout();
      const expiresAt = Date.now() + (questionTimeout * 1000);

      this._postToPanel(panelId, {
        type: 'semiAutonomousQuestionTimer',
        payload: {
          toolCallId: auqData.toolCallId,
          timeout: questionTimeout,
          expiresAt,
        }
      });

      const timeoutHandle = setTimeout(() => {
        this._handleSemiAutonomousQuestionTimeout(panelId, auqData);
      }, questionTimeout * 1000);
      this._semiAutoQuestionTimeouts.set(auqData.toolCallId, timeoutHandle);
    }
  }

  /**
   * Handle detected plan options with autonomous/semi-autonomous support.
   * Wraps existing plan option rendering with auto-selection and timeout logic.
   */
  private async _handleDetectedPlanOptions(
    options: PlanOption[],
    messageId: string,
    originalQuery: string,
    metaQuestions: ClarifyingQuestion[] | undefined,
    panelId: string,
    origin?: { source: 'exit-plan-mode'; planFilePath: string | null }
  ): Promise<void> {
    const syntheticPlanId = `plan-${messageId}-${Date.now()}`;

    // Autonomous mode: try to auto-select a plan
    if (this._autonomousManager.isActive()) {
      // Convert plan options to AskUserQuestionData for generateAutoAnswer()
      const auqForAutoSelect: AskUserQuestionData = {
        toolCallId: syntheticPlanId,
        questions: [{
          question: 'Which implementation approach should be used?',
          header: 'Approach',
          options: options.map(o => ({ label: o.title, description: o.summary })),
          multiSelect: false,
        }],
        source: 'detected',
      };

      const autoResult = this._autonomousManager.generateAutoAnswer(auqForAutoSelect);
      if (autoResult) {
        // Map selected title back to PlanOption
        const selectedTitle = autoResult.answers['Approach'] as string;
        const selectedPlan = options.find(o => o.title === selectedTitle) || options[0];

        this._postToPanel(panelId, { type: 'autonomousDecision', payload: autoResult.decision });
        await this._handlePlanOptionSelected(
          { selectedPlan, originalQuery, messageId, executionMode: 'edit-automatically', customInstructions: '' },
          panelId
        );
        return;
      }
      // Not confident — fall through to UI (will be blocked by pending state)
    }

    // Track pending plan selection (blocks autonomous continuation)
    this._pendingPlanSelections.add(panelId);
    this._pendingPlanData.set(syntheticPlanId, { options, messageId, originalQuery });

    // Send plan options to webview (existing rendering). Native exit-plan
    // routing (Plan 02 Phase 3.5) reuses this exact message shape, adding
    // source/planFilePath so the renderer can label the card; the webview
    // ignores fields it doesn't know.
    const planPayload: { options: PlanOption[]; messageId: string; originalQuery: string; syntheticPlanId: string; metaQuestions?: ClarifyingQuestion[]; source?: string; planFilePath?: string | null } = { options, messageId, originalQuery, syntheticPlanId };
    if (metaQuestions && metaQuestions.length > 0) {
      planPayload.metaQuestions = metaQuestions;
    }
    if (origin) {
      planPayload.source = origin.source;
      planPayload.planFilePath = origin.planFilePath;
    }
    this._postToPanel(panelId, { type: 'planOptions', payload: planPayload });

    // Semi-autonomous: set up timer for auto-selection
    if (this._isSemiAutonomousEnabled(panelId)) {
      const timeout = this._getSemiAutonomousTimeout();
      const expiresAt = Date.now() + (timeout * 1000);

      this._postToPanel(panelId, {
        type: 'semiAutonomousPlanTimer',
        payload: { syntheticPlanId, timeout, expiresAt }
      });

      const timeoutHandle = setTimeout(() => {
        this._handleSemiAutonomousPlanTimeout(panelId, syntheticPlanId);
      }, timeout * 1000);
      this._semiAutoPlanTimeouts.set(syntheticPlanId, timeoutHandle);
    }
  }

  /**
   * Plan 02 Phase 3 — thinking style for per-message persistence.
   * Returns the provider's declared thinkingStyle when it actually emits
   * thinking ('streamed' / 'complete-blocks'), undefined otherwise — the
   * done handler then falls back to the legacy plain-string thinking shape.
   */
  private _getThinkingStyleForProvider(provider: ProviderType): MessageThinkingStyle | undefined {
    const instance = this._providerManager.getProviderInstance(provider);
    const style = instance?.capabilities?.thinkingStyle;
    return (style === 'streamed' || style === 'complete-blocks') ? style : undefined;
  }

  /**
   * Plan 02 Phase 3.5 — route Claude's native exit_plan_mode into the
   * existing plan-selection flow.
   *
   * Builds a single PlanOption from the plan file the CLI wrote (when
   * planFilePath is present) or from the assistant's streamed response, then
   * reuses _handleDetectedPlanOptions so the webview receives the same
   * `planOptions` message it already renders — cards, planOptionSelected
   * round trip, autonomous auto-select, and semi-autonomous timers all work
   * unchanged. The payload additionally carries source: 'exit-plan-mode' and
   * planFilePath for renderer labeling.
   */
  private async _handleExitPlanMode(
    planFilePath: string | null,
    assistantMessage: Message,
    panelId: string
  ): Promise<void> {
    try {
      let planContent = '';
      if (planFilePath) {
        try {
          const resolved = path.isAbsolute(planFilePath)
            ? planFilePath
            : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', planFilePath);
          if (fs.existsSync(resolved)) {
            planContent = fs.readFileSync(resolved, 'utf-8').slice(0, EXIT_PLAN_FILE_MAX_CHARS);
          } else {
            console.log('[Mysti] exit_plan_mode plan file not found:', resolved);
          }
        } catch (readError) {
          console.log('[Mysti] Failed to read exit_plan_mode plan file:', readError);
        }
      }
      if (!planContent.trim()) {
        // No plan file (or unreadable): the streamed response is the plan
        planContent = assistantMessage.content;
      }
      if (!planContent.trim()) {
        console.log('[Mysti] exit_plan_mode with no plan content — skipping plan card');
        return;
      }

      const headingMatch = planContent.match(/^#{1,6}\s+(.+)$/m);
      const title = headingMatch ? headingMatch[1].trim() : 'Implementation Plan';
      const firstLine = planContent
        .split('\n')
        .map(line => line.trim())
        .find(line => line.length > 0 && !line.startsWith('#'));
      const summary = (firstLine || 'Plan ready for review.').slice(0, 200);

      const option: PlanOption = {
        id: `exit-plan-${assistantMessage.id}`,
        title,
        summary,
        approach: planContent,
        pros: [],
        cons: [],
        complexity: 'medium',
        icon: '📋',
        color: 'blue'
      };

      const originalQuery = this._lastUserMessage.get(panelId) || '';
      await this._handleDetectedPlanOptions(
        [option],
        assistantMessage.id,
        originalQuery,
        undefined,
        panelId,
        { source: 'exit-plan-mode', planFilePath }
      );
    } catch (error) {
      console.error('[Mysti] exit_plan_mode handling failed:', error);
    }
  }

  /**
   * Detect plan options and clarifying questions in an assistant message using AI classification
   * Returns true if interactive elements (questions or plans) were detected and sent
   */
  private async _detectAndSendPlanOptions(message: Message, panelId: string): Promise<boolean> {
    try {
      // Use AI-powered classification to distinguish questions from plan options
      const classifyStart = Date.now();
      const result = await this._planOptionManager.classifyResponse(message.content);
      console.log(`[Mysti] Classification completed in ${Date.now() - classifyStart}ms — questions: ${result.questions.length}, plans: ${result.planOptions.length}`);
      const originalQuery = this._lastUserMessage.get(panelId) || '';

      let hasInteractiveElements = false;

      // Separate questions by type
      const clarifyingQuestions = result.questions.filter(
        q => !q.questionType || q.questionType === 'clarifying'
      );
      const metaQuestions = result.questions.filter(
        q => q.questionType === 'meta'
      );

      // Send clarifying questions through the unified AskUserQuestion path
      // Skip card UI for a single detected question with no predefined options —
      // the question in the response text is sufficient on its own.
      const hasUsefulCard = clarifyingQuestions.length > 1 ||
        (clarifyingQuestions.length === 1 && clarifyingQuestions[0].options && clarifyingQuestions[0].options.length > 0);

      if (hasUsefulCard) {
        console.log('[Mysti] Detected clarifying questions:', clarifyingQuestions.length);
        const auqData = this._convertClarifyingToAuq(clarifyingQuestions, message.id);
        await this._handleDetectedQuestions(auqData, panelId);
        hasInteractiveElements = true;
      }

      // Send plan options through autonomous/semi-auto handling
      // Only suppress if CLARIFYING questions exist
      if (result.planOptions.length >= 1 && clarifyingQuestions.length === 0) {
        console.log('[Mysti] Detected plan options:', result.planOptions.length);
        await this._handleDetectedPlanOptions(
          result.planOptions,
          message.id,
          originalQuery,
          metaQuestions.length > 0 ? metaQuestions : undefined,
          panelId
        );
        hasInteractiveElements = true;
      } else if (result.planOptions.length >= 1 && clarifyingQuestions.length > 0) {
        console.log('[Mysti] Plan options detected but suppressed due to clarifying questions');
      }

      return hasInteractiveElements;
    } catch (error) {
      console.error('[Mysti] Response classification failed:', error);
      return false;  // On error, allow suggestions to be generated
    }
  }

  /**
   * Handle user selection of a plan option
   */
  private async _handlePlanOptionSelected(
    payload: PlanSelectionResult,
    panelId: string
  ): Promise<void> {
    const { selectedPlan, originalQuery, executionMode, customInstructions } = payload;
    console.log('[Mysti] Plan option selected:', selectedPlan.title, 'with mode:', executionMode);

    // Clear pending plan tracking
    this._pendingPlanSelections.delete(panelId);
    // Cancel any semi-auto timer for this panel's plans
    for (const [planId, timer] of this._semiAutoPlanTimeouts.entries()) {
      clearTimeout(timer);
      this._semiAutoPlanTimeouts.delete(planId);
      this._pendingPlanData.delete(planId);
    }

    // Check if currently in plan mode
    const config = vscode.workspace.getConfiguration('mysti');
    const currentMode = config.get<string>('defaultMode');
    const isInPlanMode = currentMode === 'quick-plan' || currentMode === 'detailed-plan';

    // Auto-exit plan mode when user chooses to execute
    if (isInPlanMode && (executionMode === 'edit-automatically' || executionMode === 'ask-before-edit')) {
      console.log(`[Mysti] Exiting ${currentMode} to ${executionMode} on plan approval`);
    }

    // Generate the follow-up prompt
    let followUpPrompt = this._planOptionManager.createSelectionPrompt(selectedPlan, originalQuery);

    // Append custom instructions if provided
    if (customInstructions?.trim()) {
      followUpPrompt += `\n\nAdditional instructions:\n${customInstructions.trim()}`;
    }

    // Clear plan UI when exiting plan mode to execution
    if (isInPlanMode && (executionMode === 'edit-automatically' || executionMode === 'ask-before-edit')) {
      this._postToPanel(panelId, { type: 'clearPlanOptions' });
      this._postToPanel(panelId, { type: 'clearSuggestions' });
    }

    // Handle "Keep Planning" mode differently - just insert the prompt
    if (executionMode === 'quick-plan' || executionMode === 'detailed-plan') {
      this._postToPanel(panelId, {
        type: 'setInputValue',
        payload: { value: followUpPrompt }
      });
      return;
    }

    // For execution modes: switch mode and auto-execute
    // 1. Switch to the selected execution mode
    await this._handleUpdateSettings({ mode: executionMode });

    // 2. Notify webview of mode change
    this._postToPanel(panelId, {
      type: 'modeChanged',
      payload: { mode: executionMode }
    });

    // 3. Get current settings with the new mode (use per-panel provider/model)
    const settings: Settings = {
      mode: executionMode,
      thinkingLevel: config.get('defaultThinkingLevel', 'none'),
      accessLevel: config.get('accessLevel', 'ask-permission'),
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: this._getPanelModel(panelId),
      provider: this._getPanelProvider(panelId) as Settings['provider']
    };

    // 4. Auto-execute by calling _handleSendMessage directly
    await this._handleSendMessage(
      {
        content: followUpPrompt,
        context: this._contextManager.getContext(panelId),
        settings
      },
      panelId
    );
  }

  /**
   * Handle user answers to clarifying questions
   */
  private async _handleQuestionAnswered(
    payload: QuestionSubmission,
    panelId: string
  ): Promise<void> {
    console.log('[Mysti] Questions answered:', payload.answers.length);

    // Get the questions from the stored classification (we need to reconstruct them)
    // For now, we'll create a simplified prompt from the answers
    const answers = new Map<string, string | string[]>();
    for (const answer of payload.answers) {
      answers.set(answer.questionId, answer.value);
    }

    // Create a follow-up message with the user's answers
    // We need to fetch the questions from somewhere - for now build a simple response
    const answerParts: string[] = ['Here are my answers:\n'];
    for (const answer of payload.answers) {
      const value = Array.isArray(answer.value) ? answer.value.join(', ') : answer.value;
      answerParts.push(`- ${value}`);
    }
    answerParts.push('\nPlease proceed based on these choices.');

    const followUpPrompt = answerParts.join('\n');

    // Insert the prompt into the input
    this._postToPanel(panelId, {
      type: 'insertPrompt',
      payload: followUpPrompt
    });
  }

  /**
   * Validate file path to prevent directory traversal attacks
   * @throws Error if path is invalid or contains directory traversal
   */
  private _validateFilePath(filePath: string): void {
    // Check for null bytes (security risk)
    if (filePath.includes('\0')) {
      throw new Error('Invalid file path: contains null byte');
    }

    // Normalize the path to resolve .. and . components
    const normalizedPath = path.normalize(filePath);

    // Check for directory traversal attempts
    if (normalizedPath.includes('..')) {
      throw new Error('Invalid file path: directory traversal detected');
    }

    // If relative path, ensure it doesn't try to escape workspace
    if (!path.isAbsolute(normalizedPath)) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        const resolvedPath = path.resolve(workspaceFolders[0].uri.fsPath, normalizedPath);
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // Ensure resolved path is within workspace boundaries
        if (!resolvedPath.startsWith(workspaceRoot)) {
          throw new Error('Invalid file path: outside workspace boundaries');
        }
      }
    }
  }

  /**
   * Resolve a file path (relative or absolute) to an absolute path
   * @throws Error if path validation fails
   */
  private _resolveFilePath(filePath: string): string {
    // Security: Validate path to prevent directory traversal
    this._validateFilePath(filePath);

    // If already absolute (Unix or Windows), return as-is
    if (filePath.startsWith('/') || filePath.match(/^[A-Za-z]:/)) {
      return filePath;
    }
    // Resolve relative path against workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      return vscode.Uri.joinPath(workspaceFolders[0].uri, filePath).fsPath;
    }
    return filePath;
  }

  private async _handleOpenFile(payload: { path: string; line?: number }) {
    const uri = vscode.Uri.file(this._resolveFilePath(payload.path));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    if (payload.line !== undefined) {
      const position = new vscode.Position(payload.line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    }
  }

  private async _handleApplyEdit(
    payload: {
      path: string;
      content: string;
      startLine?: number;
      endLine?: number;
    },
    panelId?: string
  ) {
    const uri = vscode.Uri.file(this._resolveFilePath(payload.path));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const edit = new vscode.WorkspaceEdit();
    if (payload.startLine !== undefined && payload.endLine !== undefined) {
      const range = new vscode.Range(
        new vscode.Position(payload.startLine, 0),
        new vscode.Position(payload.endLine, document.lineAt(payload.endLine).text.length)
      );
      edit.replace(uri, range, payload.content);
    } else {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, payload.content);
    }

    await vscode.workspace.applyEdit(edit);
    if (panelId) {
      this._postToPanel(panelId, {
        type: 'editApplied',
        payload: { path: payload.path, success: true }
      });
    }
  }

  /**
   * M6: Debounced refresh of workspace file cache — broadcasts to all panels
   */
  private _refreshWorkspaceFileCacheDebounced(): void {
    if (this._fileCacheRefreshTimer) { clearTimeout(this._fileCacheRefreshTimer); }
    this._fileCacheRefreshTimer = setTimeout(async () => {
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 1000);
      const payload = files.map(f => f.fsPath);
      this._broadcastToAll({ type: 'workspaceFiles', payload });
    }, 2000); // 2s debounce to batch rapid FS changes
  }

  private async _handleGetWorkspaceFiles(panelId?: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'workspaceFiles',
          payload: []
        });
      }
      return;
    }

    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 1000);
    if (panelId) {
      this._postToPanel(panelId, {
        type: 'workspaceFiles',
        payload: files.map(f => f.fsPath)
      });
    }
  }

  /** @deprecated Replaced by SlashCommandManager — kept for reference only */
  // Old _getSlashCommands removed — logic moved to SlashCommandManager

  /** Fetch GitHub star count with 24-hour cache */
  private async _getGithubStarCount(): Promise<number> {
    const cacheKey = 'mysti.githubStarCount';
    const cached = this._extensionContext.globalState.get<{ count: number; fetchedAt: number }>(cacheKey);
    const ONE_DAY = 24 * 60 * 60 * 1000;

    if (cached && Date.now() - cached.fetchedAt < ONE_DAY) {
      return cached.count;
    }

    try {
      const https = await import('https');
      const data = await new Promise<string>((resolve, reject) => {
        const req = https.get('https://api.github.com/repos/DeepMyst/Mysti', {
          headers: { 'User-Agent': 'Mysti-VSCode-Extension' }
        }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      const json = JSON.parse(data);
      const count = typeof json.stargazers_count === 'number' ? json.stargazers_count : 0;
      await this._extensionContext.globalState.update(cacheKey, { count, fetchedAt: Date.now() });
      return count;
    } catch {
      return cached?.count || 0;
    }
  }

  private _getQuickActions() {
    return [
      {
        id: 'explain',
        label: 'Explain this code',
        prompt: 'Explain the selected code in detail',
        icon: 'info'
      },
      {
        id: 'refactor',
        label: 'Refactor',
        prompt: 'Suggest refactoring improvements for this code',
        icon: 'wrench'
      },
      {
        id: 'fix-bugs',
        label: 'Find bugs',
        prompt: 'Find potential bugs in this code',
        icon: 'bug'
      },
      {
        id: 'add-tests',
        label: 'Add tests',
        prompt: 'Generate unit tests for this code',
        icon: 'beaker'
      },
      {
        id: 'optimize',
        label: 'Optimize',
        prompt: 'Suggest performance optimizations',
        icon: 'zap'
      },
      {
        id: 'document',
        label: 'Add docs',
        prompt: 'Add documentation and comments to this code',
        icon: 'book'
      }
    ];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Visual Test Dashboard
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Open the Visual Test Dashboard in a separate editor tab.
   * If a dashboard is already open, focuses it.
   * Returns the dashboard panelId.
   */
  public openVisualTestDashboard(config?: VisualTestConfig, originPanelId?: string): string {
    // If dashboard already open, focus it
    if (this._vtDashboardPanelId) {
      const existing = this._panelStates.get(this._vtDashboardPanelId);
      if (existing?.panel) {
        existing.panel.reveal();
        // If config provided, send it to pre-fill
        if (config) {
          existing.webview.postMessage({ type: 'visualTestDashboardConfig', payload: config });
        }
        return this._vtDashboardPanelId;
      }
    }

    const panelId = `vt-dashboard-${Date.now()}`;
    const panel = vscode.window.createWebviewPanel(
      'mysti.visualTestDashboard',
      'Mysti Visual Test',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true
      }
    );

    panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'Mysti-Logo.png');
    const version = this._extensionContext.extension.packageJSON.version || '0.0.0';
    panel.webview.html = getVisualTestDashboardContent(panel.webview, this._extensionUri, version);

    // Track dashboard
    this._vtDashboardPanelId = panelId;
    this._vtDashboardChatOrigin = originPanelId || null;

    // Register in panel states (for message routing)
    this._panelStates.set(panelId, {
      id: panelId,
      webview: panel.webview,
      panel,
      currentConversationId: null,
      isSidebar: false
    });

    // Wire messages
    panel.webview.onDidReceiveMessage(
      async (msg: any) => this._handleDashboardMessage(msg, panelId)
    );

    // Cleanup on dispose
    panel.onDidDispose(() => {
      this._vtDashboardPanelId = null;
      this._vtDashboardChatOrigin = null;
      this._panelStates.delete(panelId);
      // Cancel running test on close
      this._visualTestManager.cancelTest(panelId);
    });

    // If config provided, pre-fill
    if (config) {
      panel.webview.postMessage({ type: 'visualTestDashboardConfig', payload: config });
    }

    return panelId;
  }

  /**
   * Handle messages from the Visual Test Dashboard webview.
   */
  private async _handleDashboardMessage(msg: any, dashboardPanelId: string): Promise<void> {
    switch (msg.type) {
      case 'dashboardStartVisualTest': {
        const config = msg.payload?.config as VisualTestConfig | undefined;
        if (!config) { break; }
        // Get settings from the origin chat panel or use defaults
        const settings = this._getSettingsForPanel(this._vtDashboardChatOrigin || this._sidebarId);
        this._runVisualTestWithDashboard(dashboardPanelId, config, this._vtDashboardChatOrigin, settings);
        break;
      }
      case 'dashboardCancelVisualTest':
        this._visualTestManager.cancelTest(dashboardPanelId);
        this._postToPanel(dashboardPanelId, { type: 'visualTestDashboardCancelled' } as any);
        break;
      case 'dashboardStopServer':
        await this._visualTestManager.stopDevServer(dashboardPanelId);
        break;
    }
  }

  /**
   * Run a visual test with dashboard panel (streams to both dashboard and chat).
   */
  private async _runVisualTestWithDashboard(
    dashPanelId: string,
    config: VisualTestConfig,
    chatPanelId: string | null,
    settings: Settings
  ): Promise<void> {
    try {
      const stream = this._visualTestManager.startVisualTest(
        dashPanelId, config, this._providerManager, settings
      );
      for await (const chunk of stream) {
        // Send to dashboard
        this._postToPanel(dashPanelId, { type: 'visualTestDashboardUpdate', payload: chunk } as any);
        // Send mini status to origin chat panel
        if (chatPanelId) {
          this._postToPanel(chatPanelId, { type: 'visualTestMiniStatus', payload: chunk } as any);
        }
        // On completion, inject summary into chat for agent reasoning
        if (chunk.type === 'visual_test_complete' && chunk.report && chatPanelId) {
          const summary = this._visualTestManager.buildAgentFeedbackSummary(chunk.report);
          this._postToPanel(chatPanelId, {
            type: 'responseChunk',
            payload: { type: 'text', content: `\n\n${summary}` }
          });
        }
      }
    } catch (err: any) {
      this._postToPanel(dashPanelId, {
        type: 'visualTestDashboardUpdate',
        payload: { type: 'visual_test_error', status: 'failed', message: err.message || 'Visual test failed' }
      } as any);
      if (chatPanelId) {
        this._postToPanel(chatPanelId, {
          type: 'visualTestMiniStatus',
          payload: { type: 'visual_test_error', status: 'failed', message: err.message }
        } as any);
      }
    }
  }

  /**
   * Run a visual test headlessly (no dashboard, results go to chat only).
   */
  private async _runVisualTestHeadless(
    config: VisualTestConfig,
    chatPanelId: string,
    settings: Settings
  ): Promise<void> {
    const testPanelId = `vt-headless-${Date.now()}`;
    try {
      this._postToPanel(chatPanelId, {
        type: 'visualTestMiniStatus',
        payload: { type: 'visual_test_started', status: 'capturing', message: 'Visual test starting (headless)...' }
      } as any);

      const stream = this._visualTestManager.startVisualTest(
        testPanelId, config, this._providerManager, settings
      );
      for await (const chunk of stream) {
        this._postToPanel(chatPanelId, { type: 'visualTestMiniStatus', payload: chunk } as any);

        if (chunk.type === 'visual_test_complete' && chunk.report) {
          const summary = this._visualTestManager.buildAgentFeedbackSummary(chunk.report);
          this._postToPanel(chatPanelId, {
            type: 'responseChunk',
            payload: { type: 'text', content: `\n\n${summary}` }
          });
        }
      }
    } catch (err: any) {
      this._postToPanel(chatPanelId, {
        type: 'visualTestMiniStatus',
        payload: { type: 'visual_test_error', status: 'failed', message: err.message }
      } as any);
    }
  }

  /**
   * Detect a visual test trigger in AI response text.
   * Looks for: ```visual-test\n{...JSON...}\n```
   */
  private _detectVisualTestTrigger(content: string): VisualTestTrigger | null {
    const match = content.match(/```visual-test\s*\n([\s\S]*?)```/);
    if (!match) { return null; }
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  /**
   * Get the effective settings for a panel (resolves overrides).
   */
  private _getSettingsForPanel(panelId: string): Settings {
    const config = vscode.workspace.getConfiguration('mysti');
    // Build base settings from config (simplified — the real settings resolution is in _handleMessage)
    const settings: Settings = {
      provider: config.get('provider', DEFAULT_PROVIDER) as any,
      model: config.get('model', ''),
      mode: config.get('mode', 'default') as any,
      thinkingLevel: config.get('thinkingLevel', 'none') as any,
      accessLevel: config.get('accessLevel', 'ask-permission') as any,
      contextMode: config.get('contextMode', 'auto') as any,
      autonomousMode: config.get('autonomous.enabled', false),
    };
    // Apply per-panel overrides
    const state = this._panelStates.get(panelId);
    if (state?.settingsOverrides) {
      if (state.settingsOverrides.provider) { settings.provider = state.settingsOverrides.provider; }
      if (state.settingsOverrides.model) { settings.model = state.settingsOverrides.model; }
    }
    return settings;
  }

  // ========================================================================
  // Canvas
  // ========================================================================

  /**
   * Open the Canvas in a separate editor tab.
   */
  public openCanvas(sessionId?: string, originPanelId?: string): string {
    // If canvas already open, focus it
    if (this._canvasPanelId) {
      const existing = this._panelStates.get(this._canvasPanelId);
      if (existing?.panel) {
        existing.panel.reveal();
        return this._canvasPanelId;
      }
    }

    const panelId = `canvas-${Date.now()}`;
    const panel = vscode.window.createWebviewPanel(
      'mysti.canvas',
      'Mysti Canvas',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true
      }
    );

    panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'Mysti-Logo.png');
    const version = this._extensionContext.extension.packageJSON.version || '0.0.0';
    panel.webview.html = getCanvasContent(panel.webview, this._extensionUri, version);

    // Track canvas panel
    this._canvasPanelId = panelId;
    this._canvasChatOrigin = originPanelId || null;

    // Register in panel states
    this._panelStates.set(panelId, {
      id: panelId,
      webview: panel.webview,
      panel,
      currentConversationId: null,
      isSidebar: false
    });

    // Wire messages
    panel.webview.onDidReceiveMessage(
      async (msg: any) => this._handleCanvasMessage(msg, panelId)
    );

    // Cleanup on dispose
    panel.onDidDispose(() => {
      this._canvasBrowserManager.close(panelId).catch(() => {});
      this._canvasDevServerManager.stop(panelId).catch(() => {});
      this._canvasPanelId = null;
      this._canvasChatOrigin = null;
      this._panelStates.delete(panelId);
    });

    // If sessionId provided, load that session; otherwise wait for canvasReady
    if (sessionId) {
      this._canvasManager.loadSession(sessionId).then(async session => {
        if (session) {
          session.canvasJson = await this._canvasManager.rehydrateAssets(session.canvasJson);
          panel.webview.postMessage({ type: 'canvasLoad', payload: session });
        }
      });
    }

    return panelId;
  }

  /**
   * F-11: inject the shared {@link CanvasSecrets} instance (constructed once in
   * extension.ts after the one-time settings→secrets migration) and prime the
   * generation services with the stored keys.
   */
  public setCanvasSecrets(secrets: CanvasSecrets): void {
    this._canvasSecrets = secrets;
    void this._refreshCanvasGenKeys();
  }

  /**
   * Plan 04 Phase 4: inject the DeepMyst auth manager (constructed in
   * extension.ts) so the chat can (a) teach agents the `<<<MYSTI_CONNECT:slug>>>`
   * convention via the system prompt and (b) open the right connect page when a
   * marker fires. Wired post-construction to avoid growing the constructor.
   */
  public setDeepMystAuth(auth: DeepMystAuthManager): void {
    this._deepMystAuth = auth;
    // A sign-in/out invalidates any cached connection list.
    auth.onDidChangeAuth(() => { this._connectionsCache = undefined; });
  }

  /**
   * Plan 04 Phase 4: system-prompt addendum teaching every agent the in-chat
   * connect convention. When the user asks to link an external service, the
   * agent emits a single `<<<MYSTI_CONNECT:slug>>>` marker which Mysti turns
   * into a one-click "Link <service>" button — no local credentials. Returns ''
   * when DeepMyst isn't wired so the convention never leaks into other setups.
   */
  private _deepMystConnectSnippet(): string {
    if (!this._deepMystAuth) { return ''; }
    return [
      '## Connecting external tools (DeepMyst)',
      'Mysti links external services (Gmail, Google Drive, Slack, Notion, databases, etc.) through DeepMyst — the user never pastes API keys locally.',
      'When the user asks to connect / link / authorize an external service that you do NOT already have a working tool for, do NOT ask for credentials or API keys.',
      'Instead emit a single marker on its own line:',
      '<<<MYSTI_CONNECT:slug>>>',
      'where `slug` is a short lowercase identifier for the service (e.g. gmail, google-drive, slack, notion, postgres, github).',
      'Mysti renders that marker as a one-click "Link <service>" button. Emit it once, then in one short sentence tell the user to click the button to connect.',
    ].join('\n');
  }

  /**
   * Plan 04 Phase 4: handle a detected `<<<MYSTI_CONNECT:slug>>>` marker. If the
   * service already appears in the user's DeepMyst connections, post a subtle
   * "already linked" note; otherwise post a connect card the webview renders as
   * a "Link <service>" button. Best-effort and non-blocking — never throws into
   * the stream loop.
   */
  private async _emitConnectionCard(panelId: string, service: string): Promise<void> {
    try {
      const signedIn = !!this._deepMystAuth?.isSignedIn();
      if (signedIn && (await this._isServiceLinked(service))) {
        this._postToPanel(panelId, {
          type: 'connectionAlready',
          payload: { service }
        });
        return;
      }
      this._postToPanel(panelId, {
        type: 'connectionRequired',
        payload: { service, signedIn }
      });
    } catch (err) {
      console.warn('[Mysti] connect card emit failed:', err);
    }
  }

  /**
   * Best-effort check whether `service` matches one of the user's existing
   * DeepMyst connections (by name/type/id substring). Caches the connection
   * names for {@link CONNECTIONS_CACHE_TTL_MS} so repeated markers don't hammer
   * the API. Returns false on any error (we'd rather show an extra button than
   * hide a needed one).
   */
  private async _isServiceLinked(service: string): Promise<boolean> {
    const auth = this._deepMystAuth;
    if (!auth?.isSignedIn()) { return false; }
    const now = Date.now();
    const CONNECTIONS_CACHE_TTL_MS = 60_000;
    if (!this._connectionsCache || now - this._connectionsCache.at > CONNECTIONS_CACHE_TTL_MS) {
      try {
        const res = await auth.client.listConnections();
        const names = res.available
          ? res.items.flatMap(c => [c.name, c.type, c.id].filter(Boolean).map(s => String(s).toLowerCase()))
          : [];
        this._connectionsCache = { at: now, names };
      } catch {
        this._connectionsCache = { at: now, names: [] };
      }
    }
    const needle = service.toLowerCase();
    return this._connectionsCache.names.some(n => n.includes(needle) || needle.includes(n));
  }

  /**
   * Plan 04 Phase 4: act on the in-chat "Link <service>" button. When signed in,
   * open the DeepMyst connections page deep-linked to the service so the user can
   * authorize it; when signed out, open the Mysti Connections panel to sign in
   * first (the broker needs a DeepMyst session before it can link anything).
   */
  private async _handleConnectService(service?: string): Promise<void> {
    const slug = (service || '').trim().toLowerCase();
    console.log(`[Mysti] connectService requested for "${slug || '(none)'}"`);
    const auth = this._deepMystAuth;
    if (!auth || !auth.isSignedIn()) {
      vscode.commands.executeCommand('mysti.openConnections');
      return;
    }
    // DeepMyst's "My Connections" hub lives at /settings/connections (the
    // catalog browse + OAuth connect happens there). The page doesn't read a
    // preselect query param, so we open the hub and let the user search.
    const webUrl = auth.getWebUrl().replace(/\/+$/, '');
    const target = `${webUrl}/settings/connections`;
    await vscode.env.openExternal(vscode.Uri.parse(target));
    // The list may change after the user links something; drop the cache so the
    // next marker re-checks.
    this._connectionsCache = undefined;
  }

  /**
   * F-11: re-resolve the OpenAI/Gemini canvas keys from SecretStorage and push
   * them into the image/video generation services so `isAvailable` /
   * `isVisionAvailable` / `generate` see the current key without a reload.
   */
  private async _refreshCanvasGenKeys(): Promise<void> {
    if (!this._canvasSecrets) { return; }
    const [openai, gemini] = await Promise.all([
      this._canvasSecrets.get('openai'),
      this._canvasSecrets.get('gemini'),
    ]);
    this._imageGenService.setKeys({ openai, gemini });
    this._videoGenService.setKeys({ openai, gemini });
  }

  /**
   * F-3: derive a {@link StitchScreenRef} from a webview snapshot when the
   * prompt bar did not send an explicit `stitchScreenRef`. Mirrors the
   * `canvasReimagine` fallback: read the first selected object's metadata and,
   * if it is a Stitch-generated screen, reconstruct the ref from its
   * `stitchProjectId` / `stitchScreenId`. Returns `undefined` when the
   * selection is not a Stitch screen so callers can surface a clear error.
   */
  private _stitchRefFromSnapshot(snapshot: any): StitchScreenRef | undefined {
    const meta = snapshot?.selectedRegion?.objects?.[0]?.metadata;
    if (meta?.engine === 'stitch' && meta.stitchProjectId && meta.stitchScreenId) {
      return {
        projectId: meta.stitchProjectId,
        screenId: meta.stitchScreenId,
        htmlContent: meta.stitchHtmlContent || undefined,
        imageBase64: meta.stitchImageBase64 || undefined,
      };
    }
    return undefined;
  }

  /**
   * Handle messages from the Canvas webview.
   */
  private async _handleCanvasMessage(msg: any, canvasPanelId: string): Promise<void> {
    switch (msg.type) {
      case 'canvasReady': {
        // Resume the most recent session, or create a new one
        let session = await this._canvasManager.getLatestSession();
        if (session) {
          // Rehydrate asset:// references back to data URIs for the webview
          session.canvasJson = await this._canvasManager.rehydrateAssets(session.canvasJson);
        } else {
          session = this._canvasManager.createSession('Untitled Canvas');
          await this._canvasManager.saveSession(session);
        }
        this._postToPanel(canvasPanelId, { type: 'canvasLoad', payload: session } as any);
        break;
      }

      case 'canvasSave': {
        const payload = msg.payload;
        if (payload?.id) {
          const existing = await this._canvasManager.loadSession(payload.id);
          if (existing) {
            existing.canvasJson = payload.canvasJson;
            this._canvasManager.debouncedSave(existing);
          }
        }
        break;
      }

      case 'canvasPrompt': {
        const request = msg.payload;
        if (!request) { break; }
        const settings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
        // Build snapshot from webview data
        const snapshot = this._canvasManager.buildSnapshot(
          request.snapshot?._canvasJson || {},
          request.snapshot?.imageBase64 || '',
          request.snapshot?.selectedRegion
        );
        request.snapshot = snapshot;
        try {
          const stream = this._canvasManager.promptFrame(request, this._providerManager, settings);
          for await (const chunk of stream) {
            this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
          }
        } catch (err: any) {
          this._postToPanel(canvasPanelId, {
            type: 'canvasStreamChunk',
            payload: { type: 'canvas_error', canvasId: request.canvasId, error: err.message }
          } as any);
        }
        break;
      }

      case 'canvasReimagine': {
        const request = msg.payload;
        if (!request) { break; }

        // Check if the selected object is a Stitch screen — use Stitch variants instead
        const reimagineStitchMeta = request.snapshot?.selectedRegion?.objects?.[0]?.metadata;
        if (reimagineStitchMeta?.engine === 'stitch' && reimagineStitchMeta.stitchProjectId && reimagineStitchMeta.stitchScreenId) {
          try {
            const stitchRef = {
              projectId: reimagineStitchMeta.stitchProjectId,
              screenId: reimagineStitchMeta.stitchScreenId,
            };
            const stream = this._canvasManager.reimagineWithStitch(
              request.canvasId, stitchRef, request.prompt || ''
            );
            for await (const chunk of stream) {
              this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
            }
          } catch (err: any) {
            this._postToPanel(canvasPanelId, {
              type: 'canvasStreamChunk',
              payload: { type: 'canvas_error', canvasId: request.canvasId, error: err.message }
            } as any);
          }
          break;
        }

        if (!this._imageGenService.isAvailable) {
          this._postToPanel(canvasPanelId, { type: 'canvasShowConfig' } as any);
          break;
        }
        const settings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
        const snapshot = this._canvasManager.buildSnapshot(
          request.snapshot?._canvasJson || {},
          request.snapshot?.imageBase64 || '',
          request.snapshot?.selectedRegion
        );
        request.snapshot = snapshot;
        try {
          const projectContext = await CanvasManager.buildProjectContext(
            this._providerManager, settings, this._projectContextManager
          );
          const stream = this._canvasManager.generateImageVariants(request, this._providerManager, this._imageGenService, settings, projectContext);
          for await (const chunk of stream) {
            this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
          }
        } catch (err: any) {
          this._postToPanel(canvasPanelId, {
            type: 'canvasStreamChunk',
            payload: { type: 'canvas_error', canvasId: request.canvasId, error: err.message }
          } as any);
        }
        break;
      }

      case 'canvasGenerateDraft': {
        const { canvasId, prompt, snapshot } = msg.payload || {};
        if (!prompt) { break; }
        if (!this._imageGenService.isAvailable) {
          this._postToPanel(canvasPanelId, { type: 'canvasShowConfig' } as any);
          break;
        }
        try {
          const draftSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
          const frameBounds = snapshot?.selectedRegion?.bounds;
          const projectContext = await CanvasManager.buildProjectContext(
            this._providerManager, draftSettings, this._projectContextManager
          );
          const selectionDesc = snapshot?.selectedRegion?.objects?.length
            ? snapshot.selectedRegion.objects.map((o: any) =>
                `${o.type}${o.content ? `: "${o.content}"` : ''} (${o.size.width}x${o.size.height})`
              ).join(', ')
            : '';
          const stream = this._canvasManager.generateDraft(
            canvasId || '', prompt, this._imageGenService,
            this._providerManager, draftSettings,
            frameBounds, projectContext, selectionDesc,
            snapshot?.selectedRegion?.imageBase64,
            snapshot?.selectedRegion?.objects
          );
          for await (const chunk of stream) {
            this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
          }
        } catch (err: any) {
          this._postToPanel(canvasPanelId, {
            type: 'canvasStreamChunk',
            payload: { type: 'canvas_error', canvasId: canvasId || '', error: err.message }
          } as any);
        }
        break;
      }

      // F-15: `canvasBatchGenerate` (batch-generation pipeline) and
      // `canvasImportScreenshot` removed — both were dead code with no webview
      // producer. The batch pipeline / `generateBatchContent` are gone from
      // CanvasManager; `_computeCompositionGuide` is kept (reused by smart
      // prompts).

      case 'canvasUnifiedPrompt': {
        const payload = msg.payload || {};
        const text = payload.text || '';
        const canvasId = payload.canvasId || '';
        const parsed = CanvasManager.parseUnifiedPrompt(text);

        switch (parsed.action) {
          case 'render': {
            try {
              const stream = this._canvasManager.renderPage(
                canvasId,
                canvasPanelId,
                parsed.argument,
                this._canvasBrowserManager,
                this._canvasScreenshotService,
                this._canvasDevServerManager
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'generate': {
            if (!this._imageGenService.isAvailable) {
              this._postToPanel(canvasPanelId, { type: 'canvasShowConfig' } as any);
              break;
            }
            try {
              const genSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
              const snapshot = this._canvasManager.buildSnapshot(
                payload.snapshot?._canvasJson || {},
                payload.snapshot?.imageBase64 || '',
                payload.snapshot?.selectedRegion
              );
              const frameBounds = snapshot.selectedRegion?.bounds;
              const selectionDesc = snapshot.selectedRegion?.objects?.length
                ? snapshot.selectedRegion.objects.map(o =>
                    `${o.type}${o.content ? `: "${o.content}"` : ''}${o.label ? ` [${o.label}]` : ''} (${o.size.width}x${o.size.height})`
                  ).join(', ')
                : '';
              const projectContext = await CanvasManager.buildProjectContext(
                this._providerManager, genSettings, this._projectContextManager
              );
              const regionImageBase64 = snapshot.selectedRegion?.imageBase64;
              const stream = this._canvasManager.generateDraft(
                canvasId, parsed.argument, this._imageGenService,
                this._providerManager, genSettings,
                frameBounds, projectContext, selectionDesc, regionImageBase64,
                snapshot.selectedRegion?.objects
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'reimagine': {
            // /reimagine — variants of the selected screen/image. If a Stitch
            // screen is selected use Stitch variants; otherwise AI image variants.
            const reimagineSnapshot = this._canvasManager.buildSnapshot(
              payload.snapshot?._canvasJson || {},
              payload.snapshot?.imageBase64 || '',
              payload.snapshot?.selectedRegion
            );
            // F-3: prefer the explicit stitchScreenRef the webview now sends,
            // falling back to the selected region's object metadata (the
            // canvasReimagine pattern at ~5555).
            const reimagineRef = payload.stitchScreenRef;
            const reimagineMeta = reimagineSnapshot.selectedRegion?.objects?.[0]?.metadata;
            const stitchProjectId = reimagineRef?.projectId || reimagineMeta?.stitchProjectId;
            const stitchScreenId = reimagineRef?.screenId || reimagineMeta?.stitchScreenId;
            const isStitch = (reimagineRef || reimagineMeta?.engine === 'stitch') && stitchProjectId && stitchScreenId;
            try {
              if (isStitch) {
                const stream = this._canvasManager.reimagineWithStitch(
                  canvasId,
                  { projectId: stitchProjectId!, screenId: stitchScreenId! },
                  parsed.argument
                );
                for await (const chunk of stream) {
                  this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
                }
                break;
              }
              if (!this._imageGenService.isAvailable) {
                this._postToPanel(canvasPanelId, { type: 'canvasShowConfig' } as any);
                break;
              }
              const reimagineSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
              const projectContext = await CanvasManager.buildProjectContext(
                this._providerManager, reimagineSettings, this._projectContextManager
              );
              const stream = this._canvasManager.generateImageVariants(
                { canvasId, prompt: parsed.argument, snapshot: reimagineSnapshot, selectedObjectIds: payload.selectedObjectIds, action: 'reimagine' },
                this._providerManager, this._imageGenService, reimagineSettings, projectContext
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'video': {
            if (!this._videoGenService.isAvailable) {
              this._postToPanel(canvasPanelId, { type: 'canvasShowConfig' } as any);
              break;
            }
            try {
              const vidSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
              const snapshot = this._canvasManager.buildSnapshot(
                payload.snapshot?._canvasJson || {},
                payload.snapshot?.imageBase64 || '',
                payload.snapshot?.selectedRegion
              );
              const frameBounds = snapshot.selectedRegion?.bounds;
              const selectionDesc = snapshot.selectedRegion?.objects?.length
                ? snapshot.selectedRegion.objects.map(o =>
                    `${o.type}${o.content ? `: "${o.content}"` : ''}${o.label ? ` [${o.label}]` : ''} (${o.size.width}x${o.size.height})`
                  ).join(', ')
                : '';
              const projectContext = await CanvasManager.buildProjectContext(
                this._providerManager, vidSettings, this._projectContextManager
              );
              const regionImageBase64 = snapshot.selectedRegion?.imageBase64;
              const stream = this._canvasManager.generateVideo(
                canvasId, parsed.argument, this._videoGenService,
                this._providerManager, vidSettings,
                frameBounds, projectContext, selectionDesc, regionImageBase64,
                snapshot.selectedRegion?.objects
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'page': {
            const layoutSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
            try {
              const projectContext = await CanvasManager.buildProjectContext(
                this._providerManager, layoutSettings, this._projectContextManager
              );
              const snapshot = this._canvasManager.buildSnapshot(
                payload.snapshot?._canvasJson || {},
                payload.snapshot?.imageBase64 || '',
                payload.snapshot?.selectedRegion
              );
              const frameBounds = snapshot.selectedRegion?.bounds;
              const stream = this._canvasManager.generateScreen(
                canvasId, parsed.argument, 'DESKTOP',
                projectContext, frameBounds
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'website': {
            try {
              const websiteSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
              const websiteSnapshot = this._canvasManager.buildSnapshot(
                payload.snapshot?._canvasJson || {},
                payload.snapshot?.imageBase64 || '',
                payload.snapshot?.selectedRegion
              );
              const projectContext = await CanvasManager.buildProjectContext(
                this._providerManager, websiteSettings, this._projectContextManager
              );
              const stream = this._canvasManager.generateWebsite(
                canvasId, parsed.argument, projectContext
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'svg': {
            try {
              if (!this._imageGenService.isVisionAvailable) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Configure a Gemini or OpenAI API key to use SVG conversion' }
                } as any);
                break;
              }
              const svgSnapshot = this._canvasManager.buildSnapshot(
                payload.snapshot?._canvasJson || {},
                payload.snapshot?.imageBase64 || '',
                payload.snapshot?.selectedRegion
              );
              const regionImage = svgSnapshot.selectedRegion?.imageBase64;
              if (!regionImage) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Select an image to convert to SVG' }
                } as any);
                break;
              }
              const stream = this._canvasManager.convertToSvg(
                canvasId, regionImage, parsed.argument,
                this._imageGenService,
                svgSnapshot.selectedRegion?.bounds,
                svgSnapshot.selectedRegion?.objects?.[0]?.metadata
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'code': {
            try {
              // Deterministic code gen if a DesignNode is selected
              if (payload.designNode && payload.designTheme) {
                const framework = (parsed.argument.match(/react|vue|html/i)?.[0]?.toLowerCase() || 'react') as 'react' | 'vue' | 'html';
                const compName = payload.designNode.componentType
                  ? payload.designNode.componentType.replace(/[^a-zA-Z]/g, '').replace(/^./, (c: string) => c.toUpperCase())
                  : payload.designNode.name?.replace(/[^a-zA-Z]/g, '').replace(/^./, (c: string) => c.toUpperCase()) || 'Component';
                const codeDetSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
                const codeDetProjectCtx = await CanvasManager.buildProjectContext(
                  this._providerManager, codeDetSettings, this._projectContextManager, this._imageGenService
                );
                const stream = this._canvasManager.generateCodeFromDesignNode(
                  canvasId, payload.designNode, payload.designTheme, framework, compName,
                  codeDetProjectCtx, payload.designAssets
                );
                for await (const chunk of stream) {
                  this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
                }
                break;
              }

              // Check if selected object is a Stitch screen — use Stitch HTML directly
              const codeObjMeta = payload.snapshot?.selectedRegion?.objects?.[0]?.metadata
                || payload.designNode?.metadata;
              if (codeObjMeta?.engine === 'stitch' && codeObjMeta.stitchProjectId && codeObjMeta.stitchScreenId) {
                if (!this._codeGenService) {
                  const { CodeGenerationService } = await import('../services/CodeGenerationService');
                  this._codeGenService = new CodeGenerationService();
                }
                const stitchCodeSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
                const stitchCodeCtx = await CanvasManager.buildProjectContext(
                  this._providerManager, stitchCodeSettings, this._projectContextManager, this._imageGenService
                );
                const stitchRef = {
                  projectId: codeObjMeta.stitchProjectId,
                  screenId: codeObjMeta.stitchScreenId,
                };
                const stream = this._canvasManager.generateCodeFromStitch(
                  canvasId, stitchRef, parsed.argument,
                  this._codeGenService, this._imageGenService, stitchCodeCtx
                );
                for await (const chunk of stream) {
                  this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
                }
                break;
              }

              if (!this._imageGenService.isVisionAvailable) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Configure a Gemini or OpenAI API key to use code generation' }
                } as any);
                break;
              }
              const codeSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
              const codeSnapshot = this._canvasManager.buildSnapshot(
                payload.snapshot?._canvasJson || {},
                payload.snapshot?.imageBase64 || '',
                payload.snapshot?.selectedRegion
              );
              const projectContext = await CanvasManager.buildProjectContext(
                this._providerManager, codeSettings, this._projectContextManager, this._imageGenService
              );
              const selectedObj = codeSnapshot.selectedRegion?.objects?.[0];
              const regionImage = codeSnapshot.selectedRegion?.imageBase64;
              const svgContent = selectedObj?.content && selectedObj.content.startsWith('<svg') ? selectedObj.content : null;

              if (!this._codeGenService) {
                const { CodeGenerationService } = await import('../services/CodeGenerationService');
                this._codeGenService = new CodeGenerationService();
              }

              const codeFrameBounds = codeSnapshot.selectedRegion?.bounds;
              const stream = this._canvasManager.generateCode(
                canvasId,
                svgContent,
                regionImage || null,
                parsed.argument,
                this._codeGenService,
                this._imageGenService,
                selectedObj?.label,
                selectedObj?.metadata,
                projectContext,
                codeFrameBounds,
                payload.designTheme,
                payload.designAssets
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'edit-element':
          case 'edit-layout': {
            try {
              if (!this._imageGenService?.isVisionAvailable) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Configure a Gemini or OpenAI API key for element editing' }
                } as any);
                break;
              }
              const elementSelection = payload.snapshot?.elementSelection;
              if (!elementSelection?.componentSource) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Select an element within a component to edit' }
                } as any);
                break;
              }
              if (!this._codeGenService) {
                const { CodeGenerationService } = await import('../services/CodeGenerationService');
                this._codeGenService = new CodeGenerationService();
              }
              const editStream = this._canvasManager.editElement(
                canvasId,
                parsed.argument,
                elementSelection,
                this._imageGenService,
                this._codeGenService,
                parsed.action as 'edit-element' | 'edit-layout'
              );
              for await (const chunk of editStream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          // 'mockup' action removed — /mockup command no longer exists

          case 'theme': {
            try {
              const themeSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
              const stream = this._canvasManager.generateTheme(
                canvasId, parsed.argument, this._providerManager, themeSettings
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'stitch-edit': {
            try {
              // F-3: the webview sends stitchScreenRef; fall back to the
              // selected region's object metadata (the canvasReimagine pattern).
              const stitchRef = payload.stitchScreenRef
                || this._stitchRefFromSnapshot(payload.snapshot);
              if (!stitchRef) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Select a Stitch-generated screen to edit' }
                } as any);
                break;
              }
              const stream = this._canvasManager.editStitchScreen(canvasId, parsed.argument, stitchRef);
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'stitch-variants': {
            try {
              const variantRef = payload.stitchScreenRef
                || this._stitchRefFromSnapshot(payload.snapshot);
              if (!variantRef) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Select a Stitch-generated screen to create variants' }
                } as any);
                break;
              }
              const config = vscode.workspace.getConfiguration('mysti');
              const variantCount = config.get<number>('canvas.stitchVariantCount', 3);
              const creativeRange = config.get<string>('canvas.stitchCreativeRange', 'EXPLORE') as import('../types').StitchCreativeRange;
              // F-20: anchor the variant row to the source screen's bounds so
              // variants appear next to the screen they were derived from
              // (laid out in a row just below it) instead of stacking at (0,0).
              const sourceBounds = payload.snapshot?.selectedRegion?.bounds;
              const variantBaseX = sourceBounds?.left ?? 0;
              const variantBaseY = sourceBounds
                ? sourceBounds.top + sourceBounds.height + 100
                : 0;
              const stream = this._canvasManager.generateStitchVariants(
                canvasId, variantRef, parsed.argument,
                { variantCount, creativeRange, aspects: ['LAYOUT', 'COLOR_SCHEME'] },
                variantBaseX, variantBaseY
              );
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'stitch-html': {
            try {
              const htmlRef = payload.stitchScreenRef
                || this._stitchRefFromSnapshot(payload.snapshot);
              if (!htmlRef) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Select a Stitch-generated screen to export HTML' }
                } as any);
                break;
              }
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_stitch_html_ready', canvasId, stitchHtml: htmlRef.htmlContent || '', stitchScreenRef: htmlRef }
              } as any);
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'design-dna': {
            try {
              const dnaRef = payload.stitchScreenRef
                || this._stitchRefFromSnapshot(payload.snapshot);
              if (!dnaRef) {
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_error', canvasId, error: 'Select a Stitch-generated screen to extract Design DNA' }
                } as any);
                break;
              }
              const stream = this._canvasManager.extractDesignDna(canvasId, dnaRef);
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }

          case 'prompt':
          default: {
            const settings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
            const snapshot = this._canvasManager.buildSnapshot(
              payload.snapshot?._canvasJson || {},
              payload.snapshot?.imageBase64 || '',
              payload.snapshot?.selectedRegion
            );
            const request = {
              canvasId,
              prompt: parsed.argument,
              snapshot,
              selectedObjectIds: payload.selectedObjectIds,
              action: 'prompt' as const,
            };
            try {
              const stream = this._canvasManager.promptFrame(request, this._providerManager, settings);
              for await (const chunk of stream) {
                this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
              }
            } catch (err: any) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId, error: err.message }
              } as any);
            }
            break;
          }
        }
        break;
      }

      case 'canvasSendToChat': {
        const snapshot = msg.payload?.snapshot;
        if (snapshot && this._canvasChatOrigin) {
          // Inject canvas context into chat as a message
          this._postToPanel(this._canvasChatOrigin, {
            type: 'canvasContext',
            payload: {
              imageBase64: snapshot.imageBase64,
              sceneDescription: snapshot.sceneDescription || 'Canvas snapshot',
            }
          } as any);
        }
        break;
      }

      case 'canvasExport': {
        const dataUrl = msg.payload?.imageDataUrl;
        if (dataUrl) {
          const uri = await vscode.window.showSaveDialog({
            filters: { 'PNG Image': ['png'] },
            defaultUri: vscode.Uri.file('canvas-export.png'),
          });
          if (uri) {
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');
            await vscode.workspace.fs.writeFile(uri, buffer);
            vscode.window.showInformationMessage(`Canvas exported to ${uri.fsPath}`);
          }
        }
        break;
      }

      case 'canvasUpdateProps': {
        const propPayload = msg.payload || {};
        if (propPayload.modifiedProps && propPayload.componentName) {
          try {
            if (!this._codeGenService) {
              const { CodeGenerationService } = await import('../services/CodeGenerationService');
              this._codeGenService = new CodeGenerationService();
            }
            const stream = this._codeGenService.regenerateWithProps({
              // F-7: pass the real SVG markup AND the current component source so
              // the regen prompt edits the existing code instead of rebuilding
              // from a hardcoded empty SVG. The service prefers `currentSource`
              // as the source of truth and uses SVG as extra context.
              svgMarkup: propPayload.svgMarkup || '',
              currentSource: propPayload.currentSource || propPayload.componentSource || '',
              modifiedProps: propPayload.modifiedProps,
              framework: propPayload.framework || 'react',
              componentName: propPayload.componentName,
              imageService: this._imageGenService,
            });
            for await (const chunk of stream) {
              if (chunk.type === 'complete' && chunk.files) {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot) {
                  await this._codeGenService.writeToWorkspace(chunk.files, workspaceRoot);
                }
                this._postToPanel(canvasPanelId, {
                  type: 'canvasStreamChunk',
                  payload: { type: 'canvas_props_extracted', canvasId: propPayload.canvasId || '', generatedFiles: chunk.files }
                } as any);
              }
            }
          } catch (err: any) {
            this._postToPanel(canvasPanelId, {
              type: 'canvasStreamChunk',
              payload: { type: 'canvas_error', canvasId: propPayload.canvasId || '', error: err.message }
            } as any);
          }
        }
        break;
      }

      case 'canvasGenerateAllAssets': {
        const assetPayload = msg.payload || {};
        const assetCanvasId = assetPayload.canvasId || '';
        const unresolvedAssets = assetPayload.assets || [];
        if (unresolvedAssets.length > 0 && this._imageGenService?.isVisionAvailable) {
          try {
            const assetStream = this._canvasManager.generateDesignAssets(
              assetCanvasId, unresolvedAssets, this._imageGenService
            );
            for await (const assetChunk of assetStream) {
              this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: assetChunk } as any);
            }
          } catch (err: any) {
            this._postToPanel(canvasPanelId, {
              type: 'canvasStreamChunk',
              payload: { type: 'canvas_error', canvasId: assetCanvasId, error: `Asset generation failed: ${err.message}` }
            } as any);
          }
        } else if (!this._imageGenService?.isVisionAvailable) {
          this._postToPanel(canvasPanelId, {
            type: 'canvasStreamChunk',
            payload: { type: 'canvas_error', canvasId: assetCanvasId, error: 'Configure a Gemini or OpenAI API key to generate assets' }
          } as any);
        }
        break;
      }

      case 'canvasIntegrateComponent': {
        const intPayload = msg.payload || {};
        if (intPayload.codeFiles && intPayload.componentName) {
          try {
            const intSettings = this._getSettingsForPanel(this._canvasChatOrigin || this._sidebarId);
            const stream = this._canvasManager.integrateComponent(
              intPayload.canvasId || '',
              intPayload.codeFiles,
              intPayload.componentName,
              intPayload.framework || 'react',
              this._providerManager,
              intSettings,
              this._canvasChatOrigin || this._sidebarId
            );
            for await (const chunk of stream) {
              this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
            }
          } catch (err: any) {
            this._postToPanel(canvasPanelId, {
              type: 'canvasStreamChunk',
              payload: { type: 'canvas_error', canvasId: intPayload.canvasId || '', error: err.message }
            } as any);
          }
        }
        break;
      }

      case 'canvasElementEdits': {
        const editPayload = msg.payload || {};
        if (editPayload.currentCode && editPayload.edits?.length) {
          try {
            if (!this._imageGenService?.isVisionAvailable) {
              this._postToPanel(canvasPanelId, {
                type: 'canvasStreamChunk',
                payload: { type: 'canvas_error', canvasId: editPayload.canvasId || '', error: 'Configure a Gemini or OpenAI API key for element editing' }
              } as any);
              break;
            }
            const stream = this._canvasManager.applyElementEdits(
              editPayload.canvasId || '',
              editPayload,
              this._imageGenService
            );
            for await (const chunk of stream) {
              this._postToPanel(canvasPanelId, { type: 'canvasStreamChunk', payload: chunk } as any);
            }
          } catch (err: any) {
            this._postToPanel(canvasPanelId, {
              type: 'canvasStreamChunk',
              payload: { type: 'canvas_error', canvasId: editPayload.canvasId || '', error: err.message }
            } as any);
          }
        }
        break;
      }

      // F-15: `canvasRenderComponent` stub removed — it had no real producer
      // (it only wrote a temp file and posted a fake progress chunk). Component
      // preview rendering happens client-side in the webview iframe.

      case 'canvasSaveConfig': {
        const { provider, apiKey } = msg.payload || {};
        if (provider && apiKey) {
          const config = vscode.workspace.getConfiguration('mysti');
          // Provider-selection settings are NOT secrets — keep writing them.
          const isVideoProvider = provider === 'sora' || provider === 'veo';
          if (isVideoProvider) {
            await config.update('canvas.videoGenerationProvider', provider, true);
          } else {
            await config.update('canvas.imageGenerationProvider', provider, true);
          }
          // F-11: the API key goes into SecretStorage, NOT a plaintext setting.
          if (this._canvasSecrets) {
            const isOpenAi = provider === 'gpt-image-1.5' || provider === 'gpt-image-1'
              || provider === 'gpt-image-1-mini' || provider === 'sora';
            await this._canvasSecrets.set(isOpenAi ? 'openai' : 'gemini', apiKey);
            // Re-push keys into the generation services so the new key is live
            // without requiring a reload.
            await this._refreshCanvasGenKeys();
          } else {
            console.warn('[Mysti] Canvas: CanvasSecrets not wired — API key not saved.');
          }
          // Notify canvas that config is saved
          this._postToPanel(canvasPanelId, { type: 'canvasConfigSaved', payload: { provider } } as any);
        }
        break;
      }
    }
  }

  /**
   * Open Mysti in a new editor tab (detached panel)
   */
  public openInNewTab(): void {
    const panelId = `panel_${Date.now()}`;
    const panel = vscode.window.createWebviewPanel(
      'mysti.detachedChat',
      'Mysti',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true
      }
    );

    // Set the tab icon to Mysti logo
    panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'Mysti-Logo.png');

    const version = this._extensionContext.extension.packageJSON.version || '0.0.0';
    panel.webview.html = getWebviewContent(panel.webview, this._extensionUri, version);

    // Create a new conversation for this panel
    const newConversation = this._conversationManager.createNewConversation();

    // Register panel state
    this._panelStates.set(panelId, {
      id: panelId,
      webview: panel.webview,
      panel: panel,
      currentConversationId: newConversation.id,
      isSidebar: false
    });

    // Handle messages from detached panel
    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await this._handleMessage(message);
      }
    );

    // Cleanup on dispose
    panel.onDidDispose(() => {
      this._panelStates.delete(panelId);
      this._lastUserMessage.delete(panelId);
      this._lastMentionContext.delete(panelId);
      this._cancelledPanels.delete(panelId);
      // Cancel any running processes for this panel
      this._providerManager.cancelRequest(panelId);
      // Clean up per-panel context
      this._contextManager.clearPanelContext(panelId);
      // Clean up per-panel channel bridge state
      this._channelBridge.clearPanel(panelId);
      this._runningPanels.delete(panelId);
      // Clean up per-panel provider sessions (including persistent processes)
      for (const provider of this._providerManager.getAllProviders()) {
        provider.cancelCurrentRequest(panelId);
        if (typeof provider.disposePersistentProcess === 'function') {
          provider.disposePersistentProcess(panelId);
        }
      }
      // Clean up pending plan selections
      this._pendingPlanSelections.delete(panelId);
      for (const [planId, timer] of this._semiAutoPlanTimeouts.entries()) {
        clearTimeout(timer);
        this._semiAutoPlanTimeouts.delete(planId);
        this._pendingPlanData.delete(planId);
      }
      // Clean up autonomy level tracking
      this._panelAutonomyLevel.delete(panelId);
    });

    // Send initial state with the new conversation
    this._sendInitialState(panelId);

    // Pre-spawn persistent process so first message is instant
    this._tryPreSpawnPersistentProcess(panelId);
  }

  /**
   * Send message to a specific panel
   */
  private _postToPanel(panelId: string, message: WebviewMessage) {
    const state = this._panelStates.get(panelId);
    state?.webview.postMessage(message);
  }

  /**
   * Broadcast message to all panels
   */
  private _broadcastToAll(message: WebviewMessage) {
    this._panelStates.forEach(state => {
      state.webview.postMessage(message);
    });
  }

  /**
   * Smart message routing - broadcast global changes, target panel-specific
   */
  public postMessage(message: WebviewMessage, panelId?: string) {
    // Types that should broadcast to all panels
    const broadcastTypes = [
      'settingsChanged',
      'providerChanged',
      'contextUpdated',
      'conversationHistory'
    ];

    if (panelId && !broadcastTypes.includes(message.type)) {
      this._postToPanel(panelId, message);
    } else {
      this._broadcastToAll(message);
    }
  }

  // ============================================================================
  // Setup Management Methods
  // ============================================================================

  /**
   * Handle check setup request from webview
   */
  private async _handleCheckSetup(panelId: string): Promise<void> {
    const statuses = await this._setupManager.getSetupStatus();
    const npmAvailable = await this._setupManager.checkNpmAvailable();
    const anyReady = statuses.some(s => s.installed && s.authenticated);

    this._postToPanel(panelId, {
      type: 'setupStatus',
      payload: {
        providers: statuses,
        npmAvailable,
        anyReady
      }
    });

    // If no provider is ready, try auto-setup for the default provider
    if (!anyReady) {
      const config = vscode.workspace.getConfiguration('mysti');
      const defaultProvider = config.get<string>('defaultProvider', DEFAULT_PROVIDER);
      await this._runAutoSetup(defaultProvider, panelId);
    }
  }

  /**
   * Run auto-setup flow for a provider
   */
  private async _runAutoSetup(providerId: string, panelId: string): Promise<void> {
    const result = await this._setupManager.setupProvider(
      providerId,
      (step, message, progress) => {
        this._postToPanel(panelId, {
          type: 'setupProgress',
          payload: { step, providerId, message, progress }
        });
      }
    );

    if (result.success) {
      this._postToPanel(panelId, {
        type: 'setupComplete',
        payload: { providerId }
      });
    } else if (result.requiresManualStep === 'auth') {
      // CLI installed but needs auth - prompt user
      const provider = this._providerManager.getProvider(providerId);
      this._postToPanel(panelId, {
        type: 'authPrompt',
        payload: {
          providerId,
          displayName: provider?.displayName || providerId,
          message: `To use ${provider?.displayName || providerId}, you need to sign in. This will open your browser.`
        }
      });
    } else {
      // Installation failed - show manual instructions
      this._postToPanel(panelId, {
        type: 'setupFailed',
        payload: {
          providerId,
          error: result.error || 'Setup failed',
          canRetry: true,
          requiresManual: result.requiresManualStep === 'install'
        }
      });
    }
  }

  /**
   * Handle retry setup request
   */
  private async _handleRetrySetup(providerId: string, panelId: string): Promise<void> {
    await this._runAutoSetup(providerId, panelId);
  }

  /**
   * Handle user confirming authentication
   */
  private async _handleAuthConfirm(providerId: string, panelId: string): Promise<void> {
    // Verify CLI is actually installed before attempting auth
    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      this._postToPanel(panelId, {
        type: 'setupFailed',
        payload: {
          providerId,
          error: `Provider "${providerId}" not found`,
          canRetry: true,
          requiresManual: true
        }
      });
      return;
    }

    const discovery = await provider.discoverCli();
    if (!discovery.found) {
      // CLI not installed - need to install first
      this._postToPanel(panelId, {
        type: 'setupFailed',
        payload: {
          providerId,
          error: 'CLI is not installed. Please install it first before authenticating.',
          canRetry: true,
          requiresManual: true
        }
      });
      return;
    }

    this._postToPanel(panelId, {
      type: 'setupProgress',
      payload: {
        step: 'authenticating',
        providerId,
        message: 'Opening authentication...',
        progress: 80
      }
    });

    // Start auth flow (opens terminal/browser)
    await this._setupManager.authenticateProvider(providerId);

    // Poll for auth completion
    this._pollAuthStatus(providerId, panelId);
  }

  /**
   * Poll for authentication status completion
   */
  private async _pollAuthStatus(providerId: string, panelId: string): Promise<void> {
    const maxAttempts = 60; // 2 minutes with 2-second intervals
    let attempts = 0;

    const poll = async () => {
      attempts++;
      const provider = this._providerManager.getProviderInstance(providerId);
      if (!provider) {return;}

      const authStatus = await provider.checkAuthentication();

      if (authStatus.authenticated) {
        // Auth completed out-of-band — drop the cached status (it still says
        // unauthenticated) so the next wizard/availability read re-probes
        this._setupManager.invalidateProviderStatus(providerId);
        this._postToPanel(panelId, {
          type: 'setupComplete',
          payload: { providerId }
        });
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(poll, 2000);
      } else {
        // Timeout - user can retry
        this._postToPanel(panelId, {
          type: 'setupFailed',
          payload: {
            providerId,
            error: 'Authentication timed out. Please try again.',
            canRetry: true
          }
        });
      }
    };

    setTimeout(poll, 2000);
  }

  /**
   * Handle user skipping authentication for now
   */
  private async _handleAuthSkip(providerId: string, panelId: string): Promise<void> {
    // Check if any other provider is ready
    const statuses = await this._setupManager.getSetupStatus();
    const otherReady = statuses.find(s => s.providerId !== providerId && s.installed && s.authenticated);

    if (otherReady) {
      // Switch to the ready provider (per-panel + global fallback)
      await this._handleUpdateSettings({ provider: otherReady.providerId as ProviderType }, panelId);

      this._postToPanel(panelId, {
        type: 'setupComplete',
        payload: { providerId: otherReady.providerId }
      });
    } else {
      // No provider ready - show manual setup options
      this._postToPanel(panelId, {
        type: 'setupFailed',
        payload: {
          providerId,
          error: 'Authentication skipped. You can configure providers manually in settings.',
          canRetry: true,
          requiresManual: true
        }
      });
    }
  }

  /**
   * Handle user choosing to skip setup entirely
   */
  private _handleSkipSetup(panelId: string): void {
    // User wants to configure manually - send initial state to show the chat interface
    this._sendInitialState(panelId);
  }

  // ============================================================================
  // Setup Wizard Handlers (Enhanced Onboarding)
  // ============================================================================

  /**
   * Handle request for wizard status from webview
   */
  private async _handleRequestWizardStatus(panelId: string): Promise<void> {
    const status = await this._setupManager.getWizardStatus();
    this._postToPanel(panelId, {
      type: 'wizardStatus',
      payload: status
    });
  }

  /**
   * Handle start provider setup from wizard
   */
  private async _handleStartProviderSetup(
    payload: { providerId: string; autoInstall?: boolean },
    panelId: string
  ): Promise<void> {
    const { providerId, autoInstall = true } = payload;

    // Send initial checking step
    this._postToPanel(panelId, {
      type: 'providerSetupStep',
      payload: {
        providerId,
        step: 'checking',
        progress: 5,
        message: 'Checking current status...'
      }
    });

    const provider = this._providerManager.getProviderInstance(providerId);
    if (!provider) {
      this._postToPanel(panelId, {
        type: 'providerSetupStep',
        payload: {
          providerId,
          step: 'failed',
          progress: 0,
          message: `Provider "${providerId}" not found`
        }
      });
      return;
    }

    // Check if already installed
    const discovery = await provider.discoverCli();

    if (!discovery.found) {
      if (autoInstall) {
        // Try auto-install
        this._postToPanel(panelId, {
          type: 'providerSetupStep',
          payload: {
            providerId,
            step: 'downloading',
            progress: 15,
            message: 'Checking system requirements and permissions...'
          }
        });

        this._postToPanel(panelId, {
          type: 'providerSetupStep',
          payload: {
            providerId,
            step: 'installing',
            progress: 30,
            message: `Installing ${provider.displayName} CLI...`
          }
        });

        const installResult = await this._setupManager.autoInstallCli(providerId);

        if (!installResult.success) {
          // Build alternative commands from provider's install methods
          const alternativeCommands: Array<{ label: string; command: string }> = [];
          if (provider.getInstallMethods) {
            const methods = provider.getInstallMethods();
            methods.forEach(m => alternativeCommands.push({ label: m.label, command: m.command }));
          }
          if (alternativeCommands.length === 0) {
            alternativeCommands.push({ label: 'Manual install', command: provider.getInstallCommand() });
          }

          this._postToPanel(panelId, {
            type: 'providerSetupStep',
            payload: {
              providerId,
              step: 'failed',
              progress: 0,
              message: installResult.error || 'Installation failed',
              details: `Run: ${provider.getInstallCommand()}`,
              errorCategory: installResult.errorCategory,
              suggestedFix: installResult.suggestedFix,
              retryable: installResult.retryable !== false,
              alternativeCommands
            }
          });
          return;
        }

        this._postToPanel(panelId, {
          type: 'providerSetupStep',
          payload: {
            providerId,
            step: 'verifying',
            progress: 60,
            message: 'Verifying installation...'
          }
        });
      } else {
        // Manual install needed
        this._postToPanel(panelId, {
          type: 'providerSetupStep',
          payload: {
            providerId,
            step: 'failed',
            progress: 0,
            message: 'CLI not installed',
            details: `Run: ${provider.getInstallCommand()}`
          }
        });
        return;
      }
    }

    // CLI installed - check auth
    this._postToPanel(panelId, {
      type: 'providerSetupStep',
      payload: {
        providerId,
        step: 'verifying',
        progress: 70,
        message: 'Checking authentication...'
      }
    });

    const authStatus = await provider.checkAuthentication();

    if (!authStatus.authenticated) {
      // Check if provider has multiple auth options
      const authOptions = this._setupManager.getAuthOptions(providerId);

      if (authOptions.length > 1) {
        // Show auth options for providers like Gemini
        this._postToPanel(panelId, {
          type: 'authOptions',
          payload: {
            providerId,
            displayName: provider.displayName,
            options: authOptions
          }
        });
      } else {
        // Single auth method - prompt for auth
        this._postToPanel(panelId, {
          type: 'authPrompt',
          payload: {
            providerId,
            displayName: provider.displayName,
            message: `Sign in to ${provider.displayName} to continue`
          }
        });
      }
      return;
    }

    // Fully ready!
    this._postToPanel(panelId, {
      type: 'providerSetupStep',
      payload: {
        providerId,
        step: 'complete',
        progress: 100,
        message: 'Ready to use!',
        details: authStatus.user
      }
    });

    // Refresh wizard status
    const status = await this._setupManager.getWizardStatus();
    this._postToPanel(panelId, {
      type: 'wizardStatus',
      payload: status
    });
  }

  /**
   * Handle auth method selection from wizard
   */
  private async _handleSelectAuthMethod(
    payload: { providerId: string; method: string; apiKey?: string },
    panelId: string
  ): Promise<void> {
    const { providerId, method, apiKey } = payload;

    this._postToPanel(panelId, {
      type: 'providerSetupStep',
      payload: {
        providerId,
        step: 'authenticating',
        progress: 80,
        message: 'Authenticating...'
      }
    });

    const result = await this._setupManager.authenticateWithMethod(
      providerId,
      method as AuthMethodType,
      apiKey
    );

    if (result.authenticated) {
      this._postToPanel(panelId, {
        type: 'providerSetupStep',
        payload: {
          providerId,
          step: 'complete',
          progress: 100,
          message: 'Authentication successful!',
          details: result.user
        }
      });

      // Refresh wizard status
      const status = await this._setupManager.getWizardStatus();
      this._postToPanel(panelId, {
        type: 'wizardStatus',
        payload: status
      });
    } else if (method === 'oauth' || method === 'cli-login') {
      // OAuth flow - poll for completion
      this._pollAuthStatus(providerId, panelId);
    } else {
      this._postToPanel(panelId, {
        type: 'providerSetupStep',
        payload: {
          providerId,
          step: 'failed',
          progress: 0,
          message: result.error || 'Authentication failed'
        }
      });
    }
  }

  /**
   * Handle provider selection from wizard
   */
  private async _handleSelectProvider(providerId: string, panelId: string): Promise<void> {
    // Set as default provider (per-panel + global fallback)
    await this._handleUpdateSettings({ provider: providerId as ProviderType }, panelId);

    // Close wizard and show main UI
    this._postToPanel(panelId, {
      type: 'wizardComplete',
      payload: { providerId }
    });

    // Send initial state with the selected provider
    await this._sendInitialState(panelId);
  }

  /**
   * Handle wizard dismissal
   */
  private _handleDismissWizard(panelId: string, dontShowAgain?: boolean): void {
    if (dontShowAgain) {
      // Store preference
      this._extensionContext.globalState.update('mysti.setupWizardDismissed', true);
    }

    this._postToPanel(panelId, {
      type: 'wizardDismissed'
    });

    // Send initial state anyway - user can configure later
    this._sendInitialState(panelId);
  }

  /**
   * Handle refresh provider detection request
   * Clears cached detection results and re-runs discovery
   */
  private async _handleRefreshProviderDetection(panelId: string): Promise<void> {
    console.log('[Mysti] ChatViewProvider: Refreshing provider detection');

    // Force a full re-probe: resets the npm cache and bypasses the discovery
    // cache (and provider-side probe-failure TTLs) — Plan 03 Phase 3a.
    const wizardStatus = await this._setupManager.refreshWizardStatus();
    this._postToPanel(panelId, {
      type: 'wizardStatus',
      payload: wizardStatus
    });

    // Also update provider availability (same shape the webview consumes
    // from initialState / the late providerAvailability message)
    this._postToPanel(panelId, {
      type: 'providerAvailability',
      payload: { providerAvailability: this._buildProviderAvailability(wizardStatus) }
    });

    console.log('[Mysti] ChatViewProvider: Provider detection refreshed');
  }

  /**
   * Handle run diagnostics request from wizard
   */
  private async _handleRunDiagnostics(panelId: string): Promise<void> {
    console.log('[Mysti] ChatViewProvider: Running diagnostics');
    try {
      const result = await this._setupManager.runDiagnostics();
      this._postToPanel(panelId, {
        type: 'diagnosticsResult',
        payload: result
      });
    } catch (error) {
      console.error('[Mysti] ChatViewProvider: Diagnostics failed:', error);
      this._postToPanel(panelId, {
        type: 'diagnosticsResult',
        payload: {
          timestamp: Date.now(),
          platform: { os: process.platform, arch: process.arch, shell: 'unknown', hasNvm: false, nodeVersion: null, npmVersion: null },
          npmStatus: { available: false, canWriteGlobalDir: false },
          nodeStatus: { available: false, meetsMinimum: false },
          providers: [],
          networkReachable: false,
          recommendations: [`Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`]
        }
      });
    }
  }

  /**
   * Handle open terminal request
   * Opens a VSCode terminal with the install command pre-filled
   */
  private _handleOpenTerminal(payload: { providerId: string; command: string }): void {
    // If the command is a URL, open it in the browser instead of a terminal
    if (/^https?:\/\//.test(payload.command)) {
      vscode.env.openExternal(vscode.Uri.parse(payload.command));
      console.log(`[Mysti] ChatViewProvider: Opened URL for ${payload.providerId}: ${payload.command}`);
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: `Install ${payload.providerId}`,
      shellPath: process.platform === 'win32' ? undefined : process.env.SHELL
    });
    terminal.show();
    terminal.sendText(`# Run this command to install ${payload.providerId}:`);
    terminal.sendText(payload.command);
    console.log(`[Mysti] ChatViewProvider: Opened terminal for ${payload.providerId}`);
  }

  /**
   * Handle request for provider install info (from install modal)
   */
  private async _handleRequestProviderInstallInfo(
    payload: { providerId: string },
    panelId: string
  ): Promise<void> {
    const info = this._setupManager.getProviderSetupInfo(payload.providerId);
    const wizardStatus = await this._setupManager.getWizardStatus();
    const providerStatus = wizardStatus.providers.find(p => p.providerId === payload.providerId);

    // Get provider instance for capabilities and install methods
    const providerInstance = this._providerManager.getProviderInstance(payload.providerId);
    const supportsAutoInstall = providerInstance?.capabilities.supportsAutoInstall ?? true;
    const installMethods = providerInstance?.getInstallMethods?.() || [];

    this._postToPanel(panelId, {
      type: 'providerInstallInfo',
      payload: {
        providerId: payload.providerId,
        displayName: providerStatus?.displayName || payload.providerId,
        installCommand: info?.installCommand || '',
        authCommand: info?.authCommand || '',
        authInstructions: info?.authInstructions || [],
        docsUrl: info?.docsUrl,
        npmAvailable: wizardStatus.npmAvailable,
        supportsAutoInstall,
        installMethods
      }
    });
  }

  /**
   * Debug method: Force show setup UI for testing
   * Call this via the mysti.debugSetup command
   */
  public debugForceSetup(): void {
    // Show setup for sidebar panel
    this._postToPanel(this._sidebarId, {
      type: 'setupProgress',
      payload: {
        step: 'checking',
        providerId: 'claude-code',
        message: 'DEBUG: Simulating setup flow...',
        progress: 10
      }
    });

    // Simulate progress
    setTimeout(() => {
      this._postToPanel(this._sidebarId, {
        type: 'setupProgress',
        payload: {
          step: 'installing',
          providerId: 'claude-code',
          message: 'DEBUG: Simulating installation...',
          progress: 40
        }
      });
    }, 1000);

    setTimeout(() => {
      this._postToPanel(this._sidebarId, {
        type: 'authPrompt',
        payload: {
          providerId: 'claude-code',
          displayName: 'Claude Code',
          message: 'DEBUG: This is a test auth prompt. Click Sign In or Later to test the flow.'
        }
      });
    }, 2500);
  }

  /**
   * Debug method: Force show setup failure for testing
   */
  public debugForceSetupFailure(): void {
    this._postToPanel(this._sidebarId, {
      type: 'setupFailed',
      payload: {
        providerId: 'claude-code',
        error: 'DEBUG: Simulated failure - npm not available on your system.',
        canRetry: true,
        requiresManual: true
      }
    });
  }

  /**
   * Dispose the provider and clean up all resources
   * Critical: Prevents memory leaks from panel states and tracking maps
   */
  public dispose(): void {
    console.log('[Mysti] ChatViewProvider: Disposing and cleaning up resources');

    // Clean up all panel states
    for (const [, state] of this._panelStates) {
      if (state.panel) {
        state.panel.dispose();
      }
    }
    this._panelStates.clear();

    // Clear tracking maps
    this._lastUserMessage.clear();
    this._lastMentionContext.clear();
    this._cancelledPanels.clear();

    // Dispose managers that may have resources
    this._providerManager.dispose();
  }
}
