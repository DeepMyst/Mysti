import * as vscode from 'vscode';

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const styles = getStyles();

  // URIs for library scripts
  const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'marked.min.js'));
  const prismUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'prism-bundle.js'));
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'mermaid.min.js'));
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'Mysti-Logo.png'));

  const script = getScript(mermaidUri.toString(), logoUri.toString());

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
        <img src="${logoUri}" alt="Mysti" class="header-logo" />
        <h1 class="title">Mysti</h1>
        <span id="session-indicator" class="session-indicator" style="display: none;">
          <span class="session-dot"></span>
          Session
        </span>
        <button id="new-chat-btn" class="icon-btn" title="New conversation">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a.5.5 0 0 1 .5.5v6h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6v-6A.5.5 0 0 1 8 1z"/>
          </svg>
        </button>
      </div>
      <div class="header-right">
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
          <option value="ask-before-edit">Ask before edit</option>
          <option value="edit-automatically">Edit automatically</option>
          <option value="plan">Plan</option>
          <option value="brainstorm">Brainstorm</option>
        </select>
      </div>
      <div class="settings-section">
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
    </div>

    <!-- Context section -->
    <div class="context-section">
      <div class="context-header">
        <span class="context-title">Context</span>
        <div class="context-controls">
          <button id="context-mode-btn" class="pill-btn" title="Toggle context mode">
            <span id="context-mode-label">Auto</span>
          </button>
          <button id="add-context-btn" class="icon-btn small" title="Add files to context">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a.5.5 0 0 1 .5.5v6h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6v-6A.5.5 0 0 1 8 1z"/>
            </svg>
          </button>
          <button id="clear-context-btn" class="icon-btn small" title="Clear context">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1H3v9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4h.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1H2.5zm3 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zM8 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 5zm3 .5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 1 0z"/>
            </svg>
          </button>
        </div>
      </div>
      <div id="context-items" class="context-items">
        <div class="context-empty">Drop files here or click + to add context</div>
      </div>
    </div>

    <!-- Messages area -->
    <div id="messages" class="messages">
      <div class="welcome-container">
        <div class="welcome-header">
          <img src="${logoUri}" alt="Mysti" class="welcome-logo" />
          <h2>Welcome to Mysti</h2>
          <p>Your AI coding assistant. Choose an action or ask anything!</p>
        </div>
        <div class="welcome-suggestions" id="welcome-suggestions"></div>
      </div>
    </div>

    <!-- Quick actions (dynamically populated) -->
    <div id="quick-actions" class="quick-actions">
      <!-- Suggestions will be dynamically generated after each response -->
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
          <span id="agent-icon" class="agent-icon">🟣</span>
          <span id="agent-name">Claude</span>
          <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 6l4 4 4-4"/>
          </svg>
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
        <span class="agent-item-dot" style="background: #8B5CF6;"></span>
        <span class="agent-item-name">Claude Code</span>
        <span class="agent-item-badge">Active</span>
      </div>
      <div class="agent-menu-item" data-agent="openai-codex">
        <span class="agent-item-dot" style="background: #10B981;"></span>
        <span class="agent-item-name">OpenAI Codex</span>
      </div>
      <div class="agent-menu-divider"></div>
      <div class="agent-menu-item" data-agent="brainstorm">
        <span class="agent-item-dot" style="background: #F59E0B;"></span>
        <span class="agent-item-name">Brainstorm</span>
        <span class="agent-item-desc">Both agents collaborate</span>
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
    }

    .header-left, .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .title {
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .header-logo {
      width: 24px;
      height: 24px;
      object-fit: contain;
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
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 10px;
      cursor: pointer;
    }

    .pill-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
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
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      margin-bottom: 8px;
      background: var(--icon-bg, rgba(59,130,246,0.15));
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
    .welcome-card[data-color="blue"] { --card-color: #3b82f6; --icon-bg: rgba(59,130,246,0.15); }
    .welcome-card[data-color="green"] { --card-color: #22c55e; --icon-bg: rgba(34,197,94,0.15); }
    .welcome-card[data-color="purple"] { --card-color: #a855f7; --icon-bg: rgba(168,85,247,0.15); }
    .welcome-card[data-color="orange"] { --card-color: #f97316; --icon-bg: rgba(249,115,22,0.15); }
    .welcome-card[data-color="indigo"] { --card-color: #6366f1; --icon-bg: rgba(99,102,241,0.15); }
    .welcome-card[data-color="red"] { --card-color: #ef4444; --icon-bg: rgba(239,68,68,0.15); }
    .welcome-card[data-color="teal"] { --card-color: #14b8a6; --icon-bg: rgba(20,184,166,0.15); }
    .welcome-card[data-color="pink"] { --card-color: #ec4899; --icon-bg: rgba(236,72,153,0.15); }
    .welcome-card[data-color="amber"] { --card-color: #f59e0b; --icon-bg: rgba(245,158,11,0.15); }

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

    /* Suggestions container - grid layout for cards */
    .quick-actions {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      max-height: 280px;
      overflow-y: auto;
    }

    .quick-actions.loading {
      pointer-events: none;
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
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }

    .quick-action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
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

    .toolbar-spacer {
      flex: 1;
    }

    .mode-indicator {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 8px;
      background: var(--vscode-badge-background);
      border-radius: 10px;
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
      font-family: var(--vscode-font-family);
      resize: none;
      min-height: 36px;
      max-height: 150px;
    }

    #message-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .stop-btn {
      background: var(--vscode-errorForeground, #f14c4c);
      color: var(--vscode-button-foreground, white);
      border: none;
      padding: 8px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
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
      background: var(--vscode-button-secondaryBackground);
    }

    .agent-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .agent-icon {
      font-size: 12px;
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
    }

    .agent-item-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .agent-item-icon {
      font-size: 14px;
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
      color: #22c55e;
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
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-descriptionForeground);
    }

    .phase-indicator.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      animation: pulse 2s infinite;
    }

    .phase-indicator.complete {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }

    .phase-connector {
      width: 24px;
      height: 2px;
      background: var(--vscode-panel-border);
    }

    .phase-connector.complete {
      background: #22c55e;
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
      background: rgba(0, 0, 0, 0.1);
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
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .brainstorm-phase-indicator.individual {
      background: rgba(59, 130, 246, 0.2);
      color: #3b82f6;
    }

    .brainstorm-phase-indicator.discussion {
      background: rgba(245, 158, 11, 0.2);
      color: #f59e0b;
    }

    .brainstorm-phase-indicator.synthesis {
      background: rgba(139, 92, 246, 0.2);
      color: #8b5cf6;
    }

    .brainstorm-phase-indicator.complete {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
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
      background: rgba(59, 130, 246, 0.2);
      color: #3b82f6;
      animation: pulse 1.5s infinite;
    }

    .brainstorm-agent-status.complete {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
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
      background: rgba(0, 0, 0, 0.1);
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
  `;
}

function getScript(mermaidUri: string, logoUri: string): string {
  return `
    (function() {
      const vscode = acquireVsCodeApi();
      const MERMAID_URI = '${mermaidUri}';
      const LOGO_URI = '${logoUri}';

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
        // Brainstorm mode state
        activeAgent: 'claude-code',
        brainstormSession: null,
        brainstormPhase: null,
        agentResponses: {},
        // Autocomplete state
        autocompleteSuggestion: null,
        autocompleteType: null
      };

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
      const newChatBtn = document.getElementById('new-chat-btn');
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

      // Welcome screen suggestions
      var WELCOME_SUGGESTIONS = [
        { id: 'understand', title: 'Understand Project', description: 'Analyze structure & architecture', message: 'Help me understand this project. Analyze the codebase structure, key files, technologies used, and how everything connects.', icon: '🔍', color: 'blue' },
        { id: 'review', title: 'Code Review', description: 'Find issues & improvements', message: 'Review my code for potential issues, bugs, and suggest improvements for better quality and maintainability.', icon: '👀', color: 'purple' },
        { id: 'cleanup', title: 'Clean Up', description: 'Remove dead code & organize', message: 'Help me clean up this codebase. Find dead code, unused imports, redundant files, and suggest organization improvements.', icon: '🧹', color: 'green' },
        { id: 'tests', title: 'Write Tests', description: 'Add test coverage', message: 'Help me write tests for this project. Identify untested code and create comprehensive unit and integration tests.', icon: '🧪', color: 'teal' },
        { id: 'security', title: 'Security Audit', description: 'Find vulnerabilities', message: 'Perform a security audit. Check for vulnerabilities, exposed secrets, injection risks, and OWASP top 10 issues.', icon: '🔒', color: 'red' },
        { id: 'performance', title: 'Performance', description: 'Optimize for speed', message: 'Analyze performance bottlenecks and suggest optimizations for better speed and resource efficiency.', icon: '⚡', color: 'amber' },
        { id: 'docs', title: 'Documentation', description: 'Improve docs & comments', message: 'Help me improve documentation. Add JSDoc comments, update README, and document complex logic.', icon: '📝', color: 'indigo' },
        { id: 'refactor', title: 'Refactor', description: 'Improve code structure', message: 'Suggest refactoring opportunities. Identify code smells, duplicate code, and ways to improve architecture.', icon: '🔄', color: 'orange' },
        { id: 'production', title: 'Production Ready', description: 'Prepare for deployment', message: 'Help make this project production-ready. Check error handling, logging, environment configs, and best practices.', icon: '🚀', color: 'green' },
        { id: 'deploy', title: 'Prep Deployment', description: 'Set up CI/CD', message: 'Help me prepare for deployment. Set up CI/CD pipelines, Docker configs, and deployment scripts.', icon: '📦', color: 'purple' },
        { id: 'compliance', title: 'Compliance', description: 'Check licensing & regs', message: 'Check for compliance issues. Review licenses, dependencies, accessibility, and regulatory requirements.', icon: '✅', color: 'blue' },
        { id: 'debug', title: 'Debug Issue', description: 'Help diagnose problems', message: 'Help me debug an issue in my code. I will describe the problem and you help me find the root cause.', icon: '🐛', color: 'red' }
      ];

      function renderWelcomeSuggestions() {
        var container = document.getElementById('welcome-suggestions');
        if (!container) return;
        container.innerHTML = '';

        WELCOME_SUGGESTIONS.forEach(function(s) {
          var card = document.createElement('button');
          card.className = 'welcome-card';
          card.setAttribute('data-color', s.color);
          card.title = s.message;

          card.innerHTML =
            '<div class="welcome-card-icon">' + s.icon + '</div>' +
            '<div class="welcome-card-title">' + escapeHtml(s.title) + '</div>' +
            '<div class="welcome-card-desc">' + escapeHtml(s.description) + '</div>';

          card.onclick = function() {
            vscode.postMessage({
              type: 'sendMessage',
              payload: {
                content: s.message,
                context: state.context,
                settings: state.settings
              }
            });
          };

          container.appendChild(card);
        });
      }

      // Render welcome suggestions on load
      renderWelcomeSuggestions();

      sendBtn.addEventListener('click', sendMessage);
      stopBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'cancelRequest' });
      });
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
                vscode.postMessage({
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
                vscode.postMessage({
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
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
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
            vscode.postMessage({
              type: 'requestAutocomplete',
              payload: { text: inputEl.value, type: 'sentence', precompute: true }
            });
          }
        }, 300);
      });

      settingsBtn.addEventListener('click', function() {
        settingsPanel.classList.toggle('hidden');
      });

      newChatBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'newConversation' });
        clearMessages();
      });

      modeSelect.addEventListener('change', function() {
        state.settings.mode = modeSelect.value;
        updateModeIndicator();
        vscode.postMessage({ type: 'updateSettings', payload: { mode: modeSelect.value } });
      });

      thinkingSelect.addEventListener('change', function() {
        state.settings.thinkingLevel = thinkingSelect.value;
        vscode.postMessage({ type: 'updateSettings', payload: { thinkingLevel: thinkingSelect.value } });
      });

      modelSelect.addEventListener('change', function() {
        state.settings.model = modelSelect.value;
        vscode.postMessage({ type: 'updateSettings', payload: { model: modelSelect.value } });
      });

      accessSelect.addEventListener('change', function() {
        state.settings.accessLevel = accessSelect.value;
        vscode.postMessage({ type: 'updateSettings', payload: { accessLevel: accessSelect.value } });
      });

      providerSelect.addEventListener('change', function() {
        var newProvider = providerSelect.value;
        state.settings.provider = newProvider;
        state.activeAgent = newProvider;

        // Update model dropdown with provider-specific models
        updateModelsForProvider(newProvider);

        // Sync with agent menu selection
        updateAgentMenuSelection();

        // Notify backend of provider change
        vscode.postMessage({ type: 'updateSettings', payload: { provider: newProvider } });
      });

      contextModeBtn.addEventListener('click', function() {
        state.settings.contextMode = state.settings.contextMode === 'auto' ? 'manual' : 'auto';
        contextModeLabel.textContent = state.settings.contextMode === 'auto' ? 'Auto' : 'Manual';
        vscode.postMessage({ type: 'updateSettings', payload: { contextMode: state.settings.contextMode } });
      });

      addContextBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'getWorkspaceFiles' });
      });

      clearContextBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'clearContext' });
      });

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

        // Agent menu item clicks
        document.querySelectorAll('.agent-menu-item').forEach(function(item) {
          item.addEventListener('click', function() {
            var agent = item.dataset.agent;
            if (agent) {
              if (agent === 'brainstorm') {
                // Enable brainstorm mode
                state.settings.mode = 'brainstorm';
                state.activeAgent = 'brainstorm';
                updateAgentMenuSelection();
                agentMenu.classList.add('hidden');
                // Notify backend of mode change
                vscode.postMessage({ type: 'updateSettings', payload: { mode: 'brainstorm' } });
              } else {
                // Select single agent, disable brainstorm
                state.activeAgent = agent;
                state.settings.provider = agent;
                state.settings.mode = 'ask'; // Reset to normal mode

                // Sync settings dropdown
                providerSelect.value = agent;

                // Update models for the new provider
                updateModelsForProvider(agent);

                updateAgentMenuSelection();
                agentMenu.classList.add('hidden');
                // Notify backend of provider change
                vscode.postMessage({ type: 'updateSettings', payload: { provider: agent, mode: 'ask' } });
              }
            }
          });
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
              vscode.postMessage({ type: 'updateSettings', payload: { model: state.settings.model } });
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
          var agentName = state.activeAgent === 'claude-code' ? 'Claude' :
                         state.activeAgent === 'brainstorm' ? 'Brainstorm' : 'Codex';
          agentNameEl.textContent = agentName;
        }
        if (agentIconEl) {
          agentIconEl.textContent = state.activeAgent === 'claude-code' ? '🟣' :
                                   state.activeAgent === 'brainstorm' ? '🧠' : '🟢';
        }
        // Sync settings provider dropdown (only for actual providers, not brainstorm)
        if (providerSelect && state.activeAgent !== 'brainstorm' && providerSelect.value !== state.activeAgent) {
          providerSelect.value = state.activeAgent;
        }
      }

      enhanceBtn.addEventListener('click', function() {
        if (inputEl.value.trim()) {
          vscode.postMessage({ type: 'enhancePrompt', payload: inputEl.value });
        }
      });

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
            finalizeStreamingMessage(message.payload);
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
            renderFallbackSuggestions();
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
          case 'error':
            hideLoading();
            showError(message.payload);
            break;
          case 'contextUpdated':
            updateContext(message.payload);
            break;
          case 'conversationChanged':
            clearMessages();
            if (message.payload && message.payload.messages) {
              message.payload.messages.forEach(function(msg) { addMessage(msg); });
            }
            break;
          case 'insertPrompt':
            inputEl.value = message.payload;
            inputEl.focus();
            break;
          case 'promptEnhanced':
            inputEl.value = message.payload;
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
            updateAgentMenuSelection();
            break;
        }
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

        brainstormContainer.innerHTML =
          '<div class="brainstorm-header">' +
            '<span class="brainstorm-icon">🧠</span>' +
            '<span class="brainstorm-title">Brainstorm Session</span>' +
            '<span class="brainstorm-phase-indicator" id="brainstorm-phase">Individual Analysis</span>' +
          '</div>' +
          '<div class="brainstorm-agents">' +
            '<div class="brainstorm-agent-card" data-agent="claude-code">' +
              '<div class="brainstorm-agent-header">' +
                '<span class="brainstorm-agent-icon">🟠</span>' +
                '<span class="brainstorm-agent-name">Claude</span>' +
                '<span class="brainstorm-agent-status streaming">Thinking...</span>' +
              '</div>' +
              '<div class="brainstorm-agent-content" id="brainstorm-claude-content"></div>' +
            '</div>' +
            '<div class="brainstorm-agent-card" data-agent="openai-codex">' +
              '<div class="brainstorm-agent-header">' +
                '<span class="brainstorm-agent-icon">🟢</span>' +
                '<span class="brainstorm-agent-name">Codex</span>' +
                '<span class="brainstorm-agent-status streaming">Thinking...</span>' +
              '</div>' +
              '<div class="brainstorm-agent-content" id="brainstorm-codex-content"></div>' +
            '</div>' +
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

        var contentEl = document.getElementById('brainstorm-' + (agentId === 'claude-code' ? 'claude' : 'codex') + '-content');
        if (!contentEl) return;

        if (chunkType === 'thinking') {
          // Use same thinking block format as normal mode
          var thinkingEl = document.createElement('div');
          thinkingEl.className = 'thinking-block';
          var thinkingIcon = '<span class="thinking-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg></span>';
          thinkingEl.innerHTML = thinkingIcon + '<span class="thinking-content">' + escapeHtml(content) + '</span>';
          contentEl.appendChild(thinkingEl);
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
        contextModeLabel.textContent = state.settings.contextMode === 'auto' ? 'Auto' : 'Manual';
        updateModeIndicator();

        // Set provider dropdown
        if (state.settings.provider) {
          providerSelect.value = state.settings.provider;
          state.activeAgent = state.settings.provider;
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

        updateContext(state.context);

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
          vscode.postMessage({
            type: 'executeSlashCommand',
            payload: { command: command, args: args }
          });
          inputEl.value = '';
          inputEl.style.height = 'auto';
          return;
        }

        // Check if brainstorm mode is selected (use activeAgent which is set synchronously)
        if (state.activeAgent === 'brainstorm') {
          vscode.postMessage({
            type: 'sendBrainstormMessage',
            payload: {
              content: content,
              context: state.context,
              settings: state.settings
            }
          });
        } else {
          vscode.postMessage({
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

        if (thinking) {
          // Create a new thinking block for each thought
          var thinkingEl = document.createElement('div');
          thinkingEl.className = 'thinking-block';
          // Use a thought bubble icon instead of text
          var thinkingIcon = '<span class="thinking-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg></span>';
          thinkingEl.innerHTML = thinkingIcon + '<span class="thinking-content">' + escapeHtml(thinking) + '</span>';
          messageBody.appendChild(thinkingEl);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
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
            return input.command || '';
          case 'read':
            return input.file_path || input.path || '';
          case 'write':
            return input.file_path || input.path || '';
          case 'edit':
            return input.file_path || input.path || '';
          case 'glob':
            return input.pattern || '';
          case 'grep':
            return input.pattern || '';
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
            // Try common field names
            return input.file_path || input.path || input.command || input.query || input.pattern || '';
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

        var div = document.createElement('div');
        div.className = 'tool-call running';
        div.dataset.id = toolCall.id;

        // Format input for display
        var inputStr = JSON.stringify(toolCall.input || {}, null, 2);
        var summary = formatToolSummary(toolCall.name, toolCall.input);
        div.dataset.summary = summary;

        // Chevron SVG for expand indicator
        var chevronSvg = '<svg class="tool-call-chevron" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">' +
          '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

        // Spinner SVG for running state
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
            '<span class="tool-call-status running">running</span>' +
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
                vscode.postMessage({
                  type: 'getFileLineNumber',
                  filePath: editInfo.filePath,
                  searchText: searchText
                });
              }

              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          }

          // For TodoWrite, render a nice todo list
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
            }
          }

          // Clean up stored data
          pendingToolData.delete(toolCall.id);
        }
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
      }

      function hideLoading() {
        state.isLoading = false;
        sendBtn.style.display = 'flex';
        sendBtn.disabled = false;
        stopBtn.style.display = 'none';
        currentResponse = '';
        currentThinking = '';
        contentSegmentIndex = 0;
        var loading = messagesEl.querySelector('.loading');
        if (loading) loading.remove();
      }

      // Dynamic suggestions functions (ezorro-style cards)
      function showSuggestionSkeleton() {
        var container = document.getElementById('quick-actions');
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
            vscode.postMessage({ type: 'executeSuggestion', payload: s });
          };

          container.appendChild(card);
        });
      }

      function renderFallbackSuggestions() {
        renderSuggestions([
          { id: 'continue', title: 'Continue', description: 'Continue with more details', message: 'Please continue', icon: '➡️', color: 'blue' },
          { id: 'elaborate', title: 'Elaborate', description: 'Expand on this explanation', message: 'Can you elaborate on this?', icon: '📖', color: 'purple' },
          { id: 'example', title: 'Show Example', description: 'See a practical code example', message: 'Can you show me an example?', icon: '💻', color: 'green' },
          { id: 'alternative', title: 'Alternatives', description: 'Explore other approaches', message: 'What are alternative approaches?', icon: '🔄', color: 'orange' },
          { id: 'optimize', title: 'Optimize', description: 'Improve performance or code quality', message: 'How can I optimize this?', icon: '⚡', color: 'amber' },
          { id: 'tests', title: 'Add Tests', description: 'Write tests for this code', message: 'Can you write tests for this?', icon: '🧪', color: 'teal' }
        ]);
      }

      function finalizeStreamingMessage(msg) {
        var streamingEl = messagesEl.querySelector('.message.streaming');
        if (streamingEl) {
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

      function clearMessages() {
        messagesEl.innerHTML = '<div class="welcome-container"><div class="welcome-header"><img src="' + LOGO_URI + '" alt="Mysti" class="welcome-logo" /><h2>Welcome to Mysti</h2><p>Your AI coding assistant. Choose an action or ask anything!</p></div><div class="welcome-suggestions" id="welcome-suggestions"></div></div>';
        renderWelcomeSuggestions();
      }

      function updateContext(context) {
        state.context = context;
        if (context.length === 0) {
          contextItems.innerHTML = '<div class="context-empty">Drop files here or click + to add context</div>';
          return;
        }

        contextItems.innerHTML = context.map(function(item) {
          return '<div class="context-item" data-id="' + item.id + '"><span class="context-item-path" title="' + item.path + '">' + getFileName(item.path) + (item.type === 'selection' ? ' (selection)' : '') + '</span><button class="context-item-remove" data-id="' + item.id + '">x</button></div>';
        }).join('');

        contextItems.querySelectorAll('.context-item-remove').forEach(function(btn) {
          btn.addEventListener('click', function() {
            vscode.postMessage({ type: 'removeFromContext', payload: btn.dataset.id });
          });
        });
      }

      function updateModeIndicator() {
        var modeLabels = {
          'ask-before-edit': 'Ask before edit',
          'edit-automatically': 'Auto edit',
          'plan': 'Plan mode',
          'brainstorm': 'Brainstorm'
        };
        modeIndicator.textContent = modeLabels[state.settings.mode] || state.settings.mode;
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
        vscode.postMessage({ type: 'cancelAutocomplete' });
      }

      function acceptAutocomplete() {
        if (state.autocompleteSuggestion) {
          // Append the suggestion to the input
          inputEl.value = inputEl.value + state.autocompleteSuggestion;
          // Update textarea height
          inputEl.style.height = 'auto';
          inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
          // Clear the ghost text
          clearAutocomplete();
          // Focus at the end
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }
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

        // Extract file path
        info.filePath = input.file_path || input.path || input.notebook_path || '';
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

          html += '<div class="todo-item ' + todo.status + '">' +
            '<span class="todo-status ' + todo.status + '">' + statusIcon + '</span>' +
            '<span class="todo-content">' + escapeHtml(todo.content) + '</span>' +
          '</div>';
        });
        html += '</div>';
        return html;
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
            vscode.postMessage({
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
            vscode.postMessage({
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
            vscode.postMessage({
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
            vscode.postMessage({
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
        vscode.postMessage({
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
        vscode.postMessage({
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
