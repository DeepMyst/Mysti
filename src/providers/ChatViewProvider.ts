/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
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
import { SetupManager } from '../managers/SetupManager';
import { TelemetryManager } from '../managers/TelemetryManager';
import { AgentLoader } from '../managers/AgentLoader';
import { AgentContextManager } from '../managers/AgentContextManager';
import { AutonomousManager } from '../managers/AutonomousManager';
import { MemoryManager } from '../managers/MemoryManager';
import { CompactionManager } from '../managers/CompactionManager';
import { AgentLifecycleManager } from '../managers/AgentLifecycleManager';
import { SlashCommandManager, type SlashCommandCallbacks } from '../managers/SlashCommandManager';
import { getWebviewContent } from '../webview/webviewContent';
import type { WebviewMessage, Settings, ContextItem, Attachment, QuickActionSuggestion, Message, PermissionResponse, PlanSelectionResult, QuestionSubmission, ClarifyingQuestion, AgentConfiguration, ProviderType, Mention, MentionTask, MentionTaskList, SubAgentResponse, AgentType, AskUserQuestionData, AskUserQuestionItem, CompactionEvent, UsageStats, Conversation, PlanOption, AuthMethodType, SubAgentQuestionCallback } from '../types';
import { AUTONOMOUS_CONTINUATION_DELAY_MS, SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S } from '../constants';
import { DEVELOPER_PERSONAS, DEVELOPER_SKILLS } from './base/IProvider';
import { validateModelName, validateProfileName } from '../utils/validation';

/**
 * Extended message type that includes the panelId field sent by the webview
 * alongside every WebviewMessage. This avoids `(message as any).panelId` casts.
 */
interface WebviewMessageWithPanel extends WebviewMessage {
  panelId: string;
}

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
  // Per-panel cancel tracking for isolated cancellation
  private _cancelledPanels: Set<string> = new Set();
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
    slashCommandManager: SlashCommandManager
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

    // Load agents asynchronously and track the promise
    this._agentInitPromise = this._initializeAgents();
  }

  /**
   * Initialize the agent system by loading all agent metadata
   */
  private async _initializeAgents(): Promise<void> {
    try {
      await this._agentLoader.loadAllMetadata();
      this._agentsLoaded = true;
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
      || vscode.workspace.getConfiguration('mysti').get<string>('defaultProvider', 'claude-code');
    // Validate provider exists in registry; fall back to claude-code if stale/removed
    if (provider && this._providerManager.getProvider(provider)) {
      return provider;
    }
    console.warn(`[Mysti] Provider '${provider}' not found in registry, falling back to claude-code`);
    return 'claude-code';
  }

  /**
   * Get the effective model for a panel (per-panel override or global default)
   */
  private _getPanelModel(panelId: string): string {
    const panelState = this._panelStates.get(panelId);
    const model = panelState?.settingsOverrides?.model
      || vscode.workspace.getConfiguration('mysti').get<string>('defaultModel', 'claude-sonnet-4-5-20250929');
    // Validate model belongs to the active provider; reset to provider default if stale
    const provider = this._getPanelProvider(panelId);
    const providerConfig = this._providerManager.getProvider(provider);
    if (providerConfig) {
      const validModel = providerConfig.models.some(m => m.id === model);
      if (!validModel) {
        console.warn(`[Mysti] Model '${model}' not valid for provider '${provider}', using default '${providerConfig.defaultModel}'`);
        return providerConfig.defaultModel;
      }
    }
    return model;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
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
  }

  private async _sendInitialState(panelId: string) {
    // Critical: Wait for agents to load before building initial state
    await this._agentInitPromise;

    // Get wizard status for provider availability
    const wizardStatus = await this._setupManager.getWizardStatus();

    // Check if any provider is ready - show wizard if not
    const wizardDismissed = this._extensionContext.globalState.get('mysti.setupWizardDismissed', false);
    if (!wizardDismissed && !wizardStatus.anyReady) {
      // No providers installed - show the setup wizard
      this._postToPanel(panelId, {
        type: 'showWizard',
        payload: wizardStatus
      });
      return;
    }

    const config = vscode.workspace.getConfiguration('mysti');

    // Get the configured provider — use per-panel override if set, else global config
    let selectedProvider: ProviderType = this._getPanelProvider(panelId) as ProviderType;
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
      thinkingLevel: config.get('defaultThinkingLevel', 'medium'),
      accessLevel: config.get('accessLevel', 'ask-permission'),
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: this._getPanelModel(panelId),
      provider: selectedProvider
    };

    // Read provider-specific custom model and profile settings
    const providerModelKeys: Record<string, string> = {
      'claude-code': 'claudeCodeModel',
      'openai-codex': 'codexModel',
      'google-gemini': 'geminiModel',
      'cline': 'clineModel',
      'github-copilot': 'copilotModel',
      'cursor': 'cursorModel',
      'openclaw': 'openclawModel'
    };
    const customModelKey = providerModelKeys[selectedProvider];
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

    // Get provider availability status for each provider
    const providers = this._providerManager.getProviders();
    const providerAvailability: Record<string, { available: boolean; installCommand?: string }> = {};
    for (const provider of providers) {
      const status = await this._providerManager.getProviderStatus(provider.name);
      providerAvailability[provider.name] = {
        available: status?.found ?? false,
        installCommand: status?.installCommand
      };
    }

    this._postToPanel(panelId, {
      type: 'initialState',
      payload: {
        panelId,
        settings,
        context: this._contextManager.getContext(panelId),
        conversation,
        providers,
        providerAvailability,
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
        permissionSettings
      }
    });
  }

  private async _handleMessage(message: WebviewMessage) {
    // Cast once: the webview always sends panelId alongside every message
    const msg = message as WebviewMessageWithPanel;
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
            const allAgentIds: AgentType[] = ['claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot', 'cursor', 'openclaw'];
            this._mentionRouter.cancelSubAgents(panelId, allAgentIds);
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
        await this._handleSlashCommand(
          msg.payload as { command?: string; commandId?: string; args?: string },
          msg.panelId
        );
        break;

      case 'openExternal': {
        const url = (msg.payload as { url: string })?.url;
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
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
          const allAgentIds: AgentType[] = ['claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot', 'cursor', 'openclaw'];
          this._mentionRouter.cancelSubAgents(panelId, allAgentIds);
          this._cancelPendingSubAgentQuestions(panelId);

          this._providerManager.clearSession(panelId);  // Clear provider session for this panel
          this._compactionManager.resetUsage(panelId);  // Reset compaction tracking
          this._lifecycleManager.removeSession(panelId);  // Clear lifecycle tracking
          const newConv = this._conversationManager.createNewConversation();

          if (panelState) {
            panelState.currentConversationId = newConv.id;
          }

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
                providerId: 'claude-code',
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
        {
          const panelId = msg.panelId;
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
            break;
          }

          const settings: Settings = {
            mode: config.get('defaultMode', 'default') as Settings['mode'],
            thinkingLevel: config.get('defaultThinkingLevel', 'medium') as Settings['thinkingLevel'],
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
          this._executeCompaction(panelId, settings, conversation, usage, contextWindow);
        }
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
      thinkingLevel: config.get('defaultThinkingLevel', 'medium') as Settings['thinkingLevel'],
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
    // Clear cancel flag for this panel
    this._cancelledPanels.delete(panelId);
    const { content, context, mentions, attachments } = payload;
    let { settings } = payload;

    // Track the user's message for plan selection follow-up
    this._lastUserMessage.set(panelId, content);

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
        console.log('[Mysti] Processing mentions:', mentions.length, 'mentions for panel:', panelId);
        const subAgentResponses = new Map<AgentType, SubAgentResponse>();

        // Store mention context for retry support
        this._lastMentionContext.set(panelId, { content, mentions, context, settings });

        const subAgentQuestionCallback = this._createSubAgentQuestionCallback(panelId);
        const mentionStream = this._mentionRouter.processMentions(
          content, mentions, context, settings, conversation, panelId, subAgentQuestionCallback
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
      let lastUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;

      // Send context window info when starting
      this._postToPanel(panelId, {
        type: 'contextWindowInfo',
        payload: {
          contextWindow: this._providerManager.getModelContextWindow(settings.provider, settings.model)
        }
      });

      for await (const chunk of stream) {
        // Check if THIS panel's request was cancelled
        if (this._cancelledPanels.has(panelId)) {break;}

        switch (chunk.type) {
          case 'text':
            assistantContent += chunk.content || '';
            this._postToPanel(panelId, {
              type: 'responseChunk',
              payload: { type: 'text', content: chunk.content }
            });
            break;

          case 'thinking':
            thinkingContent += chunk.content || '';
            this._postToPanel(panelId, {
              type: 'responseChunk',
              payload: { type: 'thinking', content: chunk.content }
            });
            break;

          case 'tool_use':
            this._postToPanel(panelId, {
              type: 'toolUse',
              payload: chunk.toolCall
            });
            break;

          case 'tool_result':
            this._postToPanel(panelId, {
              type: 'toolResult',
              payload: chunk.toolCall
            });
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
            const assistantMessage = this._conversationManager.addMessageToConversation(
              conversationId,
              'assistant',
              assistantContent,
              undefined,
              undefined,
              thinkingContent
            );
            console.log('[Mysti] Sending responseComplete with usage:', lastUsage);
            this._postToPanel(panelId, {
              type: 'responseComplete',
              payload: {
                message: assistantMessage,
                usage: lastUsage
              }
            });

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

            // Skip plan options and suggestions if there's a pending AskUserQuestion or plan selection
            if (!this._pendingAskUserQuestions.has(panelId) && !this._pendingPlanSelections.has(panelId)) {
              // Run classification to show visual questions and plan options
              // (brainstorm has its own handler via _handleBrainstormMessage)
              const hasInteractiveElements = await this._detectAndSendPlanOptions(assistantMessage, panelId);

              // Only generate suggestions if no interactive elements were detected
              if (!hasInteractiveElements) {
                this._generateSuggestionsAsync(assistantMessage, panelId);
              }
            }

            // Autonomous mode: check if we should auto-continue
            // Only continue if no pending questions or plan selections
            if (this._autonomousManager.isActive() && !this._pendingAskUserQuestions.has(panelId) && !this._pendingPlanSelections.has(panelId)) {
              const followUp = this._autonomousManager.shouldContinue(assistantContent);
              if (followUp) {
                const autoConfig = vscode.workspace.getConfiguration('mysti');
                const autoSettings: Settings = {
                  mode: 'edit-automatically' as Settings['mode'],
                  thinkingLevel: autoConfig.get('defaultThinkingLevel', 'medium') as Settings['thinkingLevel'],
                  accessLevel: 'full-access' as Settings['accessLevel'],
                  contextMode: autoConfig.get('autoContext', true) ? 'auto' : 'manual',
                  model: this._getPanelModel(panelId),
                  provider: this._getPanelProvider(panelId) as Settings['provider']
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

          case 'done': {
            const session = this._brainstormManager.getCurrentSession(panelId);
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

      // Auto-switch to a compatible model for the new provider
      const newProviderConfig = this._providerManager.getProvider(settings.provider);
      if (newProviderConfig) {
        const currentModel = panelId ? this._getPanelModel(panelId) : config.get<string>('defaultModel', '');
        const validModels = newProviderConfig.models.map(m => m.id);

        // If current model is not valid for the new provider, switch to the provider's default
        if (!validModels.includes(currentModel)) {
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

    // Handle custom model updates per provider
    const settingsAny = settings as Record<string, unknown>;
    if ('customModel' in settingsAny) {
      const customModel = settingsAny['customModel'] as string;
      const provider = settings.provider || config.get<string>('defaultProvider', 'claude-code');
      const providerModelKeys: Record<string, string> = {
        'claude-code': 'claudeCodeModel',
        'openai-codex': 'codexModel',
        'google-gemini': 'geminiModel',
        'cline': 'clineModel',
        'github-copilot': 'copilotModel',
        'cursor': 'cursorModel',
        'openclaw': 'openclawModel'
      };
      const settingKey = providerModelKeys[provider];
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
      // Validate: exactly 2 agents from valid set
      const validAgents = ['claude-code', 'openai-codex', 'google-gemini', 'cline', 'github-copilot', 'cursor', 'openclaw'];
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
    this._permissionManager.handleResponse(response);

    // Learn from the user's permission decision (passive memory building)
    const request = this._permissionManager.getPendingRequest(response.requestId);
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
    panelId: string
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

    // Send plan options to webview (existing rendering)
    const planPayload: { options: PlanOption[]; messageId: string; originalQuery: string; syntheticPlanId: string; metaQuestions?: ClarifyingQuestion[] } = { options, messageId, originalQuery, syntheticPlanId };
    if (metaQuestions && metaQuestions.length > 0) {
      planPayload.metaQuestions = metaQuestions;
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
   * Detect plan options and clarifying questions in an assistant message using AI classification
   * Returns true if interactive elements (questions or plans) were detected and sent
   */
  private async _detectAndSendPlanOptions(message: Message, panelId: string): Promise<boolean> {
    try {
      // Use AI-powered classification to distinguish questions from plan options
      const result = await this._planOptionManager.classifyResponse(message.content);
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
      thinkingLevel: config.get('defaultThinkingLevel', 'medium'),
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
      // Clean up per-panel provider sessions
      for (const provider of this._providerManager.getAllProviders()) {
        provider.cancelCurrentRequest(panelId);
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
      const defaultProvider = config.get<string>('defaultProvider', 'claude-code');
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

    // Reset npm cache in SetupManager
    this._setupManager.resetNpmCache();

    // Re-run discovery for all providers and send updated wizard status
    const wizardStatus = await this._setupManager.getWizardStatus();
    this._postToPanel(panelId, {
      type: 'wizardStatus',
      payload: wizardStatus
    });

    // Also update provider availability
    const providerStatuses = wizardStatus.providers.map(p => ({
      id: p.providerId,
      name: p.displayName,
      installed: p.installed,
      authenticated: p.authenticated
    }));

    this._postToPanel(panelId, {
      type: 'providerAvailability',
      payload: providerStatuses
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
