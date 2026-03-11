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

/**
 * Returns the HTML content for the Visual Test Dashboard webview panel.
 * This is a standalone editor tab (not the chat sidebar).
 */
export function getVisualTestDashboardContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  _version: string = '0.0.0'
): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mysti Visual Test</title>
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      overflow: auto;
    }

    /* ── Header ── */
    .vt-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .vt-header-title {
      font-size: 14px;
      font-weight: 600;
    }
    .vt-header-spacer { flex: 1; }
    .vt-status-badge {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .vt-status-idle { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .vt-status-running { background: #1a73e8; color: #fff; }
    .vt-status-complete { background: #34a853; color: #fff; }
    .vt-status-failed { background: #ea4335; color: #fff; }
    .vt-status-cancelled { background: #9e9e9e; color: #fff; }

    .vt-cancel-btn {
      padding: 4px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: #ea4335;
      color: #fff;
      font-size: 12px;
      cursor: pointer;
    }
    .vt-cancel-btn:hover { opacity: 0.9; }
    .vt-cancel-btn.hidden { display: none; }

    /* ── Config Form ── */
    .vt-config {
      max-width: 700px;
      margin: 24px auto;
      padding: 0 16px;
    }
    .vt-config.hidden { display: none; }
    .vt-config h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .vt-form-group {
      margin-bottom: 12px;
    }
    .vt-label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
    }
    .vt-input, .vt-textarea, .vt-select {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }
    .vt-textarea { resize: vertical; min-height: 80px; }
    .vt-row { display: flex; gap: 12px; }
    .vt-row .vt-form-group { flex: 1; }
    .vt-checkbox-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      cursor: pointer;
      padding-top: 20px;
    }
    .vt-start-btn {
      margin-top: 16px;
      padding: 8px 24px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .vt-start-btn:hover { background: var(--vscode-button-hoverBackground); }

    /* ── Progress View ── */
    .vt-progress { display: none; padding: 16px; }
    .vt-progress.active { display: block; }

    .vt-main-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    @media (max-width: 700px) {
      .vt-main-grid { grid-template-columns: 1fr; }
    }

    /* Screenshot preview */
    .vt-screenshot-panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .vt-screenshot-panel h3 {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .vt-screenshot-container {
      padding: 8px;
      text-align: center;
      min-height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-descriptionForeground);
    }
    .vt-screenshot-container img {
      max-width: 100%;
      max-height: 50vh;
      border-radius: 4px;
    }

    /* Issues panel */
    .vt-issues-panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }
    .vt-issues-panel h3 {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .vt-issue-count {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 11px;
    }
    .vt-issues-list {
      max-height: 50vh;
      overflow-y: auto;
      padding: 4px 0;
    }
    .vt-issue-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 12px;
      font-size: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .vt-issue-item:last-child { border-bottom: none; }
    .vt-severity {
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .vt-severity-critical { background: #ea4335; color: #fff; }
    .vt-severity-major { background: #ff9800; color: #fff; }
    .vt-severity-minor { background: #fbc02d; color: #000; }
    .vt-severity-cosmetic { background: #90a4ae; color: #fff; }

    /* Action Log */
    .vt-action-log {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    .vt-action-log h3 {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .vt-action-list {
      max-height: 200px;
      overflow-y: auto;
      padding: 4px 0;
    }
    .vt-action-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .vt-action-item:last-child { border-bottom: none; }
    .vt-action-icon {
      width: 14px;
      flex-shrink: 0;
      text-align: center;
    }
    .vt-action-icon.done { color: #34a853; }
    .vt-action-icon.running { color: #1a73e8; }
    .vt-action-badge {
      padding: 0 4px;
      border-radius: 3px;
      font-size: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* Report Summary */
    .vt-report {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px 16px;
      display: none;
    }
    .vt-report.active { display: block; }
    .vt-report-row {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .vt-verdict {
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 700;
    }
    .vt-verdict-pass { background: #34a853; color: #fff; }
    .vt-verdict-partial { background: #ff9800; color: #fff; }
    .vt-verdict-fail { background: #ea4335; color: #fff; }
    .vt-report-stat {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .vt-empty-state {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 12px;
      text-align: center;
    }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="vt-header">
    <span class="vt-header-title">Mysti Visual Test</span>
    <span class="vt-header-spacer"></span>
    <span id="vt-status" class="vt-status-badge vt-status-idle">Idle</span>
    <button id="vt-cancel" class="vt-cancel-btn hidden">Cancel</button>
  </div>

  <!-- Configuration Form -->
  <div id="vt-config" class="vt-config">
    <h2>Configure Visual Test</h2>

    <div class="vt-form-group">
      <label class="vt-label">URL</label>
      <input id="cfg-url" type="text" class="vt-input" placeholder="http://localhost:3000" value="http://localhost:3000" />
    </div>

    <div class="vt-form-group">
      <label class="vt-label">Dev Server Command</label>
      <input id="cfg-dev-cmd" type="text" class="vt-input" placeholder="npm run dev (auto-detected if empty)" />
    </div>

    <div class="vt-form-group">
      <label class="vt-label">Requirements / What to Test</label>
      <textarea id="cfg-requirements" class="vt-textarea" rows="4" placeholder="Describe what the app should look like and how it should behave..."></textarea>
    </div>

    <div class="vt-row">
      <div class="vt-form-group">
        <label class="vt-label">Max Iterations</label>
        <input id="cfg-max-iter" type="number" class="vt-input" min="1" max="20" value="5" />
      </div>
      <div class="vt-form-group">
        <label class="vt-label">Screenshot Mode</label>
        <select id="cfg-screenshot-mode" class="vt-select">
          <option value="viewport">Viewport</option>
          <option value="full-page">Full Page</option>
          <option value="element">Element</option>
        </select>
      </div>
      <div class="vt-form-group">
        <label class="vt-label">Browser</label>
        <select id="cfg-browser" class="vt-select">
          <option value="chromium">Chromium</option>
          <option value="firefox">Firefox</option>
          <option value="webkit">WebKit</option>
        </select>
      </div>
    </div>

    <div class="vt-row">
      <div class="vt-form-group">
        <label class="vt-label">Element Selector (when mode = Element)</label>
        <input id="cfg-element-selector" type="text" class="vt-input" placeholder="#app, .main-content" />
      </div>
      <div class="vt-form-group">
        <label class="vt-checkbox-label">
          <input id="cfg-interactions" type="checkbox" checked /> Enable Browser Actions
        </label>
      </div>
    </div>

    <button id="vt-start" class="vt-start-btn">Start Visual Test</button>
  </div>

  <!-- Progress View -->
  <div id="vt-progress" class="vt-progress">

    <div class="vt-main-grid">
      <!-- Screenshot -->
      <div class="vt-screenshot-panel">
        <h3>Screenshot</h3>
        <div id="vt-screenshot" class="vt-screenshot-container">
          Waiting for first screenshot...
        </div>
      </div>

      <!-- Issues -->
      <div class="vt-issues-panel">
        <h3>Issues <span id="vt-issue-count" class="vt-issue-count">0</span></h3>
        <div id="vt-issues" class="vt-issues-list">
          <div class="vt-empty-state">No issues detected yet</div>
        </div>
      </div>
    </div>

    <!-- Action Log -->
    <div class="vt-action-log">
      <h3>Action Log</h3>
      <div id="vt-actions" class="vt-action-list">
        <div class="vt-empty-state">Waiting for actions...</div>
      </div>
    </div>

    <!-- Report Summary -->
    <div id="vt-report" class="vt-report">
      <div class="vt-report-row">
        <span id="vt-verdict" class="vt-verdict"></span>
        <span id="vt-report-iterations" class="vt-report-stat"></span>
        <span id="vt-report-issues" class="vt-report-stat"></span>
        <span id="vt-report-duration" class="vt-report-stat"></span>
      </div>
    </div>

  </div>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      var issueCount = 0;
      var actionCount = 0;
      var isRunning = false;

      // ── Elements ──
      var statusEl = document.getElementById('vt-status');
      var cancelBtn = document.getElementById('vt-cancel');
      var configPanel = document.getElementById('vt-config');
      var progressPanel = document.getElementById('vt-progress');
      var screenshotEl = document.getElementById('vt-screenshot');
      var issuesEl = document.getElementById('vt-issues');
      var issueCountEl = document.getElementById('vt-issue-count');
      var actionsEl = document.getElementById('vt-actions');
      var reportEl = document.getElementById('vt-report');

      // ── Config → Start ──
      document.getElementById('vt-start').addEventListener('click', function() {
        var requirements = document.getElementById('cfg-requirements').value.trim();
        if (!requirements) {
          document.getElementById('cfg-requirements').focus();
          return;
        }

        var config = {
          url: document.getElementById('cfg-url').value || 'http://localhost:3000',
          devServerCommand: document.getElementById('cfg-dev-cmd').value || undefined,
          requirements: requirements,
          maxIterations: parseInt(document.getElementById('cfg-max-iter').value || '5', 10),
          screenshotMode: document.getElementById('cfg-screenshot-mode').value || 'viewport',
          elementSelector: document.getElementById('cfg-element-selector').value || undefined,
          browser: document.getElementById('cfg-browser').value || 'chromium',
          headless: true,
          viewportWidth: 1280,
          viewportHeight: 720,
          interactionsEnabled: document.getElementById('cfg-interactions').checked
        };

        vscode.postMessage({ type: 'dashboardStartVisualTest', payload: { config: config } });
        switchToProgress();
      });

      // ── Cancel ──
      cancelBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'dashboardCancelVisualTest' });
        setStatus('Cancelling...', 'cancelled');
      });

      function switchToProgress() {
        configPanel.classList.add('hidden');
        progressPanel.classList.add('active');
        cancelBtn.classList.remove('hidden');
        isRunning = true;
        issueCount = 0;
        actionCount = 0;
        issuesEl.innerHTML = '';
        actionsEl.innerHTML = '';
        screenshotEl.innerHTML = 'Waiting for first screenshot...';
        issueCountEl.textContent = '0';
        reportEl.classList.remove('active');
        setStatus('Starting...', 'running');
      }

      function switchToConfig() {
        configPanel.classList.remove('hidden');
        progressPanel.classList.remove('active');
        cancelBtn.classList.add('hidden');
        isRunning = false;
        setStatus('Idle', 'idle');
      }

      function setStatus(text, state) {
        statusEl.textContent = text;
        statusEl.className = 'vt-status-badge vt-status-' + state;
      }

      function addAction(icon, text, badge) {
        if (actionCount === 0) { actionsEl.innerHTML = ''; }
        actionCount++;
        var item = document.createElement('div');
        item.className = 'vt-action-item';
        var iconHtml = '<span class="vt-action-icon ' + (icon === 'done' ? 'done' : 'running') + '">'
          + (icon === 'done' ? '\\u2713' : '\\u25CB') + '</span>';
        var badgeHtml = badge ? ' <span class="vt-action-badge">' + escapeHtml(badge) + '</span>' : '';
        item.innerHTML = iconHtml + '<span>' + escapeHtml(text) + badgeHtml + '</span>';
        actionsEl.appendChild(item);
        actionsEl.scrollTop = actionsEl.scrollHeight;
      }

      function addIssue(issue) {
        if (issueCount === 0) { issuesEl.innerHTML = ''; }
        issueCount++;
        issueCountEl.textContent = issueCount.toString();
        var item = document.createElement('div');
        item.className = 'vt-issue-item';
        item.innerHTML = '<span class="vt-severity vt-severity-' + issue.severity + '">'
          + escapeHtml(issue.severity) + '</span>'
          + '<span>' + escapeHtml(issue.description) + '</span>';
        issuesEl.appendChild(item);
      }

      function showReport(report) {
        if (!report || !report.summary) return;
        var s = report.summary;
        var verdictEl = document.getElementById('vt-verdict');
        var cls = s.verdict === 'pass' ? 'pass' : s.verdict === 'partial' ? 'partial' : 'fail';
        verdictEl.className = 'vt-verdict vt-verdict-' + cls;
        verdictEl.textContent = s.verdict.toUpperCase();
        document.getElementById('vt-report-iterations').textContent = s.totalIterations + '/' + s.maxIterations + ' iterations';
        document.getElementById('vt-report-issues').textContent = s.totalIssuesFound + ' issues, ' + s.totalIssuesFixed + ' fixed';
        document.getElementById('vt-report-duration').textContent = s.totalDuration ? Math.round(s.totalDuration / 1000) + 's' : '';
        reportEl.classList.add('active');
      }

      function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // ── Message handler ──
      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg) return;

        switch (msg.type) {
          case 'visualTestDashboardConfig': {
            // Pre-fill config from agent trigger
            var c = msg.payload;
            if (c) {
              if (c.url) document.getElementById('cfg-url').value = c.url;
              if (c.devServerCommand) document.getElementById('cfg-dev-cmd').value = c.devServerCommand;
              if (c.requirements) document.getElementById('cfg-requirements').value = c.requirements;
              if (c.maxIterations) document.getElementById('cfg-max-iter').value = c.maxIterations.toString();
              if (c.screenshotMode) document.getElementById('cfg-screenshot-mode').value = c.screenshotMode;
              if (c.elementSelector) document.getElementById('cfg-element-selector').value = c.elementSelector;
              if (c.browser) document.getElementById('cfg-browser').value = c.browser;
              if (c.interactionsEnabled !== undefined) document.getElementById('cfg-interactions').checked = c.interactionsEnabled;
            }
            break;
          }

          case 'visualTestDashboardAutoStart': {
            // Agent triggered — auto-fill and start immediately
            var cfg = msg.payload;
            if (cfg) {
              if (cfg.url) document.getElementById('cfg-url').value = cfg.url;
              if (cfg.devServerCommand) document.getElementById('cfg-dev-cmd').value = cfg.devServerCommand;
              if (cfg.requirements) document.getElementById('cfg-requirements').value = cfg.requirements;
              if (cfg.maxIterations) document.getElementById('cfg-max-iter').value = cfg.maxIterations.toString();
            }
            switchToProgress();
            break;
          }

          case 'visualTestDashboardUpdate': {
            var chunk = msg.payload;
            if (!chunk) break;
            handleChunk(chunk);
            break;
          }

          case 'visualTestDashboardCancelled':
            setStatus('Cancelled', 'cancelled');
            cancelBtn.classList.add('hidden');
            isRunning = false;
            addAction('done', 'Visual test cancelled');
            break;
        }
      });

      function handleChunk(chunk) {
        switch (chunk.type) {
          case 'visual_test_started':
            setStatus(chunk.message || chunk.status || 'Starting...', 'running');
            addAction('running', chunk.message || 'Visual test started');
            break;

          case 'visual_test_screenshot':
            setStatus('Captured screenshot', 'running');
            if (chunk.screenshot && chunk.screenshot.base64Data) {
              screenshotEl.innerHTML = '<img src="data:image/png;base64,' + chunk.screenshot.base64Data
                + '" alt="Iteration ' + chunk.screenshot.iteration + '" />';
            }
            addAction('done', 'Screenshot captured (iteration ' + (chunk.screenshot ? chunk.screenshot.iteration : '?') + ')');
            break;

          case 'visual_test_iteration':
            if (chunk.iteration) {
              var n = chunk.iteration.number;
              var ic = chunk.iteration.issues ? chunk.iteration.issues.length : 0;
              var dur = Math.round((chunk.iteration.duration || 0) / 1000);
              setStatus('Iteration ' + n + ' complete', 'running');
              addAction('done', 'Iteration ' + n + ': ' + ic + ' issue(s) found', dur + 's');
            }
            break;

          case 'visual_test_issue':
            if (chunk.issue) {
              addIssue(chunk.issue);
            }
            break;

          case 'visual_test_fix': {
            setStatus(chunk.message || 'Applying fix...', 'running');
            var badge = '';
            if (chunk.toolDetail) {
              if (chunk.toolDetail.linesAdded || chunk.toolDetail.linesRemoved) {
                badge = '+' + (chunk.toolDetail.linesAdded || 0) + '/-' + (chunk.toolDetail.linesRemoved || 0);
              }
            }
            addAction(chunk.message && chunk.message.startsWith('Completed') ? 'done' : 'running',
              chunk.message || 'Applying fix...', badge);
            break;
          }

          case 'visual_test_interaction':
            if (chunk.interaction) {
              var desc = chunk.interaction.action;
              if (chunk.interaction.target) desc += ' on ' + chunk.interaction.target;
              addAction('running', 'Action: ' + desc);
            }
            break;

          case 'visual_test_error':
            setStatus('Error', 'failed');
            addAction('done', 'ERROR: ' + (chunk.message || 'Unknown error'));
            break;

          case 'visual_test_complete':
            isRunning = false;
            cancelBtn.classList.add('hidden');
            var verdict = chunk.report && chunk.report.summary ? chunk.report.summary.verdict : 'fail';
            setStatus(verdict === 'pass' ? 'Passed' : verdict === 'partial' ? 'Partial' : 'Failed',
              verdict === 'pass' ? 'complete' : 'failed');
            addAction('done', 'Visual test complete');
            if (chunk.report) showReport(chunk.report);
            break;
        }
      }

    })();
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
