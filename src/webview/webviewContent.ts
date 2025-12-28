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

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, version: string = '0.0.0'): string {
  const nonce = getNonce();
  const styles = getStyles();

  // URIs for library scripts
  const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'marked.min.js'));
  const prismUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'prism-bundle.js'));
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'mermaid.min.js'));
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'Mysti-Logo.png'));

  // Icon URIs for welcome suggestions and personas
  const iconUris: Record<string, string> = {};
  const iconNames = [
    // Welcome suggestions
    'magnifier', 'eye', 'brush', 'lab', 'lock', 'flash', 'notes', 'recycle', 'rocket', 'package', 'check', 'bug',
    // Personas (additional)
    'architecture', 'gear', 'target', 'microscope', 'hammer', 'chain', 'teacher', 'paint', 'globe', 'tools'
  ];
  for (const name of iconNames) {
    iconUris[name] = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', `${name}.png`)).toString();
  }

  // Provider logos
  const claudeLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'Claude.png')).toString();
  const openaiLogoLightUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'openai.svg')).toString();
  const openaiLogoDarkUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'openai_white.png')).toString();
  const geminiLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'gemini.png.webp')).toString();
  const copilotLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'copilot.png')).toString();

  const script = getScript(mermaidUri.toString(), logoUri.toString(), iconUris, claudeLogoUri, openaiLogoLightUri, openaiLogoDarkUri, geminiLogoUri, copilotLogoUri, version);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data: blob:;">
  <title>Mysti</title>
  <style>
    ${styles}
  </style>
  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${prismUri}"></script>
</head>
<body>
  <div id="app">
    <!-- Header with settings -->
    <header class="header">
      <div class="header-left">
        <span id="session-indicator" class="session-indicator" style="display: none;">
          <span class="session-dot"></span>
          Session
        </span>
        <div class="history-dropdown">
          <button id="history-btn" class="icon-btn" title="Chat history">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8.515 1.019A7 7 0 0 0 8 1V0a8 8 0 0 1 .589.022l-.074.997zm2.004.45a7 7 0 0 0-.985-.299l.219-.976c.383.086.76.2 1.126.342l-.36.933zm1.37.71a7 7 0 0 0-.439-.27l.493-.87a8 8 0 0 1 .979.654l-.615.789a7 7 0 0 0-.418-.302zm1.834 1.79a7 7 0 0 0-.653-.796l.724-.69c.27.285.52.59.747.91l-.818.576zm.744 1.352a7 7 0 0 0-.214-.468l.893-.45a8 8 0 0 1 .45 1.088l-.95.313a7 7 0 0 0-.179-.483zm.53 2.507a7 7 0 0 0-.1-1.025l.985-.17c.067.386.106.778.116 1.17l-1 .025zm-.131 1.538c.033-.17.06-.339.081-.51l.993.123a8 8 0 0 1-.23 1.155l-.964-.267c.046-.165.086-.332.12-.501zm-.952 2.379c.184-.29.346-.594.486-.908l.914.405c-.16.36-.345.706-.555 1.038l-.845-.535zm-.964 1.205c.122-.122.239-.248.35-.378l.758.653a8 8 0 0 1-.723.834l-.707-.707c.12-.12.235-.243.344-.37l-.022-.032zm-1.791 1.189c.306-.166.605-.349.89-.551l.605.79a8 8 0 0 1-1.054.652l-.44-.891zm-1.899.559a7 7 0 0 0 .99-.378l.445.887a8 8 0 0 1-1.18.454l-.255-.963zm-3.511.106A8 8 0 0 1 8 16v-1a7 7 0 0 0 .111-.998l.995.063A8 8 0 0 1 8 16zM.93 10.243l.976-.218c.066.297.16.586.28.867l-.924.381a8 8 0 0 1-.332-1.03zm1.122-3.996l-.98-.2a8 8 0 0 1 .634-1.528l.879.446a7 7 0 0 0-.533 1.282zm1.062-2.13l-.798-.6a8 8 0 0 1 .918-.934l.654.78a7 7 0 0 0-.774.754zm1.614-1.411L3.96 2.03a8 8 0 0 1 1.255-.568l.323.947a7 7 0 0 0-1.052.478zm6.058 9.222l-2.379-1.96a1 1 0 0 1-.362-.79V4.498a1 1 0 0 1 2 0v5.357l2.153 1.777a1 1 0 0 1-1.275 1.545l-.137-.112z"/>
            </svg>
          </button>
          <div id="history-menu" class="history-menu hidden">
            <!-- Populated dynamically -->
          </div>
        </div>
        <button id="new-conversation-btn" class="icon-btn" title="New conversation">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a.5.5 0 0 1 .5.5v6h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6v-6A.5.5 0 0 1 8 1z"/>
          </svg>
        </button>
        <button id="new-tab-btn" class="icon-btn" title="Open in new tab">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4A1.5 1.5 0 0 1 1.5 0h4a.5.5 0 0 1 0 1h-4zM10 .5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 16 1.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zM.5 10a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 0 14.5v-4a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5z"/>
          </svg>
        </button>
      </div>
      <div class="header-right">
        <button id="agent-config-btn" class="icon-btn" title="Agent Configuration">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>
            <path fill-rule="evenodd" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1z"/>
          </svg>
        </button>
        <button id="about-btn" class="icon-btn" title="About Mysti">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
            <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588z"/>
            <circle cx="8" cy="4.5" r="1"/>
          </svg>
        </button>
        <button id="settings-btn" class="icon-btn" title="Settings">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
            <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- Settings panel (hidden by default) -->
    <div id="settings-panel" class="settings-panel hidden">
      <div class="settings-section">
        <label class="settings-label">Mode</label>
        <select id="mode-select" class="select">
          <option value="default">Default</option>
          <option value="ask-before-edit">Ask Before Edit</option>
          <option value="edit-automatically">Edit Automatically</option>
          <option value="quick-plan">Quick Plan</option>
          <option value="detailed-plan">Detailed Plan</option>
        </select>
      </div>
      <div class="settings-section" id="thinking-section">
        <label class="settings-label">Thinking Level</label>
        <select id="thinking-select" class="select">
          <option value="none">None</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <div class="settings-section">
        <label class="settings-label">Agent</label>
        <select id="provider-select" class="select">
          <option value="claude-code">Claude Code</option>
          <option value="openai-codex">OpenAI Codex</option>
          <option value="google-gemini">Gemini</option>
          <option value="github-copilot">GitHub Copilot</option>
          <option value="brainstorm">Brainstorm</option>
        </select>
      </div>
      <div class="settings-section">
        <label class="settings-label">Model</label>
        <select id="model-select" class="select">
        </select>
      </div>
      <div class="settings-section">
        <label class="settings-label">Access Level</label>
        <select id="access-select" class="select">
          <option value="read-only">Read only</option>
          <option value="ask-permission">Ask permission</option>
          <option value="full-access">Full access</option>
        </select>
      </div>
      <div class="settings-section hidden" id="brainstorm-agents-section">
        <label class="settings-label">Brainstorm Agents</label>
        <div class="settings-hint">Select 2 agents for brainstorm mode</div>
        <div class="brainstorm-agent-selector">
          <label class="brainstorm-agent-option" data-agent="claude-code">
            <input type="checkbox" name="brainstorm-agent" value="claude-code" />
            <span class="brainstorm-agent-chip">
              <span class="brainstorm-agent-dot" style="background: #8B5CF6;"></span>
              <span class="brainstorm-agent-name">Claude</span>
            </span>
          </label>
          <label class="brainstorm-agent-option" data-agent="openai-codex">
            <input type="checkbox" name="brainstorm-agent" value="openai-codex" />
            <span class="brainstorm-agent-chip">
              <span class="brainstorm-agent-dot" style="background: #10B981;"></span>
              <span class="brainstorm-agent-name">Codex</span>
            </span>
          </label>
          <label class="brainstorm-agent-option" data-agent="google-gemini">
            <input type="checkbox" name="brainstorm-agent" value="google-gemini" />
            <span class="brainstorm-agent-chip">
              <span class="brainstorm-agent-dot" style="background: #4285F4;"></span>
              <span class="brainstorm-agent-name">Gemini</span>
            </span>
          </label>
          <label class="brainstorm-agent-option" data-agent="github-copilot">
            <input type="checkbox" name="brainstorm-agent" value="github-copilot" />
            <span class="brainstorm-agent-chip">
              <span class="brainstorm-agent-dot" style="background: #6366F1;"></span>
              <span class="brainstorm-agent-name">Copilot</span>
            </span>
          </label>
        </div>
        <div class="brainstorm-agent-error hidden" id="brainstorm-agent-error">
          Please select exactly 2 agents
        </div>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">Agent Settings</div>
      <div class="settings-section">
        <label class="settings-label">Auto-Suggest Personas</label>
        <div class="settings-toggle-row">
          <div id="auto-suggest-toggle" class="settings-toggle">
            <div class="settings-toggle-knob"></div>
          </div>
          <span class="settings-toggle-label">Suggest based on message</span>
        </div>
      </div>
      <div class="settings-section">
        <label class="settings-label">Limit Agent Tokens</label>
        <div class="settings-toggle-row">
          <div id="token-limit-toggle" class="settings-toggle">
            <div class="settings-toggle-knob"></div>
          </div>
          <span class="settings-toggle-label">Enable token limit</span>
        </div>
      </div>
      <div class="settings-section" id="token-budget-section">
        <label class="settings-label">Token Budget</label>
        <div class="token-budget-input-row">
          <input type="number" id="token-budget-input" class="input"
                 min="100" max="16000" step="100" value="2000" />
          <span class="token-budget-suffix">tokens</span>
        </div>
        <div class="token-budget-hint">Recommended: 1000-4000</div>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section">
        <label class="settings-label">Quick Suggestions</label>
        <div class="settings-toggle-row">
          <div id="suggestions-toggle" class="settings-toggle active">
            <div class="settings-toggle-knob"></div>
          </div>
          <span class="settings-toggle-label">Show after AI responses</span>
        </div>
      </div>
    </div>

    <!-- About panel (hidden by default) -->
    <div id="about-panel" class="about-panel hidden">
      <div class="about-header">
        <img src="${logoUri}" alt="Mysti Logo" class="about-logo" />
        <div class="about-title">
          <h2>Mysti</h2>
          <span class="about-version">v${version}</span>
        </div>
      </div>
      <p class="about-tagline">Your AI Coding Agent</p>
      <p class="about-description">
        A powerful AI coding agent for VSCode supporting multiple backends.
        Mysti can analyze code, execute tasks, and collaborate with you on complex projects.
      </p>
      <div class="about-section">
        <h3>Created by</h3>
        <p>DeepMyst Inc.</p>
        <p class="about-author">Baha Abunojaim</p>
      </div>
      <div class="about-links">
        <a href="https://deepmyst.com" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.958 6.958 0 0 0-.656 2.5h2.49zM4.847 5a12.5 12.5 0 0 0-.338 2.5H7.5V5H4.847zM8.5 5v2.5h2.99a12.495 12.495 0 0 0-.337-2.5H8.5zM4.51 8.5a12.5 12.5 0 0 0 .337 2.5H7.5V8.5H4.51zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5H8.5zM5.145 12c.138.386.295.744.468 1.068.552 1.035 1.218 1.65 1.887 1.855V12H5.145zm.182 2.472a6.696 6.696 0 0 1-.597-.933A9.268 9.268 0 0 1 4.09 12H2.255a7.024 7.024 0 0 0 3.072 2.472zM3.82 11a13.652 13.652 0 0 1-.312-2.5h-2.49c.062.89.291 1.733.656 2.5H3.82zm6.853 3.472A7.024 7.024 0 0 0 13.745 12H11.91a9.27 9.27 0 0 1-.64 1.539 6.688 6.688 0 0 1-.597.933zM8.5 12v2.923c.67-.204 1.335-.82 1.887-1.855.173-.324.33-.682.468-1.068H8.5zm3.68-1h2.146c.365-.767.594-1.61.656-2.5h-2.49a13.65 13.65 0 0 1-.312 2.5zm2.802-3.5a6.959 6.959 0 0 0-.656-2.5H12.18c.174.782.282 1.623.312 2.5h2.49zM11.27 2.461c.247.464.462.98.64 1.539h1.835a7.024 7.024 0 0 0-3.072-2.472c.218.284.418.598.597.933zM10.855 4a7.966 7.966 0 0 0-.468-1.068C9.835 1.897 9.17 1.282 8.5 1.077V4h2.355z"/>
          </svg>
          Website
        </a>
        <a href="https://github.com/DeepMyst/Mysti" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub
        </a>
        <a href="https://www.linkedin.com/company/deepmyst/" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854V1.146zm4.943 12.248V6.169H2.542v7.225h2.401zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248-.822 0-1.359.54-1.359 1.248 0 .694.521 1.248 1.327 1.248h.016zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016a5.54 5.54 0 0 1 .016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225h2.4z"/>
          </svg>
          LinkedIn
        </a>
      </div>
      <div class="about-section">
        <h3>License</h3>
        <p>Business Source License 1.1</p>
      </div>
      <div class="about-section about-credits">
        <h3>Third-party Libraries</h3>
        <ul class="credits-list">
          <li>Marked.js - Markdown parsing</li>
          <li>Prism.js - Syntax highlighting</li>
          <li>Mermaid.js - Diagram rendering</li>
        </ul>
      </div>
    </div>

    <!-- Agent Configuration panel (hidden by default) -->
    <div id="agent-config-panel" class="agent-config-panel hidden">
      <div class="config-summary">
        <span class="config-summary-label">Active:</span>
        <span class="config-summary-value" id="config-summary-text">Default (no customization)</span>
        <button class="config-reset-btn" id="config-reset-btn" title="Reset to default">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
          </svg>
        </button>
      </div>
      <div class="config-section">
        <div class="config-section-header">
          <span class="config-section-title">Persona</span>
          <span class="config-section-hint">Select one (optional)</span>
        </div>
        <div class="persona-grid" id="persona-grid">
          <!-- Dynamically populated with persona cards -->
        </div>
      </div>
      <div class="config-section">
        <div class="config-section-header">
          <span class="config-section-title">Skills</span>
          <span class="config-section-hint">Toggle multiple</span>
        </div>
        <div class="skills-list" id="skills-list">
          <!-- Dynamically populated with skill toggles -->
        </div>
      </div>
    </div>

    <!-- Messages area -->
    <div id="messages" class="messages">
      <!-- Fixed container for stuck in-progress items -->
      <div id="sticky-progress-container" class="sticky-progress-container">
        <div class="sticky-progress-header">
          <span class="sticky-progress-title">In Progress</span>
          <span class="sticky-progress-count"></span>
        </div>
        <div class="sticky-progress-list"></div>
      </div>
      <div class="welcome-container">
        <div class="welcome-header">
          <img src="${logoUri}" alt="Mysti" class="welcome-logo" />
          <h2>Welcome to Mysti</h2>
          <p>Your AI coding team. Choose an action or ask anything!</p>
        </div>
        <div class="welcome-suggestions" id="welcome-suggestions"></div>
      </div>
    </div>

    <!-- Quick actions (dynamically populated) -->
    <div id="quick-actions-container" class="quick-actions-container">
      <div class="quick-actions-header">
        <span class="quick-actions-title">Suggestions</span>
        <button id="quick-actions-hide" class="quick-actions-hide" title="Hide suggestions">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>
      <div id="quick-actions" class="quick-actions">
        <!-- Suggestions will be dynamically generated after each response -->
      </div>
    </div>

    <!-- Inline suggestions widget (compact, above input) -->
    <div id="inline-suggestions" class="inline-suggestions hidden">
      <div class="inline-suggestions-content">
        <div class="inline-suggestions-chips" id="inline-suggestions-chips">
          <!-- Dynamically populated with recommendation chips -->
        </div>
        <div class="inline-suggestions-actions">
          <label class="inline-suggestions-toggle">
            <input type="checkbox" id="inline-auto-suggest-check" />
            <span class="inline-toggle-text">Auto-suggest</span>
          </label>
          <button class="inline-suggestions-dismiss" id="inline-suggestions-dismiss" title="Dismiss">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Input area -->
    <div class="input-area">
      <div class="input-toolbar">
        <button id="slash-cmd-btn" class="toolbar-btn" title="Slash commands">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.354 5.5H2.5a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V9h.5a.5.5 0 0 0 .4-.8l-4-5.333a.5.5 0 0 0-.846.054L6.354 5.5zM7 9v2.5H3V6h2.354l1.646 3z"/>
          </svg>
          <span>/</span>
        </button>
        <button id="enhance-btn" class="toolbar-btn" title="Enhance prompt">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.828l.645-1.937zM3.794 1.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 0 1 0 .412l-1.162.387A1.734 1.734 0 0 0 4.593 5.69l-.387 1.162a.217.217 0 0 1-.412 0L3.407 5.69a1.734 1.734 0 0 0-1.097-1.097l-1.162-.387a.217.217 0 0 1 0-.412l1.162-.387A1.734 1.734 0 0 0 3.407 2.31l.387-1.162zM10.863.099a.145.145 0 0 1 .274 0l.258.774c.115.346.386.617.732.732l.774.258a.145.145 0 0 1 0 .274l-.774.258a1.156 1.156 0 0 0-.732.732l-.258.774a.145.145 0 0 1-.274 0l-.258-.774a1.156 1.156 0 0 0-.732-.732L9.1 2.137a.145.145 0 0 1 0-.274l.774-.258c.346-.115.617-.386.732-.732L10.863.1z"/>
          </svg>
        </button>
        <div class="toolbar-spacer"></div>
        <button id="agent-select-btn" class="toolbar-btn agent-btn" title="Select AI agent">
          <span id="agent-icon" class="agent-icon"><img src="${claudeLogoUri}" alt="" /></span>
          <span id="agent-name">Claude</span>
          <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 6l4 4 4-4"/>
          </svg>
        </button>
        <div id="context-usage" class="context-usage" title="Context usage: 0%">
          <svg viewBox="0 0 32 32" class="context-pie">
            <circle class="context-pie-bg" cx="16" cy="16" r="14"/>
            <path id="context-pie-fill" class="context-pie-fill" d=""/>
          </svg>
          <span id="context-usage-text" class="context-usage-text">0%</span>
        </div>
        <button id="toolbar-persona-btn" class="toolbar-btn persona-indicator-btn" title="Click to select a persona">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>
            <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1z"/>
          </svg>
          <span id="toolbar-persona-name">No persona</span>
          <span id="toolbar-persona-clear" class="toolbar-persona-clear hidden" title="Clear persona">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </span>
        </button>
        <span id="mode-indicator" class="mode-indicator">Ask before edit</span>
      </div>
      <div class="input-container">
        <div class="input-wrapper">
          <textarea id="message-input" placeholder="Ask Mysti..." rows="1"></textarea>
          <div id="autocomplete-ghost" class="autocomplete-ghost"></div>
        </div>
        <button id="send-btn" class="send-btn" title="Send message">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11zM6.636 10.07l2.761 4.338L14.13 2.576 6.636 10.07zm6.787-8.201L1.591 6.602l4.339 2.76 7.494-7.493z"/>
          </svg>
        </button>
        <button id="stop-btn" class="stop-btn" title="Stop generating" style="display: none;">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="3" y="3" width="10" height="10" rx="1"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Slash commands menu -->
    <div id="slash-menu" class="slash-menu hidden">
      <div class="slash-menu-item" data-command="clear">/clear - Clear conversation</div>
      <div class="slash-menu-item" data-command="help">/help - Show available commands</div>
      <div class="slash-menu-item" data-command="context">/context - Show current context</div>
      <div class="slash-menu-item" data-command="mode">/mode - Show or change mode</div>
      <div class="slash-menu-item" data-command="model">/model - Show or change model</div>
      <div class="slash-menu-item" data-command="agent">/agent - Switch AI agent</div>
      <div class="slash-menu-item" data-command="brainstorm">/brainstorm - Toggle brainstorm mode</div>
    </div>

    <!-- Agent selection menu -->
    <div id="agent-menu" class="agent-menu hidden">
      <div class="agent-menu-header">Select Agent</div>
      <div class="agent-menu-item selected" data-agent="claude-code">
        <span class="agent-item-icon"><img src="${claudeLogoUri}" alt="" /></span>
        <span class="agent-item-name">Claude Code</span>
        <span class="agent-item-badge">Active</span>
      </div>
      <div class="agent-menu-item" data-agent="openai-codex">
        <span class="agent-item-icon"><img class="openai-logo" src="${openaiLogoDarkUri}" alt="" /></span>
        <span class="agent-item-name">OpenAI Codex</span>
      </div>
      <div class="agent-menu-item" data-agent="google-gemini">
        <span class="agent-item-icon"><img class="gemini-logo" src="${geminiLogoUri}" alt="" /></span>
        <span class="agent-item-name">Gemini</span>
      </div>
      <div class="agent-menu-item" data-agent="github-copilot">
        <span class="agent-item-icon"><img class="copilot-logo" src="${copilotLogoUri}" alt="" /></span>
        <span class="agent-item-name">GitHub Copilot</span>
      </div>
      <div class="agent-menu-divider"></div>
      <div class="agent-menu-item" data-agent="brainstorm">
        <span class="agent-item-icon"><img src="${logoUri}" alt="" /></span>
        <span class="agent-item-name">Brainstorm</span>
        <span class="agent-item-desc">Both agents collaborate</span>
      </div>
    </div>
  </div>

  <!-- Setup Overlay (legacy - kept for backward compatibility) -->
  <div id="setup-overlay" class="setup-overlay hidden">
    <div class="setup-content">
      <div class="setup-progress">
        <img src="${logoUri}" alt="Mysti" class="setup-logo" />
        <div class="setup-step">Setting up Mysti...</div>
        <div class="setup-progress-track">
          <div class="setup-progress-bar" style="width: 0%"></div>
        </div>
        <div class="setup-message">Checking CLI installation...</div>
      </div>
      <div class="setup-error hidden">
        <div class="setup-error-icon">⚠️</div>
        <div class="setup-error-message"></div>
        <div class="setup-buttons">
          <button class="setup-btn primary" onclick="postMessageWithPanelId({ type: 'retrySetup', payload: { providerId: state.setup.providerId } })">Retry</button>
          <button class="setup-btn secondary" onclick="postMessageWithPanelId({ type: 'skipSetup' })">Skip</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Setup Wizard (Enhanced Onboarding) -->
  <div id="setup-wizard" class="setup-wizard hidden">
    <div class="wizard-content">
      <!-- Header -->
      <div class="wizard-header">
        <img src="${logoUri}" alt="Mysti" class="wizard-logo" />
        <h2>Welcome to Mysti</h2>
        <p class="wizard-subtitle">Set up an AI provider to get started</p>
      </div>

      <!-- Prerequisites Warning -->
      <div id="wizard-prerequisites" class="wizard-prereq hidden">
        <span class="prereq-icon">⚠️</span>
        <div class="prereq-content">
          <strong>Node.js Required</strong>
          <p>npm is not available. Install Node.js to enable automatic CLI installation.</p>
          <a href="https://nodejs.org" target="_blank" class="prereq-link">Download Node.js →</a>
        </div>
      </div>

      <!-- Provider Cards -->
      <div class="wizard-providers">
        <!-- Claude Code -->
        <div class="provider-card" data-provider="claude-code">
          <div class="provider-card-header">
            <img src="${claudeLogoUri}" alt="Claude" class="provider-logo" />
            <div class="provider-info">
              <h3>Claude Code</h3>
              <span class="provider-status" data-status="unknown">Checking...</span>
            </div>
          </div>
          <p class="provider-desc">Anthropic's Claude - powerful reasoning and code generation</p>
          <div class="provider-steps hidden"></div>
          <div class="provider-progress hidden">
            <div class="progress-track"><div class="progress-bar"></div></div>
            <span class="progress-msg"></span>
          </div>
          <div class="provider-card-actions">
            <button class="provider-action-btn primary" data-action="setup">Set Up</button>
          </div>
        </div>

        <!-- OpenAI Codex -->
        <div class="provider-card" data-provider="openai-codex">
          <div class="provider-card-header">
            <img src="${openaiLogoDarkUri}" alt="OpenAI" class="provider-logo openai-logo" />
            <div class="provider-info">
              <h3>OpenAI Codex</h3>
              <span class="provider-status" data-status="unknown">Checking...</span>
            </div>
          </div>
          <p class="provider-desc">OpenAI's Codex - ChatGPT-powered code assistant</p>
          <div class="provider-steps hidden"></div>
          <div class="provider-progress hidden">
            <div class="progress-track"><div class="progress-bar"></div></div>
            <span class="progress-msg"></span>
          </div>
          <div class="provider-card-actions">
            <button class="provider-action-btn primary" data-action="setup">Set Up</button>
          </div>
        </div>

        <!-- Google Gemini -->
        <div class="provider-card" data-provider="google-gemini">
          <div class="provider-card-header">
            <img src="${geminiLogoUri}" alt="Gemini" class="provider-logo gemini-logo" />
            <div class="provider-info">
              <h3>Google Gemini</h3>
              <span class="provider-status" data-status="unknown">Checking...</span>
            </div>
          </div>
          <p class="provider-desc">Google's Gemini - multimodal AI with code capabilities</p>
          <div class="provider-steps hidden"></div>
          <div class="provider-progress hidden">
            <div class="progress-track"><div class="progress-bar"></div></div>
            <span class="progress-msg"></span>
          </div>
          <div class="provider-card-actions">
            <button class="provider-action-btn primary" data-action="setup">Set Up</button>
          </div>
        </div>

        <!-- GitHub Copilot -->
        <div class="provider-card" data-provider="github-copilot">
          <div class="provider-card-header">
            <img src="${copilotLogoUri}" alt="Copilot" class="provider-logo copilot-logo" />
            <div class="provider-info">
              <h3>GitHub Copilot</h3>
              <span class="provider-status" data-status="unknown">Checking...</span>
            </div>
          </div>
          <p class="provider-desc">GitHub's Copilot - AI pair programmer with GitHub integration</p>
          <div class="provider-steps hidden"></div>
          <div class="provider-progress hidden">
            <div class="progress-track"><div class="progress-bar"></div></div>
            <span class="progress-msg"></span>
          </div>
          <div class="provider-card-actions">
            <button class="provider-action-btn primary" data-action="setup">Set Up</button>
          </div>
        </div>
      </div>

      <!-- Auth Options Modal (for Gemini) -->
      <div id="auth-options-modal" class="auth-options-modal hidden">
        <div class="auth-options-content">
          <h3>Choose Authentication Method</h3>
          <p id="auth-options-subtitle"></p>
          <div id="auth-options-list" class="auth-options-list"></div>
          <button class="auth-options-cancel">Cancel</button>
        </div>
      </div>

      <!-- Footer -->
      <div class="wizard-footer">
        <button class="wizard-skip-btn" onclick="postMessageWithPanelId({ type: 'dismissWizard', payload: { dontShowAgain: false } })">Skip for now</button>
        <p class="wizard-footer-hint">You can configure providers later in Settings</p>
      </div>
    </div>
  </div>

  <!-- Install Provider Modal (outside wizard so it's always accessible) -->
  <div id="install-provider-modal" class="install-provider-modal hidden">
    <div class="install-provider-content">
      <div class="install-provider-header">
        <img id="install-provider-icon" src="" alt="" />
        <h3 id="install-provider-title">Install Provider</h3>
      </div>
      <p id="install-provider-desc">Install this provider to use it with Mysti.</p>

      <div id="install-auto-section" class="install-section">
        <button id="install-auto-btn" class="install-action-btn primary">
          <span class="install-btn-icon">&#9889;</span>
          Install Automatically
        </button>
        <p class="install-hint">Requires npm installed on your system</p>
      </div>

      <div id="install-progress-section" class="install-section hidden">
        <div class="install-progress-bar">
          <div id="install-progress-fill" class="install-progress-fill"></div>
        </div>
        <p id="install-progress-msg" class="install-progress-msg">Installing...</p>
      </div>

      <div class="install-section">
        <h4>Manual Installation</h4>
        <div class="install-command-box">
          <code id="install-command-text"></code>
          <button id="install-copy-btn" class="install-copy-btn" title="Copy command">&#128203;</button>
          <button id="install-terminal-btn" class="install-terminal-btn" title="Open in Terminal">&#9654;</button>
        </div>
      </div>

      <div id="install-auth-section" class="install-section">
        <h4>Authentication</h4>
        <ul id="install-auth-steps" class="install-auth-list"></ul>
      </div>

      <div class="install-footer">
        <a id="install-docs-link" href="#" class="install-docs-link" target="_blank">
          &#128218; View Documentation
        </a>
        <button id="install-refresh-btn" class="install-refresh-btn" title="Refresh Detection">&#8635; Refresh Detection</button>
        <button id="install-close-btn" class="install-close-btn">Close</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    ${script}
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getStyles(): string {
  return `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      height: 100vh;
      overflow: hidden;
    }

    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      position: relative;
      z-index: 10000;
    }

    .header-left, .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .session-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--vscode-charts-green);
      padding: 2px 8px;
      background: rgba(0, 200, 83, 0.1);
      border-radius: 10px;
    }

    .session-dot {
      width: 6px;
      height: 6px;
      background: var(--vscode-charts-green);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* History dropdown */
    .history-dropdown {
      position: relative;
    }

    .history-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 280px;
      max-height: 400px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      z-index: 1000;
    }

    .history-menu.hidden {
      display: none;
    }

    .history-empty {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .history-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-widget-border);
    }

    .history-item:last-child {
      border-bottom: none;
    }

    .history-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .history-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .history-item-info {
      flex: 1;
      min-width: 0;
    }

    .history-item-title {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 500;
    }

    .history-item-date {
      display: block;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .history-item.active .history-item-date {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.8;
    }

    .history-item-delete {
      opacity: 0;
      padding: 4px 6px;
      margin-left: 8px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--vscode-errorForeground);
      font-size: 14px;
      line-height: 1;
      border-radius: 4px;
    }

    .history-item-delete:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .history-item:hover .history-item-delete {
      opacity: 1;
    }

    .icon-btn {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .icon-btn.small {
      padding: 2px;
    }

    .settings-panel {
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      position: relative;
      z-index: 50;
    }

    .settings-panel.hidden {
      display: none;
    }

    .settings-section {
      margin-bottom: 12px;
    }

    .settings-section:last-child {
      margin-bottom: 0;
    }

    .settings-label {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .select {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 12px;
    }

    .select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .settings-divider {
      height: 1px;
      background: var(--vscode-panel-border);
      margin: 12px 0;
    }

    .settings-section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .settings-toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .settings-toggle {
      position: relative;
      width: 32px;
      height: 18px;
      background: var(--vscode-input-background);
      border-radius: 9px;
      border: 1px solid var(--vscode-input-border);
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
    }

    .settings-toggle-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 12px;
      height: 12px;
      background: var(--vscode-descriptionForeground);
      border-radius: 50%;
      transition: all 0.2s ease;
    }

    .settings-toggle.active {
      background: var(--vscode-charts-green, #22c55e);
      border-color: var(--vscode-charts-green, #22c55e);
    }

    .settings-toggle.active .settings-toggle-knob {
      left: 16px;
      background: white;
    }

    .settings-toggle-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* Token Budget Input */
    .token-budget-input-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .token-budget-input-row .input {
      width: 100px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 12px;
    }

    .token-budget-input-row .input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .token-budget-suffix {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .token-budget-hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      opacity: 0.8;
    }

    #token-budget-section.hidden {
      display: none;
    }

    /* Brainstorm Agent Selection */
    .settings-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }

    .brainstorm-agent-selector {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 6px;
    }

    .brainstorm-agent-option {
      cursor: pointer;
      user-select: none;
    }

    .brainstorm-agent-option input[type="checkbox"] {
      display: none;
    }

    .brainstorm-agent-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 16px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-input-background);
      font-size: 12px;
      transition: all 0.15s ease;
    }

    .brainstorm-agent-option:hover .brainstorm-agent-chip {
      border-color: var(--vscode-focusBorder);
    }

    .brainstorm-agent-option input:checked + .brainstorm-agent-chip {
      background: color-mix(in srgb, var(--vscode-button-background) 20%, transparent);
      border-color: var(--vscode-button-background);
    }

    .brainstorm-agent-option.disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    .brainstorm-agent-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .brainstorm-agent-name {
      color: var(--vscode-foreground);
    }

    .brainstorm-agent-error {
      color: var(--vscode-errorForeground);
      font-size: 11px;
      margin-top: 4px;
    }

    .brainstorm-agent-error.hidden {
      display: none;
    }

    #brainstorm-agents-section.hidden {
      display: none;
    }

    /* Inline Suggestions Widget (compact, above input) */
    .inline-suggestions {
      padding: 6px 12px;
      background: var(--vscode-editorWidget-background);
      border-top: 1px solid var(--vscode-panel-border);
      animation: slideUp 0.15s ease;
    }

    .inline-suggestions.hidden {
      display: none;
    }

    .inline-suggestions-content {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .inline-suggestions-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }

    .inline-suggestions-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .inline-suggestions-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }

    .inline-suggestions-toggle input {
      width: 12px;
      height: 12px;
      margin: 0;
      cursor: pointer;
    }

    .inline-toggle-text {
      white-space: nowrap;
    }

    .inline-suggestions-dismiss {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      border-radius: 3px;
    }

    .inline-suggestions-dismiss:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }

    /* Recommendation Chips */
    .recommendation-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 10px;
      font-size: 11px;
      cursor: pointer;
      background: var(--vscode-badge-background);
      border: 1px solid transparent;
      transition: all 0.12s ease;
      max-width: 180px;
    }

    .recommendation-chip:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .recommendation-chip.high-confidence {
      border-color: var(--vscode-charts-green, #22c55e);
    }

    .recommendation-chip.medium-confidence {
      border-color: var(--vscode-charts-yellow, #eab308);
    }

    .recommendation-chip.low-confidence {
      border-color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }

    .recommendation-chip.selected {
      background: var(--vscode-list-activeSelectionBackground);
      border-color: var(--vscode-focusBorder);
    }

    .chip-name {
      font-weight: 500;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chip-type {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Toolbar Persona Indicator Button */
    .persona-indicator-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: none;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .persona-indicator-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .persona-indicator-btn.has-persona {
      color: var(--vscode-foreground);
      background: var(--vscode-badge-background);
    }

    .persona-indicator-btn.has-persona:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .persona-indicator-btn svg {
      flex-shrink: 0;
    }

    #toolbar-persona-name {
      max-width: 80px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toolbar-persona-clear {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      margin-left: 2px;
      opacity: 0.7;
      transition: all 0.15s ease;
    }

    .toolbar-persona-clear:hover {
      opacity: 1;
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, #fff);
    }

    .toolbar-persona-clear.hidden {
      display: none;
    }

    .toolbar-persona-clear svg {
      flex-shrink: 0;
    }

    /* About Panel */
    .about-panel {
      padding: 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .about-panel.hidden {
      display: none;
    }

    .about-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .about-logo {
      width: 48px;
      height: 48px;
      border-radius: 8px;
    }

    .about-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .about-title h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    .about-version {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-badge-background);
      padding: 2px 6px;
      border-radius: 4px;
    }

    .about-tagline {
      font-size: 14px;
      font-weight: 500;
      color: var(--vscode-foreground);
      margin: 0 0 8px 0;
    }

    .about-description {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
      margin: 0 0 16px 0;
    }

    .about-section {
      margin-bottom: 12px;
    }

    .about-section h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 4px 0;
    }

    .about-section p {
      margin: 0;
      font-size: 12px;
    }

    .about-author {
      color: var(--vscode-descriptionForeground);
    }

    .about-links {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }

    .about-links a {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .about-links a:hover {
      text-decoration: underline;
    }

    .about-links svg {
      width: 14px;
      height: 14px;
    }

    .credits-list {
      margin: 0;
      padding-left: 16px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .credits-list li {
      margin: 2px 0;
    }

    /* Agent Configuration Panel */
    .agent-config-panel {
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      position: relative;
      z-index: 50;
      max-height: 60vh;
      overflow-y: auto;
    }

    .agent-config-panel.hidden {
      display: none;
    }

    .config-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 6px;
      margin-bottom: 12px;
      font-size: 11px;
    }

    .config-summary-label {
      color: var(--vscode-descriptionForeground);
    }

    .config-summary-value {
      flex: 1;
      color: var(--vscode-foreground);
      font-weight: 500;
    }

    .config-reset-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      opacity: 0.7;
    }

    .config-reset-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }

    .config-section {
      margin-bottom: 16px;
    }

    .config-section:last-child {
      margin-bottom: 0;
    }

    .config-section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .config-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
    }

    .config-section-hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    /* Persona Grid */
    .persona-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
    }

    .persona-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px 4px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
    }

    .persona-card:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .persona-card.selected {
      background: var(--vscode-list-activeSelectionBackground);
      border-color: var(--vscode-focusBorder);
    }

    .persona-card-icon {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 4px;
    }

    .persona-card-icon img {
      width: 16px;
      height: 16px;
      object-fit: contain;
    }

    .persona-card-name {
      font-size: 9px;
      font-weight: 500;
      color: var(--vscode-foreground);
      line-height: 1.2;
      word-break: break-word;
    }

    .persona-card.selected .persona-card-name {
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }

    /* Skills List */
    .skills-list {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px;
    }

    .skill-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .skill-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .skill-item.active {
      background: var(--vscode-list-activeSelectionBackground);
    }

    .skill-toggle {
      position: relative;
      width: 28px;
      height: 16px;
      background: var(--vscode-input-background);
      border-radius: 8px;
      border: 1px solid var(--vscode-input-border);
      transition: all 0.2s ease;
      flex-shrink: 0;
    }

    .skill-toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 10px;
      height: 10px;
      background: var(--vscode-descriptionForeground);
      border-radius: 50%;
      transition: all 0.2s ease;
    }

    .skill-item.active .skill-toggle {
      background: var(--vscode-charts-green, #22c55e);
      border-color: var(--vscode-charts-green, #22c55e);
    }

    .skill-item.active .skill-toggle::after {
      left: 14px;
      background: white;
    }

    .skill-name {
      flex: 1;
      font-size: 11px;
      color: var(--vscode-foreground);
    }

    .skill-item.active .skill-name {
      color: var(--vscode-charts-green, #22c55e);
      font-weight: 500;
    }

    /* Active indicator on config button */
    #agent-config-btn {
      position: relative;
    }

    #agent-config-btn.has-config::after {
      content: '';
      position: absolute;
      top: 2px;
      right: 2px;
      width: 6px;
      height: 6px;
      background: var(--vscode-charts-blue, #3b82f6);
      border-radius: 50%;
    }

    .context-section {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .context-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .context-title {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .context-controls {
      display: flex;
      gap: 4px;
    }

    .pill-btn {
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: none;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 10px;
      cursor: pointer;
    }

    .pill-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .context-items {
      max-height: 100px;
      overflow-y: auto;
    }

    .context-empty {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-align: center;
      padding: 8px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 4px;
    }

    .context-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      margin-bottom: 4px;
      font-size: 11px;
    }

    .context-item-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .context-item-remove {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px;
    }

    .context-item-remove:hover {
      color: var(--vscode-errorForeground);
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      position: relative;
      z-index: 1;
    }

    /* Welcome screen container */
    .welcome-container {
      padding: 20px;
      max-width: 700px;
      margin: 0 auto;
    }

    .welcome-header {
      text-align: center;
      margin-bottom: 20px;
    }

    .welcome-header h2 {
      font-size: 18px;
      margin-bottom: 6px;
      color: var(--vscode-foreground);
    }

    .welcome-header p {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .welcome-logo {
      width: 80px;
      height: 80px;
      object-fit: contain;
      margin-bottom: 12px;
    }

    .welcome-suggestions {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }

    .welcome-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 14px 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .welcome-card:hover {
      border-color: var(--card-color, var(--vscode-focusBorder));
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transform: translateY(-2px);
    }

    .welcome-card:active {
      transform: translateY(0);
    }

    .welcome-card-icon {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 8px;
    }

    .welcome-card-icon img {
      width: 28px;
      height: 28px;
      object-fit: contain;
    }

    .welcome-card-title {
      font-weight: 600;
      font-size: 11px;
      margin-bottom: 3px;
      color: var(--vscode-foreground);
    }

    .welcome-card-desc {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.3;
    }

    /* Welcome card color variants */
    .welcome-card[data-color="blue"] { --card-color: #3b82f6; }
    .welcome-card[data-color="green"] { --card-color: #22c55e; }
    .welcome-card[data-color="purple"] { --card-color: #a855f7; }
    .welcome-card[data-color="orange"] { --card-color: #f97316; }
    .welcome-card[data-color="indigo"] { --card-color: #6366f1; }
    .welcome-card[data-color="red"] { --card-color: #ef4444; }
    .welcome-card[data-color="teal"] { --card-color: #14b8a6; }
    .welcome-card[data-color="pink"] { --card-color: #ec4899; }
    .welcome-card[data-color="amber"] { --card-color: #f59e0b; }

    .message {
      margin-bottom: 16px;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 4px;
    }

    .message-role-container {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .message-role {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .message-role.user {
      color: var(--vscode-textLink-foreground);
    }

    .message-role.assistant {
      color: var(--vscode-charts-green);
    }

    .message-model-info {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
      text-transform: none;
      letter-spacing: normal;
    }

    .message-content {
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
    }

    .message.user .message-content {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
    }

    .message.assistant .message-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }

    .message-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }

    .message-content code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .thinking-block {
      padding: 4px 0;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .thinking-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: middle;
      width: 14px;
      height: 14px;
      margin-right: 6px;
      color: var(--vscode-descriptionForeground);
    }

    .thinking-content {
      display: inline;
      vertical-align: middle;
    }

    /* Collapsible Claude thinking */
    .thinking-block.collapsible {
      cursor: pointer;
    }
    .thinking-block .thinking-preview {
      display: inline;
      vertical-align: middle;
    }
    .thinking-block .thinking-dots {
      color: var(--vscode-descriptionForeground);
      margin-left: 4px;
      font-weight: bold;
    }
    .thinking-block .thinking-rest {
      display: none;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border);
      white-space: pre-wrap;
    }
    .thinking-block.expanded .thinking-rest {
      display: block;
    }
    .thinking-block.expanded .thinking-dots {
      display: none;
    }

    /* Suggestions container wrapper */
    .quick-actions-container {
      border-top: 1px solid var(--vscode-panel-border);
    }

    .quick-actions-container.hidden {
      display: none;
    }

    .quick-actions-container.ai-running {
      display: none;
    }

    .quick-actions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--vscode-sideBar-background);
    }

    .quick-actions-title {
      font-size: 11px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .quick-actions-hide {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 4px;
      opacity: 0.7;
      transition: all 0.15s ease;
    }

    .quick-actions-hide:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    /* Suggestions grid - layout for cards */
    .quick-actions {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      padding: 12px;
      max-height: 280px;
      overflow-y: auto;
    }

    .quick-actions.loading {
      pointer-events: none;
    }

    .quick-actions:empty {
      display: none;
    }

    /* Responsive: single column for narrow panels */
    @media (max-width: 400px) {
      .quick-actions {
        grid-template-columns: 1fr;
        padding: 8px;
        gap: 6px;
        max-height: 200px;
      }

      .suggestion-card {
        padding: 8px;
      }

      .suggestion-icon {
        width: 28px;
        height: 28px;
        font-size: 14px;
      }
    }

    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    @keyframes fadeSlideIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Skeleton card loader */
    .skeleton-card {
      display: flex;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
    }

    .skeleton-icon {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: linear-gradient(90deg, var(--vscode-editor-background) 0%, var(--vscode-widget-border) 50%, var(--vscode-editor-background) 100%);
      background-size: 200% 100%;
      animation: shimmer 1.5s ease-in-out infinite;
      flex-shrink: 0;
    }

    .skeleton-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .skeleton-text {
      height: 10px;
      border-radius: 4px;
      background: linear-gradient(90deg, var(--vscode-editor-background) 0%, var(--vscode-widget-border) 50%, var(--vscode-editor-background) 100%);
      background-size: 200% 100%;
      animation: shimmer 1.5s ease-in-out infinite;
    }

    .skeleton-card:nth-child(1) { animation-delay: 0s; }
    .skeleton-card:nth-child(2) { animation-delay: 0.1s; }
    .skeleton-card:nth-child(3) { animation-delay: 0.2s; }
    .skeleton-card:nth-child(4) { animation-delay: 0.3s; }
    .skeleton-card:nth-child(5) { animation-delay: 0.4s; }
    .skeleton-card:nth-child(6) { animation-delay: 0.5s; }

    /* Suggestion cards */
    .suggestion-card {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      opacity: 0;
      animation: fadeSlideIn 0.3s ease forwards;
      text-align: left;
    }

    .suggestion-card:hover {
      border-color: var(--card-color, var(--vscode-focusBorder));
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      transform: translateY(-1px);
    }

    .suggestion-card:active {
      transform: translateY(0);
    }

    .suggestion-icon {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
      background: var(--icon-bg, rgba(59,130,246,0.15));
    }

    .suggestion-content {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }

    .suggestion-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .suggestion-description {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.3;
    }

    /* Color variants */
    .suggestion-card[data-color="blue"] { --card-color: #3b82f6; --icon-bg: rgba(59,130,246,0.15); }
    .suggestion-card[data-color="green"] { --card-color: #22c55e; --icon-bg: rgba(34,197,94,0.15); }
    .suggestion-card[data-color="purple"] { --card-color: #a855f7; --icon-bg: rgba(168,85,247,0.15); }
    .suggestion-card[data-color="orange"] { --card-color: #f97316; --icon-bg: rgba(249,115,22,0.15); }
    .suggestion-card[data-color="indigo"] { --card-color: #6366f1; --icon-bg: rgba(99,102,241,0.15); }
    .suggestion-card[data-color="red"] { --card-color: #ef4444; --icon-bg: rgba(239,68,68,0.15); }
    .suggestion-card[data-color="teal"] { --card-color: #14b8a6; --icon-bg: rgba(20,184,166,0.15); }
    .suggestion-card[data-color="pink"] { --card-color: #ec4899; --icon-bg: rgba(236,72,153,0.15); }
    .suggestion-card[data-color="amber"] { --card-color: #f59e0b; --icon-bg: rgba(245,158,11,0.15); }

    /* Legacy quick action btn (keep for compatibility) */
    .quick-action-btn {
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: none;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }

    .quick-action-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .input-area {
      padding: 8px 12px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    .input-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 8px;
    }

    .toolbar-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
    }

    .toolbar-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .toolbar-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .toolbar-btn:disabled:hover {
      background: transparent;
      color: var(--vscode-descriptionForeground);
    }

    /* Enhance button loading state */
    .toolbar-btn.enhancing {
      color: var(--vscode-progressBar-background);
      pointer-events: none;
    }

    .toolbar-btn.enhancing svg {
      animation: sparkle 0.8s ease-in-out infinite;
    }

    @keyframes sparkle {
      0%, 100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.5;
        transform: scale(1.15);
      }
    }

    /* Input area disabled state during enhancement */
    .input-area.enhancing textarea {
      opacity: 0.6;
      pointer-events: none;
    }

    .input-area.enhancing .send-btn {
      opacity: 0.5;
      pointer-events: none;
    }

    .toolbar-spacer {
      flex: 1;
    }

    .mode-indicator {
      display: flex;
      align-items: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 8px;
      background: var(--vscode-input-background);
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }

    .mode-indicator:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .input-container {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    .input-wrapper {
      flex: 1;
      position: relative;
    }

    .autocomplete-ghost {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      padding: 8px 12px;
      pointer-events: none;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      color: var(--vscode-input-placeholderForeground);
      opacity: 0.6;
      overflow: hidden;
    }

    .autocomplete-ghost .ghost-text {
      color: var(--vscode-textLink-foreground);
      opacity: 0.7;
    }

    #message-input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      font-family: var(--vscode-font-family);
      resize: none;
      min-height: 36px;
      max-height: 240px;
    }

    #message-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 10px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      align-self: flex-end;
    }

    .send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .stop-btn {
      background: var(--vscode-errorForeground, #f14c4c);
      color: var(--vscode-button-foreground, white);
      border: none;
      padding: 8px 10px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      align-self: flex-end;
    }

    .stop-btn:hover {
      opacity: 0.85;
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .slash-menu {
      position: absolute;
      bottom: 80px;
      left: 12px;
      right: 12px;
      background: var(--vscode-quickInput-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      z-index: 100;
    }

    .slash-menu.hidden {
      display: none;
    }

    .slash-menu-item {
      padding: 8px 12px;
      cursor: pointer;
      font-size: 12px;
    }

    .slash-menu-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .slash-menu-item:first-child {
      border-radius: 7px 7px 0 0;
    }

    .slash-menu-item:last-child {
      border-radius: 0 0 7px 7px;
    }

    /* Agent selector styles */
    .agent-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      background: var(--vscode-input-background);
    }

    .agent-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .agent-icon {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .agent-icon img {
      width: 14px;
      height: 14px;
      object-fit: contain;
    }

    /* Context usage pie chart */
    .context-usage {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      border-radius: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .context-usage:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .context-pie {
      width: 18px;
      height: 18px;
    }

    .context-pie-bg {
      fill: var(--vscode-input-border, #3c3c3c);
    }

    .context-pie-fill {
      fill: var(--vscode-progressBar-background, #0e639c);
      transition: d 0.3s ease;
    }

    .context-usage.warning .context-pie-fill {
      fill: var(--vscode-editorWarning-foreground, #cca700);
    }

    .context-usage.danger .context-pie-fill {
      fill: var(--vscode-errorForeground, #f14c4c);
    }

    .context-usage-text {
      min-width: 24px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    /* Agent menu */
    .agent-menu {
      position: absolute;
      bottom: 80px;
      right: 12px;
      min-width: 200px;
      background: var(--vscode-quickInput-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      z-index: 100;
      overflow: hidden;
    }

    .agent-menu.hidden {
      display: none;
    }

    .agent-menu-header {
      padding: 8px 12px;
      font-size: 10px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .agent-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 12px;
    }

    .agent-menu-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .agent-menu-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    /* Disabled menu items - use color dimming instead of opacity */
    .agent-menu-item.disabled {
      cursor: default;
    }

    .agent-menu-item.disabled:hover {
      background: transparent;
    }

    .agent-menu-item.disabled .agent-item-name,
    .agent-menu-item.disabled .agent-item-icon {
      opacity: 0.5;
    }

    .agent-menu-item.disabled .agent-item-badge {
      background: var(--vscode-errorBackground, rgba(255, 0, 0, 0.1));
      color: var(--vscode-errorForeground, #f87171);
    }

    /* Install button - inside menu item, always fully visible */
    .agent-install-btn {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      margin-left: auto;
      opacity: 1 !important;
    }

    .agent-install-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    select option:disabled {
      color: var(--vscode-disabledForeground);
    }

    .agent-item-icon {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .agent-item-icon img {
      width: 14px;
      height: 14px;
      object-fit: contain;
    }

    .agent-item-name {
      flex: 1;
    }

    .agent-item-badge {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .agent-item-status {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .agent-item-status.active {
      color: var(--vscode-charts-green, #22c55e);
    }

    .agent-item-desc {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }

    .agent-menu-divider {
      height: 1px;
      background: var(--vscode-panel-border);
      margin: 4px 0;
    }

    /* Brainstorm UI styles */
    .brainstorm-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 12px;
    }

    .brainstorm-phases {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px;
      background: var(--vscode-editor-background);
      border-radius: 8px;
      border: 1px solid var(--vscode-panel-border);
    }

    .phase-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 16px;
      font-size: 11px;
      font-weight: 500;
      transition: all 0.3s ease;
    }

    .phase-indicator.pending {
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
    }

    .phase-indicator.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      animation: pulse 2s infinite;
    }

    .phase-indicator.complete {
      background: color-mix(in srgb, var(--vscode-charts-green, #22c55e) 20%, transparent);
      color: var(--vscode-charts-green, #22c55e);
    }

    .phase-connector {
      width: 24px;
      height: 2px;
      background: var(--vscode-panel-border);
    }

    .phase-connector.complete {
      background: var(--vscode-charts-green, #22c55e);
    }

    .agent-responses {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .agent-response-card {
      display: flex;
      flex-direction: column;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      transition: border-color 0.2s ease;
    }

    .agent-response-card.streaming {
      border-color: var(--agent-color, var(--vscode-focusBorder));
    }

    .agent-response-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .agent-response-icon {
      font-size: 14px;
    }

    .agent-response-name {
      font-weight: 600;
      font-size: 12px;
    }

    .agent-response-status {
      margin-left: auto;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
    }

    .agent-response-status.streaming {
      background: var(--vscode-charts-blue);
      color: white;
      animation: pulse 1.5s infinite;
    }

    .agent-response-status.complete {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }

    .agent-response-content {
      padding: 12px;
      font-size: 13px;
      line-height: 1.5;
      max-height: 300px;
      overflow-y: auto;
    }

    .synthesis-container {
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(16, 185, 129, 0.1) 100%);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
    }

    .synthesis-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
      font-weight: 600;
      font-size: 14px;
    }

    .synthesis-content {
      padding: 16px;
      font-size: 13px;
      line-height: 1.6;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    /* Brainstorm session UI */
    .brainstorm-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.15) 0%, rgba(16, 185, 129, 0.15) 100%);
      border-radius: 8px 8px 0 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .brainstorm-icon {
      font-size: 18px;
    }

    .brainstorm-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--vscode-foreground);
    }

    .brainstorm-phase-indicator {
      margin-left: auto;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
    }

    .brainstorm-phase-indicator.individual {
      background: color-mix(in srgb, var(--vscode-charts-blue, #3b82f6) 20%, transparent);
      color: var(--vscode-charts-blue, #3b82f6);
    }

    .brainstorm-phase-indicator.discussion {
      background: color-mix(in srgb, var(--vscode-charts-orange, #f59e0b) 20%, transparent);
      color: var(--vscode-charts-orange, #f59e0b);
    }

    .brainstorm-phase-indicator.synthesis {
      background: color-mix(in srgb, var(--vscode-charts-purple, #8b5cf6) 20%, transparent);
      color: var(--vscode-charts-purple, #8b5cf6);
    }

    .brainstorm-phase-indicator.complete {
      background: color-mix(in srgb, var(--vscode-charts-green, #22c55e) 20%, transparent);
      color: var(--vscode-charts-green, #22c55e);
    }

    .brainstorm-agents {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      padding: 12px;
      background: var(--vscode-editor-background);
    }

    .brainstorm-agent-card {
      display: flex;
      flex-direction: column;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
    }

    .brainstorm-agent-card[data-agent="claude-code"] {
      border-color: rgba(139, 92, 246, 0.3);
    }

    .brainstorm-agent-card[data-agent="openai-codex"] {
      border-color: rgba(16, 185, 129, 0.3);
    }

    .brainstorm-agent-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .brainstorm-agent-icon {
      font-size: 14px;
    }

    .brainstorm-agent-logo {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      object-fit: contain;
    }

    .brainstorm-agent-name {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
    }

    .brainstorm-agent-status {
      margin-left: auto;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .brainstorm-agent-status.streaming {
      background: color-mix(in srgb, var(--vscode-charts-blue, #3b82f6) 20%, transparent);
      color: var(--vscode-charts-blue, #3b82f6);
      animation: pulse 1.5s infinite;
    }

    .brainstorm-agent-status.complete {
      background: color-mix(in srgb, var(--vscode-charts-green, #22c55e) 20%, transparent);
      color: var(--vscode-charts-green, #22c55e);
    }

    .brainstorm-agent-content {
      padding: 12px;
      font-size: 13px;
      line-height: 1.6;
      max-height: 350px;
      overflow-y: auto;
    }

    .brainstorm-agent-content:empty::before {
      content: "Waiting for response...";
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .brainstorm-synthesis {
      margin: 0 12px 12px;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(16, 185, 129, 0.1) 100%);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
    }

    .brainstorm-synthesis.hidden {
      display: none;
    }

    .brainstorm-synthesis-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .brainstorm-synthesis-icon {
      font-size: 16px;
    }

    .brainstorm-synthesis-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--vscode-foreground);
    }

    .brainstorm-synthesis-content {
      padding: 16px;
      font-size: 13px;
      line-height: 1.6;
    }

    .brainstorm-error {
      padding: 12px 16px;
      margin: 12px;
      background: rgba(248, 81, 73, 0.1);
      border: 1px solid var(--vscode-charts-red);
      border-radius: 8px;
      color: var(--vscode-charts-red);
      font-size: 13px;
    }

    .brainstorm-error .error-icon {
      margin-right: 8px;
    }

    .loading {
      display: flex;
      gap: 4px;
      padding: 12px;
    }

    .loading-dot {
      width: 6px;
      height: 6px;
      background: var(--vscode-foreground);
      border-radius: 50%;
      animation: bounce 1.4s infinite ease-in-out;
    }

    .loading-dot:nth-child(1) { animation-delay: -0.32s; }
    .loading-dot:nth-child(2) { animation-delay: -0.16s; }

    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }

    .tool-call {
      padding: 0;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      margin: 8px 0;
      font-size: 11px;
      overflow: hidden;
      transition: background 0.3s ease;
    }

    .tool-call.completed {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
    }

    .tool-call.failed {
      background: rgba(248, 81, 73, 0.1);
      border: 1px solid var(--vscode-charts-red);
    }

    .tool-call-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      cursor: pointer;
      user-select: none;
    }

    .tool-call-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tool-call-chevron {
      transition: transform 0.2s ease;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .tool-call.expanded .tool-call-chevron {
      transform: rotate(90deg);
    }

    /* Hide chevron and show spinner when running */
    .tool-call.running .tool-call-chevron {
      display: none;
    }

    .tool-call-spinner {
      display: none;
      width: 12px;
      height: 12px;
      flex-shrink: 0;
    }

    .tool-call.running .tool-call-spinner {
      display: block;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .tool-call-name {
      font-weight: 600;
      color: var(--vscode-charts-orange);
      flex-shrink: 0;
    }

    .tool-call-summary {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      opacity: 0.8;
      margin-left: 4px;
    }

    .tool-call-copy {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.2s ease, color 0.2s ease, background 0.2s ease;
      margin-left: auto;
      flex-shrink: 0;
    }

    .tool-call-header:hover .tool-call-copy {
      opacity: 1;
    }

    .tool-call-copy:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .tool-call-copy.copied {
      opacity: 1;
      color: var(--vscode-charts-green);
    }

    .tool-call-copy.copied .tool-call-copy-icon {
      color: var(--vscode-charts-green);
    }

    .tool-call-status {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
    }

    .tool-call-status.running {
      background: var(--vscode-charts-blue);
      color: white;
    }

    .tool-call-status.completed {
      background: var(--vscode-charts-green);
      color: white;
    }

    .tool-call-status.failed {
      background: var(--vscode-charts-red);
      color: white;
    }

    .tool-call-status.pending {
      background: var(--vscode-charts-yellow, #f59e0b);
      color: #1a1a1a;
    }

    /* Pending tool call styling (for AskUserQuestion awaiting input) */
    .tool-call.pending {
      border-left: 3px solid var(--vscode-charts-yellow, #f59e0b);
    }

    .tool-call.pending .tool-call-spinner {
      animation: spin 1.5s linear infinite;
    }

    .tool-call.pending .tool-call-spinner circle {
      stroke: var(--vscode-charts-yellow, #f59e0b);
    }

    /* Todo List Styles */
    .todo-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      margin-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .todo-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-editor-background);
      font-size: 12px;
    }

    .todo-item.completed {
      opacity: 0.7;
    }

    .todo-item.completed .todo-content {
      text-decoration: line-through;
      color: var(--vscode-descriptionForeground);
    }

    .todo-status {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .todo-status.completed {
      color: var(--vscode-charts-green);
    }

    .todo-status.in_progress {
      color: var(--vscode-charts-blue);
      animation: spin 1s linear infinite;
    }

    .todo-status.pending {
      color: var(--vscode-descriptionForeground);
    }

    .todo-content {
      flex: 1;
    }

    /* Sticky Progress Container - for scroll-aware sticky items */
    .sticky-progress-container {
      position: sticky;
      top: 0;
      z-index: 100;
      display: none;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 8px 12px;
      margin: 0 0 8px 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      border-radius: 0 0 8px 8px;
    }

    .sticky-progress-container.has-items {
      display: block;
    }

    .sticky-progress-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 6px;
    }

    .sticky-progress-title {
      opacity: 0.8;
    }

    .sticky-progress-count {
      margin-left: auto;
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    .sticky-progress-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    /* Individual stuck item styling */
    .stuck-todo-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      background: var(--vscode-editor-background);
      border-left: 2px solid var(--vscode-charts-blue);
      animation: slideInFromTop 0.3s ease-out forwards;
    }

    .stuck-todo-item.unsticking {
      animation: slideOutToPosition 0.3s ease-in forwards;
    }

    .stuck-todo-icon {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--vscode-charts-blue);
    }

    .stuck-todo-icon svg {
      animation: spin 1s linear infinite;
    }

    .stuck-todo-text {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Completion animation for stuck items */
    .stuck-todo-item.completing {
      animation: todoCompleteStuck 0.5s ease forwards;
      border-left-color: var(--vscode-charts-green, #22c55e);
    }

    .stuck-todo-item.completing .stuck-todo-icon {
      color: var(--vscode-charts-green, #22c55e);
    }

    .stuck-todo-item.completing .stuck-todo-icon svg {
      animation: none;
    }

    /* Mark original item as stuck (invisible but maintains space) */
    .todo-item.is-stuck {
      visibility: hidden;
    }

    /* Slide animations */
    @keyframes slideInFromTop {
      from {
        transform: translateY(-100%);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    @keyframes slideOutToPosition {
      from {
        transform: translateY(0);
        opacity: 1;
      }
      to {
        transform: translateY(-100%);
        opacity: 0;
      }
    }

    @keyframes todoCompleteStuck {
      0% { opacity: 1; background: var(--vscode-editor-background); }
      30% { opacity: 1; background: rgba(34, 197, 94, 0.15); }
      100% { opacity: 0; max-height: 0; padding: 0; margin: 0; overflow: hidden; }
    }

    .tool-call-details {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.2s ease-out;
      border-top: 1px solid transparent;
    }

    .tool-call.expanded .tool-call-details {
      max-height: 400px;
      overflow-y: auto;
      border-top-color: var(--vscode-panel-border);
    }

    .tool-call-section {
      padding: 8px;
    }

    .tool-call-label {
      font-size: 10px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }

    .tool-call-content,
    .tool-call-output-content {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background);
      padding: 6px 8px;
      border-radius: 3px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 150px;
      overflow-y: auto;
      margin: 0;
    }

    .tool-call-output-section {
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .message-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .message-body .tool-call {
      margin: 0;
    }

    .message-body > .message-content:empty {
      display: none;
    }

    .tool-calls-container {
      margin-top: 8px;
    }

    .tool-calls-container .tool-call {
      margin-bottom: 8px;
    }

    .tool-calls-container .tool-call:last-child {
      margin-bottom: 0;
    }

    /* ========================================
       Permission Approval Card
       ======================================== */
    .permission-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      margin: 12px 0;
      overflow: hidden;
      animation: fadeSlideIn 0.3s ease forwards;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .permission-card.pending {
      border-left: 4px solid var(--vscode-charts-orange, #f59e0b);
      background: rgba(245, 158, 11, 0.03);
    }

    .permission-card.approved {
      border-left: 4px solid var(--vscode-charts-green, #22c55e);
      animation: approvedFade 0.5s ease forwards;
    }

    .permission-card.denied {
      border-left: 4px solid var(--vscode-charts-red, #ef4444);
      animation: deniedShake 0.3s ease, fadeOut 0.3s 0.3s ease forwards;
    }

    .permission-card.expired {
      border-left: 4px solid var(--vscode-descriptionForeground);
      opacity: 0.6;
    }

    @keyframes approvedFade {
      0% { opacity: 1; transform: scale(1); }
      50% { background: rgba(34, 197, 94, 0.1); }
      100% { opacity: 0; height: 0; padding: 0; margin: 0; overflow: hidden; }
    }

    @keyframes deniedShake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-4px); }
      75% { transform: translateX(4px); }
    }

    @keyframes fadeOut {
      to { opacity: 0; height: 0; padding: 0; margin: 0; overflow: hidden; }
    }

    .permission-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      background: var(--vscode-titleBar-activeBackground, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .permission-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .permission-icon {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: rgba(245, 158, 11, 0.15);
      color: var(--vscode-charts-orange);
      font-size: 12px;
    }

    .permission-card.pending .permission-icon {
      animation: pulse 2s infinite;
    }

    .permission-title {
      font-weight: 600;
      font-size: 13px;
      color: var(--vscode-foreground);
    }

    .permission-risk {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      margin-left: 8px;
    }

    .permission-risk.low {
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
    }

    .permission-risk.medium {
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
    }

    .permission-risk.high {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }

    .permission-timer {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
      padding: 2px 8px;
      background: var(--vscode-badge-background);
      border-radius: 10px;
    }

    .permission-timer.warning {
      color: var(--vscode-charts-orange);
      background: rgba(245, 158, 11, 0.15);
    }

    .permission-timer.critical {
      color: var(--vscode-charts-red);
      background: rgba(239, 68, 68, 0.15);
      animation: pulse 0.5s infinite;
    }

    .permission-body {
      padding: 12px 14px;
    }

    .permission-description {
      font-size: 13px;
      color: var(--vscode-foreground);
      margin-bottom: 10px;
    }

    .permission-details {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family);
    }

    .permission-detail-row {
      display: flex;
      gap: 8px;
      margin-bottom: 4px;
    }

    .permission-detail-row:last-child {
      margin-bottom: 0;
    }

    .permission-detail-label {
      color: var(--vscode-descriptionForeground);
      min-width: 60px;
    }

    .permission-detail-value {
      color: var(--vscode-foreground);
      word-break: break-all;
    }

    .permission-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(0,0,0,0.1));
      border-top: 1px solid var(--vscode-panel-border);
      flex-wrap: wrap;
    }

    .permission-btn {
      padding: 6px 14px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .permission-btn.approve {
      background: var(--vscode-charts-green, #22c55e);
      color: white;
    }

    .permission-btn.approve:hover {
      background: #16a34a;
    }

    .permission-btn.deny {
      background: transparent;
      border: 1px solid var(--vscode-charts-red, #ef4444);
      color: var(--vscode-charts-red);
    }

    .permission-btn.deny:hover {
      background: rgba(239, 68, 68, 0.1);
    }

    .permission-btn.always-allow {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .permission-btn.always-allow:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .permission-shortcuts {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }

    .permission-shortcuts kbd {
      background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.2));
      border: 1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,0.3));
      border-radius: 3px;
      padding: 1px 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
    }

    /* Permission queue banner */
    .permission-queue-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid var(--vscode-charts-orange);
      border-radius: 6px;
      margin: 8px 12px;
      font-size: 12px;
    }

    .permission-queue-count {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-charts-orange);
      font-weight: 500;
    }

    /* ========================================
       Plan Option Selection Cards
       ======================================== */
    .plan-options-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin: 16px 0;
      padding: 0 4px;
    }

    .plan-options-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .plan-options-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .plan-options-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .plan-option-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      padding: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
      overflow: hidden;
    }

    .plan-option-card:hover {
      border-color: var(--vscode-focusBorder);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    .plan-option-card:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 2px var(--vscode-focusBorder);
    }

    .plan-option-card.selected {
      border-color: var(--vscode-charts-green, #22c55e);
      background: rgba(34, 197, 94, 0.05);
    }

    .plan-option-card.selected::after {
      content: '\\2713';
      position: absolute;
      top: 10px;
      right: 10px;
      width: 24px;
      height: 24px;
      background: var(--vscode-charts-green, #22c55e);
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
    }

    .plan-option-header {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 10px;
    }

    .plan-option-icon {
      font-size: 20px;
      line-height: 1;
      flex-shrink: 0;
    }

    .plan-option-title-area {
      flex: 1;
      min-width: 0;
    }

    .plan-option-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .plan-option-complexity {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
    }

    .plan-option-complexity.low {
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
    }

    .plan-option-complexity.medium {
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
    }

    .plan-option-complexity.high {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }

    .plan-option-summary {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }

    .plan-option-proscons {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .plan-option-pros, .plan-option-cons {
      font-size: 11px;
    }

    .plan-option-pros-title, .plan-option-cons-title {
      font-weight: 600;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .plan-option-pros-title {
      color: var(--vscode-charts-green, #22c55e);
    }

    .plan-option-cons-title {
      color: var(--vscode-charts-red, #ef4444);
    }

    .plan-option-list {
      list-style: none;
      padding: 0;
      margin: 0;
      color: var(--vscode-descriptionForeground);
    }

    .plan-option-list li {
      padding: 2px 0;
      padding-left: 12px;
      position: relative;
    }

    .plan-option-list li::before {
      content: '•';
      position: absolute;
      left: 0;
    }

    .plan-option-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .plan-option-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .plan-option-btn.select {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .plan-option-btn.select:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .plan-option-btn.details {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      padding: 8px 12px;
    }

    .plan-option-btn.details:hover {
      text-decoration: underline;
    }

    /* Plan option expand/collapse */
    .plan-option-expanded {
      max-height: 500px;
      overflow: hidden;
      transition: max-height 0.3s ease;
    }

    .plan-option-collapsed .plan-option-proscons,
    .plan-option-collapsed .plan-option-actions,
    .plan-option-collapsed .plan-custom-instructions {
      display: none;
    }

    /* Plan execution buttons */
    .plan-execute-btn {
      flex: 1;
      min-width: 100px;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent);
      transition: all 0.15s ease;
    }

    .plan-execute-btn.edit-auto {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .plan-execute-btn.edit-auto:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .plan-execute-btn.ask-first {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .plan-execute-btn.ask-first:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .plan-execute-btn.keep-planning {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border);
    }

    .plan-execute-btn.keep-planning:hover {
      background: var(--vscode-list-hoverBackground);
    }

    /* Custom instructions section */
    .plan-custom-instructions {
      margin-top: 12px;
    }

    .custom-instructions-toggle {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 12px;
      padding: 0;
    }

    .custom-instructions-toggle:hover {
      text-decoration: underline;
    }

    .custom-instructions-input {
      margin-top: 8px;
    }

    .custom-instructions-input.hidden {
      display: none;
    }

    .custom-instructions-textarea {
      width: 100%;
      min-height: 60px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      resize: vertical;
      box-sizing: border-box;
    }

    .custom-instructions-textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    /* Color variations for plan cards */
    .plan-option-card[data-color="blue"] { border-left: 4px solid var(--vscode-charts-blue, #3b82f6); }
    .plan-option-card[data-color="green"] { border-left: 4px solid var(--vscode-charts-green, #22c55e); }
    .plan-option-card[data-color="purple"] { border-left: 4px solid var(--vscode-charts-purple, #a855f7); }
    .plan-option-card[data-color="orange"] { border-left: 4px solid var(--vscode-charts-orange, #f59e0b); }
    .plan-option-card[data-color="indigo"] { border-left: 4px solid var(--vscode-charts-blue, #6366f1); }
    .plan-option-card[data-color="teal"] { border-left: 4px solid var(--vscode-charts-green, #14b8a6); }
    .plan-option-card[data-color="red"] { border-left: 4px solid var(--vscode-charts-red, #ef4444); }
    .plan-option-card[data-color="pink"] { border-left: 4px solid var(--vscode-charts-red, #ec4899); }
    .plan-option-card[data-color="amber"] { border-left: 4px solid var(--vscode-charts-yellow, #f59e0b); }

    /* ========================================
       Clarifying Question Input Cards
       ======================================== */
    .questions-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin: 16px 0;
      padding: 0 4px;
    }

    .questions-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .questions-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .questions-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .question-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-left: 4px solid var(--vscode-textLink-foreground);
      border-radius: 10px;
      padding: 16px;
      transition: all 0.2s ease;
    }

    .question-card:hover {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }

    .question-card.answered {
      border-left-color: var(--vscode-charts-green, #22c55e);
      background: rgba(34, 197, 94, 0.03);
    }

    .question-icon {
      font-size: 18px;
      margin-right: 8px;
    }

    .question-text {
      font-size: 13px;
      font-weight: 500;
      color: var(--vscode-foreground);
      margin-bottom: 12px;
      line-height: 1.4;
    }

    .question-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .question-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .question-option:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .question-option.selected {
      background: rgba(59, 130, 246, 0.1);
      border-color: var(--vscode-textLink-foreground);
    }

    .question-option input[type="radio"],
    .question-option input[type="checkbox"] {
      margin: 0;
      margin-top: 2px;
      accent-color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }

    .question-option-content {
      flex: 1;
      min-width: 0;
    }

    .question-option-label {
      font-size: 12px;
      color: var(--vscode-foreground);
      font-weight: 500;
    }

    .question-option-description {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .question-text-input {
      width: 100%;
      padding: 10px 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      color: var(--vscode-input-foreground);
      font-size: 12px;
      font-family: inherit;
      resize: vertical;
      min-height: 60px;
    }

    .question-text-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .question-text-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .questions-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .questions-submit-btn {
      padding: 10px 20px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .questions-submit-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .questions-submit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .questions-skip-btn {
      padding: 10px 16px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .questions-skip-btn:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }

    /* Required indicator */
    .question-required {
      color: var(--vscode-charts-red, #ef4444);
      font-size: 11px;
      margin-left: 4px;
    }

    /* "Other" option styling */
    .question-option-other .question-other-content {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
    }

    .question-other-input {
      width: 100%;
      padding: 8px 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      font-size: 12px;
      font-family: inherit;
    }

    .question-other-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .question-other-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .question-option-other.selected .question-other-input {
      border-color: var(--vscode-textLink-foreground);
    }

    /* Submitted state */
    .questions-container.submitted {
      opacity: 0.7;
      pointer-events: none;
    }

    .questions-submitted {
      text-align: center;
      padding: 16px;
      color: var(--vscode-charts-green, #22c55e);
      font-weight: 500;
      font-size: 13px;
    }

    /* ========================================
       Native AskUserQuestion Tool UI (Tabbed)
       ======================================== */
    .ask-user-question-container {
      margin-top: 16px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-editor-background);
      overflow: hidden;
    }

    .auq-tab-header {
      display: flex;
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
    }

    .auq-tab {
      flex: 1;
      padding: 10px 8px;
      border: none;
      background: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      opacity: 0.7;
      transition: all 0.2s ease;
      border-bottom: 2px solid transparent;
      position: relative;
    }

    .auq-tab:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }

    .auq-tab.active {
      opacity: 1;
      border-bottom-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
      background: var(--vscode-editor-background);
    }

    .auq-tab.answered::after {
      content: ' ✓';
      color: var(--vscode-charts-green, #22c55e);
      font-size: 10px;
    }

    .auq-tab-content {
      padding: 16px;
    }

    .auq-panel {
      display: none;
    }

    .auq-question-text {
      font-weight: 500;
      font-size: 13px;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
      line-height: 1.4;
    }

    .auq-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .auq-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      background: var(--vscode-input-background);
    }

    .auq-option:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .auq-option:has(input:checked) {
      background: rgba(59, 130, 246, 0.1);
      border-color: var(--vscode-textLink-foreground);
    }

    .auq-option input {
      margin-top: 2px;
      accent-color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }

    .auq-option-content {
      flex: 1;
    }

    .auq-option-label {
      font-weight: 500;
      font-size: 12px;
      color: var(--vscode-foreground);
    }

    .auq-option-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      line-height: 1.4;
    }

    .auq-option-other {
      flex-wrap: wrap;
    }

    .auq-other-content {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }

    .auq-other-text {
      width: 100%;
      margin-top: 8px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
    }

    .auq-other-text:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .auq-other-text::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .auq-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
    }

    .auq-skip-btn {
      padding: 8px 16px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      background: none;
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.15s ease;
    }

    .auq-skip-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .auq-submit-btn {
      padding: 8px 16px;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.15s ease;
    }

    .auq-submit-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .auq-submit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .auq-submitted {
      padding: 16px;
      text-align: center;
      color: var(--vscode-charts-green, #22c55e);
      font-weight: 500;
      font-size: 13px;
    }

    .auq-check {
      margin-right: 6px;
    }

    .ask-user-question-container.submitted {
      opacity: 0.7;
      pointer-events: none;
    }

    /* Professional File Diff Component */
    .file-diff {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      margin: 12px 0;
      overflow: hidden;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .file-diff-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--vscode-titleBar-activeBackground, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
      user-select: none;
    }

    .file-diff-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .file-diff-info {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
    }

    .file-diff-icon {
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .file-diff-name {
      font-weight: 500;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-diff-stats {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .file-diff-stat {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 11px;
      font-weight: 500;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .file-diff-stat.additions {
      color: #3fb950;
      background: rgba(46, 160, 67, 0.15);
    }

    .file-diff-stat.deletions {
      color: #f85149;
      background: rgba(248, 81, 73, 0.15);
    }

    .file-diff-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .file-diff-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      opacity: 0;
      transition: opacity 0.15s ease, background 0.15s ease;
    }

    .file-diff-header:hover .file-diff-btn {
      opacity: 1;
    }

    .file-diff-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .file-diff-chevron {
      color: var(--vscode-descriptionForeground);
      transition: transform 0.2s ease;
      flex-shrink: 0;
    }

    .file-diff.expanded .file-diff-chevron {
      transform: rotate(90deg);
    }

    .file-diff-content {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.25s ease-out;
    }

    .file-diff.expanded .file-diff-content {
      max-height: 500px;
      overflow-y: auto;
    }

    .file-diff-lines {
      display: table;
      width: 100%;
      border-collapse: collapse;
    }

    .diff-line {
      display: table-row;
      line-height: 1.5;
    }

    .diff-line-num {
      display: table-cell;
      width: 40px;
      min-width: 40px;
      padding: 0 8px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      background: var(--vscode-editorGutter-background, rgba(0,0,0,0.1));
      border-right: 1px solid var(--vscode-panel-border);
      user-select: none;
      font-size: 11px;
      vertical-align: top;
      padding-top: 1px;
    }

    .diff-line-content {
      display: table-cell;
      padding: 0 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .diff-line.addition {
      background: rgba(46, 160, 67, 0.15);
    }

    .diff-line.addition .diff-line-content {
      color: #3fb950;
    }

    .diff-line.addition .diff-line-num {
      background: rgba(46, 160, 67, 0.25);
      color: #3fb950;
    }

    .diff-line.deletion {
      background: rgba(248, 81, 73, 0.15);
    }

    .diff-line.deletion .diff-line-content {
      color: #f85149;
    }

    .diff-line.deletion .diff-line-num {
      background: rgba(248, 81, 73, 0.25);
      color: #f85149;
    }

    .diff-line.hunk {
      background: rgba(56, 139, 253, 0.1);
    }

    .diff-line.hunk .diff-line-content {
      color: var(--vscode-charts-blue);
      font-style: italic;
    }

    .diff-line.hunk .diff-line-num {
      background: rgba(56, 139, 253, 0.15);
    }

    .diff-line.context {
      background: transparent;
    }

    .diff-line.context .diff-line-content {
      color: var(--vscode-editor-foreground);
      opacity: 0.7;
    }

    .file-diff-expand {
      display: flex;
      justify-content: center;
      padding: 8px;
      background: var(--vscode-textCodeBlock-background);
      border-top: 1px solid var(--vscode-panel-border);
    }

    .file-diff-expand-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .file-diff-expand-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    /* Legacy diff-block fallback */
    .diff-block {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.4;
    }

    .diff-addition {
      background: rgba(46, 160, 67, 0.2);
      color: #3fb950;
    }

    .diff-deletion {
      background: rgba(248, 81, 73, 0.2);
      color: #f85149;
    }

    .diff-hunk {
      color: var(--vscode-charts-blue);
      background: rgba(3, 102, 214, 0.1);
    }

    .diff-header {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }

    /* Markdown styles */
    .message-content h1, .message-content h2, .message-content h3,
    .message-content h4, .message-content h5, .message-content h6 {
      margin: 12px 0 8px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .message-content h1 { font-size: 1.4em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .message-content h2 { font-size: 1.2em; }
    .message-content h3 { font-size: 1.1em; }
    .message-content h4 { font-size: 1em; }
    .message-content h5 { font-size: 0.9em; }
    .message-content h6 { font-size: 0.85em; }

    .message-content ul, .message-content ol {
      margin: 8px 0;
      padding-left: 24px;
    }
    .message-content li { margin: 4px 0; }

    .message-content a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .message-content a:hover { text-decoration: underline; }

    .message-content table {
      border-collapse: collapse;
      margin: 8px 0;
      width: 100%;
      font-size: 12px;
    }
    .message-content th, .message-content td {
      border: 1px solid var(--vscode-panel-border);
      padding: 6px 10px;
      text-align: left;
    }
    .message-content th {
      background: var(--vscode-textBlockQuote-background);
      font-weight: 600;
    }

    .message-content blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding-left: 12px;
      margin: 8px 0;
      color: var(--vscode-descriptionForeground);
    }

    .message-content hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 12px 0;
    }

    .message-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .message-content pre code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      background: none;
      padding: 0;
    }

    .message-content p code, .message-content li code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .message-content p {
      margin: 8px 0;
    }

    .message-content p:first-child {
      margin-top: 0;
    }

    .message-content p:last-child {
      margin-bottom: 0;
    }

    /* Prism VS Code Theme */
    code[class*="language-"],
    pre[class*="language-"] {
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      text-align: left;
      white-space: pre;
      word-spacing: normal;
      word-break: normal;
      tab-size: 2;
    }

    .token.comment,
    .token.prolog,
    .token.doctype,
    .token.cdata {
      color: var(--vscode-editorLineNumber-foreground, #6a9955);
    }

    .token.punctuation {
      color: var(--vscode-editor-foreground);
    }

    .token.property,
    .token.tag,
    .token.boolean,
    .token.number,
    .token.constant,
    .token.symbol {
      color: var(--vscode-debugTokenExpression-number, #b5cea8);
    }

    .token.selector,
    .token.attr-name,
    .token.string,
    .token.char,
    .token.builtin {
      color: var(--vscode-debugTokenExpression-string, #ce9178);
    }

    .token.operator,
    .token.entity,
    .token.url {
      color: var(--vscode-editor-foreground);
    }

    .token.atrule,
    .token.attr-value,
    .token.keyword {
      color: var(--vscode-debugTokenExpression-name, #569cd6);
    }

    .token.function,
    .token.class-name {
      color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
    }

    .token.regex,
    .token.important,
    .token.variable {
      color: var(--vscode-debugTokenExpression-value, #d16969);
    }

    .token.inserted {
      background: rgba(46, 160, 67, 0.2);
      color: var(--vscode-charts-green);
    }

    .token.deleted {
      background: rgba(248, 81, 73, 0.2);
      color: var(--vscode-charts-red);
    }

    /* Mermaid styles */
    .mermaid-diagram {
      background: var(--vscode-textCodeBlock-background);
      padding: 16px;
      border-radius: 6px;
      margin: 8px 0;
      overflow-x: auto;
    }

    .mermaid-pending {
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap;
      color: var(--vscode-descriptionForeground);
    }

    .mermaid-rendered svg {
      max-width: 100%;
      height: auto;
    }

    .mermaid-error {
      border: 1px solid var(--vscode-charts-red);
      color: var(--vscode-errorForeground);
    }

    /* File Edit Card - Professional Inline Diff Display */
    .file-edit-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      margin: 12px 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    }

    .file-edit-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-titleBar-activeBackground));
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .file-edit-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .file-edit-filename {
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .file-edit-path {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-edit-stats {
      display: flex;
      gap: 6px;
      font-size: 11px;
      font-weight: 500;
    }

    .file-edit-additions {
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    }

    .file-edit-deletions {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }

    .file-edit-collapse-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      transition: background 0.15s, transform 0.2s;
    }

    .file-edit-collapse-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .file-edit-card.collapsed .file-edit-collapse-btn svg {
      transform: rotate(-90deg);
    }

    .file-edit-diff {
      max-height: 400px;
      overflow: hidden;
      transition: max-height 0.3s ease;
    }

    .file-edit-card.collapsed .file-edit-diff {
      max-height: 0;
    }

    .file-edit-card.expanded .file-edit-diff {
      max-height: none;
      overflow-y: auto;
    }

    .file-edit-diff-content {
      padding: 0;
    }

    .file-edit-line {
      display: flex;
      line-height: 1.6;
      min-height: 22px;
    }

    .file-edit-line-num {
      width: 40px;
      padding: 0 8px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      background: var(--vscode-editorGutter-background, rgba(0,0,0,0.1));
      user-select: none;
      flex-shrink: 0;
      font-size: 11px;
    }

    .file-edit-line-content {
      flex: 1;
      padding: 0 12px;
      white-space: pre;
      overflow-x: auto;
    }

    .file-edit-line.addition {
      background: rgba(46, 160, 67, 0.15);
    }

    .file-edit-line.addition .file-edit-line-num {
      background: rgba(46, 160, 67, 0.25);
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    }

    .file-edit-line.addition .file-edit-line-content {
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    }

    .file-edit-line.deletion {
      background: rgba(248, 81, 73, 0.15);
    }

    .file-edit-line.deletion .file-edit-line-num {
      background: rgba(248, 81, 73, 0.25);
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }

    .file-edit-line.deletion .file-edit-line-content {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
      text-decoration: line-through;
      opacity: 0.8;
    }

    .file-edit-line.context .file-edit-line-content {
      color: var(--vscode-editor-foreground);
      opacity: 0.7;
    }

    .file-edit-show-more {
      display: block;
      width: 100%;
      padding: 8px;
      background: var(--vscode-textBlockQuote-background);
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 11px;
      text-align: center;
      transition: background 0.15s;
    }

    .file-edit-show-more:hover {
      background: var(--vscode-list-hoverBackground);
      text-decoration: underline;
    }

    .file-edit-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 12px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-titleBar-activeBackground));
      border-top: 1px solid var(--vscode-panel-border);
    }

    .file-edit-btn {
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
      border: 1px solid transparent;
    }

    .file-edit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .file-edit-revert {
      background: transparent;
      border-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .file-edit-revert:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .file-edit-review {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .file-edit-review:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    /* ========================================
       Edit Report Card Styles
       Structured file change visualization
       ======================================== */

    .edit-report-card {
      margin: 8px 0;
      border-radius: 8px;
      overflow: hidden;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    /* Thinking section */
    .edit-report-thinking {
      border-bottom: 1px solid var(--vscode-panel-border);
      background: rgba(138, 43, 226, 0.08);
    }

    .edit-report-thinking-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      color: var(--vscode-charts-purple, #a855f7);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .edit-report-thinking-header::before {
      content: '▶';
      font-size: 8px;
      transition: transform 0.2s;
    }

    .edit-report-thinking.expanded .edit-report-thinking-header::before {
      transform: rotate(90deg);
    }

    .edit-report-thinking-content {
      max-height: 0;
      overflow: hidden;
      padding: 0 12px;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      line-height: 1.5;
      transition: max-height 0.3s ease-out, padding 0.3s ease-out;
    }

    .edit-report-thinking.expanded .edit-report-thinking-content {
      max-height: 300px;
      overflow-y: auto;
      padding: 0 12px 12px 12px;
    }

    /* File header section */
    .edit-report-file-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .edit-report-file-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    /* Bullet indicator */
    .edit-report-bullet {
      font-size: 14px;
      line-height: 1;
    }

    .edit-report-bullet.create {
      color: var(--vscode-charts-green, #3fb950);
    }

    .edit-report-bullet.edit {
      color: var(--vscode-charts-yellow, #d29922);
    }

    .edit-report-bullet.delete {
      color: var(--vscode-charts-red, #f85149);
    }

    /* Action label */
    .edit-report-action {
      font-weight: 600;
    }

    .edit-report-action.create {
      color: var(--vscode-charts-green, #3fb950);
    }

    .edit-report-action.edit {
      color: var(--vscode-charts-yellow, #d29922);
    }

    .edit-report-action.delete {
      color: var(--vscode-charts-red, #f85149);
    }

    /* File name */
    .edit-report-filename {
      color: var(--vscode-textLink-foreground);
      font-weight: 500;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Chevron for expand/collapse */
    .edit-report-chevron {
      color: var(--vscode-descriptionForeground);
      transition: transform 0.2s;
      flex-shrink: 0;
    }

    .edit-report-card.expanded .edit-report-chevron {
      transform: rotate(90deg);
    }

    /* Stats line with tree connector */
    .edit-report-stats {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px 10px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .edit-report-stats-tree {
      color: var(--vscode-panel-border);
      margin-left: 4px;
    }

    .edit-report-stats-added {
      color: var(--vscode-charts-green, #3fb950);
    }

    .edit-report-stats-removed {
      color: var(--vscode-charts-red, #f85149);
    }

    /* Diff content area */
    .edit-report-diff {
      max-height: 0;
      overflow: hidden;
      background: var(--vscode-textCodeBlock-background);
      border-top: 1px solid transparent;
      transition: max-height 0.25s ease-out;
    }

    .edit-report-card.expanded .edit-report-diff {
      max-height: 400px;
      overflow-y: auto;
      border-top-color: var(--vscode-panel-border);
    }

    /* Diff lines */
    .edit-report-diff-line {
      display: flex;
      line-height: 1.6;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .edit-report-diff-linenum {
      width: 40px;
      text-align: right;
      padding-right: 8px;
      flex-shrink: 0;
      user-select: none;
      color: var(--vscode-editorLineNumber-foreground, rgba(255,255,255,0.4));
      font-size: 11px;
    }

    .edit-report-diff-prefix {
      width: 20px;
      text-align: center;
      flex-shrink: 0;
      user-select: none;
      color: var(--vscode-descriptionForeground);
    }

    .edit-report-diff-content {
      flex: 1;
      padding: 0 12px 0 4px;
      white-space: pre;
      overflow-x: auto;
    }

    .edit-report-diff-line.context {
      color: var(--vscode-editor-foreground);
      opacity: 0.8;
      border-left: 4px solid transparent;
      background: rgba(128, 128, 128, 0.05);
    }

    .edit-report-diff-line.context .edit-report-diff-prefix {
      color: var(--vscode-editor-foreground);
      opacity: 0.5;
    }

    /* GitHub-style diff lines with border indicators */
    .edit-report-diff-line.addition {
      background: rgba(35, 134, 54, 0.25);
      border-left: 4px solid #238636;
    }

    .edit-report-diff-line.addition .edit-report-diff-prefix {
      color: #238636;
      font-weight: bold;
    }

    .edit-report-diff-line.addition .edit-report-diff-content {
      color: #3fb950;
    }

    .edit-report-diff-line.deletion {
      background: rgba(248, 81, 73, 0.25);
      border-left: 4px solid #f85149;
    }

    .edit-report-diff-line.deletion .edit-report-diff-prefix {
      color: #f85149;
      font-weight: bold;
    }

    .edit-report-diff-line.deletion .edit-report-diff-content {
      color: #f85149;
    }

    /* Syntax highlighting tokens in diff lines */
    .edit-report-diff-content .token.comment,
    .edit-report-diff-content .token.prolog,
    .edit-report-diff-content .token.doctype,
    .edit-report-diff-content .token.cdata {
      color: #6a9955;
    }

    .edit-report-diff-content .token.punctuation {
      color: inherit;
    }

    .edit-report-diff-content .token.property,
    .edit-report-diff-content .token.tag,
    .edit-report-diff-content .token.boolean,
    .edit-report-diff-content .token.number,
    .edit-report-diff-content .token.constant,
    .edit-report-diff-content .token.symbol {
      color: #b5cea8;
    }

    .edit-report-diff-content .token.selector,
    .edit-report-diff-content .token.attr-name,
    .edit-report-diff-content .token.string,
    .edit-report-diff-content .token.char,
    .edit-report-diff-content .token.builtin {
      color: #ce9178;
    }

    .edit-report-diff-content .token.operator,
    .edit-report-diff-content .token.entity,
    .edit-report-diff-content .token.url,
    .edit-report-diff-content .token.variable {
      color: #d4d4d4;
    }

    .edit-report-diff-content .token.atrule,
    .edit-report-diff-content .token.attr-value,
    .edit-report-diff-content .token.keyword {
      color: #569cd6;
    }

    .edit-report-diff-content .token.function,
    .edit-report-diff-content .token.class-name {
      color: #dcdcaa;
    }

    .edit-report-diff-content .token.regex,
    .edit-report-diff-content .token.important {
      color: #d16969;
    }

    /* Adjust token colors for context lines (slightly dimmed) */
    .edit-report-diff-line.context .edit-report-diff-content .token {
      opacity: 0.85;
    }

    /* Show more link in diff */
    .edit-report-show-more {
      padding: 6px 12px;
      text-align: center;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background);
      border-top: 1px solid var(--vscode-panel-border);
    }

    .edit-report-show-more:hover {
      text-decoration: underline;
    }

    /* Actions row */
    .edit-report-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-top: 1px solid var(--vscode-panel-border);
    }

    .edit-report-btn {
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.15s;
    }

    .edit-report-btn-copy {
      background: transparent;
      border-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .edit-report-btn-copy:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .edit-report-btn-open {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .edit-report-btn-open:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .edit-report-btn-revert {
      background: transparent;
      border-color: var(--vscode-editorError-foreground, #f85149);
      color: var(--vscode-editorError-foreground, #f85149);
    }

    .edit-report-btn-revert:hover {
      background: rgba(248, 81, 73, 0.15);
    }

    .edit-report-btn-revert:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .edit-report-btn-revert.reverted {
      border-color: var(--vscode-charts-green, #3fb950);
      color: var(--vscode-charts-green, #3fb950);
    }

    .edit-report-btn-revert.failed {
      border-color: var(--vscode-editorError-foreground, #f85149);
      color: var(--vscode-editorError-foreground, #f85149);
    }

    /* Setup Overlay Styles */
    .setup-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-sideBar-background);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100000;
    }

    .setup-overlay.hidden {
      display: none;
    }

    .setup-content {
      text-align: center;
      padding: 40px;
      max-width: 400px;
    }

    .setup-logo {
      width: 64px;
      height: 64px;
      margin-bottom: 20px;
    }

    .setup-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .setup-step {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
    }

    .setup-message {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 20px;
      line-height: 1.5;
    }

    .setup-progress-track {
      height: 4px;
      background: var(--vscode-progressBar-background, rgba(255, 255, 255, 0.1));
      border-radius: 2px;
      margin-bottom: 16px;
      overflow: hidden;
    }

    .setup-progress-bar {
      height: 100%;
      background: var(--vscode-progressBar-background, #0078d4);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .setup-buttons {
      display: flex;
      gap: 12px;
      justify-content: center;
      margin-top: 20px;
    }

    .setup-btn {
      padding: 8px 20px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s;
    }

    .setup-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .setup-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .setup-btn.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border);
    }

    .setup-btn.secondary:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .setup-error {
      margin-top: 20px;
    }

    .setup-error.hidden {
      display: none;
    }

    .setup-error-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }

    .setup-error-message {
      color: var(--vscode-editorError-foreground, #f85149);
      font-size: 13px;
      margin-bottom: 16px;
    }

    .setup-auth-prompt {
      text-align: center;
    }

    /* ============================================
       Setup Wizard Styles (Enhanced Onboarding)
       ============================================ */

    .setup-wizard {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 20px;
      overflow-y: auto;
      z-index: 100000;
    }

    .setup-wizard.hidden {
      display: none;
    }

    .wizard-content {
      max-width: 500px;
      width: 100%;
    }

    .wizard-header {
      text-align: center;
      margin-bottom: 24px;
    }

    .wizard-logo {
      width: 64px;
      height: 64px;
      margin-bottom: 12px;
    }

    .wizard-header h2 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 8px 0;
      color: var(--vscode-foreground);
    }

    .wizard-subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      margin: 0;
    }

    /* Prerequisites Warning */
    .wizard-prereq {
      display: flex;
      gap: 12px;
      padding: 12px 16px;
      background: rgba(255, 165, 0, 0.1);
      border: 1px solid rgba(255, 165, 0, 0.3);
      border-radius: 8px;
      margin-bottom: 20px;
    }

    .wizard-prereq.hidden {
      display: none;
    }

    .prereq-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .prereq-content {
      flex: 1;
    }

    .prereq-content strong {
      display: block;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
    }

    .prereq-content p {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 8px 0;
    }

    .prereq-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 12px;
    }

    .prereq-link:hover {
      text-decoration: underline;
    }

    /* Provider Cards */
    .wizard-providers {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }

    .provider-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      transition: all 0.2s ease;
    }

    .provider-card:hover {
      border-color: var(--vscode-focusBorder);
    }

    .provider-card.ready {
      border-color: var(--vscode-charts-green, #22c55e);
    }

    .provider-card.error {
      border-color: var(--vscode-editorError-foreground, #f85149);
    }

    .provider-card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }

    .provider-logo {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      object-fit: contain;
    }

    .provider-logo.gemini-logo {
      width: 28px;
      height: 28px;
    }

    .provider-info {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .provider-info h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .provider-status {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      text-transform: uppercase;
      font-weight: 500;
    }

    .provider-status[data-status="unknown"] {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .provider-status[data-status="not-installed"] {
      background: rgba(255, 165, 0, 0.2);
      color: #f59e0b;
    }

    .provider-status[data-status="installing"],
    .provider-status[data-status="downloading"],
    .provider-status[data-status="verifying"] {
      background: rgba(59, 130, 246, 0.2);
      color: #3b82f6;
    }

    .provider-status[data-status="not-authenticated"],
    .provider-status[data-status="authenticating"] {
      background: rgba(234, 179, 8, 0.2);
      color: #eab308;
    }

    .provider-status[data-status="ready"],
    .provider-status[data-status="complete"] {
      background: rgba(34, 197, 94, 0.2);
      color: var(--vscode-charts-green, #22c55e);
    }

    .provider-status[data-status="error"],
    .provider-status[data-status="failed"] {
      background: rgba(248, 81, 73, 0.2);
      color: var(--vscode-editorError-foreground, #f85149);
    }

    .provider-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 12px 0;
    }

    .provider-steps {
      margin: 12px 0;
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 6px;
      font-size: 12px;
    }

    .provider-steps.hidden {
      display: none;
    }

    .provider-step {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 8px;
      color: var(--vscode-descriptionForeground);
    }

    .provider-step:last-child {
      margin-bottom: 0;
    }

    .step-number {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .step-number.completed {
      background: var(--vscode-charts-green, #22c55e);
    }

    /* Provider Progress */
    .provider-progress {
      margin: 12px 0;
    }

    .provider-progress.hidden {
      display: none;
    }

    .provider-progress .progress-track {
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 8px;
    }

    .provider-progress .progress-bar {
      height: 100%;
      background: var(--vscode-progressBar-background, #0078d4);
      transition: width 0.3s ease;
    }

    .provider-progress .progress-msg {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* Provider Actions */
    .provider-card-actions {
      display: flex;
      gap: 8px;
    }

    .provider-action-btn {
      flex: 1;
      padding: 8px 16px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s;
    }

    .provider-action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .provider-action-btn.primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .provider-action-btn.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border);
    }

    .provider-action-btn.secondary:hover:not(:disabled) {
      background: var(--vscode-list-hoverBackground);
    }

    .provider-action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .provider-action-btn.success {
      background: var(--vscode-charts-green, #22c55e);
      color: white;
    }

    /* Auth Options Modal */
    .auth-options-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100001;
    }

    .auth-options-modal.hidden {
      display: none;
    }

    .auth-options-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 20px;
      max-width: 400px;
      width: 90%;
    }

    .auth-options-content h3 {
      margin: 0 0 8px 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .auth-options-content > p {
      margin: 0 0 16px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .auth-options-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    .auth-option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .auth-option:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
    }

    .auth-option-icon {
      font-size: 20px;
      flex-shrink: 0;
    }

    .auth-option-content {
      flex: 1;
    }

    .auth-option-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--vscode-foreground);
      margin-bottom: 2px;
    }

    .auth-option-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .auth-options-cancel {
      width: 100%;
      padding: 8px;
      background: transparent;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 12px;
    }

    .auth-options-cancel:hover {
      background: var(--vscode-list-hoverBackground);
    }

    /* Install Provider Modal */
    .install-provider-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100002;
    }

    .install-provider-modal.hidden {
      display: none;
    }

    .install-provider-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      padding: 20px;
      max-width: 420px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    }

    .install-provider-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .install-provider-header img {
      width: 32px;
      height: 32px;
    }

    .install-provider-header h3 {
      margin: 0;
      font-size: 16px;
      color: var(--vscode-foreground);
    }

    #install-provider-desc {
      margin: 0 0 12px 0;
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }

    .install-section {
      margin: 16px 0;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-widget-border);
    }

    .install-section:first-of-type {
      border-top: none;
      margin-top: 0;
      padding-top: 0;
    }

    .install-section h4 {
      margin: 0 0 8px 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }

    .install-action-btn {
      width: 100%;
      padding: 10px 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .install-action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .install-action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .install-action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .install-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      margin-top: 6px;
    }

    .install-command-box {
      display: flex;
      align-items: center;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      padding: 8px 12px;
      gap: 8px;
    }

    .install-command-box code {
      flex: 1;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      word-break: break-all;
      color: var(--vscode-foreground);
    }

    .install-copy-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      opacity: 0.7;
      font-size: 14px;
    }

    .install-copy-btn:hover {
      opacity: 1;
    }

    .install-terminal-btn {
      background: var(--vscode-button-secondaryBackground);
      border: none;
      cursor: pointer;
      padding: 4px 8px;
      margin-left: 4px;
      border-radius: 4px;
      font-size: 14px;
      color: var(--vscode-button-secondaryForeground);
    }

    .install-terminal-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .install-refresh-btn {
      background: var(--vscode-button-secondaryBackground);
      border: none;
      cursor: pointer;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      color: var(--vscode-button-secondaryForeground);
    }

    .install-refresh-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .install-auth-list {
      margin: 0;
      padding-left: 20px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--vscode-foreground);
    }

    .install-auth-list li {
      margin-bottom: 4px;
    }

    .install-progress-bar {
      height: 4px;
      background: var(--vscode-progressBar-background);
      border-radius: 2px;
      overflow: hidden;
    }

    .install-progress-fill {
      height: 100%;
      background: var(--vscode-button-background);
      width: 0%;
      transition: width 0.3s ease;
    }

    .install-progress-msg {
      font-size: 12px;
      text-align: center;
      margin-top: 8px;
      color: var(--vscode-foreground);
    }

    .install-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-widget-border);
    }

    .install-docs-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 13px;
    }

    .install-docs-link:hover {
      text-decoration: underline;
    }

    .install-close-btn {
      padding: 6px 16px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .install-close-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }


    /* Wizard Footer */
    .wizard-footer {
      text-align: center;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .wizard-skip-btn {
      background: transparent;
      border: none;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 13px;
      padding: 8px 16px;
    }

    .wizard-skip-btn:hover {
      text-decoration: underline;
    }

    .wizard-footer-hint {
      margin: 8px 0 0 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
  `;
}

function getScript(mermaidUri: string, logoUri: string, iconUris: Record<string, string>, claudeLogoUri: string, openaiLogoLightUri: string, openaiLogoDarkUri: string, geminiLogoUri: string, copilotLogoUri: string, version: string): string {
  return `
    (function() {
      const vscode = acquireVsCodeApi();
      const MERMAID_URI = '${mermaidUri}';
      const LOGO_URI = '${logoUri}';
      const MYSTI_VERSION = '${version}';
      var ICON_URIS = ${JSON.stringify(iconUris)};
      var CLAUDE_LOGO = '${claudeLogoUri}';
      var OPENAI_LOGO_LIGHT = '${openaiLogoLightUri}';
      var OPENAI_LOGO_DARK = '${openaiLogoDarkUri}';
      var GEMINI_LOGO = '${geminiLogoUri}';
      var COPILOT_LOGO = '${copilotLogoUri}';
      var MYSTI_LOGO = '${logoUri}';

      // Theme detection for OpenAI logo
      function isDarkTheme() {
        return document.body.classList.contains('vscode-dark') ||
               document.body.classList.contains('vscode-high-contrast');
      }

      function getOpenAILogo() {
        return isDarkTheme() ? OPENAI_LOGO_DARK : OPENAI_LOGO_LIGHT;
      }

      var OPENAI_LOGO = getOpenAILogo();

      // Mermaid lazy loading
      var mermaidLoaded = false;
      var mermaidLoadPromise = null;

      function loadMermaid() {
        if (mermaidLoaded) return Promise.resolve();
        if (mermaidLoadPromise) return mermaidLoadPromise;

        mermaidLoadPromise = new Promise(function(resolve, reject) {
          var script = document.createElement('script');
          script.src = MERMAID_URI;
          script.onload = function() {
            mermaid.initialize({
              startOnLoad: false,
              theme: 'dark',
              securityLevel: 'strict'
            });
            mermaidLoaded = true;
            resolve();
          };
          script.onerror = reject;
          document.head.appendChild(script);
        });
        return mermaidLoadPromise;
      }

      function renderMermaidDiagrams() {
        var mermaidBlocks = document.querySelectorAll('.mermaid-pending');
        if (mermaidBlocks.length === 0) return;

        loadMermaid().then(function() {
          mermaidBlocks.forEach(function(block, index) {
            var code = block.textContent;
            var id = 'mermaid-' + Date.now() + '-' + index;
            try {
              mermaid.render(id, code).then(function(result) {
                block.innerHTML = result.svg;
                block.classList.remove('mermaid-pending');
                block.classList.add('mermaid-rendered');
              }).catch(function(e) {
                block.classList.add('mermaid-error');
                console.error('Mermaid render error:', e);
              });
            } catch (e) {
              block.classList.add('mermaid-error');
              console.error('Mermaid render error:', e);
            }
          });
        }).catch(function(e) {
          console.error('Failed to load Mermaid:', e);
        });
      }

      // Configure marked if available
      if (typeof marked !== 'undefined') {
        var renderer = new marked.Renderer();
        var originalCode = renderer.code.bind(renderer);

        renderer.code = function(code, lang, escaped) {
          if (typeof code === 'object') {
            lang = code.lang;
            escaped = code.escaped;
            code = code.text;
          }

          if (lang === 'mermaid') {
            return '<div class="mermaid-diagram mermaid-pending">' + escapeHtmlForMarked(code) + '</div>';
          }

          // Check for diff content - use professional diff component
          if (lang === 'diff' || lang === 'patch' || isDiffContentMarked(code)) {
            return formatDiffContentMarked(code);
          }

          // Return code block for Prism highlighting
          var langClass = lang ? 'language-' + lang : '';
          return '<pre><code class="' + langClass + '">' + escapeHtmlForMarked(code) + '</code></pre>';
        };

        marked.setOptions({
          gfm: true,
          breaks: true,
          renderer: renderer
        });
      }

      function escapeHtmlForMarked(text) {
        if (!text) return '';
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function isDiffContentMarked(content) {
        var lines = content.split('\\n');
        var diffMarkers = 0;
        var checkLines = Math.min(lines.length, 20);
        for (var i = 0; i < checkLines; i++) {
          var line = lines[i];
          // Exclude CSS custom properties (--var) from diff detection
          if (line.startsWith('+') || (line.startsWith('-') && !line.startsWith('--')) || line.startsWith('@@')) {
            diffMarkers++;
          }
        }
        return diffMarkers > checkLines * 0.2;
      }

      function formatDiffContentMarked(content) {
        var lines = content.split('\\n');
        var additions = 0;
        var deletions = 0;
        var fileName = '';
        var filePath = '';
        var diffLines = [];
        var lineNum = 1;
        var previewLimit = 10;
        var diffId = 'diff-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

        // Parse diff and collect data
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          // Extract file path from diff headers
          if (line.startsWith('+++ b/')) {
            filePath = line.substring(6);
          } else if (line.startsWith('+++ ') && !filePath) {
            filePath = line.substring(4);
          } else if (line.startsWith('diff --git')) {
            var gitMatch = line.match(/b\\/(.+)$/);
            if (gitMatch) filePath = gitMatch[1];
          }

          // Skip header lines for display
          if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
            continue;
          }

          // Parse hunk header for line numbers
          if (line.startsWith('@@')) {
            var hunkMatch = line.match(/@@ -\\d+(?:,\\d+)? \\+(\\d+)/);
            if (hunkMatch) lineNum = parseInt(hunkMatch[1], 10);
            continue;
          }

          var lineClass = 'file-edit-line';
          var lineNumDisplay = '';

          if (line.startsWith('+')) {
            lineClass += ' addition';
            additions++;
            lineNumDisplay = lineNum++;
          } else if (line.startsWith('-')) {
            lineClass += ' deletion';
            deletions++;
            lineNumDisplay = '';
          } else {
            lineClass += ' context';
            lineNumDisplay = lineNum++;
          }

          diffLines.push({
            cls: lineClass,
            num: lineNumDisplay,
            content: line.substring(1) || ' '
          });
        }

        // Extract filename from path
        if (!filePath) filePath = 'changes';
        var pathParts = filePath.split('/');
        fileName = pathParts.pop() || filePath;
        var dirPath = pathParts.length > 0 ? pathParts.join('/') + '/' : '';

        // Build preview (first 10 lines)
        var hasMore = diffLines.length > previewLimit;
        var previewLines = hasMore ? diffLines.slice(0, previewLimit) : diffLines;
        var remainingCount = diffLines.length - previewLimit;

        var previewHtml = '';
        for (var j = 0; j < previewLines.length; j++) {
          var dl = previewLines[j];
          previewHtml += '<div class="' + dl.cls + '">' +
            '<span class="file-edit-line-num">' + (dl.num !== '' ? dl.num : '') + '</span>' +
            '<span class="file-edit-line-content">' + escapeHtmlForMarked(dl.content) + '</span>' +
          '</div>';
        }

        // Encode full diff data for expansion
        var fullDiffData = encodeURIComponent(JSON.stringify(diffLines));

        // Chevron SVG
        var chevronSvg = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4 6l4 4 4-4"/></svg>';

        var html = '<div class="file-edit-card" id="' + diffId + '" data-file-path="' + escapeHtmlForMarked(filePath) + '" data-full-diff="' + fullDiffData + '">' +
          '<div class="file-edit-header">' +
            '<span class="file-edit-icon">📄</span>' +
            '<span class="file-edit-filename">' + escapeHtmlForMarked(fileName) + '</span>' +
            '<span class="file-edit-path">' + escapeHtmlForMarked(dirPath) + '</span>' +
            '<div class="file-edit-stats">' +
              (additions > 0 ? '<span class="file-edit-additions">+' + additions + '</span>' : '') +
              (deletions > 0 ? '<span class="file-edit-deletions">-' + deletions + '</span>' : '') +
            '</div>' +
            '<button class="file-edit-collapse-btn" title="Toggle">' + chevronSvg + '</button>' +
          '</div>' +
          '<div class="file-edit-diff">' +
            '<div class="file-edit-diff-content">' + previewHtml + '</div>' +
            (hasMore ? '<button class="file-edit-show-more">Show more... (' + remainingCount + ' lines)</button>' : '') +
          '</div>' +
          '<div class="file-edit-actions">' +
            '<button class="file-edit-btn file-edit-revert">Revert</button>' +
            '<button class="file-edit-btn file-edit-review">Review</button>' +
          '</div>' +
        '</div>';

        return html;
      }

      let state = {
        panelId: null,  // Unique ID for this panel
        workspacePath: '',  // Workspace root for relative path display
        settings: {
          mode: 'ask-before-edit',
          thinkingLevel: 'medium',
          accessLevel: 'ask-permission',
          contextMode: 'auto',
          model: 'claude-sonnet-4-5-20250929',
          provider: 'claude-code'
        },
        context: [],
        messages: [],
        isLoading: false,
        providers: [],
        slashCommands: [],
        quickActions: [],
        // Context usage tracking
        contextUsage: {
          usedTokens: 0,
          contextWindow: 200000,
          percentage: 0
        },
        // Brainstorm mode state
        activeAgent: 'claude-code',
        brainstormSession: null,
        brainstormPhase: null,
        agentResponses: {},
        // Autocomplete state
        autocompleteSuggestion: null,
        autocompleteType: null,
        // Permission state
        pendingPermissions: new Map(),
        focusedPermissionId: null,
        // Agent configuration state (per-conversation)
        agentConfig: {
          personaId: null,
          enabledSkills: []
        },
        availablePersonas: [],
        availableSkills: [],
        // Agent settings (configurable via settings panel)
        agentSettings: {
          autoSuggest: true,
          tokenLimitEnabled: false,
          maxTokenBudget: 0,
          showSuggestions: true
        },
        // Brainstorm agent selection (which 2 of 3 agents to use)
        brainstormAgents: ['claude-code', 'openai-codex'],
        // Provider availability for brainstorm section
        providerAvailability: {},
        // Setup state (legacy)
        setup: {
          isChecking: true,
          isReady: false,
          currentStep: 'checking',
          progress: 0,
          message: '',
          providerId: null,
          error: null,
          npmAvailable: true,
          providers: []
        },
        // Setup wizard state (enhanced onboarding)
        wizard: {
          visible: false,
          providers: [],
          npmAvailable: true,
          nodeVersion: null,
          anyReady: false,
          activeSetup: null,
          currentAuthProviderId: null
        }
      };

      // Agent display configuration for brainstorm UI
      var AGENT_DISPLAY = {
        'claude-code': { name: 'Claude', shortId: 'claude', color: '#8B5CF6', logo: CLAUDE_LOGO },
        'openai-codex': { name: 'Codex', shortId: 'codex', color: '#10B981', logo: null }, // Uses getOpenAILogo() for theme support
        'google-gemini': { name: 'Gemini', shortId: 'gemini', color: '#4285F4', logo: GEMINI_LOGO },
        'github-copilot': { name: 'Copilot', shortId: 'copilot', color: '#6366F1', logo: COPILOT_LOGO }
      };

      // Helper to get agent logo (handles OpenAI theme switching)
      function getAgentLogo(agentId) {
        if (agentId === 'openai-codex') {
          return getOpenAILogo();
        }
        return AGENT_DISPLAY[agentId] ? AGENT_DISPLAY[agentId].logo : '';
      }

      // Helper to get short ID for an agent
      function getAgentShortId(agentId) {
        return AGENT_DISPLAY[agentId] ? AGENT_DISPLAY[agentId].shortId : agentId;
      }

      // Helper to send messages with panelId
      function postMessageWithPanelId(msg) {
        msg.panelId = state.panelId;
        vscode.postMessage(msg);
      }

      // Helper to convert absolute paths to relative paths
      function makeRelativePath(absolutePath) {
        if (!absolutePath || !state.workspacePath) return absolutePath;
        // Normalize path separators
        var normalizedPath = absolutePath.replace(/\\\\/g, '/');
        var normalizedWorkspace = state.workspacePath.replace(/\\\\/g, '/');
        // Remove workspace prefix if present
        if (normalizedPath.startsWith(normalizedWorkspace)) {
          var relative = normalizedPath.substring(normalizedWorkspace.length);
          // Remove leading slash
          return relative.startsWith('/') ? relative.substring(1) : relative;
        }
        return absolutePath;
      }

      // Helper to replace absolute paths with relative paths in a string (for commands)
      function cleanPathsInString(str) {
        if (!str || !state.workspacePath) return str;
        var normalizedWorkspace = state.workspacePath.replace(/\\\\/g, '/');
        // Replace workspace path with ./ or just remove it
        return str.split(normalizedWorkspace + '/').join('')
                  .split(normalizedWorkspace).join('.');
      }

      // Autocomplete variables
      var autocompleteDebounceTimer = null;
      var tabHoldStart = 0;
      var tabHoldTimer = null;
      var currentCompletionLevel = 'sentence'; // Track current level during hold

      const messagesEl = document.getElementById('messages');
      const inputEl = document.getElementById('message-input');
      const autocompleteGhostEl = document.getElementById('autocomplete-ghost');
      const sendBtn = document.getElementById('send-btn');
      const stopBtn = document.getElementById('stop-btn');
      const settingsBtn = document.getElementById('settings-btn');
      const settingsPanel = document.getElementById('settings-panel');
      const aboutBtn = document.getElementById('about-btn');
      const aboutPanel = document.getElementById('about-panel');
      const newConversationBtn = document.getElementById('new-conversation-btn');
      const newTabBtn = document.getElementById('new-tab-btn');
      const modeSelect = document.getElementById('mode-select');
      const thinkingSelect = document.getElementById('thinking-select');
      const modelSelect = document.getElementById('model-select');
      const providerSelect = document.getElementById('provider-select');
      const accessSelect = document.getElementById('access-select');
      const contextModeBtn = document.getElementById('context-mode-btn');
      const contextModeLabel = document.getElementById('context-mode-label');
      const addContextBtn = document.getElementById('add-context-btn');
      const clearContextBtn = document.getElementById('clear-context-btn');
      const contextItems = document.getElementById('context-items');
      const slashCmdBtn = document.getElementById('slash-cmd-btn');
      const slashMenu = document.getElementById('slash-menu');
      const enhanceBtn = document.getElementById('enhance-btn');
      const modeIndicator = document.getElementById('mode-indicator');
      const sessionIndicator = document.getElementById('session-indicator');
      const agentSelectBtn = document.getElementById('agent-select-btn');
      const agentMenu = document.getElementById('agent-menu');
      const historyBtn = document.getElementById('history-btn');
      const historyMenu = document.getElementById('history-menu');

      // Welcome screen suggestions with auto-persona and skills configuration
      var WELCOME_SUGGESTIONS = [
  {
    "id": "understand",
    "title": "Understand Project",
    "description": "Analyze structure, patterns & conventions",
    "messages": [
      {
        "provider": "claude",
        "message": "/init"
      },
      {
        "provider": "codex",
        "message": "Analyze this codebase thoroughly. Map the directory structure, identify the tech stack and frameworks, understand the architecture patterns in use, locate entry points, and document key conventions. Summarize: project purpose, main components, data flow, dependencies, and any configuration patterns. Create a mental model I can reference for future tasks."
      }
    ],
    "icon": "magnifier",
    "color": "blue",
    "suggestedPersona": "architect",
    "suggestedSkills": ["organized", "repo-hygiene", "first-principles", "doc-reflexes"]
  },
  {
    "id": "review",
    "title": "Code Review",
    "description": "Find bugs, anti-patterns & improvements",
    "messages": [
      {
        "provider": "claude",
        "message": "Perform a comprehensive code review. Identify bugs, logic errors, anti-patterns, code smells, and potential edge cases. Suggest specific improvements for readability, maintainability, and adherence to best practices. Prioritize findings by severity and provide actionable fixes."
      },
      {
        "provider": "codex",
        "message": "Perform a comprehensive code review. Identify bugs, logic errors, anti-patterns, code smells, and potential edge cases. Suggest specific improvements for readability, maintainability, and adherence to best practices. Prioritize findings by severity (critical/high/medium/low) and provide actionable fixes with code examples."
      }
    ],
    "icon": "eye",
    "color": "purple",
    "suggestedPersona": "refactorer",
    "suggestedSkills": ["scope-discipline", "doc-reflexes", "first-principles", "test-driven", "organized"]
  },
  {
    "id": "cleanup",
    "title": "Clean Up",
    "description": "Remove dead code, reorganize files & enforce hygiene",
    "messages": [
      {
        "provider": "claude",
        "message": "Deep clean this codebase. Find and remove: dead code, unused imports, orphaned files, redundant dependencies, commented-out code blocks, and empty or placeholder files. Reorganize file structure for clarity—group related modules, enforce consistent naming conventions, and suggest files to merge, split, or relocate. Clean up package.json/requirements.txt of unused dependencies. Provide a summary of all removals and reorganizations."
      },
      {
        "provider": "codex",
        "message": "Deep clean this codebase. Find and remove: dead code, unused imports, orphaned files, redundant dependencies, commented-out code blocks, and empty or placeholder files. Reorganize file structure for clarity—group related modules, enforce consistent naming conventions, and identify files to merge, split, or relocate. Clean up package.json/requirements.txt of unused dependencies. Execute the cleanup and provide a summary of all changes made."
      }
    ],
    "icon": "brush",
    "color": "green",
    "suggestedPersona": "refactorer",
    "suggestedSkills": ["repo-hygiene", "organized", "scope-discipline", "auto-commit"]
  },
  {
    "id": "tests",
    "title": "Write Tests",
    "description": "Add comprehensive test coverage",
    "messages": [
      {
        "provider": "claude",
        "message": "Analyze test coverage gaps and write tests. Identify critical untested paths, edge cases, and error conditions. Create unit tests for individual functions, integration tests for component interactions, and suggest e2e test scenarios. Follow existing test patterns and conventions. Prioritize tests by risk—focus on business-critical logic, data transformations, and error handling first."
      },
      {
        "provider": "codex",
        "message": "Analyze test coverage gaps and write tests. Identify critical untested paths, edge cases, and error conditions. Create unit tests for individual functions, integration tests for component interactions. Follow existing test patterns and conventions in this repo. Prioritize tests by risk—focus on business-critical logic, data transformations, and error handling first. Write and save the test files."
      }
    ],
    "icon": "lab",
    "color": "teal",
    "suggestedPersona": "debugger",
    "suggestedSkills": ["test-driven", "scope-discipline", "organized", "first-principles"]
  },
  {
    "id": "security",
    "title": "Security Audit",
    "description": "Find vulnerabilities, secrets & attack vectors",
    "messages": [
      {
        "provider": "claude",
        "message": "Perform a thorough security audit. Check for: exposed secrets, API keys, and credentials in code or config files; injection vulnerabilities (SQL, XSS, command injection); insecure dependencies with known CVEs; authentication and authorization flaws; OWASP Top 10 issues; insecure data handling and storage; missing input validation and sanitization; improper error messages that leak information. Prioritize findings by severity (critical/high/medium/low) with specific remediation steps."
      },
      {
        "provider": "codex",
        "message": "Perform a thorough security audit. Check for: exposed secrets, API keys, and credentials in code or config files; injection vulnerabilities (SQL, XSS, command injection); insecure dependencies with known CVEs; authentication and authorization flaws; OWASP Top 10 issues; insecure data handling and storage; missing input validation and sanitization; improper error messages that leak information. Prioritize findings by severity (critical/high/medium/low) with specific remediation steps. Fix critical issues immediately."
      }
    ],
    "icon": "lock",
    "color": "red",
    "suggestedPersona": "security",
    "suggestedSkills": ["first-principles", "scope-discipline", "doc-reflexes", "organized", "dependency-aware"]
  },
  {
    "id": "performance",
    "title": "Performance",
    "description": "Identify bottlenecks & optimize resources",
    "messages": [
      {
        "provider": "claude",
        "message": "Analyze performance and identify optimization opportunities. Look for: N+1 queries and database inefficiencies; unnecessary re-renders or computations; missing caching opportunities; memory leaks and resource cleanup issues; blocking operations that should be async; large bundle sizes and lazy-loading candidates; inefficient algorithms and data structures; slow regex or string operations. Provide specific fixes with expected impact and any trade-offs."
      },
      {
        "provider": "codex",
        "message": "Analyze performance and identify optimization opportunities. Look for: N+1 queries and database inefficiencies; unnecessary re-renders or computations; missing caching opportunities; memory leaks and resource cleanup issues; blocking operations that should be async; large bundle sizes and lazy-loading candidates; inefficient algorithms and data structures; slow regex or string operations. Implement fixes and document expected impact and any trade-offs for each change."
      }
    ],
    "icon": "flash",
    "color": "amber",
    "suggestedPersona": "performance",
    "suggestedSkills": ["first-principles", "test-driven", "scope-discipline", "organized"]
  },
  {
    "id": "docs",
    "title": "Documentation",
    "description": "Add docs, comments & usage examples",
    "messages": [
      {
        "provider": "claude",
        "message": "Improve project documentation comprehensively. Add or update: JSDoc/docstrings for all public APIs with parameter types and return values; inline comments explaining complex or non-obvious logic; README with setup instructions, usage examples, and architecture overview; API documentation with request/response examples; environment variable documentation; contribution guidelines if missing. Focus on explaining 'why' not just 'what'."
      },
      {
        "provider": "codex",
        "message": "Improve project documentation comprehensively. Add or update: JSDoc/docstrings for all public APIs with parameter types and return values; inline comments explaining complex or non-obvious logic; README with setup instructions, usage examples, and architecture overview; API documentation with request/response examples; environment variable documentation; contribution guidelines if missing. Focus on explaining 'why' not just 'what'. Write all documentation files."
      }
    ],
    "icon": "notes",
    "color": "indigo",
    "suggestedPersona": "mentor",
    "suggestedSkills": ["doc-reflexes", "organized", "concise", "first-principles"]
  },
  {
    "id": "refactor",
    "title": "Refactor",
    "description": "Improve architecture & eliminate code smells",
    "messages": [
      {
        "provider": "claude",
        "message": "Identify refactoring opportunities to improve code quality. Find: code duplication that should be abstracted; overly complex functions that need decomposition; tight coupling that reduces testability; violated SOLID principles; mixed concerns that should be separated; inconsistent patterns across the codebase; magic numbers and hardcoded values; poor naming that obscures intent. Propose specific refactoring strategies with before/after examples. Prioritize by impact and risk."
      },
      {
        "provider": "codex",
        "message": "Identify and execute refactoring to improve code quality. Find and fix: code duplication that should be abstracted; overly complex functions that need decomposition; tight coupling that reduces testability; violated SOLID principles; mixed concerns that should be separated; inconsistent patterns across the codebase; magic numbers and hardcoded values; poor naming that obscures intent. Implement refactoring changes incrementally, committing after each logical improvement. Prioritize by impact and risk."
      }
    ],
    "icon": "recycle",
    "color": "orange",
    "suggestedPersona": "refactorer",
    "suggestedSkills": ["first-principles", "scope-discipline", "test-driven", "organized", "repo-hygiene"]
  },
  {
    "id": "production",
    "title": "Production Ready",
    "description": "Harden for reliability & operability",
    "messages": [
      {
        "provider": "claude",
        "message": "Audit production readiness and harden the codebase. Check and improve: error handling—ensure all errors are caught, logged, and handled gracefully; logging—add structured logging for debugging and monitoring; environment configuration—separate configs for dev/staging/prod with proper secret management; health checks and readiness probes; graceful shutdown handling; rate limiting and request validation; retry logic with exponential backoff for external calls; database connection pooling and timeout handling; feature flags for safe rollouts. Create a checklist of items to address before deployment."
      },
      {
        "provider": "codex",
        "message": "Audit production readiness and harden the codebase. Check and improve: error handling—ensure all errors are caught, logged, and handled gracefully; logging—add structured logging for debugging and monitoring; environment configuration—separate configs for dev/staging/prod with proper secret management; health checks and readiness probes; graceful shutdown handling; rate limiting and request validation; retry logic with exponential backoff for external calls; database connection pooling and timeout handling. Implement missing production hardening. Create a PRODUCTION_CHECKLIST.md with status of each item."
      }
    ],
    "icon": "rocket",
    "color": "green",
    "suggestedPersona": "devops",
    "suggestedSkills": ["graceful-degradation", "rollback-ready", "test-driven", "doc-reflexes", "dependency-aware"]
  },
  {
    "id": "deploy",
    "title": "Prep Deployment",
    "description": "Set up CI/CD, containers & infrastructure",
    "messages": [
      {
        "provider": "claude",
        "message": "Prepare deployment infrastructure and automation. Set up or improve: CI/CD pipeline with build, test, lint, and deploy stages; Dockerfile with multi-stage builds, minimal base images, and security best practices; docker-compose for local development parity; environment-specific configuration management; automated testing gates before deployment; deployment scripts with rollback capability; infrastructure as code if applicable; secrets management integration; build caching for faster pipelines. Document the deployment process."
      },
      {
        "provider": "codex",
        "message": "Prepare deployment infrastructure and automation. Create or improve: CI/CD pipeline with build, test, lint, and deploy stages; Dockerfile with multi-stage builds, minimal base images, and security best practices; docker-compose for local development parity; environment-specific configuration management; automated testing gates before deployment; deployment scripts with rollback capability; build caching for faster pipelines. Write all configuration files and create a DEPLOYMENT.md with the complete deployment process."
      }
    ],
    "icon": "package",
    "color": "purple",
    "suggestedPersona": "devops",
    "suggestedSkills": ["auto-commit", "rollback-ready", "organized", "doc-reflexes", "dependency-aware"]
  },
  {
    "id": "compliance",
    "title": "Compliance",
    "description": "Audit licenses, accessibility & regulations",
    "messages": [
      {
        "provider": "claude",
        "message": "Perform a compliance audit across multiple dimensions. Check: dependency licenses for compatibility and legal requirements (GPL, MIT, Apache, etc.); license file presence and accuracy; accessibility compliance (WCAG 2.1 for web apps); data privacy requirements (GDPR, CCPA handling); audit logging for regulated industries; required security headers and policies; third-party data sharing and tracking disclosures; terms of service requirements for external APIs. Generate a compliance report with findings and required actions."
      },
      {
        "provider": "codex",
        "message": "Perform a compliance audit across multiple dimensions. Check: dependency licenses for compatibility and legal requirements (GPL, MIT, Apache, etc.); license file presence and accuracy; accessibility compliance (WCAG 2.1 for web apps); data privacy requirements (GDPR, CCPA handling); audit logging for regulated industries; required security headers and policies; third-party data sharing and tracking disclosures; terms of service requirements for external APIs. Generate a COMPLIANCE_REPORT.md with findings, severity, and required remediation actions."
      }
    ],
    "icon": "check",
    "color": "blue",
    "suggestedPersona": "security",
    "suggestedSkills": ["doc-reflexes", "scope-discipline", "organized", "first-principles", "dependency-aware"]
  },
  {
    "id": "debug",
    "title": "Debug Issue",
    "description": "Diagnose root cause & trace execution",
    "messages": [
      {
        "provider": "claude",
        "message": "Help me systematically debug an issue. I will describe the problem—expected vs actual behavior, error messages, and steps to reproduce. Then help me: trace the execution path to isolate the failure point; identify potential root causes from most to least likely; suggest diagnostic steps (logging, breakpoints, test cases) to confirm the cause; propose fixes with explanation of why they address the root cause, not just symptoms; recommend preventive measures to avoid similar issues."
      },
      {
        "provider": "codex",
        "message": "Help me systematically debug an issue. I will describe the problem—expected vs actual behavior, error messages, and steps to reproduce. Then: trace the execution path to isolate the failure point; identify potential root causes from most to least likely; add diagnostic logging if needed to confirm the cause; implement the fix that addresses the root cause, not just symptoms; add a regression test to prevent recurrence; commit with a detailed explanation of the bug and fix."
      }
    ],
    "icon": "bug",
    "color": "red",
    "suggestedPersona": "debugger",
    "suggestedSkills": ["first-principles", "test-driven", "scope-discipline", "organized", "concise"]
  }
];

      // Helper to get provider-specific message from suggestion
      function getProviderMessage(suggestion, currentProvider) {
        // New format: messages array with provider-specific entries
        if (suggestion.messages && Array.isArray(suggestion.messages)) {
          var found = suggestion.messages.find(function(m) {
            return m.provider === currentProvider ||
                   (currentProvider === 'claude-code' && m.provider === 'claude') ||
                   (currentProvider === 'openai-codex' && m.provider === 'codex');
          });
          if (found) return found.message;
          // Fallback to first message if provider not found
          return suggestion.messages[0] ? suggestion.messages[0].message : '';
        }
        // Backward compatibility: single message field
        return suggestion.message || '';
      }

      function renderWelcomeSuggestions() {
        var container = document.getElementById('welcome-suggestions');
        if (!container) return;
        container.innerHTML = '';

        WELCOME_SUGGESTIONS.forEach(function(s) {
          var card = document.createElement('button');
          card.className = 'welcome-card';
          card.setAttribute('data-color', s.color);

          // Get provider-specific message for tooltip
          var providerMsg = getProviderMessage(s, state.settings.provider);
          card.title = providerMsg;

          card.innerHTML =
            '<div class="welcome-card-icon"><img src="' + ICON_URIS[s.icon] + '" alt="" /></div>' +
            '<div class="welcome-card-title">' + escapeHtml(s.title) + '</div>' +
            '<div class="welcome-card-desc">' + escapeHtml(s.description) + '</div>';

          card.onclick = function() {
            // Get provider-specific message at click time (provider may have changed)
            var message = getProviderMessage(s, state.settings.provider);
            // Send with suggested persona and skills for auto-configuration
            postMessageWithPanelId({
              type: 'quickActionWithConfig',
              payload: {
                content: message,
                context: state.context,
                settings: state.settings,
                suggestedPersona: s.suggestedPersona || null,
                suggestedSkills: s.suggestedSkills || []
              }
            });
          };

          container.appendChild(card);
        });
      }

      // Render welcome suggestions on load
      renderWelcomeSuggestions();

      // Debug logging
      console.log('[Mysti Webview] Setting up event listeners...');
      console.log('[Mysti Webview] sendBtn:', sendBtn);
      console.log('[Mysti Webview] inputEl:', inputEl);

      if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
      } else {
        console.error('[Mysti Webview] sendBtn not found!');
      }
      if (stopBtn) {
        stopBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'cancelRequest' });
        });
      }
      if (inputEl) {
        inputEl.addEventListener('keydown', function(e) {
        // Tab key handling for autocomplete (hold-duration based)
        if (e.key === 'Tab' && state.autocompleteSuggestion) {
          e.preventDefault();

          // Only start hold tracking on first keydown (not repeat)
          if (!tabHoldStart) {
            tabHoldStart = Date.now();
            currentCompletionLevel = 'sentence';

            // Accept sentence completion immediately
            acceptAutocomplete();

            // Set up progressive completion while holding
            tabHoldTimer = setInterval(function() {
              var holdDuration = Date.now() - tabHoldStart;

              if (holdDuration > 600 && currentCompletionLevel !== 'message') {
                // After 600ms, upgrade to message completion
                currentCompletionLevel = 'message';
                postMessageWithPanelId({
                  type: 'requestAutocomplete',
                  payload: { text: inputEl.value, type: 'message' }
                });
                // Stop checking after message level
                if (tabHoldTimer) {
                  clearInterval(tabHoldTimer);
                  tabHoldTimer = null;
                }
              } else if (holdDuration > 300 && currentCompletionLevel === 'sentence') {
                // After 300ms, upgrade to paragraph completion
                currentCompletionLevel = 'paragraph';
                postMessageWithPanelId({
                  type: 'requestAutocomplete',
                  payload: { text: inputEl.value, type: 'paragraph' }
                });
              }
            }, 50); // Check every 50ms for responsive feel
          }
          return;
        }

        // Escape to dismiss autocomplete
        if (e.key === 'Escape' && state.autocompleteSuggestion) {
          clearAutocomplete();
          return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          clearAutocomplete();
          sendMessage();
        }
        if (e.key === '/' && inputEl.value === '') {
          e.preventDefault();
          showSlashMenu();
        }
        });

        // Tab key release handler
        inputEl.addEventListener('keyup', function(e) {
          if (e.key === 'Tab') {
            tabHoldStart = 0;
            if (tabHoldTimer) {
              clearInterval(tabHoldTimer);
              tabHoldTimer = null;
            }
            currentCompletionLevel = 'sentence';
          }
        });

        inputEl.addEventListener('input', function() {
        autoResizeTextarea();
        if (!inputEl.value.startsWith('/')) {
          hideSlashMenu();
        }

        // Clear current autocomplete when typing
        clearAutocomplete();

        // Debounce autocomplete request (300ms)
        if (autocompleteDebounceTimer) {
          clearTimeout(autocompleteDebounceTimer);
        }
        autocompleteDebounceTimer = setTimeout(function() {
          var text = inputEl.value.trim();
          if (text && text.length > 3 && !text.startsWith('/') && !state.isLoading) {
            // Request precompute for instant response when Tab is held
            postMessageWithPanelId({
              type: 'requestAutocomplete',
              payload: { text: inputEl.value, type: 'sentence', precompute: true }
            });
          }
        }, 300);

        // Debounce recommendation request (500ms) - only if auto-suggest enabled
        if (window.recommendationDebounceTimer) {
          clearTimeout(window.recommendationDebounceTimer);
        }
        if (state.agentSettings && state.agentSettings.autoSuggest) {
          window.recommendationDebounceTimer = setTimeout(function() {
            var text = inputEl.value.trim();
            if (text && text.length > 10 && !text.startsWith('/')) {
              postMessageWithPanelId({
                type: 'getAgentRecommendations',
                payload: { query: text }
              });
            }
          }, 500);
        }
        });
      } else {
        console.error('[Mysti Webview] inputEl not found!');
      }

      // Global keydown handler for permission cards
      document.addEventListener('keydown', function(e) {
        // Only handle when a permission card is focused
        var focusedCard = document.activeElement;
        if (focusedCard && focusedCard.classList.contains('permission-card')) {
          if (handlePermissionKeyboard(e)) {
            return;
          }
        }
      });

      settingsBtn.addEventListener('click', function() {
        settingsPanel.classList.toggle('hidden');
        // Close other panels when settings opens
        var agentConfigPanel = document.getElementById('agent-config-panel');
        if (agentConfigPanel && !settingsPanel.classList.contains('hidden')) {
          agentConfigPanel.classList.add('hidden');
        }
        if (aboutPanel && !settingsPanel.classList.contains('hidden')) {
          aboutPanel.classList.add('hidden');
        }
      });

      // About panel toggle
      if (aboutBtn && aboutPanel) {
        aboutBtn.addEventListener('click', function() {
          aboutPanel.classList.toggle('hidden');
          // Close other panels when about opens
          if (!aboutPanel.classList.contains('hidden')) {
            settingsPanel.classList.add('hidden');
            var agentConfigPanel = document.getElementById('agent-config-panel');
            if (agentConfigPanel) {
              agentConfigPanel.classList.add('hidden');
            }
          }
        });
      }

      // Agent config panel toggle
      var agentConfigBtn = document.getElementById('agent-config-btn');
      var agentConfigPanel = document.getElementById('agent-config-panel');
      var configResetBtn = document.getElementById('config-reset-btn');

      if (agentConfigBtn && agentConfigPanel) {
        agentConfigBtn.addEventListener('click', function() {
          agentConfigPanel.classList.toggle('hidden');
          // Close other panels when config opens
          if (!agentConfigPanel.classList.contains('hidden')) {
            settingsPanel.classList.add('hidden');
            if (aboutPanel) {
              aboutPanel.classList.add('hidden');
            }
          }
        });
      }

      // Reset agent config
      if (configResetBtn) {
        configResetBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          state.agentConfig = { personaId: null, enabledSkills: [] };
          renderAgentConfigPanel();
          saveAgentConfig();
        });
      }

      // Map persona ID to icon key for ICON_URIS
      function getPersonaIconKey(personaId) {
        var mapping = {
          'architect': 'architecture',
          'prototyper': 'rocket',
          'product-centric': 'package',
          'refactorer': 'recycle',
          'devops': 'gear',
          'domain-expert': 'target',
          'researcher': 'microscope',
          'builder': 'hammer',
          'debugger': 'bug',
          'integrator': 'chain',
          'mentor': 'teacher',
          'designer': 'paint',
          'fullstack': 'globe',
          'security': 'lock',
          'performance': 'flash',
          'toolsmith': 'tools'
        };
        return mapping[personaId] || personaId;
      }

      // Render agent config panel
      function renderAgentConfigPanel() {
        var personaGrid = document.getElementById('persona-grid');
        var skillsList = document.getElementById('skills-list');

        if (!personaGrid || !skillsList) return;

        // Render personas
        personaGrid.innerHTML = '';
        state.availablePersonas.forEach(function(p) {
          var card = document.createElement('div');
          card.className = 'persona-card' + (state.agentConfig.personaId === p.id ? ' selected' : '');
          card.dataset.persona = p.id;
          card.title = p.description;
          card.innerHTML =
            '<span class="persona-card-icon"><img src="' + ICON_URIS[getPersonaIconKey(p.id)] + '" alt="" /></span>' +
            '<span class="persona-card-name">' + escapeHtml(p.name) + '</span>';

          card.onclick = function() {
            togglePersona(p.id);
          };

          personaGrid.appendChild(card);
        });

        // Render skills
        skillsList.innerHTML = '';
        state.availableSkills.forEach(function(s) {
          var isActive = state.agentConfig.enabledSkills.indexOf(s.id) !== -1;
          var item = document.createElement('div');
          item.className = 'skill-item' + (isActive ? ' active' : '');
          item.dataset.skill = s.id;
          item.title = s.description;
          item.innerHTML =
            '<div class="skill-toggle"></div>' +
            '<span class="skill-name">' + escapeHtml(s.name) + '</span>';

          item.onclick = function() {
            toggleSkill(s.id);
          };

          skillsList.appendChild(item);
        });

        updateConfigSummary();
      }

      // Render agent recommendations from auto-suggest (compact inline widget)
      function renderRecommendations(payload) {
        var widget = document.getElementById('inline-suggestions');
        var chipsContainer = document.getElementById('inline-suggestions-chips');
        var autoSuggestCheck = document.getElementById('inline-auto-suggest-check');

        if (!widget || !chipsContainer) return;

        // Hide if no recommendations
        if (!payload.recommendations || payload.recommendations.length === 0) {
          widget.classList.add('hidden');
          return;
        }

        // Sync auto-suggest checkbox with current state
        if (autoSuggestCheck) {
          autoSuggestCheck.checked = state.agentSettings && state.agentSettings.autoSuggest;
        }

        // Build compact recommendation chips (show type instead of reason for compactness)
        var chipsHtml = payload.recommendations.map(function(rec) {
          var confidenceClass = rec.confidence + '-confidence';
          var typeLabel = rec.type === 'persona' ? 'persona' : 'skill';
          return '<div class="recommendation-chip ' + confidenceClass + '" ' +
                 'data-agent-id="' + rec.agent.id + '" ' +
                 'data-agent-type="' + rec.type + '" ' +
                 'title="' + escapeHtml(rec.reason) + '">' +
                 '<span class="chip-name">' + escapeHtml(rec.agent.name) + '</span>' +
                 '<span class="chip-type">' + typeLabel + '</span>' +
                 '</div>';
        }).join('');

        chipsContainer.innerHTML = chipsHtml;
        widget.classList.remove('hidden');

        // Add click handlers to chips
        chipsContainer.querySelectorAll('.recommendation-chip').forEach(function(chip) {
          chip.addEventListener('click', function() {
            var agentId = chip.dataset.agentId;
            var agentType = chip.dataset.agentType;

            if (agentType === 'persona') {
              selectPersona(agentId);
            } else if (agentType === 'skill') {
              toggleSkill(agentId);
            }

            // Mark as selected
            chip.classList.add('selected');

            // Hide widget after selection
            setTimeout(function() {
              widget.classList.add('hidden');
            }, 200);
          });
        });
      }

      // Inline suggestions widget handlers
      (function() {
        var dismissBtn = document.getElementById('inline-suggestions-dismiss');
        var autoSuggestCheck = document.getElementById('inline-auto-suggest-check');
        var widget = document.getElementById('inline-suggestions');

        if (dismissBtn) {
          dismissBtn.addEventListener('click', function() {
            if (widget) widget.classList.add('hidden');
          });
        }

        if (autoSuggestCheck) {
          autoSuggestCheck.addEventListener('change', function() {
            var isEnabled = autoSuggestCheck.checked;
            state.agentSettings = state.agentSettings || {};
            state.agentSettings.autoSuggest = isEnabled;

            // Update settings panel toggle if visible
            var settingsToggle = document.getElementById('auto-suggest-toggle');
            if (settingsToggle) {
              settingsToggle.classList.toggle('active', isEnabled);
            }

            // Send to extension
            postMessageWithPanelId({
              type: 'updateSettings',
              payload: { 'agents.autoSuggest': isEnabled }
            });

            // Hide widget if auto-suggest is disabled
            if (!isEnabled && widget) {
              widget.classList.add('hidden');
            }
          });
        }
      })();

      // Toolbar persona button click handler
      (function() {
        var personaBtn = document.getElementById('toolbar-persona-btn');
        if (personaBtn) {
          personaBtn.addEventListener('click', function(e) {
            // Don't open suggestions if clicking the clear button
            if (e.target.closest('.toolbar-persona-clear')) return;

            var widget = document.getElementById('inline-suggestions');
            var inputEl = document.getElementById('message-input');

            if (!widget) return;

            if (widget.classList.contains('hidden')) {
              // Request recommendations based on current input
              var query = inputEl ? inputEl.value.trim() : '';
              if (query.length > 3) {
                postMessageWithPanelId({
                  type: 'getAgentRecommendations',
                  payload: { query: query }
                });
              } else {
                // Show all personas if no meaningful input
                showAllPersonaSuggestions();
              }
            } else {
              widget.classList.add('hidden');
            }
          });
        }
      })();

      // Toolbar persona clear button click handler
      (function() {
        var clearBtn = document.getElementById('toolbar-persona-clear');
        if (clearBtn) {
          clearBtn.addEventListener('click', function(e) {
            e.stopPropagation(); // Prevent triggering parent button click

            // Clear persona selection
            state.agentConfig.personaId = null;

            // Update UI
            document.querySelectorAll('.persona-card').forEach(function(card) {
              card.classList.remove('selected');
            });

            // Hide inline suggestions if visible
            var widget = document.getElementById('inline-suggestions');
            if (widget) widget.classList.add('hidden');

            updateConfigSummary();
            updateToolbarPersonaIndicator();
            saveAgentConfig();
          });
        }
      })();

      function togglePersona(personaId) {
        if (state.agentConfig.personaId === personaId) {
          // Deselect if clicking same persona
          state.agentConfig.personaId = null;
        } else {
          state.agentConfig.personaId = personaId;
        }

        // Update UI
        document.querySelectorAll('.persona-card').forEach(function(card) {
          card.classList.toggle('selected', card.dataset.persona === state.agentConfig.personaId);
        });

        updateConfigSummary();
        updateToolbarPersonaIndicator();
        saveAgentConfig();
      }

      // Select persona (always sets, never toggles) - used by inline suggestions
      function selectPersona(personaId) {
        state.agentConfig.personaId = personaId;

        // Update persona cards UI
        document.querySelectorAll('.persona-card').forEach(function(card) {
          card.classList.toggle('selected', card.dataset.persona === personaId);
        });

        updateConfigSummary();
        updateToolbarPersonaIndicator();
        saveAgentConfig();
      }

      function toggleSkill(skillId) {
        var index = state.agentConfig.enabledSkills.indexOf(skillId);
        if (index === -1) {
          state.agentConfig.enabledSkills.push(skillId);
        } else {
          state.agentConfig.enabledSkills.splice(index, 1);
        }

        // Update UI
        document.querySelectorAll('.skill-item').forEach(function(item) {
          var isActive = state.agentConfig.enabledSkills.indexOf(item.dataset.skill) !== -1;
          item.classList.toggle('active', isActive);
        });

        updateConfigSummary();
        saveAgentConfig();
      }

      function updateConfigSummary() {
        var summaryText = document.getElementById('config-summary-text');
        var configBtn = document.getElementById('agent-config-btn');

        if (!summaryText) return;

        var parts = [];

        if (state.agentConfig.personaId) {
          var persona = state.availablePersonas.find(function(p) { return p.id === state.agentConfig.personaId; });
          if (persona) parts.push(persona.name);
        }

        if (state.agentConfig.enabledSkills.length > 0) {
          parts.push(state.agentConfig.enabledSkills.length + ' skill' +
                     (state.agentConfig.enabledSkills.length > 1 ? 's' : ''));
        }

        if (parts.length === 0) {
          summaryText.textContent = 'Default (no customization)';
          if (configBtn) configBtn.classList.remove('has-config');
        } else {
          summaryText.textContent = parts.join(' + ');
          if (configBtn) configBtn.classList.add('has-config');
        }

        // Also update toolbar persona indicator
        updateToolbarPersonaIndicator();
      }

      // Update toolbar persona indicator button
      function updateToolbarPersonaIndicator() {
        var nameEl = document.getElementById('toolbar-persona-name');
        var btn = document.getElementById('toolbar-persona-btn');
        var clearBtn = document.getElementById('toolbar-persona-clear');
        if (!nameEl || !btn) return;

        if (state.agentConfig.personaId) {
          var persona = state.availablePersonas.find(function(p) {
            return p.id === state.agentConfig.personaId;
          });
          nameEl.textContent = persona ? persona.name : 'Unknown';
          btn.classList.add('has-persona');
          btn.title = 'Active: ' + (persona ? persona.name : 'Unknown') + ' (click to change)';
          if (clearBtn) clearBtn.classList.remove('hidden');
        } else {
          nameEl.textContent = 'No persona';
          btn.classList.remove('has-persona');
          btn.title = 'Click to select a persona';
          if (clearBtn) clearBtn.classList.add('hidden');
        }
      }

      // Show all personas in inline suggestions (when no context query)
      function showAllPersonaSuggestions() {
        var widget = document.getElementById('inline-suggestions');
        var chipsContainer = document.getElementById('inline-suggestions-chips');
        var autoSuggestCheck = document.getElementById('inline-auto-suggest-check');
        if (!widget || !chipsContainer) return;

        // Sync checkbox state
        if (autoSuggestCheck) {
          autoSuggestCheck.checked = state.agentSettings && state.agentSettings.autoSuggest;
        }

        var chipsHtml = state.availablePersonas.map(function(p) {
          var isSelected = state.agentConfig.personaId === p.id;
          return '<div class="recommendation-chip' + (isSelected ? ' selected' : '') + '" ' +
                 'data-agent-id="' + p.id + '" data-agent-type="persona" ' +
                 'title="' + escapeHtml(p.description || '') + '">' +
                 '<span class="chip-name">' + escapeHtml(p.name) + '</span>' +
                 '</div>';
        }).join('');

        chipsContainer.innerHTML = chipsHtml;
        widget.classList.remove('hidden');

        // Add click handlers
        chipsContainer.querySelectorAll('.recommendation-chip').forEach(function(chip) {
          chip.addEventListener('click', function() {
            selectPersona(chip.dataset.agentId);
            widget.classList.add('hidden');
          });
        });
      }

      function saveAgentConfig() {
        // Send to extension for per-conversation persistence
        postMessageWithPanelId({
          type: 'updateAgentConfig',
          payload: state.agentConfig
        });
      }

      newConversationBtn.addEventListener('click', function() {
        postMessageWithPanelId({ type: 'newConversation' });
      });

      newTabBtn.addEventListener('click', function() {
        postMessageWithPanelId({ type: 'openInNewTab' });
      });

      // History menu toggle
      if (historyBtn && historyMenu) {
        historyBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          historyMenu.classList.toggle('hidden');
          if (!historyMenu.classList.contains('hidden')) {
            postMessageWithPanelId({ type: 'getConversationHistory' });
          }
        });
      }

      // Close history menu on outside click
      document.addEventListener('click', function(e) {
        if (historyMenu && !historyMenu.contains(e.target) && e.target !== historyBtn) {
          historyMenu.classList.add('hidden');
        }
      });

      // CAPTURE PHASE handler for Install buttons - runs before bubbling
      // This ensures clicks work even on buttons inside disabled items
      document.addEventListener('click', function(e) {
        var installBtn = e.target.closest('.agent-install-btn');
        if (installBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          var agentId = installBtn.dataset.agent;
          console.log('[Mysti Webview] CAPTURE: Install button clicked for:', agentId);
          if (agentId) {
            try {
              console.log('[Mysti Webview] Calling showInstallProviderModal...');
              showInstallProviderModal(agentId);
              console.log('[Mysti Webview] showInstallProviderModal called successfully');
            } catch (err) {
              console.error('[Mysti Webview] ERROR in showInstallProviderModal:', err);
            }
          } else {
            console.log('[Mysti Webview] No agentId found on button');
          }
        }
      }, true); // true = capture phase

      // Render history menu items
      function renderHistoryMenu(conversations, currentId) {
        if (!historyMenu) return;
        historyMenu.innerHTML = '';

        if (conversations.length === 0) {
          historyMenu.innerHTML = '<div class="history-empty">No previous chats</div>';
          return;
        }

        conversations.forEach(function(conv) {
          var item = document.createElement('div');
          item.className = 'history-item' + (conv.id === currentId ? ' active' : '');

          var date = new Date(conv.updatedAt);
          var dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

          item.innerHTML =
            '<div class="history-item-info">' +
              '<span class="history-item-title">' + escapeHtml(conv.title || 'New Conversation') + '</span>' +
              '<span class="history-item-date">' + dateStr + '</span>' +
            '</div>' +
            '<button class="history-item-delete" title="Delete">×</button>';

          // Click to switch conversation
          item.addEventListener('click', function(e) {
            if (!e.target.classList.contains('history-item-delete')) {
              postMessageWithPanelId({ type: 'switchConversation', payload: { id: conv.id } });
              historyMenu.classList.add('hidden');
            }
          });

          // Delete button
          item.querySelector('.history-item-delete').addEventListener('click', function(e) {
            e.stopPropagation();
            postMessageWithPanelId({ type: 'deleteConversation', payload: { id: conv.id } });
          });

          historyMenu.appendChild(item);
        });
      }

      modeSelect.addEventListener('change', function() {
        state.settings.mode = modeSelect.value;
        updateModeIndicator();
        postMessageWithPanelId({ type: 'updateSettings', payload: { mode: modeSelect.value } });
      });

      thinkingSelect.addEventListener('change', function() {
        state.settings.thinkingLevel = thinkingSelect.value;
        postMessageWithPanelId({ type: 'updateSettings', payload: { thinkingLevel: thinkingSelect.value } });
      });

      modelSelect.addEventListener('change', function() {
        state.settings.model = modelSelect.value;
        postMessageWithPanelId({ type: 'updateSettings', payload: { model: modelSelect.value } });
      });

      accessSelect.addEventListener('change', function() {
        state.settings.accessLevel = accessSelect.value;
        postMessageWithPanelId({ type: 'updateSettings', payload: { accessLevel: accessSelect.value } });
      });

      // Agent settings event handlers
      var autoSuggestToggle = document.getElementById('auto-suggest-toggle');
      var tokenLimitToggle = document.getElementById('token-limit-toggle');
      var tokenBudgetInput = document.getElementById('token-budget-input');
      var tokenBudgetSection = document.getElementById('token-budget-section');
      var suggestionsToggle = document.getElementById('suggestions-toggle');

      if (autoSuggestToggle) {
        autoSuggestToggle.addEventListener('click', function() {
          state.agentSettings.autoSuggest = !state.agentSettings.autoSuggest;
          if (state.agentSettings.autoSuggest) {
            autoSuggestToggle.classList.add('active');
          } else {
            autoSuggestToggle.classList.remove('active');
          }
          postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.autoSuggest': state.agentSettings.autoSuggest } });
        });
      }

      if (tokenLimitToggle) {
        tokenLimitToggle.addEventListener('click', function() {
          state.agentSettings.tokenLimitEnabled = !state.agentSettings.tokenLimitEnabled;
          if (state.agentSettings.tokenLimitEnabled) {
            tokenLimitToggle.classList.add('active');
            if (tokenBudgetSection) tokenBudgetSection.classList.remove('hidden');
            // Restore budget value when enabled
            var budgetValue = state.agentSettings.maxTokenBudget || 2000;
            postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.maxTokenBudget': budgetValue } });
          } else {
            tokenLimitToggle.classList.remove('active');
            if (tokenBudgetSection) tokenBudgetSection.classList.add('hidden');
            // Set to 0 (unlimited) when disabled
            postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.maxTokenBudget': 0 } });
          }
        });
      }

      if (tokenBudgetInput) {
        tokenBudgetInput.addEventListener('change', function() {
          var value = parseInt(tokenBudgetInput.value, 10);
          if (value < 100) value = 100;
          if (value > 16000) value = 16000;
          tokenBudgetInput.value = value;
          state.agentSettings.maxTokenBudget = value;
          postMessageWithPanelId({ type: 'updateSettings', payload: { 'agents.maxTokenBudget': value } });
        });
      }

      if (suggestionsToggle) {
        suggestionsToggle.addEventListener('click', function() {
          state.agentSettings.showSuggestions = !state.agentSettings.showSuggestions;
          var quickActionsContainer = document.getElementById('quick-actions-container');
          if (state.agentSettings.showSuggestions) {
            suggestionsToggle.classList.add('active');
            if (quickActionsContainer) quickActionsContainer.classList.remove('hidden');
          } else {
            suggestionsToggle.classList.remove('active');
            if (quickActionsContainer) quickActionsContainer.classList.add('hidden');
          }
          postMessageWithPanelId({ type: 'updateSettings', payload: { showSuggestions: state.agentSettings.showSuggestions } });
        });
      }

      // Quick actions hide button handler
      var quickActionsHideBtn = document.getElementById('quick-actions-hide');
      if (quickActionsHideBtn) {
        quickActionsHideBtn.addEventListener('click', function() {
          state.agentSettings.showSuggestions = false;
          var quickActionsContainer = document.getElementById('quick-actions-container');
          if (quickActionsContainer) quickActionsContainer.classList.add('hidden');
          // Update settings toggle if visible
          if (suggestionsToggle) suggestionsToggle.classList.remove('active');
          postMessageWithPanelId({ type: 'updateSettings', payload: { showSuggestions: false } });
        });
      }

      // Brainstorm agent selection handlers
      var brainstormAgentSection = document.getElementById('brainstorm-agents-section');
      var brainstormAgentCheckboxes = document.querySelectorAll('input[name="brainstorm-agent"]');
      var brainstormAgentError = document.getElementById('brainstorm-agent-error');

      function updateBrainstormAgentSelection() {
        var selected = [];
        brainstormAgentCheckboxes.forEach(function(cb) {
          if (cb.checked) {
            selected.push(cb.value);
          }
        });

        // Validate: exactly 2 must be selected
        if (selected.length === 2) {
          brainstormAgentError.classList.add('hidden');
          state.brainstormAgents = selected;
          // Persist to settings
          postMessageWithPanelId({
            type: 'updateSettings',
            payload: { 'brainstorm.agents': selected }
          });
        } else {
          brainstormAgentError.classList.remove('hidden');
        }

        // Disable unchecked options if 2 are already selected
        brainstormAgentCheckboxes.forEach(function(cb) {
          var option = cb.closest('.brainstorm-agent-option');
          if (selected.length >= 2 && !cb.checked) {
            option.classList.add('disabled');
          } else {
            option.classList.remove('disabled');
          }
        });
      }

      brainstormAgentCheckboxes.forEach(function(cb) {
        cb.addEventListener('change', updateBrainstormAgentSelection);
      });

      // Function to show/hide brainstorm section based on provider availability
      function updateBrainstormSectionVisibility() {
        if (!brainstormAgentSection) return;

        var providerAvailability = state.providerAvailability || {};

        // Count available providers
        var availableCount = 0;
        ['claude-code', 'openai-codex', 'google-gemini', 'github-copilot'].forEach(function(providerId) {
          if (providerAvailability[providerId] &&
              providerAvailability[providerId].available) {
            availableCount++;
          }
        });

        // Show section only if 2+ providers are available
        if (availableCount >= 2) {
          brainstormAgentSection.classList.remove('hidden');

          // Disable unavailable provider checkboxes
          brainstormAgentCheckboxes.forEach(function(cb) {
            var providerId = cb.value;
            var option = cb.closest('.brainstorm-agent-option');
            if (providerAvailability[providerId] &&
                !providerAvailability[providerId].available) {
              option.classList.add('disabled');
              cb.disabled = true;
              // If this was selected, uncheck and revalidate
              if (cb.checked) {
                cb.checked = false;
                updateBrainstormAgentSelection();
              }
            } else {
              cb.disabled = false;
            }
          });
        } else {
          brainstormAgentSection.classList.add('hidden');
        }
      }

      // Function to sync brainstorm agents UI from state
      function updateBrainstormAgentsUI() {
        if (!state.brainstormAgents) return;

        brainstormAgentCheckboxes.forEach(function(cb) {
          cb.checked = state.brainstormAgents.includes(cb.value);
        });

        // Re-apply disabled states
        var selected = state.brainstormAgents.length;
        brainstormAgentCheckboxes.forEach(function(cb) {
          var option = cb.closest('.brainstorm-agent-option');
          if (selected >= 2 && !cb.checked) {
            option.classList.add('disabled');
          } else {
            option.classList.remove('disabled');
          }
        });

        if (brainstormAgentError) {
          brainstormAgentError.classList.add('hidden');
        }
      }

      providerSelect.addEventListener('change', function() {
        var newProvider = providerSelect.value;

        // Update state for all agent types including brainstorm
        state.settings.provider = newProvider;
        state.activeAgent = newProvider;
        updateAgentMenuSelection();

        if (newProvider !== 'brainstorm') {
          // Update model dropdown with provider-specific models (brainstorm doesn't have its own models)
          updateModelsForProvider(newProvider);
        }

        // Hide thinking section for Gemini (doesn't support thinking tokens)
        updateThinkingSectionVisibility(newProvider);

        // Notify backend of provider change
        postMessageWithPanelId({ type: 'updateSettings', payload: { provider: newProvider } });
      });

      // Function to show/hide thinking section based on provider
      function updateThinkingSectionVisibility(provider) {
        var thinkingSection = document.getElementById('thinking-section');
        if (thinkingSection) {
          // Gemini doesn't support thinking tokens, hide the section
          thinkingSection.style.display = (provider === 'google-gemini') ? 'none' : 'block';
        }
      }

      if (contextModeBtn && contextModeLabel) {
        contextModeBtn.addEventListener('click', function() {
          state.settings.contextMode = state.settings.contextMode === 'auto' ? 'manual' : 'auto';
          contextModeLabel.textContent = state.settings.contextMode === 'auto' ? 'Auto' : 'Manual';
          postMessageWithPanelId({ type: 'updateSettings', payload: { contextMode: state.settings.contextMode } });
        });
      }

      // Mode indicator click to cycle through modes
      if (modeIndicator) {
        modeIndicator.addEventListener('click', function() {
          var modes = ['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];
          var currentIndex = modes.indexOf(state.settings.mode);
          var nextIndex = (currentIndex + 1) % modes.length;
          var newMode = modes[nextIndex];

          state.settings.mode = newMode;
          updateModeIndicator();

          // Also update the mode dropdown if it exists
          if (modeSelect) {
            modeSelect.value = newMode;
          }

          postMessageWithPanelId({ type: 'updateSettings', payload: { mode: newMode } });
        });

        modeIndicator.title = 'Click to cycle through modes';
      }

      if (addContextBtn) {
        addContextBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'getWorkspaceFiles' });
        });
      }

      if (clearContextBtn) {
        clearContextBtn.addEventListener('click', function() {
          postMessageWithPanelId({ type: 'clearContext' });
        });
      }

      slashCmdBtn.addEventListener('click', function() {
        slashMenu.classList.toggle('hidden');
      });

      document.querySelectorAll('.slash-menu-item').forEach(function(item) {
        item.addEventListener('click', function() {
          var command = item.dataset.command;
          inputEl.value = '/' + command + ' ';
          inputEl.focus();
          hideSlashMenu();
        });
      });

      // Agent menu toggle
      if (agentSelectBtn && agentMenu) {
        agentSelectBtn.addEventListener('click', function() {
          agentMenu.classList.toggle('hidden');
          // Close slash menu if open
          if (slashMenu) slashMenu.classList.add('hidden');
        });

        // Agent menu clicks with event delegation
        agentMenu.addEventListener('click', function(e) {
          // FIRST: Check if Install button was clicked (highest priority)
          var installBtn = e.target.closest('.agent-install-btn');
          if (installBtn) {
            e.preventDefault();
            e.stopPropagation();
            var agentId = installBtn.dataset.agent;
            console.log('[Mysti Webview] Install button clicked via delegation for:', agentId);
            if (agentId) {
              showInstallProviderModal(agentId);
            }
            return;
          }

          // SECOND: Check if a menu item was clicked
          var menuItem = e.target.closest('.agent-menu-item');
          if (!menuItem) return; // Click was on header/divider/etc

          // Skip disabled items
          if (menuItem.classList.contains('disabled')) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          // Handle normal agent selection
          var agent = menuItem.dataset.agent;
          if (agent) {
            state.activeAgent = agent;
            state.settings.provider = agent;

            if (providerSelect) providerSelect.value = agent;

            if (agent !== 'brainstorm') {
              updateModelsForProvider(agent);
            }

            updateThinkingSectionVisibility(agent);
            updateAgentMenuSelection();
            agentMenu.classList.add('hidden');

            postMessageWithPanelId({ type: 'updateSettings', payload: { provider: agent } });
          }
        });
      }

      function updateModelsForProvider(providerId) {
        if (!state.providers || state.providers.length === 0) return;

        var provider = state.providers.find(function(p) { return p.name === providerId; });
        if (provider && provider.models) {
          modelSelect.innerHTML = provider.models.map(function(m) {
            return '<option value="' + m.id + '">' + m.name + '</option>';
          }).join('');

          // Select first model as default or keep current if it exists in the new provider
          if (provider.models.length > 0) {
            var currentModelExists = provider.models.some(function(m) { return m.id === state.settings.model; });
            if (!currentModelExists) {
              state.settings.model = provider.models[0].id;
              modelSelect.value = state.settings.model;
              // Notify backend of model change
              postMessageWithPanelId({ type: 'updateSettings', payload: { model: state.settings.model } });
            }
          }
        }
      }

      function updateAgentMenuSelection() {
        document.querySelectorAll('.agent-menu-item[data-agent]').forEach(function(item) {
          if (item.dataset.agent === state.activeAgent) {
            item.classList.add('selected');
            // Show "Active" badge
            var badge = item.querySelector('.agent-item-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'agent-item-badge';
              badge.textContent = 'Active';
              item.appendChild(badge);
            }
          } else {
            item.classList.remove('selected');
            // Remove "Active" badge
            var badge = item.querySelector('.agent-item-badge');
            if (badge) badge.remove();
          }
        });
        // Update agent button label and icon
        var agentNameEl = document.getElementById('agent-name');
        var agentIconEl = document.getElementById('agent-icon');
        if (agentNameEl) {
          var agentNames = {
            'claude-code': 'Claude',
            'openai-codex': 'Codex',
            'google-gemini': 'Gemini',
            'github-copilot': 'Copilot',
            'brainstorm': 'Brainstorm'
          };
          agentNameEl.textContent = agentNames[state.activeAgent] || 'Claude';
        }
        if (agentIconEl) {
          var img = agentIconEl.querySelector('img');
          if (img) {
            var agentLogos = {
              'claude-code': CLAUDE_LOGO,
              'openai-codex': getOpenAILogo(),
              'google-gemini': GEMINI_LOGO,
              'github-copilot': COPILOT_LOGO,
              'brainstorm': MYSTI_LOGO
            };
            img.src = agentLogos[state.activeAgent] || CLAUDE_LOGO;
          }
        }
        // Sync settings provider dropdown (only for actual providers, not brainstorm)
        if (providerSelect && state.activeAgent !== 'brainstorm' && providerSelect.value !== state.activeAgent) {
          providerSelect.value = state.activeAgent;
        }
      }

      // Update all OpenAI logos based on current theme
      function updateOpenAILogos() {
        var logo = getOpenAILogo();
        document.querySelectorAll('.openai-logo').forEach(function(img) {
          img.src = logo;
        });
        // Also update toolbar icon if currently showing OpenAI
        if (state.activeAgent === 'openai-codex') {
          var agentIconEl = document.getElementById('agent-icon');
          if (agentIconEl) {
            var img = agentIconEl.querySelector('img');
            if (img) img.src = logo;
          }
        }
      }

      /**
       * Update provider availability in the UI
       * - Disables unavailable providers in dropdowns and agent menu
       * - Auto-selects first available provider if current is unavailable
       * - Handles brainstorm availability (requires 2+ providers)
       */
      function updateProviderAvailability() {
        if (!state.providerAvailability) return;

        var availability = state.providerAvailability;

        // Count available providers
        var availableCount = 0;
        var firstAvailable = null;
        ['claude-code', 'openai-codex', 'google-gemini', 'github-copilot'].forEach(function(providerId) {
          if (availability[providerId] && availability[providerId].available) {
            availableCount++;
            if (!firstAvailable) firstAvailable = providerId;
          }
        });

        // Update provider dropdown options
        if (providerSelect) {
          Array.from(providerSelect.options).forEach(function(option) {
            var providerId = option.value;
            if (providerId === 'brainstorm') {
              // Brainstorm requires 2+ available providers
              if (availableCount < 2) {
                option.disabled = true;
                option.textContent = 'Brainstorm (requires 2+ providers)';
              } else {
                option.disabled = false;
                option.textContent = 'Brainstorm';
              }
            } else if (availability[providerId]) {
              if (!availability[providerId].available) {
                option.disabled = true;
                option.textContent = option.textContent.replace(' (not installed)', '') + ' (not installed)';
              } else {
                option.disabled = false;
                option.textContent = option.textContent.replace(' (not installed)', '');
              }
            }
          });
        }

        // Update agent menu items
        document.querySelectorAll('.agent-menu-item[data-agent]').forEach(function(item) {
          var agentId = item.dataset.agent;

          if (agentId === 'brainstorm') {
            // Brainstorm requires 2+ available providers
            if (availableCount < 2) {
              item.classList.add('disabled');
              item.title = 'Requires 2+ installed providers';
              // Add disabled badge
              var existingBadge = item.querySelector('.agent-item-badge');
              if (!existingBadge || existingBadge.textContent === 'Active') {
                var badge = existingBadge || document.createElement('span');
                badge.className = 'agent-item-badge';
                badge.textContent = 'Requires 2+';
                if (!existingBadge) item.appendChild(badge);
              }
            } else {
              item.classList.remove('disabled');
              item.title = '';
              // Remove disabled badge if not active
              var badge = item.querySelector('.agent-item-badge');
              if (badge && badge.textContent === 'Requires 2+') {
                badge.remove();
              }
            }
          } else if (availability[agentId]) {
            if (!availability[agentId].available) {
              item.classList.add('disabled');
              item.dataset.installCommand = availability[agentId].installCommand || '';
              item.title = 'Not installed - click Install to set up';

              // Add or update "Not Installed" badge inside the item
              var badge = item.querySelector('.agent-item-badge');
              if (!badge) {
                badge = document.createElement('span');
                badge.className = 'agent-item-badge';
                item.appendChild(badge);
              }
              badge.textContent = 'Not Installed';

              // Add Install button inside the menu item (CSS handles pointer-events)
              var installBtn = item.querySelector('.agent-install-btn');
              if (!installBtn) {
                installBtn = document.createElement('button');
                installBtn.className = 'agent-install-btn';
                installBtn.dataset.agent = agentId;
                installBtn.textContent = 'Install';
                installBtn.addEventListener('click', function(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  console.log('[Mysti Webview] Install button clicked for:', agentId);
                  showInstallProviderModal(agentId);
                });
                item.appendChild(installBtn);
              }
            } else {
              item.classList.remove('disabled');
              item.title = '';
              delete item.dataset.installCommand;
              // Remove "Not Installed" badge
              var badge = item.querySelector('.agent-item-badge');
              if (badge && badge.textContent === 'Not Installed') {
                badge.remove();
              }
              // Remove Install button
              var installBtn = item.querySelector('.agent-install-btn');
              if (installBtn) {
                installBtn.remove();
              }
            }
          }
        });

        // Auto-select first available provider if current is unavailable
        var currentProvider = state.settings.provider;
        if (currentProvider && currentProvider !== 'brainstorm') {
          if (availability[currentProvider] && !availability[currentProvider].available) {
            if (firstAvailable) {
              console.log('[Mysti Webview] Current provider unavailable, switching to:', firstAvailable);
              state.settings.provider = firstAvailable;
              state.activeAgent = firstAvailable;
              if (providerSelect) providerSelect.value = firstAvailable;
              updateAgentMenuSelection();
              updateModelsForProvider(firstAvailable);
              postMessageWithPanelId({ type: 'updateSettings', payload: { provider: firstAvailable } });
            }
          }
        } else if (currentProvider === 'brainstorm' && availableCount < 2) {
          // Brainstorm selected but not enough providers
          if (firstAvailable) {
            console.log('[Mysti Webview] Brainstorm unavailable (need 2+ providers), switching to:', firstAvailable);
            state.settings.provider = firstAvailable;
            state.activeAgent = firstAvailable;
            if (providerSelect) providerSelect.value = firstAvailable;
            updateAgentMenuSelection();
            updateModelsForProvider(firstAvailable);
            postMessageWithPanelId({ type: 'updateSettings', payload: { provider: firstAvailable } });
          }
        }

        // Update brainstorm agent section visibility
        updateBrainstormSectionVisibility();
      }

      // Watch for theme changes
      var themeObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          if (mutation.attributeName === 'class') {
            updateOpenAILogos();
          }
        });
      });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

      var enhanceTimeout = null;
      enhanceBtn.addEventListener('click', function() {
        if (inputEl.value.trim() && !enhanceBtn.classList.contains('enhancing')) {
          // Add enhancing state - show loader and disable inputs
          enhanceBtn.classList.add('enhancing');
          enhanceBtn.title = 'Enhancing prompt...';
          var inputArea = document.querySelector('.input-area');
          if (inputArea) inputArea.classList.add('enhancing');

          // Safety timeout - reset UI if no response after 30 seconds
          enhanceTimeout = setTimeout(function() {
            if (enhanceBtn.classList.contains('enhancing')) {
              enhanceBtn.classList.remove('enhancing');
              enhanceBtn.title = 'Enhance prompt';
              var ia = document.querySelector('.input-area');
              if (ia) ia.classList.remove('enhancing');
              inputEl.placeholder = 'Enhancement timed out. Try again.';
              setTimeout(function() {
                inputEl.placeholder = 'Ask Mysti...';
              }, 3000);
            }
          }, 30000);

          postMessageWithPanelId({ type: 'enhancePrompt', payload: inputEl.value });
        }
      });

      if (contextItems) {
        contextItems.addEventListener('dragover', function(e) {
          e.preventDefault();
          contextItems.style.background = 'var(--vscode-list-hoverBackground)';
        });

        contextItems.addEventListener('dragleave', function() {
          contextItems.style.background = '';
        });

        contextItems.addEventListener('drop', function(e) {
          e.preventDefault();
          contextItems.style.background = '';
        });
      }

      window.addEventListener('message', function(event) {
        handleMessage(event.data);
      });

      function handleMessage(message) {
        switch (message.type) {
          case 'initialState':
            initializeState(message.payload);
            break;
          case 'messageAdded':
            addMessage(message.payload);
            break;
          case 'responseStarted':
            showLoading();
            break;
          case 'responseChunk':
            handleResponseChunk(message.payload);
            break;
          case 'responseComplete':
            hideLoading();
            // Payload is { message, usage } - extract message for finalization
            var responsePayload = message.payload || {};
            finalizeStreamingMessage(responsePayload.message || responsePayload);
            // Update context usage from response
            // Total context = input_tokens + cache_read_input_tokens (cached context being used)
            if (responsePayload.usage) {
              var totalContextTokens = (responsePayload.usage.input_tokens || 0) +
                                       (responsePayload.usage.cache_read_input_tokens || 0);
              console.log('[Mysti Webview] Context usage - input:', responsePayload.usage.input_tokens,
                          'cached:', responsePayload.usage.cache_read_input_tokens,
                          'total:', totalContextTokens);
              updateContextUsage(totalContextTokens, null);
            }
            break;
          case 'contextWindowInfo':
            // Update context window size for the current model
            if (message.payload && message.payload.contextWindow) {
              updateContextUsage(state.contextUsage.usedTokens, message.payload.contextWindow);
            }
            break;
          case 'requestCancelled':
            hideLoading();
            // Hide suggestion skeleton if showing
            var quickActionsContainer = document.getElementById('quick-actions');
            if (quickActionsContainer) {
              quickActionsContainer.classList.remove('loading');
              quickActionsContainer.innerHTML = '';
            }
            break;
          case 'suggestionsLoading':
            showSuggestionSkeleton();
            break;
          case 'suggestionsReady':
            renderSuggestions(message.payload.suggestions);
            break;
          case 'suggestionsError':
            // Clear suggestions on error - don't show fallbacks
            var suggestionsContainer = document.getElementById('quick-actions');
            if (suggestionsContainer) {
              suggestionsContainer.classList.remove('loading');
              suggestionsContainer.innerHTML = '';
            }
            break;
          case 'clearSuggestions':
            // Clear suggestions when user interacts with questions/plans
            var suggestionsContainer = document.getElementById('quick-actions');
            if (suggestionsContainer) {
              suggestionsContainer.classList.remove('loading');
              suggestionsContainer.innerHTML = '';
            }
            break;
          case 'clearPlanOptions':
            // Clear plan options and questions when exiting plan mode
            var planOptionsContainers = document.querySelectorAll('.plan-options-container');
            planOptionsContainers.forEach(function(container) {
              container.remove();
            });
            var questionsContainers = document.querySelectorAll('.questions-container');
            questionsContainers.forEach(function(container) {
              container.remove();
            });
            console.log('[Mysti] Cleared all plan options and questions from UI');
            break;
          case 'autocompleteSuggestion':
            if (message.payload && message.payload.suggestion) {
              updateGhostText(message.payload.suggestion);
              state.autocompleteType = message.payload.type || 'word';
            }
            break;
          case 'autocompleteCleared':
            if (autocompleteGhostEl) {
              autocompleteGhostEl.innerHTML = '';
            }
            state.autocompleteSuggestion = null;
            state.autocompleteType = null;
            break;
          case 'toolUse':
            handleToolUse(message.payload);
            break;
          case 'toolResult':
            handleToolResult(message.payload);
            break;
          case 'permissionRequest':
            handlePermissionRequest(message.payload);
            break;
          case 'permissionExpired':
            handlePermissionExpired(message.payload);
            break;
          case 'planOptions':
            handlePlanOptionsMessage(message.payload);
            break;
          case 'clarifyingQuestions':
            handleClarifyingQuestionsMessage(message.payload);
            break;
          case 'askUserQuestion':
            handleAskUserQuestionMessage(message.payload);
            break;
          case 'error':
            hideLoading();
            showError(message.payload);
            break;
          case 'authError':
            hideLoading();
            showAuthError(message.payload);
            break;
          case 'contextUpdated':
            updateContext(message.payload);
            break;
          case 'conversationChanged':
            clearMessages();
            resetContextUsage();
            if (message.payload && message.payload.messages) {
              message.payload.messages.forEach(function(msg) { addMessage(msg); });
            }
            // Update agent config when switching conversations
            if (message.payload && message.payload.agentConfig) {
              state.agentConfig = message.payload.agentConfig;
            } else {
              state.agentConfig = { personaId: null, enabledSkills: [] };
            }
            renderAgentConfigPanel();
            break;
          case 'agentConfigUpdated':
            // Update local state with new config (e.g., from quick action auto-selection)
            if (message.payload) {
              state.agentConfig = {
                personaId: message.payload.personaId || null,
                enabledSkills: message.payload.enabledSkills || []
              };
              renderAgentConfigPanel();
            }
            break;
          case 'agentRecommendations':
            renderRecommendations(message.payload);
            break;
          case 'conversationHistory':
            renderHistoryMenu(message.payload.conversations, message.payload.currentId);
            break;
          case 'titleUpdated':
            // Title was updated by AI, refresh history if open
            if (historyMenu && !historyMenu.classList.contains('hidden')) {
              postMessageWithPanelId({ type: 'getConversationHistory' });
            }
            break;
          case 'insertPrompt':
            inputEl.value = message.payload;
            inputEl.focus();
            break;
          case 'promptEnhanced':
            // Clear safety timeout
            if (enhanceTimeout) {
              clearTimeout(enhanceTimeout);
              enhanceTimeout = null;
            }
            // Reset enhancing state
            enhanceBtn.classList.remove('enhancing');
            enhanceBtn.title = 'Enhance prompt';
            var inputAreaReset = document.querySelector('.input-area');
            if (inputAreaReset) inputAreaReset.classList.remove('enhancing');

            inputEl.value = message.payload;
            inputEl.focus();
            autoResizeTextarea();
            break;
          case 'promptEnhanceError':
            // Clear safety timeout
            if (enhanceTimeout) {
              clearTimeout(enhanceTimeout);
              enhanceTimeout = null;
            }
            // Reset enhancing state on error
            enhanceBtn.classList.remove('enhancing');
            enhanceBtn.title = 'Enhance prompt';
            var inputAreaError = document.querySelector('.input-area');
            if (inputAreaError) inputAreaError.classList.remove('enhancing');

            // Show error briefly in the input area
            var originalPlaceholder = inputEl.placeholder;
            inputEl.placeholder = 'Enhancement failed: ' + (message.payload || 'Try again');
            setTimeout(function() {
              inputEl.placeholder = originalPlaceholder;
            }, 3000);
            inputEl.focus();
            break;
          case 'slashCommandResult':
            addSystemMessage(message.payload.result);
            break;
          case 'sessionCleared':
            sessionIndicator.style.display = 'none';
            break;
          case 'sessionActive':
            sessionIndicator.style.display = 'flex';
            break;
          case 'fileReverted':
            handleFileReverted(message.payload);
            break;
          case 'fileLineNumber':
            handleFileLineNumber(message.payload);
            break;
          // Brainstorm mode message handlers
          case 'brainstormStarted':
            handleBrainstormStarted(message.payload);
            break;
          case 'brainstormAgentChunk':
            handleBrainstormAgentChunk(message.payload);
            break;
          case 'brainstormPhaseChange':
            handleBrainstormPhaseChange(message.payload);
            break;
          case 'brainstormSynthesisChunk':
            handleBrainstormSynthesisChunk(message.payload);
            break;
          case 'brainstormComplete':
            handleBrainstormComplete(message.payload);
            break;
          case 'brainstormError':
            handleBrainstormError(message.payload);
            break;
          case 'brainstormAgentComplete':
            handleBrainstormAgentComplete(message.payload);
            break;
          case 'agentChanged':
            state.activeAgent = message.payload.agent;
            state.settings.provider = message.payload.agent;
            // Sync provider dropdown
            if (providerSelect) providerSelect.value = message.payload.agent;
            updateAgentMenuSelection();
            break;
          case 'modeChanged':
            // Update mode when plan is executed
            var newMode = message.payload.mode;
            state.settings.mode = newMode;
            var modeSelect = document.getElementById('mode-select');
            if (modeSelect) modeSelect.value = newMode;
            updateModeIndicator();
            break;
          case 'setInputValue':
            // For "Keep Planning" - insert prompt into input field
            inputEl.value = message.payload.value;
            autoResizeTextarea();
            inputEl.focus();
            break;
          // Setup message handlers
          case 'setupStatus':
            handleSetupStatus(message.payload);
            break;
          case 'setupProgress':
            handleSetupProgress(message.payload);
            break;
          case 'setupComplete':
            handleSetupComplete(message.payload);
            break;
          case 'setupFailed':
            handleSetupFailed(message.payload);
            break;
          case 'authPrompt':
            handleAuthPrompt(message.payload);
            break;
          // Setup Wizard handlers (enhanced onboarding)
          case 'showWizard':
            handleShowWizard(message.payload);
            break;
          case 'wizardStatus':
            handleWizardStatus(message.payload);
            break;
          case 'providerSetupStep':
            handleProviderSetupStep(message.payload);
            break;
          case 'authOptions':
            handleAuthOptions(message.payload);
            break;
          case 'providerInstallInfo':
            handleProviderInstallInfo(message.payload);
            break;
          case 'wizardComplete':
            handleWizardComplete(message.payload);
            break;
          case 'wizardDismissed':
            handleWizardDismissed();
            break;
        }
      }

      // ========================================
      // Setup Flow Handlers (Legacy)
      // ========================================

      function handleSetupStatus(payload) {
        state.setup.providers = payload.providers;
        state.setup.npmAvailable = payload.npmAvailable;
        state.setup.isReady = payload.anyReady;

        if (payload.anyReady) {
          hideSetupOverlay();
        }
      }

      function handleSetupProgress(payload) {
        state.setup.currentStep = payload.step;
        state.setup.providerId = payload.providerId;
        state.setup.message = payload.message;
        state.setup.progress = payload.progress || 0;
        state.setup.isChecking = false;

        updateSetupOverlay();
      }

      function handleSetupComplete(payload) {
        state.setup.isReady = true;
        state.setup.currentStep = 'ready';
        state.setup.message = 'Setup complete!';
        state.setup.error = null;

        // Hide setup after brief success display
        setTimeout(function() {
          hideSetupOverlay();
        }, 1000);
      }

      function handleSetupFailed(payload) {
        state.setup.currentStep = 'failed';
        state.setup.providerId = payload.providerId;
        state.setup.error = payload.error;
        state.setup.message = payload.error;

        updateSetupOverlay();
      }

      function handleAuthPrompt(payload) {
        state.setup.currentStep = 'authenticating';
        state.setup.providerId = payload.providerId;
        state.setup.message = payload.message;

        showAuthPromptUI(payload);
      }

      function showSetupOverlay() {
        var overlay = document.getElementById('setup-overlay');
        if (overlay) {
          overlay.classList.remove('hidden');
        }
      }

      function hideSetupOverlay() {
        var overlay = document.getElementById('setup-overlay');
        if (overlay) {
          overlay.classList.add('hidden');
        }
        state.setup.isReady = true;
      }

      function updateSetupOverlay() {
        var overlay = document.getElementById('setup-overlay');
        if (!overlay) return;

        overlay.classList.remove('hidden');

        var progressEl = overlay.querySelector('.setup-progress-bar');
        var messageEl = overlay.querySelector('.setup-message');
        var stepEl = overlay.querySelector('.setup-step');

        if (progressEl) {
          progressEl.style.width = state.setup.progress + '%';
        }
        if (messageEl) {
          messageEl.textContent = state.setup.message;
        }
        if (stepEl) {
          var stepText = state.setup.currentStep === 'checking' ? 'Checking...' :
                         state.setup.currentStep === 'installing' ? 'Installing...' :
                         state.setup.currentStep === 'authenticating' ? 'Authenticating...' :
                         state.setup.currentStep === 'ready' ? 'Ready!' :
                         state.setup.currentStep === 'failed' ? 'Setup Failed' : '';
          stepEl.textContent = stepText;
        }

        // Show error UI if failed
        if (state.setup.currentStep === 'failed') {
          var errorSection = overlay.querySelector('.setup-error');
          if (errorSection) {
            errorSection.classList.remove('hidden');
            var errorMsg = errorSection.querySelector('.setup-error-message');
            if (errorMsg) errorMsg.textContent = state.setup.error;
          }
        }
      }

      function showAuthPromptUI(payload) {
        var overlay = document.getElementById('setup-overlay');
        if (!overlay) return;

        overlay.classList.remove('hidden');
        var content = overlay.querySelector('.setup-content');
        if (!content) return;

        content.innerHTML =
          '<div class="setup-auth-prompt">' +
            '<div class="setup-icon">🔐</div>' +
            '<div class="setup-step">Authentication Required</div>' +
            '<div class="setup-message">' + payload.message + '</div>' +
            '<div class="setup-buttons">' +
              '<button class="setup-btn primary" id="auth-confirm-btn">Sign In</button>' +
              '<button class="setup-btn secondary" id="auth-skip-btn">Later</button>' +
            '</div>' +
          '</div>';

        document.getElementById('auth-confirm-btn').addEventListener('click', function() {
          postMessageWithPanelId({ type: 'authConfirm', payload: { providerId: payload.providerId } });
          content.innerHTML =
            '<div class="setup-progress">' +
              '<div class="setup-icon">⏳</div>' +
              '<div class="setup-step">Waiting for authentication...</div>' +
              '<div class="setup-message">Complete sign-in in the terminal that opened</div>' +
            '</div>';
        });

        document.getElementById('auth-skip-btn').addEventListener('click', function() {
          postMessageWithPanelId({ type: 'authSkip', payload: { providerId: payload.providerId } });
        });
      }

      // ========================================
      // Setup Wizard Handlers (Enhanced Onboarding)
      // ========================================

      function handleShowWizard(payload) {
        state.wizard.visible = true;
        state.wizard.providers = payload.providers || [];
        state.wizard.npmAvailable = payload.npmAvailable;
        state.wizard.nodeVersion = payload.nodeVersion;
        state.wizard.anyReady = payload.anyReady;

        renderWizard();
        initWizardEventListeners();
      }

      function handleWizardStatus(payload) {
        state.wizard.providers = payload.providers || [];
        state.wizard.npmAvailable = payload.npmAvailable;
        state.wizard.anyReady = payload.anyReady;

        if (state.wizard.visible) {
          updateWizardProviderCards();
        }
      }

      function handleProviderSetupStep(payload) {
        // Update provider in state
        var provider = state.wizard.providers.find(function(p) {
          return p.providerId === payload.providerId;
        });

        if (provider) {
          provider.setupStep = payload.step;
          provider.setupProgress = payload.progress;
          provider.setupMessage = payload.message;
          provider.setupDetails = payload.details;

          if (payload.step === 'complete') {
            provider.installed = true;
            provider.authenticated = true;
          } else if (payload.step === 'failed') {
            provider.lastError = payload.message;
          }
        }

        updateWizardProviderCard(payload.providerId);

        // Also update install modal if it's open for this provider
        if (currentInstallProviderId === payload.providerId) {
          updateInstallProgress(payload);
        }
      }

      function handleAuthOptions(payload) {
        state.wizard.currentAuthProviderId = payload.providerId;
        showAuthOptionsModal(payload);
      }

      function handleWizardComplete(payload) {
        hideWizard();
        // Main UI will be shown via initialState
      }

      function handleWizardDismissed() {
        hideWizard();
        // Main UI will be shown via initialState
      }

      function renderWizard() {
        var wizard = document.getElementById('setup-wizard');
        if (!wizard) return;

        wizard.classList.remove('hidden');

        // Show/hide prerequisites warning
        var prereqSection = document.getElementById('wizard-prerequisites');
        if (prereqSection) {
          if (state.wizard.npmAvailable) {
            prereqSection.classList.add('hidden');
          } else {
            prereqSection.classList.remove('hidden');
          }
        }

        // Update provider cards
        updateWizardProviderCards();
      }

      function updateWizardProviderCards() {
        state.wizard.providers.forEach(function(provider) {
          updateWizardProviderCard(provider.providerId);
        });
      }

      function updateWizardProviderCard(providerId) {
        var card = document.querySelector('.provider-card[data-provider="' + providerId + '"]');
        if (!card) return;

        var provider = state.wizard.providers.find(function(p) {
          return p.providerId === providerId;
        });
        if (!provider) return;

        // Determine status
        var status = getWizardProviderStatus(provider);

        // Update status badge
        var statusBadge = card.querySelector('.provider-status');
        if (statusBadge) {
          statusBadge.setAttribute('data-status', status);
          statusBadge.textContent = getWizardStatusText(status);
        }

        // Update card class
        card.classList.remove('ready', 'error');
        if (status === 'ready' || status === 'complete') {
          card.classList.add('ready');
        } else if (status === 'error' || status === 'failed') {
          card.classList.add('error');
        }

        // Update progress section
        var progressSection = card.querySelector('.provider-progress');
        if (progressSection) {
          var showProgress = ['installing', 'downloading', 'verifying', 'authenticating', 'checking'].indexOf(status) !== -1;
          if (showProgress) {
            progressSection.classList.remove('hidden');
            var progressBar = progressSection.querySelector('.progress-bar');
            if (progressBar) {
              progressBar.style.width = (provider.setupProgress || 0) + '%';
            }
            var progressMsg = progressSection.querySelector('.progress-msg');
            if (progressMsg) {
              progressMsg.textContent = provider.setupMessage || 'Working...';
            }
          } else {
            progressSection.classList.add('hidden');
          }
        }

        // Update action button
        var actionBtn = card.querySelector('.provider-action-btn');
        if (actionBtn) {
          updateWizardActionButton(actionBtn, provider, status);
        }
      }

      function getWizardProviderStatus(provider) {
        if (provider.setupStep === 'failed') return 'failed';
        if (provider.setupStep && provider.setupStep !== 'complete') return provider.setupStep;
        if (provider.installed && provider.authenticated) return 'ready';
        if (provider.installed && !provider.authenticated) return 'not-authenticated';
        return 'not-installed';
      }

      function getWizardStatusText(status) {
        var texts = {
          'unknown': 'Checking...',
          'not-installed': 'Not Installed',
          'checking': 'Checking...',
          'downloading': 'Downloading...',
          'installing': 'Installing...',
          'verifying': 'Verifying...',
          'not-authenticated': 'Not Signed In',
          'authenticating': 'Authenticating...',
          'ready': 'Ready',
          'complete': 'Ready',
          'error': 'Error',
          'failed': 'Failed'
        };
        return texts[status] || status;
      }

      function updateWizardActionButton(btn, provider, status) {
        var configs = {
          'not-installed': { text: 'Install', action: 'install', disabled: false, primary: true },
          'checking': { text: 'Checking...', action: null, disabled: true, primary: false },
          'downloading': { text: 'Downloading...', action: null, disabled: true, primary: false },
          'installing': { text: 'Installing...', action: null, disabled: true, primary: false },
          'verifying': { text: 'Verifying...', action: null, disabled: true, primary: false },
          'not-authenticated': { text: 'Sign In', action: 'auth', disabled: false, primary: true },
          'authenticating': { text: 'Waiting...', action: null, disabled: true, primary: false },
          'ready': { text: 'Use This', action: 'select', disabled: false, primary: true, success: true },
          'complete': { text: 'Use This', action: 'select', disabled: false, primary: true, success: true },
          'error': { text: 'Retry', action: 'retry', disabled: false, primary: false },
          'failed': { text: 'Retry', action: 'retry', disabled: false, primary: false }
        };

        var config = configs[status] || configs['not-installed'];

        btn.textContent = config.text;
        btn.disabled = config.disabled;
        btn.setAttribute('data-action', config.action || '');
        btn.setAttribute('data-provider', provider.providerId);

        btn.classList.remove('primary', 'secondary', 'success');
        if (config.success) {
          btn.classList.add('success');
        } else if (config.primary) {
          btn.classList.add('primary');
        } else {
          btn.classList.add('secondary');
        }
      }

      function initWizardEventListeners() {
        // Provider card action buttons
        var actionBtns = document.querySelectorAll('.provider-card .provider-action-btn');
        console.log('[Mysti Webview] initWizardEventListeners: found', actionBtns.length, 'action buttons');
        actionBtns.forEach(function(btn) {
          btn.addEventListener('click', function() {
            var action = btn.getAttribute('data-action');
            var card = btn.closest('.provider-card');
            var providerId = card ? card.getAttribute('data-provider') : null;
            console.log('[Mysti Webview] Wizard button clicked - action:', action, 'providerId:', providerId);
            if (!action || !providerId) {
              console.log('[Mysti Webview] Missing action or providerId, returning early');
              return;
            }
            handleWizardProviderAction(providerId, action);
          });
        });

        // Auth options cancel button
        var authCancelBtn = document.querySelector('.auth-options-cancel');
        if (authCancelBtn) {
          authCancelBtn.addEventListener('click', function() {
            hideAuthOptionsModal();
          });
        }
      }

      function handleWizardProviderAction(providerId, action) {
        console.log('[Mysti Webview] handleWizardProviderAction:', providerId, action);
        switch (action) {
          case 'setup':
          case 'install':
          case 'retry':
            postMessageWithPanelId({
              type: 'startProviderSetup',
              payload: { providerId: providerId, autoInstall: state.wizard.npmAvailable }
            });
            break;
          case 'auth':
            postMessageWithPanelId({
              type: 'startProviderSetup',
              payload: { providerId: providerId, autoInstall: false }
            });
            break;
          case 'select':
            postMessageWithPanelId({
              type: 'selectProvider',
              payload: { providerId: providerId }
            });
            break;
        }
      }

      function showAuthOptionsModal(payload) {
        var modal = document.getElementById('auth-options-modal');
        if (!modal) return;

        var subtitle = document.getElementById('auth-options-subtitle');
        if (subtitle) {
          subtitle.textContent = 'Select how to authenticate with ' + payload.displayName;
        }

        var optionsList = document.getElementById('auth-options-list');
        if (optionsList) {
          optionsList.innerHTML = '';

          payload.options.forEach(function(option) {
            var optionEl = document.createElement('div');
            optionEl.className = 'auth-option';
            optionEl.setAttribute('data-method', option.action);
            optionEl.innerHTML =
              '<span class="auth-option-icon">' + option.icon + '</span>' +
              '<div class="auth-option-content">' +
                '<div class="auth-option-label">' + option.label + '</div>' +
                '<div class="auth-option-desc">' + option.description + '</div>' +
              '</div>';

            optionEl.addEventListener('click', function() {
              hideAuthOptionsModal();
              postMessageWithPanelId({
                type: 'selectAuthMethod',
                payload: {
                  providerId: payload.providerId,
                  method: option.action
                }
              });
            });

            optionsList.appendChild(optionEl);
          });
        }

        modal.classList.remove('hidden');
      }

      function hideAuthOptionsModal() {
        var modal = document.getElementById('auth-options-modal');
        if (modal) {
          modal.classList.add('hidden');
        }
        state.wizard.currentAuthProviderId = null;
      }

      // ========================================
      // Install Provider Modal Functions
      // ========================================

      var currentInstallProviderId = null;

      function showInstallProviderModal(providerId) {
        console.log('[Mysti Webview] showInstallProviderModal called for:', providerId);
        currentInstallProviderId = providerId;
        // Request install info from extension
        postMessageWithPanelId({
          type: 'requestProviderInstallInfo',
          payload: { providerId: providerId }
        });
        console.log('[Mysti Webview] requestProviderInstallInfo message sent');
      }

      function handleProviderInstallInfo(payload) {
        console.log('[Mysti Webview] handleProviderInstallInfo received:', payload);
        var modal = document.getElementById('install-provider-modal');
        if (!modal) {
          console.log('[Mysti Webview] ERROR: install-provider-modal not found in DOM!');
          return;
        }
        console.log('[Mysti Webview] Modal found, updating content...');

        currentInstallProviderId = payload.providerId;

        // Update modal content
        var icon = document.getElementById('install-provider-icon');
        if (icon) {
          icon.src = getProviderIconUri(payload.providerId);
        }

        var title = document.getElementById('install-provider-title');
        if (title) {
          title.textContent = 'Install ' + payload.displayName;
        }

        var commandText = document.getElementById('install-command-text');
        if (commandText) {
          commandText.textContent = payload.installCommand;
        }

        // Auth steps
        var authList = document.getElementById('install-auth-steps');
        if (authList) {
          authList.innerHTML = '';
          payload.authInstructions.forEach(function(step) {
            var li = document.createElement('li');
            li.textContent = step;
            authList.appendChild(li);
          });
        }

        // Docs link
        var docsLink = document.getElementById('install-docs-link');
        if (docsLink) {
          if (payload.docsUrl) {
            docsLink.href = payload.docsUrl;
            docsLink.style.display = '';
          } else {
            docsLink.style.display = 'none';
          }
        }

        // Auto-install button is always enabled
        var autoBtn = document.getElementById('install-auto-btn');
        if (autoBtn) {
          autoBtn.disabled = false;
        }

        // Reset progress section
        var progressSection = document.getElementById('install-progress-section');
        var autoSection = document.getElementById('install-auto-section');
        if (progressSection) progressSection.classList.add('hidden');
        if (autoSection) autoSection.classList.remove('hidden');

        modal.classList.remove('hidden');
      }

      function hideInstallProviderModal() {
        var modal = document.getElementById('install-provider-modal');
        if (modal) {
          modal.classList.add('hidden');
        }
        currentInstallProviderId = null;
      }

      function startAutoInstallFromModal() {
        if (!currentInstallProviderId) return;

        // Show progress, hide auto-install section
        var autoSection = document.getElementById('install-auto-section');
        var progressSection = document.getElementById('install-progress-section');
        if (autoSection) autoSection.classList.add('hidden');
        if (progressSection) progressSection.classList.remove('hidden');

        postMessageWithPanelId({
          type: 'startProviderSetup',
          payload: { providerId: currentInstallProviderId, autoInstall: true }
        });
      }

      function updateInstallProgress(payload) {
        var progressFill = document.getElementById('install-progress-fill');
        var progressMsg = document.getElementById('install-progress-msg');

        if (progressFill) {
          progressFill.style.width = payload.progress + '%';
        }
        if (progressMsg) {
          progressMsg.textContent = payload.message;
        }

        if (payload.step === 'complete') {
          if (progressMsg) progressMsg.textContent = '✓ ' + payload.message;
          setTimeout(function() {
            hideInstallProviderModal();
            // Refresh availability
            postMessageWithPanelId({ type: 'requestProviderAvailability' });
          }, 1500);
        } else if (payload.step === 'failed') {
          if (progressMsg) progressMsg.textContent = '✗ ' + payload.message;
          // Show auto-install section again after delay
          setTimeout(function() {
            var autoSection = document.getElementById('install-auto-section');
            if (autoSection) autoSection.classList.remove('hidden');
          }, 2000);
        }
      }

      function getProviderIconUri(providerId) {
        var icons = {
          'claude-code': CLAUDE_LOGO,
          'openai-codex': getOpenAILogo(),
          'google-gemini': GEMINI_LOGO,
          'github-copilot': COPILOT_LOGO
        };
        return icons[providerId] || '';
      }

      // Setup install modal event listeners
      (function setupInstallModalListeners() {
        var autoBtn = document.getElementById('install-auto-btn');
        if (autoBtn) {
          autoBtn.addEventListener('click', startAutoInstallFromModal);
        }

        var copyBtn = document.getElementById('install-copy-btn');
        if (copyBtn) {
          copyBtn.addEventListener('click', function() {
            var commandText = document.getElementById('install-command-text');
            if (commandText) {
              navigator.clipboard.writeText(commandText.textContent).then(function() {
                copyBtn.textContent = '✓';
                setTimeout(function() { copyBtn.innerHTML = '&#128203;'; }, 1500);
              });
            }
          });
        }

        var terminalBtn = document.getElementById('install-terminal-btn');
        if (terminalBtn) {
          terminalBtn.addEventListener('click', function() {
            var commandText = document.getElementById('install-command-text');
            if (commandText && currentInstallProviderId) {
              postMessageWithPanelId({
                type: 'openTerminal',
                payload: {
                  providerId: currentInstallProviderId,
                  command: commandText.textContent || ''
                }
              });
            }
          });
        }

        var refreshBtn = document.getElementById('install-refresh-btn');
        if (refreshBtn) {
          refreshBtn.addEventListener('click', function() {
            postMessageWithPanelId({
              type: 'refreshProviderDetection',
              payload: {}
            });
            refreshBtn.textContent = '⟳ Refreshing...';
            setTimeout(function() { refreshBtn.innerHTML = '&#8635; Refresh Detection'; }, 2000);
          });
        }

        var closeBtn = document.getElementById('install-close-btn');
        if (closeBtn) {
          closeBtn.addEventListener('click', hideInstallProviderModal);
        }

        // Close modal when clicking outside
        var modal = document.getElementById('install-provider-modal');
        if (modal) {
          modal.addEventListener('click', function(e) {
            if (e.target === modal) {
              hideInstallProviderModal();
            }
          });
        }
      })();

      function hideWizard() {
        var wizard = document.getElementById('setup-wizard');
        if (wizard) {
          wizard.classList.add('hidden');
        }
        state.wizard.visible = false;
      }

      // ========================================
      // Brainstorm Mode Handlers
      // ========================================

      function handleBrainstormStarted(payload) {
        state.brainstormSession = payload.sessionId;
        state.brainstormPhase = 'individual';
        state.agentResponses = {};
        showLoading();

        // Create brainstorm container in messages area
        var brainstormContainer = document.createElement('div');
        brainstormContainer.className = 'brainstorm-container';
        brainstormContainer.id = 'brainstorm-' + payload.sessionId;

        // Generate agent cards dynamically from configured agents
        var agents = state.brainstormAgents || ['claude-code', 'openai-codex'];
        var agentCardsHtml = agents.map(function(agentId) {
          var agentInfo = AGENT_DISPLAY[agentId] || { name: agentId, shortId: agentId, color: '#888', logo: '' };
          var logoSrc = getAgentLogo(agentId);
          var logoClass = agentId === 'openai-codex' ? 'brainstorm-agent-logo openai-logo' : 'brainstorm-agent-logo';
          return '<div class="brainstorm-agent-card" data-agent="' + agentId + '">' +
            '<div class="brainstorm-agent-header">' +
              '<img src="' + logoSrc + '" alt="' + agentInfo.name + '" class="' + logoClass + '" />' +
              '<span class="brainstorm-agent-name">' + agentInfo.name + '</span>' +
              '<span class="brainstorm-agent-status streaming">Thinking...</span>' +
            '</div>' +
            '<div class="brainstorm-agent-content" id="brainstorm-' + agentInfo.shortId + '-content"></div>' +
          '</div>';
        }).join('');

        brainstormContainer.innerHTML =
          '<div class="brainstorm-header">' +
            '<span class="brainstorm-icon">🧠</span>' +
            '<span class="brainstorm-title">Brainstorm Session</span>' +
            '<span class="brainstorm-phase-indicator" id="brainstorm-phase">Individual Analysis</span>' +
          '</div>' +
          '<div class="brainstorm-agents">' +
            agentCardsHtml +
          '</div>' +
          '<div class="brainstorm-synthesis hidden" id="brainstorm-synthesis">' +
            '<div class="brainstorm-synthesis-header">' +
              '<span class="brainstorm-synthesis-icon">✨</span>' +
              '<span class="brainstorm-synthesis-title">Unified Solution</span>' +
            '</div>' +
            '<div class="brainstorm-synthesis-content" id="brainstorm-synthesis-content"></div>' +
          '</div>';

        messagesEl.appendChild(brainstormContainer);
        scrollToBottom();
      }

      function handleBrainstormAgentChunk(payload) {
        var agentId = payload.agentId;
        var content = payload.content || '';
        var chunkType = payload.type || 'text';

        // Use dynamic lookup for agent content element
        var contentEl = document.getElementById('brainstorm-' + getAgentShortId(agentId) + '-content');
        if (!contentEl) return;

        if (chunkType === 'thinking') {
          var thinkingIcon = '<span class="thinking-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg></span>';

          // Codex sends complete thoughts - create separate blocks
          if (agentId !== 'claude-code') {
            var thinkingEl = document.createElement('div');
            thinkingEl.className = 'thinking-block';
            thinkingEl.innerHTML = thinkingIcon + '<span class="thinking-content">' + escapeHtml(content) + '</span>';
            contentEl.appendChild(thinkingEl);
          } else {
            // Claude: Accumulate and create collapsible structure
            brainstormClaudeThinkingBuffer += content;

            var thinkingEl = contentEl.querySelector('.thinking-block.claude-thinking');
            if (!thinkingEl) {
              // Create the thinking block structure
              thinkingEl = document.createElement('div');
              thinkingEl.className = 'thinking-block claude-thinking';
              thinkingEl.innerHTML = thinkingIcon +
                '<span class="thinking-preview"></span>' +
                '<span class="thinking-dots"></span>' +
                '<div class="thinking-rest"></div>';
              thinkingEl.onclick = function() {
                thinkingEl.classList.toggle('expanded');
              };
              contentEl.appendChild(thinkingEl);
            }

            var previewSpan = thinkingEl.querySelector('.thinking-preview');
            var dotsSpan = thinkingEl.querySelector('.thinking-dots');
            var restDiv = thinkingEl.querySelector('.thinking-rest');

            if (!brainstormFirstSentenceComplete) {
              // Still building first sentence
              var sentenceEnd = findFirstSentenceEnd(brainstormClaudeThinkingBuffer);
              if (sentenceEnd !== -1) {
                // First sentence complete!
                brainstormFirstSentenceComplete = true;
                var firstSentence = brainstormClaudeThinkingBuffer.substring(0, sentenceEnd).trim();
                var rest = brainstormClaudeThinkingBuffer.substring(sentenceEnd).trim();

                previewSpan.textContent = firstSentence;
                dotsSpan.textContent = ' ...';
                thinkingEl.classList.add('collapsible');
                if (rest) {
                  restDiv.textContent = rest;
                }
              } else {
                // Still streaming first sentence
                previewSpan.textContent = brainstormClaudeThinkingBuffer;
              }
            } else {
              // First sentence done, update the rest section
              var sentenceEnd = findFirstSentenceEnd(brainstormClaudeThinkingBuffer);
              var rest = brainstormClaudeThinkingBuffer.substring(sentenceEnd).trim();
              restDiv.textContent = rest;
            }
          }
        } else {
          // Accumulate text content
          if (!state.agentResponses[agentId]) {
            state.agentResponses[agentId] = '';
          }
          state.agentResponses[agentId] += content;

          // Find or create text content container
          var textContainer = contentEl.querySelector('.brainstorm-text-content');
          if (!textContainer) {
            textContainer = document.createElement('div');
            textContainer.className = 'brainstorm-text-content';
            contentEl.appendChild(textContainer);
          }
          // Use formatContent for proper markdown rendering like normal mode
          textContainer.innerHTML = formatContent(state.agentResponses[agentId]);
        }
        scrollToBottom();
      }

      function handleBrainstormAgentComplete(payload) {
        var agentId = payload.agentId;

        // Reset Claude thinking buffer and state
        if (agentId === 'claude-code') {
          brainstormClaudeThinkingBuffer = '';
          brainstormFirstSentenceComplete = false;
        }

        var statusEl = document.querySelector(
          '.brainstorm-agent-card[data-agent="' + agentId + '"] .brainstorm-agent-status'
        );
        if (statusEl) {
          statusEl.textContent = 'Complete';
          statusEl.classList.remove('streaming');
          statusEl.classList.add('complete');
        }
      }

      function handleBrainstormPhaseChange(payload) {
        state.brainstormPhase = payload.phase;

        var phaseIndicator = document.getElementById('brainstorm-phase');
        if (phaseIndicator) {
          var phaseNames = {
            'individual': 'Individual Analysis',
            'discussion': 'Discussion',
            'synthesis': 'Synthesizing Solution',
            'complete': 'Complete'
          };
          phaseIndicator.textContent = phaseNames[payload.phase] || payload.phase;
          phaseIndicator.className = 'brainstorm-phase-indicator ' + payload.phase;
        }

        // Update agent card statuses when individual phase completes
        if (payload.phase === 'synthesis' || payload.phase === 'discussion') {
          document.querySelectorAll('.brainstorm-agent-status').forEach(function(el) {
            el.textContent = 'Complete';
            el.classList.remove('streaming');
            el.classList.add('complete');
          });

          // Show synthesis section
          var synthesisSection = document.getElementById('brainstorm-synthesis');
          if (synthesisSection) {
            synthesisSection.classList.remove('hidden');
          }
        }
      }

      function handleBrainstormSynthesisChunk(payload) {
        var content = payload.content || '';

        if (!state.synthesisContent) {
          state.synthesisContent = '';
        }
        state.synthesisContent += content;

        var synthesisContentEl = document.getElementById('brainstorm-synthesis-content');
        if (synthesisContentEl) {
          synthesisContentEl.innerHTML = formatContent(state.synthesisContent);
        }
        scrollToBottom();
      }

      function handleBrainstormComplete(payload) {
        hideLoading();
        state.brainstormPhase = 'complete';
        state.synthesisContent = '';

        var phaseIndicator = document.getElementById('brainstorm-phase');
        if (phaseIndicator) {
          phaseIndicator.textContent = 'Complete';
          phaseIndicator.classList.add('complete');
        }

        // Update all status indicators
        document.querySelectorAll('.brainstorm-agent-status').forEach(function(el) {
          el.textContent = 'Complete';
          el.classList.remove('streaming');
          el.classList.add('complete');
        });
      }

      function handleBrainstormError(payload) {
        hideLoading();
        var errorMsg = payload.error || 'Brainstorm session failed';

        var container = document.getElementById('brainstorm-' + state.brainstormSession);
        if (container) {
          var errorEl = document.createElement('div');
          errorEl.className = 'brainstorm-error';
          errorEl.innerHTML = '<span class="error-icon">⚠️</span> ' + escapeHtml(errorMsg);
          container.appendChild(errorEl);
        } else {
          showError(errorMsg);
        }
      }

      function handleFileLineNumber(payload) {
        // Find edit report card with this file path and update line numbers
        var cards = document.querySelectorAll('.edit-report-card[data-file-path="' + payload.filePath + '"]');
        cards.forEach(function(card) {
          var baseLineNum = payload.lineNumber;
          // Store line number on card for Open File button to use
          card.dataset.lineNumber = String(baseLineNum);
          // Update diff line numbers display
          var lineNumEls = card.querySelectorAll('.edit-report-diff-linenum');
          lineNumEls.forEach(function(el, idx) {
            el.textContent = String(baseLineNum + idx);
          });
        });
      }

      function handleFileReverted(payload) {
        // Find all file edit cards with this path and update the revert button (legacy cards)
        var cards = document.querySelectorAll('.file-edit-card[data-file-path="' + payload.path + '"]');
        cards.forEach(function(card) {
          var revertBtn = card.querySelector('.file-edit-revert');
          if (revertBtn) {
            if (payload.success) {
              revertBtn.textContent = 'Reverted';
              revertBtn.disabled = true;
              revertBtn.style.color = 'var(--vscode-charts-green)';
            } else {
              revertBtn.textContent = 'Failed';
              revertBtn.disabled = false;
              revertBtn.style.color = 'var(--vscode-charts-red)';
              setTimeout(function() {
                revertBtn.textContent = 'Revert';
                revertBtn.style.color = '';
              }, 2000);
            }
          }
        });

        // Find all edit report cards with this path and update the revert button
        var editReportCards = document.querySelectorAll('.edit-report-card[data-file-path="' + payload.path + '"]');
        editReportCards.forEach(function(card) {
          var revertBtn = card.querySelector('.edit-report-btn-revert');
          if (revertBtn) {
            if (payload.success) {
              revertBtn.textContent = 'Reverted';
              revertBtn.disabled = true;
              revertBtn.classList.add('reverted');
            } else {
              revertBtn.textContent = 'Failed';
              revertBtn.classList.add('failed');
              setTimeout(function() {
                revertBtn.textContent = 'Revert';
                revertBtn.disabled = false;
                revertBtn.classList.remove('failed');
              }, 2000);
            }
          }
        });
      }

      function initializeState(payload) {
        state = Object.assign({}, state, payload);
        modeSelect.value = state.settings.mode;
        thinkingSelect.value = state.settings.thinkingLevel;
        accessSelect.value = state.settings.accessLevel;
        if (contextModeLabel) {
          contextModeLabel.textContent = state.settings.contextMode === 'auto' ? 'Auto' : 'Manual';
        }
        updateModeIndicator();

        // Set agent based on provider setting
        // Brainstorm is an agent type, not a mode - user selects it from the agent dropdown
        if (state.settings.provider) {
          providerSelect.value = state.settings.provider;
          state.activeAgent = state.settings.provider;
          // Update thinking section visibility for Gemini
          updateThinkingSectionVisibility(state.settings.provider);
        }

        // Populate model dropdown based on selected provider
        if (state.providers && state.providers.length > 0) {
          var provider = state.providers.find(function(p) { return p.name === state.settings.provider; });
          if (provider) {
            modelSelect.innerHTML = provider.models.map(function(m) {
              return '<option value="' + m.id + '"' + (m.id === state.settings.model ? ' selected' : '') + '>' + m.name + '</option>';
            }).join('');
          }
        }

        // Update agent menu to match settings
        updateAgentMenuSelection();
        updateOpenAILogos();

        // Update provider availability (disable unavailable providers)
        updateProviderAvailability();

        updateContext(state.context);

        // Initialize agent configuration
        if (state.availablePersonas && state.availableSkills) {
          // Set agentConfig from conversation or use default
          if (state.agentConfig) {
            state.agentConfig = state.agentConfig;
          } else {
            state.agentConfig = { personaId: null, enabledSkills: [] };
          }
          renderAgentConfigPanel();
        }

        // Initialize agent settings UI
        if (state.agentSettings) {
          updateAgentSettingsUI();
        }

        // Initialize brainstorm agents UI
        if (state.brainstormAgents) {
          updateBrainstormAgentsUI();
        }
        updateBrainstormSectionVisibility();

        // Initialize sticky progress observer for scroll-aware sticking
        initStickyProgressObserver();

        if (state.conversation && state.conversation.messages) {
          state.conversation.messages.forEach(function(msg) { addMessage(msg); });
        }
      }

      function sendMessage() {
        var content = inputEl.value.trim();
        if (!content || state.isLoading) return;

        // Hide quick actions when sending a message
        var quickActions = document.getElementById('quick-actions');
        if (quickActions) {
          quickActions.innerHTML = '';
        }

        if (content.startsWith('/')) {
          var parts = content.slice(1).split(' ');
          var command = parts[0];
          var args = parts.slice(1).join(' ');
          postMessageWithPanelId({
            type: 'executeSlashCommand',
            payload: { command: command, args: args }
          });
          inputEl.value = '';
          inputEl.style.height = 'auto';
          return;
        }

        // Check if brainstorm mode is selected (use activeAgent which is set synchronously)
        if (state.activeAgent === 'brainstorm') {
          postMessageWithPanelId({
            type: 'sendBrainstormMessage',
            payload: {
              content: content,
              context: state.context,
              settings: state.settings
            }
          });
        } else {
          postMessageWithPanelId({
            type: 'sendMessage',
            payload: {
              content: content,
              context: state.context,
              settings: state.settings
            }
          });
        }

        inputEl.value = '';
        inputEl.style.height = 'auto';
        state.isLoading = true;
        sendBtn.disabled = true;
      }

      function addMessage(msg) {
        var welcome = messagesEl.querySelector('.welcome-container');
        if (welcome) welcome.remove();

        var div = document.createElement('div');
        div.className = 'message ' + msg.role;
        div.dataset.id = msg.id;

        var roleLabel = msg.role === 'assistant' ? 'Mysti' : msg.role;
        var html = '<div class="message-header">';
        html += '<div class="message-role-container">';
        html += '<span class="message-role ' + msg.role + '">' + roleLabel + '</span>';
        if (msg.role === 'assistant') {
          html += '<span class="message-model-info">' + getModelDisplayName(state.settings.model) + '</span>';
        }
        html += '</div></div>';

        if (msg.thinking) {
          var thinkingIcon = '<span class="thinking-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg></span>';
          html += '<div class="thinking-block">' + thinkingIcon + '<span class="thinking-content">' + escapeHtml(msg.thinking) + '</span></div>';
        }

        html += '<div class="message-content">' + formatContent(msg.content) + '</div>';

        div.innerHTML = html;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function addSystemMessage(content) {
        var div = document.createElement('div');
        div.className = 'message system';
        div.innerHTML = '<div class="message-content">' + escapeHtml(content) + '</div>';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      var currentResponse = '';
      var currentThinking = '';
      var contentSegmentIndex = 0;
      var pendingToolData = new Map(); // toolId -> { name, input } for edit report cards
      var currentTodos = []; // Track current todo list for sticky progress
      var previousTodoContents = new Set(); // Track previous todo content for completion detection
      var stuckTodoObservers = new Map(); // todoId -> IntersectionObserver
      var stuckTodos = new Map(); // todoId -> { originalEl, cloneEl }
      var claudeThinkingBuffer = ''; // Buffer for Claude's streaming thinking chunks
      var claudeFirstSentenceComplete = false; // Track if first sentence is done
      var brainstormClaudeThinkingBuffer = ''; // Buffer for brainstorm mode Claude thinking
      var brainstormFirstSentenceComplete = false; // Track if first sentence is done in brainstorm

      // Helper to detect first sentence end
      function findFirstSentenceEnd(text) {
        // Match sentence-ending punctuation followed by space, newline, or end
        var match = text.match(/[.!?](?:\s|$)/);
        return match ? match.index + 1 : -1;
      }

      function handleResponseChunk(chunk) {
        console.log('[Mysti Webview] Received chunk:', JSON.stringify(chunk));
        if (chunk.type === 'text') {
          currentResponse += chunk.content;
          updateCurrentContentSegment(currentResponse);
        } else if (chunk.type === 'thinking') {
          console.log('[Mysti Webview] Thinking content:', JSON.stringify(chunk.content));
          currentThinking += chunk.content;  // Still accumulate for storage
          appendThinkingBlock(chunk.content);  // But display each chunk separately
        }
      }

      function getOrCreateStreamingMessage() {
        var streamingEl = messagesEl.querySelector('.message.streaming');

        if (!streamingEl) {
          streamingEl = document.createElement('div');
          streamingEl.className = 'message assistant streaming';
          // Removed static thinking-block - now created dynamically for each thought
          streamingEl.innerHTML = '<div class="message-header"><div class="message-role-container"><span class="message-role assistant">Mysti</span><span class="message-model-info">' + getModelDisplayName(state.settings.model) + '</span></div></div><div class="message-body"></div>';
          messagesEl.appendChild(streamingEl);
        }

        return streamingEl;
      }

      function appendThinkingBlock(thinking) {
        var streamingEl = getOrCreateStreamingMessage();
        var messageBody = streamingEl.querySelector('.message-body');
        var thinkingIcon = '<span class="thinking-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg></span>';

        if (thinking && messageBody) {
          // Codex sends complete thoughts - create separate blocks
          if (state.settings.provider === 'openai-codex') {
            var thinkingEl = document.createElement('div');
            thinkingEl.className = 'thinking-block';
            thinkingEl.innerHTML = thinkingIcon + '<span class="thinking-content">' + escapeHtml(thinking) + '</span>';
            messageBody.appendChild(thinkingEl);
          } else {
            // Claude: Accumulate and create collapsible structure
            claudeThinkingBuffer += thinking;

            var thinkingEl = messageBody.querySelector('.thinking-block.claude-thinking');
            if (!thinkingEl) {
              // Create the thinking block structure
              thinkingEl = document.createElement('div');
              thinkingEl.className = 'thinking-block claude-thinking';
              thinkingEl.innerHTML = thinkingIcon +
                '<span class="thinking-preview"></span>' +
                '<span class="thinking-dots"></span>' +
                '<div class="thinking-rest"></div>';
              thinkingEl.onclick = function() {
                thinkingEl.classList.toggle('expanded');
              };
              messageBody.appendChild(thinkingEl);
            }

            var previewSpan = thinkingEl.querySelector('.thinking-preview');
            var dotsSpan = thinkingEl.querySelector('.thinking-dots');
            var restDiv = thinkingEl.querySelector('.thinking-rest');

            if (!claudeFirstSentenceComplete) {
              // Still building first sentence
              var sentenceEnd = findFirstSentenceEnd(claudeThinkingBuffer);
              if (sentenceEnd !== -1) {
                // First sentence complete!
                claudeFirstSentenceComplete = true;
                var firstSentence = claudeThinkingBuffer.substring(0, sentenceEnd).trim();
                var rest = claudeThinkingBuffer.substring(sentenceEnd).trim();

                previewSpan.textContent = firstSentence;
                dotsSpan.textContent = ' ...';
                thinkingEl.classList.add('collapsible');
                if (rest) {
                  restDiv.textContent = rest;
                }
              } else {
                // Still streaming first sentence
                previewSpan.textContent = claudeThinkingBuffer;
              }
            } else {
              // First sentence done, update the rest section
              var sentenceEnd = findFirstSentenceEnd(claudeThinkingBuffer);
              var rest = claudeThinkingBuffer.substring(sentenceEnd).trim();
              restDiv.textContent = rest;
            }
          }
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function flushThinkingBuffer() {
        // Reset the buffer and state - the thinking block stays as-is with its content
        claudeThinkingBuffer = '';
        claudeFirstSentenceComplete = false;
      }

      function updateCurrentContentSegment(content) {
        var streamingEl = getOrCreateStreamingMessage();
        var messageBody = streamingEl.querySelector('.message-body');

        // Find or create the current content segment
        var segmentId = 'content-segment-' + contentSegmentIndex;
        var segmentEl = messageBody.querySelector('.' + segmentId);

        if (!segmentEl) {
          segmentEl = document.createElement('div');
          segmentEl.className = 'message-content ' + segmentId;
          messageBody.appendChild(segmentEl);
        }

        segmentEl.innerHTML = formatContent(content);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // Legacy function for backward compatibility
      function updateStreamingMessage(content, thinking) {
        if (thinking) {
          updateThinkingBlock(thinking);
        }
        if (content) {
          updateCurrentContentSegment(content);
        }
      }

      function toggleToolCall(el) {
        el.classList.toggle('expanded');
      }

      function formatToolSummary(toolName, input) {
        if (!input) return '';
        var name = toolName.toLowerCase();

        switch (name) {
          case 'bash':
            // Show description if available (often contains what the command does)
            // Otherwise show command with paths cleaned up
            if (input.description) {
              return cleanPathsInString(input.description);
            }
            return cleanPathsInString(input.command || '');
          case 'read':
            return makeRelativePath(input.file_path || input.path || '');
          case 'write':
            return makeRelativePath(input.file_path || input.path || '');
          case 'edit':
            return makeRelativePath(input.file_path || input.path || '');
          case 'notebookedit':
            return makeRelativePath(input.notebook_path || input.path || '');
          case 'glob':
            // Show pattern and relative path if specified
            var globPattern = input.pattern || '';
            var globPath = input.path ? makeRelativePath(input.path) : '';
            return globPath ? globPattern + ' in ' + globPath : globPattern;
          case 'grep':
            // Show pattern and relative path if specified
            var grepPattern = input.pattern || '';
            var grepPath = input.path ? makeRelativePath(input.path) : '';
            return grepPath ? grepPattern + ' in ' + grepPath : grepPattern;
          case 'webfetch':
            return input.url || '';
          case 'websearch':
            return input.query || '';
          case 'task':
            return input.description || input.prompt?.substring(0, 50) || '';
          case 'todowrite':
            var todos = input.todos || [];
            return todos.length + ' item' + (todos.length !== 1 ? 's' : '');
          default:
            // Try common field names - apply makeRelativePath to potential file paths
            var filePath = input.file_path || input.path || '';
            if (filePath) return makeRelativePath(filePath);
            return cleanPathsInString(input.command || '') || input.query || input.pattern || '';
        }
      }

      function handleToolUse(toolCall) {
        // Store tool data for later lookup when result arrives
        // (tool_result events don't include name or input)
        if (toolCall.id && toolCall.name) {
          pendingToolData.set(toolCall.id, {
            name: toolCall.name,
            input: toolCall.input || {}
          });
        }

        // Check if this tool call already exists (update with complete input)
        var existingEl = messagesEl.querySelector('.tool-call[data-id="' + toolCall.id + '"]');

        if (existingEl) {
          // Update existing element with complete input
          var inputContent = existingEl.querySelector('.tool-call-content');
          if (inputContent && toolCall.input && Object.keys(toolCall.input).length > 0) {
            var inputStr = JSON.stringify(toolCall.input, null, 2);
            inputContent.textContent = inputStr;
          }
          // Update summary if we now have input
          var summaryEl = existingEl.querySelector('.tool-call-summary');
          if (summaryEl && toolCall.input) {
            var summary = formatToolSummary(toolCall.name, toolCall.input);
            summaryEl.textContent = summary;
            existingEl.dataset.summary = summary;
          }
          return;
        }

        // Get or create streaming message
        var streamingEl = getOrCreateStreamingMessage();
        var messageBody = streamingEl.querySelector('.message-body');

        // If there's content in the current segment, finalize it and start a new segment
        if (currentResponse.trim()) {
          contentSegmentIndex++;
          currentResponse = '';
        }

        // Use actual status from toolCall, default to 'running'
        var toolStatus = toolCall.status || 'running';

        var div = document.createElement('div');
        div.className = 'tool-call ' + toolStatus;
        div.dataset.id = toolCall.id;

        // Format input for display
        var inputStr = JSON.stringify(toolCall.input || {}, null, 2);
        var summary = formatToolSummary(toolCall.name, toolCall.input);
        div.dataset.summary = summary;

        // Chevron SVG for expand indicator
        var chevronSvg = '<svg class="tool-call-chevron" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">' +
          '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

        // Spinner SVG for running state (also used for pending)
        var spinnerSvg = '<svg class="tool-call-spinner" viewBox="0 0 16 16" width="12" height="12">' +
          '<circle cx="8" cy="8" r="6" stroke="var(--vscode-charts-blue)" stroke-width="2" fill="none" stroke-dasharray="28" stroke-dashoffset="8" stroke-linecap="round"/></svg>';

        // Copy icon SVG
        var copySvg = '<svg class="tool-call-copy-icon" viewBox="0 0 16 16" fill="currentColor" width="14" height="14">' +
          '<path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/></svg>';

        div.innerHTML =
          '<div class="tool-call-header">' +
            spinnerSvg +
            chevronSvg +
            '<span class="tool-call-name">' + escapeHtml(toolCall.name) + '</span>' +
            '<span class="tool-call-summary">' + escapeHtml(summary) + '</span>' +
            '<span class="tool-call-status ' + toolStatus + '">' + toolStatus + '</span>' +
            '<button class="tool-call-copy" title="Copy to clipboard">' + copySvg + '</button>' +
          '</div>' +
          '<div class="tool-call-details">' +
            '<div class="tool-call-section">' +
              '<div class="tool-call-label">Input</div>' +
              '<pre class="tool-call-content">' + escapeHtml(inputStr) + '</pre>' +
            '</div>' +
            '<div class="tool-call-output-section" style="display:none;">' +
              '<div class="tool-call-label">Output</div>' +
              '<pre class="tool-call-output-content"></pre>' +
            '</div>' +
          '</div>';

        // Append tool call directly to message body (interleaved with content segments)
        messageBody.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function handleToolResult(toolCall) {
        var toolEl = messagesEl.querySelector('.tool-call[data-id="' + toolCall.id + '"]');
        if (toolEl) {
          // Update status badge
          var statusEl = toolEl.querySelector('.tool-call-status');
          statusEl.className = 'tool-call-status ' + toolCall.status;
          statusEl.textContent = toolCall.status;

          // Add status class to the tool call element for background styling
          toolEl.classList.remove('running');
          toolEl.classList.add(toolCall.status);

          // Show output if available
          if (toolCall.output) {
            var outputSection = toolEl.querySelector('.tool-call-output-section');
            var outputContent = toolEl.querySelector('.tool-call-output-content');
            outputSection.style.display = 'block';
            outputContent.textContent = toolCall.output.substring(0, 1000) + (toolCall.output.length > 1000 ? '...' : '');
          }

          // CRITICAL: Retrieve stored tool data (name and input are empty in tool_result)
          var storedData = pendingToolData.get(toolCall.id);
          var toolName = storedData ? storedData.name : toolCall.name;
          var toolInput = storedData ? storedData.input : toolCall.input;

          // For file edit tools, AUGMENT with structured report card below
          if (isFileEditTool(toolName)) {
            var editInfo = parseFileEditInfo(toolName, toolInput || {}, toolCall.output || '');

            // Check if edit report card already exists for this tool
            var existingCard = toolEl.parentNode.querySelector('.edit-report-card[data-tool-id="' + toolCall.id + '"]');
            if (!existingCard && editInfo.filePath) {
              // Create and insert edit report card below the tool call
              var cardHtml = renderEditReportCard(editInfo, currentThinking);
              var cardWrapper = document.createElement('div');
              cardWrapper.innerHTML = cardHtml;
              var cardEl = cardWrapper.firstChild;
              cardEl.dataset.toolId = toolCall.id;

              // Insert after the tool call element
              if (toolEl.nextSibling) {
                toolEl.parentNode.insertBefore(cardEl, toolEl.nextSibling);
              } else {
                toolEl.parentNode.appendChild(cardEl);
              }

              // Request actual file line number from extension
              var searchText = toolInput.old_string || toolInput.content || '';
              if (searchText && editInfo.filePath) {
                postMessageWithPanelId({
                  type: 'getFileLineNumber',
                  filePath: editInfo.filePath,
                  searchText: searchText
                });
              }

              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          }

          // For TodoWrite, render a nice todo list and update sticky progress
          if (toolName && toolName.toLowerCase() === 'todowrite') {
            var todoInput = toolInput;
            if (todoInput && todoInput.todos && todoInput.todos.length > 0) {
              // Remove any existing todo list for this tool
              var existingTodoList = toolEl.querySelector('.todo-list');
              if (existingTodoList) {
                existingTodoList.remove();
              }

              var todoListHtml = renderTodoList(todoInput.todos);
              var todoContainer = document.createElement('div');
              todoContainer.innerHTML = todoListHtml;
              toolEl.appendChild(todoContainer.firstChild);

              // Update sticky progress indicator
              updateStickyTodos(todoInput.todos);
            }
          }

          // Clean up stored data
          pendingToolData.delete(toolCall.id);
        }
      }

      // ========================================
      // Permission Handling Functions
      // ========================================

      function handlePermissionRequest(request) {
        // Store in state
        state.pendingPermissions.set(request.id, request);

        // Render permission card
        var card = renderPermissionCard(request);
        messagesEl.appendChild(card);

        // Start timer countdown
        if (request.expiresAt > 0) {
          startPermissionTimer(request.id, request.expiresAt);
        }

        // Focus for keyboard navigation
        card.focus();
        state.focusedPermissionId = request.id;

        scrollToBottom();
      }

      function renderPermissionCard(request) {
        var card = document.createElement('div');
        card.className = 'permission-card pending';
        card.dataset.id = request.id;
        card.tabIndex = 0;

        var timeRemaining = request.expiresAt > 0 ? Math.max(0, request.expiresAt - Date.now()) : 0;
        var timerClass = timeRemaining > 0 && timeRemaining < 10000 ? 'critical' :
                         timeRemaining > 0 && timeRemaining < 20000 ? 'warning' : '';
        var timerText = request.expiresAt > 0 ? formatTimeRemaining(timeRemaining) : 'No timeout';

        var riskClass = request.details.riskLevel || 'medium';
        var riskLabel = riskClass.charAt(0).toUpperCase() + riskClass.slice(1);

        card.innerHTML =
          '<div class="permission-header">' +
            '<div class="permission-header-left">' +
              '<div class="permission-icon">🛡️</div>' +
              '<span class="permission-title">Permission Required</span>' +
              '<span class="permission-risk ' + riskClass + '">' + riskLabel + '</span>' +
            '</div>' +
            '<span class="permission-timer ' + timerClass + '" data-expires="' + request.expiresAt + '">' + timerText + '</span>' +
          '</div>' +
          '<div class="permission-body">' +
            '<div class="permission-description">' +
              'Mysti wants to: <strong>' + escapeHtml(request.title) + '</strong>' +
            '</div>' +
            '<div class="permission-details">' +
              renderPermissionDetails(request) +
            '</div>' +
          '</div>' +
          '<div class="permission-actions">' +
            '<button class="permission-btn approve" data-action="approve">Approve</button>' +
            '<button class="permission-btn deny" data-action="deny">Deny</button>' +
            '<button class="permission-btn always-allow" data-action="always-allow">Always Allow (Session)</button>' +
            '<span class="permission-shortcuts">' +
              '<kbd>Enter</kbd> Approve · <kbd>Esc</kbd> Deny · <kbd>Tab</kbd> Always' +
            '</span>' +
          '</div>';

        // Add click handlers to buttons
        card.querySelectorAll('.permission-btn').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var action = btn.dataset.action;
            handlePermissionAction(request.id, action);
          });
        });

        return card;
      }

      function renderPermissionDetails(request) {
        var details = request.details;
        var html = '';

        if (details.filePath) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">File:</span>' +
            '<span class="permission-detail-value">' + makeRelativePath(details.filePath) + '</span>' +
          '</div>';
        }

        if (details.command) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">Command:</span>' +
            '<span class="permission-detail-value">' + escapeHtml(details.command.substring(0, 100)) + (details.command.length > 100 ? '...' : '') + '</span>' +
          '</div>';
        }

        if (details.linesAdded !== undefined || details.linesRemoved !== undefined) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">Changes:</span>' +
            '<span class="permission-detail-value">' +
              (details.linesAdded ? '+' + details.linesAdded + ' lines ' : '') +
              (details.linesRemoved ? '-' + details.linesRemoved + ' lines' : '') +
            '</span>' +
          '</div>';
        }

        if (details.files && details.files.length > 0) {
          html += '<div class="permission-detail-row">' +
            '<span class="permission-detail-label">Files:</span>' +
            '<span class="permission-detail-value">' + details.files.length + ' files</span>' +
          '</div>';
        }

        return html || '<div class="permission-detail-row"><span class="permission-detail-value">' + escapeHtml(request.description) + '</span></div>';
      }

      function formatTimeRemaining(ms) {
        var seconds = Math.ceil(ms / 1000);
        return seconds + 's';
      }

      function startPermissionTimer(requestId, expiresAt) {
        var interval = setInterval(function() {
          var card = document.querySelector('.permission-card[data-id="' + requestId + '"]');
          if (!card || !state.pendingPermissions.has(requestId)) {
            clearInterval(interval);
            return;
          }

          var timerEl = card.querySelector('.permission-timer');
          var remaining = expiresAt - Date.now();

          if (remaining <= 0) {
            clearInterval(interval);
            return; // Backend will handle expiration
          }

          timerEl.textContent = formatTimeRemaining(remaining);
          timerEl.className = 'permission-timer ' +
            (remaining < 10000 ? 'critical' : remaining < 20000 ? 'warning' : '');
        }, 1000);
      }

      function handlePermissionAction(requestId, action) {
        var card = document.querySelector('.permission-card[data-id="' + requestId + '"]');
        if (!card) return;

        // Update visual state
        card.classList.remove('pending');
        card.classList.add(action === 'deny' ? 'denied' : 'approved');

        // Send response to extension
        postMessageWithPanelId({
          type: 'permissionResponse',
          payload: {
            requestId: requestId,
            decision: action,
            scope: action === 'always-allow' ? 'session' : 'this-action'
          }
        });

        // Remove from state
        state.pendingPermissions.delete(requestId);

        // Auto-remove card after animation
        setTimeout(function() {
          if (card.parentNode) {
            card.remove();
          }
        }, action === 'deny' ? 600 : 500);
      }

      function handlePermissionExpired(payload) {
        var card = document.querySelector('.permission-card[data-id="' + payload.requestId + '"]');
        if (!card) return;

        card.classList.remove('pending');
        card.classList.add('expired');

        // Update UI to show expired state
        var timerEl = card.querySelector('.permission-timer');
        if (timerEl) {
          timerEl.textContent = payload.behavior === 'auto-accept' ? 'Auto-approved' : 'Expired';
        }

        var actionsEl = card.querySelector('.permission-actions');
        if (actionsEl) {
          actionsEl.innerHTML = '<span style="color: var(--vscode-descriptionForeground);">Action was ' +
            (payload.behavior === 'auto-accept' ? 'automatically approved' : 'automatically denied') +
            ' due to timeout.</span>';
        }

        // Remove from state
        state.pendingPermissions.delete(payload.requestId);

        // Remove after delay
        setTimeout(function() {
          if (card.parentNode) card.remove();
        }, 3000);
      }

      // Keyboard shortcuts for permission cards
      function handlePermissionKeyboard(e) {
        var focusedCard = document.querySelector('.permission-card:focus');
        if (!focusedCard) return false;

        var requestId = focusedCard.dataset.id;

        switch(e.key) {
          case 'Enter':
            e.preventDefault();
            handlePermissionAction(requestId, 'approve');
            return true;
          case 'Escape':
            e.preventDefault();
            handlePermissionAction(requestId, 'deny');
            return true;
          case 'Tab':
            if (!e.shiftKey) {
              e.preventDefault();
              handlePermissionAction(requestId, 'always-allow');
              return true;
            }
            break;
        }
        return false;
      }

      // ========================================
      // Plan Option Selection Handlers
      // ========================================

      // Render plan options as interactive cards
      function renderPlanOptions(options, messageId, originalQuery, metaQuestions) {
        if (!options || options.length === 0) return null;

        var container = document.createElement('div');
        container.className = 'plan-options-container';
        container.setAttribute('data-message-id', messageId);
        container.setAttribute('data-original-query', originalQuery || '');

        // Render meta-questions if present (informational only)
        if (metaQuestions && metaQuestions.length > 0) {
          var metaSection = document.createElement('div');
          metaSection.className = 'meta-questions-section';
          metaSection.style.marginBottom = '16px';
          metaSection.style.padding = '12px 16px';
          metaSection.style.background = 'var(--vscode-editor-background)';
          metaSection.style.border = '1px solid var(--vscode-panel-border)';
          metaSection.style.borderRadius = '6px';
          metaSection.style.fontSize = '14px';
          metaSection.style.lineHeight = '1.5';

          metaQuestions.forEach(function(q) {
            var questionText = document.createElement('div');
            questionText.className = 'meta-question-text';
            questionText.style.marginBottom = '4px';
            questionText.textContent = q.question;
            metaSection.appendChild(questionText);
          });

          container.appendChild(metaSection);
        }

        var header = document.createElement('div');
        header.className = 'plan-options-header';
        header.innerHTML =
          '<span class="plan-options-title">Select an approach:</span>' +
          '<span class="plan-options-hint">Click to proceed with your preferred option</span>';
        container.appendChild(header);

        options.forEach(function(option, index) {
          var card = createPlanOptionCard(option, messageId, index);
          container.appendChild(card);
        });

        return container;
      }

      // Create a single plan option card
      function createPlanOptionCard(option, messageId, index) {
        var card = document.createElement('div');
        card.className = 'plan-option-card';
        card.setAttribute('data-id', option.id);
        card.setAttribute('data-color', option.color || 'blue');
        card.setAttribute('tabindex', '0');

        // Build pros list
        var prosHtml = '';
        if (option.pros && option.pros.length > 0) {
          prosHtml = '<div class="plan-option-pros">' +
            '<div class="plan-option-pros-title">✓ Pros</div>' +
            '<ul class="plan-option-list">' +
            option.pros.map(function(p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') +
            '</ul></div>';
        }

        // Build cons list
        var consHtml = '';
        if (option.cons && option.cons.length > 0) {
          consHtml = '<div class="plan-option-cons">' +
            '<div class="plan-option-cons-title">✗ Cons</div>' +
            '<ul class="plan-option-list">' +
            option.cons.map(function(p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') +
            '</ul></div>';
        }

        // Build pros/cons section
        var prosConsHtml = '';
        if (prosHtml || consHtml) {
          prosConsHtml = '<div class="plan-option-proscons">' + prosHtml + consHtml + '</div>';
        }

        card.innerHTML =
          '<div class="plan-option-header">' +
            '<div class="plan-option-icon">' + (option.icon || '📋') + '</div>' +
            '<div class="plan-option-title-area">' +
              '<div class="plan-option-title">' +
                escapeHtml(option.title) +
                '<span class="plan-option-complexity ' + (option.complexity || 'medium') + '">' +
                  (option.complexity || 'medium') +
                '</span>' +
              '</div>' +
              '<div class="plan-option-summary">' + escapeHtml(option.summary || '') + '</div>' +
            '</div>' +
          '</div>' +
          prosConsHtml +
          '<div class="plan-option-actions">' +
            '<button class="plan-execute-btn edit-auto" data-mode="edit-automatically">Execute Automatically</button>' +
            '<button class="plan-execute-btn ask-first" data-mode="ask-before-edit">Ask Before Each Edit</button>' +
            '<button class="plan-execute-btn keep-planning" data-mode="quick-plan">Keep Planning</button>' +
          '</div>' +
          '<div class="plan-custom-instructions">' +
            '<button class="custom-instructions-toggle">Add custom instructions</button>' +
            '<div class="custom-instructions-input hidden">' +
              '<textarea class="custom-instructions-textarea" placeholder="Add any additional instructions or constraints..."></textarea>' +
            '</div>' +
          '</div>';

        // Event handlers for execution buttons
        card.querySelectorAll('.plan-execute-btn').forEach(function(btn) {
          btn.onclick = function(e) {
            e.stopPropagation();
            var mode = btn.getAttribute('data-mode');
            var textarea = card.querySelector('.custom-instructions-textarea');
            var customInstructions = textarea ? textarea.value : '';
            handlePlanOptionSelect(option, messageId, mode, customInstructions);
          };
        });

        // Toggle custom instructions visibility
        var toggleBtn = card.querySelector('.custom-instructions-toggle');
        var inputDiv = card.querySelector('.custom-instructions-input');
        if (toggleBtn && inputDiv) {
          toggleBtn.onclick = function(e) {
            e.stopPropagation();
            inputDiv.classList.toggle('hidden');
            toggleBtn.textContent = inputDiv.classList.contains('hidden')
              ? 'Add custom instructions'
              : 'Hide custom instructions';
          };
        }

        card.onclick = function(e) {
          if (e.target.classList.contains('plan-execute-btn') ||
              e.target.classList.contains('custom-instructions-toggle') ||
              e.target.classList.contains('custom-instructions-textarea')) return;
          // Toggle expansion or select
          card.classList.toggle('plan-option-collapsed');
        };

        // Keyboard support - default to 'edit-automatically' on Enter
        card.onkeydown = function(e) {
          if (e.key === 'Enter' && e.target === card) {
            e.preventDefault();
            var textarea = card.querySelector('.custom-instructions-textarea');
            var customInstructions = textarea ? textarea.value : '';
            handlePlanOptionSelect(option, messageId, 'edit-automatically', customInstructions);
          }
        };

        return card;
      }

      // Handle plan option selection
      function handlePlanOptionSelect(option, messageId, executionMode, customInstructions) {
        var container = document.querySelector('.plan-options-container[data-message-id="' + messageId + '"]');
        var originalQuery = container ? container.getAttribute('data-original-query') : '';

        // Mark as selected
        var cards = document.querySelectorAll('.plan-option-card');
        cards.forEach(function(c) { c.classList.remove('selected'); });
        var selectedCard = document.querySelector('.plan-option-card[data-id="' + option.id + '"]');
        if (selectedCard) {
          selectedCard.classList.add('selected');
        }

        // Send selection to backend with execution mode and custom instructions
        postMessageWithPanelId({
          type: 'planOptionSelected',
          payload: {
            selectedPlan: option,
            originalQuery: originalQuery,
            messageId: messageId,
            executionMode: executionMode,
            customInstructions: customInstructions || ''
          }
        });
      }

      // Handle planOptions message from backend
      function handlePlanOptionsMessage(payload) {
        if (!payload.options || payload.options.length === 0) return;

        // Find the message to attach plan options to
        var messageEl = document.querySelector('.message[data-id="' + payload.messageId + '"]');
        if (!messageEl) {
          // Find most recent assistant message
          var messages = document.querySelectorAll('.message.assistant');
          messageEl = messages[messages.length - 1];
        }

        if (messageEl) {
          // Remove any existing plan options
          var existing = messageEl.querySelector('.plan-options-container');
          if (existing) existing.remove();

          // Add new plan options (with optional meta-questions)
          var planContainer = renderPlanOptions(
            payload.options,
            payload.messageId,
            payload.originalQuery,
            payload.metaQuestions
          );
          if (planContainer) {
            messageEl.appendChild(planContainer);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
      }

      // ========================================
      // Clarifying Question Input Handlers
      // ========================================

      // Render clarifying questions as interactive input cards
      function renderClarifyingQuestions(questions, messageId) {
        if (!questions || questions.length === 0) return null;

        var container = document.createElement('div');
        container.className = 'questions-container';
        container.setAttribute('data-message-id', messageId);

        var header = document.createElement('div');
        header.className = 'questions-header';
        header.innerHTML =
          '<span class="questions-title">❓ Please answer the following:</span>' +
          '<span class="questions-hint">Your answers will help guide the implementation</span>';
        container.appendChild(header);

        // Track answers for submission
        container._answers = {};

        questions.forEach(function(question) {
          var card = createQuestionCard(question, container);
          container.appendChild(card);
        });

        // Add action buttons
        var actions = document.createElement('div');
        actions.className = 'questions-actions';
        actions.innerHTML =
          '<button class="questions-skip-btn">Skip</button>' +
          '<button class="questions-submit-btn" disabled>Submit Answers</button>';

        var submitBtn = actions.querySelector('.questions-submit-btn');
        var skipBtn = actions.querySelector('.questions-skip-btn');

        submitBtn.onclick = function() {
          handleQuestionsSubmit(questions, container, messageId);
        };

        skipBtn.onclick = function() {
          container.remove();
        };

        container.appendChild(actions);
        return container;
      }

      // Create a single question card
      function createQuestionCard(question, container) {
        var card = document.createElement('div');
        card.className = 'question-card';
        card.setAttribute('data-question-id', question.id);

        var questionText = document.createElement('div');
        questionText.className = 'question-text';
        questionText.innerHTML = escapeHtml(question.question);
        if (question.required) {
          questionText.innerHTML += '<span class="question-required">*</span>';
        }
        card.appendChild(questionText);

        var optionsDiv = document.createElement('div');
        optionsDiv.className = 'question-options';

        if (question.inputType === 'text') {
          // Text input
          var textarea = document.createElement('textarea');
          textarea.className = 'question-text-input';
          textarea.placeholder = question.placeholder || 'Enter your answer...';
          textarea.oninput = function() {
            container._answers[question.id] = textarea.value;
            updateSubmitButton(container);
            card.classList.toggle('answered', textarea.value.trim() !== '');
          };
          optionsDiv.appendChild(textarea);
        } else if (question.options && question.options.length > 0) {
          // Radio, checkbox, or select options
          var inputType = question.inputType === 'checkbox' ? 'checkbox' : 'radio';
          var inputName = 'question_' + question.id;

          question.options.forEach(function(opt, optIndex) {
            var optionDiv = document.createElement('label');
            optionDiv.className = 'question-option';

            var input = document.createElement('input');
            input.type = inputType;
            input.name = inputName;
            input.value = opt.value;
            input.id = inputName + '_' + optIndex;

            input.onchange = function() {
              // Clear "Other" text if selecting a predefined option
              var otherInput = optionsDiv.querySelector('.question-other-input');
              if (otherInput && inputType === 'radio') {
                otherInput.value = '';
              }

              if (inputType === 'checkbox') {
                // Handle multi-select
                var checked = optionsDiv.querySelectorAll('input[type="checkbox"]:checked:not(.question-other-radio)');
                container._answers[question.id] = Array.from(checked).map(function(c) { return c.value; });
              } else {
                container._answers[question.id] = input.value;
              }
              // Update visual state
              optionsDiv.querySelectorAll('.question-option').forEach(function(o) {
                o.classList.remove('selected');
              });
              if (inputType === 'checkbox') {
                optionsDiv.querySelectorAll('input:checked').forEach(function(c) {
                  c.closest('.question-option').classList.add('selected');
                });
              } else {
                optionDiv.classList.add('selected');
              }
              card.classList.add('answered');
              updateSubmitButton(container);
            };

            var content = document.createElement('div');
            content.className = 'question-option-content';
            content.innerHTML =
              '<div class="question-option-label">' + escapeHtml(opt.label) + '</div>' +
              (opt.description ? '<div class="question-option-description">' + escapeHtml(opt.description) + '</div>' : '');

            optionDiv.appendChild(input);
            optionDiv.appendChild(content);
            optionsDiv.appendChild(optionDiv);
          });

          // Add "Other" option for custom input
          var otherDiv = document.createElement('label');
          otherDiv.className = 'question-option question-option-other';

          var otherRadio = document.createElement('input');
          otherRadio.type = inputType;
          otherRadio.name = inputName;
          otherRadio.value = '__other__';
          otherRadio.className = 'question-other-radio';
          otherRadio.id = inputName + '_other';

          var otherContent = document.createElement('div');
          otherContent.className = 'question-option-content question-other-content';
          otherContent.innerHTML = '<div class="question-option-label">Other:</div>';

          var otherTextInput = document.createElement('input');
          otherTextInput.type = 'text';
          otherTextInput.className = 'question-other-input';
          otherTextInput.placeholder = 'Type your own answer...';

          otherTextInput.onfocus = function() {
            otherRadio.checked = true;
            optionsDiv.querySelectorAll('.question-option').forEach(function(o) {
              o.classList.remove('selected');
            });
            otherDiv.classList.add('selected');
          };

          otherTextInput.oninput = function() {
            if (otherTextInput.value.trim()) {
              container._answers[question.id] = otherTextInput.value.trim();
              card.classList.add('answered');
            } else {
              delete container._answers[question.id];
              card.classList.remove('answered');
            }
            updateSubmitButton(container);
          };

          otherRadio.onchange = function() {
            optionsDiv.querySelectorAll('.question-option').forEach(function(o) {
              o.classList.remove('selected');
            });
            otherDiv.classList.add('selected');
            otherTextInput.focus();
            if (otherTextInput.value.trim()) {
              container._answers[question.id] = otherTextInput.value.trim();
              card.classList.add('answered');
            } else {
              delete container._answers[question.id];
              card.classList.remove('answered');
            }
            updateSubmitButton(container);
          };

          otherContent.appendChild(otherTextInput);
          otherDiv.appendChild(otherRadio);
          otherDiv.appendChild(otherContent);
          optionsDiv.appendChild(otherDiv);
        }

        card.appendChild(optionsDiv);
        return card;
      }

      // Update submit button state
      function updateSubmitButton(container) {
        var submitBtn = container.querySelector('.questions-submit-btn');
        var questions = container.querySelectorAll('.question-card');
        var allAnswered = true;

        questions.forEach(function(card) {
          var qId = card.getAttribute('data-question-id');
          var answer = container._answers[qId];
          var hasAnswer = answer !== undefined && answer !== '' &&
            (!Array.isArray(answer) || answer.length > 0);
          if (!hasAnswer) {
            allAnswered = false;
          }
        });

        submitBtn.disabled = !allAnswered;
      }

      // Handle questions submission
      function handleQuestionsSubmit(questions, container, messageId) {
        // Build a formatted message with questions and answers
        var messageParts = ['Here are my answers:\\n'];

        questions.forEach(function(q) {
          var answer = container._answers[q.id];
          if (answer !== undefined) {
            var formattedAnswer = Array.isArray(answer) ? answer.join(', ') : answer;
            messageParts.push('**' + q.question + '**');
            messageParts.push('→ ' + formattedAnswer + '\\n');
          }
        });

        messageParts.push('\\nPlease proceed based on these choices.');
        var content = messageParts.join('\\n');

        // Visual feedback - mark container as submitted
        container.classList.add('submitted');
        container.innerHTML = '<div class="questions-submitted">✓ Answers submitted</div>';

        // Put message in input and send
        inputEl.value = content;

        // Hide quick actions
        var quickActions = document.getElementById('quick-actions');
        if (quickActions) {
          quickActions.innerHTML = '';
        }

        // Send the message
        sendMessage();

        // Remove container after a short delay
        setTimeout(function() {
          container.remove();
        }, 1000);
      }

      // Handle clarifyingQuestions message from backend
      function handleClarifyingQuestionsMessage(payload) {
        if (!payload.questions || payload.questions.length === 0) return;

        // Find the message to attach questions to
        var messageEl = document.querySelector('.message[data-id="' + payload.messageId + '"]');
        if (!messageEl) {
          // Find most recent assistant message
          var messages = document.querySelectorAll('.message.assistant');
          messageEl = messages[messages.length - 1];
        }

        if (messageEl) {
          // Remove any existing questions container
          var existing = messageEl.querySelector('.questions-container');
          if (existing) existing.remove();

          // Add new questions container (before any plan options)
          var questionsContainer = renderClarifyingQuestions(payload.questions, payload.messageId);
          if (questionsContainer) {
            var planOptions = messageEl.querySelector('.plan-options-container');
            if (planOptions) {
              messageEl.insertBefore(questionsContainer, planOptions);
            } else {
              messageEl.appendChild(questionsContainer);
            }
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
      }

      // Handle native AskUserQuestion tool from Claude Code CLI
      function handleAskUserQuestionMessage(payload) {
        if (!payload || !payload.questions || payload.questions.length === 0) return;

        // Find most recent assistant message
        var messages = document.querySelectorAll('.message.assistant');
        var messageEl = messages[messages.length - 1];

        if (messageEl) {
          // Remove any existing AskUserQuestion container
          var existing = messageEl.querySelector('.ask-user-question-container');
          if (existing) existing.remove();

          // Add tabbed question UI
          var container = renderAskUserQuestionTabs(payload.toolCallId, payload.questions);
          if (container) {
            messageEl.appendChild(container);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
      }

      function renderAskUserQuestionTabs(toolCallId, questions) {
        var container = document.createElement('div');
        container.className = 'ask-user-question-container';
        container.setAttribute('data-tool-call-id', toolCallId);

        // Track answers and current tab
        container._answers = {};
        container._currentTab = 0;
        container._questions = questions;

        // Tab header
        var tabHeader = document.createElement('div');
        tabHeader.className = 'auq-tab-header';

        questions.forEach(function(q, idx) {
          var tab = document.createElement('button');
          tab.className = 'auq-tab' + (idx === 0 ? ' active' : '');
          tab.textContent = (q.header || 'Q' + (idx + 1)).substring(0, 12);
          tab.setAttribute('data-tab', idx);
          tab.onclick = function() { switchAuqTab(container, idx); };
          tabHeader.appendChild(tab);
        });

        container.appendChild(tabHeader);

        // Tab content panels
        var tabContent = document.createElement('div');
        tabContent.className = 'auq-tab-content';

        questions.forEach(function(q, idx) {
          var panel = createAuqQuestionPanel(q, idx, container);
          panel.style.display = idx === 0 ? 'block' : 'none';
          tabContent.appendChild(panel);
        });

        container.appendChild(tabContent);

        // Footer with submit button
        var footer = document.createElement('div');
        footer.className = 'auq-footer';

        var skipBtn = document.createElement('button');
        skipBtn.className = 'auq-skip-btn';
        skipBtn.textContent = 'Skip';
        skipBtn.onclick = function() { container.remove(); };

        var submitBtn = document.createElement('button');
        submitBtn.className = 'auq-submit-btn';
        submitBtn.textContent = 'Submit Answers';
        submitBtn.disabled = true;
        submitBtn.onclick = function() { submitAuqAnswers(container, toolCallId); };

        footer.appendChild(skipBtn);
        footer.appendChild(submitBtn);
        container.appendChild(footer);

        return container;
      }

      function createAuqQuestionPanel(question, index, container) {
        var panel = document.createElement('div');
        panel.className = 'auq-panel';
        panel.setAttribute('data-panel-index', index);

        // Question text
        var qText = document.createElement('div');
        qText.className = 'auq-question-text';
        qText.textContent = question.question;
        panel.appendChild(qText);

        // Options
        var optionsDiv = document.createElement('div');
        optionsDiv.className = 'auq-options';

        var inputType = question.multiSelect ? 'checkbox' : 'radio';
        var inputName = 'auq_' + index;

        question.options.forEach(function(opt) {
          var optionLabel = document.createElement('label');
          optionLabel.className = 'auq-option';

          var input = document.createElement('input');
          input.type = inputType;
          input.name = inputName;
          input.value = opt.label;

          input.onchange = function() {
            handleAuqOptionChange(container, question, index, inputType);
          };

          var optContent = document.createElement('div');
          optContent.className = 'auq-option-content';
          optContent.innerHTML =
            '<div class="auq-option-label">' + escapeHtml(opt.label) + '</div>' +
            (opt.description ? '<div class="auq-option-desc">' + escapeHtml(opt.description) + '</div>' : '');

          optionLabel.appendChild(input);
          optionLabel.appendChild(optContent);
          optionsDiv.appendChild(optionLabel);
        });

        // "Other" option with text input
        var otherLabel = document.createElement('label');
        otherLabel.className = 'auq-option auq-option-other';

        var otherInput = document.createElement('input');
        otherInput.type = inputType;
        otherInput.name = inputName;
        otherInput.value = '__other__';
        otherInput.className = 'auq-other-radio';

        var otherContent = document.createElement('div');
        otherContent.className = 'auq-option-content auq-other-content';

        var otherLabelText = document.createElement('div');
        otherLabelText.className = 'auq-option-label';
        otherLabelText.textContent = 'Other';
        otherContent.appendChild(otherLabelText);

        var otherTextInput = document.createElement('input');
        otherTextInput.type = 'text';
        otherTextInput.className = 'auq-other-text';
        otherTextInput.placeholder = 'Type your answer...';

        otherTextInput.onfocus = function() { otherInput.checked = true; };
        otherTextInput.oninput = function() {
          if (otherTextInput.value.trim()) {
            var header = question.header || 'Q' + (index + 1);
            container._answers[header] = otherTextInput.value.trim();
          } else {
            var header = question.header || 'Q' + (index + 1);
            delete container._answers[header];
          }
          updateAuqSubmitButton(container);
          updateAuqTabIndicators(container);
        };

        otherInput.onchange = function() {
          handleAuqOptionChange(container, question, index, inputType);
        };

        otherContent.appendChild(otherTextInput);
        otherLabel.appendChild(otherInput);
        otherLabel.appendChild(otherContent);
        optionsDiv.appendChild(otherLabel);

        panel.appendChild(optionsDiv);
        return panel;
      }

      function handleAuqOptionChange(container, question, index, inputType) {
        var panels = container.querySelectorAll('.auq-panel');
        var panel = panels[index];
        var header = question.header || 'Q' + (index + 1);

        if (inputType === 'checkbox') {
          var inputs = panel.querySelectorAll('input[type="checkbox"]:checked');
          var values = [];

          inputs.forEach(function(i) {
            if (i.value !== '__other__') {
              values.push(i.value);
            }
          });

          var otherRadio = panel.querySelector('.auq-other-radio:checked');
          var otherText = panel.querySelector('.auq-other-text');
          if (otherRadio && otherText && otherText.value.trim()) {
            values.push(otherText.value.trim());
          }

          if (values.length > 0) {
            container._answers[header] = values;
          } else {
            delete container._answers[header];
          }
        } else {
          // Radio - single select
          var checkedInput = panel.querySelector('input[type="radio"]:checked');
          if (checkedInput) {
            if (checkedInput.value === '__other__') {
              var otherText = panel.querySelector('.auq-other-text');
              if (otherText && otherText.value.trim()) {
                container._answers[header] = otherText.value.trim();
              } else {
                delete container._answers[header];
              }
            } else {
              container._answers[header] = checkedInput.value;
              // Auto-advance to next tab for radio buttons
              var tabCount = container.querySelectorAll('.auq-tab').length;
              if (index < tabCount - 1) {
                setTimeout(function() { switchAuqTab(container, index + 1); }, 300);
              }
            }
          }
        }

        updateAuqSubmitButton(container);
        updateAuqTabIndicators(container);
      }

      function switchAuqTab(container, index) {
        var tabs = container.querySelectorAll('.auq-tab');
        var panels = container.querySelectorAll('.auq-panel');

        tabs.forEach(function(t, i) {
          t.classList.toggle('active', i === index);
        });

        panels.forEach(function(p, i) {
          p.style.display = i === index ? 'block' : 'none';
        });

        container._currentTab = index;
      }

      function updateAuqTabIndicators(container) {
        var tabs = container.querySelectorAll('.auq-tab');
        var questions = container._questions;

        tabs.forEach(function(tab, idx) {
          var header = questions[idx].header || 'Q' + (idx + 1);
          var isAnswered = container._answers.hasOwnProperty(header);
          tab.classList.toggle('answered', isAnswered);
        });
      }

      function updateAuqSubmitButton(container) {
        var submitBtn = container.querySelector('.auq-submit-btn');
        var questions = container._questions;
        var answeredCount = 0;

        questions.forEach(function(q, idx) {
          var header = q.header || 'Q' + (idx + 1);
          if (container._answers.hasOwnProperty(header)) {
            answeredCount++;
          }
        });

        submitBtn.disabled = answeredCount < questions.length;
      }

      function submitAuqAnswers(container, toolCallId) {
        // Visual feedback
        container.classList.add('submitted');

        // Send answers to extension
        postMessageWithPanelId({
          type: 'askUserQuestionResponse',
          payload: {
            toolCallId: toolCallId,
            answers: container._answers
          }
        });

        // Replace with confirmation
        container.innerHTML = '<div class="auq-submitted"><span class="auq-check">✓</span> Answers submitted</div>';

        setTimeout(function() { container.remove(); }, 1500);
      }

      function showLoading() {
        state.isLoading = true;
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'flex';
        var loading = document.createElement('div');
        loading.className = 'loading';
        loading.innerHTML = '<div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div>';
        messagesEl.appendChild(loading);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        // Auto-hide suggestions while AI is running
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (quickActionsContainer) {
          quickActionsContainer.classList.add('ai-running');
        }
      }

      function hideLoading() {
        state.isLoading = false;
        sendBtn.style.display = 'flex';
        sendBtn.disabled = false;
        stopBtn.style.display = 'none';
        currentResponse = '';
        currentThinking = '';
        contentSegmentIndex = 0;
        claudeThinkingBuffer = ''; // Reset Claude thinking buffer
        claudeFirstSentenceComplete = false;
        var loading = messagesEl.querySelector('.loading');
        if (loading) loading.remove();

        // Show suggestions again if enabled
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (quickActionsContainer) {
          quickActionsContainer.classList.remove('ai-running');
        }
      }

      // Dynamic suggestions functions (ezorro-style cards)
      function showSuggestionSkeleton() {
        var container = document.getElementById('quick-actions');
        if (!container) return;

        // Don't show if suggestions are disabled
        if (state.agentSettings && !state.agentSettings.showSuggestions) {
          container.innerHTML = '';
          return;
        }

        container.classList.add('loading');
        container.innerHTML = '';

        for (var i = 0; i < 6; i++) {
          var card = document.createElement('div');
          card.className = 'skeleton-card';
          card.style.animationDelay = (i * 0.1) + 's';
          card.innerHTML =
            '<div class="skeleton-icon"></div>' +
            '<div class="skeleton-content">' +
              '<div class="skeleton-text" style="width: 60%;"></div>' +
              '<div class="skeleton-text" style="width: 90%;"></div>' +
            '</div>';
          container.appendChild(card);
        }
      }

      function renderSuggestions(suggestions) {
        var container = document.getElementById('quick-actions');
        if (!container) return;

        // Don't render if suggestions are disabled
        if (state.agentSettings && !state.agentSettings.showSuggestions) {
          container.innerHTML = '';
          return;
        }

        container.classList.remove('loading');
        container.innerHTML = '';

        suggestions.forEach(function(s, i) {
          var card = document.createElement('button');
          card.className = 'suggestion-card';
          card.setAttribute('data-color', s.color || 'blue');
          card.style.animationDelay = (i * 0.08) + 's';
          card.title = s.message;

          card.innerHTML =
            '<div class="suggestion-icon">' + (s.icon || '💡') + '</div>' +
            '<div class="suggestion-content">' +
              '<div class="suggestion-title">' + escapeHtml(s.title) + '</div>' +
              '<div class="suggestion-description">' + escapeHtml(s.description) + '</div>' +
            '</div>';

          card.onclick = function() {
            postMessageWithPanelId({ type: 'executeSuggestion', payload: s });
          };

          container.appendChild(card);
        });
      }

      function finalizeStreamingMessage(msg) {
        var streamingEl = messagesEl.querySelector('.message.streaming');
        if (streamingEl) {
          // Reset the Claude thinking buffer
          flushThinkingBuffer();

          // Remove streaming class from thinking block
          var streamingThinking = streamingEl.querySelector('.thinking-block.streaming-thinking');
          if (streamingThinking) {
            streamingThinking.classList.remove('streaming-thinking');
          }

          streamingEl.classList.remove('streaming');
          streamingEl.dataset.id = msg.id;

          // Re-render all content segments with final markdown
          var messageBody = streamingEl.querySelector('.message-body');
          if (messageBody && msg.content) {
            var segments = messageBody.querySelectorAll('.message-content');
            if (segments.length === 1) {
              // Single segment - render full content
              segments[0].innerHTML = formatContent(msg.content);
            }
            // For multiple segments, leave them as-is (already rendered during streaming)
          }
        }
      }

      function showError(error) {
        var div = document.createElement('div');
        div.className = 'message error';
        div.innerHTML = '<div class="message-content" style="color: var(--vscode-errorForeground);">Error: ' + escapeHtml(error) + '</div>';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function showAuthError(data) {
        var div = document.createElement('div');
        div.className = 'message error auth-error';
        div.innerHTML = '<div class="message-content">' +
          '<div style="color: var(--vscode-errorForeground); margin-bottom: 8px;">' +
            '<strong>Authentication Required</strong>' +
          '</div>' +
          '<p style="margin: 8px 0;">' + escapeHtml(data.providerName) + ' is not authenticated.</p>' +
          '<div style="margin: 12px 0; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; font-family: monospace;">' +
            '<strong>To authenticate, run:</strong><br>' +
            '<code style="color: var(--vscode-textPreformat-foreground);">' + escapeHtml(data.authCommand) + '</code>' +
          '</div>' +
          '<button id="auth-terminal-btn" ' +
            'style="padding: 6px 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px;">' +
            'Open Terminal & Authenticate' +
          '</button>' +
        '</div>';
        messagesEl.appendChild(div);

        // Add event listener (CSP compliant - no inline onclick)
        var authBtn = div.querySelector('#auth-terminal-btn');
        if (authBtn) {
          authBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openTerminal', payload: data.authCommand });
          });
        }

        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function clearMessages() {
        messagesEl.innerHTML = '<div class="welcome-container"><div class="welcome-header"><img src="' + LOGO_URI + '" alt="Mysti" class="welcome-logo" /><h2>Welcome to Mysti</h2><p>Your AI coding team. Choose an action or ask anything!</p></div><div class="welcome-suggestions" id="welcome-suggestions"></div></div>';
        renderWelcomeSuggestions();
        // Reset all streaming buffers
        currentResponse = '';
        currentThinking = '';
        contentSegmentIndex = 0;
        claudeThinkingBuffer = '';
        claudeFirstSentenceComplete = false;
        brainstormClaudeThinkingBuffer = '';
        brainstormFirstSentenceComplete = false;
      }

      function updateContext(context) {
        state.context = context;
        if (!contextItems) return;

        if (context.length === 0) {
          contextItems.innerHTML = '<div class="context-empty">Drop files here or click + to add context</div>';
          return;
        }

        contextItems.innerHTML = context.map(function(item) {
          return '<div class="context-item" data-id="' + item.id + '"><span class="context-item-path" title="' + item.path + '">' + getFileName(item.path) + (item.type === 'selection' ? ' (selection)' : '') + '</span><button class="context-item-remove" data-id="' + item.id + '">x</button></div>';
        }).join('');

        contextItems.querySelectorAll('.context-item-remove').forEach(function(btn) {
          btn.addEventListener('click', function() {
            postMessageWithPanelId({ type: 'removeFromContext', payload: btn.dataset.id });
          });
        });
      }

      function updateModeIndicator() {
        var modeLabels = {
          'default': 'Default',
          'ask-before-edit': 'Ask Before Edit',
          'edit-automatically': 'Auto Edit',
          'quick-plan': 'Quick Plan',
          'detailed-plan': 'Detailed Plan'
        };
        modeIndicator.textContent = modeLabels[state.settings.mode] || state.settings.mode;
      }

      /**
       * Update the agent settings UI from state
       */
      function updateAgentSettingsUI() {
        var autoSuggestToggle = document.getElementById('auto-suggest-toggle');
        var tokenLimitToggle = document.getElementById('token-limit-toggle');
        var tokenBudgetInput = document.getElementById('token-budget-input');
        var tokenBudgetSection = document.getElementById('token-budget-section');

        if (autoSuggestToggle) {
          if (state.agentSettings.autoSuggest) {
            autoSuggestToggle.classList.add('active');
          } else {
            autoSuggestToggle.classList.remove('active');
          }
        }

        // Token limit is enabled when maxTokenBudget > 0
        var tokenLimitEnabled = state.agentSettings.maxTokenBudget > 0;
        state.agentSettings.tokenLimitEnabled = tokenLimitEnabled;

        if (tokenLimitToggle) {
          if (tokenLimitEnabled) {
            tokenLimitToggle.classList.add('active');
          } else {
            tokenLimitToggle.classList.remove('active');
          }
        }

        if (tokenBudgetSection) {
          if (tokenLimitEnabled) {
            tokenBudgetSection.classList.remove('hidden');
          } else {
            tokenBudgetSection.classList.add('hidden');
          }
        }

        if (tokenBudgetInput && tokenLimitEnabled) {
          tokenBudgetInput.value = String(state.agentSettings.maxTokenBudget);
        }

        // Suggestions toggle
        var suggestionsToggle = document.getElementById('suggestions-toggle');
        var quickActionsContainer = document.getElementById('quick-actions-container');
        if (suggestionsToggle) {
          if (state.agentSettings.showSuggestions) {
            suggestionsToggle.classList.add('active');
          } else {
            suggestionsToggle.classList.remove('active');
          }
        }
        if (quickActionsContainer) {
          if (state.agentSettings.showSuggestions) {
            quickActionsContainer.classList.remove('hidden');
          } else {
            quickActionsContainer.classList.add('hidden');
          }
        }
      }

      /**
       * Update the context usage pie chart
       * @param usedTokens - Number of tokens used (input_tokens from response)
       * @param contextWindow - Context window size (null to keep existing)
       */
      function updateContextUsage(usedTokens, contextWindow) {
        if (contextWindow !== null && contextWindow !== undefined) {
          state.contextUsage.contextWindow = contextWindow;
        }
        state.contextUsage.usedTokens = usedTokens || 0;

        var percentage = Math.min(100, Math.round((state.contextUsage.usedTokens / state.contextUsage.contextWindow) * 100));
        state.contextUsage.percentage = percentage;

        var pieFill = document.getElementById('context-pie-fill');
        var usageText = document.getElementById('context-usage-text');
        var usageContainer = document.getElementById('context-usage');

        if (pieFill && usageText && usageContainer) {
          // Calculate pie slice path
          // Center at (16,16), radius 14, starting from top (12 o'clock)
          var cx = 16, cy = 16, r = 14;
          if (percentage <= 0) {
            pieFill.setAttribute('d', '');
          } else if (percentage >= 100) {
            // Full circle
            pieFill.setAttribute('d', 'M ' + cx + ' ' + (cy - r) + ' A ' + r + ' ' + r + ' 0 1 1 ' + (cx - 0.001) + ' ' + (cy - r) + ' Z');
          } else {
            // Calculate end point of arc
            var angle = (percentage / 100) * 2 * Math.PI;
            var endX = cx + r * Math.sin(angle);
            var endY = cy - r * Math.cos(angle);
            var largeArc = percentage > 50 ? 1 : 0;
            // Path: Move to center, line to top, arc to end point, close
            var d = 'M ' + cx + ' ' + cy + ' L ' + cx + ' ' + (cy - r) + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + endX + ' ' + endY + ' Z';
            pieFill.setAttribute('d', d);
          }

          // Update percentage text
          usageText.textContent = percentage + '%';

          // Update tooltip
          var usedK = Math.round(state.contextUsage.usedTokens / 1000);
          var totalK = Math.round(state.contextUsage.contextWindow / 1000);
          usageContainer.title = 'Context usage: ' + usedK + 'k / ' + totalK + 'k tokens (' + percentage + '%)';

          // Update color based on usage level
          usageContainer.classList.remove('warning', 'danger');
          if (percentage >= 90) {
            usageContainer.classList.add('danger');
          } else if (percentage >= 70) {
            usageContainer.classList.add('warning');
          }
        }
      }

      /**
       * Reset context usage (for new conversations)
       */
      function resetContextUsage() {
        state.contextUsage.usedTokens = 0;
        state.contextUsage.percentage = 0;
        updateContextUsage(0, null);
      }

      function showSlashMenu() {
        slashMenu.classList.remove('hidden');
      }

      function hideSlashMenu() {
        slashMenu.classList.add('hidden');
      }

      // Autocomplete helper functions
      function updateGhostText(suggestion) {
        if (!autocompleteGhostEl || !suggestion) {
          clearAutocomplete();
          return;
        }
        // Show the current text plus the suggested completion in ghost style
        var currentText = inputEl.value;
        // Create ghost content: invisible current text + visible suggestion
        var invisiblePart = '<span style="visibility: hidden;">' + escapeHtml(currentText) + '</span>';
        var ghostPart = '<span class="ghost-text">' + escapeHtml(suggestion) + '</span>';
        autocompleteGhostEl.innerHTML = invisiblePart + ghostPart;
        state.autocompleteSuggestion = suggestion;
      }

      function clearAutocomplete() {
        if (autocompleteGhostEl) {
          autocompleteGhostEl.innerHTML = '';
        }
        state.autocompleteSuggestion = null;
        state.autocompleteType = null;
        // Cancel any pending autocomplete request
        postMessageWithPanelId({ type: 'cancelAutocomplete' });
      }

      function acceptAutocomplete() {
        if (state.autocompleteSuggestion) {
          // Append the suggestion to the input
          inputEl.value = inputEl.value + state.autocompleteSuggestion;
          // Update textarea height
          autoResizeTextarea();
          // Clear the ghost text
          clearAutocomplete();
          // Focus at the end
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }
      }

      // Auto-resize textarea to fit content up to 10 lines (240px max)
      function autoResizeTextarea() {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 240) + 'px';
      }

      function getFileName(path) {
        return path.split(/[\\\\/]/).pop();
      }

      function getModelDisplayName(modelId) {
        if (state.providers) {
          for (var i = 0; i < state.providers.length; i++) {
            var provider = state.providers[i];
            for (var j = 0; j < provider.models.length; j++) {
              if (provider.models[j].id === modelId) {
                return provider.models[j].name;
              }
            }
          }
        }
        // Fallback: format model ID nicely
        return modelId.replace(/-/g, ' ').replace(/\\d{8}$/, '').trim();
      }

      function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // ========================================
      // Edit Report Card Functions
      // ========================================

      var FILE_EDIT_TOOLS = ['write', 'edit', 'multiwrite', 'notebookedit'];

      function isFileEditTool(toolName) {
        return FILE_EDIT_TOOLS.includes((toolName || '').toLowerCase());
      }

      // Helper to split content into lines (handles various newline formats)
      function splitLines(str) {
        if (!str) return [];
        // Handle both actual newlines and escaped \\n sequences
        return String(str).split(/\\r?\\n|\\\\n/);
      }

      // GitHub-style diff: identify context lines (unchanged) vs actual changes
      function computeLineDiff(oldLines, newLines) {
        var result = [];

        // Find common prefix (unchanged lines at start)
        var prefixLen = 0;
        while (prefixLen < oldLines.length && prefixLen < newLines.length
               && oldLines[prefixLen] === newLines[prefixLen]) {
          prefixLen++;
        }

        // Find common suffix (unchanged lines at end)
        var suffixLen = 0;
        while (suffixLen < (oldLines.length - prefixLen)
               && suffixLen < (newLines.length - prefixLen)
               && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
          suffixLen++;
        }

        // Add context lines from prefix (5 lines before changes)
        var contextBefore = Math.min(prefixLen, 5);
        for (var i = prefixLen - contextBefore; i < prefixLen; i++) {
          result.push({ type: 'context', content: oldLines[i], lineNum: i + 1 });
        }

        // Add deletions (lines only in old)
        for (var i = prefixLen; i < oldLines.length - suffixLen; i++) {
          result.push({ type: 'deletion', content: oldLines[i], lineNum: i + 1 });
        }

        // Add additions (lines only in new)
        for (var i = prefixLen; i < newLines.length - suffixLen; i++) {
          result.push({ type: 'addition', content: newLines[i], lineNum: i + 1 });
        }

        // Add context lines from suffix (5 lines after changes)
        var contextAfter = Math.min(suffixLen, 5);
        var suffixStart = newLines.length - suffixLen;
        for (var i = suffixStart; i < suffixStart + contextAfter; i++) {
          result.push({ type: 'context', content: newLines[i], lineNum: i + 1 });
        }

        return result;
      }

      // Detect programming language from file extension for syntax highlighting
      function getLanguageFromPath(filePath) {
        var ext = (filePath || '').split('.').pop().toLowerCase();
        var langMap = {
          'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript',
          'ts': 'typescript', 'tsx': 'typescript',
          'py': 'python',
          'go': 'go',
          'css': 'css', 'scss': 'scss',
          'html': 'html', 'htm': 'html',
          'json': 'json',
          'md': 'markdown',
          'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
          'xml': 'xml', 'svg': 'xml',
          'yaml': 'yaml', 'yml': 'yaml',
          'rs': 'rust',
          'rb': 'ruby',
          'php': 'php',
          'java': 'java',
          'c': 'c', 'h': 'c',
          'cpp': 'cpp', 'cc': 'cpp', 'hpp': 'cpp',
          'cs': 'csharp',
          'swift': 'swift',
          'kt': 'kotlin',
          'sql': 'sql'
        };
        return langMap[ext] || 'javascript';
      }

      // Highlight code content using Prism.js if available
      function highlightCode(content, language) {
        if (typeof Prism !== 'undefined' && Prism.languages && Prism.languages[language]) {
          try {
            return Prism.highlight(content, Prism.languages[language], language);
          } catch (e) {
            return escapeHtml(content);
          }
        }
        return escapeHtml(content);
      }

      function parseFileEditInfo(toolName, input, output) {
        var info = {
          action: 'edit',
          filePath: '',
          fileName: '',
          linesAdded: 0,
          linesRemoved: 0,
          diffLines: []
        };

        // Extract file path (convert to relative for display)
        var absolutePath = input.file_path || input.path || input.notebook_path || '';
        info.filePath = makeRelativePath(absolutePath);
        if (info.filePath) {
          var parts = info.filePath.replace(/\\\\/g, '/').split('/');
          info.fileName = parts.pop() || info.filePath;
        }

        var toolLower = (toolName || '').toLowerCase();

        // Determine action type based on tool and content
        if (toolLower === 'write') {
          // Write tool creates or overwrites a file
          info.action = 'create';

          // For Write, entire content is new
          if (input.content) {
            var lines = splitLines(input.content);
            info.linesAdded = lines.length;
            info.diffLines = lines.map(function(line, idx) {
              return { type: 'addition', content: line, lineNum: idx + 1 };
            });
          }
        } else if (toolLower === 'edit') {
          info.action = 'edit';

          // Edit tool has old_string and new_string
          var oldStr = input.old_string || '';
          var newStr = input.new_string || '';

          var oldLines = splitLines(oldStr);
          var newLines = splitLines(newStr);

          // Filter out empty lines that result from empty strings
          if (oldLines.length === 1 && oldLines[0] === '') oldLines = [];
          if (newLines.length === 1 && newLines[0] === '') newLines = [];

          // Use GitHub-style diff algorithm to identify context vs changes
          info.diffLines = computeLineDiff(oldLines, newLines);

          // Count actual additions and deletions (not context lines)
          info.linesAdded = info.diffLines.filter(function(l) { return l.type === 'addition'; }).length;
          info.linesRemoved = info.diffLines.filter(function(l) { return l.type === 'deletion'; }).length;
        } else if (toolLower === 'multiwrite') {
          info.action = 'create';
          // MultiWrite may have multiple files - just show stats
          if (input.content) {
            var lines = splitLines(input.content);
            info.linesAdded = lines.length;
          }
        } else if (toolLower === 'notebookedit') {
          info.action = 'edit';
          if (input.new_source) {
            var lines = splitLines(input.new_source);
            info.linesAdded = lines.length;
            info.diffLines = lines.map(function(line, idx) {
              return { type: 'addition', content: line, lineNum: idx + 1 };
            });
          }
        }

        return info;
      }

      // Generate unique ID from todo content
      function generateTodoId(content) {
        var hash = 0;
        for (var i = 0; i < content.length; i++) {
          hash = ((hash << 5) - hash) + content.charCodeAt(i);
          hash |= 0;
        }
        return 'todo-' + Math.abs(hash);
      }

      // Update sticky progress count display
      function updateStickyProgressCount() {
        var container = document.getElementById('sticky-progress-container');
        if (!container) return;
        var countEl = container.querySelector('.sticky-progress-count');
        if (countEl) {
          countEl.textContent = stuckTodos.size + ' in progress';
        }
      }

      // Stick a todo item to the top
      function stickTodoItem(originalEl, todoId) {
        if (stuckTodos.has(todoId)) return; // Already stuck

        var container = document.getElementById('sticky-progress-container');
        if (!container) return;
        var listEl = container.querySelector('.sticky-progress-list');
        if (!listEl) return;

        // Mark original as stuck
        originalEl.classList.add('is-stuck');

        // Get the display text (activeForm if available)
        var todoContent = originalEl.getAttribute('data-todo-content') || '';
        var activeForm = originalEl.getAttribute('data-todo-active-form') || todoContent;

        // Create clone for sticky container
        var spinnerSvg = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="28" stroke-dashoffset="8"/></svg>';

        var cloneEl = document.createElement('div');
        cloneEl.className = 'stuck-todo-item';
        cloneEl.setAttribute('data-todo-id', todoId);
        cloneEl.innerHTML =
          '<span class="stuck-todo-icon">' + spinnerSvg + '</span>' +
          '<span class="stuck-todo-text">' + escapeHtml(activeForm) + '</span>';

        listEl.appendChild(cloneEl);

        // Show container
        container.classList.add('has-items');
        updateStickyProgressCount();

        // Track stuck item
        stuckTodos.set(todoId, { originalEl: originalEl, cloneEl: cloneEl });
      }

      // Unstick a todo item (animate it back)
      function unstickTodoItem(todoId) {
        var stuckItem = stuckTodos.get(todoId);
        if (!stuckItem) return;

        var cloneEl = stuckItem.cloneEl;
        var originalEl = stuckItem.originalEl;

        // Animate out
        cloneEl.classList.add('unsticking');

        cloneEl.addEventListener('animationend', function() {
          // Remove clone
          if (cloneEl.parentNode) {
            cloneEl.parentNode.removeChild(cloneEl);
          }

          // Restore original visibility
          originalEl.classList.remove('is-stuck');

          // Clean up tracking
          stuckTodos.delete(todoId);

          // Hide container if empty
          var container = document.getElementById('sticky-progress-container');
          if (container && stuckTodos.size === 0) {
            container.classList.remove('has-items');
          }
          updateStickyProgressCount();
        }, { once: true });
      }

      // Handle completion of a stuck todo
      function completeStuckTodo(todoId) {
        var stuckItem = stuckTodos.get(todoId);
        if (!stuckItem) return;

        var cloneEl = stuckItem.cloneEl;

        // Change icon to checkmark
        var checkSvg = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';
        var iconEl = cloneEl.querySelector('.stuck-todo-icon');
        if (iconEl) {
          iconEl.innerHTML = checkSvg;
        }

        // Play completion animation
        cloneEl.classList.add('completing');

        cloneEl.addEventListener('animationend', function() {
          // Remove clone
          if (cloneEl.parentNode) {
            cloneEl.parentNode.removeChild(cloneEl);
          }

          // Disconnect observer
          var observer = stuckTodoObservers.get(todoId);
          if (observer) {
            observer.disconnect();
            stuckTodoObservers.delete(todoId);
          }

          // Clean up tracking
          stuckTodos.delete(todoId);

          // Hide container if empty
          var container = document.getElementById('sticky-progress-container');
          if (container && stuckTodos.size === 0) {
            container.classList.remove('has-items');
          }
          updateStickyProgressCount();
        }, { once: true });
      }

      // Setup IntersectionObserver for a todo element
      function setupTodoIntersectionObserver(todoElement) {
        var todoId = todoElement.getAttribute('data-todo-id');
        if (!todoId || stuckTodoObservers.has(todoId)) return;

        var messagesEl = document.getElementById('messages');
        if (!messagesEl) return;

        var observer = new IntersectionObserver(function(entries) {
          entries.forEach(function(entry) {
            if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
              // Item has scrolled above viewport - stick it
              stickTodoItem(todoElement, todoId);
            } else if (entry.isIntersecting && stuckTodos.has(todoId)) {
              // Item is back in view - unstick it
              unstickTodoItem(todoId);
            }
          });
        }, {
          root: messagesEl,
          threshold: 0,
          rootMargin: '-1px 0px 0px 0px' // Trigger right at the top edge
        });

        observer.observe(todoElement);
        stuckTodoObservers.set(todoId, observer);
      }

      // Find and observe all in-progress todo items
      function observeInProgressTodos() {
        // Clean up existing observers for items that are no longer in_progress
        var currentInProgressIds = new Set();
        var inProgressItems = document.querySelectorAll('.todo-item.in_progress');

        inProgressItems.forEach(function(item) {
          var todoId = item.getAttribute('data-todo-id');
          if (todoId) {
            currentInProgressIds.add(todoId);
            // Setup observer if not already observing
            if (!stuckTodoObservers.has(todoId)) {
              setupTodoIntersectionObserver(item);
            }
          }
        });

        // Disconnect observers for items no longer in_progress
        stuckTodoObservers.forEach(function(observer, todoId) {
          if (!currentInProgressIds.has(todoId)) {
            observer.disconnect();
            stuckTodoObservers.delete(todoId);
            // Also remove from stuckTodos if present
            if (stuckTodos.has(todoId)) {
              var stuckItem = stuckTodos.get(todoId);
              if (stuckItem.cloneEl && stuckItem.cloneEl.parentNode) {
                stuckItem.cloneEl.parentNode.removeChild(stuckItem.cloneEl);
              }
              if (stuckItem.originalEl) {
                stuckItem.originalEl.classList.remove('is-stuck');
              }
              stuckTodos.delete(todoId);
            }
          }
        });

        // Hide container if no stuck items
        var container = document.getElementById('sticky-progress-container');
        if (container && stuckTodos.size === 0) {
          container.classList.remove('has-items');
        }
      }

      // Initialize sticky progress observation with MutationObserver
      function initStickyProgressObserver() {
        var messagesEl = document.getElementById('messages');
        if (!messagesEl) return;

        // Observe for new todo items being added
        var mutationObserver = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
              if (node.nodeType === 1) { // Element node
                // Check for todo lists
                var todoLists = node.querySelectorAll ? node.querySelectorAll('.todo-list') : [];
                if (todoLists.length > 0 || (node.classList && node.classList.contains('todo-list'))) {
                  setTimeout(observeInProgressTodos, 50);
                }
              }
            });
          });
        });

        mutationObserver.observe(messagesEl, {
          childList: true,
          subtree: true
        });
      }

      function renderTodoList(todos) {
        if (!todos || !todos.length) return '';

        var html = '<div class="todo-list">';
        todos.forEach(function(todo) {
          var statusIcon = '';
          if (todo.status === 'completed') {
            statusIcon = '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';
          } else if (todo.status === 'in_progress') {
            statusIcon = '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="28" stroke-dashoffset="8"/></svg>';
          } else {
            statusIcon = '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
          }

          var todoId = generateTodoId(todo.content);
          var activeForm = todo.activeForm || todo.content;
          var displayText = todo.status === 'in_progress' ? activeForm : todo.content;

          html += '<div class="todo-item ' + todo.status + '" ' +
            'data-todo-id="' + todoId + '" ' +
            'data-todo-content="' + escapeHtml(todo.content) + '" ' +
            'data-todo-active-form="' + escapeHtml(activeForm) + '">' +
            '<span class="todo-status ' + todo.status + '">' + statusIcon + '</span>' +
            '<span class="todo-content">' + escapeHtml(displayText) + '</span>' +
          '</div>';
        });
        html += '</div>';
        return html;
      }

      // Update sticky todo progress indicator - now uses scroll-aware sticking
      function updateStickyTodos(todos) {
        // Build set of current in-progress todo contents
        var newInProgressContents = new Set();
        var newInProgressMap = new Map(); // content -> todo

        (todos || []).forEach(function(todo) {
          if (todo.status === 'in_progress') {
            newInProgressContents.add(todo.content);
            newInProgressMap.set(todo.content, todo);
          }
        });

        // Check for completed items that were stuck
        stuckTodos.forEach(function(stuckItem, todoId) {
          var content = stuckItem.originalEl.getAttribute('data-todo-content');
          if (content && !newInProgressContents.has(content)) {
            // This item was completed - animate it out
            completeStuckTodo(todoId);
          }
        });

        // Update previous state for next comparison
        previousTodoContents = newInProgressContents;
        currentTodos = todos || [];

        // Re-observe any new in-progress items (after a small delay for DOM update)
        setTimeout(function() {
          observeInProgressTodos();
        }, 50);
      }

      function renderEditReportCard(editInfo, thinkingContent) {
        var actionClass = editInfo.action;
        var actionLabel = editInfo.action.charAt(0).toUpperCase() + editInfo.action.slice(1);
        var bullet = '●';

        // Chevron SVG
        var chevronSvg = '<svg class="edit-report-chevron" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

        var html = '<div class="edit-report-card" data-file-path="' + escapeHtml(editInfo.filePath) + '">';

        // Thinking section (if available)
        if (thinkingContent && thinkingContent.trim()) {
          html += '<div class="edit-report-thinking">' +
            '<div class="edit-report-thinking-header">Thinking</div>' +
            '<div class="edit-report-thinking-content">' + escapeHtml(thinkingContent) + '</div>' +
          '</div>';
        }

        // File header
        html += '<div class="edit-report-file-header">' +
          '<span class="edit-report-bullet ' + actionClass + '">' + bullet + '</span>' +
          '<span class="edit-report-action ' + actionClass + '">' + actionLabel + '</span>' +
          '<span class="edit-report-filename">' + escapeHtml(editInfo.fileName) + '</span>' +
          chevronSvg +
        '</div>';

        // Stats line with tree connector
        var statsText = '';
        if (editInfo.linesAdded > 0) {
          statsText += '<span class="edit-report-stats-added">Added ' + editInfo.linesAdded + ' line' + (editInfo.linesAdded !== 1 ? 's' : '') + '</span>';
        }
        if (editInfo.linesRemoved > 0) {
          if (statsText) statsText += ', ';
          statsText += '<span class="edit-report-stats-removed">Removed ' + editInfo.linesRemoved + ' line' + (editInfo.linesRemoved !== 1 ? 's' : '') + '</span>';
        }
        if (!statsText) {
          statsText = 'No changes';
        }

        html += '<div class="edit-report-stats">' +
          '<span class="edit-report-stats-tree">└</span> ' + statsText +
        '</div>';

        // Diff content (collapsed by default)
        html += '<div class="edit-report-diff">';

        var maxPreviewLines = 20;
        var diffLines = editInfo.diffLines || [];
        var showLines = diffLines.slice(0, maxPreviewLines);
        var language = getLanguageFromPath(editInfo.filePath);

        showLines.forEach(function(line) {
          var prefix = line.type === 'addition' ? '+' : (line.type === 'deletion' ? '-' : ' ');
          var lineNum = line.lineNum ? line.lineNum : '';
          var highlightedContent = highlightCode(line.content, language);
          html += '<div class="edit-report-diff-line ' + line.type + '">' +
            '<span class="edit-report-diff-linenum">' + lineNum + '</span>' +
            '<span class="edit-report-diff-prefix">' + prefix + '</span>' +
            '<span class="edit-report-diff-content">' + highlightedContent + '</span>' +
          '</div>';
        });

        if (diffLines.length > maxPreviewLines) {
          html += '<div class="edit-report-show-more" data-full-diff="' + encodeURIComponent(JSON.stringify(diffLines)) + '" data-language="' + language + '">' +
            '... ' + (diffLines.length - maxPreviewLines) + ' more lines' +
          '</div>';
        }

        html += '</div>'; // end diff

        // Actions
        html += '<div class="edit-report-actions">' +
          '<button class="edit-report-btn edit-report-btn-revert" title="Revert changes (git checkout)">Revert</button>' +
          '<button class="edit-report-btn edit-report-btn-copy" title="Copy file path">Copy path</button>' +
          '<button class="edit-report-btn edit-report-btn-open" title="Open file in editor">Open file</button>' +
        '</div>';

        html += '</div>'; // end card

        return html;
      }

      function isDiffContent(content) {
        var lines = content.split('\\n');
        var diffMarkers = 0;
        var checkLines = Math.min(lines.length, 20);

        for (var i = 0; i < checkLines; i++) {
          var line = lines[i];
          // Exclude CSS custom properties (--var) from diff detection
          if (line.startsWith('+') || (line.startsWith('-') && !line.startsWith('--')) || line.startsWith('@@')) {
            diffMarkers++;
          }
        }
        return diffMarkers > checkLines * 0.2;
      }

      function formatDiffContent(content) {
        var lines = content.split('\\n');
        var html = '';

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var lineClass = 'diff-line';

          if (line.startsWith('+') && !line.startsWith('+++')) {
            lineClass += ' diff-addition';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            lineClass += ' diff-deletion';
          } else if (line.startsWith('@@')) {
            lineClass += ' diff-hunk';
          } else if (line.startsWith('diff ') || line.startsWith('index ') ||
                     line.startsWith('---') || line.startsWith('+++')) {
            lineClass += ' diff-header';
          }

          html += '<div class="' + lineClass + '">' + escapeHtml(line) + '</div>';
        }
        return html;
      }

      function formatContent(content) {
        if (!content) return '';

        // Use marked for full markdown parsing if available
        if (typeof marked !== 'undefined') {
          try {
            var html = marked.parse(content);

            // Schedule syntax highlighting and mermaid rendering
            setTimeout(function() {
              if (typeof Prism !== 'undefined') {
                Prism.highlightAll();
              }
              renderMermaidDiagrams();
            }, 0);

            return html;
          } catch (e) {
            console.error('Markdown parse error:', e);
          }
        }

        // Fallback to basic formatting if marked is not available
        var html = escapeHtml(content);
        html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code class="language-$1">$2</code></pre>');
        html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        html = html.replace(/\\n/g, '<br>');
        return html;
      }

      document.addEventListener('click', function(e) {
        if (!slashCmdBtn.contains(e.target) && !slashMenu.contains(e.target)) {
          hideSlashMenu();
        }

        // Close agent menu when clicking outside
        if (agentSelectBtn && agentMenu && !agentSelectBtn.contains(e.target) && !agentMenu.contains(e.target)) {
          agentMenu.classList.add('hidden');
        }

        // Handle copy button click
        var copyBtn = e.target.closest('.tool-call-copy');
        if (copyBtn) {
          e.stopPropagation();
          var toolCall = copyBtn.closest('.tool-call');
          if (toolCall && toolCall.dataset.summary) {
            postMessageWithPanelId({
              type: 'copyToClipboard',
              payload: toolCall.dataset.summary
            });
            // Visual feedback
            copyBtn.classList.add('copied');
            setTimeout(function() {
              copyBtn.classList.remove('copied');
            }, 1500);
          }
          return;
        }

        // Handle tool call expand/collapse
        var toolCallHeader = e.target.closest('.tool-call-header');
        if (toolCallHeader) {
          var toolCall = toolCallHeader.closest('.tool-call');
          if (toolCall) {
            toolCall.classList.toggle('expanded');
          }
        }

        // File Edit Card: Show more button
        var showMoreBtn = e.target.closest('.file-edit-show-more');
        if (showMoreBtn) {
          expandFileEditCard(showMoreBtn);
          return;
        }

        // File Edit Card: Collapse/expand toggle
        var collapseBtn = e.target.closest('.file-edit-collapse-btn');
        if (collapseBtn) {
          var card = collapseBtn.closest('.file-edit-card');
          if (card) {
            card.classList.toggle('collapsed');
          }
          return;
        }

        // File Edit Card: Revert button
        var revertBtn = e.target.closest('.file-edit-revert');
        if (revertBtn) {
          handleFileEditRevert(revertBtn);
          return;
        }

        // File Edit Card: Review button
        var reviewBtn = e.target.closest('.file-edit-review');
        if (reviewBtn) {
          handleFileEditReview(reviewBtn);
          return;
        }

        // ========================================
        // Edit Report Card Click Handlers
        // ========================================

        // Edit Report: Expand/collapse diff via file header click
        var editReportFileHeader = e.target.closest('.edit-report-file-header');
        if (editReportFileHeader) {
          var editReportCard = editReportFileHeader.closest('.edit-report-card');
          if (editReportCard) {
            editReportCard.classList.toggle('expanded');
          }
          return;
        }

        // Edit Report: Expand/collapse thinking section
        var editReportThinkingHeader = e.target.closest('.edit-report-thinking-header');
        if (editReportThinkingHeader) {
          var thinkingSection = editReportThinkingHeader.closest('.edit-report-thinking');
          if (thinkingSection) {
            thinkingSection.classList.toggle('expanded');
          }
          return;
        }

        // Edit Report: Copy path button
        var editReportCopyBtn = e.target.closest('.edit-report-btn-copy');
        if (editReportCopyBtn) {
          var editCard = editReportCopyBtn.closest('.edit-report-card');
          if (editCard && editCard.dataset.filePath) {
            postMessageWithPanelId({
              type: 'copyToClipboard',
              payload: editCard.dataset.filePath
            });
            // Visual feedback
            var originalText = editReportCopyBtn.textContent;
            editReportCopyBtn.textContent = 'Copied!';
            setTimeout(function() {
              editReportCopyBtn.textContent = originalText;
            }, 1500);
          }
          return;
        }

        // Edit Report: Open file button
        var editReportOpenBtn = e.target.closest('.edit-report-btn-open');
        if (editReportOpenBtn) {
          var editCard = editReportOpenBtn.closest('.edit-report-card');
          if (editCard && editCard.dataset.filePath) {
            // Use stored line number to open at the changed location (convert to 0-based)
            var lineNum = editCard.dataset.lineNumber ? parseInt(editCard.dataset.lineNumber, 10) - 1 : undefined;
            postMessageWithPanelId({
              type: 'openFile',
              payload: { path: editCard.dataset.filePath, line: lineNum }
            });
          }
          return;
        }

        // Edit Report: Revert button
        var editReportRevertBtn = e.target.closest('.edit-report-btn-revert');
        if (editReportRevertBtn) {
          var editCard = editReportRevertBtn.closest('.edit-report-card');
          if (editCard && editCard.dataset.filePath) {
            editReportRevertBtn.textContent = 'Reverting...';
            editReportRevertBtn.disabled = true;
            postMessageWithPanelId({
              type: 'revertFileEdit',
              payload: { path: editCard.dataset.filePath }
            });
          }
          return;
        }

        // Edit Report: Show more lines in diff
        var editReportShowMore = e.target.closest('.edit-report-show-more');
        if (editReportShowMore) {
          expandEditReportDiff(editReportShowMore);
          return;
        }
      });

      // Expand file edit card to show all lines
      function expandFileEditCard(btn) {
        var card = btn.closest('.file-edit-card');
        if (!card) return;

        try {
          var fullDiffData = JSON.parse(decodeURIComponent(card.dataset.fullDiff));
          var diffContent = card.querySelector('.file-edit-diff-content');

          // Render all lines
          var html = '';
          for (var i = 0; i < fullDiffData.length; i++) {
            var dl = fullDiffData[i];
            html += '<div class="' + dl.cls + '">' +
              '<span class="file-edit-line-num">' + (dl.num !== '' ? dl.num : '') + '</span>' +
              '<span class="file-edit-line-content">' + escapeHtml(dl.content) + '</span>' +
            '</div>';
          }

          diffContent.innerHTML = html;
          btn.remove(); // Remove "Show more" button
          card.classList.add('expanded');
        } catch (e) {
          console.error('Failed to expand diff:', e);
        }
      }

      // Handle revert action
      function handleFileEditRevert(btn) {
        var card = btn.closest('.file-edit-card');
        if (!card) return;

        var filePath = card.dataset.filePath;
        postMessageWithPanelId({
          type: 'revertFileEdit',
          payload: { path: filePath }
        });

        // Visual feedback
        btn.textContent = 'Reverting...';
        btn.disabled = true;
      }

      // Handle review action (open file in editor)
      function handleFileEditReview(btn) {
        var card = btn.closest('.file-edit-card');
        if (!card) return;

        var filePath = card.dataset.filePath;
        postMessageWithPanelId({
          type: 'openFile',
          payload: { path: filePath }
        });
      }

      // Expand edit report diff to show all lines
      function expandEditReportDiff(btn) {
        var card = btn.closest('.edit-report-card');
        if (!card) return;

        try {
          var fullDiffData = JSON.parse(decodeURIComponent(btn.dataset.fullDiff));
          var language = btn.dataset.language || 'javascript';
          var diffContent = card.querySelector('.edit-report-diff');

          // Render all lines with syntax highlighting
          var html = '';
          for (var i = 0; i < fullDiffData.length; i++) {
            var line = fullDiffData[i];
            var prefix = line.type === 'addition' ? '+' : (line.type === 'deletion' ? '-' : ' ');
            var lineNum = line.lineNum ? line.lineNum : '';
            var highlightedContent = highlightCode(line.content, language);
            html += '<div class="edit-report-diff-line ' + line.type + '">' +
              '<span class="edit-report-diff-linenum">' + lineNum + '</span>' +
              '<span class="edit-report-diff-prefix">' + prefix + '</span>' +
              '<span class="edit-report-diff-content">' + highlightedContent + '</span>' +
            '</div>';
          }

          diffContent.innerHTML = html;
          btn.remove(); // Remove "Show more" button
        } catch (e) {
          console.error('Failed to expand edit report diff:', e);
        }
      }
    })();
  `;
}
