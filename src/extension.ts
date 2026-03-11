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
import { ChatViewProvider } from './providers/ChatViewProvider';
import { ContextManager } from './managers/ContextManager';
import { ConversationManager } from './managers/ConversationManager';
import { ProviderManager } from './managers/ProviderManager';
import { SuggestionManager } from './managers/SuggestionManager';
import { BrainstormManager } from './managers/BrainstormManager';
import { PermissionManager } from './managers/PermissionManager';
import { SetupManager } from './managers/SetupManager';
import { TelemetryManager } from './managers/TelemetryManager';
import { MemoryManager } from './managers/MemoryManager';
import { AutonomousManager } from './managers/AutonomousManager';
import { CompactionManager } from './managers/CompactionManager';
import { AgentLifecycleManager } from './managers/AgentLifecycleManager';
import { SlashCommandManager } from './managers/SlashCommandManager';
import { ActiveModeManager } from './managers/ActiveModeManager';
import { EngagementManager } from './managers/EngagementManager';
import { CommitSignatureManager } from './managers/CommitSignatureManager';
import { TeamPresenceManager } from './managers/TeamPresenceManager';
import { MystiFileDecorationProvider } from './providers/MystiFileDecorationProvider';
import { MystiCodeLensProvider } from './providers/MystiCodeLensProvider';
import { ProjectContextManager } from './managers/ProjectContextManager';

let chatViewProvider: ChatViewProvider;
let contextManager: ContextManager;
let conversationManager: ConversationManager;
let providerManager: ProviderManager;
let suggestionManager: SuggestionManager;
let brainstormManager: BrainstormManager;
let permissionManager: PermissionManager;
let setupManager: SetupManager;
let telemetryManager: TelemetryManager;
let memoryManager: MemoryManager;
let autonomousManager: AutonomousManager;
let compactionManager: CompactionManager;
let lifecycleManager: AgentLifecycleManager;
let activeModeManager: ActiveModeManager;
let engagementManager: EngagementManager;
let commitSignatureManager: CommitSignatureManager;
let teamPresenceManager: TeamPresenceManager;
let fileDecorationProvider: MystiFileDecorationProvider;
let projectContextManager: ProjectContextManager;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Mysti extension is now active');

  // Initialize telemetry first
  telemetryManager = new TelemetryManager(context);
  const version = context.extension.packageJSON.version || '0.0.0';
  telemetryManager.trackActivation(version);

  // Initialize managers
  contextManager = new ContextManager(context);
  conversationManager = new ConversationManager(context);
  providerManager = new ProviderManager(context);
  suggestionManager = new SuggestionManager(context);

  // Get initial access level from configuration
  const config = vscode.workspace.getConfiguration('mysti');
  const initialAccessLevel = config.get<'read-only' | 'ask-permission' | 'full-access'>('accessLevel', 'ask-permission');
  permissionManager = new PermissionManager(initialAccessLevel);

  // Initialize providers (async)
  await providerManager.initialize();

  // Initialize brainstorm manager
  brainstormManager = new BrainstormManager(context, providerManager);

  // Initialize setup manager for CLI auto-setup
  setupManager = new SetupManager(context, providerManager);

  // Initialize memory, autonomous, and compaction managers
  memoryManager = new MemoryManager(context);
  // Initialize per-project auto-memory (like ~/.claude/projects/<project>/memory/)
  if (vscode.workspace.workspaceFolders?.length) {
    memoryManager.initProjectMemory(vscode.workspace.workspaceFolders[0].uri.fsPath);
  }
  autonomousManager = new AutonomousManager(context, memoryManager);
  compactionManager = new CompactionManager(context);
  lifecycleManager = new AgentLifecycleManager(context);

  // Initialize engagement manager (badges, stats, review prompts)
  engagementManager = new EngagementManager(context);

  // Initialize viral growth managers (Phase 2)
  commitSignatureManager = new CommitSignatureManager(context);
  teamPresenceManager = new TeamPresenceManager(context); // Session action tracker
  fileDecorationProvider = new MystiFileDecorationProvider();

  // Initialize project context manager (reads mysti.md + .mysti/rules/)
  projectContextManager = new ProjectContextManager(context);
  projectContextManager.initialize().catch(err =>
    console.log('[Mysti] ProjectContextManager: initialization error:', err)
  );

  // Initialize active mode manager (provider-independent OpenClaw daemon connection)
  activeModeManager = new ActiveModeManager(context);
  // Non-blocking: detects CLI, connects to daemon if available
  activeModeManager.initialize().catch(err =>
    console.log('[Mysti] ActiveMode: initialization error:', err)
  );

  // Initialize slash command manager
  const slashCommandManager = new SlashCommandManager({
    providerManager,
    contextManager,
    conversationManager,
    compactionManager,
    memoryManager,
    brainstormManager,
  });

  // Initialize the chat view provider
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    context,  // Extension context for AgentLoader
    contextManager,
    conversationManager,
    providerManager,
    suggestionManager,
    brainstormManager,
    permissionManager,
    setupManager,
    telemetryManager,
    autonomousManager,
    memoryManager,
    compactionManager,
    lifecycleManager,
    slashCommandManager,
    activeModeManager,
    engagementManager,
    projectContextManager
  );

  // Register the webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'mysti.chatView',
      chatViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Register chatViewProvider for proper disposal (prevents memory leaks)
  context.subscriptions.push({
    dispose: () => chatViewProvider.dispose()
  });

  // Wire file modification listeners (file decorations + commit tracking)
  chatViewProvider.onFileModified((filePath, provider) => {
    commitSignatureManager.markFileModified(filePath);
    fileDecorationProvider.markFileTouched(filePath, provider);
    teamPresenceManager.trackFileWritten(filePath);
  });

  // Wire tool_use listener (AI commit detection + session action tracking)
  chatViewProvider.onToolUseDetected((toolName, toolInput) => {
    // Track session actions (files read, commands run, etc.)
    teamPresenceManager.trackToolUse(toolName, toolInput);

    // Detect AI-initiated git commits for badge tracking
    if (commitSignatureManager.isAICommit(toolName, toolInput)) {
      engagementManager.trackCommitWithSignature();
      console.log('[Mysti] AI-initiated git commit detected');
    }
  });

  // Register file decoration provider (sparkle M badge in Explorer)
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider)
  );
  context.subscriptions.push(fileDecorationProvider);

  // Mysti branded status bar item (always visible)
  const mystiStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  mystiStatusBar.command = 'mysti.openChat';
  const defaultProvider = vscode.workspace.getConfiguration('mysti').get<string>('defaultProvider', 'claude-code');
  const providerLabel = _formatProviderLabel(defaultProvider);
  mystiStatusBar.text = `$(sparkle) Mysti: ${providerLabel}`;
  mystiStatusBar.tooltip = `You're Mysting with ${providerLabel} — click to open chat`;
  mystiStatusBar.show();
  context.subscriptions.push(mystiStatusBar);

  // Update status bar when provider changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mysti.defaultProvider')) {
        const provider = vscode.workspace.getConfiguration('mysti').get<string>('defaultProvider', 'claude-code');
        const label = _formatProviderLabel(provider);
        mystiStatusBar.text = `$(sparkle) Mysti: ${label}`;
        mystiStatusBar.tooltip = `You're Mysting with ${label} — click to open chat`;
      }
    })
  );

  // "What's New" notification and first-install walkthrough
  const currentVersion = context.extension.packageJSON.version as string;
  const previousVersion = context.globalState.get<string>('mysti.lastVersion');

  if (!previousVersion) {
    // First install — open walkthrough
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'DeepMyst.mysti#mysti.gettingStarted',
      false
    );
  } else if (previousVersion !== currentVersion) {
    // Extension updated — show What's New
    vscode.window.showInformationMessage(
      `Mysti updated to v${currentVersion}! See what's new.`,
      "What's New",
      'Rate Mysti'
    ).then((selection) => {
      if (selection === "What's New") {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/DeepMyst/Mysti/blob/main/CHANGELOG.md'));
      } else if (selection === 'Rate Mysti') {
        vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti&ssr=false#review-details'));
      }
    });
  }
  context.globalState.update('mysti.lastVersion', currentVersion);

  // Active Mode status bar item (provider-independent)
  const activeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  activeStatusBar.command = 'mysti.openChat';
  context.subscriptions.push(activeStatusBar);

  activeModeManager.onStatusChanged((status) => {
    if (!activeModeManager.isInstalled()) {
      activeStatusBar.hide();
    } else if (status?.running) {
      activeStatusBar.text = '$(radio-tower) Mysti: OpenClaw Active';
      activeStatusBar.tooltip = `Mysti \u00B7 OpenClaw daemon running \u00B7 ${status.channelCount} channel${status.channelCount !== 1 ? 's' : ''}`;
      activeStatusBar.show();
    } else {
      activeStatusBar.text = '$(radio-tower) Mysti: OpenClaw Offline';
      activeStatusBar.tooltip = 'Mysti \u00B7 OpenClaw daemon not running';
      activeStatusBar.show();
    }
  });

  // Session actions status bar item — shows what Mysti did this session
  const actionsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
  actionsStatusBar.command = 'mysti.openChat';
  context.subscriptions.push(actionsStatusBar);

  teamPresenceManager.onDidChange((summary) => {
    if (summary.totalActions > 0) {
      const parts: string[] = [];
      if (summary.filesWritten > 0) { parts.push(`${summary.filesWritten} file${summary.filesWritten !== 1 ? 's' : ''} edited`); }
      if (summary.filesRead > 0) { parts.push(`${summary.filesRead} read`); }
      if (summary.commandsRun > 0) { parts.push(`${summary.commandsRun} cmd${summary.commandsRun !== 1 ? 's' : ''}`); }
      actionsStatusBar.text = `$(tools) Mysti: ${parts.join(', ')}`;
      actionsStatusBar.tooltip = `Mysti session activity\n${summary.filesWritten} files edited, ${summary.filesRead} files read, ${summary.commandsRun} commands run`;
      actionsStatusBar.show();
    } else {
      actionsStatusBar.hide();
    }
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.openChat', () => {
      vscode.commands.executeCommand('mysti.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.newConversation', () => {
      conversationManager.createNewConversation();
      chatViewProvider.postMessage({ type: 'conversationChanged' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.addToContext', async (uri?: vscode.Uri) => {
      if (uri) {
        await contextManager.addFileToContext(uri.fsPath);
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const selection = editor.selection;
          if (!selection.isEmpty) {
            await contextManager.addSelectionToContext(
              editor.document.uri.fsPath,
              editor.document.getText(selection),
              selection.start.line,
              selection.end.line,
              editor.document.languageId
            );
          } else {
            await contextManager.addFileToContext(editor.document.uri.fsPath);
          }
        }
      }
      chatViewProvider.postMessage({
        type: 'contextUpdated',
        payload: contextManager.getContext()
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.clearContext', () => {
      contextManager.clearContext();
      chatViewProvider.postMessage({
        type: 'contextUpdated',
        payload: []
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.openInNewTab', () => {
      chatViewProvider.openInNewTab();
    })
  );

  // Toggle autonomous mode command
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.toggleAutonomous', () => {
      chatViewProvider.toggleAutonomousMode();
    })
  );

  // Debug commands for testing setup flow (not in package.json - use Command Palette)
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.debugSetup', () => {
      chatViewProvider.debugForceSetup();
      vscode.window.showInformationMessage('Debug: Setup flow triggered');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.debugSetupFailure', () => {
      chatViewProvider.debugForceSetupFailure();
      vscode.window.showInformationMessage('Debug: Setup failure triggered');
    })
  );

  // Register CodeLens provider (Mysti: Explain | Refactor | Write Tests)
  const codeLensProvider = new MystiCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
  );
  context.subscriptions.push(codeLensProvider);

  // CodeLens action command — opens sidebar and pre-fills prompt
  context.subscriptions.push(
    vscode.commands.registerCommand('mysti.codeLensAction', (action: string, functionCode: string, filePath: string, functionName: string) => {
      const prompts: Record<string, string> = {
        explain: `Explain what the function \`${functionName}\` does:\n\n\`\`\`\n${functionCode}\n\`\`\``,
        refactor: `Refactor the function \`${functionName}\` for better readability and performance:\n\n\`\`\`\n${functionCode}\n\`\`\``,
        test: `Write comprehensive tests for the function \`${functionName}\`:\n\n\`\`\`\n${functionCode}\n\`\`\``
      };
      const prompt = prompts[action] || prompts['explain'];

      // Focus the sidebar, then send the message
      vscode.commands.executeCommand('mysti.chatView.focus').then(() => {
        chatViewProvider.postMessage({
          type: 'prefillPrompt',
          payload: { content: prompt, filePath }
        });
      });

      // Track in engagement
      engagementManager.trackMessageSent('codelens');
      telemetryManager.sendEvent('codelens.clicked', { action, functionName });
    })
  );

  // Register URI handler for conversation deep links (Feature 5)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/import') {
          const params = new URLSearchParams(uri.query);
          const data = params.get('data');
          if (data) {
            const imported = conversationManager.importFromShareable(data);
            if (imported) {
              vscode.commands.executeCommand('mysti.chatView.focus');
              chatViewProvider.postMessage({ type: 'conversationChanged' });
              vscode.window.showInformationMessage(`Conversation loaded: "${imported.title}"`);
              telemetryManager.sendEvent('deeplink.imported', {});
            } else {
              vscode.window.showErrorMessage('Could not load this conversation. The link may be invalid or expired.');
            }
          }
        }
      }
    })
  );

  // Project onboarding: detect .mysti/ or mysti.md in the workspace
  // Like how .claude/ or CLAUDE.md signal "this project uses Claude Code"
  const hasPromptedTeamOnboarding = context.workspaceState.get<boolean>('mysti.hasPromptedTeamOnboarding');
  if (!hasPromptedTeamOnboarding && vscode.workspace.workspaceFolders?.length) {
    const root = vscode.workspace.workspaceFolders[0].uri;
    const mystiMarkers = [
      vscode.Uri.joinPath(root, '.mysti', 'team.json'),
      vscode.Uri.joinPath(root, '.mysti', 'config.json'),
      vscode.Uri.joinPath(root, 'mysti.md'),
      vscode.Uri.joinPath(root, 'MYSTI.md'),
    ];

    // Check if any Mysti config file exists in the workspace
    Promise.any(mystiMarkers.map(uri => vscode.workspace.fs.stat(uri))).then(async () => {
      const hasSetup = context.globalState.get<boolean>('mysti.hasCompletedSetup');
      if (!hasSetup) {
        const choice = await vscode.window.showInformationMessage(
          'This project has a Mysti configuration. Open Mysti to get started?',
          'Open Mysti',
          'Dismiss'
        );
        if (choice === 'Open Mysti') {
          vscode.commands.executeCommand('mysti.chatView.focus');
        }
        context.workspaceState.update('mysti.hasPromptedTeamOnboarding', true);
      }
    }, () => { /* No Mysti config files found — skip */ });
  }

  // Workspace extension recommendation (Feature 13 — one-time prompt per workspace)
  const hasPromptedRec = context.workspaceState.get<boolean>('mysti.hasPromptedRecommendation');
  const hasCompletedSetup = context.globalState.get<boolean>('mysti.hasCompletedSetup');
  if (!hasPromptedRec && hasCompletedSetup) {
    // Defer to avoid blocking activation
    setTimeout(async () => {
      const choice = await vscode.window.showInformationMessage(
        'Would you like to recommend Mysti to other contributors on this project?',
        'Sure',
        'Not now'
      );
      if (choice === 'Sure') {
        await _addToWorkspaceRecommendations();
        engagementManager.trackWorkspaceRecommendation();
        telemetryManager.sendEvent('workspace.recommendation', { action: 'accepted' });
      } else {
        telemetryManager.sendEvent('workspace.recommendation', { action: 'declined' });
      }
      context.workspaceState.update('mysti.hasPromptedRecommendation', true);
    }, 30_000); // Wait 30s after activation to avoid overwhelming the user
  }

  // Listen for active editor changes for auto-context
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && contextManager.isAutoContextEnabled()) {
        chatViewProvider.postMessage({
          type: 'activeFileChanged',
          payload: {
            path: editor.document.uri.fsPath,
            language: editor.document.languageId
          }
        });
      }
    })
  );

  // Listen for selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (contextManager.isAutoContextEnabled() && !event.selections[0].isEmpty) {
        const editor = event.textEditor;
        chatViewProvider.postMessage({
          type: 'selectionChanged',
          payload: {
            path: editor.document.uri.fsPath,
            text: editor.document.getText(event.selections[0]),
            startLine: event.selections[0].start.line,
            endLine: event.selections[0].end.line,
            language: editor.document.languageId
          }
        });
      }
    })
  );
}

/** Add Mysti to .vscode/extensions.json workspace recommendations */
async function _addToWorkspaceRecommendations(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) { return; }

  const vscodePath = vscode.Uri.joinPath(workspaceFolders[0].uri, '.vscode');
  const extensionsPath = vscode.Uri.joinPath(vscodePath, 'extensions.json');

  let existing: { recommendations?: string[] } = {};
  try {
    const content = await vscode.workspace.fs.readFile(extensionsPath);
    existing = JSON.parse(Buffer.from(content).toString('utf-8'));
  } catch {
    // File doesn't exist — create it
  }

  const recs = existing.recommendations || [];
  if (!recs.includes('DeepMyst.mysti')) {
    recs.push('DeepMyst.mysti');
    existing.recommendations = recs;

    // Ensure .vscode directory exists
    try { await vscode.workspace.fs.createDirectory(vscodePath); } catch { /* already exists */ }
    await vscode.workspace.fs.writeFile(
      extensionsPath,
      Buffer.from(JSON.stringify(existing, null, 2) + '\n', 'utf-8')
    );
    console.log('[Mysti] Added to workspace recommendations');
  }
}

/** Format provider ID to a human-readable label for the status bar */
function _formatProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    'claude-code': 'Claude Code',
    'openai-codex': 'Codex',
    'google-gemini': 'Gemini',
    'cline': 'Cline',
    'github-copilot': 'Copilot',
    'cursor': 'Cursor',
    'openclaw': 'OpenClaw',
  };
  return labels[provider] || provider;
}

export function deactivate() {
  console.log('Mysti extension is now deactivated');
  // Cleanup is handled automatically via context.subscriptions
  // Additional cleanup for managers not in subscriptions
  if (permissionManager) {
    permissionManager.dispose();
  }
  if (autonomousManager) {
    autonomousManager.dispose();
  }
  if (memoryManager) {
    memoryManager.dispose();
  }
  if (compactionManager) {
    compactionManager.dispose();
  }
  if (lifecycleManager) {
    lifecycleManager.dispose();
  }
  if (activeModeManager) {
    activeModeManager.dispose();
  }
  if (engagementManager) {
    engagementManager.dispose();
  }
  if (commitSignatureManager) {
    commitSignatureManager.dispose();
  }
  if (teamPresenceManager) {
    teamPresenceManager.dispose();
  }
  if (fileDecorationProvider) {
    fileDecorationProvider.dispose();
  }
  if (projectContextManager) {
    projectContextManager.dispose();
  }
}
