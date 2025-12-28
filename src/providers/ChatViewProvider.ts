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
import { PermissionManager } from '../managers/PermissionManager';
import { PlanOptionManager } from '../managers/PlanOptionManager';
import { SetupManager } from '../managers/SetupManager';
import { TelemetryManager } from '../managers/TelemetryManager';
import { AgentLoader } from '../managers/AgentLoader';
import { AgentContextManager } from '../managers/AgentContextManager';
import { getWebviewContent } from '../webview/webviewContent';
import type { WebviewMessage, Settings, ContextItem, QuickActionSuggestion, Message, PermissionResponse, PlanSelectionResult, QuestionSubmission, ClarifyingQuestion, AgentConfiguration, AgentTypeDiscriminator, ProviderType } from '../types';
import { DEVELOPER_PERSONAS, DEVELOPER_SKILLS } from './base/IProvider';

interface PanelState {
  id: string;
  webview: vscode.Webview;
  panel?: vscode.WebviewPanel;
  currentConversationId: string | null;
  isSidebar: boolean;
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
  // Per-panel cancel tracking for isolated cancellation
  private _cancelledPanels: Set<string> = new Set();
  // Track last user message per panel for plan selection follow-up
  private _lastUserMessage: Map<string, string> = new Map();
  // Track if agents have been loaded
  private _agentsLoaded: boolean = false;
  private _agentInitPromise: Promise<void>;
  // Track panels with pending AskUserQuestion (to suppress plan options/suggestions)
  private _pendingAskUserQuestions: Set<string> = new Set();

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
    telemetryManager: TelemetryManager
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
    this._planOptionManager = new PlanOptionManager();

    // Initialize agent system (three-tier loading)
    this._agentLoader = new AgentLoader(extensionContext);
    this._agentContextManager = new AgentContextManager(extensionContext, this._agentLoader);

    // Connect agent context manager to provider manager
    this._providerManager.setAgentContextManager(this._agentContextManager);

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

    // Get the configured provider, but auto-select first available if it's not installed
    let selectedProvider: ProviderType = config.get('defaultProvider', 'claude-code') as ProviderType;
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
      model: config.get('defaultModel', 'claude-sonnet-4-5-20250929'),
      provider: selectedProvider
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
    const brainstormAgents = vscode.workspace.getConfiguration('mysti')
      .get<string[]>('brainstorm.agents', ['claude-code', 'openai-codex']);

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
        context: this._contextManager.getContext(),
        conversation,
        providers,
        providerAvailability,
        slashCommands: this._getSlashCommands(),
        quickActions: this._getQuickActions(),
        workspacePath,
        agentConfig: conversation?.agentConfig,
        availablePersonas,
        availableSkills,
        agentSettings,
        brainstormAgents
      }
    });
  }

  private async _handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case 'sendMessage':
        await this._handleSendMessage(
          message.payload as {
            content: string;
            context: ContextItem[];
            settings: Settings;
          },
          (message as any).panelId
        );
        break;

      case 'quickActionWithConfig':
        {
          const panelId = (message as any).panelId;
          const payload = message.payload as {
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
          const panelId = (message as any).panelId;
          if (panelId) {
            // Add to cancelled panels set for per-panel tracking
            this._cancelledPanels.add(panelId);
            // Cancel only this panel's request
            this._providerManager.cancelRequest(panelId);
            this._brainstormManager.cancelSession(panelId);
            // Notify webview to reset UI state
            this._postToPanel(panelId, { type: 'requestCancelled' });
          }
        }
        break;

      case 'sendBrainstormMessage':
        await this._handleBrainstormMessage(
          message.payload as {
            content: string;
            context: ContextItem[];
            settings: Settings;
          },
          (message as any).panelId
        );
        break;

      case 'updateSettings':
        await this._handleUpdateSettings(message.payload as Partial<Settings>);
        break;

      case 'addToContext':
        await this._handleAddToContext(
          message.payload as { path: string; type: string },
          (message as any).panelId
        );
        break;

      case 'removeFromContext':
        {
          const panelId = (message as any).panelId;
          this._contextManager.removeFromContext(message.payload as string);
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'contextUpdated',
              payload: this._contextManager.getContext()
            });
          }
        }
        break;

      case 'clearContext':
        {
          const panelId = (message as any).panelId;
          this._contextManager.clearContext();
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'contextUpdated',
              payload: []
            });
          }
        }
        break;

      case 'executeSlashCommand':
        await this._handleSlashCommand(
          message.payload as { command: string; args: string },
          (message as any).panelId
        );
        break;

      case 'executeQuickAction':
        await this._handleQuickAction(message.payload as string, (message as any).panelId);
        break;

      case 'executeSuggestion':
        await this._handleExecuteSuggestion(
          message.payload as QuickActionSuggestion,
          (message as any).panelId
        );
        break;

      case 'enhancePrompt':
        await this._handleEnhancePrompt(message.payload as string, (message as any).panelId);
        break;

      case 'newConversation':
        {
          const panelId = (message as any).panelId;
          const panelState = this._panelStates.get(panelId);

          this._providerManager.clearSession();  // Clear Claude session
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
          const panelId = (message as any).panelId;
          this._providerManager.clearSession();
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'sessionCleared',
              payload: { message: 'Session cleared' }
            });
          }
        }
        break;

      case 'requestPermission':
        await this._handlePermissionRequest(
          message.payload as { action: string; details: string },
          (message as any).panelId
        );
        break;

      case 'permissionResponse':
        this._handlePermissionResponse(
          message.payload as PermissionResponse
        );
        break;

      case 'planOptionSelected':
        // Clear suggestions before handling plan selection
        this._postToPanel((message as any).panelId, { type: 'clearSuggestions' });

        await this._handlePlanOptionSelected(
          message.payload as PlanSelectionResult,
          (message as any).panelId
        );
        break;

      case 'questionAnswered':
        // Clear suggestions before handling question answers
        this._postToPanel((message as any).panelId, { type: 'clearSuggestions' });

        await this._handleQuestionAnswered(
          message.payload as QuestionSubmission,
          (message as any).panelId
        );
        break;

      case 'openFile':
        await this._handleOpenFile(message.payload as { path: string; line?: number });
        break;

      case 'applyEdit':
        await this._handleApplyEdit(
          message.payload as {
            path: string;
            content: string;
            startLine?: number;
            endLine?: number;
          },
          (message as any).panelId
        );
        break;

      case 'getWorkspaceFiles':
        await this._handleGetWorkspaceFiles((message as any).panelId);
        break;

      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(message.payload as string);
        break;

      case 'revertFileEdit':
        await this._handleRevertFileEdit(
          message.payload as { path: string },
          (message as any).panelId
        );
        break;

      case 'getFileLineNumber':
        // Support both message.payload and direct properties on message
        const fileLinePayload = message.payload || message;
        await this._handleGetFileLineNumber(
          {
            filePath: (fileLinePayload as any).filePath,
            searchText: (fileLinePayload as any).searchText
          },
          (message as any).panelId
        );
        break;

      case 'openInNewTab':
        vscode.commands.executeCommand('mysti.openInNewTab');
        break;

      case 'checkSetup':
        await this._handleCheckSetup((message as any).panelId);
        break;

      case 'retrySetup':
        await this._handleRetrySetup(
          (message.payload as { providerId: string }).providerId,
          (message as any).panelId
        );
        break;

      case 'authConfirm':
        await this._handleAuthConfirm(
          (message.payload as { providerId: string }).providerId,
          (message as any).panelId
        );
        break;

      case 'authSkip':
        await this._handleAuthSkip(
          (message.payload as { providerId: string }).providerId,
          (message as any).panelId
        );
        break;

      case 'skipSetup':
        this._handleSkipSetup((message as any).panelId);
        break;

      case 'requestWizardStatus':
        await this._handleRequestWizardStatus((message as any).panelId);
        break;

      case 'startProviderSetup':
        await this._handleStartProviderSetup(
          message.payload as { providerId: string; autoInstall?: boolean },
          (message as any).panelId
        );
        break;

      case 'selectAuthMethod':
        await this._handleSelectAuthMethod(
          message.payload as { providerId: string; method: string; apiKey?: string },
          (message as any).panelId
        );
        break;

      case 'selectProvider':
        await this._handleSelectProvider(
          (message.payload as { providerId: string }).providerId,
          (message as any).panelId
        );
        break;

      case 'dismissWizard':
        this._handleDismissWizard(
          (message as any).panelId,
          (message.payload as { dontShowAgain?: boolean } | undefined)?.dontShowAgain
        );
        break;

      case 'refreshProviderDetection':
        await this._handleRefreshProviderDetection((message as any).panelId);
        break;

      case 'openTerminal':
        this._handleOpenTerminal(
          message.payload as { providerId: string; command: string }
        );
        break;

      case 'requestProviderInstallInfo':
        await this._handleRequestProviderInstallInfo(
          message.payload as { providerId: string },
          (message as any).panelId
        );
        break;

      case 'getConversationHistory':
        {
          const panelId = (message as any).panelId;
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
          const panelId = (message as any).panelId;
          const switchId = (message.payload as { id: string }).id;
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
          const panelId = (message as any).panelId;
          const config = message.payload as AgentConfiguration;
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
          const panelId = (message as any).panelId;
          const deleteId = (message.payload as { id: string }).id;
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
          const panelId = (message as any).panelId;
          const query = (message.payload as { query: string }).query;

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
          const panelId = (message as any).panelId;
          const agentId = (message.payload as { agentId: string }).agentId;

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
        await this._handleAskUserQuestionResponse(
          message.payload as { toolCallId: string; answers: Record<string, string | string[]> },
          (message as any).panelId
        );
        break;

      case 'openTerminal':
        {
          const authCommand = message.payload as string;
          const terminal = vscode.window.createTerminal('Authenticate Provider');
          terminal.show();
          terminal.sendText(authCommand);
        }
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
          if (content[i] === '\n') lineNumber++;
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
    panelId: string
  ): Promise<void> {
    // Clear the pending AskUserQuestion tracking
    this._pendingAskUserQuestions.delete(panelId);

    // Send tool_result to mark the tool as completed
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

    // Format answers into a readable message for Claude
    const parts = ['Here are my answers:\n'];
    for (const [questionHeader, answer] of Object.entries(payload.answers)) {
      const formattedAnswer = Array.isArray(answer) ? answer.join(', ') : answer;
      parts.push(`**${questionHeader}**: ${formattedAnswer}`);
    }
    parts.push('\nPlease proceed based on these choices.');

    // Get settings from config
    const config = vscode.workspace.getConfiguration('mysti');
    const settings: Settings = {
      mode: config.get('defaultMode', 'ask-before-edit') as Settings['mode'],
      thinkingLevel: config.get('defaultThinkingLevel', 'medium') as Settings['thinkingLevel'],
      accessLevel: config.get('accessLevel', 'ask-permission') as Settings['accessLevel'],
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: config.get('defaultModel', 'claude-sonnet-4-5-20250929'),
      provider: config.get('defaultProvider', 'claude-code') as Settings['provider']
    };

    // Send as follow-up message
    await this._handleSendMessage(
      {
        content: parts.join('\n'),
        context: this._contextManager.getContext(),
        settings
      },
      panelId
    );
  }

  private async _handleSendMessage(
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

    // Track the user's message for plan selection follow-up
    this._lastUserMessage.set(panelId, content);

    // Get the panel's conversation
    const panelState = this._panelStates.get(panelId);
    const conversationId = panelState?.currentConversationId;
    const conversation = conversationId
      ? this._conversationManager.getConversation(conversationId)
      : null;

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

    // Stream response from provider
    try {
      this._postToPanel(panelId, { type: 'responseStarted' });

      // Get agent configuration for this conversation
      const agentConfig = conversationId
        ? this._conversationManager.getAgentConfig(conversationId)
        : undefined;

      // Pass panelId for per-panel process tracking
      const stream = this._providerManager.sendMessage(
        content,
        context,
        settings,
        conversation,
        undefined,
        panelId,
        agentConfig
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
        if (this._cancelledPanels.has(panelId)) break;

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
            this._postToPanel(panelId, {
              type: 'sessionActive',
              payload: { sessionId: chunk.sessionId }
            });
            break;

          case 'ask_user_question':
            // Track that this panel has a pending question (suppresses plan options/suggestions)
            this._pendingAskUserQuestions.add(panelId);
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
            break;

          case 'done':
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

            // Skip plan options and suggestions if there's a pending AskUserQuestion
            if (!this._pendingAskUserQuestions.has(panelId)) {
              // Run classification to show visual questions and plan options
              // (brainstorm has its own handler via _handleBrainstormMessage)
              const hasInteractiveElements = await this._detectAndSendPlanOptions(assistantMessage, panelId);

              // Only generate suggestions if no interactive elements were detected
              if (!hasInteractiveElements) {
                this._generateSuggestionsAsync(assistantMessage, panelId);
              }
            }
            break;
        }
      }
    } catch (error) {
      this._postToPanel(panelId, {
        type: 'error',
        payload: error instanceof Error ? error.message : 'An unknown error occurred'
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
        query: content,
        agents: this._brainstormManager.getCurrentSession(panelId)?.agents || []
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
        if (this._cancelledPanels.has(panelId)) break;

        switch (chunk.type) {
          case 'phase_change':
            this._postToPanel(panelId, {
              type: 'brainstormPhaseChange',
              payload: { phase: chunk.phase }
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
              payload: { agentId: chunk.agentId, content: chunk.content }
            });
            break;

          case 'synthesis_text':
            this._postToPanel(panelId, {
              type: 'brainstormSynthesisChunk',
              payload: { content: chunk.content }
            });
            break;

          case 'done':
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
    } catch (error) {
      this._postToPanel(panelId, {
        type: 'brainstormError',
        payload: { error: error instanceof Error ? error.message : 'An unknown error occurred' }
      });
    }
  }

  private async _handleUpdateSettings(settings: Partial<Settings>) {
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
      await config.update('defaultModel', settings.model, vscode.ConfigurationTarget.Global);
    }
    if (settings.provider !== undefined) {
      await config.update('defaultProvider', settings.provider, vscode.ConfigurationTarget.Global);

      // Auto-switch to a compatible model for the new provider
      const newProviderConfig = this._providerManager.getProvider(settings.provider);
      if (newProviderConfig) {
        const currentModel = config.get<string>('defaultModel', '');
        const validModels = newProviderConfig.models.map(m => m.id);

        // If current model is not valid for the new provider, switch to the provider's default
        if (!validModels.includes(currentModel)) {
          const newModel = newProviderConfig.defaultModel;
          await config.update('defaultModel', newModel, vscode.ConfigurationTarget.Global);
          console.log(`[Mysti] Auto-switched model to ${newModel} for ${settings.provider}`);

          // Notify the webview of the model change
          this.postMessage({
            type: 'modelChanged',
            payload: { model: newModel, provider: settings.provider }
          });
        }
      }
    }

    // Handle agent settings (passed with dot notation keys)
    const settingsAny = settings as Record<string, unknown>;
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
      const validAgents = ['claude-code', 'openai-codex', 'google-gemini', 'github-copilot'];
      const filtered = agents.filter(a => validAgents.includes(a));
      if (filtered.length === 2) {
        await config.update('brainstorm.agents', filtered, vscode.ConfigurationTarget.Global);
        console.log(`[Mysti] Updated brainstorm agents to: ${filtered.join(', ')}`);
      }
    }
  }

  private async _handleAddToContext(
    payload: { path: string; type: string },
    panelId?: string
  ) {
    if (payload.type === 'file') {
      await this._contextManager.addFileToContext(payload.path);
    } else if (payload.type === 'folder') {
      await this._contextManager.addFolderToContext(payload.path);
    }
    if (panelId) {
      this._postToPanel(panelId, {
        type: 'contextUpdated',
        payload: this._contextManager.getContext()
      });
    }
  }

  private async _handleSlashCommand(
    payload: { command: string; args: string },
    panelId?: string
  ) {
    const commands = this._getSlashCommands(panelId);
    const cmd = commands.find(c => c.name === payload.command);
    if (cmd) {
      const result = cmd.handler(payload.args);
      if (panelId) {
        this._postToPanel(panelId, {
          type: 'slashCommandResult',
          payload: { command: payload.command, result }
        });
      }
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
    if (!panelId) return;

    // Detect mode change suggestions
    const lowerMessage = suggestion.message.toLowerCase();

    // Check if this is an "exit plan mode" suggestion
    if (lowerMessage.includes('exit plan mode') ||
        lowerMessage.includes('exit planning') ||
        lowerMessage.includes('leave plan mode')) {

      // Auto-detect and execute mode change
      const config = vscode.workspace.getConfiguration('mysti');
      const currentMode = config.get<string>('defaultMode');
      const currentProvider = config.get<string>('defaultProvider');

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
    if (panelId && this._cancelledPanels.has(panelId)) return;

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
    if (!conversation) return;

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

      // Send clarifying questions if detected (these suppress plans)
      if (clarifyingQuestions.length > 0) {
        console.log('[Mysti] Detected clarifying questions:', clarifyingQuestions.length);
        this._postToPanel(panelId, {
          type: 'clarifyingQuestions',
          payload: {
            questions: clarifyingQuestions,
            messageId: message.id,
            context: result.context
          }
        });
        hasInteractiveElements = true;
      }

      // Send plan options if detected (even with meta-questions)
      // Only suppress if CLARIFYING questions exist
      if (result.planOptions.length >= 1 && clarifyingQuestions.length === 0) {
        console.log('[Mysti] Detected plan options:', result.planOptions.length);

        // Include meta-questions with plan options
        const planPayload: any = {
          options: result.planOptions,
          messageId: message.id,
          originalQuery,
          context: result.context
        };

        // Attach meta-questions if present
        if (metaQuestions.length > 0) {
          console.log('[Mysti] Including meta-questions with plans:', metaQuestions.length);
          planPayload.metaQuestions = metaQuestions;
        }

        this._postToPanel(panelId, {
          type: 'planOptions',
          payload: planPayload
        });
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

    // 3. Get current settings with the new mode
    const settings: Settings = {
      mode: executionMode,
      thinkingLevel: config.get('defaultThinkingLevel', 'medium'),
      accessLevel: config.get('accessLevel', 'ask-permission'),
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: config.get('defaultModel', 'claude-sonnet-4-5-20250929'),
      provider: config.get('defaultProvider', 'claude-code')
    };

    // 4. Auto-execute by calling _handleSendMessage directly
    await this._handleSendMessage(
      {
        content: followUpPrompt,
        context: this._contextManager.getContext(),
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
    const editor = await vscode.window.showTextDocument(document);

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

  private _getSlashCommands(panelId?: string) {
    return [
      {
        name: 'clear',
        description: 'Clear the conversation',
        handler: () => {
          this._providerManager.clearSession();
          this._conversationManager.createNewConversation();
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'sessionCleared',
              payload: { message: 'Session cleared' }
            });
          }
          return 'Conversation and session cleared';
        }
      },
      {
        name: 'help',
        description: 'Show available commands',
        handler: () => {
          return 'Available commands:\n' +
            '/clear - Clear conversation and session\n' +
            '/help - Show this help message\n' +
            '/context - Show current context items\n' +
            '/mode [mode] - Show/change mode (ask-before-edit, edit-automatically, quick-plan, detailed-plan)\n' +
            '/exit-plan-mode - Exit plan mode and switch to ask-before-edit\n' +
            '/exit-plan - Alias for /exit-plan-mode\n' +
            '/model [model] - Show/change AI model\n' +
            '/agent [agent] - Switch agent (claude-code, openai-codex, google-gemini, github-copilot, brainstorm)\n' +
            '/brainstorm [on|off|status] - Toggle brainstorm mode';
        }
      },
      {
        name: 'context',
        description: 'Show current context',
        handler: () => {
          const context = this._contextManager.getContext();
          return context.length > 0
            ? `Current context:\n${context.map(c => `- ${c.path}`).join('\n')}`
            : 'No context items added';
        }
      },
      {
        name: 'mode',
        description: 'Show or change operation mode',
        handler: (args: string) => {
          if (args) {
            // Note: brainstorm is an agent type, not a mode - use /brainstorm or /agent
            const modes = ['ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];
            const arg = args.trim();

            // Handle legacy 'plan' alias -> quick-plan
            const targetMode = arg === 'plan' ? 'quick-plan' : arg;

            if (modes.includes(targetMode)) {
              this._handleUpdateSettings({ mode: targetMode as any });
              return `Mode changed to: ${targetMode}`;
            }
            return `Invalid mode. Available modes: ${modes.join(', ')} (or 'plan' for quick-plan)`;
          }
          const config = vscode.workspace.getConfiguration('mysti');
          return `Current mode: ${config.get('defaultMode')}`;
        }
      },
      {
        name: 'exit-plan-mode',
        description: 'Exit plan mode and switch to ask-before-edit',
        handler: (args: string, panelId?: string) => {
          const config = vscode.workspace.getConfiguration('mysti');
          const currentMode = config.get<string>('defaultMode');
          const currentProvider = config.get<string>('defaultProvider');

          if (currentMode === 'quick-plan' || currentMode === 'detailed-plan') {
            // Log provider-specific exit for debugging
            console.log(`[Mysti] Exiting ${currentMode} mode (provider: ${currentProvider})`);

            // Clear any pending plan options or questions from UI
            if (panelId) {
              this._postToPanel(panelId, { type: 'clearPlanOptions' });
              this._postToPanel(panelId, { type: 'clearSuggestions' });
            }

            // Update mode setting
            this._handleUpdateSettings({ mode: 'ask-before-edit' });

            // Broadcast mode change to all panels
            this.postMessage({
              type: 'modeChanged',
              payload: { mode: 'ask-before-edit' }
            });

            return `Exited ${currentMode}. Switched to: ask-before-edit\n(Ready for implementation with ${currentProvider})`;
          } else {
            return 'Not currently in plan mode.';
          }
        }
      },
      {
        name: 'exit-plan',
        description: 'Alias for /exit-plan-mode',
        handler: (args: string, panelId?: string) => {
          const config = vscode.workspace.getConfiguration('mysti');
          const currentMode = config.get<string>('defaultMode');
          const currentProvider = config.get<string>('defaultProvider');

          if (currentMode === 'quick-plan' || currentMode === 'detailed-plan') {
            // Log provider-specific exit for debugging
            console.log(`[Mysti] Exiting ${currentMode} mode (provider: ${currentProvider})`);

            // Clear any pending plan options or questions from UI
            if (panelId) {
              this._postToPanel(panelId, { type: 'clearPlanOptions' });
              this._postToPanel(panelId, { type: 'clearSuggestions' });
            }

            // Update mode setting
            this._handleUpdateSettings({ mode: 'ask-before-edit' });

            // Broadcast mode change to all panels
            this.postMessage({
              type: 'modeChanged',
              payload: { mode: 'ask-before-edit' }
            });

            return `Exited ${currentMode}. Switched to: ask-before-edit\n(Ready for implementation with ${currentProvider})`;
          } else {
            return 'Not currently in plan mode.';
          }
        }
      },
      {
        name: 'model',
        description: 'Show or change model',
        handler: (args: string) => {
          if (args) {
            this._handleUpdateSettings({ model: args });
            return `Model changed to: ${args}`;
          }
          const config = vscode.workspace.getConfiguration('mysti');
          return `Current model: ${config.get('defaultModel')}`;
        }
      },
      {
        name: 'agent',
        description: 'Switch AI agent (claude-code, openai-codex, google-gemini, github-copilot)',
        handler: (args: string) => {
          if (args) {
            const agents = ['claude-code', 'openai-codex', 'google-gemini', 'github-copilot'];
            if (agents.includes(args)) {
              // Get the new provider's default model for feedback
              const newProviderConfig = this._providerManager.getProvider(args);
              const config = vscode.workspace.getConfiguration('mysti');
              const currentModel = config.get<string>('defaultModel', '');
              const validModels = newProviderConfig?.models.map(m => m.id) || [];
              const willSwitchModel = !validModels.includes(currentModel);
              const newModel = newProviderConfig?.defaultModel || currentModel;

              this._handleUpdateSettings({ provider: args as any });
              if (panelId) {
                this._postToPanel(panelId, {
                  type: 'agentChanged',
                  payload: { agent: args }
                });
              }

              const agentNames: Record<string, string> = {
                'claude-code': 'Claude Code',
                'openai-codex': 'OpenAI Codex',
                'google-gemini': 'Gemini',
                'github-copilot': 'GitHub Copilot'
              };
              const agentName = agentNames[args] || args;
              if (willSwitchModel && newProviderConfig) {
                return `Switched to ${agentName} (model auto-switched to ${newModel})`;
              }
              return `Switched to ${agentName}`;
            }
            return `Invalid agent. Available agents: ${agents.join(', ')}`;
          }
          const config = vscode.workspace.getConfiguration('mysti');
          const current = config.get('defaultProvider') || 'claude-code';
          return `Current agent: ${current}`;
        }
      },
      {
        name: 'brainstorm',
        description: 'Toggle brainstorm mode (multi-agent collaboration)',
        handler: (args: string) => {
          const config = vscode.workspace.getConfiguration('mysti');
          const currentProvider = config.get<string>('defaultProvider', 'claude-code');
          const isBrainstormActive = currentProvider === 'brainstorm';

          if (args === 'on' || args === 'enable') {
            config.update('defaultProvider', 'brainstorm', true);
            if (panelId) {
              this._postToPanel(panelId, {
                type: 'agentChanged',
                payload: { agent: 'brainstorm' }
              });
            }
            return 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.';
          } else if (args === 'off' || args === 'disable') {
            config.update('defaultProvider', 'claude-code', true);
            if (panelId) {
              this._postToPanel(panelId, {
                type: 'agentChanged',
                payload: { agent: 'claude-code' }
              });
            }
            return 'Brainstorm mode disabled. Using Claude Code.';
          } else if (args === 'status') {
            return isBrainstormActive
              ? 'Brainstorm mode is ON. Multiple agents will collaborate.'
              : 'Brainstorm mode is OFF. Using single agent.';
          }

          // Toggle if no args
          const newProvider = isBrainstormActive ? 'claude-code' : 'brainstorm';
          config.update('defaultProvider', newProvider, true);
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'agentChanged',
              payload: { agent: newProvider }
            });
          }
          return newProvider === 'brainstorm'
            ? 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.'
            : 'Brainstorm mode disabled. Using Claude Code.';
        }
      }
    ];
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
      this._cancelledPanels.delete(panelId);
      // Cancel any running processes for this panel
      this._providerManager.cancelRequest(panelId);
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
      if (!provider) return;

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
      // Switch to the ready provider
      const config = vscode.workspace.getConfiguration('mysti');
      await config.update('defaultProvider', otherReady.providerId, vscode.ConfigurationTarget.Global);

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
            message: 'Preparing installation...'
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
          this._postToPanel(panelId, {
            type: 'providerSetupStep',
            payload: {
              providerId,
              step: 'failed',
              progress: 0,
              message: installResult.error || 'Installation failed',
              details: `Run: ${provider.getInstallCommand()}`
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
      method as any,
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
    // Set as default provider
    const config = vscode.workspace.getConfiguration('mysti');
    await config.update('defaultProvider', providerId, vscode.ConfigurationTarget.Global);

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
   * Handle open terminal request
   * Opens a VSCode terminal with the install command pre-filled
   */
  private _handleOpenTerminal(payload: { providerId: string; command: string }): void {
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
    const provider = wizardStatus.providers.find(p => p.providerId === payload.providerId);

    this._postToPanel(panelId, {
      type: 'providerInstallInfo',
      payload: {
        providerId: payload.providerId,
        displayName: provider?.displayName || payload.providerId,
        installCommand: info?.installCommand || '',
        authCommand: info?.authCommand || '',
        authInstructions: info?.authInstructions || [],
        docsUrl: info?.docsUrl,
        npmAvailable: wizardStatus.npmAvailable
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
    for (const [panelId, state] of this._panelStates) {
      if (state.panel) {
        state.panel.dispose();
      }
    }
    this._panelStates.clear();

    // Clear tracking maps
    this._lastUserMessage.clear();
    this._cancelledPanels.clear();

    // Dispose managers that may have resources
    this._providerManager.dispose();
  }
}
