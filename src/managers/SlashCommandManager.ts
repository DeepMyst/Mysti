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
import { DEFAULT_PROVIDER } from '../constants';
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
  WebviewMessage,
  ModelInfo
} from '../types';
import {
  NATIVE_COMMANDS,
  nativeCommandId,
  parseNativeCommandId,
  type NativeCommandSpec,
} from '../providers/base/NativeCommands';
import type { NativeCommandDiscovery } from '../services/NativeCommandDiscovery';

interface SlashCommandManagerDeps {
  providerManager: ProviderManager;
  contextManager: ContextManager;
  conversationManager: ConversationManager;
  compactionManager: CompactionManager;
  memoryManager: MemoryManager;
  brainstormManager: BrainstormManager;
  /**
   * Source of the user's own commands for each backend (`.claude/commands`,
   * `.gemini/commands`, `.cursor/commands`, …). Optional so existing tests can
   * construct the manager without a filesystem; the native section then holds
   * the curated catalog alone.
   */
  nativeCommandDiscovery?: NativeCommandDiscovery;
}

/**
 * What a provider-native command turns into when it is run. The manager
 * resolves; ChatViewProvider dispatches, because sending a turn needs the
 * panel's settings and context, which only the webview's send payload carries.
 */
export type ResolvedNativeCommand =
  /** Run Mysti's own equivalent instead of the backend's version. */
  | { kind: 'mysti'; commandId: string }
  /** Send this text to the backend as the turn's prompt. */
  | { kind: 'prompt'; text: string }
  /** Put this in the composer and let the user finish typing the arguments. */
  | { kind: 'prefill'; text: string };

/**
 * Callbacks provided by ChatViewProvider for executing side-effects
 */
export interface SlashCommandCallbacks {
  postToPanel: (panelId: string, message: WebviewMessage) => void;
  updateSettings: (settings: Record<string, unknown>, panelId?: string) => Promise<void>;
  getPanelProvider: (panelId: string) => string;
  getPanelModel: (panelId: string) => string;
  /**
   * Merged model list for a provider (Plan 01 Phase 1) — backed by the
   * ModelRegistryService so the `/model` QuickPick shows the same curated +
   * discovered + custom set as the dropdown, not the raw bundled config.models.
   */
  getModelsForProvider: (providerId: string) => ModelInfo[];
  /**
   * Provider-neutral manual compaction (Plan 02 Phase 2, C7) — routes through
   * CompactionManager, which picks native-cli vs client-summarize from the
   * provider's supportsNativeCompact capability.
   */
  executeManualCompaction: (panelId: string) => Promise<void>;
}

/**
 * True when a command cannot run without arguments.
 *
 * `<condition>` is required, `[instructions]` is optional — the convention the
 * catalog and the CLIs' own help text both use. Getting this backwards makes a
 * perfectly valid bare `/compact` impossible to run from the menu.
 */
function requiresArguments(hint: string | undefined): boolean {
  return !!hint && hint.trim().startsWith('<');
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
  private _nativeCommandDiscovery?: NativeCommandDiscovery;

  private static readonly _sections: SlashCommandSectionInfo[] = [
    { id: 'context',   label: 'Context',   order: 1 },
    { id: 'model',     label: 'Model',     order: 2 },
    { id: 'customize', label: 'Customize', order: 3 },
    { id: 'commands',  label: 'Commands',  order: 4 },
    // Label is replaced per-provider in getCommands() — this section holds the
    // ACTIVE backend's own vocabulary, so it is titled after that backend
    // ("Claude commands") rather than with a generic heading.
    { id: 'native',    label: 'CLI Commands', order: 5 },
    { id: 'settings',  label: 'Settings',  order: 6 },
    { id: 'support',   label: 'Support',   order: 7 },
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
    // C7: /compact is provider-neutral — CompactionManager branches on the
    // provider's supportsNativeCompact capability, so non-Claude providers
    // get client-side summarization instead of a Claude-only CLI passthrough.
    'compact': 'cmd:compact',
    'export': 'cmd:export',
    'import': 'cmd:import',
    'share': 'cmd:share',
    'init-team': 'cmd:init-team',
    'memory': 'cmd:memory',
    'rules': 'cmd:rules',
    'visual-test': 'cmd:visual-test',
    'canvas': 'cmd:canvas',
  };

  constructor(deps: SlashCommandManagerDeps) {
    this._providerManager = deps.providerManager;
    this._contextManager = deps.contextManager;
    this._conversationManager = deps.conversationManager;
    this._compactionManager = deps.compactionManager;
    this._memoryManager = deps.memoryManager;
    this._brainstormManager = deps.brainstormManager;
    this._nativeCommandDiscovery = deps.nativeCommandDiscovery;
  }

  /**
   * Map a legacy command name (e.g., 'clear') to a new command ID (e.g., 'cmd:clear')
   */
  public mapLegacyCommand(name: string): string {
    return SlashCommandManager._legacyCommandMap[name] || `cmd:${name}`;
  }

  /**
   * True when `commandId` is a command Mysti itself handles for the given panel/
   * provider. Used to decide native pass-through: an UNKNOWN `/command` (e.g.
   * Claude Code's `/deep-research`, a `/skill-name`, or a saved workflow) is not
   * a Mysti command and is forwarded verbatim to the backend instead.
   */
  public isKnownCommand(
    commandId: string,
    panelId: string,
    activeProvider: ProviderType,
    callbacks: SlashCommandCallbacks,
  ): boolean {
    if (commandId.endsWith(':terminal')) {
      return true;
    }
    // A name Mysti explicitly claims is OWNED even when it has no menu row.
    // `cmd:compact` is the case that matters: it is provider-neutral (it picks
    // native-CLI vs client-side summarization from the backend's capabilities)
    // and is reachable only by typing, so judging ownership by menu membership
    // alone would forward `/compact` to the backend and quietly bypass
    // CompactionManager.
    if (Object.values(SlashCommandManager._legacyCommandMap).includes(commandId)) {
      return true;
    }
    try {
      const { commands } = this.getCommands(panelId, activeProvider, callbacks);
      return commands.some(c => c.id === commandId);
    } catch {
      // If we can't resolve the registry, treat as known so we never accidentally
      // leak a Mysti command to the backend.
      return true;
    }
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

    // 3. The active backend's OWN commands — curated catalog, plus whatever the
    //    user has authored on disk, plus anything an ACP agent reported live.
    const nativeCmds = this._getNativeCommands(panelId, activeProvider);

    // 4. Merge and filter to active provider
    const allCmds = [...universalCmds, ...providerCmds, ...nativeCmds].filter(cmd =>
      cmd.provider === 'all' || cmd.provider === activeProvider
    );

    // 5. Resolve dynamic values
    this._resolveDynamicValues(allCmds, panelId, activeProvider, callbacks);

    // 6. Only include sections that have commands, and title the native section
    //    after the backend whose commands it holds.
    const usedSections = new Set<SlashCommandSection>(allCmds.map(c => c.section));
    const sections = SlashCommandManager._sections
      .filter(s => usedSections.has(s.id))
      .map(s => s.id === 'native'
        ? { ...s, label: `${this._getProviderDisplayName(activeProvider)} commands` }
        : s);

    return { sections, commands: allCmds };
  }

  /**
   * Build the provider-native section for one panel.
   *
   * Three sources, in precedence order — a name found earlier wins, so a repo
   * cannot shadow a curated built-in with a file of the same name:
   *   1. NATIVE_COMMANDS   — the CLI's own built-ins Mysti can actually run
   *   2. the provider      — live list from an ACP agent, when it sends one
   *   3. discovery         — `.claude/commands`, `.gemini/commands`, skills, …
   */
  private _getNativeCommands(
    panelId: string,
    activeProvider: ProviderType
  ): SlashCommandDefinition[] {
    const out: SlashCommandDefinition[] = [];
    const claimed = new Set<string>();

    const add = (
      spec: NativeCommandSpec,
      origin: SlashCommandDefinition['origin']
    ): void => {
      if (claimed.has(spec.name)) { return; }
      claimed.add(spec.name);
      out.push({
        id: nativeCommandId(activeProvider, spec.name),
        label: `/${spec.name}`,
        description: spec.description,
        section: 'native',
        icon: spec.icon ?? 'terminal',
        provider: activeProvider,
        action: 'execute',
        // Only the entries actually handed to the CLI are pass-through; the
        // ones mapped onto a Mysti command are not, and the webview must not
        // treat them as text to send.
        isCliPassthrough: spec.execution.kind !== 'mysti',
        nativeName: spec.name,
        argumentHint: spec.argumentHint,
        origin,
        keywords: spec.keywords,
      });
    };

    for (const spec of NATIVE_COMMANDS[activeProvider] ?? []) {
      add(spec, 'builtin');
    }

    // ACP backends (Hermes, Kimi) are told their command list by the agent at
    // session start; it is the only accurate source for them.
    for (const spec of this._getDynamicNativeCommands(panelId, activeProvider)) {
      add(spec, 'agent');
    }

    for (const found of this._nativeCommandDiscovery?.getCached(activeProvider) ?? []) {
      add(
        {
          name: found.name,
          description: found.description,
          icon: found.origin === 'project' ? 'repo' : 'account',
          execution: found.execution,
        },
        found.origin
      );
    }

    return out;
  }

  /**
   * Rescan the active backend's command directories if the cache has gone
   * stale. Resolves to `true` only when the visible set actually changed, so
   * the caller re-posts a menu only when it would look different.
   */
  public async refreshNativeCommands(providerId: string): Promise<boolean> {
    if (!this._nativeCommandDiscovery) { return false; }
    try {
      return await this._nativeCommandDiscovery.refreshIfStale(providerId);
    } catch {
      // Discovery is a convenience; the curated catalog stands without it.
      return false;
    }
  }

  /**
   * Map a BARE command name the user typed (`design`, `frontend:audit`) onto a
   * native command id for the active provider, or null if the backend has no
   * such command.
   *
   * Without this, a typed `/name` and the same entry picked from the menu would
   * behave differently: the menu resolves `expand` commands by reading the
   * user's template, while a typed one would be forwarded verbatim to a CLI
   * whose headless mode cannot expand it.
   */
  public findNativeCommandId(
    name: string,
    panelId: string,
    activeProvider: ProviderType
  ): string | null {
    if (!name) { return null; }
    const known =
      (NATIVE_COMMANDS[activeProvider] ?? []).some(c => c.name === name) ||
      (this._nativeCommandDiscovery?.getCached(activeProvider) ?? []).some(c => c.name === name) ||
      this._getDynamicNativeCommands(panelId, activeProvider).some(c => c.name === name);
    return known ? nativeCommandId(activeProvider, name) : null;
  }

  /** Live command list from an ACP backend; never throws. */
  private _getDynamicNativeCommands(
    panelId: string,
    activeProvider: ProviderType
  ): NativeCommandSpec[] {
    try {
      const instance = this._providerManager.getProviderInstance(activeProvider);
      return instance?.getDynamicNativeCommands?.(panelId) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Turn a `native:<provider>:<name>` id into something runnable, or null when
   * the id names no command this provider has.
   */
  public resolveNativeCommand(
    commandId: string,
    panelId: string,
    activeProvider: ProviderType,
    args: string
  ): ResolvedNativeCommand | null {
    const parsed = parseNativeCommandId(commandId);
    if (!parsed || parsed.provider !== activeProvider) { return null; }

    const trimmedArgs = args.trim();

    const builtin = (NATIVE_COMMANDS[activeProvider] ?? [])
      .find(c => c.name === parsed.name);
    if (builtin) {
      if (builtin.execution.kind === 'mysti') {
        return { kind: 'mysti', commandId: builtin.execution.commandId };
      }
      // A command that REQUIRES arguments is prefilled rather than sent: firing
      // `/goal` with no condition wastes a turn, and the user cannot see what
      // was sent to correct it. An optional argument still runs bare.
      if (requiresArguments(builtin.argumentHint) && !trimmedArgs) {
        return { kind: 'prefill', text: `/${builtin.name} ` };
      }
      return {
        kind: 'prompt',
        text: trimmedArgs ? `/${builtin.name} ${trimmedArgs}` : `/${builtin.name}`,
      };
    }

    // Live ACP command — the agent owns the vocabulary, so it is passed
    // through verbatim.
    const live = this._getDynamicNativeCommands(panelId, activeProvider)
      .find(c => c.name === parsed.name);
    if (live) {
      if (requiresArguments(live.argumentHint) && !trimmedArgs) {
        return { kind: 'prefill', text: `/${live.name} ` };
      }
      return {
        kind: 'prompt',
        text: trimmedArgs ? `/${live.name} ${trimmedArgs}` : `/${live.name}`,
      };
    }

    const found = (this._nativeCommandDiscovery?.getCached(activeProvider) ?? [])
      .find(c => c.name === parsed.name);
    if (!found) { return null; }

    if (found.execution.kind === 'mysti') {
      return { kind: 'mysti', commandId: found.execution.commandId };
    }
    if (found.execution.kind === 'passthrough') {
      return {
        kind: 'prompt',
        text: trimmedArgs ? `/${found.name} ${trimmedArgs}` : `/${found.name}`,
      };
    }

    // `expand`: this backend's headless mode cannot resolve a slash command, so
    // Mysti sends the template the user wrote. If it cannot be read, say so
    // rather than sending a bare `/name` the CLI will treat as prose.
    const expanded = this._nativeCommandDiscovery?.expandTemplate(found.filePath, trimmedArgs);
    return expanded ? { kind: 'prompt', text: expanded } : null;
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
          const models = callbacks.getModelsForProvider(callbacks.getPanelProvider(panelId));
          return `Model changed to: ${this._getModelDisplayName(selectedModel, models)}`;
        }
        return;
      }

      case 'provider:switch': {
        if (trimmedArgs) {
          // C2: derive ids from the registry, never a hard-coded list
          const agents: string[] = this._providerManager.getAllProviderIds();
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
        return this._getHelpText();

      case 'cmd:compact':
        // C7: fire-and-forget — compaction progress/result is reported via
        // 'compactionStatus' cards posted by the compaction pipeline itself.
        void callbacks.executeManualCompaction(panelId);
        return 'Compacting conversation...';

      case 'cmd:brainstorm': {
        const currentProvider = callbacks.getPanelProvider(panelId);
        const isBrainstormActive = currentProvider === 'brainstorm';

        if (trimmedArgs === 'on' || trimmedArgs === 'enable') {
          await callbacks.updateSettings({ provider: 'brainstorm' }, panelId);
          callbacks.postToPanel(panelId, { type: 'agentChanged', payload: { agent: 'brainstorm' } });
          return 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.';
        } else if (trimmedArgs === 'off' || trimmedArgs === 'disable') {
          await callbacks.updateSettings({ provider: DEFAULT_PROVIDER }, panelId);
          callbacks.postToPanel(panelId, { type: 'agentChanged', payload: { agent: DEFAULT_PROVIDER } });
          return `Brainstorm mode disabled. Using ${this._getProviderDisplayName(DEFAULT_PROVIDER)}.`;
        } else if (trimmedArgs === 'status') {
          return isBrainstormActive
            ? 'Brainstorm mode is ON. Multiple agents will collaborate.'
            : 'Brainstorm mode is OFF. Using single agent.';
        }

        // Toggle if no args
        const newProvider = isBrainstormActive ? DEFAULT_PROVIDER : 'brainstorm';
        await callbacks.updateSettings({ provider: newProvider }, panelId);
        callbacks.postToPanel(panelId, { type: 'agentChanged', payload: { agent: newProvider } });
        return newProvider === 'brainstorm'
          ? 'Brainstorm mode enabled. Multiple agents will collaborate on your queries.'
          : `Brainstorm mode disabled. Using ${this._getProviderDisplayName(DEFAULT_PROVIDER)}.`;
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

      case 'cmd:visual-test': {
        // Open the visual test dashboard in a separate editor tab.
        // NOTE: this posts INTO the webview, so it must be a type chat.js
        // actually handles. It used to post 'openVisualTestDashboard' — the
        // extension-side type — which no webview case matched, so /visual-test
        // silently did nothing. chat.js's 'openVisualTestDialog' handler is the
        // one that bounces the request back to the extension.
        callbacks.postToPanel(panelId, { type: 'openVisualTestDialog' });
        return;
      }

      case 'cmd:canvas': {
        // Open the canvas in a separate editor tab.
        //
        // This used to post `openCanvas` to the webview, which handles no such
        // message — so the menu entry did nothing. `mysti.openCanvas` is a
        // registered VS Code command that calls the same
        // `chatViewProvider.openCanvas()`, so invoke it directly rather than
        // round-tripping through a webview that has no part to play. Same
        // pattern as the settings and issue-tracker entries below.
        await vscode.commands.executeCommand('mysti.openCanvas');
        return;
      }

      case 'cmd:export': {
        // Trigger the export via the webview (ChatViewProvider handles the actual export)
        callbacks.postToPanel(panelId, { type: 'triggerExport' });
        return;
      }

      case 'cmd:import': {
        // Trigger the import via the webview (ChatViewProvider handles the file dialog)
        callbacks.postToPanel(panelId, { type: 'triggerImport' });
        return;
      }

      case 'cmd:share': {
        // Generate and copy a shareable deep link for the current conversation
        callbacks.postToPanel(panelId, { type: 'triggerShareLink' });
        return;
      }

      case 'cmd:init-team': {
        // Scaffold .mysti/ team workspace config
        callbacks.postToPanel(panelId, { type: 'triggerInitTeam' });
        return;
      }

      case 'cmd:memory': {
        // Open project MEMORY.md for viewing/editing
        callbacks.postToPanel(panelId, { type: 'triggerOpenMemory' });
        return;
      }

      case 'cmd:rules': {
        // Open .mysti/rules/ directory
        callbacks.postToPanel(panelId, { type: 'triggerOpenRules' });
        return;
      }

      // ---- Collaboration (Plan 14) ----
      // These four posted `composeCollaboration` to open a collaborator picker
      // in the webview. That picker was never built, and NOTHING handles the
      // message — so all four menu entries did nothing, while advertising a
      // description. The collaboration machinery itself works: ChatViewProvider
      // parses `@agent:role` out of the message text and runs it.
      //
      // So the picker is a native QuickPick, and the composed mention goes into
      // the input via `setInputValue` — leaving the user to read it, edit the
      // brief and press Enter, rather than silently dispatching agents on their
      // behalf. Nothing new is invented: this is the documented direct path,
      // pre-composed.
      case 'cmd:consult':
        return this._composeCollaboration(callbacks, panelId, 'advisor', trimmedArgs);
      case 'cmd:review':
        return this._composeCollaboration(callbacks, panelId, 'reviewer', trimmedArgs);
      case 'cmd:critique':
        return this._composeCollaboration(callbacks, panelId, 'critic', trimmedArgs);
      case 'cmd:panel':
        return this._composeCollaboration(callbacks, panelId, 'advisor', trimmedArgs, true);

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
      // `claude:compact` used to live here. It posted `sendCliPassthrough`,
      // which NOTHING in chat.js has ever handled, so selecting it did nothing
      // at all — the same class of dead entry Plan 27 Phase 4 cleaned out of
      // the universal section, missed because that test only scans `cmd:` ids.
      // Claude's real `/compact` is now a pass-through entry in the native
      // section (it is one of the built-ins that survives headless mode), and
      // provider-neutral compaction stays on `cmd:compact`.
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
      {
        id: 'cmd:visual-test',
        label: '/visual-test',
        description: 'Run visual testing on your app (screenshot → analyze → fix → verify)',
        section: 'commands',
        icon: 'device-camera',
        provider: 'all',
        action: 'execute',
        keywords: ['visual', 'test', 'screenshot', 'browser', 'playwright', 'ui'],
      },
      {
        id: 'cmd:canvas',
        label: '/canvas',
        description: 'Open infinite canvas for drawing, annotating, and AI design',
        section: 'commands',
        icon: 'paintcan',
        provider: 'all',
        action: 'execute',
        keywords: ['canvas', 'draw', 'design', 'annotate', 'mockup', 'reimagine', 'image'],
      },
      {
        id: 'cmd:export',
        label: 'Export Conversation',
        description: 'Copy conversation as Markdown',
        section: 'commands' as SlashCommandSection,
        icon: 'export',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['export', 'copy', 'markdown', 'share'],
      },
      {
        id: 'cmd:import',
        label: 'Import Conversation',
        description: 'Import from .mysti.json, .json, or .jsonl file',
        section: 'commands' as SlashCommandSection,
        icon: 'cloud-download',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['import', 'load', 'file', 'open'],
      },
      {
        id: 'cmd:share',
        label: 'Share Conversation',
        description: 'Copy a shareable deep link to clipboard',
        section: 'commands' as SlashCommandSection,
        icon: 'link',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['share', 'link', 'deep', 'copy', 'url'],
      },
      {
        id: 'cmd:init-team',
        label: 'Init Team Workspace',
        description: 'Set up .mysti/ config for your team',
        section: 'commands' as SlashCommandSection,
        icon: 'organization',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['init', 'team', 'workspace', 'setup', 'config'],
      },
      {
        id: 'cmd:memory',
        label: 'Memory',
        description: 'View and edit project memory (MEMORY.md)',
        section: 'commands' as SlashCommandSection,
        icon: 'book',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['memory', 'learn', 'remember', 'knowledge'],
      },
      {
        id: 'cmd:rules',
        label: 'Rules',
        description: 'View and edit project rules (.mysti/rules/)',
        section: 'commands' as SlashCommandSection,
        icon: 'law',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['rules', 'constraints', 'always', 'never'],
      },

      // -- Collaboration (Plan 14): call other agents in a named role --
      {
        id: 'cmd:consult',
        label: 'Consult',
        description: 'Ask other agents for advice on the current thread',
        section: 'commands' as SlashCommandSection,
        icon: 'comment-discussion',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['consult', 'advisor', 'advice', 'second-opinion', 'ask'],
      },
      {
        id: 'cmd:review',
        label: 'Review',
        description: 'Have other agents review the current diff or files',
        section: 'commands' as SlashCommandSection,
        icon: 'git-pull-request',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['review', 'code review', 'diff', 'pr'],
      },
      {
        id: 'cmd:critique',
        label: 'Critique',
        description: 'Have other agents poke holes in the latest plan or answer',
        section: 'commands' as SlashCommandSection,
        icon: 'feedback',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['critique', 'red team', 'poke holes', 'challenge'],
      },
      {
        id: 'cmd:panel',
        label: 'Panel',
        description: 'Convene a multi-agent panel on the current question',
        section: 'commands' as SlashCommandSection,
        icon: 'organization',
        provider: 'all',
        action: 'execute' as const,
        keywords: ['panel', 'collaborate', 'multi-agent', 'advisors'],
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
          cmd.currentValue = this._getModelDisplayName(
            callbacks.getPanelModel(panelId),
            callbacks.getModelsForProvider(activeProvider)
          );
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

  /**
   * Human-readable label for a model id. Plan 01 Phase 1: derive the display
   * name from the registry-backed ModelInfo.name (the single source of truth)
   * instead of a hand-maintained shortNames map that drifted from the curated
   * lists. Falls back to the raw id for custom/unlisted models with no metadata.
   */
  private _getModelDisplayName(modelId: string, models: ModelInfo[]): string {
    return models.find(m => m.id === modelId)?.name || modelId;
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
      'opencode': 'OpenCode',
      'ollama': 'Ollama',
      'localai': 'LocalAI',
      'qwen-code': 'Qwen Code',
      'hermes': 'Hermes',
      'continue': 'Continue',
      'openrouter': 'OpenRouter',
      'kimi-code': 'Kimi Code',
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
    // Plan 01 Phase 1: pull the merged list (curated + discovered + custom)
    // from the registry-backed callback so /model matches the dropdown.
    const models = callbacks.getModelsForProvider(currentProvider);

    if (models.length === 0) {
      vscode.window.showWarningMessage('No models available for the current provider');
      return undefined;
    }

    const items = models.map(model => ({
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

  private _getHelpText(): string {
    // C7: /compact is listed unconditionally — it works on every provider
    // (native CLI compact or client-side summarization).
    return 'Available commands:\n' +
      '/clear - Clear conversation and session\n' +
      '/help - Show this help message\n' +
      '/context - Show current context items\n' +
      '/mode [mode] - Show/change mode (ask-before-edit, edit-automatically, quick-plan, detailed-plan)\n' +
      '/exit-plan-mode - Exit plan mode\n' +
      '/model [model] - Show/change AI model\n' +
      '/agent [agent] - Switch provider\n' +
      '/brainstorm [on|off|status] - Toggle brainstorm mode\n' +
      '/compact - Compact conversation context';
  }

  /**
   * Compose an `@agent:role` mention for the collaboration slash commands
   * (Plan 27 Phase 4).
   *
   * The webview picker these commands were written against does not exist, so
   * the agent choice is a native QuickPick over the REGISTERED providers —
   * `getAllProviders()`, so a sixteenth backend appears here with no edit — and
   * the result is written into the chat input rather than dispatched. The user
   * sees exactly what will run and still has to press Enter: a slash command
   * should not fan work out to several backends without a visible confirmation.
   *
   * Returns a status string on cancel/none-available so the caller surfaces a
   * reason instead of the silence these commands used to produce.
   */
  private async _composeCollaboration(
    callbacks: SlashCommandCallbacks,
    panelId: string,
    role: string,
    brief: string,
    panel = false,
  ): Promise<string | undefined> {
    const active = callbacks.getPanelProvider(panelId);
    const candidates = this._providerManager
      .getAllProviders()
      .filter(p => p.id !== active);

    if (candidates.length === 0) {
      return 'No other agent is available to collaborate with. Add a second backend first.';
    }

    const picked = await vscode.window.showQuickPick(
      candidates.map(p => ({ label: p.displayName, id: p.id })),
      {
        title: panel ? `Convene a panel (${role})` : `Ask another agent as ${role}`,
        placeHolder: panel ? 'Pick the agents for the panel' : `Pick the agent to act as ${role}`,
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );

    if (!picked || picked.length === 0) {
      return undefined; // cancelled — the QuickPick closing is its own feedback
    }

    const mentions = picked.map(p => `@${p.id}:${role}`).join(' ');
    callbacks.postToPanel(panelId, {
      type: 'setInputValue',
      payload: { value: `${mentions} ${brief}`.trim() + (brief ? '' : ' ') },
    });
    return undefined;
  }

}
