/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
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
  autonomousManager = new AutonomousManager(context, memoryManager);
  compactionManager = new CompactionManager(context);
  lifecycleManager = new AgentLifecycleManager(context);

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
    activeModeManager
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

  // Active Mode status bar item (provider-independent)
  const activeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  activeStatusBar.command = 'mysti.openChat';
  context.subscriptions.push(activeStatusBar);

  activeModeManager.onStatusChanged((status) => {
    if (!activeModeManager.isInstalled()) {
      activeStatusBar.hide();
    } else if (status?.running) {
      activeStatusBar.text = '$(radio-tower) OpenClaw Active';
      activeStatusBar.tooltip = `Daemon running \u00B7 ${status.channelCount} channel${status.channelCount !== 1 ? 's' : ''}`;
      activeStatusBar.show();
    } else {
      activeStatusBar.text = '$(radio-tower) OpenClaw Offline';
      activeStatusBar.tooltip = 'OpenClaw daemon not running';
      activeStatusBar.show();
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
}
