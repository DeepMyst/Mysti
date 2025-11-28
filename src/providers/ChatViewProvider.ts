import * as vscode from 'vscode';
import * as fs from 'fs';
import { ContextManager } from '../managers/ContextManager';
import { ConversationManager } from '../managers/ConversationManager';
import { ProviderManager } from '../managers/ProviderManager';
import { SuggestionManager } from '../managers/SuggestionManager';
import { BrainstormManager } from '../managers/BrainstormManager';
import { PermissionManager } from '../managers/PermissionManager';
import { PlanOptionManager } from '../managers/PlanOptionManager';
import { getWebviewContent } from '../webview/webviewContent';
import type { WebviewMessage, Settings, ContextItem, QuickActionSuggestion, Message, PermissionResponse, PlanSelectionResult, QuestionSubmission, ClarifyingQuestion } from '../types';

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
  private _contextManager: ContextManager;
  private _conversationManager: ConversationManager;
  private _providerManager: ProviderManager;
  private _suggestionManager: SuggestionManager;
  private _brainstormManager: BrainstormManager;
  private _permissionManager: PermissionManager;
  private _planOptionManager: PlanOptionManager;
  // Per-panel cancel tracking for isolated cancellation
  private _cancelledPanels: Set<string> = new Set();
  // Track last user message per panel for plan selection follow-up
  private _lastUserMessage: Map<string, string> = new Map();

  constructor(
    extensionUri: vscode.Uri,
    contextManager: ContextManager,
    conversationManager: ConversationManager,
    providerManager: ProviderManager,
    suggestionManager: SuggestionManager,
    brainstormManager: BrainstormManager,
    permissionManager: PermissionManager
  ) {
    this._extensionUri = extensionUri;
    this._contextManager = contextManager;
    this._conversationManager = conversationManager;
    this._providerManager = providerManager;
    this._suggestionManager = suggestionManager;
    this._brainstormManager = brainstormManager;
    this._permissionManager = permissionManager;
    this._planOptionManager = new PlanOptionManager();
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

    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri);

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
    const config = vscode.workspace.getConfiguration('mysti');
    const settings: Settings = {
      mode: config.get('defaultMode', 'ask-before-edit'),
      thinkingLevel: config.get('defaultThinkingLevel', 'medium'),
      accessLevel: config.get('accessLevel', 'ask-permission'),
      contextMode: config.get('autoContext', true) ? 'auto' : 'manual',
      model: config.get('defaultModel', 'claude-sonnet-4-5-20250929'),
      provider: config.get('defaultProvider', 'claude-code')
    };

    const panelState = this._panelStates.get(panelId);
    const conversation = panelState?.currentConversationId
      ? this._conversationManager.getConversation(panelState.currentConversationId)
      : this._conversationManager.getCurrentConversation();

    // Get workspace path for relative path display
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';

    this._postToPanel(panelId, {
      type: 'initialState',
      payload: {
        panelId,
        settings,
        context: this._contextManager.getContext(),
        conversation,
        providers: this._providerManager.getProviders(),
        slashCommands: this._getSlashCommands(),
        quickActions: this._getQuickActions(),
        workspacePath
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
        await this._handlePlanOptionSelected(
          message.payload as PlanSelectionResult,
          (message as any).panelId
        );
        break;

      case 'questionAnswered':
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

      // Pass panelId for per-panel process tracking
      const stream = this._providerManager.sendMessage(
        content,
        context,
        settings,
        conversation,
        undefined,
        panelId
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

          case 'session_active':
            this._postToPanel(panelId, {
              type: 'sessionActive',
              payload: { sessionId: chunk.sessionId }
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

            // Detect plan options in Plan mode
            if (settings.mode === 'plan') {
              this._detectAndSendPlanOptions(assistantMessage, panelId);
            }

            // Trigger async suggestion generation
            this._generateSuggestionsAsync(assistantMessage, panelId);
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
    // Handle brainstorm enabled toggle (from agent dropdown)
    if ((settings as any).brainstormEnabled !== undefined) {
      await config.update('brainstorm.enabled', (settings as any).brainstormEnabled, vscode.ConfigurationTarget.Global);
      this.postMessage({
        type: 'brainstormToggled',
        payload: { enabled: (settings as any).brainstormEnabled }
      });
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
    if (panelId) {
      this._postToPanel(panelId, {
        type: 'insertPrompt',
        payload: suggestion.message
      });
    }
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
   */
  private async _detectAndSendPlanOptions(message: Message, panelId: string): Promise<void> {
    try {
      // Use AI-powered classification to distinguish questions from plan options
      const result = await this._planOptionManager.classifyResponse(message.content);
      const originalQuery = this._lastUserMessage.get(panelId) || '';

      // Send clarifying questions if detected
      if (result.questions.length > 0) {
        console.log('[Mysti] Detected clarifying questions:', result.questions.length);
        this._postToPanel(panelId, {
          type: 'clarifyingQuestions',
          payload: {
            questions: result.questions,
            messageId: message.id,
            context: result.context
          }
        });
      }

      // Send plan options if detected (need at least 2 distinct options)
      if (result.planOptions.length >= 2) {
        console.log('[Mysti] Detected plan options:', result.planOptions.length);
        this._postToPanel(panelId, {
          type: 'planOptions',
          payload: {
            options: result.planOptions,
            messageId: message.id,
            originalQuery,
            context: result.context
          }
        });
      }
    } catch (error) {
      console.error('[Mysti] Response classification failed:', error);
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

    // Generate the follow-up prompt
    let followUpPrompt = this._planOptionManager.createSelectionPrompt(selectedPlan, originalQuery);

    // Append custom instructions if provided
    if (customInstructions?.trim()) {
      followUpPrompt += `\n\nAdditional instructions:\n${customInstructions.trim()}`;
    }

    // Handle "Keep Planning" mode differently - just insert the prompt
    if (executionMode === 'plan') {
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
    const config = vscode.workspace.getConfiguration('mysti');
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
   * Resolve a file path (relative or absolute) to an absolute path
   */
  private _resolveFilePath(filePath: string): string {
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
            '/mode [mode] - Show/change mode (ask-before-edit, edit-automatically, plan)\n' +
            '/model [model] - Show/change AI model\n' +
            '/agent [agent] - Switch agent (claude-code, openai-codex, brainstorm)\n' +
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
            const modes = ['ask-before-edit', 'edit-automatically', 'plan', 'brainstorm'];
            if (modes.includes(args)) {
              this._handleUpdateSettings({ mode: args as any });
              return `Mode changed to: ${args}`;
            }
            return `Invalid mode. Available modes: ${modes.join(', ')}`;
          }
          const config = vscode.workspace.getConfiguration('mysti');
          return `Current mode: ${config.get('defaultMode')}`;
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
        description: 'Switch AI agent (claude-code, openai-codex)',
        handler: (args: string) => {
          if (args) {
            const agents = ['claude-code', 'openai-codex'];
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

              const agentName = args === 'claude-code' ? 'Claude Code' : 'OpenAI Codex';
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
          const currentEnabled = config.get<boolean>('brainstorm.enabled', false);

          if (args === 'on' || args === 'enable') {
            config.update('brainstorm.enabled', true, true);
            if (panelId) {
              this._postToPanel(panelId, {
                type: 'brainstormToggled',
                payload: { enabled: true }
              });
            }
            return 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.';
          } else if (args === 'off' || args === 'disable') {
            config.update('brainstorm.enabled', false, true);
            if (panelId) {
              this._postToPanel(panelId, {
                type: 'brainstormToggled',
                payload: { enabled: false }
              });
            }
            return 'Brainstorm mode disabled. Using single agent.';
          } else if (args === 'status') {
            return currentEnabled
              ? 'Brainstorm mode is ON. Multiple agents will collaborate.'
              : 'Brainstorm mode is OFF. Using single agent.';
          }

          // Toggle if no args
          const newState = !currentEnabled;
          config.update('brainstorm.enabled', newState, true);
          if (panelId) {
            this._postToPanel(panelId, {
              type: 'brainstormToggled',
              payload: { enabled: newState }
            });
          }
          return newState
            ? 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.'
            : 'Brainstorm mode disabled. Using single agent.';
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

    panel.webview.html = getWebviewContent(panel.webview, this._extensionUri);

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
}
