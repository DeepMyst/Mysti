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
import type { ProviderManager } from './ProviderManager';
import type { ContextManager } from './ContextManager';
import type { ConversationManager } from './ConversationManager';
import type { CompactionManager } from './CompactionManager';
import type { MemoryManager } from './MemoryManager';
import type { BrainstormManager } from './BrainstormManager';
import type {
  SlashCommandDefinition,
  SlashCommandSectionInfo,
  SlashCommandSection,
  ProviderType,
  WebviewMessage
} from '../types';

interface SlashCommandManagerDeps {
  providerManager: ProviderManager;
  contextManager: ContextManager;
  conversationManager: ConversationManager;
  compactionManager: CompactionManager;
  memoryManager: MemoryManager;
  brainstormManager: BrainstormManager;
}

/**
 * Callbacks provided by ChatViewProvider for executing side-effects
 */
export interface SlashCommandCallbacks {
  postToPanel: (panelId: string, message: WebviewMessage) => void;
  updateSettings: (settings: Record<string, unknown>, panelId?: string) => Promise<void>;
  getPanelProvider: (panelId: string) => string;
  getPanelModel: (panelId: string) => string;
}

/**
 * Central registry for slash commands. Merges universal commands with
 * provider-specific commands, resolves dynamic values, and dispatches
 * command execution to the appropriate managers.
 */
export class SlashCommandManager {
  private _providerManager: ProviderManager;
  private _contextManager: ContextManager;
  private _conversationManager: ConversationManager;
  private _compactionManager: CompactionManager;
  private _memoryManager: MemoryManager;
  private _brainstormManager: BrainstormManager;

  private static readonly _sections: SlashCommandSectionInfo[] = [
    { id: 'context',   label: 'Context',   order: 1 },
    { id: 'model',     label: 'Model',     order: 2 },
    { id: 'customize', label: 'Customize', order: 3 },
    { id: 'commands',  label: 'Commands',  order: 4 },
    { id: 'settings',  label: 'Settings',  order: 5 },
    { id: 'support',   label: 'Support',   order: 6 },
  ];

  /** Maps legacy command names to new IDs */
  private static readonly _legacyCommandMap: Record<string, string> = {
    'clear': 'cmd:clear',
    'help': 'cmd:help',
    'context': 'context:show',
    'mode': 'settings:mode',
    'model': 'model:switch',
    'agent': 'provider:switch',
    'brainstorm': 'cmd:brainstorm',
    'exit-plan-mode': 'cmd:exit-plan',
    'exit-plan': 'cmd:exit-plan',
    'compact': 'claude:compact',
  };

  constructor(deps: SlashCommandManagerDeps) {
    this._providerManager = deps.providerManager;
    this._contextManager = deps.contextManager;
    this._conversationManager = deps.conversationManager;
    this._compactionManager = deps.compactionManager;
    this._memoryManager = deps.memoryManager;
    this._brainstormManager = deps.brainstormManager;
  }

  /**
   * Map a legacy command name (e.g., 'clear') to a new command ID (e.g., 'cmd:clear')
   */
  public mapLegacyCommand(name: string): string {
    return SlashCommandManager._legacyCommandMap[name] || `cmd:${name}`;
  }

  /**
   * Get all commands relevant to the given panel and active provider.
   * Merges universal + provider-specific commands, resolves dynamic values.
   */
  public getCommands(
    panelId: string,
    activeProvider: ProviderType,
    callbacks: SlashCommandCallbacks,
    _query?: string
  ): { sections: SlashCommandSectionInfo[]; commands: SlashCommandDefinition[] } {
    // 1. Collect universal commands
    const universalCmds = this._getUniversalCommands(panelId, activeProvider, callbacks);

    // 2. Get provider-specific commands
    let providerCmds: SlashCommandDefinition[] = [];
    try {
      const providerInstance = this._providerManager.getProviderInstance(activeProvider);
      if (providerInstance?.getSlashCommands) {
        providerCmds = providerInstance.getSlashCommands(panelId) || [];
      }
    } catch {
      // Provider not available, skip its commands
    }

    // 3. Merge and filter to active provider
    const allCmds = [...universalCmds, ...providerCmds].filter(cmd =>
      cmd.provider === 'all' || cmd.provider === activeProvider
    );

    // 4. Resolve dynamic values
    this._resolveDynamicValues(allCmds, panelId, activeProvider, callbacks);

    // 5. Only include sections that have commands
    const usedSections = new Set<SlashCommandSection>(allCmds.map(c => c.section));
    const sections = SlashCommandManager._sections.filter(s => usedSections.has(s.id));

    return { sections, commands: allCmds };
  }

  /**
   * Execute a command by its ID. Returns a result string for display, or void.
   */
  public async executeCommand(
    commandId: string,
    args: string,
    panelId: string,
    callbacks: SlashCommandCallbacks
  ): Promise<string | void> {
    const trimmedArgs = args.trim();

    switch (commandId) {
      // ---- Context ----
      case 'context:attach': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Add to Context',
        });
        if (uris && uris.length > 0) {
          for (const uri of uris) {
            this._contextManager.addFileToContext(uri.fsPath, panelId);
          }
          callbacks.postToPanel(panelId, {
            type: 'contextUpdated',
            payload: this._contextManager.getContext(panelId)
          });
          return `Added ${uris.length} file(s) to context`;
        }
        return;
      }

      case 'context:mention':
        // Set the input to '@' to trigger the mention menu
        callbacks.postToPanel(panelId, { type: 'setInputValue', payload: '@' });
        return;

      case 'context:show': {
        const context = this._contextManager.getContext(panelId);
        return context.length > 0
          ? `Current context:\n${context.map(c => `- ${c.path}`).join('\n')}`
          : 'No context items added';
      }

      case 'context:clear':
        this._contextManager.clearContext(panelId);
        callbacks.postToPanel(panelId, { type: 'contextUpdated', payload: [] });
        return 'Context cleared';

      // ---- Model ----
      case 'model:switch': {
        if (trimmedArgs) {
          await callbacks.updateSettings({ model: trimmedArgs }, panelId);
          return `Model changed to: ${trimmedArgs}`;
        }
        const selectedModel = await this._selectModel(panelId, callbacks);
        if (selectedModel) {
          await callbacks.updateSettings({ model: selectedModel }, panelId);
          return `Model changed to: ${this._getModelDisplayName(selectedModel)}`;
        }
        return;
      }

      case 'provider:switch': {
        if (trimmedArgs) {
          const agents = ['claude-code', 'openai-codex', 'google-gemini', 'github-copilot', 'cursor', 'cline', 'openclaw'];
          if (agents.includes(trimmedArgs)) {
            return this._applyProviderSwitch(trimmedArgs, panelId, callbacks);
          }
          return `Invalid provider. Available: ${agents.join(', ')}`;
        }
        const selectedProvider = await this._selectProvider(panelId, callbacks);
        if (selectedProvider) {
          return this._applyProviderSwitch(selectedProvider, panelId, callbacks);
        }
        return;
      }

      // ---- Commands ----
      case 'cmd:clear':
        this._providerManager.clearSession(panelId);
        this._conversationManager.createNewConversation();
        callbacks.postToPanel(panelId, {
          type: 'sessionCleared',
          payload: { message: 'Session cleared' }
        });
        return 'Conversation and session cleared';

      case 'cmd:help':
        return this._getHelpText(panelId, callbacks);

      case 'cmd:brainstorm': {
        const currentProvider = callbacks.getPanelProvider(panelId);
        const isBrainstormActive = currentProvider === 'brainstorm';

        if (trimmedArgs === 'on' || trimmedArgs === 'enable') {
          await callbacks.updateSettings({ provider: 'brainstorm' }, panelId);
          callbacks.postToPanel(panelId, { type: 'agentChanged', payload: { agent: 'brainstorm' } });
          return 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.';
        } else if (trimmedArgs === 'off' || trimmedArgs === 'disable') {
          await callbacks.updateSettings({ provider: 'claude-code' }, panelId);
          callbacks.postToPanel(panelId, { type: 'agentChanged', payload: { agent: 'claude-code' } });
          return 'Brainstorm mode disabled. Using Claude Code.';
        } else if (trimmedArgs === 'status') {
          return isBrainstormActive
            ? 'Brainstorm mode is ON. Multiple agents will collaborate.'
            : 'Brainstorm mode is OFF. Using single agent.';
        }

        // Toggle if no args
        const newProvider = isBrainstormActive ? 'claude-code' : 'brainstorm';
        await callbacks.updateSettings({ provider: newProvider }, panelId);
        callbacks.postToPanel(panelId, { type: 'agentChanged', payload: { agent: newProvider } });
        return newProvider === 'brainstorm'
          ? 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.'
          : 'Brainstorm mode disabled. Using Claude Code.';
      }

      case 'cmd:exit-plan': {
        const config = vscode.workspace.getConfiguration('mysti');
        const currentMode = config.get<string>('defaultMode');

        if (currentMode === 'quick-plan' || currentMode === 'detailed-plan') {
          const currentProv = callbacks.getPanelProvider(panelId);
          console.log(`[Mysti] Exiting ${currentMode} mode (provider: ${currentProv})`);

          callbacks.postToPanel(panelId, { type: 'clearPlanOptions' });
          callbacks.postToPanel(panelId, { type: 'clearSuggestions' });
          await callbacks.updateSettings({ mode: 'ask-before-edit' });

          return `Exited ${currentMode}. Switched to: ask-before-edit\n(Ready for implementation with ${currentProv})`;
        }
        return 'Not currently in plan mode.';
      }

      // ---- Settings ----
      case 'settings:mode': {
        if (trimmedArgs) {
          const modes = ['ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];
          const targetMode = trimmedArgs === 'plan' ? 'quick-plan' : trimmedArgs;
          if (modes.includes(targetMode)) {
            await callbacks.updateSettings({ mode: targetMode });
            return `Mode changed to: ${targetMode}`;
          }
          return `Invalid mode. Available modes: ${modes.join(', ')} (or 'plan' for quick-plan)`;
        }
        const selectedMode = await this._selectOperationMode();
        if (selectedMode) {
          await callbacks.updateSettings({ mode: selectedMode });
          return `Mode changed to: ${selectedMode}`;
        }
        return;
      }

      case 'settings:thinking': {
        if (trimmedArgs) {
          const levels = ['none', 'low', 'medium', 'high'];
          if (levels.includes(trimmedArgs)) {
            await callbacks.updateSettings({ thinkingLevel: trimmedArgs });
            return `Thinking level changed to: ${trimmedArgs}`;
          }
          return `Invalid level. Available: ${levels.join(', ')}`;
        }
        const selectedThinking = await this._selectThinkingLevel();
        if (selectedThinking) {
          await callbacks.updateSettings({ thinkingLevel: selectedThinking });
          return `Thinking level changed to: ${selectedThinking}`;
        }
        return;
      }

      case 'settings:access': {
        if (trimmedArgs) {
          const levels = ['read-only', 'ask-permission', 'full-access'];
          if (levels.includes(trimmedArgs)) {
            await callbacks.updateSettings({ accessLevel: trimmedArgs });
            return `Access level changed to: ${trimmedArgs}`;
          }
          return `Invalid level. Available: ${levels.join(', ')}`;
        }
        const selectedAccess = await this._selectAccessLevel();
        if (selectedAccess) {
          await callbacks.updateSettings({ accessLevel: selectedAccess });
          return `Access level changed to: ${selectedAccess}`;
        }
        return;
      }

      case 'settings:open':
        vscode.commands.executeCommand('workbench.action.openSettings', 'mysti');
        return;

      // ---- Support ----
      case 'support:help':
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/DeepMyst/Mysti/tree/main/docs'));
        return;

      case 'support:report':
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/DeepMyst/Mysti/issues'));
        return;

      case 'support:version': {
        const ext = vscode.extensions.getExtension('deepmyst.mysti');
        const version = ext?.packageJSON?.version || 'unknown';
        return `Mysti v${version}`;
      }

      // ---- Provider-specific: Claude ----
      case 'claude:compact':
        callbacks.postToPanel(panelId, {
          type: 'sendCliPassthrough',
          payload: { command: '/compact' }
        });
        return 'Compacting conversation...';

      case 'claude:thinking': {
        if (trimmedArgs) {
          const levels = ['none', 'low', 'medium', 'high'];
          if (levels.includes(trimmedArgs)) {
            await callbacks.updateSettings({ thinkingLevel: trimmedArgs });
            return `Thinking level changed to: ${trimmedArgs}`;
          }
          return `Invalid level. Available: ${levels.join(', ')}`;
        }
        // Cycle through levels
        const config = vscode.workspace.getConfiguration('mysti');
        const current = config.get<string>('defaultThinkingLevel', 'medium');
        const cycle = ['none', 'low', 'medium', 'high'];
        const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
        await callbacks.updateSettings({ thinkingLevel: cycle[nextIdx] });
        return `Thinking level: ${cycle[nextIdx]}`;
      }

      // ---- Provider-specific: Codex ----
      case 'codex:profile': {
        if (trimmedArgs) {
          const config = vscode.workspace.getConfiguration('mysti');
          await config.update('codexProfile', trimmedArgs, vscode.ConfigurationTarget.Global);
          return `Codex profile changed to: ${trimmedArgs}`;
        }
        const config = vscode.workspace.getConfiguration('mysti');
        const profile = config.get<string>('codexProfile', '');
        return profile ? `Current Codex profile: ${profile}` : 'No Codex profile set';
      }

      // ---- Provider-specific: Cline ----
      case 'cline:plan-act': {
        const config = vscode.workspace.getConfiguration('mysti');
        const currentMode = config.get<string>('defaultMode', 'ask-before-edit');
        const isPlanMode = currentMode === 'quick-plan' || currentMode === 'detailed-plan';
        const newMode = isPlanMode ? 'ask-before-edit' : 'quick-plan';
        await callbacks.updateSettings({ mode: newMode });
        return `Cline mode: ${isPlanMode ? 'act' : 'plan'}`;
      }

      // ---- Terminal launch (any provider) ----
      default: {
        if (commandId.endsWith(':terminal')) {
          const providerId = commandId.replace(':terminal', '');
          const providerInstance = this._providerManager.getProviderInstance(providerId as ProviderType);
          if (providerInstance) {
            const cliPath = providerInstance.getCliPath() || providerId;
            const terminal = vscode.window.createTerminal(`Mysti: ${providerInstance.displayName || providerId}`);
            terminal.show();
            terminal.sendText(cliPath);
            return;
          }
          return `Provider not found: ${providerId}`;
        }
        return `Unknown command: ${commandId}`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Universal command definitions
  // ---------------------------------------------------------------------------

  private _getUniversalCommands(
    _panelId: string,
    _activeProvider: ProviderType,
    _callbacks: SlashCommandCallbacks
  ): SlashCommandDefinition[] {
    return [
      // -- Context --
      {
        id: 'context:attach',
        label: 'Attach file...',
        description: 'Add a file to context',
        section: 'context',
        icon: 'new-file',
        provider: 'all',
        action: 'execute',
        keywords: ['file', 'add', 'include'],
      },
      {
        id: 'context:mention',
        label: 'Mention file from project...',
        description: 'Reference a workspace file',
        section: 'context',
        icon: 'mention',
        provider: 'all',
        action: 'execute',
        keywords: ['@', 'file', 'reference'],
      },
      {
        id: 'context:show',
        label: 'Show context',
        description: 'Display current context items',
        section: 'context',
        icon: 'list-flat',
        provider: 'all',
        action: 'execute',
        keywords: ['context', 'files', 'list'],
      },
      {
        id: 'context:clear',
        label: 'Clear context',
        description: 'Remove all context items',
        section: 'context',
        icon: 'clear-all',
        provider: 'all',
        action: 'execute',
        keywords: ['context', 'remove', 'reset'],
      },

      // -- Model --
      {
        id: 'model:switch',
        label: 'Switch model...',
        description: 'Change the AI model',
        section: 'model',
        icon: 'hubot',
        provider: 'all',
        action: 'execute',
        keywords: ['model', 'change', 'llm'],
      },
      {
        id: 'provider:switch',
        label: 'Switch provider...',
        description: 'Change the AI provider',
        section: 'model',
        icon: 'server',
        provider: 'all',
        action: 'execute',
        keywords: ['provider', 'agent', 'switch', 'claude', 'codex', 'gemini', 'copilot'],
      },

      // -- Commands --
      {
        id: 'cmd:clear',
        label: '/clear',
        description: 'Clear conversation and session',
        section: 'commands',
        icon: 'trash',
        provider: 'all',
        action: 'execute',
        keywords: ['clear', 'reset', 'new'],
      },
      {
        id: 'cmd:help',
        label: '/help',
        description: 'Show available commands',
        section: 'commands',
        icon: 'question',
        provider: 'all',
        action: 'execute',
        keywords: ['help', 'commands', 'list'],
      },
      {
        id: 'cmd:brainstorm',
        label: '/brainstorm',
        description: 'Toggle brainstorm mode',
        section: 'commands',
        icon: 'organization',
        provider: 'all',
        action: 'execute',
        isToggle: true,
        keywords: ['brainstorm', 'multi', 'agent', 'collaborate'],
      },
      {
        id: 'cmd:exit-plan',
        label: '/exit-plan-mode',
        description: 'Exit plan mode',
        section: 'commands',
        icon: 'sign-out',
        provider: 'all',
        action: 'execute',
        keywords: ['exit', 'plan', 'mode'],
      },

      // -- Settings --
      {
        id: 'settings:mode',
        label: 'Operation mode',
        description: 'Change operation mode',
        section: 'settings',
        icon: 'settings-gear',
        provider: 'all',
        action: 'execute',
        keywords: ['mode', 'ask', 'edit', 'plan'],
      },
      {
        id: 'settings:thinking',
        label: 'Thinking level',
        description: 'Adjust thinking depth',
        section: 'settings',
        icon: 'lightbulb',
        provider: 'all',
        action: 'execute',
        keywords: ['thinking', 'depth', 'reasoning'],
      },
      {
        id: 'settings:access',
        label: 'Access level',
        description: 'Change permission level',
        section: 'settings',
        icon: 'shield',
        provider: 'all',
        action: 'execute',
        keywords: ['access', 'permission', 'read', 'write'],
      },
      {
        id: 'settings:open',
        label: 'Mysti settings...',
        description: 'Open Mysti extension settings',
        section: 'settings',
        icon: 'gear',
        provider: 'all',
        action: 'execute',
        keywords: ['settings', 'config', 'preferences'],
      },

      // -- Support --
      {
        id: 'support:help',
        label: 'View help docs',
        description: 'Open documentation',
        section: 'support',
        icon: 'book',
        provider: 'all',
        action: 'external',
        url: 'https://github.com/DeepMyst/Mysti/tree/main/docs',
        keywords: ['docs', 'documentation', 'help'],
      },
      {
        id: 'support:report',
        label: 'Report a problem',
        description: 'Report a bug on GitHub',
        section: 'support',
        icon: 'bug',
        provider: 'all',
        action: 'external',
        url: 'https://github.com/DeepMyst/Mysti/issues',
        keywords: ['bug', 'issue', 'problem', 'report'],
      },
      {
        id: 'support:version',
        label: 'Version',
        description: 'Show extension version',
        section: 'support',
        icon: 'info',
        provider: 'all',
        action: 'execute',
        keywords: ['version', 'about'],
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Private: Resolve dynamic values
  // ---------------------------------------------------------------------------

  private _resolveDynamicValues(
    commands: SlashCommandDefinition[],
    panelId: string,
    activeProvider: ProviderType,
    callbacks: SlashCommandCallbacks
  ): void {
    const config = vscode.workspace.getConfiguration('mysti');

    for (const cmd of commands) {
      switch (cmd.id) {
        case 'model:switch':
          cmd.currentValue = this._getModelDisplayName(callbacks.getPanelModel(panelId));
          break;
        case 'provider:switch':
          cmd.currentValue = this._getProviderDisplayName(activeProvider);
          break;
        case 'settings:mode':
          cmd.currentValue = config.get<string>('defaultMode', 'ask-before-edit');
          break;
        case 'settings:thinking':
          cmd.currentValue = config.get<string>('defaultThinkingLevel', 'medium');
          break;
        case 'settings:access':
          cmd.currentValue = config.get<string>('accessLevel', 'ask-permission');
          break;
        case 'cmd:brainstorm':
          cmd.toggleState = callbacks.getPanelProvider(panelId) === 'brainstorm';
          break;
        case 'support:version': {
          const ext = vscode.extensions.getExtension('deepmyst.mysti');
          cmd.currentValue = `v${ext?.packageJSON?.version || '?'}`;
          break;
        }
        case 'claude:thinking':
          cmd.currentValue = config.get<string>('defaultThinkingLevel', 'medium');
          break;
        case 'codex:profile': {
          const profile = config.get<string>('codexProfile', '');
          cmd.currentValue = profile || 'default';
          break;
        }
      }
    }
  }

  private _getModelDisplayName(modelId: string): string {
    // Shorten common model IDs for display
    const shortNames: Record<string, string> = {
      'claude-opus-4-6': 'Opus 4.6',
      'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
      'claude-opus-4-5-20250918': 'Opus 4.5',
      'claude-haiku-4-5-20251001': 'Haiku 4.5',
      'gpt-5.3-codex': 'GPT-5.3 Codex',
      'gpt-5.2-codex': 'GPT-5.2 Codex',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
    };
    return shortNames[modelId] || modelId;
  }

  private _getProviderDisplayName(providerId: string): string {
    const names: Record<string, string> = {
      'claude-code': 'Claude Code',
      'openai-codex': 'OpenAI Codex',
      'google-gemini': 'Gemini',
      'github-copilot': 'GitHub Copilot',
      'cursor': 'Cursor',
      'cline': 'Cline',
      'openclaw': 'OpenClaw',
      'brainstorm': 'Brainstorm',
    };
    return names[providerId] || providerId;
  }

  // ---------------------------------------------------------------------------
  // Private: QuickPick selection helpers
  // ---------------------------------------------------------------------------

  private async _selectModel(
    panelId: string,
    callbacks: SlashCommandCallbacks
  ): Promise<string | undefined> {
    const currentProvider = callbacks.getPanelProvider(panelId);
    const currentModel = callbacks.getPanelModel(panelId);
    const providerConfig = this._providerManager.getProvider(currentProvider);

    if (!providerConfig || providerConfig.models.length === 0) {
      vscode.window.showWarningMessage('No models available for the current provider');
      return undefined;
    }

    const items = providerConfig.models.map(model => ({
      label: model.id === currentModel ? `$(check) ${model.name}` : model.name,
      description: model.id,
      detail: model.description,
      modelId: model.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a model',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    return selected?.modelId;
  }

  private async _selectProvider(
    panelId: string,
    callbacks: SlashCommandCallbacks
  ): Promise<string | undefined> {
    const currentProvider = callbacks.getPanelProvider(panelId);
    const allProviders = this._providerManager.getProviders();

    const items = allProviders.map(p => ({
      label: p.name === currentProvider ? `$(check) ${p.displayName}` : p.displayName,
      description: p.name,
      detail: `Models: ${p.models.map(m => m.name).join(', ')}`,
      providerId: p.name,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a provider',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    return selected?.providerId;
  }

  private async _selectOperationMode(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('mysti');
    const current = config.get<string>('defaultMode', 'ask-before-edit');

    const items: { label: string; description: string; detail: string; modeId: string }[] = [
      { label: 'Ask Before Edit', description: 'ask-before-edit', detail: 'AI will ask permission before making changes', modeId: 'ask-before-edit' },
      { label: 'Edit Automatically', description: 'edit-automatically', detail: 'AI will make changes without asking', modeId: 'edit-automatically' },
      { label: 'Quick Plan', description: 'quick-plan', detail: 'AI will generate a quick implementation plan', modeId: 'quick-plan' },
      { label: 'Detailed Plan', description: 'detailed-plan', detail: 'AI will generate a detailed implementation plan', modeId: 'detailed-plan' },
    ];

    for (const item of items) {
      if (item.modeId === current) {
        item.label = `$(check) ${item.label}`;
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select operation mode',
    });

    return selected?.modeId;
  }

  private async _selectThinkingLevel(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('mysti');
    const current = config.get<string>('defaultThinkingLevel', 'medium');

    const items: { label: string; description: string; detail: string; levelId: string }[] = [
      { label: 'None', description: 'none', detail: 'No extended thinking', levelId: 'none' },
      { label: 'Low', description: 'low', detail: 'Minimal extended thinking', levelId: 'low' },
      { label: 'Medium', description: 'medium', detail: 'Balanced thinking depth', levelId: 'medium' },
      { label: 'High', description: 'high', detail: 'Deep reasoning and analysis', levelId: 'high' },
    ];

    for (const item of items) {
      if (item.levelId === current) {
        item.label = `$(check) ${item.label}`;
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select thinking level',
    });

    return selected?.levelId;
  }

  private async _selectAccessLevel(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('mysti');
    const current = config.get<string>('accessLevel', 'ask-permission');

    const items: { label: string; description: string; detail: string; levelId: string }[] = [
      { label: 'Read Only', description: 'read-only', detail: 'AI can only read files, no modifications', levelId: 'read-only' },
      { label: 'Ask Permission', description: 'ask-permission', detail: 'AI will ask before making changes', levelId: 'ask-permission' },
      { label: 'Full Access', description: 'full-access', detail: 'AI has full read/write access', levelId: 'full-access' },
    ];

    for (const item of items) {
      if (item.levelId === current) {
        item.label = `$(check) ${item.label}`;
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select access level',
    });

    return selected?.levelId;
  }

  private async _applyProviderSwitch(
    providerId: string,
    panelId: string,
    callbacks: SlashCommandCallbacks
  ): Promise<string> {
    const newProviderConfig = this._providerManager.getProvider(providerId);
    const currentModel = callbacks.getPanelModel(panelId);
    const validModels = newProviderConfig?.models.map(m => m.id) || [];
    const willSwitchModel = !validModels.includes(currentModel);
    const newModel = newProviderConfig?.defaultModel || currentModel;

    await callbacks.updateSettings({ provider: providerId }, panelId);
    callbacks.postToPanel(panelId, {
      type: 'agentChanged',
      payload: { agent: providerId }
    });

    const agentName = this._getProviderDisplayName(providerId);
    if (willSwitchModel && newProviderConfig) {
      return `Switched to ${agentName} (model auto-switched to ${newModel})`;
    }
    return `Switched to ${agentName}`;
  }

  private _getHelpText(panelId: string, callbacks: SlashCommandCallbacks): string {
    const activeProvider = callbacks.getPanelProvider(panelId);
    let text = 'Available commands:\n' +
      '/clear - Clear conversation and session\n' +
      '/help - Show this help message\n' +
      '/context - Show current context items\n' +
      '/mode [mode] - Show/change mode (ask-before-edit, edit-automatically, quick-plan, detailed-plan)\n' +
      '/exit-plan-mode - Exit plan mode\n' +
      '/model [model] - Show/change AI model\n' +
      '/agent [agent] - Switch provider\n' +
      '/brainstorm [on|off|status] - Toggle brainstorm mode';

    if (activeProvider === 'claude-code') {
      text += '\n/compact - Compact conversation context';
    }
    return text;
  }
}
