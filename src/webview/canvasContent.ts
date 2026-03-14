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

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getCanvasContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  version: string = '0.0.0'
): string {
  const nonce = getNonce();
  const fabricUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'fabric.min.js'));
  const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'Mysti-Logo.png'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data: blob:;
             media-src data: blob:;
             frame-src blob: data:;
             child-src blob: data:;
             style-src 'unsafe-inline';
             script-src 'nonce-${nonce}' 'unsafe-eval' ${webview.cspSource};
             font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mysti Canvas</title>
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: 13px;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .canvas-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 12px;
      background: var(--vscode-titleBar-activeBackground, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
      min-height: 36px;
    }
    .canvas-header-logo { width: 20px; height: 20px; }
    .canvas-header-title { font-weight: 600; font-size: 13px; }
    .canvas-header-session {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .canvas-header-btn {
      background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.1));
      border: none;
      color: var(--vscode-foreground);
      padding: 4px;
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
    }
    .canvas-header-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.15)); }
    .canvas-header-btn svg { display: block; }

    /* Toolbar */
    .canvas-toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 12px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
    }
    .tool-btn {
      background: none;
      border: 1px solid transparent;
      color: var(--vscode-editor-foreground);
      padding: 5px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      min-width: 32px;
      text-align: center;
      transition: background 0.15s;
    }
    .tool-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    .tool-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-focusBorder);
    }
    .tool-separator {
      width: 1px;
      height: 20px;
      background: var(--vscode-panel-border, #444);
      margin: 0 6px;
    }
    .tool-color-input {
      -webkit-appearance: none;
      width: 24px; height: 24px;
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 4px;
      cursor: pointer;
      background: none;
      padding: 0;
    }
    .tool-color-input::-webkit-color-swatch-wrapper { padding: 2px; }
    .tool-color-input::-webkit-color-swatch { border: none; border-radius: 2px; }
    .tool-range {
      width: 80px;
      accent-color: var(--vscode-button-background);
    }
    .tool-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 0 4px;
    }
    .tool-btn svg { display: block; margin: auto; }
    .tool-btn:disabled { opacity: 0.3; cursor: default; }
    .tool-btn:disabled:hover { background: none; }

    /* Zoom controls */
    .zoom-controls {
      position: absolute; bottom: 12px; right: 12px;
      display: flex; align-items: center; gap: 2px;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.95));
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px; padding: 2px; z-index: 50;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .zoom-btn {
      background: none; border: none; color: var(--vscode-editor-foreground);
      padding: 4px 6px; border-radius: 4px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      min-width: 28px; height: 28px;
    }
    .zoom-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
    .zoom-btn svg { display: block; }
    .zoom-level {
      background: none; border: none; color: var(--vscode-editor-foreground);
      font-size: 11px; padding: 4px 8px; cursor: pointer;
      min-width: 48px; text-align: center; border-radius: 4px; height: 28px;
      font-family: var(--vscode-font-family, sans-serif);
    }
    .zoom-level:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }

    /* Minimap */
    .minimap {
      position: absolute; bottom: 48px; right: 12px;
      width: 150px; height: 100px;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.85));
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px; overflow: hidden; z-index: 50;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer;
    }
    .minimap.hidden { display: none; }
    .minimap-viewport {
      position: absolute;
      border: 1.5px solid var(--vscode-textLink-foreground, #3794ff);
      background: rgba(55,148,255,0.1);
      pointer-events: none; border-radius: 1px;
    }

    /* Status bar enhancements */
    .status-clickable { cursor: pointer; }
    .status-clickable:hover { color: var(--vscode-textLink-foreground); }
    .status-sep { opacity: 0.3; margin: 0 2px; }
    .status-muted { opacity: 0.5; }

    /* Canvas area */
    .canvas-area {
      flex: 1;
      position: relative;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .canvas-area canvas {
      position: absolute;
      top: 0; left: 0;
    }

    /* Live component iframe overlays */
    #iframe-overlay-container {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      z-index: 20; pointer-events: none; overflow: hidden;
    }
    .component-iframe-wrapper {
      position: absolute; overflow: hidden; pointer-events: auto;
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 4px;
      background: #fff;
    }
    .component-iframe-wrapper iframe {
      width: 100%; height: 100%; border: none;
    }
    .component-iframe-wrapper.hidden { display: none; }

    /* Status bar */
    .canvas-statusbar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 3px 12px;
      background: var(--vscode-statusBar-background, var(--vscode-editor-background));
      color: var(--vscode-statusBar-foreground, var(--vscode-descriptionForeground));
      border-top: 1px solid var(--vscode-panel-border, #333);
      font-size: 11px;
      flex-shrink: 0;
    }

    /* Unified prompt bar */
    .canvas-prompt-bar {
      flex-shrink: 0;
      background: var(--vscode-editorWidget-background, #252526);
      border-top: 1px solid var(--vscode-panel-border, #333);
      padding: 8px 12px;
      position: relative;
    }
    .prompt-bar-context {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 0 0 4px 0;
      display: none;
    }
    .prompt-bar-context.visible { display: block; }
    .prompt-bar-input-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .prompt-bar-input-row input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      outline: none;
      font-family: var(--vscode-font-family, sans-serif);
    }
    .prompt-bar-input-row input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .prompt-bar-input-row input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .prompt-bar-send {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .prompt-bar-send:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .prompt-bar-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .prompt-bar-suggestions {
      position: absolute;
      bottom: 100%;
      left: 12px;
      right: 12px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 6px;
      display: none;
      box-shadow: 0 -4px 12px rgba(0,0,0,0.3);
      max-height: 200px;
      overflow-y: auto;
      z-index: 150;
    }
    .prompt-bar-suggestions.visible { display: block; }
    .prompt-bar-suggestion {
      padding: 8px 12px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .prompt-bar-suggestion:hover,
    .prompt-bar-suggestion.selected {
      background: var(--vscode-list-hoverBackground);
    }
    .prompt-bar-suggestion .cmd {
      color: var(--vscode-textLink-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 600;
    }
    .prompt-bar-suggestion .desc {
      color: var(--vscode-descriptionForeground);
    }
    .prompt-bar-status {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 0 0 0;
      display: none;
    }
    .prompt-bar-status.visible { display: block; }
    .prompt-bar-status .progress-bar {
      height: 3px;
      background: var(--vscode-progressBar-background, #0078d4);
      border-radius: 2px;
      margin-top: 4px;
      transition: width 0.3s ease;
      max-width: 100%;
    }
    .prompt-bar-status span {
      display: block;
      line-height: 1.4;
    }

    /* Floating reimagine button — top-right corner outside frame */
    /* Collapsible right actions panel */
    .canvas-main-row {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .actions-panel {
      width: 0;
      overflow: hidden;
      background: var(--vscode-sideBar-background, #252526);
      border-left: 1px solid var(--vscode-panel-border, #555);
      transition: width 0.2s ease;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
    }
    .actions-panel.visible { width: 160px; }
    .actions-panel-header {
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground, #bbb);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      white-space: nowrap;
    }
    .action-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      width: 100%;
      white-space: nowrap;
    }
    .action-btn:hover { background: var(--vscode-list-hoverBackground); }
    .action-icon { width: 20px; text-align: center; flex-shrink: 0; }
    .actions-separator { height: 1px; background: var(--vscode-panel-border, #444); margin: 4px 12px; }
    .action-integrate { display: none; }
    .action-integrate.visible { display: flex; }

    /* Frames panel — thumbnail grid overlay */
    .frames-panel {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 88;
      background: var(--vscode-editor-background);
      display: none;
      overflow-y: auto;
      padding: 16px;
    }
    .frames-panel.visible { display: block; }
    .frames-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }
    .frame-thumb {
      cursor: pointer;
      border-radius: 6px;
      overflow: hidden;
      border: 2px solid transparent;
      background: var(--vscode-editorWidget-background, #2d2d2d);
    }
    .frame-thumb:hover { border-color: var(--vscode-focusBorder, #007fd4); }
    .frame-thumb.selected { border-color: var(--vscode-button-background); }
    .frame-thumb-img {
      width: 100%;
      aspect-ratio: 16/9;
      object-fit: cover;
      background: #222;
      display: block;
    }
    .frame-thumb-label {
      padding: 4px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Tab placeholder overlay — shown over selected frame when tab content missing */
    .tab-placeholder-overlay {
      position: absolute;
      display: none;
      z-index: 90;
      background: rgba(0,0,0,0.55);
      border-radius: 8px;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      pointer-events: auto;
    }
    .tab-placeholder-overlay.visible { display: flex; }
    .tab-placeholder-icon { font-size: 32px; opacity: 0.7; color: var(--vscode-foreground); }
    .tab-placeholder-label { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .tab-placeholder-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      padding: 8px 20px;
      font-size: 12px;
      cursor: pointer;
    }
    .tab-placeholder-btn:hover { opacity: 0.9; }

    /* Inline input modal — replaces window.prompt() which is unsupported in webviews */
    .inline-input-modal {
      display: none;
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 200;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #555);
      border-radius: 8px;
      padding: 16px 20px;
      min-width: 340px;
      max-width: 480px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .inline-input-modal.visible { display: block; }
    .inline-input-modal-label {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }
    .inline-input-modal input {
      width: 100%;
      padding: 6px 10px;
      font-size: 13px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      outline: none;
      font-family: inherit;
    }
    .inline-input-modal input:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .inline-input-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    .inline-input-modal-actions button {
      padding: 4px 14px;
      font-size: 12px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-family: inherit;
    }
    .inline-input-modal-actions .modal-cancel {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .inline-input-modal-actions .modal-submit {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .inline-input-modal-actions button:hover { opacity: 0.9; }

    /* Properties panel — right side overlay */
    .props-panel {
      position: absolute;
      top: 48px;
      right: 0;
      width: 280px;
      height: calc(100% - 96px);
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.97));
      border-left: 1px solid var(--vscode-editorWidget-border, #444);
      display: none;
      flex-direction: column;
      z-index: 90;
      font-size: 12px;
    }
    .props-panel.visible { display: flex; }
    .props-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, #444);
      font-weight: bold;
      font-size: 13px;
    }
    .props-panel-close {
      background: none; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 16px; padding: 0 4px;
    }
    .props-panel-close:hover { color: var(--vscode-errorForeground); }
    #props-panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
    }
    .props-panel-footer {
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-editorWidget-border, #444);
    }
    .props-category {
      margin-bottom: 12px;
    }
    .props-category-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .props-row {
      display: flex;
      align-items: center;
      margin-bottom: 6px;
      gap: 6px;
    }
    .props-row label {
      flex: 0 0 90px;
      font-size: 11px;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .props-row input, .props-row select {
      flex: 1;
      min-width: 0;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 11px;
      font-family: inherit;
    }
    .props-row input[type="color"] {
      width: 28px;
      height: 24px;
      flex: 0 0 28px;
      padding: 1px;
      cursor: pointer;
    }
    .props-row input[type="checkbox"] {
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
    }

    /* Global tab bar — persistent tabs at top of canvas */
    .canvas-global-tabs {
      display: flex;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.95));
      border-bottom: 1px solid var(--vscode-panel-border, #555);
      padding: 0 8px;
      gap: 0;
    }
    .global-tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--vscode-descriptionForeground);
      padding: 6px 16px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
    }
    .global-tab:hover { color: var(--vscode-foreground); }
    .global-tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-button-background);
    }

    /* (integrate button moved to actions panel) */

    /* Generation loader overlay — positioned over target frame */
    .gen-loader-overlay {
      position: absolute;
      z-index: 99;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.45);
      border-radius: 4px;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    .gen-loader-overlay .gen-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(255,255,255,0.25);
      border-top-color: var(--vscode-button-background, #007acc);
      border-radius: 50%;
      animation: gen-spin 0.8s linear infinite;
    }
    .gen-loader-overlay .gen-label {
      position: absolute;
      bottom: 8px;
      left: 0; right: 0;
      text-align: center;
      font-size: 11px;
      color: #fff;
      text-shadow: 0 1px 3px rgba(0,0,0,0.6);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 6px;
    }
    @keyframes gen-spin {
      to { transform: rotate(360deg); }
    }

    /* Video play icon overlay on poster images */
    .video-play-badge {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 40px;
      height: 40px;
      background: rgba(0,0,0,0.6);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .video-play-badge::after {
      content: '';
      display: block;
      width: 0;
      height: 0;
      border-style: solid;
      border-width: 8px 0 8px 14px;
      border-color: transparent transparent transparent #fff;
      margin-left: 2px;
    }

    /* Draft generation overlay */
    .draft-overlay {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      background: var(--vscode-editorWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 8px;
      padding: 16px;
      min-width: 400px;
      z-index: 200;
      display: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .draft-overlay.visible { display: block; }
    .draft-overlay h3 { font-size: 14px; margin-bottom: 10px; }
    .draft-overlay textarea {
      width: 100%;
      min-height: 80px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 4px;
      padding: 8px;
      font-size: 12px;
      resize: vertical;
      outline: none;
      font-family: inherit;
    }
    .draft-overlay textarea:focus { border-color: var(--vscode-focusBorder); }
    .draft-overlay-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      justify-content: flex-end;
    }
    .draft-progress {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .draft-progress-bar {
      width: 100%;
      height: 4px;
      background: var(--vscode-progressBar-background, #333);
      border-radius: 2px;
      margin-top: 4px;
      overflow: hidden;
    }
    .draft-progress-bar-fill {
      height: 100%;
      background: var(--vscode-button-background);
      transition: width 0.3s;
      width: 0%;
    }

    /* Prompt response panel */
    .prompt-response-panel {
      position: absolute;
      bottom: 40px;
      right: 12px;
      width: 360px;
      max-height: 300px;
      background: var(--vscode-editorWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 8px;
      padding: 10px;
      overflow-y: auto;
      display: none;
      z-index: 150;
      font-size: 12px;
      line-height: 1.5;
    }
    .prompt-response-panel.visible { display: block; }
    .prompt-response-close {
      position: absolute;
      top: 4px; right: 8px;
      background: none; border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 16px;
    }

    /* Image gen config panel */
    .config-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 300;
    }
    .config-overlay.visible { display: flex; }
    .batch-frame-list {
      max-height: 200px; overflow-y: auto; margin: 12px 0;
      display: flex; flex-direction: column; gap: 4px;
    }
    .batch-frame-item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; border-radius: 4px;
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
      font-size: 12px;
    }
    .batch-frame-role {
      font-size: 10px; padding: 1px 6px; border-radius: 3px;
      background: rgba(100,149,237,0.2); color: rgba(100,149,237,0.9);
    }
    .config-panel {
      background: var(--vscode-editorWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 10px;
      padding: 24px;
      width: 420px;
      max-width: 90vw;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .config-panel h3 {
      margin: 0 0 4px 0;
      font-size: 16px;
      color: var(--vscode-foreground);
    }
    .config-panel .config-subtitle {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 16px;
    }
    .config-panel label {
      display: block;
      font-size: 12px;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
      font-weight: 500;
    }
    .config-panel select,
    .config-panel input[type="password"] {
      width: 100%;
      padding: 8px 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 6px;
      font-size: 13px;
      outline: none;
      margin-bottom: 14px;
      box-sizing: border-box;
    }
    .config-panel select:focus,
    .config-panel input[type="password"]:focus {
      border-color: var(--vscode-focusBorder);
    }
    .config-provider-cards {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 14px;
    }
    .config-provider-card {
      border: 2px solid var(--vscode-panel-border, #444);
      border-radius: 8px;
      padding: 12px;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      text-align: center;
    }
    .config-provider-card:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
    }
    .config-provider-card.selected {
      border-color: var(--vscode-button-background);
      background: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,0.15));
    }
    .config-provider-card .provider-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 2px;
    }
    .config-provider-card .provider-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .config-provider-card .provider-price {
      font-size: 10px;
      color: var(--vscode-textLink-foreground);
      margin-top: 4px;
    }
    .config-key-help {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: -8px 0 14px 0;
    }
    .config-key-help a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .config-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 4px;
    }
    .config-actions button {
      padding: 8px 20px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }
    .config-actions .btn-cancel {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border, #555);
    }
    .config-actions .btn-save {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .config-actions .btn-save:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .config-actions .btn-save:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .config-success {
      display: none;
      text-align: center;
      padding: 12px;
      color: var(--vscode-testing-iconPassed, #4caf50);
      font-size: 13px;
    }
    .config-success.visible { display: block; }

    /* Hidden */
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="canvas-header">
    <img src="${logoUri}" class="canvas-header-logo" alt="Mysti">
    <span class="canvas-header-title">Mysti Canvas</span>
    <span id="session-name" class="canvas-header-session">Untitled Canvas</span>
    <button id="btn-ai-models" class="canvas-header-btn" title="Configure AI models"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg></button>
    <button id="btn-send-to-chat" class="canvas-header-btn" title="Send to chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></button>
    <button id="btn-export" class="canvas-header-btn" title="Export as PNG"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
    <button id="btn-save" class="canvas-header-btn" title="Save canvas"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></button>
  </div>

  <!-- Toolbar -->
  <div class="canvas-toolbar">
    <button class="tool-btn active" data-tool="select" title="Select (V)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2l12 10-5.5 1.2L8 18z"/><path d="M10.5 13.2L14 18"/></svg></button>
    <button class="tool-btn" data-tool="pencil" title="Pencil (P)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3L7 16H4v-3z"/><path d="M11 6l3 3"/></svg></button>
    <button class="tool-btn" data-tool="text" title="Text (T)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5V3h12v2"/><path d="M10 3v14"/><path d="M7 17h6"/></svg></button>
    <button class="tool-btn" data-tool="comment" title="Comment (C)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h14a1 1 0 011 1v8a1 1 0 01-1 1H8l-4 3v-3H3a1 1 0 01-1-1V5a1 1 0 011-1z"/></svg></button>
    <button class="tool-btn" data-tool="frame" title="Frame (F)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="1"/><path d="M3 7h14M3 13h14M7 3v14M13 3v14"/></svg></button>
    <button class="tool-btn" data-tool="image" title="Import Image (I)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l4-4 3 3 4-4 5 5"/></svg></button>
    <button class="tool-btn" data-tool="pan" title="Pan (Space)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v10M7 5V3.5a1.5 1.5 0 013 0M13 5V3.5a1.5 1.5 0 00-3 0M7 5v7a1.5 1.5 0 01-3 0V9M13 5v7a1.5 1.5 0 003 0V9M7 12a5 5 0 005 5h0a5 5 0 005-5"/></svg></button>
    <div class="tool-separator"></div>
    <button class="tool-btn" id="btn-undo" title="Undo (Ctrl+Z)" disabled><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h10a3 3 0 010 6H11"/><path d="M7 5L4 8l3 3"/></svg></button>
    <button class="tool-btn" id="btn-redo" title="Redo (Ctrl+Shift+Z)" disabled><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8H6a3 3 0 000 6h3"/><path d="M13 5l3 3-3 3"/></svg></button>
    <div class="tool-separator"></div>
    <label class="tool-label">Color</label>
    <input type="color" id="tool-color" class="tool-color-input" value="#ffffff">
    <label class="tool-label">Size</label>
    <input type="range" id="tool-size" class="tool-range" min="1" max="20" value="3">
  </div>

  <!-- Global tab bar -->
  <div class="canvas-global-tabs" id="canvas-global-tabs">
    <button class="global-tab" id="tab-frames" data-tab="frames">Frames</button>
    <button class="global-tab active" id="tab-image-video" data-tab="image">Image / Video</button>
    <button class="global-tab" id="tab-svg" data-tab="svg">SVG</button>
    <button class="global-tab" id="tab-components" data-tab="components">Components</button>
  </div>

  <!-- Main row: canvas + collapsible actions panel -->
  <div class="canvas-main-row">
  <!-- Canvas area -->
  <div class="canvas-area" id="canvas-area">
    <canvas id="fabric-canvas"></canvas>
    <!-- Live component iframe overlays -->
    <div id="iframe-overlay-container"></div>
    <!-- Inline input modal (replaces window.prompt) -->
    <div class="inline-input-modal" id="inline-input-modal">
      <div class="inline-input-modal-label" id="inline-input-label">Enter instruction:</div>
      <input type="text" id="inline-input-field" placeholder="Type here..." autocomplete="off" />
      <div class="inline-input-modal-actions">
        <button class="modal-cancel" id="inline-input-cancel">Cancel</button>
        <button class="modal-submit" id="inline-input-submit">Submit</button>
      </div>
    </div>
    <!-- Minimap -->
    <div class="minimap" id="minimap">
      <canvas id="minimap-canvas" width="150" height="100"></canvas>
      <div class="minimap-viewport" id="minimap-viewport"></div>
    </div>
    <!-- Zoom controls -->
    <div class="zoom-controls" id="zoom-controls">
      <button class="zoom-btn" id="btn-zoom-out" title="Zoom out (Ctrl+-)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8h10"/></svg></button>
      <button class="zoom-level" id="zoom-level-btn" title="Double-click to reset">100%</button>
      <button class="zoom-btn" id="btn-zoom-in" title="Zoom in (Ctrl+=)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8h10M8 3v10"/></svg></button>
      <button class="zoom-btn" id="btn-zoom-fit" title="Zoom to fit (Ctrl+0)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button>
    </div>
    <!-- Tab placeholder overlay (positioned over selected frame when tab content missing) -->
    <div class="tab-placeholder-overlay" id="tab-placeholder-overlay">
      <div class="tab-placeholder-icon" id="tab-placeholder-icon"></div>
      <div class="tab-placeholder-label" id="tab-placeholder-label">No content</div>
      <button class="tab-placeholder-btn" id="tab-placeholder-btn">Generate</button>
    </div>
    <!-- Frames panel (thumbnail grid, shown on Frames tab) -->
    <div class="frames-panel" id="frames-panel">
      <div class="frames-grid" id="frames-grid"></div>
    </div>
    <!-- Properties Panel -->
    <div id="props-panel" class="props-panel">
      <div class="props-panel-header">
        <span id="props-panel-title">Properties</span>
        <button class="props-panel-close" id="props-panel-close">&times;</button>
      </div>
      <div id="props-panel-body"></div>
      <div class="props-panel-footer">
        <button class="canvas-header-btn primary" id="btn-props-apply">Apply Changes</button>
      </div>
    </div>
  </div>
  <!-- Collapsible right actions panel -->
  <div class="actions-panel" id="actions-panel">
    <div class="actions-panel-header">Actions</div>
    <button class="action-btn" id="action-generate" title="Generate image"><span class="action-icon">&#9998;</span> Generate Image</button>
    <button class="action-btn" id="action-video" title="Generate video"><span class="action-icon">&#9654;</span> Generate Video</button>
    <button class="action-btn" id="action-svg" title="Convert to SVG"><span class="action-icon">S</span> Convert to SVG</button>
    <button class="action-btn" id="action-code" title="Generate component"><span class="action-icon">&lt;/&gt;</span> Generate Code</button>
    <button class="action-btn" id="action-reimagine" title="Reimagine"><span class="action-icon">&#10024;</span> Reimagine</button>
    <div class="actions-separator"></div>
    <button class="action-btn action-integrate" id="action-integrate" title="Integrate into project"><span class="action-icon">&#128204;</span> Integrate</button>
    <div class="actions-separator" id="element-actions-sep" style="display:none;"></div>
    <button class="action-btn" id="action-edit-element" style="display:none;" title="Edit selected element with AI"><span class="action-icon">&#9998;</span> Edit Element</button>
    <button class="action-btn" id="action-edit-layout" style="display:none;" title="Edit layout with AI"><span class="action-icon">&#9638;</span> Edit Layout</button>
  </div>
  </div><!-- end canvas-main-row -->

  <!-- Draft generation overlay -->
  <div class="draft-overlay" id="draft-overlay">
    <h3>Generate Draft Mockup</h3>
    <textarea id="draft-prompt" placeholder="Describe the page or component you want to visualize...&#10;&#10;e.g. A modern SaaS landing page with a hero section, navigation bar, and pricing cards"></textarea>
    <div class="draft-progress hidden" id="draft-progress">
      <span id="draft-progress-text">Generating...</span>
      <div class="draft-progress-bar"><div class="draft-progress-bar-fill" id="draft-progress-fill"></div></div>
    </div>
    <div class="draft-overlay-actions">
      <button class="canvas-header-btn" id="btn-draft-cancel">Cancel</button>
      <button class="canvas-header-btn primary" id="btn-draft-generate">Generate</button>
    </div>
  </div>

  <!-- Prompt response panel -->
  <div class="prompt-response-panel" id="prompt-response-panel">
    <button class="prompt-response-close" id="btn-response-close">&#10005;</button>
    <div id="prompt-response-content"></div>
  </div>

  <!-- Image generation config panel -->
  <div class="config-overlay" id="config-overlay">
    <div class="config-panel">
      <h3>Configure AI Generation</h3>
      <p class="config-subtitle">Select a provider and enter your API key to enable AI image and video generation on the canvas.</p>

      <label>Image Generation</label>
      <div class="config-provider-cards" id="config-provider-cards">
        <div class="config-provider-card" data-provider="gpt-image-1.5">
          <div class="provider-name">GPT Image 1.5</div>
          <div class="provider-desc">Best quality, fastest</div>
          <div class="provider-price">~$0.04/image</div>
        </div>
        <div class="config-provider-card" data-provider="gpt-image-1">
          <div class="provider-name">GPT Image 1</div>
          <div class="provider-desc">Great quality</div>
          <div class="provider-price">~$0.02/image</div>
        </div>
        <div class="config-provider-card" data-provider="gpt-image-1-mini">
          <div class="provider-name">GPT Image 1 Mini</div>
          <div class="provider-desc">Budget-friendly</div>
          <div class="provider-price">~$0.005/image</div>
        </div>
        <div class="config-provider-card" data-provider="nano-banana">
          <div class="provider-name">Gemini 3.1 Flash</div>
          <div class="provider-desc">Fast, free tier</div>
          <div class="provider-price">Free tier available</div>
        </div>
        <div class="config-provider-card" data-provider="nano-banana-pro">
          <div class="provider-name">Gemini 3 Pro</div>
          <div class="provider-desc">Highest quality</div>
          <div class="provider-price">Free tier available</div>
        </div>
      </div>

      <label style="margin-top:12px;">Video Generation</label>
      <div class="config-provider-cards" id="config-video-provider-cards">
        <div class="config-provider-card" data-provider="sora">
          <div class="provider-name">Sora 2</div>
          <div class="provider-desc">OpenAI video gen</div>
          <div class="provider-price">~$0.10/sec</div>
        </div>
        <div class="config-provider-card" data-provider="veo">
          <div class="provider-name">Veo 3.1</div>
          <div class="provider-desc">Google video gen</div>
          <div class="provider-price">~$0.15/sec</div>
        </div>
      </div>
      <p class="config-subtitle" style="font-size:11px;margin-top:4px;opacity:0.7;">Video providers use the same API keys as image providers (OpenAI / Gemini).</p>

      <label id="config-key-label">API Key</label>
      <input type="password" id="config-api-key" placeholder="Paste your API key here..." />
      <div class="config-key-help" id="config-key-help">
        Get a free Gemini API key at <a href="https://aistudio.google.com/apikey" id="config-key-link">aistudio.google.com/apikey</a>
      </div>

      <div class="config-success" id="config-success">&#10003; Configuration saved! You can now use image generation.</div>

      <div class="config-actions" id="config-actions">
        <button class="btn-cancel" id="btn-config-cancel">Cancel</button>
        <button class="btn-save" id="btn-config-save" disabled>Save &amp; Continue</button>
      </div>
    </div>
  </div>

  <!-- Batch content generation modal -->
  <div class="config-overlay" id="batch-gen-overlay">
    <div class="config-panel">
      <h3>Generate Content for Frames</h3>
      <p class="config-subtitle">Generate images for all <strong id="batch-frame-count">0</strong> frames with a unified visual theme.</p>
      <div id="batch-frame-list" class="batch-frame-list"></div>
      <div class="config-actions">
        <button class="btn-cancel" id="btn-batch-cancel">Skip</button>
        <button class="btn-save" id="btn-batch-generate">Generate All</button>
      </div>
    </div>
  </div>

  <!-- Unified prompt bar -->
  <div class="canvas-prompt-bar" id="canvas-prompt-bar">
    <div class="prompt-bar-context" id="prompt-bar-context"></div>
    <div class="prompt-bar-input-row">
      <input type="text" id="unified-prompt-input"
             placeholder="Type a prompt, or /render, /generate, /reimagine, /video..."
             autocomplete="off" />
      <button class="prompt-bar-send" id="btn-unified-send">Send</button>
    </div>
    <div class="prompt-bar-suggestions" id="prompt-bar-suggestions"></div>
    <div class="prompt-bar-status" id="prompt-bar-status"></div>
  </div>

  <!-- Status bar -->
  <div class="canvas-statusbar">
    <span id="status-zoom" class="status-clickable" title="Click to zoom-to-fit">100%</span>
    <span class="status-sep">|</span>
    <span id="status-cursor">X: 0 Y: 0</span>
    <span id="status-selection"></span>
    <span class="status-sep">|</span>
    <span id="status-objects">0 objects</span>
    <span id="status-tool">Select</span>
    <span style="flex:1"></span>
    <span class="status-muted">Mysti Canvas v${version}</span>
  </div>

  <script nonce="${nonce}" src="${fabricUri}"></script>
  <script nonce="${nonce}">
  (function() {
    var vscodeApi = acquireVsCodeApi();
    var canvasArea = document.getElementById('canvas-area');
    var fabricCanvasEl = document.getElementById('fabric-canvas');

    // ====================================================================
    // Wait for Fabric.js to load (handles async script timing)
    // ====================================================================
    function waitForFabric(cb, retries) {
      if (typeof fabric !== 'undefined') { cb(); return; }
      if (retries <= 0) {
        canvasArea.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vscode-errorForeground);font-size:14px;">' +
          'Failed to load Fabric.js canvas library.<br><br>' +
          '<span style="color:var(--vscode-descriptionForeground);font-size:12px;">Try reloading the window (Cmd+Shift+P → Developer: Reload Window)</span></div>';
        return;
      }
      setTimeout(function() { waitForFabric(cb, retries - 1); }, 100);
    }

    console.log('[Mysti Canvas] Waiting for Fabric.js...');
    waitForFabric(initCanvas, 30); // retry up to 3 seconds

    function initCanvas() {
    console.log('[Mysti Canvas] Fabric.js loaded, waiting for layout...');

    // Wait for layout to compute non-zero dimensions
    function initWhenSized() {
      if (canvasArea.clientWidth > 0 && canvasArea.clientHeight > 0) {
        console.log('[Mysti Canvas] Layout ready (' + canvasArea.clientWidth + 'x' + canvasArea.clientHeight + '), creating canvas...');
        try {
          createCanvas();
        } catch (err) {
          console.error('[Mysti Canvas] FATAL: createCanvas() threw:', err);
          canvasArea.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vscode-errorForeground);font-size:14px;">' +
            'Canvas initialization error: ' + (err.message || err) + '<br><br>' +
            '<span style="color:var(--vscode-descriptionForeground);font-size:12px;">Check Developer Tools console for details</span></div>';
        }
      } else {
        requestAnimationFrame(initWhenSized);
      }
    }
    initWhenSized();

    function createCanvas() {
    var canvas;
    try {
      fabricCanvasEl.width = canvasArea.clientWidth;
      fabricCanvasEl.height = canvasArea.clientHeight;

      canvas = new fabric.Canvas('fabric-canvas', {
        width: canvasArea.clientWidth,
        height: canvasArea.clientHeight,
        backgroundColor: 'transparent',
        selection: true,
        preserveObjectStacking: true,
      });
    } catch (err) {
      canvasArea.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vscode-errorForeground);font-size:14px;">' +
        'Failed to initialize canvas: ' + err.message + '</div>';
      return;
    }

    // Figma-like selection controls (merged into each object constructor)
    var controlStyle = {
      cornerSize: 10,
      cornerColor: '#ffffff',
      cornerStrokeColor: '#3794ff',
      cornerStyle: 'circle',
      transparentCorners: false,
      borderColor: '#3794ff',
      borderScaleFactor: 1.5,
      padding: 0,
    };

    // Resolve CSS variable to actual font family for fabric.js text measurement
    var resolvedFont = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || '-apple-system, BlinkMacSystemFont, sans-serif';

    // Resize handler
    var resizeObserver = new ResizeObserver(function() {
      if (canvasArea.clientWidth > 0 && canvasArea.clientHeight > 0) {
        canvas.setDimensions({ width: canvasArea.clientWidth, height: canvasArea.clientHeight });
        canvas.renderAll();
      }
    });
    resizeObserver.observe(canvasArea);

    // ====================================================================
    // State
    // ====================================================================
    var currentTool = 'select';
    var isPanning = false;
    var lastPanPoint = null;
    var spaceDown = false;
    var canvasSessionId = null;
    var objectIdCounter = 0;
    var isDrawingFrame = false;
    var frameStartPoint = null;
    var currentFrameRect = null;

    // Undo/Redo
    var undoStack = [];
    var redoStack = [];
    var maxHistorySize = 50;
    var isUndoRedoing = false;
    var historyTimer = null;

    // Zoom animation
    var zoomAnimationFrame = null;

    // Pan inertia
    var panVelocity = { x: 0, y: 0 };
    var lastPanTime = 0;
    var inertiaFrame = null;

    // Minimap
    var minimapVisible = true;
    var lastMinimapUpdate = 0;

    // ====================================================================
    // Tool switching
    // ====================================================================
    var toolBtns = document.querySelectorAll('.tool-btn[data-tool]');
    toolBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        setTool(btn.getAttribute('data-tool'));
      });
    });

    function setTool(tool) {
      currentTool = tool;
      toolBtns.forEach(function(b) { b.classList.remove('active'); });
      var activeBtn = document.querySelector('.tool-btn[data-tool="' + tool + '"]');
      if (activeBtn) { activeBtn.classList.add('active'); }

      canvas.isDrawingMode = (tool === 'pencil');
      canvas.selection = (tool === 'select');
      canvas.defaultCursor = (tool === 'pan') ? 'grab' : 'default';

      if (tool === 'pencil') {
        canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
        canvas.freeDrawingBrush.color = document.getElementById('tool-color').value;
        canvas.freeDrawingBrush.width = parseInt(document.getElementById('tool-size').value);
      }

      document.getElementById('status-tool').textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
    }

    // Color and size controls
    document.getElementById('tool-color').addEventListener('input', function(e) {
      if (canvas.freeDrawingBrush) {
        canvas.freeDrawingBrush.color = e.target.value;
      }
      // Update selected object color
      var active = canvas.getActiveObject();
      if (active) {
        if (active.type === 'i-text' || active.type === 'textbox') {
          active.set('fill', e.target.value);
        } else {
          active.set('stroke', e.target.value);
        }
        canvas.renderAll();
        autoSave();
      }
    });

    document.getElementById('tool-size').addEventListener('input', function(e) {
      if (canvas.freeDrawingBrush) {
        canvas.freeDrawingBrush.width = parseInt(e.target.value);
      }
    });

    // ====================================================================
    // Pan & Zoom
    // ====================================================================
    canvas.on('mouse:down', function(opt) {
      // Cancel any ongoing inertia
      if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; }

      if (currentTool === 'pan' || spaceDown || (opt.e && opt.e.button === 1)) {
        isPanning = true;
        lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
        lastPanTime = performance.now();
        panVelocity = { x: 0, y: 0 };
        canvas.defaultCursor = 'grabbing';
        canvas.selection = false;
        opt.e.preventDefault();
        return;
      }

      // Text tool: place text on click
      if (currentTool === 'text') {
        // If clicking existing IText/Textbox, switch to select and defer editing
        if (opt.target && (opt.target.type === 'i-text' || opt.target.type === 'textbox')) {
          var editTarget = opt.target;
          setTool('select');
          setTimeout(function() { editTarget.enterEditing(); canvas.renderAll(); }, 0);
          return;
        }
        setTool('select'); // Switch FIRST so canvas.selection = true
        var pointer = canvas.getViewportPoint(opt.e);
        var text = new fabric.IText('', Object.assign({}, controlStyle, {
          left: pointer.x,
          top: pointer.y,
          fontSize: 16,
          fill: document.getElementById('tool-color').value,
          fontFamily: resolvedFont,
          id: 'text-' + (++objectIdCounter),
          editable: true,
          selectable: true,
          minWidth: 20,
        }));
        canvas.add(text);
        canvas.setActiveObject(text);
        autoSave();
        setTimeout(function() { text.enterEditing(); canvas.renderAll(); }, 0);
        return;
      }

      // Comment tool: place sticky note (flat Rect + Textbox)
      if (currentTool === 'comment') {
        // If clicking existing IText/Textbox, switch to select and defer editing
        if (opt.target && (opt.target.type === 'i-text' || opt.target.type === 'textbox')) {
          var editTarget = opt.target;
          setTool('select');
          setTimeout(function() { editTarget.enterEditing(); canvas.renderAll(); }, 0);
          return;
        }
        setTool('select'); // Switch FIRST
        var pointer = canvas.getViewportPoint(opt.e);
        var commentId = 'comment-' + (++objectIdCounter);
        var commentBg = new fabric.Rect({
          left: pointer.x,
          top: pointer.y,
          width: 150,
          height: 60,
          fill: '#ffd54f',
          rx: 4,
          ry: 4,
          selectable: false,
          evented: false,
          id: commentId + '-bg',
          shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.2)', blur: 4, offsetX: 1, offsetY: 1 }),
        });
        var commentText = new fabric.Textbox('Comment', Object.assign({}, controlStyle, {
          left: pointer.x + 8,
          top: pointer.y + 8,
          width: 134,
          fontSize: 12,
          fill: '#1e1e1e',
          fontFamily: resolvedFont,
          id: commentId,
          editable: true,
          selectable: true,
          _commentBgId: commentId + '-bg',
        }));
        canvas.add(commentBg);
        canvas.add(commentText);
        canvas.setActiveObject(commentText);
        autoSave();
        setTimeout(function() { commentText.enterEditing(); canvas.renderAll(); }, 0);
        return;
      }

      // Frame tool: start drawing frame
      if (currentTool === 'frame' && !opt.target) {
        isDrawingFrame = true;
        frameStartPoint = canvas.getViewportPoint(opt.e);
        currentFrameRect = new fabric.Rect(Object.assign({}, controlStyle, {
          left: frameStartPoint.x,
          top: frameStartPoint.y,
          width: 0,
          height: 0,
          fill: 'rgba(100, 149, 237, 0.05)',
          stroke: 'rgba(100, 149, 237, 0.6)',
          strokeWidth: 2,
          strokeDashArray: [8, 4],
          selectable: true,
          id: 'frame-' + (++objectIdCounter),
          label: 'Frame',
        }));
        canvas.add(currentFrameRect);
        return;
      }

      // Image tool: open file picker
      if (currentTool === 'image' && !opt.target) {
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.onchange = function(ev) {
          var file = ev.target.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function(e) {
            var imgEl = new Image();
            imgEl.onload = function() {
              var fabricImg = new fabric.FabricImage(imgEl, Object.assign({}, controlStyle, {
                left: 100,
                top: 100,
                id: 'image-' + (++objectIdCounter),
              }));
              // Scale down if too large
              if (fabricImg.width > 800) {
                fabricImg.scaleToWidth(800);
              }
              canvas.add(fabricImg);
              canvas.setActiveObject(fabricImg);
              autoSave();
            };
            imgEl.src = e.target.result;
          };
          reader.readAsDataURL(file);
        };
        fileInput.click();
        setTool('select');
        return;
      }
    });

    var cursorThrottleTime = 0;
    canvas.on('mouse:move', function(opt) {
      // Update cursor coordinates in status bar (throttled)
      var now = performance.now();
      if (now - cursorThrottleTime > 50) {
        cursorThrottleTime = now;
        var pointer = canvas.getViewportPoint(opt.e);
        document.getElementById('status-cursor').textContent = 'X: ' + Math.round(pointer.x) + ' Y: ' + Math.round(pointer.y);
      }

      if (isPanning && lastPanPoint) {
        var dx = opt.e.clientX - lastPanPoint.x;
        var dy = opt.e.clientY - lastPanPoint.y;
        var now = performance.now();
        var dt = now - lastPanTime;
        if (dt > 0) {
          panVelocity = { x: (dx / dt) * 16, y: (dy / dt) * 16 };
        }
        lastPanTime = now;
        var vpt = canvas.viewportTransform.slice();
        vpt[4] += dx;
        vpt[5] += dy;
        canvas.setViewportTransform(vpt);
        _debouncedSyncAllIframes();
        lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
        return;
      }

      // Frame drawing
      if (isDrawingFrame && currentFrameRect && frameStartPoint) {
        var pointer = canvas.getViewportPoint(opt.e);
        var left = Math.min(frameStartPoint.x, pointer.x);
        var top = Math.min(frameStartPoint.y, pointer.y);
        var width = Math.abs(pointer.x - frameStartPoint.x);
        var height = Math.abs(pointer.y - frameStartPoint.y);
        currentFrameRect.set({ left: left, top: top, width: width, height: height });
        canvas.renderAll();
      }
    });

    canvas.on('mouse:up', function() {
      if (isPanning) {
        isPanning = false;
        lastPanPoint = null;
        canvas.defaultCursor = (currentTool === 'pan') ? 'grab' : 'default';
        if (currentTool !== 'pan') { canvas.selection = true; }
        // Pan inertia
        if (Math.abs(panVelocity.x) > 0.5 || Math.abs(panVelocity.y) > 0.5) {
          var friction = 0.92;
          (function inertiaStep() {
            if (Math.abs(panVelocity.x) < 0.5 && Math.abs(panVelocity.y) < 0.5) { inertiaFrame = null; return; }
            var vpt = canvas.viewportTransform.slice();
            vpt[4] += panVelocity.x; vpt[5] += panVelocity.y;
            canvas.setViewportTransform(vpt);
            _debouncedSyncAllIframes();
            panVelocity.x *= friction; panVelocity.y *= friction;
            inertiaFrame = requestAnimationFrame(inertiaStep);
          })();
        }
        return;
      }

      if (isDrawingFrame) {
        isDrawingFrame = false;
        if (currentFrameRect && currentFrameRect.width < 10 && currentFrameRect.height < 10) {
          canvas.remove(currentFrameRect);
        } else {
          canvas.setActiveObject(currentFrameRect);
          autoSave();
        }
        currentFrameRect = null;
        frameStartPoint = null;
        setTool('select');
      }
    });

    // ====================================================================
    // Zoom functions
    // ====================================================================
    function updateZoomDisplay(zoom) {
      var pct = Math.round(zoom * 100) + '%';
      document.getElementById('status-zoom').textContent = pct;
      document.getElementById('zoom-level-btn').textContent = pct;
    }

    function smoothZoomTo(newZoom, pointX, pointY) {
      newZoom = Math.max(0.1, Math.min(5, newZoom));
      var startZoom = canvas.getZoom();
      var startTime = performance.now();
      var duration = 150;
      if (zoomAnimationFrame) cancelAnimationFrame(zoomAnimationFrame);
      (function animate(now) {
        var t = Math.min((now - startTime) / duration, 1);
        t = 1 - Math.pow(1 - t, 3); // ease-out cubic
        canvas.zoomToPoint(new fabric.Point(pointX, pointY), startZoom + (newZoom - startZoom) * t);
        updateZoomDisplay(canvas.getZoom());
        _debouncedSyncAllIframes();
        if (t < 1) zoomAnimationFrame = requestAnimationFrame(animate);
        else zoomAnimationFrame = null;
      })(performance.now());
    }

    function zoomToFit() {
      var objects = canvas.getObjects();
      if (!objects.length) {
        canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        updateZoomDisplay(1);
        return;
      }
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      objects.forEach(function(obj) {
        var b = obj.getBoundingRect();
        minX = Math.min(minX, b.left); minY = Math.min(minY, b.top);
        maxX = Math.max(maxX, b.left + b.width); maxY = Math.max(maxY, b.top + b.height);
      });
      var pad = 60;
      var zoom = Math.min(
        (canvasArea.clientWidth - pad * 2) / (maxX - minX),
        (canvasArea.clientHeight - pad * 2) / (maxY - minY),
        5
      );
      zoom = Math.max(0.1, zoom);
      var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      canvas.setViewportTransform([zoom, 0, 0, zoom, canvasArea.clientWidth / 2 - cx * zoom, canvasArea.clientHeight / 2 - cy * zoom]);
      updateZoomDisplay(zoom);
      _debouncedSyncAllIframes();
    }

    // Zoom with mouse wheel (smooth)
    canvas.on('mouse:wheel', function(opt) {
      var delta = opt.e.deltaY;
      var zoom = canvas.getZoom();
      var newZoom = zoom * (0.999 ** delta);
      smoothZoomTo(newZoom, opt.e.offsetX, opt.e.offsetY);
      _debouncedSyncAllIframes();
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });

    // Zoom control buttons
    document.getElementById('btn-zoom-in').addEventListener('click', function() {
      var z = canvas.getZoom();
      smoothZoomTo(z * 1.25, canvasArea.clientWidth / 2, canvasArea.clientHeight / 2);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', function() {
      var z = canvas.getZoom();
      smoothZoomTo(z * 0.8, canvasArea.clientWidth / 2, canvasArea.clientHeight / 2);
    });
    document.getElementById('btn-zoom-fit').addEventListener('click', zoomToFit);
    document.getElementById('zoom-level-btn').addEventListener('dblclick', function() {
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      updateZoomDisplay(1);
      _debouncedSyncAllIframes();
    });
    document.getElementById('status-zoom').addEventListener('click', zoomToFit);

    // ====================================================================
    // Undo / Redo
    // ====================================================================
    var customJsonProps = ['id', 'label', 'description', 'metadata', 'videoData', 'videoMimeType', 'isVideo', '_commentBgId', '_viewData'];

    function saveHistoryState() {
      if (isUndoRedoing) return;
      clearTimeout(historyTimer);
      historyTimer = setTimeout(function() {
        var json = canvas.toJSON(customJsonProps);
        undoStack.push(JSON.stringify(json));
        if (undoStack.length > maxHistorySize) undoStack.shift();
        redoStack = [];
        updateUndoRedoButtons();
      }, 150);
    }

    function undo() {
      if (undoStack.length === 0) return;
      clearTimeout(historyTimer);
      // Exit any active text editing before undo
      var active = canvas.getActiveObject();
      if (active && active.isEditing) { active.exitEditing(); }
      canvas.discardActiveObject();
      isUndoRedoing = true;
      try {
        var currentState = JSON.stringify(canvas.toJSON(customJsonProps));
        redoStack.push(currentState);
        var prevState = undoStack.pop();
        canvas.loadFromJSON(JSON.parse(prevState), function() {
          canvas.getObjects().forEach(function(obj) { obj.set(controlStyle); });
          canvas.renderAll();
          isUndoRedoing = false;
          updateUndoRedoButtons();
          updateObjectCount();
        });
      } catch (e) {
        console.error('[Mysti Canvas] Undo failed:', e);
        isUndoRedoing = false;
      }
    }

    function redo() {
      if (redoStack.length === 0) return;
      clearTimeout(historyTimer);
      // Exit any active text editing before redo
      var active = canvas.getActiveObject();
      if (active && active.isEditing) { active.exitEditing(); }
      canvas.discardActiveObject();
      isUndoRedoing = true;
      try {
        var currentState = JSON.stringify(canvas.toJSON(customJsonProps));
        undoStack.push(currentState);
        var nextState = redoStack.pop();
        canvas.loadFromJSON(JSON.parse(nextState), function() {
          canvas.getObjects().forEach(function(obj) { obj.set(controlStyle); });
          canvas.renderAll();
          isUndoRedoing = false;
          updateUndoRedoButtons();
          updateObjectCount();
        });
      } catch (e) {
        console.error('[Mysti Canvas] Redo failed:', e);
        isUndoRedoing = false;
      }
    }

    function updateUndoRedoButtons() {
      document.getElementById('btn-undo').disabled = undoStack.length === 0;
      document.getElementById('btn-redo').disabled = redoStack.length === 0;
    }

    canvas.on('object:added', function() { saveHistoryState(); });
    canvas.on('object:removed', function() { saveHistoryState(); });
    canvas.on('object:modified', function() { saveHistoryState(); });
    canvas.on('path:created', function() { saveHistoryState(); });

    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);

    // Save initial state
    saveHistoryState();

    // ====================================================================
    // Dot grid background
    // ====================================================================
    canvas.on('after:render', function() {
      var ctx = canvas.getContext();
      var vpt = canvas.viewportTransform;
      var zoom = canvas.getZoom();
      // Skip grid at very low zoom to avoid millions of dots
      if (zoom < 0.15) return;
      var gridSize = 20;
      var dotRadius = 0.8;
      var left = -vpt[4] / zoom;
      var top = -vpt[5] / zoom;
      var right = left + canvasArea.clientWidth / zoom;
      var bottom = top + canvasArea.clientHeight / zoom;
      var startX = Math.floor(left / gridSize) * gridSize;
      var startY = Math.floor(top / gridSize) * gridSize;
      // Safety cap: skip if too many dots would be drawn
      var xCount = (right - startX) / gridSize;
      var yCount = (bottom - startY) / gridSize;
      if (xCount * yCount > 10000) return;
      ctx.save();
      ctx.fillStyle = 'rgba(128,128,128,0.15)';
      for (var x = startX; x < right; x += gridSize) {
        for (var y = startY; y < bottom; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x * zoom + vpt[4], y * zoom + vpt[5], dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    });

    // ====================================================================
    // Minimap
    // ====================================================================
    var minimapCanvas = document.getElementById('minimap-canvas');
    var minimapCtx = minimapCanvas.getContext('2d');
    var minimapViewport = document.getElementById('minimap-viewport');
    var minimapEl = document.getElementById('minimap');

    function updateMinimap() {
      var now = performance.now();
      if (now - lastMinimapUpdate < 100) return;
      lastMinimapUpdate = now;

      var mw = 150, mh = 100;
      minimapCtx.clearRect(0, 0, mw, mh);

      var objects = canvas.getObjects();
      if (!objects.length) {
        minimapViewport.style.display = 'none';
        return;
      }

      // Compute world bounds
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      objects.forEach(function(obj) {
        var b = obj.getBoundingRect();
        // Convert from viewport to world coords
        var zoom = canvas.getZoom();
        var vpt = canvas.viewportTransform;
        var wLeft = (b.left - vpt[4]) / zoom;
        var wTop = (b.top - vpt[5]) / zoom;
        var wRight = wLeft + b.width / zoom;
        var wBottom = wTop + b.height / zoom;
        minX = Math.min(minX, wLeft); minY = Math.min(minY, wTop);
        maxX = Math.max(maxX, wRight); maxY = Math.max(maxY, wBottom);
      });

      // Add padding
      var pad = 100;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      var worldW = Math.max(1, maxX - minX);
      var worldH = Math.max(1, maxY - minY);
      var scale = Math.min(mw / worldW, mh / worldH);

      // Draw objects as colored rects
      minimapCtx.fillStyle = 'rgba(128,160,255,0.4)';
      objects.forEach(function(obj) {
        var b = obj.getBoundingRect();
        var zoom = canvas.getZoom();
        var vpt = canvas.viewportTransform;
        var wLeft = (b.left - vpt[4]) / zoom;
        var wTop = (b.top - vpt[5]) / zoom;
        var wW = b.width / zoom;
        var wH = b.height / zoom;
        minimapCtx.fillRect(
          (wLeft - minX) * scale,
          (wTop - minY) * scale,
          Math.max(2, wW * scale),
          Math.max(2, wH * scale)
        );
      });

      // Show viewport rect
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      var vpLeft = -vpt[4] / zoom;
      var vpTop = -vpt[5] / zoom;
      var vpW = canvasArea.clientWidth / zoom;
      var vpH = canvasArea.clientHeight / zoom;

      minimapViewport.style.display = 'block';
      minimapViewport.style.left = ((vpLeft - minX) * scale) + 'px';
      minimapViewport.style.top = ((vpTop - minY) * scale) + 'px';
      minimapViewport.style.width = (vpW * scale) + 'px';
      minimapViewport.style.height = (vpH * scale) + 'px';

      // Store bounds for click-to-navigate
      minimapEl._worldBounds = { minX: minX, minY: minY, worldW: worldW, worldH: worldH, scale: scale };
    }

    canvas.on('after:render', updateMinimap);

    // Click-to-navigate on minimap
    minimapEl.addEventListener('click', function(e) {
      var bounds = minimapEl._worldBounds;
      if (!bounds) return;
      var rect = minimapEl.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var worldX = mx / bounds.scale + bounds.minX;
      var worldY = my / bounds.scale + bounds.minY;
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform.slice();
      vpt[4] = canvasArea.clientWidth / 2 - worldX * zoom;
      vpt[5] = canvasArea.clientHeight / 2 - worldY * zoom;
      canvas.setViewportTransform(vpt);
    });

    // ====================================================================
    // Selection info in status bar
    // ====================================================================
    function updateSelectionStatus() {
      var active = canvas.getActiveObject();
      var el = document.getElementById('status-selection');
      if (active) {
        var b = active.getBoundingRect();
        var zoom = canvas.getZoom();
        el.textContent = ' | ' + Math.round(b.width / zoom) + ' \u00d7 ' + Math.round(b.height / zoom);
      } else {
        el.textContent = '';
      }
    }
    canvas.on('selection:created', updateSelectionStatus);
    canvas.on('selection:updated', updateSelectionStatus);
    canvas.on('selection:cleared', updateSelectionStatus);
    canvas.on('object:scaling', updateSelectionStatus);
    canvas.on('object:moving', updateSelectionStatus);

    // Sync comment bg position and size with its textbox
    function syncCommentBg(obj) {
      if (!obj._commentBgId) return;
      var bg = canvas.getObjects().find(function(o) { return o.id === obj._commentBgId; });
      if (!bg) return;
      var w = (obj.width || 134) * (obj.scaleX || 1);
      var h = (obj.height || 44) * (obj.scaleY || 1);
      bg.set({ left: obj.left - 8, top: obj.top - 8, width: w + 16, height: h + 16 });
    }
    canvas.on('object:moving', function(opt) { syncCommentBg(opt.target); });
    canvas.on('object:scaling', function(opt) { syncCommentBg(opt.target); });
    canvas.on('object:modified', function(opt) { syncCommentBg(opt.target); });

    // ====================================================================
    // Double-click focus / text editing
    // ====================================================================
    canvas.on('mouse:dblclick', function(opt) {
      if (!opt.target) return;
      if (opt.target.isVideo) return; // skip video objects
      // Enter edit mode for text objects
      if (opt.target.type === 'i-text' || opt.target.type === 'textbox') {
        if (!opt.target.isEditing) {
          canvas.setActiveObject(opt.target);
          opt.target.enterEditing();
        }
        return; // Don't zoom-focus on text
      }
      var b = opt.target.getBoundingRect();
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      var wLeft = (b.left - vpt[4]) / zoom;
      var wTop = (b.top - vpt[5]) / zoom;
      var wW = b.width / zoom;
      var wH = b.height / zoom;
      var pad = 80;
      var newZoom = Math.min(
        (canvasArea.clientWidth - pad * 2) / wW,
        (canvasArea.clientHeight - pad * 2) / wH,
        5
      );
      newZoom = Math.max(0.1, newZoom);
      var cx = wLeft + wW / 2, cy = wTop + wH / 2;
      // Animate viewport transition
      var startVpt = canvas.viewportTransform.slice();
      var endVpt = [newZoom, 0, 0, newZoom, canvasArea.clientWidth / 2 - cx * newZoom, canvasArea.clientHeight / 2 - cy * newZoom];
      var startTime = performance.now();
      var duration = 200;
      if (zoomAnimationFrame) cancelAnimationFrame(zoomAnimationFrame);
      (function animateFocus(now) {
        var t = Math.min((now - startTime) / duration, 1);
        t = 1 - Math.pow(1 - t, 3); // ease-out cubic
        var vpt = [];
        for (var i = 0; i < 6; i++) { vpt[i] = startVpt[i] + (endVpt[i] - startVpt[i]) * t; }
        canvas.setViewportTransform(vpt);
        updateZoomDisplay(vpt[0]);
        if (t < 1) zoomAnimationFrame = requestAnimationFrame(animateFocus);
        else zoomAnimationFrame = null;
      })(performance.now());
    });

    // Space key for pan + keyboard shortcuts
    document.addEventListener('keydown', function(e) {
      if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        spaceDown = true;
        canvas.defaultCursor = 'grab';
        e.preventDefault();
      }

      // Ctrl/Cmd shortcuts (work even in input for zoom)
      if (e.ctrlKey || e.metaKey) {
        if (e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
          redo(); e.preventDefault(); return;
        }
        if (e.key === 'z' || e.key === 'Z') {
          undo(); e.preventDefault(); return;
        }
        if (e.key === 'y' || e.key === 'Y') {
          redo(); e.preventDefault(); return;
        }
        if (e.key === '=' || e.key === '+') {
          smoothZoomTo(canvas.getZoom() * 1.25, canvasArea.clientWidth / 2, canvasArea.clientHeight / 2);
          e.preventDefault(); return;
        }
        if (e.key === '-') {
          smoothZoomTo(canvas.getZoom() * 0.8, canvasArea.clientWidth / 2, canvasArea.clientHeight / 2);
          e.preventDefault(); return;
        }
        if (e.key === '0') {
          zoomToFit(); e.preventDefault(); return;
        }
        if (e.key === '1') {
          canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
          updateZoomDisplay(1);
          e.preventDefault(); return;
        }
      }

      // Tool shortcuts (only when not focused on input)
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 'p': setTool('pencil'); break;
        case 't': setTool('text'); break;
        case 'c': setTool('comment'); break;
        case 'f': setTool('frame'); break;
        case 'i': setTool('image'); break;
        case 'm':
          minimapVisible = !minimapVisible;
          minimapEl.classList.toggle('hidden', !minimapVisible);
          break;
        case 'delete': case 'backspace':
          var active = canvas.getActiveObjects();
          active.forEach(function(obj) { canvas.remove(obj); });
          canvas.discardActiveObject();
          canvas.renderAll();
          autoSave();
          break;
      }
    });

    document.addEventListener('keyup', function(e) {
      if (e.code === 'Space') {
        spaceDown = false;
        canvas.defaultCursor = (currentTool === 'pan') ? 'grab' : 'default';
      }
    });

    // ====================================================================
    // Object count tracking
    // ====================================================================
    function updateObjectCount() {
      document.getElementById('status-objects').textContent = canvas.getObjects().length + ' objects';
    }
    canvas.on('object:added', updateObjectCount);
    canvas.on('object:removed', updateObjectCount);

    // ====================================================================
    // Selection controls — collapsible right actions panel + placeholder
    // ====================================================================
    var actionsPanel = document.getElementById('actions-panel');
    var actionIntegrate = document.getElementById('action-integrate');
    var placeholderOverlay = document.getElementById('tab-placeholder-overlay');
    var placeholderIcon = document.getElementById('tab-placeholder-icon');
    var placeholderLabel = document.getElementById('tab-placeholder-label');
    var placeholderBtn = document.getElementById('tab-placeholder-btn');
    var _placeholderAction = null; // 'generate' | 'svg' | 'code'

    canvas.on('selection:created', showSelectionControls);
    canvas.on('selection:updated', showSelectionControls);
    canvas.on('selection:cleared', hideSelectionControls);

    function hideSelectionControls() {
      actionsPanel.classList.remove('visible');
      placeholderOverlay.classList.remove('visible');
      _placeholderAction = null;
    }

    function showSelectionControls() {
      var active = canvas.getActiveObject();
      if (!active) { hideSelectionControls(); return; }

      // Show actions panel
      actionsPanel.classList.add('visible');

      // Update integrate button visibility
      var vd = _getViewData(active);
      if (_activeGlobalTab === 'components' && vd && vd.codeFiles && vd.codeFiles.length) {
        actionIntegrate.classList.add('visible');
      } else {
        actionIntegrate.classList.remove('visible');
      }

      // Update tab placeholder
      _updateTabPlaceholder(active);
    }

    function _updateTabPlaceholder(obj) {
      var vd = _getViewData(obj);
      var needsPlaceholder = false;
      var icon = '';
      var label = '';
      var action = null;

      if (_activeGlobalTab === 'image') {
        if (!vd || !vd.imageDataUrl) {
          needsPlaceholder = true;
          icon = '&#9998;';
          label = 'No image generated';
          action = 'generate';
        }
      } else if (_activeGlobalTab === 'svg') {
        if (!vd || !vd.svgMarkup) {
          needsPlaceholder = true;
          icon = 'SVG';
          label = 'No SVG generated';
          action = 'svg';
        }
      } else if (_activeGlobalTab === 'components') {
        if (!vd || !vd.codeFiles || !vd.codeFiles.length) {
          needsPlaceholder = true;
          icon = '&lt;/&gt;';
          label = 'No component generated';
          action = 'code';
        }
      }
      // Frames tab: no placeholder — always shows grid

      if (needsPlaceholder) {
        var bound = obj.getBoundingRect();
        var zoom = canvas.getZoom();
        var vpt = canvas.viewportTransform;
        var screenLeft = bound.left * zoom + vpt[4];
        var screenTop = bound.top * zoom + vpt[5];
        var screenW = bound.width * zoom;
        var screenH = bound.height * zoom;

        if (screenW > 40 && screenH > 40) {
          placeholderIcon.innerHTML = icon;
          placeholderLabel.textContent = label;
          placeholderOverlay.style.left = screenLeft + 'px';
          placeholderOverlay.style.top = screenTop + 'px';
          placeholderOverlay.style.width = screenW + 'px';
          placeholderOverlay.style.height = screenH + 'px';
          placeholderOverlay.classList.add('visible');
          _placeholderAction = action;
        } else {
          placeholderOverlay.classList.remove('visible');
          _placeholderAction = null;
        }
      } else {
        placeholderOverlay.classList.remove('visible');
        _placeholderAction = null;
      }
    }

    // Placeholder button click — trigger generation
    placeholderBtn.addEventListener('click', function() {
      if (!_placeholderAction) return;
      var active = canvas.getActiveObject();
      if (!active) return;
      var snapshot = buildSnapshot();
      var selectedIds = getSelectedIds();
      var desc = active.description || active.label || '';

      if (_placeholderAction === 'generate') {
        var job = genJobCreate('generate');
        _pendingGenerateJob = job;
        showPromptStatus('Generating image...', 10);
        vscodeApi.postMessage({ type: 'canvasUnifiedPrompt', payload: { text: '/generate ' + (desc || 'Generate image for this frame'), canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: selectedIds } });
      } else if (_placeholderAction === 'svg') {
        var svgJob = genJobCreate('svg');
        _pendingSvgJob = svgJob;
        showPromptStatus('Converting to SVG...', 10);
        vscodeApi.postMessage({ type: 'canvasUnifiedPrompt', payload: { text: '/svg', canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: selectedIds } });
      } else if (_placeholderAction === 'code') {
        var codeJob = genJobCreate('code');
        _pendingCodeJob = codeJob;
        showPromptStatus('Generating code...', 10);
        vscodeApi.postMessage({ type: 'canvasUnifiedPrompt', payload: { text: '/code ' + desc, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: selectedIds } });
      }

      placeholderOverlay.classList.remove('visible');
    });

    canvas.on('object:moving', showSelectionControls);
    canvas.on('object:scaling', showSelectionControls);

    document.getElementById('btn-response-close').addEventListener('click', function() {
      document.getElementById('prompt-response-panel').classList.remove('visible');
    });

    // ====================================================================
    // Background generation job tracker
    // ====================================================================
    var _genJobCounter = 0;
    var _genJobs = {}; // jobId -> { targetObject, targetBounds, overlayEl, type }

    function genJobCreate(type) {
      var jobId = 'gen-' + (++_genJobCounter);
      var active = canvas.getActiveObject();
      var bounds = null;
      if (active) {
        bounds = active.getBoundingRect();
        bounds = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
      }
      var job = { id: jobId, type: type, targetObject: active || null, targetBounds: bounds, overlayEl: null };
      _genJobs[jobId] = job;
      if (active) {
        _genJobShowLoader(job);
      } else if (type === 'page' || type === 'section' || type === 'component') {
        // Layout jobs without a selected frame — show prompt bar progress
        showPromptStatus('Generating layout...', 10);
      }
      return job;
    }

    function _genJobShowLoader(job) {
      var el = document.createElement('div');
      el.className = 'gen-loader-overlay';
      el.setAttribute('data-job-id', job.id);
      el.innerHTML = '<div class="gen-spinner"></div><div class="gen-label">Generating...</div>';
      canvasArea.appendChild(el);
      job.overlayEl = el;
      _genJobPositionLoader(job);
    }

    function _genJobPositionLoader(job) {
      if (!job.overlayEl || !job.targetObject) return;
      var obj = job.targetObject;
      // Check object still on canvas
      if (!canvas.getObjects().includes(obj)) {
        // Object was removed — fall back to stored bounds
        if (job.targetBounds) {
          var zoom = canvas.getZoom();
          var vpt = canvas.viewportTransform;
          job.overlayEl.style.left = (job.targetBounds.left * zoom + vpt[4]) + 'px';
          job.overlayEl.style.top = (job.targetBounds.top * zoom + vpt[5]) + 'px';
          job.overlayEl.style.width = (job.targetBounds.width * zoom) + 'px';
          job.overlayEl.style.height = (job.targetBounds.height * zoom) + 'px';
        }
        return;
      }
      var bound = obj.getBoundingRect();
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      job.overlayEl.style.left = (bound.left * zoom + vpt[4]) + 'px';
      job.overlayEl.style.top = (bound.top * zoom + vpt[5]) + 'px';
      job.overlayEl.style.width = (bound.width * zoom) + 'px';
      job.overlayEl.style.height = (bound.height * zoom) + 'px';
    }

    function genJobUpdateLabel(jobId, label) {
      var job = _genJobs[jobId];
      if (!job || !job.overlayEl) return;
      var lbl = job.overlayEl.querySelector('.gen-label');
      if (lbl) lbl.textContent = label;
    }

    function genJobComplete(jobId) {
      var job = _genJobs[jobId];
      if (!job) return null;
      if (job.overlayEl) {
        job.overlayEl.style.opacity = '0';
        setTimeout(function() { if (job.overlayEl && job.overlayEl.parentNode) job.overlayEl.parentNode.removeChild(job.overlayEl); }, 200);
      }
      delete _genJobs[jobId];
      return job;
    }

    function genJobGetBounds(jobId) {
      var job = _genJobs[jobId];
      if (!job) return null;
      // Get live bounds from target object if still on canvas
      if (job.targetObject && canvas.getObjects().includes(job.targetObject)) {
        var b = job.targetObject.getBoundingRect();
        return { left: b.left, top: b.top, width: b.width, height: b.height };
      }
      return job.targetBounds;
    }

    // Reposition all active loader overlays on pan/zoom/move
    function _genJobRepositionAll() {
      for (var id in _genJobs) { _genJobPositionLoader(_genJobs[id]); }
    }
    canvas.on('object:moving', _genJobRepositionAll);
    canvas.on('object:scaling', _genJobRepositionAll);
    canvas.on('mouse:wheel', function() { setTimeout(_genJobRepositionAll, 10); });
    canvas.on('viewport:changed', _genJobRepositionAll);

    // ====================================================================
    // Reimagination
    // ====================================================================
    var reimagineVariantIndex = 0;
    var reimagineSourceBounds = null;
    var _pendingGenerateJob = null;
    var _pendingReimagineJob = null;
    var _pendingVideoJob = null;
    var _pendingSvgJob = null;
    var _pendingCodeJob = null;
    var _pendingLayoutJob = null;
    var _lastLayoutFrameMap = null;
    var _pendingBatchFrameMap = null;
    var _pendingBatchJobs = {};

    // Create a gen job for a specific canvas object (not the active selection)
    function genJobCreateForObject(fabricObj, type) {
      var jobId = 'gen-' + (++_genJobCounter);
      var bounds = fabricObj.getBoundingRect();
      bounds = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
      var job = { id: jobId, type: type, targetObject: fabricObj, targetBounds: bounds, overlayEl: null };
      _genJobs[jobId] = job;
      _genJobShowLoader(job);
      return job;
    }

    // Batch generation modal
    var batchGenOverlay = document.getElementById('batch-gen-overlay');
    var batchGenBtn = document.getElementById('btn-batch-generate');
    var batchCancelBtn = document.getElementById('btn-batch-cancel');

    function showBatchGenerateModal(frames, frameMap) {
      document.getElementById('batch-frame-count').textContent = String(frames.length);
      var listEl = document.getElementById('batch-frame-list');
      listEl.innerHTML = '';
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var role = (f.metadata && f.metadata.role) || '';
        var item = document.createElement('div');
        item.className = 'batch-frame-item';
        item.innerHTML = '<span>' + (f.label || 'Frame') + '</span>' +
          (role ? '<span class="batch-frame-role">' + role + '</span>' : '');
        listEl.appendChild(item);
      }
      _pendingBatchFrameMap = frameMap;
      batchGenOverlay.classList.add('visible');
    }

    batchCancelBtn.addEventListener('click', function() {
      batchGenOverlay.classList.remove('visible');
      _pendingBatchFrameMap = null;
    });

    batchGenBtn.addEventListener('click', function() {
      batchGenOverlay.classList.remove('visible');
      if (!_pendingBatchFrameMap) return;

      // Create loaders on each frame
      var frameIds = Object.keys(_pendingBatchFrameMap);
      _pendingBatchJobs = {};
      for (var i = 0; i < frameIds.length; i++) {
        var fid = frameIds[i];
        var entry = _pendingBatchFrameMap[fid];
        _pendingBatchJobs[fid] = genJobCreateForObject(entry.obj, 'batch');
      }

      // Send batch generate message to extension
      var batchFrames = frameIds.map(function(id) {
        var entry = _pendingBatchFrameMap[id];
        return {
          frameId: id,
          left: entry.obj.left, top: entry.obj.top,
          width: entry.obj.width, height: entry.obj.height,
          label: entry.frame.label,
          description: entry.frame.description,
          metadata: entry.frame.metadata,
        };
      });
      var snapshot = buildSnapshot();
      vscodeApi.postMessage({
        type: 'canvasBatchGenerate',
        payload: { canvasId: canvasSessionId, frames: batchFrames, snapshot: snapshot }
      });
      _pendingBatchFrameMap = null;
      showPromptStatus('Building design theme...', 5);
    });

    // Actions panel button handlers
    function _getActiveDescPrompt() {
      var active = canvas.getActiveObject();
      if (!active) return '';
      var desc = active.description || active.label || '';
      var meta = active.metadata || {};
      var metaParts = Object.keys(meta).map(function(k) { return k + ': ' + meta[k]; });
      return desc + (metaParts.length ? ' (' + metaParts.join(', ') + ')' : '');
    }

    document.getElementById('action-reimagine').addEventListener('click', function() {
      var job = genJobCreate('reimagine');
      _pendingReimagineJob = job;
      reimagineSourceBounds = job.targetBounds;
      reimagineVariantIndex = 0;
      showPromptStatus('Starting reimagination...', 10);
      var snapshot = buildSnapshot();
      vscodeApi.postMessage({
        type: 'canvasReimagine',
        payload: { canvasId: canvasSessionId, prompt: '', snapshot: snapshot, selectedObjectIds: getSelectedIds(), action: 'reimagine' }
      });
    });

    document.getElementById('action-generate').addEventListener('click', function() {
      var active = canvas.getActiveObject();
      if (!active) return;
      var prompt = _getActiveDescPrompt() || 'Generate image for this frame';
      var job = genJobCreate('generate');
      _pendingGenerateJob = job;
      showPromptStatus('Generating image...', 10);
      var snapshot = buildSnapshot();
      vscodeApi.postMessage({
        type: 'canvasUnifiedPrompt',
        payload: { text: '/generate ' + prompt, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() }
      });
    });

    document.getElementById('action-video').addEventListener('click', function() {
      var active = canvas.getActiveObject();
      if (!active) return;
      var prompt = _getActiveDescPrompt() || 'Generate video for this frame';
      var job = genJobCreate('video');
      _pendingVideoJob = job;
      showPromptStatus('Generating video...', 10);
      var snapshot = buildSnapshot();
      vscodeApi.postMessage({
        type: 'canvasUnifiedPrompt',
        payload: { text: '/video ' + prompt, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() }
      });
    });

    document.getElementById('action-svg').addEventListener('click', function() {
      var active = canvas.getActiveObject();
      if (!active) return;
      var job = genJobCreate('svg');
      _pendingSvgJob = job;
      showPromptStatus('Converting to SVG...', 10);
      var snapshot = buildSnapshot();
      vscodeApi.postMessage({
        type: 'canvasUnifiedPrompt',
        payload: { text: '/svg', canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() }
      });
    });

    document.getElementById('action-code').addEventListener('click', function() {
      var active = canvas.getActiveObject();
      if (!active) return;
      var desc = active.description || active.label || '';
      var job = genJobCreate('code');
      _pendingCodeJob = job;
      showPromptStatus('Generating code...', 10);
      var snapshot = buildSnapshot();
      vscodeApi.postMessage({
        type: 'canvasUnifiedPrompt',
        payload: { text: '/code ' + desc, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() }
      });
    });

    // Inline input modal — webview-safe replacement for window.prompt()
    var _inlineInputModal = document.getElementById('inline-input-modal');
    var _inlineInputLabel = document.getElementById('inline-input-label');
    var _inlineInputField = document.getElementById('inline-input-field');
    var _inlineInputCancel = document.getElementById('inline-input-cancel');
    var _inlineInputSubmit = document.getElementById('inline-input-submit');
    var _inlineInputCallback = null;

    function showInlineInput(label, placeholder, callback) {
      _inlineInputLabel.textContent = label;
      _inlineInputField.placeholder = placeholder || 'Type here...';
      _inlineInputField.value = '';
      _inlineInputCallback = callback;
      _inlineInputModal.classList.add('visible');
      setTimeout(function() { _inlineInputField.focus(); }, 50);
    }

    function hideInlineInput() {
      _inlineInputModal.classList.remove('visible');
      _inlineInputCallback = null;
      _inlineInputField.value = '';
    }

    _inlineInputCancel.addEventListener('click', hideInlineInput);
    _inlineInputSubmit.addEventListener('click', function() {
      var val = _inlineInputField.value.trim();
      if (val && _inlineInputCallback) { _inlineInputCallback(val); }
      hideInlineInput();
    });
    _inlineInputField.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { _inlineInputSubmit.click(); }
      if (e.key === 'Escape') { hideInlineInput(); }
      e.stopPropagation(); // prevent canvas keyboard shortcuts while typing
    });

    // Element edit action buttons
    document.getElementById('action-edit-element').addEventListener('click', function() {
      if (!_selectedElement) return;
      showInlineInput('Describe how to edit this element:', 'e.g. make the text bold and blue', function(instruction) {
        showPromptStatus('AI editing element...', 10);
        var snapshot = buildSnapshot();
        vscodeApi.postMessage({
          type: 'canvasUnifiedPrompt',
          payload: { text: '/edit-element ' + instruction, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() }
        });
      });
    });

    document.getElementById('action-edit-layout').addEventListener('click', function() {
      if (!_selectedElement) return;
      showInlineInput('Describe layout changes:', 'e.g. center the content and add more padding', function(instruction) {
        showPromptStatus('AI editing layout...', 10);
        var snapshot = buildSnapshot();
        vscodeApi.postMessage({
          type: 'canvasUnifiedPrompt',
          payload: { text: '/edit-layout ' + instruction, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() }
        });
      });
    });

    // ====================================================================
    // Draft generation
    // ====================================================================
    document.getElementById('btn-draft-cancel').addEventListener('click', function() {
      document.getElementById('draft-overlay').classList.remove('visible');
    });

    document.getElementById('btn-draft-generate').addEventListener('click', function() {
      var prompt = document.getElementById('draft-prompt').value.trim();
      if (!prompt) return;
      var job = genJobCreate('generate');
      _pendingGenerateJob = job;
      document.getElementById('draft-progress').classList.remove('hidden');
      document.getElementById('draft-progress-text').textContent = 'Generating...';
      document.getElementById('draft-progress-fill').style.width = '0%';
      document.getElementById('btn-draft-generate').disabled = true;
      vscodeApi.postMessage({
        type: 'canvasGenerateDraft',
        payload: { canvasId: canvasSessionId, prompt: prompt }
      });
    });

    // ====================================================================
    // Unified Prompt Bar
    // ====================================================================
    var unifiedInput = document.getElementById('unified-prompt-input');
    var unifiedSendBtn = document.getElementById('btn-unified-send');
    var promptBarSuggestions = document.getElementById('prompt-bar-suggestions');
    var promptBarContext = document.getElementById('prompt-bar-context');
    var promptBarStatus = document.getElementById('prompt-bar-status');
    var unifiedBusy = false;

    var slashCommands = [
      { cmd: '/render', desc: 'Capture page screenshot (URL, selector, or auto-detect)', example: '/render http://localhost:3000' },
      { cmd: '/generate', desc: 'Generate AI image from description', example: '/generate a modern SaaS landing page' },
      { cmd: '/reimagine', desc: 'Reimagine selected region with AI variants', example: '/reimagine' },
      { cmd: '/video', desc: 'Generate AI video from description', example: '/video a looping gradient background' },
      { cmd: '/page', desc: 'Generate page layout with sections and components', example: '/page a SaaS pricing page' },
      { cmd: '/section', desc: 'Generate section layout with component frames', example: '/section hero with CTA and feature highlights' },
      { cmd: '/component', desc: 'Generate a single component frame', example: '/component login form' },
      { cmd: '/website', desc: 'Generate multi-page website layout', example: '/website SaaS landing page with pricing and docs' },
      { cmd: '/svg', desc: 'Convert selected image to clean SVG', example: '/svg' },
      { cmd: '/code', desc: 'Generate component code + Storybook story', example: '/code React card with dark mode' },
    ];

    function sendUnifiedPrompt() {
      var text = unifiedInput.value.trim();
      if (!text) return;
      promptBarSuggestions.classList.remove('visible');

      // Determine action type from slash command to create the right job
      var actionType = 'prompt';
      if (text.startsWith('/generate')) { actionType = 'generate'; }
      else if (text.startsWith('/reimagine')) { actionType = 'reimagine'; }
      else if (text.startsWith('/video')) { actionType = 'video'; }
      else if (text.startsWith('/page')) { actionType = 'page'; }
      else if (text.startsWith('/section')) { actionType = 'section'; }
      else if (text.startsWith('/component')) { actionType = 'component'; }
      else if (text.startsWith('/website')) { actionType = 'website'; }
      else if (text.startsWith('/svg')) { actionType = 'svg'; }
      else if (text.startsWith('/code')) { actionType = 'code'; }

      // Create a background job for generation actions (not plain prompts)
      if (actionType === 'generate' || actionType === 'reimagine' || actionType === 'video'
          || actionType === 'page' || actionType === 'section' || actionType === 'component'
          || actionType === 'website' || actionType === 'svg' || actionType === 'code') {
        var job = genJobCreate(actionType);
        if (actionType === 'generate') { _pendingGenerateJob = job; }
        else if (actionType === 'reimagine') {
          _pendingReimagineJob = job;
          reimagineSourceBounds = job.targetBounds;
          reimagineVariantIndex = 0;
        }
        else if (actionType === 'video') { _pendingVideoJob = job; }
        else if (actionType === 'svg') { _pendingSvgJob = job; }
        else if (actionType === 'code') { _pendingCodeJob = job; }
        else if (actionType === 'page' || actionType === 'section' || actionType === 'component' || actionType === 'website') { _pendingLayoutJob = job; }
      } else {
        // Plain prompts still block
        unifiedBusy = true;
        unifiedSendBtn.disabled = true;
        showPromptStatus('Processing...', 0);
      }

      var snapshot = buildSnapshot();
      vscodeApi.postMessage({
        type: 'canvasUnifiedPrompt',
        payload: {
          text: text,
          canvasId: canvasSessionId,
          snapshot: snapshot,
          selectedObjectIds: getSelectedIds(),
        }
      });
      unifiedInput.value = '';
    }

    function showPromptStatus(message, progress) {
      promptBarStatus.classList.add('visible');
      var html = '<span>' + message + '</span>';
      if (progress !== undefined && progress >= 0) {
        html += '<div style="width:100%;height:3px;background:var(--vscode-editorWidget-border,#333);border-radius:2px;margin-top:4px;overflow:hidden;">' +
          '<div class="progress-bar" style="width:' + Math.min(progress, 100) + '%"></div></div>';
      }
      promptBarStatus.innerHTML = html;
      unifiedBusy = true;
      unifiedSendBtn.disabled = true;
    }

    function hidePromptStatus() {
      promptBarStatus.classList.remove('visible');
      promptBarStatus.innerHTML = '';
      unifiedBusy = false;
      unifiedSendBtn.disabled = false;
    }

    function showPromptStatusMessage(message, type) {
      var color = type === 'error'
        ? 'var(--vscode-errorForeground, #f44)'
        : type === 'success'
          ? 'var(--vscode-testing-iconPassed, #4caf50)'
          : 'var(--vscode-descriptionForeground)';
      var icon = type === 'error' ? '&#9888; ' : type === 'success' ? '&#10003; ' : '';
      promptBarStatus.classList.add('visible');
      promptBarStatus.innerHTML = '<span style="color:' + color + '">' + icon + message + '</span>';
      unifiedBusy = false;
      unifiedSendBtn.disabled = false;
    }

    // Safe DOM helpers — avoid crashes if legacy overlay elements are hidden/removed
    function safeSetStyle(id, prop, val) {
      var el = document.getElementById(id);
      if (el) el.style[prop] = val;
    }
    function safeSetText(id, text) {
      var el = document.getElementById(id);
      if (el) el.textContent = text;
    }
    function safeEnable(id) {
      var el = document.getElementById(id);
      if (el) el.disabled = false;
    }
    function safeAddClass(id, cls) {
      var el = document.getElementById(id);
      if (el) el.classList.add(cls);
    }

    unifiedSendBtn.addEventListener('click', sendUnifiedPrompt);
    unifiedInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendUnifiedPrompt();
      }
      if (e.key === 'Escape') {
        promptBarSuggestions.classList.remove('visible');
      }
      // Arrow navigation for suggestions
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var items = promptBarSuggestions.querySelectorAll('.prompt-bar-suggestion');
        if (items.length === 0) return;
        e.preventDefault();
        var current = promptBarSuggestions.querySelector('.selected');
        var idx = -1;
        if (current) {
          current.classList.remove('selected');
          idx = Array.from(items).indexOf(current);
        }
        idx = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
        items[idx].classList.add('selected');
      }
      // Tab to complete selected suggestion
      if (e.key === 'Tab') {
        var sel = promptBarSuggestions.querySelector('.selected');
        if (sel) {
          e.preventDefault();
          unifiedInput.value = sel.getAttribute('data-cmd') + ' ';
          promptBarSuggestions.classList.remove('visible');
        }
      }
    });

    unifiedInput.addEventListener('input', function() {
      var val = unifiedInput.value;
      if (val.startsWith('/')) {
        var filter = val.toLowerCase();
        var matches = slashCommands.filter(function(c) { return c.cmd.startsWith(filter) || filter.startsWith(c.cmd); });
        if (matches.length > 0 && val.indexOf(' ') === -1) {
          promptBarSuggestions.innerHTML = matches.map(function(c) {
            return '<div class="prompt-bar-suggestion" data-cmd="' + c.cmd + '">' +
              '<span class="cmd">' + c.cmd + '</span>' +
              '<span class="desc">' + c.desc + '</span></div>';
          }).join('');
          promptBarSuggestions.classList.add('visible');
          // Click to select
          promptBarSuggestions.querySelectorAll('.prompt-bar-suggestion').forEach(function(el) {
            el.addEventListener('click', function() {
              unifiedInput.value = el.getAttribute('data-cmd') + ' ';
              promptBarSuggestions.classList.remove('visible');
              unifiedInput.focus();
            });
          });
        } else {
          promptBarSuggestions.classList.remove('visible');
        }
      } else {
        promptBarSuggestions.classList.remove('visible');
      }
    });

    // Update context strip on selection changes
    canvas.on('selection:created', updatePromptContext);
    canvas.on('selection:updated', updatePromptContext);
    canvas.on('selection:cleared', function() {
      promptBarContext.classList.remove('visible');
      promptBarContext.innerHTML = '';
    });

    function updatePromptContext() {
      var sel = canvas.getActiveObject();
      if (sel) {
        var type = sel.type || 'object';
        var w = Math.round(sel.width * (sel.scaleX || 1));
        var h = Math.round(sel.height * (sel.scaleY || 1));
        var label = sel.label || sel.id || type;
        promptBarContext.innerHTML = 'Selected: <strong>' + label + '</strong> (' + w + '&times;' + h + ')';
        promptBarContext.classList.add('visible');
      }
    }

    // ====================================================================
    // Image Generation Config Panel
    // ====================================================================
    var configOverlay = document.getElementById('config-overlay');
    var configProviderCards = document.querySelectorAll('.config-provider-card');
    var configApiKeyInput = document.getElementById('config-api-key');
    var configKeyHelp = document.getElementById('config-key-help');
    var configKeyLink = document.getElementById('config-key-link');
    var configKeyLabel = document.getElementById('config-key-label');
    var configSaveBtn = document.getElementById('btn-config-save');
    var configCancelBtn = document.getElementById('btn-config-cancel');
    var configSuccess = document.getElementById('config-success');
    var configActions = document.getElementById('config-actions');
    var selectedProvider = '';

    function showConfigPanel() {
      hidePromptStatus();
      selectedProvider = '';
      configApiKeyInput.value = '';
      configSaveBtn.disabled = true;
      configSuccess.classList.remove('visible');
      configActions.style.display = 'flex';
      configProviderCards.forEach(function(c) { c.classList.remove('selected'); });
      configOverlay.classList.add('visible');
    }

    configProviderCards.forEach(function(card) {
      card.addEventListener('click', function() {
        configProviderCards.forEach(function(c) { c.classList.remove('selected'); });
        card.classList.add('selected');
        selectedProvider = card.getAttribute('data-provider');

        // Update key label and help link based on provider
        if (selectedProvider === 'gpt-image-1.5' || selectedProvider === 'gpt-image-1' || selectedProvider === 'gpt-image-1-mini' || selectedProvider === 'sora') {
          configKeyLabel.textContent = 'OpenAI API Key';
          configKeyHelp.innerHTML = 'Get your key at <a href="https://platform.openai.com/api-keys" id="config-key-link">platform.openai.com/api-keys</a>';
          configApiKeyInput.placeholder = 'sk-...';
        } else {
          configKeyLabel.textContent = 'Google Gemini API Key';
          configKeyHelp.innerHTML = 'Get a free key at <a href="https://aistudio.google.com/apikey" id="config-key-link">aistudio.google.com/apikey</a>';
          configApiKeyInput.placeholder = 'AIza...';
        }
        updateConfigSaveState();
        configApiKeyInput.focus();
      });
    });

    configApiKeyInput.addEventListener('input', updateConfigSaveState);

    function updateConfigSaveState() {
      configSaveBtn.disabled = !selectedProvider || !configApiKeyInput.value.trim();
    }

    configCancelBtn.addEventListener('click', function() {
      configOverlay.classList.remove('visible');
    });

    configSaveBtn.addEventListener('click', function() {
      var key = configApiKeyInput.value.trim();
      if (!selectedProvider || !key) return;
      configSaveBtn.disabled = true;
      configSaveBtn.textContent = 'Saving...';
      vscodeApi.postMessage({
        type: 'canvasSaveConfig',
        payload: { provider: selectedProvider, apiKey: key }
      });
    });

    // ====================================================================
    // Header buttons
    // ====================================================================
    document.getElementById('btn-ai-models').addEventListener('click', function() {
      showConfigPanel();
    });

    document.getElementById('btn-save').addEventListener('click', function() {
      forceSave();
    });

    document.getElementById('btn-export').addEventListener('click', function() {
      var dataUrl = canvas.toDataURL({ format: 'png', multiplier: 2 });
      vscodeApi.postMessage({ type: 'canvasExport', payload: { imageDataUrl: dataUrl } });
    });

    document.getElementById('btn-send-to-chat').addEventListener('click', function() {
      var snapshot = buildSnapshot();
      vscodeApi.postMessage({ type: 'canvasSendToChat', payload: { snapshot: snapshot } });
    });

    // ====================================================================
    // Auto-save
    // ====================================================================
    var saveTimer = null;
    function autoSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function() { forceSave(); }, 500);
    }

    function forceSave() {
      var json = canvas.toJSON(customJsonProps);
      vscodeApi.postMessage({
        type: 'canvasSave',
        payload: {
          id: canvasSessionId,
          canvasJson: JSON.stringify(json),
        }
      });
    }

    canvas.on('object:modified', autoSave);
    canvas.on('path:created', autoSave);
    canvas.on('object:added', function() { if (!isUndoRedoing) autoSave(); });
    canvas.on('object:removed', function() { if (!isUndoRedoing) autoSave(); });

    // ====================================================================
    // Helpers
    // ====================================================================
    function buildSnapshot() {
      var json = canvas.toJSON(customJsonProps);
      var fullBase64 = canvas.toDataURL({ format: 'png' }).replace(/^data:image\\/png;base64,/, '');

      var selectedRegion = null;
      var active = canvas.getActiveObject();
      if (active) {
        // Use world-space bounds via aCoords (NOT getBoundingRect which is viewport-space).
        // This ensures correct cropping regardless of zoom/pan/retina scaling.
        function worldBoundsOf(obj) {
          var coords = obj.aCoords || obj.calcACoords();
          var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
          var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
          return {
            left: Math.min.apply(null, xs),
            top: Math.min.apply(null, ys),
            right: Math.max.apply(null, xs),
            bottom: Math.max.apply(null, ys)
          };
        }

        // Start with selected object(s) bounds in world space
        var selBounds = worldBoundsOf(active);
        var cropLeft = selBounds.left;
        var cropTop = selBounds.top;
        var cropRight = selBounds.right;
        var cropBottom = selBounds.bottom;

        // For activeSelection, also include the grouped objects' individual bounds
        var selObjects = (active.type === 'activeSelection' || active.type === 'activeselection')
          ? active.getObjects() : [];

        // Expand crop to include all objects overlapping the selection
        var allObjects = canvas.getObjects();
        for (var oi = 0; oi < allObjects.length; oi++) {
          var obj = allObjects[oi];
          if (obj === active) continue;
          // Skip objects that are part of the active selection group
          if (selObjects.indexOf(obj) >= 0) continue;
          var ob = worldBoundsOf(obj);
          // AABB overlap test with the selection
          if (ob.left < cropRight && ob.right > cropLeft && ob.top < cropBottom && ob.bottom > cropTop) {
            cropLeft = Math.min(cropLeft, ob.left);
            cropTop = Math.min(cropTop, ob.top);
            cropRight = Math.max(cropRight, ob.right);
            cropBottom = Math.max(cropBottom, ob.bottom);
          }
        }

        // Add margin in world space
        var snapshotMargin = 40;
        cropLeft -= snapshotMargin;
        cropTop -= snapshotMargin;
        cropRight += snapshotMargin;
        cropBottom += snapshotMargin;

        var cropW = cropRight - cropLeft;
        var cropH = cropBottom - cropTop;

        // Validate non-zero crop before generating snapshot
        if (cropW > 0 && cropH > 0) {
          // Use fabric's toDataURL with world-space crop params —
          // it handles viewport transform + retina scaling internally
          var regionDataUrl = canvas.toDataURL({
            format: 'png',
            left: cropLeft,
            top: cropTop,
            width: cropW,
            height: cropH,
          });
          var regionBase64 = regionDataUrl.replace(/^data:image\\/png;base64,/, '');
          selectedRegion = {
            imageBase64: regionBase64,
            bounds: { left: cropLeft, top: cropTop, width: cropW, height: cropH },
          };
        }
      }

      // Build element selection context for AI awareness
      var elementSelection = null;
      if (_selectedElement) {
        var elObj = _findObjectById(_selectedElement.objectId);
        var elVd = elObj ? _getViewData(elObj) : null;
        elementSelection = {
          objectId: _selectedElement.objectId,
          selectorPath: _selectedElement.selectorPath,
          tagName: _selectedElement.tagName,
          textContent: _selectedElement.textContent || '',
          computedStyles: _selectedElement.computedStyles || {},
          componentSource: (elVd && elVd.codeFiles && elVd.codeFiles[0]) ? elVd.codeFiles[0].content : '',
          componentName: elVd ? elVd.componentName || '' : '',
          framework: elVd ? elVd.framework || '' : '',
          domSnapshot: _selectedElement.domSnapshot || '',
        };
      }

      return {
        imageBase64: fullBase64,
        sceneDescription: '',
        objects: [],
        selectedRegion: selectedRegion,
        _canvasJson: json,
        elementSelection: elementSelection,
      };
    }

    function getSelectedIds() {
      var active = canvas.getActiveObject();
      if (!active) return [];
      if (active.type === 'activeSelection' || active.type === 'activeselection') {
        return active.getObjects().map(function(o) { return o.id || ''; }).filter(Boolean);
      }
      return active.id ? [active.id] : [];
    }

    // Resolve crop gravity from frame metadata (role/componentType)
    function resolveGravity(metadata) {
      if (!metadata) return { x: 'center', y: 'center' };
      var role = (metadata.role || '').toLowerCase();
      var type = (metadata.componentType || '').toLowerCase();
      var y = 'center';
      if (/nav|header/.test(role) || /navbar|header/.test(type)) y = 'top';
      else if (/footer/.test(role) || /footer/.test(type)) y = 'bottom';
      var x = 'center';
      if (/sidebar/.test(role)) x = /right/.test(type) ? 'right' : 'left';
      return { x: x, y: y };
    }

    // Detect the bounding box of actual content in an image by comparing pixels
    // against the background color (sampled from corners).
    function detectContentBounds(imgEl) {
      var w = imgEl.naturalWidth || imgEl.width;
      var h = imgEl.naturalHeight || imgEl.height;

      var tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = w;
      tmpCanvas.height = h;
      var ctx = tmpCanvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0);

      var imageData = ctx.getImageData(0, 0, w, h);
      var pixels = imageData.data;

      // Sample corners to determine background color (average of 4 corner 8x8 blocks)
      var bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
      var sampleSize = 8;
      var corners = [
        { x: 0, y: 0 },
        { x: w - sampleSize, y: 0 },
        { x: 0, y: h - sampleSize },
        { x: w - sampleSize, y: h - sampleSize }
      ];
      for (var c = 0; c < corners.length; c++) {
        for (var dy = 0; dy < sampleSize; dy++) {
          for (var dx = 0; dx < sampleSize; dx++) {
            var idx = ((corners[c].y + dy) * w + (corners[c].x + dx)) * 4;
            bgR += pixels[idx];
            bgG += pixels[idx + 1];
            bgB += pixels[idx + 2];
            bgCount++;
          }
        }
      }
      bgR = Math.round(bgR / bgCount);
      bgG = Math.round(bgG / bgCount);
      bgB = Math.round(bgB / bgCount);

      // Scan for content bounds — pixels that differ from background by threshold
      var threshold = 30;
      var minX = w, minY = h, maxX = 0, maxY = 0;
      var step = 2;  // sample every 2nd pixel for performance

      for (var y = 0; y < h; y += step) {
        for (var x = 0; x < w; x += step) {
          var pIdx = (y * w + x) * 4;
          var dr = pixels[pIdx] - bgR;
          var dg = pixels[pIdx + 1] - bgG;
          var db = pixels[pIdx + 2] - bgB;
          var dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist > threshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      // If no content found (all background), return full image
      if (maxX <= minX || maxY <= minY) {
        return { x: 0, y: 0, w: w, h: h };
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    // Content-aware smart crop: detect content area, expand with margin,
    // adjust to frame aspect ratio centered on content, then crop.
    function smartCropToFrame(imgEl, frameW, frameH, gravity) {
      var natW = imgEl.naturalWidth || imgEl.width;
      var natH = imgEl.naturalHeight || imgEl.height;
      var frameAspect = frameW / frameH;

      // Step 1: Detect content bounding box
      var content = detectContentBounds(imgEl);

      // Step 2: Expand content bounds by 10% margin
      var marginX = content.w * 0.10;
      var marginY = content.h * 0.10;
      var expandedX = Math.max(0, content.x - marginX);
      var expandedY = Math.max(0, content.y - marginY);
      var expandedW = Math.min(natW - expandedX, content.w + marginX * 2);
      var expandedH = Math.min(natH - expandedY, content.h + marginY * 2);

      // Step 3: Adjust to match frame aspect ratio, centered on content
      var contentAspect = expandedW / expandedH;
      var sx, sy, sw, sh;

      if (contentAspect > frameAspect) {
        // Content wider than frame — expand height
        sh = expandedW / frameAspect;
        sw = expandedW;
        var contentCenterY = expandedY + expandedH / 2;
        sy = Math.max(0, Math.min(natH - sh, contentCenterY - sh / 2));
        sx = expandedX;
      } else {
        // Content taller than frame — expand width
        sw = expandedH * frameAspect;
        sh = expandedH;
        var contentCenterX = expandedX + expandedW / 2;
        sx = Math.max(0, Math.min(natW - sw, contentCenterX - sw / 2));
        sy = expandedY;
      }

      // Step 4: If adjusted region exceeds image, fall back to gravity-based crop
      if (sw > natW || sh > natH) {
        var scale = Math.max(frameW / natW, frameH / natH);
        sw = frameW / scale;
        sh = frameH / scale;
        var excessW = natW - sw;
        var excessH = natH - sh;
        sx = gravity.x === 'left' ? 0 : gravity.x === 'right' ? excessW : excessW / 2;
        sy = gravity.y === 'top' ? 0 : gravity.y === 'bottom' ? excessH : excessH / 2;
      }

      // Step 5: Draw crop at exact frame dimensions
      var cropCanvas = document.createElement('canvas');
      cropCanvas.width = Math.round(frameW);
      cropCanvas.height = Math.round(frameH);
      var ctx = cropCanvas.getContext('2d');
      ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
      return cropCanvas.toDataURL('image/png');
    }

    function addImageToCanvas(base64, label, targetBounds, targetObject, frameMetadata) {
      var imgEl = new Image();
      imgEl.onload = function() {
        var opts = Object.assign({}, controlStyle, {
          id: 'generated-' + (++objectIdCounter),
          label: label || 'Generated Image',
        });

        if (targetBounds && targetBounds.width > 0 && targetBounds.height > 0) {
          // Prefer live object coordinates (no stroke inflation from getBoundingRect)
          var frameLeft, frameTop, frameW, frameH;
          if (targetObject && canvas.getObjects().includes(targetObject)) {
            frameLeft = targetObject.left;
            frameTop = targetObject.top;
            frameW = targetObject.width;
            frameH = targetObject.height;
          } else {
            frameLeft = targetBounds.left;
            frameTop = targetBounds.top;
            frameW = targetBounds.width;
            frameH = targetBounds.height;
          }

          // Real crop: gravity-aware pixel crop to exact frame dimensions
          var gravity = resolveGravity(frameMetadata);
          var croppedDataUrl = smartCropToFrame(imgEl, frameW, frameH, gravity);

          var croppedImg = new Image();
          croppedImg.onload = function() {
            var fabricImg = new fabric.FabricImage(croppedImg, opts);
            fabricImg.set({
              left: frameLeft,
              top: frameTop,
              scaleX: 1,
              scaleY: 1,
            });
            canvas.add(fabricImg);
            canvas.setActiveObject(fabricImg);
            canvas.renderAll();
            autoSave();
          };
          croppedImg.src = croppedDataUrl;
        } else {
          // No selection — random placement (existing behavior)
          opts.left = 100 + Math.random() * 200;
          opts.top = 100 + Math.random() * 200;
          var fabricImg = new fabric.FabricImage(imgEl, opts);
          if (fabricImg.width > 600) { fabricImg.scaleToWidth(600); }
          canvas.add(fabricImg);
          canvas.setActiveObject(fabricImg);
          canvas.renderAll();
          autoSave();
        }
      };
      imgEl.src = 'data:image/png;base64,' + base64;
    }

    function addVideoToCanvas(base64, mimeType, label, targetBounds, targetObject, frameMetadata) {
      // Create a video element to extract the first frame as a poster
      var videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.preload = 'metadata';

      videoEl.addEventListener('loadeddata', function() {
        // Capture first frame as poster image
        var posterCanvas = document.createElement('canvas');
        posterCanvas.width = videoEl.videoWidth || 640;
        posterCanvas.height = videoEl.videoHeight || 360;
        var ctx = posterCanvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, posterCanvas.width, posterCanvas.height);

        // Draw play icon badge on poster
        var cx = posterCanvas.width / 2;
        var cy = posterCanvas.height / 2;
        var badgeR = Math.min(posterCanvas.width, posterCanvas.height) * 0.08;
        ctx.beginPath();
        ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
        // Play triangle
        var triSize = badgeR * 0.55;
        ctx.beginPath();
        ctx.moveTo(cx - triSize * 0.4, cy - triSize);
        ctx.lineTo(cx - triSize * 0.4, cy + triSize);
        ctx.lineTo(cx + triSize * 0.8, cy);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();

        var posterImg = new Image();
        posterImg.onload = function() {
          var opts = Object.assign({}, controlStyle, {
            id: 'video-' + (++objectIdCounter),
            label: label || 'Generated Video',
          });

          if (targetBounds && targetBounds.width > 0 && targetBounds.height > 0) {
            // Prefer live object coordinates (no stroke inflation from getBoundingRect)
            var vFrameLeft, vFrameTop, vFrameW, vFrameH;
            if (targetObject && canvas.getObjects().includes(targetObject)) {
              vFrameLeft = targetObject.left;
              vFrameTop = targetObject.top;
              vFrameW = targetObject.width;
              vFrameH = targetObject.height;
            } else {
              vFrameLeft = targetBounds.left;
              vFrameTop = targetBounds.top;
              vFrameW = targetBounds.width;
              vFrameH = targetBounds.height;
            }

            // Real crop: gravity-aware pixel crop to exact frame dimensions
            var gravity = resolveGravity(frameMetadata);
            var croppedPosterUrl = smartCropToFrame(posterImg, vFrameW, vFrameH, gravity);

            var croppedPoster = new Image();
            croppedPoster.onload = function() {
              var fabricImg = new fabric.FabricImage(croppedPoster, opts);
              fabricImg.set({
                left: vFrameLeft,
                top: vFrameTop,
                scaleX: 1,
                scaleY: 1,
              });

              // Store video data on the fabric object for playback
              fabricImg.set('videoData', base64);
              fabricImg.set('videoMimeType', mimeType || 'video/mp4');
              fabricImg.set('isVideo', true);

              canvas.add(fabricImg);
              canvas.setActiveObject(fabricImg);
              canvas.renderAll();
              autoSave();
            };
            croppedPoster.src = croppedPosterUrl;
          } else {
            opts.left = 100 + Math.random() * 200;
            opts.top = 100 + Math.random() * 200;
            var fabricImg = new fabric.FabricImage(posterImg, opts);
            if (fabricImg.width > 600) { fabricImg.scaleToWidth(600); }

            // Store video data on the fabric object for playback
            fabricImg.set('videoData', base64);
            fabricImg.set('videoMimeType', mimeType || 'video/mp4');
            fabricImg.set('isVideo', true);

            canvas.add(fabricImg);
            canvas.setActiveObject(fabricImg);
            canvas.renderAll();
            autoSave();
          }
        };
        posterImg.src = posterCanvas.toDataURL('image/png');
      });

      videoEl.src = 'data:' + (mimeType || 'video/mp4') + ';base64,' + base64;
    }

    // ====================================================================
    // SVG placement on canvas
    // ====================================================================

    function addSvgToCanvas(svgMarkup, label, targetBounds) {
      fabric.loadSVGFromString(svgMarkup).then(function(result) {
        var group = fabric.util.groupSVGElements(result.objects, result.options);
        group.set(Object.assign({}, controlStyle, {
          id: 'svg-' + (++objectIdCounter),
          label: label || 'SVG',
          left: targetBounds ? targetBounds.left : 100,
          top: targetBounds ? targetBounds.top : 100,
        }));
        if (targetBounds && targetBounds.width > 0) {
          group.scaleToWidth(targetBounds.width);
        }
        canvas.add(group);
        canvas.setActiveObject(group);
        canvas.renderAll();
        autoSave();
      }).catch(function(err) {
        console.error('[Mysti Canvas] SVG load failed:', err);
      });
    }

    // ====================================================================
    // Layout frame generation
    // ====================================================================

    function addLayoutFrames(frames, containerObject) {
      if (!frames || !frames.length) return {};

      var offsetX, offsetY;
      if (containerObject && canvas.getObjects().includes(containerObject)) {
        // Place sub-frames inside the selected container frame
        offsetX = containerObject.left + 16;
        offsetY = containerObject.top + 16;
      } else {
        // No container — place at current viewport with padding
        var vpt = canvas.viewportTransform;
        var zoom = canvas.getZoom();
        offsetX = (-vpt[4] / zoom) + 40;
        offsetY = (-vpt[5] / zoom) + 40;
      }

      var frameMap = {};
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var frameId = 'frame-' + (++objectIdCounter);
        var rect = new fabric.Rect(Object.assign({}, controlStyle, {
          left: offsetX + (f.left || 0),
          top: offsetY + (f.top || 0),
          width: f.width || 200,
          height: f.height || 100,
          fill: 'rgba(100, 149, 237, 0.05)',
          stroke: 'rgba(100, 149, 237, 0.6)',
          strokeWidth: 2,
          strokeDashArray: [8, 4],
          selectable: true,
          id: frameId,
          label: f.label || 'Frame',
          description: f.description || '',
          metadata: f.metadata || {},
        }));
        canvas.add(rect);
        frameMap[frameId] = { obj: rect, frame: f };
      }
      canvas.requestRenderAll();
      autoSave();
      return frameMap;
    }

    // Video playback overlay on double-click
    var activeVideoOverlay = null;
    var activeVideoTarget = null;

    function closeVideoOverlay() {
      if (activeVideoOverlay) {
        activeVideoOverlay.remove();
        activeVideoOverlay = null;
        activeVideoTarget = null;
      }
    }

    function updateVideoOverlayPosition() {
      if (!activeVideoOverlay || !activeVideoTarget) return;
      var bound = activeVideoTarget.getBoundingRect();
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      var sl = bound.left * zoom + vpt[4];
      var st = bound.top * zoom + vpt[5];
      var sw = bound.width * zoom;
      var sh = bound.height * zoom;
      activeVideoOverlay.style.left = sl + 'px';
      activeVideoOverlay.style.top = st + 'px';
      activeVideoOverlay.style.width = sw + 'px';
      activeVideoOverlay.style.height = sh + 'px';
    }

    // Close video overlay on pan/zoom/selection change
    canvas.on('selection:cleared', closeVideoOverlay);
    canvas.on('mouse:wheel', function() { setTimeout(updateVideoOverlayPosition, 10); });

    canvas.on('mouse:dblclick', function(opt) {
      var target = opt.target;
      if (!target || !target.get('isVideo')) return;

      var videoData = target.get('videoData');
      var videoMimeType = target.get('videoMimeType') || 'video/mp4';
      if (!videoData) return;

      closeVideoOverlay();

      // Position using viewport transform for correct screen coordinates
      var bound = target.getBoundingRect();
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      var screenLeft = bound.left * zoom + vpt[4];
      var screenTop = bound.top * zoom + vpt[5];
      var screenWidth = bound.width * zoom;
      var screenHeight = bound.height * zoom;

      var overlay = document.createElement('div');
      overlay.id = 'video-playback-overlay';
      overlay.style.cssText = 'position:absolute;left:' + screenLeft + 'px;top:' + screenTop + 'px;width:' + screenWidth + 'px;height:' + screenHeight + 'px;z-index:100;background:#000;border-radius:4px;overflow:hidden;';

      var video = document.createElement('video');
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      video.src = 'data:' + videoMimeType + ';base64,' + videoData;
      video.autoplay = true;
      video.loop = true;
      video.muted = false;
      video.controls = true;

      var closeBtn = document.createElement('button');
      closeBtn.textContent = '\u2715';
      closeBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);color:#fff;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:14px;z-index:101;';
      closeBtn.addEventListener('click', closeVideoOverlay);

      overlay.appendChild(video);
      overlay.appendChild(closeBtn);
      document.getElementById('canvas-area').appendChild(overlay);
      activeVideoOverlay = overlay;
      activeVideoTarget = target;
    });

    // ====================================================================
    // Properties Panel
    // ====================================================================
    var propsPanel = document.getElementById('props-panel');
    var propsPanelBody = document.getElementById('props-panel-body');
    var propsPanelTitle = document.getElementById('props-panel-title');
    var _currentPropsData = null; // { props, componentName, framework, svgMarkup }

    document.getElementById('props-panel-close').addEventListener('click', function() {
      propsPanel.classList.remove('visible');
      _currentPropsData = null;
    });

    function showPropsPanel(props, componentName, framework) {
      if (!props || !props.length) return;
      _currentPropsData = { props: props, componentName: componentName, framework: framework };
      propsPanelTitle.textContent = componentName || 'Properties';
      propsPanelBody.innerHTML = '';

      // Group props by category
      var categories = {};
      props.forEach(function(p) {
        var cat = p.category || 'general';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(p);
      });

      Object.keys(categories).forEach(function(cat) {
        var section = document.createElement('div');
        section.className = 'props-category';
        var title = document.createElement('div');
        title.className = 'props-category-title';
        title.textContent = cat;
        section.appendChild(title);

        categories[cat].forEach(function(prop) {
          var row = document.createElement('div');
          row.className = 'props-row';

          var label = document.createElement('label');
          label.textContent = prop.name;
          label.title = prop.name;
          row.appendChild(label);

          var input;
          if (prop.type === 'color') {
            input = document.createElement('input');
            input.type = 'color';
            input.value = prop.value || '#000000';
            input.setAttribute('data-prop-id', prop.id);
            var textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.value = prop.value || '#000000';
            textInput.setAttribute('data-prop-id', prop.id + '-text');
            textInput.style.flex = '1';
            input.addEventListener('input', function() { textInput.value = input.value; });
            textInput.addEventListener('change', function() { input.value = textInput.value; });
            row.appendChild(input);
            row.appendChild(textInput);
          } else if (prop.type === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = prop.value === 'true' || prop.value === true;
            input.setAttribute('data-prop-id', prop.id);
            row.appendChild(input);
          } else if (prop.type === 'enum' && prop.options) {
            input = document.createElement('select');
            input.setAttribute('data-prop-id', prop.id);
            prop.options.forEach(function(opt) {
              var option = document.createElement('option');
              option.value = opt;
              option.textContent = opt;
              if (opt === prop.value) option.selected = true;
              input.appendChild(option);
            });
            row.appendChild(input);
          } else if (prop.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.value = prop.value || '0';
            input.setAttribute('data-prop-id', prop.id);
            row.appendChild(input);
          } else {
            input = document.createElement('input');
            input.type = 'text';
            input.value = prop.value || '';
            input.setAttribute('data-prop-id', prop.id);
            row.appendChild(input);
          }

          section.appendChild(row);
        });

        propsPanelBody.appendChild(section);
      });

      propsPanel.classList.add('visible');
    }

    document.getElementById('btn-props-apply').addEventListener('click', function() {
      if (!_currentPropsData) return;
      // Collect modified prop values
      var modifiedProps = _currentPropsData.props.map(function(p) {
        var el = propsPanelBody.querySelector('[data-prop-id="' + p.id + '"]');
        var value = p.value;
        if (el) {
          if (p.type === 'boolean') { value = String(el.checked); }
          else if (p.type === 'color') {
            var textEl = propsPanelBody.querySelector('[data-prop-id="' + p.id + '-text"]');
            value = textEl ? textEl.value : el.value;
          }
          else { value = el.value; }
        }
        return { id: p.id, name: p.name, type: p.type, value: value, options: p.options, category: p.category };
      });

      showPromptStatus('Updating code with new properties...', 20);
      vscodeApi.postMessage({
        type: 'canvasUpdateProps',
        payload: {
          canvasId: canvasSessionId,
          modifiedProps: modifiedProps,
          componentName: _currentPropsData.componentName,
          framework: _currentPropsData.framework,
          svgMarkup: '',
        }
      });
    });

    // ====================================================================
    // Global Tab Bar — Image/Video | SVG | Components | Frames
    // ====================================================================
    var _activeGlobalTab = 'image'; // 'image' | 'svg' | 'components' | 'frames'
    var tabImageVideo = document.getElementById('tab-image-video');
    var tabSvg = document.getElementById('tab-svg');
    var tabComponents = document.getElementById('tab-components');
    var tabFrames = document.getElementById('tab-frames');
    var framesPanel = document.getElementById('frames-panel');
    var framesGrid = document.getElementById('frames-grid');

    /**
     * _viewData stored on each fabric object:
     * {
     *   activeView: 'image' | 'svg' | 'code' | 'component',
     *   imageDataUrl: string,       // original image src
     *   svgMarkup: string,          // generated SVG markup
     *   svgFabricJson: object,      // serialized SVG fabric group for restore
     *   codeFiles: Array<{ filePath, fileName, fileType, content }>,
     *   componentName: string,
     *   componentProps: Array,
     *   framework: string,
     *   componentRender: string,    // base64 rendered component screenshot (fallback)
     *   componentHtml: string,      // standalone HTML string for live iframe
     *   liveIframeActive: boolean,  // whether iframe overlay is currently showing
     * }
     */

    function _getViewData(obj) {
      if (!obj) return null;
      return obj._viewData || null;
    }

    function _ensureViewData(obj) {
      if (!obj._viewData) {
        obj._viewData = { activeView: 'image', imageDataUrl: null, svgMarkup: null, svgFabricJson: null, codeFiles: null, componentName: null, componentProps: null, framework: null, componentRender: null, componentHtml: null, liveIframeActive: false };
        // Capture the current image source if the object is an image
        if (obj.type === 'image' && obj._element && obj._element.src) {
          obj._viewData.imageDataUrl = obj._element.src;
        } else if (obj.getSrc) {
          try { obj._viewData.imageDataUrl = obj.getSrc(); } catch(e) {}
        }
      }
      return obj._viewData;
    }

    function _updateGlobalTabs() {
      tabImageVideo.classList.toggle('active', _activeGlobalTab === 'image');
      tabSvg.classList.toggle('active', _activeGlobalTab === 'svg');
      tabComponents.classList.toggle('active', _activeGlobalTab === 'components');
      tabFrames.classList.toggle('active', _activeGlobalTab === 'frames');
      // Show/hide frames panel
      framesPanel.classList.toggle('visible', _activeGlobalTab === 'frames');
    }

    function _switchGlobalTab(tab) {
      if (_activeGlobalTab === tab) return;
      console.log('[Mysti Canvas] Global tab switch:', _activeGlobalTab, '->', tab);
      _activeGlobalTab = tab;
      _updateGlobalTabs();
      _applyGlobalTabView();
      if (tab === 'frames') { _buildFramesGrid(); }
      showSelectionControls(); // update placeholder + integrate visibility
    }

    function _applyGlobalTabView() {
      // Apply the correct visual representation to all objects based on the active tab
      var objects = canvas.getObjects();

      if (_activeGlobalTab === 'components') {
        // Show live iframes for objects with code
        objects.forEach(function(obj) {
          if (obj._isFrameLabel) return;
          var vd = _getViewData(obj);
          if (!vd) return;
          if (vd.codeFiles && vd.codeFiles.length) {
            _createComponentIframe(obj, vd);
            obj.set('opacity', 0.05); // fade fabric object behind iframe
          }
        });
        _showAllComponentIframes();
        canvas.renderAll();
      } else {
        // Hide iframes and restore fabric object opacity
        _hideAllComponentIframes();
        objects.forEach(function(obj) {
          if (obj._isFrameLabel) return;
          var vd = _getViewData(obj);
          if (!vd) return;
          if (obj.opacity < 0.1 && vd.liveIframeActive) {
            obj.set('opacity', 1);
          }
          if (_activeGlobalTab === 'image') {
            if (vd.activeView !== 'image' && vd.imageDataUrl) {
              _showImageView(obj, vd);
            }
          } else if (_activeGlobalTab === 'svg') {
            if (vd.svgMarkup && vd.activeView !== 'svg') {
              _showSvgView(obj, vd);
            }
          }
          // Frames tab: don't change object view, just show grid overlay
        });
        canvas.renderAll();
      }
    }

    // ====================================================================
    // Frames Grid — thumbnail view of all objects
    // ====================================================================

    function _buildFramesGrid() {
      framesGrid.innerHTML = '';
      var objects = canvas.getObjects();
      var activeObj = canvas.getActiveObject();

      objects.forEach(function(obj) {
        if (obj._isFrameLabel) return; // skip label overlay texts
        var label = obj.label || obj.description || 'Untitled';
        var thumb = document.createElement('div');
        thumb.className = 'frame-thumb' + (obj === activeObj ? ' selected' : '');

        // Generate thumbnail
        var img = document.createElement('img');
        img.className = 'frame-thumb-img';
        try {
          img.src = obj.toDataURL({ format: 'png', multiplier: 0.3 });
        } catch (e) {
          img.style.background = '#333';
        }

        var labelEl = document.createElement('div');
        labelEl.className = 'frame-thumb-label';
        labelEl.textContent = label;

        thumb.appendChild(img);
        thumb.appendChild(labelEl);
        thumb.addEventListener('click', function() {
          canvas.setActiveObject(obj);
          canvas.renderAll();
          // Scroll canvas to center on this object
          var bound = obj.getBoundingRect();
          var zoom = canvas.getZoom();
          var cx = canvasArea.clientWidth / 2;
          var cy = canvasArea.clientHeight / 2;
          canvas.absolutePan(new fabric.Point(bound.left + bound.width / 2 - cx / zoom, bound.top + bound.height / 2 - cy / zoom));
          canvas.renderAll();
          // Switch to Image tab to see the object
          _switchGlobalTab('image');
        });
        framesGrid.appendChild(thumb);
      });

      if (objects.filter(function(o) { return !o._isFrameLabel; }).length === 0) {
        framesGrid.innerHTML = '<div style="color:var(--vscode-descriptionForeground);text-align:center;padding:40px;grid-column:1/-1;">No frames on canvas yet. Use the Frame tool or generate a draft to get started.</div>';
      }
    }

    // ====================================================================
    // Frame Labels — faded title on each object
    // ====================================================================

    function _updateFrameLabel(obj) {
      if (obj._isFrameLabel) return;
      var label = obj.label || obj.description || '';
      // Remove existing label
      if (obj._labelText) {
        canvas.remove(obj._labelText);
        obj._labelText = null;
      }
      if (!label) return;

      var objW = (obj.width || 100) * (obj.scaleX || 1);
      var objH = (obj.height || 100) * (obj.scaleY || 1);
      var text = new fabric.Text(label, {
        left: obj.left + objW / 2,
        top: obj.top + objH / 2,
        originX: 'center',
        originY: 'center',
        fontSize: Math.min(14, Math.max(10, objW / 15)),
        fill: 'rgba(255,255,255,0.25)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        selectable: false,
        evented: false,
        _isFrameLabel: true,
      });
      obj._labelText = text;
      canvas.add(text);
    }

    function _repositionFrameLabel(obj) {
      if (!obj._labelText) return;
      var objW = (obj.width || 100) * (obj.scaleX || 1);
      var objH = (obj.height || 100) * (obj.scaleY || 1);
      obj._labelText.set({
        left: obj.left + objW / 2,
        top: obj.top + objH / 2,
        fontSize: Math.min(14, Math.max(10, objW / 15)),
      });
      obj._labelText.setCoords();
    }

    // Hook frame labels into object events
    canvas.on('object:added', function(e) {
      if (e.target && !e.target._isFrameLabel) { _updateFrameLabel(e.target); }
    });
    canvas.on('object:removed', function(e) {
      if (e.target && e.target._labelText) { canvas.remove(e.target._labelText); }
      if (e.target && e.target.id) { _destroyComponentIframe(e.target.id); }
    });
    canvas.on('object:moving', function(e) { _repositionFrameLabel(e.target); _syncIframePosition(e.target); });
    canvas.on('object:scaling', function(e) { _repositionFrameLabel(e.target); _syncIframePosition(e.target); });

    // ====================================================================
    // Live Component iframes — overlay system
    // ====================================================================
    var _iframeOverlays = {}; // objectId -> { wrapper, iframe, objectRef }
    var _iframeContainer = document.getElementById('iframe-overlay-container');
    var _iframeSyncRaf = null;

    function _buildStandaloneHtmlWithBridge(code, componentName, framework) {
      var baseHtml = _buildStandaloneHtml(code, componentName, framework);
      // Inject bridge script before </body>
      var bridgeScript = '<script>'
        + '(function(){'
        + 'var selectedEl=null;'
        + 'var hl=document.createElement("div");'
        + 'hl.style.cssText="position:fixed;pointer-events:none;border:2px solid #3794ff;background:rgba(55,148,255,0.08);z-index:99999;display:none;transition:all 0.08s;box-sizing:border-box;";'
        + 'document.body.appendChild(hl);'
        + 'var sl=document.createElement("div");'
        + 'sl.style.cssText="position:fixed;pointer-events:none;border:2px solid #ff6b00;background:rgba(255,107,0,0.08);z-index:99998;display:none;box-sizing:border-box;";'
        + 'document.body.appendChild(sl);'
        + 'function posOvl(o,el){var r=el.getBoundingClientRect();o.style.left=r.left+"px";o.style.top=r.top+"px";o.style.width=r.width+"px";o.style.height=r.height+"px";o.style.display="block";}'
        + 'function buildSel(el){'
        + 'var parts=[];'
        + 'while(el&&el!==document.body&&el!==document.documentElement){'
        + 'var tag=el.tagName.toLowerCase();'
        + 'if(el.id){parts.unshift(tag+"#"+el.id);break;}'
        + 'var cls=el.className&&typeof el.className==="string"?"."+el.className.trim().split(/\\s+/).join("."):"";'
        + 'var parent=el.parentElement;'
        + 'if(parent){var sibs=Array.from(parent.children).filter(function(c){return c.tagName===el.tagName;});'
        + 'if(sibs.length>1){parts.unshift(tag+cls+":nth-of-type("+(sibs.indexOf(el)+1)+")");}else{parts.unshift(tag+cls);}}'
        + 'else{parts.unshift(tag+cls);}el=parent;}'
        + 'return parts.join(" > ");}'
        + 'function extractStyles(cs){'
        + 'return{color:cs.color,backgroundColor:cs.backgroundColor,fontSize:cs.fontSize,fontFamily:cs.fontFamily,fontWeight:cs.fontWeight,'
        + 'padding:cs.padding,margin:cs.margin,border:cs.border,borderRadius:cs.borderRadius,'
        + 'display:cs.display,flexDirection:cs.flexDirection,justifyContent:cs.justifyContent,alignItems:cs.alignItems,'
        + 'gap:cs.gap,width:cs.width,height:cs.height,textAlign:cs.textAlign,lineHeight:cs.lineHeight,'
        + 'letterSpacing:cs.letterSpacing,boxShadow:cs.boxShadow,opacity:cs.opacity};}'
        + 'document.addEventListener("mousemove",function(e){'
        + 'var el=document.elementFromPoint(e.clientX,e.clientY);'
        + 'if(!el||el===hl||el===sl||el===document.body||el===document.documentElement){hl.style.display="none";return;}'
        + 'posOvl(hl,el);});'
        + 'document.addEventListener("click",function(e){'
        + 'e.preventDefault();e.stopPropagation();'
        + 'selectedEl=e.target;posOvl(sl,selectedEl);'
        + 'var cs=window.getComputedStyle(selectedEl);'
        + 'window.parent.postMessage({type:"mysti-element-selected",payload:{'
        + 'selectorPath:buildSel(selectedEl),'
        + 'tagName:selectedEl.tagName.toLowerCase(),'
        + 'className:selectedEl.className||"",'
        + 'id:selectedEl.id||"",'
        + 'textContent:(selectedEl.childNodes.length===1&&selectedEl.childNodes[0].nodeType===3)?selectedEl.textContent:"",'
        + 'innerHTML:(selectedEl.innerHTML||"").substring(0,1000),'
        + 'computedStyles:extractStyles(cs),'
        + 'boundingRect:{left:0,top:0,width:selectedEl.offsetWidth,height:selectedEl.offsetHeight}'
        + '}},"*");},true);'
        + 'function toCamel(s){return s.replace(/-([a-z])/g,function(m,c){return c.toUpperCase();});}'
        + 'window.addEventListener("message",function(e){'
        + 'if(!e.data||!e.data.type)return;'
        + 'if(e.data.type==="mysti-apply-style"){'
        + 'var t=selectedEl;if(e.data.payload.selectorPath){try{t=document.querySelector(e.data.payload.selectorPath)||selectedEl;}catch(ex){}}if(t){var p=e.data.payload.property;if(p.indexOf("-")>=0){t.style.setProperty(p,e.data.payload.value);}else{t.style[p]=e.data.payload.value;}}}'
        + 'if(e.data.type==="mysti-apply-text"){'
        + 'var t2=selectedEl;if(e.data.payload.selectorPath){try{t2=document.querySelector(e.data.payload.selectorPath)||selectedEl;}catch(ex){}}if(t2)t2.textContent=e.data.payload.text;}'
        + 'if(e.data.type==="mysti-get-dom-tree"){'
        + 'window.parent.postMessage({type:"mysti-dom-tree",payload:{html:document.body.innerHTML.substring(0,5000)}},"*");}'
        + 'if(e.data.type==="mysti-reload"){'
        + 'document.open();document.write(e.data.payload.html);document.close();}'
        + '});'
        + '})();'
        + '<\\/script>';
      return baseHtml.replace('</body>', bridgeScript + '</body>');
    }

    function _createComponentIframe(obj, vd) {
      if (!obj.id || _iframeOverlays[obj.id]) return;
      var componentFile = null;
      if (vd.codeFiles) {
        for (var i = 0; i < vd.codeFiles.length; i++) {
          if (vd.codeFiles[i].fileType === 'component') { componentFile = vd.codeFiles[i]; break; }
        }
      }
      if (!componentFile) return;

      var html = _buildStandaloneHtmlWithBridge(componentFile.content, vd.componentName || '', vd.framework || 'html');
      vd.componentHtml = html;

      var wrapper = document.createElement('div');
      wrapper.className = 'component-iframe-wrapper';
      var iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      // Use blob URL for CSP compatibility
      var blob = new Blob([html], { type: 'text/html' });
      iframe.src = URL.createObjectURL(blob);
      wrapper.appendChild(iframe);
      _iframeContainer.appendChild(wrapper);

      _iframeOverlays[obj.id] = { wrapper: wrapper, iframe: iframe, objectRef: obj, blobUrl: iframe.src };
      vd.liveIframeActive = true;
      _syncIframePosition(obj);
      console.log('[Mysti Canvas] Created live iframe for object:', obj.id);
    }

    function _syncIframePosition(obj) {
      if (!obj || !obj.id || !_iframeOverlays[obj.id]) return;
      var overlay = _iframeOverlays[obj.id];
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      // Use aCoords for accurate world-space bounds
      var coords = obj.aCoords || obj.calcACoords();
      var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
      var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
      var worldLeft = Math.min.apply(null, xs);
      var worldTop = Math.min.apply(null, ys);
      var worldRight = Math.max.apply(null, xs);
      var worldBottom = Math.max.apply(null, ys);
      // Convert to screen space
      var screenLeft = worldLeft * zoom + vpt[4];
      var screenTop = worldTop * zoom + vpt[5];
      var screenW = (worldRight - worldLeft) * zoom;
      var screenH = (worldBottom - worldTop) * zoom;
      overlay.wrapper.style.left = screenLeft + 'px';
      overlay.wrapper.style.top = screenTop + 'px';
      overlay.wrapper.style.width = screenW + 'px';
      overlay.wrapper.style.height = screenH + 'px';
    }

    function _syncAllIframePositions() {
      for (var id in _iframeOverlays) {
        _syncIframePosition(_iframeOverlays[id].objectRef);
      }
    }

    function _debouncedSyncAllIframes() {
      if (_iframeSyncRaf) return;
      _iframeSyncRaf = requestAnimationFrame(function() {
        _syncAllIframePositions();
        _iframeSyncRaf = null;
      });
    }

    function _destroyComponentIframe(objId) {
      var overlay = _iframeOverlays[objId];
      if (!overlay) return;
      if (overlay.blobUrl) { URL.revokeObjectURL(overlay.blobUrl); }
      overlay.wrapper.remove();
      delete _iframeOverlays[objId];
      // Clear liveIframeActive on viewData if object still exists
      var objs = canvas.getObjects();
      for (var i = 0; i < objs.length; i++) {
        if (objs[i].id === objId && objs[i]._viewData) {
          objs[i]._viewData.liveIframeActive = false;
          break;
        }
      }
      console.log('[Mysti Canvas] Destroyed iframe for object:', objId);
    }

    function _showAllComponentIframes() {
      for (var id in _iframeOverlays) {
        _iframeOverlays[id].wrapper.classList.remove('hidden');
      }
      _syncAllIframePositions();
    }

    function _hideAllComponentIframes() {
      for (var id in _iframeOverlays) {
        _iframeOverlays[id].wrapper.classList.add('hidden');
      }
    }

    function _destroyAllComponentIframes() {
      var ids = Object.keys(_iframeOverlays);
      for (var i = 0; i < ids.length; i++) {
        _destroyComponentIframe(ids[i]);
      }
    }

    function _reloadComponentIframe(objId, newCode, componentName, framework) {
      var overlay = _iframeOverlays[objId];
      if (!overlay) return;
      var newHtml = _buildStandaloneHtmlWithBridge(newCode, componentName, framework);
      // Revoke old blob, create new
      if (overlay.blobUrl) { URL.revokeObjectURL(overlay.blobUrl); }
      var blob = new Blob([newHtml], { type: 'text/html' });
      var newUrl = URL.createObjectURL(blob);
      overlay.iframe.src = newUrl;
      overlay.blobUrl = newUrl;
      // Update viewData
      var obj = overlay.objectRef;
      if (obj && obj._viewData) {
        obj._viewData.componentHtml = newHtml;
      }
      console.log('[Mysti Canvas] Reloaded iframe for object:', objId);
    }

    // ====================================================================
    // Element Selection — cross-iframe messaging + property inspector
    // ====================================================================
    var _selectedElement = null; // { objectId, selectorPath, tagName, className, id, textContent, innerHTML, computedStyles, boundingRect, domSnapshot }

    function _findObjectById(id) {
      var objs = canvas.getObjects();
      for (var i = 0; i < objs.length; i++) {
        if (objs[i].id === id) return objs[i];
      }
      return null;
    }

    // Listen for messages from component iframes (bridge script)
    window.addEventListener('message', function(event) {
      if (!event.data || !event.data.type) return;
      // Only handle mysti- prefixed messages from iframes
      if (typeof event.data.type !== 'string' || event.data.type.indexOf('mysti-') !== 0) return;

      if (event.data.type === 'mysti-element-selected') {
        // Identify which object this iframe belongs to
        var objectId = null;
        for (var id in _iframeOverlays) {
          try {
            if (_iframeOverlays[id].iframe.contentWindow === event.source) {
              objectId = id; break;
            }
          } catch (e) { /* cross-origin access error — skip */ }
        }
        if (!objectId) return;

        _selectedElement = {
          objectId: objectId,
          selectorPath: event.data.payload.selectorPath,
          tagName: event.data.payload.tagName,
          className: event.data.payload.className,
          id: event.data.payload.id,
          textContent: event.data.payload.textContent,
          innerHTML: event.data.payload.innerHTML,
          computedStyles: event.data.payload.computedStyles,
          boundingRect: event.data.payload.boundingRect,
          domSnapshot: null,
        };
        showElementInspector(_selectedElement);
        _updateElementActionButtons(true);
        console.log('[Mysti Canvas] Element selected:', _selectedElement.tagName, _selectedElement.selectorPath);

        // Request DOM tree for AI context
        var overlay = _iframeOverlays[objectId];
        if (overlay && overlay.iframe.contentWindow) {
          try { overlay.iframe.contentWindow.postMessage({ type: 'mysti-get-dom-tree' }, '*'); } catch (e) {}
        }
      }

      if (event.data.type === 'mysti-dom-tree') {
        if (_selectedElement) {
          _selectedElement.domSnapshot = event.data.payload.html;
        }
      }
    });

    function _clearElementSelection() {
      _selectedElement = null;
      _updateElementActionButtons(false);
      // Hide element inspector if showing
      if (propsPanel.classList.contains('visible') && propsPanelTitle.textContent.indexOf('>') >= 0) {
        propsPanel.classList.remove('visible');
      }
    }

    // Clear element selection when canvas selection changes
    canvas.on('selection:cleared', function() { _clearElementSelection(); });
    canvas.on('selection:created', function() { _clearElementSelection(); });
    canvas.on('selection:updated', function() { _clearElementSelection(); });

    // ====================================================================
    // Element Inspector — extends existing props panel
    // ====================================================================
    var _elementInspectorEdits = {}; // selectorPath -> { property -> value }

    function showElementInspector(elData) {
      if (!elData) return;
      _elementInspectorEdits = {};
      var truncSelector = elData.selectorPath.length > 40 ? '...' + elData.selectorPath.slice(-37) : elData.selectorPath;
      propsPanelTitle.textContent = elData.tagName + ' ' + truncSelector;
      propsPanelBody.innerHTML = '';

      // Element info section
      var infoSection = _createInspectorSection('Element');
      _addReadonlyRow(infoSection, 'Tag', elData.tagName);
      _addReadonlyRow(infoSection, 'Selector', elData.selectorPath);
      if (elData.className) _addReadonlyRow(infoSection, 'Class', elData.className);
      if (elData.id) _addReadonlyRow(infoSection, 'ID', elData.id);
      propsPanelBody.appendChild(infoSection);

      // Content section (editable text)
      if (elData.textContent) {
        var contentSection = _createInspectorSection('Content');
        var textRow = document.createElement('div');
        textRow.className = 'props-row';
        var textLabel = document.createElement('label');
        textLabel.textContent = 'Text';
        textRow.appendChild(textLabel);
        var textInput = document.createElement('textarea');
        textInput.value = elData.textContent;
        textInput.rows = 2;
        textInput.style.cssText = 'flex:1;resize:vertical;font-size:11px;padding:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-family:inherit;';
        textInput.addEventListener('input', function() {
          _applyLiveEdit(elData.objectId, elData.selectorPath, null, textInput.value);
          _elementInspectorEdits[elData.selectorPath] = _elementInspectorEdits[elData.selectorPath] || {};
          _elementInspectorEdits[elData.selectorPath]['textContent'] = textInput.value;
        });
        textRow.appendChild(textInput);
        contentSection.appendChild(textRow);
        propsPanelBody.appendChild(contentSection);
      }

      // Style sections
      var styles = elData.computedStyles || {};
      var styleGroups = {
        'Typography': [
          { prop: 'color', label: 'Color', type: 'color' },
          { prop: 'fontSize', label: 'Font Size', type: 'text' },
          { prop: 'fontFamily', label: 'Font', type: 'text' },
          { prop: 'fontWeight', label: 'Weight', type: 'text' },
          { prop: 'lineHeight', label: 'Line Height', type: 'text' },
          { prop: 'letterSpacing', label: 'Spacing', type: 'text' },
          { prop: 'textAlign', label: 'Align', type: 'select', options: ['left', 'center', 'right', 'justify'] },
        ],
        'Colors': [
          { prop: 'backgroundColor', label: 'Background', type: 'color' },
        ],
        'Spacing': [
          { prop: 'padding', label: 'Padding', type: 'text' },
          { prop: 'margin', label: 'Margin', type: 'text' },
        ],
        'Layout': [
          { prop: 'display', label: 'Display', type: 'select', options: ['block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'none'] },
          { prop: 'flexDirection', label: 'Flex Dir', type: 'select', options: ['row', 'column', 'row-reverse', 'column-reverse'] },
          { prop: 'justifyContent', label: 'Justify', type: 'select', options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] },
          { prop: 'alignItems', label: 'Align', type: 'select', options: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'] },
          { prop: 'gap', label: 'Gap', type: 'text' },
          { prop: 'width', label: 'Width', type: 'text' },
          { prop: 'height', label: 'Height', type: 'text' },
        ],
        'Effects': [
          { prop: 'borderRadius', label: 'Radius', type: 'text' },
          { prop: 'border', label: 'Border', type: 'text' },
          { prop: 'boxShadow', label: 'Shadow', type: 'text' },
          { prop: 'opacity', label: 'Opacity', type: 'text' },
        ],
      };

      Object.keys(styleGroups).forEach(function(groupName) {
        var section = _createInspectorSection(groupName);
        var hasContent = false;
        styleGroups[groupName].forEach(function(def) {
          var val = styles[def.prop];
          if (!val || val === 'none' && def.prop !== 'display') return;
          hasContent = true;
          _addEditableStyleRow(section, def, val, elData);
        });
        if (hasContent) propsPanelBody.appendChild(section);
      });

      // "Apply to Source" button
      var applyBtn = document.createElement('button');
      applyBtn.textContent = 'Apply to Source';
      applyBtn.style.cssText = 'display:block;width:calc(100% - 24px);margin:12px;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit;';
      applyBtn.addEventListener('click', function() {
        _applyEditsToSource(elData.objectId, _elementInspectorEdits);
      });
      propsPanelBody.appendChild(applyBtn);

      propsPanel.classList.add('visible');
    }

    function _createInspectorSection(title) {
      var section = document.createElement('div');
      section.className = 'props-category';
      var titleEl = document.createElement('div');
      titleEl.className = 'props-category-title';
      titleEl.textContent = title;
      section.appendChild(titleEl);
      return section;
    }

    function _addReadonlyRow(section, label, value) {
      var row = document.createElement('div');
      row.className = 'props-row';
      var lbl = document.createElement('label');
      lbl.textContent = label;
      row.appendChild(lbl);
      var span = document.createElement('span');
      span.textContent = value;
      span.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
      row.appendChild(span);
      section.appendChild(row);
    }

    function _addEditableStyleRow(section, def, currentValue, elData) {
      var row = document.createElement('div');
      row.className = 'props-row';
      var lbl = document.createElement('label');
      lbl.textContent = def.label;
      row.appendChild(lbl);

      var cssProp = def.prop.replace(/([A-Z])/g, '-$1').toLowerCase(); // camelCase -> kebab-case

      if (def.type === 'color') {
        var colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = _rgbToHex(currentValue);
        colorInput.style.cssText = 'width:28px;height:22px;border:none;padding:0;cursor:pointer;';
        var colorText = document.createElement('input');
        colorText.type = 'text';
        colorText.value = currentValue;
        colorText.style.cssText = 'flex:1;font-size:10px;padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;';
        colorInput.addEventListener('input', function() {
          colorText.value = colorInput.value;
          _applyLiveStyleEdit(elData.objectId, elData.selectorPath, cssProp, colorInput.value);
          _trackEdit(elData.selectorPath, cssProp, colorInput.value);
        });
        colorText.addEventListener('change', function() {
          colorInput.value = _rgbToHex(colorText.value);
          _applyLiveStyleEdit(elData.objectId, elData.selectorPath, cssProp, colorText.value);
          _trackEdit(elData.selectorPath, cssProp, colorText.value);
        });
        row.appendChild(colorInput);
        row.appendChild(colorText);
      } else if (def.type === 'select') {
        var select = document.createElement('select');
        select.style.cssText = 'flex:1;font-size:11px;padding:2px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;';
        (def.options || []).forEach(function(opt) {
          var option = document.createElement('option');
          option.value = opt;
          option.textContent = opt;
          if (currentValue.indexOf(opt) >= 0) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener('change', function() {
          _applyLiveStyleEdit(elData.objectId, elData.selectorPath, cssProp, select.value);
          _trackEdit(elData.selectorPath, cssProp, select.value);
        });
        row.appendChild(select);
      } else {
        var input = document.createElement('input');
        input.type = 'text';
        input.value = currentValue;
        input.style.cssText = 'flex:1;font-size:11px;padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;';
        input.addEventListener('change', function() {
          _applyLiveStyleEdit(elData.objectId, elData.selectorPath, cssProp, input.value);
          _trackEdit(elData.selectorPath, cssProp, input.value);
        });
        row.appendChild(input);
      }
      section.appendChild(row);
    }

    function _trackEdit(selectorPath, property, value) {
      _elementInspectorEdits[selectorPath] = _elementInspectorEdits[selectorPath] || {};
      _elementInspectorEdits[selectorPath][property] = value;
    }

    function _applyLiveStyleEdit(objectId, selectorPath, cssProp, value) {
      var overlay = _iframeOverlays[objectId];
      if (!overlay || !overlay.iframe.contentWindow) return;
      try {
        overlay.iframe.contentWindow.postMessage({
          type: 'mysti-apply-style',
          payload: { selectorPath: selectorPath, property: cssProp, value: value }
        }, '*');
      } catch (e) { console.log('[Mysti Canvas] Failed to send style edit to iframe:', e); }
    }

    function _applyLiveEdit(objectId, selectorPath, cssProp, textValue) {
      var overlay = _iframeOverlays[objectId];
      if (!overlay || !overlay.iframe.contentWindow) return;
      try {
        if (textValue !== undefined && textValue !== null) {
          overlay.iframe.contentWindow.postMessage({
            type: 'mysti-apply-text',
            payload: { selectorPath: selectorPath, text: textValue }
          }, '*');
        }
      } catch (e) { console.log('[Mysti Canvas] Failed to send text edit to iframe:', e); }
    }

    function _applyEditsToSource(objectId, edits) {
      var obj = _findObjectById(objectId);
      if (!obj) return;
      var vd = _getViewData(obj);
      if (!vd || !vd.codeFiles || !vd.codeFiles.length) return;

      // Flatten edits into array
      var editsList = [];
      for (var sel in edits) {
        for (var prop in edits[sel]) {
          editsList.push({ selectorPath: sel, property: prop, value: edits[sel][prop] });
        }
      }
      if (!editsList.length) return;

      showPromptStatus('Applying edits to source code...', 10);
      vscodeApi.postMessage({
        type: 'canvasElementEdits',
        payload: {
          canvasId: canvasSessionId,
          objectId: objectId,
          componentName: vd.componentName,
          framework: vd.framework,
          edits: editsList,
          currentCode: vd.codeFiles[0].content,
        }
      });
    }

    function _rgbToHex(rgb) {
      if (!rgb || rgb.charAt(0) === '#') return rgb || '#000000';
      var match = rgb.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      if (!match) return '#000000';
      return '#' + ((1 << 24) + (parseInt(match[1]) << 16) + (parseInt(match[2]) << 8) + parseInt(match[3])).toString(16).slice(1);
    }

    function _updateElementActionButtons(visible) {
      var sep = document.getElementById('element-actions-sep');
      var editBtn = document.getElementById('action-edit-element');
      var layoutBtn = document.getElementById('action-edit-layout');
      if (sep) sep.style.display = visible ? 'block' : 'none';
      if (editBtn) editBtn.style.display = visible ? 'flex' : 'none';
      if (layoutBtn) layoutBtn.style.display = visible ? 'flex' : 'none';
    }

    function switchView(targetView) {
      var active = canvas.getActiveObject();
      if (!active) return;
      var vd = _getViewData(active);
      if (!vd) return;
      if (vd.activeView === targetView) return;

      console.log('[Mysti Canvas] switchView:', vd.activeView, '->', targetView);
      vd.activeView = targetView;

      if (targetView === 'image') {
        _showImageView(active, vd);
      } else if (targetView === 'svg') {
        if (!vd.svgMarkup) return;
        _showSvgView(active, vd);
      } else if (targetView === 'component') {
        if (!vd.componentRender) return;
        _showComponentView(active, vd);
      }

      showSelectionControls();
    }

    function _showImageView(obj, vd) {
      if (!vd.imageDataUrl) { console.log('[Mysti Canvas] No image data to restore'); return; }
      if (obj.type === 'group' && vd.imageDataUrl) {
        var bounds = obj.getBoundingRect();
        var imgEl = new Image();
        imgEl.onload = function() {
          var fabricImg = new fabric.Image(imgEl, Object.assign({}, controlStyle, {
            id: obj.id,
            label: obj.label,
            description: obj.description,
            metadata: obj.metadata,
            left: obj.left,
            top: obj.top,
            _viewData: vd,
          }));
          if (bounds.width > 0) fabricImg.scaleToWidth(bounds.width / (canvas.getZoom()));
          canvas.remove(obj);
          canvas.add(fabricImg);
          canvas.setActiveObject(fabricImg);
          canvas.renderAll();
          autoSave();
          console.log('[Mysti Canvas] Switched to image view');
        };
        imgEl.src = vd.imageDataUrl;
      }
      vd.activeView = 'image';
    }

    function _showSvgView(obj, vd) {
      console.log('[Mysti Canvas] Loading SVG view, markup length:', vd.svgMarkup.length);
      fabric.loadSVGFromString(vd.svgMarkup).then(function(result) {
        var group = fabric.util.groupSVGElements(result.objects, result.options);
        group.set(Object.assign({}, controlStyle, {
          id: obj.id,
          label: obj.label,
          description: obj.description,
          metadata: obj.metadata,
          left: obj.left,
          top: obj.top,
          _viewData: vd,
        }));
        var bounds = obj.getBoundingRect();
        if (bounds.width > 0) group.scaleToWidth(bounds.width / (canvas.getZoom()));
        canvas.remove(obj);
        canvas.add(group);
        canvas.setActiveObject(group);
        canvas.renderAll();
        autoSave();
        console.log('[Mysti Canvas] Switched to SVG view');
      }).catch(function(err) {
        console.error('[Mysti Canvas] Failed to load SVG for view switch:', err);
        vd.activeView = 'image';
      });
      vd.activeView = 'svg';
    }

    function _showComponentView(obj, vd) {
      // Prefer live iframe over static screenshot
      if (vd.codeFiles && vd.codeFiles.length) {
        _createComponentIframe(obj, vd);
        obj.set('opacity', 0.05);
        canvas.renderAll();
        vd.activeView = 'component';
        console.log('[Mysti Canvas] Switched to live component view');
        return;
      }
      // Fallback: static screenshot
      if (!vd.componentRender) { console.log('[Mysti Canvas] No component render to show'); return; }
      var imgEl = new Image();
      imgEl.onload = function() {
        var bounds = obj.getBoundingRect();
        var fabricImg = new fabric.Image(imgEl, Object.assign({}, controlStyle, {
          id: obj.id,
          label: (vd.componentName || obj.label || '') + ' (rendered)',
          description: obj.description,
          metadata: obj.metadata,
          left: obj.left,
          top: obj.top,
          _viewData: vd,
        }));
        if (bounds.width > 0) fabricImg.scaleToWidth(bounds.width / (canvas.getZoom()));
        canvas.remove(obj);
        canvas.add(fabricImg);
        canvas.setActiveObject(fabricImg);
        canvas.renderAll();
        autoSave();
        console.log('[Mysti Canvas] Switched to component rendered view (static)');
      };
      imgEl.src = vd.componentRender;
      vd.activeView = 'component';
    }

    function _renderComponentPreview(obj, files, componentName, framework) {
      var componentFile = null;
      for (var i = 0; i < files.length; i++) {
        if (files[i].fileType === 'component') { componentFile = files[i]; break; }
      }
      if (!componentFile) return;

      // Store code in viewData
      var vd = _ensureViewData(obj);
      vd.codeFiles = files;
      vd.componentName = componentName;
      vd.framework = framework || 'react';

      // If Components tab is active, create live iframe immediately
      if (_activeGlobalTab === 'components') {
        _createComponentIframe(obj, vd);
        obj.set('opacity', 0.05);
        canvas.renderAll();
        vd.activeView = 'component';
        console.log('[Mysti Canvas] Live component preview created for:', obj.id);
      }

      // Also send to extension for static screenshot fallback
      var html = _buildStandaloneHtml(componentFile.content, componentName, framework);
      vscodeApi.postMessage({
        type: 'canvasRenderComponent',
        payload: {
          html: html,
          objectId: obj.id,
          componentName: componentName,
          framework: framework
        }
      });
    }

    function _buildStandaloneHtml(code, componentName, framework) {
      if (framework === 'html') {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#fff;}</style></head><body>' + code + '</body></html>';
      }
      // For React/Vue, build a minimal HTML page with inline script
      var reactCdn = 'https://unpkg.com/react@18/umd/react.production.min.js';
      var reactDomCdn = 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js';
      var babelCdn = 'https://unpkg.com/@babel/standalone/babel.min.js';

      if (framework === 'react') {
        // Strip import/export to make it work inline
        var inlineCode = code
          .replace(/^import\\s+.*$/gm, '')
          .replace(/^export\\s+default\\s+/gm, 'var _Component = ')
          .replace(/^export\\s+/gm, 'var ');
        return '<!DOCTYPE html><html><head><meta charset="utf-8">'
          + '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#fff;}</style>'
          + '<script src="' + reactCdn + '"><\\/script>'
          + '<script src="' + reactDomCdn + '"><\\/script>'
          + '<script src="' + babelCdn + '"><\\/script>'
          + '</head><body><div id="root"></div>'
          + '<script type="text/babel">'
          + inlineCode
          + '\\nvar _Root = typeof _Component !== "undefined" ? _Component : typeof ' + componentName + ' !== "undefined" ? ' + componentName + ' : function() { return React.createElement("div", null, "Component not found"); };'
          + '\\nReactDOM.createRoot(document.getElementById("root")).render(React.createElement(_Root));'
          + '<\\/script></body></html>';
      }

      // Vue fallback — simpler approach
      return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#fff;}</style></head><body><pre>' + code.replace(/</g, '&lt;') + '</pre></body></html>';
    }

    // Tab click handlers
    tabImageVideo.addEventListener('click', function() { _switchGlobalTab('image'); });
    tabSvg.addEventListener('click', function() { _switchGlobalTab('svg'); });
    tabComponents.addEventListener('click', function() { _switchGlobalTab('components'); });
    tabFrames.addEventListener('click', function() { _switchGlobalTab('frames'); });

    // Integrate button click handler (actions panel)
    actionIntegrate.addEventListener('click', function() {
      var active = canvas.getActiveObject();
      if (!active) return;
      var vd = _getViewData(active);
      if (!vd || !vd.codeFiles || !vd.codeFiles.length) return;
      showPromptStatus('Integrating component into project...', 10);
      vscodeApi.postMessage({
        type: 'canvasIntegrateComponent',
        payload: {
          canvasId: canvasSessionId,
          codeFiles: vd.codeFiles,
          componentName: vd.componentName,
          framework: vd.framework,
        }
      });
    });

    // ====================================================================
    // Message handling from extension
    // ====================================================================
    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.type) {
        case 'canvasLoad': {
          var session = msg.payload;
          canvasSessionId = session.id;
          document.getElementById('session-name').textContent = session.name || 'Untitled Canvas';
          if (session.canvasJson) {
            try {
              var json = typeof session.canvasJson === 'string' ? JSON.parse(session.canvasJson) : session.canvasJson;
              canvas.loadFromJSON(json).then(function() {
                canvas.renderAll();
                updateObjectCount();
              });
            } catch (e) { console.log('[Canvas] Failed to load JSON:', e); }
          }
          break;
        }

        case 'canvasStreamChunk': {
          var chunk = msg.payload;
          switch (chunk.type) {

            // ── Reimagination (placed adjacent to frame) ─────────
            case 'canvas_reimagine_started':
              if (_pendingReimagineJob) {
                genJobUpdateLabel(_pendingReimagineJob.id, 'Reimagining...');
              }
              reimagineVariantIndex = 0;
              break;

            case 'canvas_reimagine_variant': {
              if (_pendingReimagineJob) {
                genJobUpdateLabel(_pendingReimagineJob.id, 'Variant ' + (reimagineVariantIndex + 1) + ' of 4...');
              }
              // Use live bounds from job tracker for placement
              var srcBounds = _pendingReimagineJob ? (genJobGetBounds(_pendingReimagineJob.id) || reimagineSourceBounds) : reimagineSourceBounds;
              var variantBounds = null;
              if (srcBounds) {
                // 2x2 grid to the LEFT of the source frame
                var gap = 16;
                var variantW = srcBounds.width;
                var variantH = srcBounds.height;
                var col = reimagineVariantIndex % 2;   // 0 or 1
                var row = Math.floor(reimagineVariantIndex / 2); // 0 or 1
                var gridWidth = variantW * 2 + gap;
                var variantX = srcBounds.left - gridWidth - gap + (col * (variantW + gap));
                var variantY = srcBounds.top + (row * (variantH + gap));
                variantBounds = {
                  left: variantX,
                  top: variantY,
                  width: variantW,
                  height: variantH,
                };
              }
              addImageToCanvas(chunk.variant.imageBase64, chunk.variant.description || ('Variant ' + (reimagineVariantIndex + 1)), variantBounds);
              reimagineVariantIndex++;
              break;
            }

            case 'canvas_reimagine_complete':
              if (_pendingReimagineJob) {
                genJobComplete(_pendingReimagineJob.id);
                _pendingReimagineJob = null;
              }
              showPromptStatusMessage('Reimagination complete — 4 variants placed in grid.', 'success');
              setTimeout(hidePromptStatus, 3000);
              break;

            // ── AI Prompt Response ─────────────────────────────────
            case 'canvas_prompt_response': {
              var panel = document.getElementById('prompt-response-panel');
              var content = document.getElementById('prompt-response-content');
              if (content.textContent === 'Thinking...' || content.textContent === '') {
                content.textContent = '';
                showPromptStatus('AI is responding...', 50);
              }
              content.textContent += chunk.content || '';
              panel.classList.add('visible');
              var txt = content.textContent;
              if (txt.length > 20) {
                hidePromptStatus();
              }
              break;
            }

            // ── Draft / Image Generation ───────────────────────────
            case 'canvas_draft_started':
              if (_pendingGenerateJob) {
                genJobUpdateLabel(_pendingGenerateJob.id, 'Generating image...');
              }
              // Also update legacy draft overlay if visible
              safeSetStyle('draft-progress-fill', 'width', '10%');
              break;

            case 'canvas_draft_progress': {
              var progressLabel = chunk.content || 'Generating...';
              if (_pendingGenerateJob) {
                genJobUpdateLabel(_pendingGenerateJob.id, progressLabel);
              }
              safeSetText('draft-progress-text', progressLabel);
              safeSetStyle('draft-progress-fill', 'width', (chunk.progress || 0) + '%');
              break;
            }

            case 'canvas_draft_complete': {
              var completedGenJob = _pendingGenerateJob ? genJobComplete(_pendingGenerateJob.id) : null;
              var genTargetBounds = completedGenJob ? completedGenJob.targetBounds : null;
              _pendingGenerateJob = null;
              showPromptStatusMessage('Image generated!', 'success');
              safeSetStyle('draft-progress-fill', 'width', '100%');
              safeSetText('draft-progress-text', 'Done!');
              safeEnable('btn-draft-generate');
              setTimeout(function() {
                var draftOv = document.getElementById('draft-overlay');
                if (draftOv) draftOv.classList.remove('visible');
                safeAddClass('draft-progress', 'hidden');
                hidePromptStatus();
              }, 1200);
              if (chunk.variant) {
                var genTargetObj = completedGenJob ? completedGenJob.targetObject : null;
                var genMetadata = genTargetObj ? (genTargetObj.metadata || null) : null;
                addImageToCanvas(chunk.variant.imageBase64, chunk.variant.description, genTargetBounds, genTargetObj, genMetadata);
              }
              break;
            }

            // ── Page Render ────────────────────────────────────────
            case 'canvas_render_started':
              showPromptStatus('Launching browser...', 10);
              break;

            case 'canvas_render_progress':
              showPromptStatus(chunk.content || 'Rendering page...', chunk.progress || 50);
              break;

            case 'canvas_render_complete':
              showPromptStatusMessage('Page captured!', 'success');
              setTimeout(hidePromptStatus, 1500);
              if (chunk.imageBase64) {
                addImageToCanvas(chunk.imageBase64, chunk.label || 'Page Render');
              }
              break;

            // ── Video Generation ─────────────────────────────────
            case 'canvas_video_started':
              if (_pendingVideoJob) {
                genJobUpdateLabel(_pendingVideoJob.id, 'Generating video...');
              }
              break;

            case 'canvas_video_progress': {
              var videoProgressLabel = chunk.content || 'Generating video...';
              if (_pendingVideoJob) {
                genJobUpdateLabel(_pendingVideoJob.id, videoProgressLabel);
              }
              break;
            }

            case 'canvas_video_complete': {
              var completedVideoJob = _pendingVideoJob ? genJobComplete(_pendingVideoJob.id) : null;
              var videoTargetBounds = completedVideoJob ? completedVideoJob.targetBounds : null;
              _pendingVideoJob = null;
              showPromptStatusMessage('Video generated!', 'success');
              setTimeout(hidePromptStatus, 2000);
              if (chunk.videoBase64) {
                var videoTargetObj = completedVideoJob ? completedVideoJob.targetObject : null;
                var videoMetadata = videoTargetObj ? (videoTargetObj.metadata || null) : null;
                addVideoToCanvas(chunk.videoBase64, chunk.mimeType || 'video/mp4', chunk.label || 'Generated Video', videoTargetBounds, videoTargetObj, videoMetadata);
              }
              break;
            }

            // ── Layout Generation ────────────────────────────────────
            case 'canvas_layout_started':
              if (_pendingLayoutJob) {
                genJobUpdateLabel(_pendingLayoutJob.id, 'Generating layout...');
                if (!_pendingLayoutJob.targetObject) {
                  showPromptStatus('Generating layout...', 15);
                }
              }
              break;

            case 'canvas_layout_progress': {
              var layoutProgressLabel = chunk.content || 'Generating layout...';
              if (_pendingLayoutJob) {
                genJobUpdateLabel(_pendingLayoutJob.id, layoutProgressLabel);
                if (!_pendingLayoutJob.targetObject) {
                  showPromptStatus(layoutProgressLabel, 50);
                }
              }
              break;
            }

            case 'canvas_layout_complete': {
              var layoutContainer = _pendingLayoutJob ? _pendingLayoutJob.targetObject : null;
              if (_pendingLayoutJob) { genJobComplete(_pendingLayoutJob.id); _pendingLayoutJob = null; }
              if (chunk.frames && chunk.frames.length) {
                var frameMap = addLayoutFrames(chunk.frames, layoutContainer);
                _lastLayoutFrameMap = frameMap;
                showPromptStatusMessage(chunk.frames.length + ' frames created', 'success');
                setTimeout(hidePromptStatus, 3000);
                // Show batch generation modal
                showBatchGenerateModal(chunk.frames, frameMap);
              } else {
                showPromptStatusMessage('No frames generated', 'error');
                setTimeout(hidePromptStatus, 5000);
              }
              break;
            }

            // ── Website (Multi-Page) Generation ─────────────────
            case 'canvas_website_started':
              showPromptStatus('Planning website structure...', 5);
              break;

            case 'canvas_website_page_started':
              showPromptStatus('Generating page ' + ((chunk.pageIndex || 0) + 1) + '/' + (chunk.totalPages || '?') + ': ' + (chunk.pageName || 'Page') + '...', 10 + Math.round(((chunk.pageIndex || 0) / (chunk.totalPages || 1)) * 80));
              break;

            case 'canvas_website_complete': {
              if (_pendingLayoutJob) { genJobComplete(_pendingLayoutJob.id); _pendingLayoutJob = null; }
              if (chunk.pages && chunk.pages.length) {
                var allFrameMap = {};
                var totalFrameCount = 0;
                chunk.pages.forEach(function(page, pi) {
                  // Add page title label above each page column
                  var titleLeft = page.frames.length > 0 ? page.frames[0].left : pi * 1540;
                  var titleTop = -50;
                  // Find the minimum top from frames to position title above
                  page.frames.forEach(function(f) { if (f.top < titleTop + 50) titleTop = f.top - 50; });
                  var titleText = new fabric.Text(page.name, {
                    left: titleLeft,
                    top: titleTop,
                    fontSize: 28,
                    fontWeight: 'bold',
                    fill: 'rgba(100, 149, 237, 0.9)',
                    selectable: true,
                    evented: true,
                  });
                  canvas.add(titleText);

                  // Add layout frames for this page
                  var pageFrameMap = addLayoutFrames(page.frames, null);
                  Object.keys(pageFrameMap).forEach(function(k) { allFrameMap[k] = pageFrameMap[k]; });
                  totalFrameCount += page.frames.length;
                });

                _lastLayoutFrameMap = allFrameMap;
                showPromptStatusMessage(chunk.pages.length + ' pages, ' + totalFrameCount + ' frames created', 'success');
                setTimeout(hidePromptStatus, 3000);

                // Collect all frames for batch generation
                var allFrames = [];
                chunk.pages.forEach(function(page) {
                  page.frames.forEach(function(f) { allFrames.push(f); });
                });
                showBatchGenerateModal(allFrames, allFrameMap);

                // Zoom to fit all pages
                canvas.requestRenderAll();
              } else {
                showPromptStatusMessage('No pages generated', 'error');
                setTimeout(hidePromptStatus, 5000);
              }
              break;
            }

            // ── SVG Conversion ────────────────────────────────────
            case 'canvas_svg_started':
              if (_pendingSvgJob) { genJobUpdateLabel(_pendingSvgJob.id, 'Converting to SVG...'); }
              break;

            case 'canvas_svg_progress':
              if (chunk.content) { showPromptStatus(chunk.content, chunk.progress || 30); }
              if (_pendingSvgJob) { genJobUpdateLabel(_pendingSvgJob.id, chunk.content || 'Processing...'); }
              break;

            case 'canvas_svg_complete': {
              var svgSourceObj = _pendingSvgJob ? _pendingSvgJob.targetObject : canvas.getActiveObject();
              if (_pendingSvgJob) { genJobComplete(_pendingSvgJob.id); }
              hidePromptStatus();
              if (chunk.svgMarkup && svgSourceObj) {
                // Store SVG on the source object's view data
                var svgVd = _ensureViewData(svgSourceObj);
                svgVd.svgMarkup = chunk.svgMarkup;
                console.log('[Mysti Canvas] SVG stored on object:', svgSourceObj.id, '— markup length:', chunk.svgMarkup.length);
                // Auto-switch to SVG view and tab
                canvas.setActiveObject(svgSourceObj);
                switchView('svg');
                _switchGlobalTab('svg');
                showPromptStatusMessage('SVG created — use tabs to switch views', 'success');
                setTimeout(hidePromptStatus, 3000);
              } else if (chunk.svgMarkup) {
                // Fallback: no source object, add SVG as standalone
                var svgBounds = _pendingSvgJob ? (genJobGetBounds(_pendingSvgJob.id) || null) : null;
                addSvgToCanvas(chunk.svgMarkup, 'SVG', svgBounds);
                showPromptStatusMessage('SVG created', 'success');
                setTimeout(hidePromptStatus, 3000);
              }
              _pendingSvgJob = null;
              break;
            }

            // ── Code Generation ──────────────────────────────────────
            case 'canvas_code_started':
              if (_pendingCodeJob) { genJobUpdateLabel(_pendingCodeJob.id, 'Generating code...'); }
              break;

            case 'canvas_code_progress':
              if (chunk.content) { showPromptStatus(chunk.content, chunk.progress || 30); }
              if (_pendingCodeJob) { genJobUpdateLabel(_pendingCodeJob.id, chunk.content || 'Processing...'); }
              break;

            case 'canvas_code_complete': {
              var codeSourceObj = _pendingCodeJob ? _pendingCodeJob.targetObject : canvas.getActiveObject();
              if (_pendingCodeJob) { genJobComplete(_pendingCodeJob.id); }
              hidePromptStatus();
              if (codeSourceObj) {
                // Store code data in view data
                var codeVd = _ensureViewData(codeSourceObj);
                if (chunk.generatedFiles && chunk.generatedFiles.length) {
                  codeVd.codeFiles = chunk.generatedFiles;
                }
                if (chunk.componentName) {
                  codeVd.componentName = chunk.componentName;
                  codeVd.framework = chunk.framework || 'react';
                }
                if (chunk.componentProps && chunk.componentProps.length) {
                  codeVd.componentProps = chunk.componentProps;
                }
                // Also keep metadata on the fabric object for legacy compat
                codeSourceObj.set('metadata', Object.assign({}, codeSourceObj.metadata || {}, {
                  componentName: chunk.componentName,
                  framework: chunk.framework,
                }));
                console.log('[Mysti Canvas] Code stored on object:', codeSourceObj.id,
                  '— files:', (chunk.generatedFiles || []).length,
                  '— props:', (chunk.componentProps || []).length);
              }
              if (chunk.generatedFiles && chunk.generatedFiles.length) {
                showPromptStatusMessage(chunk.generatedFiles.length + ' files generated — rendering preview...', 'success');
                setTimeout(hidePromptStatus, 4000);
                // Show properties panel if props are available
                if (chunk.componentProps && chunk.componentProps.length > 0) {
                  showPropsPanel(chunk.componentProps, chunk.componentName, chunk.framework);
                }
                // Trigger component rendering instead of code preview
                if (codeSourceObj) {
                  _renderComponentPreview(codeSourceObj, chunk.generatedFiles, chunk.componentName, chunk.framework || 'react');
                }
              }
              _pendingCodeJob = null;
              break;
            }

            case 'canvas_props_extracted': {
              if (chunk.generatedFiles && chunk.generatedFiles.length) {
                showPromptStatusMessage('Code updated with new properties', 'success');
                setTimeout(hidePromptStatus, 3000);
              }
              break;
            }

            // ── Component Rendering ──────────────────────────────
            case 'canvas_component_render_progress':
              if (chunk.content) { showPromptStatus(chunk.content, chunk.progress || 30); }
              break;

            case 'canvas_component_render_complete': {
              hidePromptStatus();
              if (chunk.imageBase64) {
                // Find the object and store the rendered image
                var renderTargetObj = null;
                canvas.getObjects().forEach(function(o) {
                  if (o.id === chunk.objectId) renderTargetObj = o;
                });
                if (!renderTargetObj) renderTargetObj = canvas.getActiveObject();
                if (renderTargetObj) {
                  var renderVd = _ensureViewData(renderTargetObj);
                  renderVd.componentRender = 'data:image/png;base64,' + chunk.imageBase64;
                  console.log('[Mysti Canvas] Component render stored on object:', renderTargetObj.id);
                  // Auto-switch to Components tab
                  _switchGlobalTab('components');
                  canvas.setActiveObject(renderTargetObj);
                  switchView('component');
                  showPromptStatusMessage('Component rendered', 'success');
                  setTimeout(hidePromptStatus, 3000);
                }
              }
              break;
            }

            // ── CLI Integration ──────────────────────────────────
            case 'canvas_integrate_started':
              showPromptStatus('Integrating component...', 10);
              break;

            case 'canvas_integrate_progress':
              if (chunk.content) { showPromptStatus(chunk.content, chunk.progress || 50); }
              break;

            case 'canvas_integrate_complete':
              hidePromptStatus();
              showPromptStatusMessage('Component integrated into project', 'success');
              setTimeout(hidePromptStatus, 4000);
              break;

            // ── Element Editing ──────────────────────────────────
            case 'canvas_element_edit_started':
              showPromptStatus('AI editing element...', 20);
              break;

            case 'canvas_element_edit_complete': {
              hidePromptStatus();
              if (chunk.generatedFiles && chunk.generatedFiles.length) {
                // Find the target object
                var editTargetObj = null;
                if (chunk.objectId) {
                  canvas.getObjects().forEach(function(o) {
                    if (o.id === chunk.objectId) editTargetObj = o;
                  });
                }
                if (!editTargetObj) editTargetObj = canvas.getActiveObject();
                if (editTargetObj) {
                  var editVd = _ensureViewData(editTargetObj);
                  // Update the code files with new code
                  editVd.codeFiles = chunk.generatedFiles;
                  if (chunk.componentName) editVd.componentName = chunk.componentName;
                  if (chunk.framework) editVd.framework = chunk.framework;

                  // Reload the live iframe with updated code
                  var componentFile = null;
                  for (var fi = 0; fi < chunk.generatedFiles.length; fi++) {
                    if (chunk.generatedFiles[fi].fileType === 'component') { componentFile = chunk.generatedFiles[fi]; break; }
                  }
                  if (componentFile && _iframeOverlays[editTargetObj.id]) {
                    _reloadComponentIframe(editTargetObj.id, componentFile.content, editVd.componentName || '', editVd.framework || 'react');
                  } else if (componentFile) {
                    // Create iframe if not yet exists (components tab might not be active)
                    _createComponentIframe(editTargetObj, editVd);
                    if (_activeGlobalTab === 'components') {
                      editTargetObj.set('opacity', 0.05);
                      canvas.renderAll();
                    }
                  }

                  showPromptStatusMessage('Element updated', 'success');
                  setTimeout(hidePromptStatus, 3000);
                  autoSave();
                  console.log('[Mysti Canvas] Element edit applied to:', editTargetObj.id);
                }
              }
              break;
            }

            // ── Batch Content Generation ─────────────────────────
            case 'canvas_batch_started':
              showPromptStatus('Building design theme...', 10);
              break;

            case 'canvas_batch_frame_started': {
              var batchJob = _pendingBatchJobs[chunk.frameId];
              if (batchJob) {
                genJobUpdateLabel(batchJob.id, 'Generating ' + (chunk.label || 'frame') + '...');
              }
              var batchPct = 10 + Math.round(((chunk.frameIndex || 0) / (chunk.totalFrames || 1)) * 80);
              showPromptStatus('Generating frame ' + ((chunk.frameIndex || 0) + 1) + '/' + (chunk.totalFrames || '?') + '...', batchPct);
              break;
            }

            case 'canvas_batch_frame_complete': {
              var completedBatchJob = _pendingBatchJobs[chunk.frameId];
              var batchFrameBounds = completedBatchJob ? completedBatchJob.targetBounds : null;
              if (completedBatchJob) {
                genJobComplete(completedBatchJob.id);
                delete _pendingBatchJobs[chunk.frameId];
              }
              var batchTargetObj = completedBatchJob ? completedBatchJob.targetObject : null;
              var batchMetadata = batchTargetObj ? (batchTargetObj.metadata || null) : null;
              if (chunk.videoBase64) {
                addVideoToCanvas(chunk.videoBase64, chunk.mimeType || 'video/mp4', chunk.label || 'Generated Video', batchFrameBounds, batchTargetObj, batchMetadata);
              } else if (chunk.imageBase64) {
                addImageToCanvas(chunk.imageBase64, chunk.label || 'Generated Image', batchFrameBounds, batchTargetObj, batchMetadata);
              }
              break;
            }

            case 'canvas_batch_complete':
              for (var bId in _pendingBatchJobs) {
                genJobComplete(_pendingBatchJobs[bId].id);
              }
              _pendingBatchJobs = {};
              showPromptStatusMessage('All ' + (chunk.totalFrames || '') + ' frames generated!', 'success');
              setTimeout(hidePromptStatus, 4000);
              break;

            // ── Errors ─────────────────────────────────────────────
            case 'canvas_error':
              showPromptStatusMessage(chunk.error || 'Unknown error', 'error');
              safeEnable('btn-draft-generate');
              safeAddClass('draft-progress', 'hidden');
              // Clean up any active generation jobs
              if (_pendingGenerateJob) { genJobComplete(_pendingGenerateJob.id); _pendingGenerateJob = null; }
              if (_pendingReimagineJob) { genJobComplete(_pendingReimagineJob.id); _pendingReimagineJob = null; }
              if (_pendingVideoJob) { genJobComplete(_pendingVideoJob.id); _pendingVideoJob = null; }
              if (_pendingLayoutJob) { genJobComplete(_pendingLayoutJob.id); _pendingLayoutJob = null; }
              // Clean up batch job for this specific frame if frameId present
              if (chunk.frameId && _pendingBatchJobs[chunk.frameId]) {
                genJobComplete(_pendingBatchJobs[chunk.frameId].id);
                delete _pendingBatchJobs[chunk.frameId];
              }
              reimagineVariantIndex = 0;
              reimagineSourceBounds = null;
              // Auto-dismiss error after 8 seconds
              setTimeout(hidePromptStatus, 8000);
              break;
          }
          break;
        }

        case 'canvasScreenshot': {
          if (msg.payload && msg.payload.base64Data) {
            addImageToCanvas(msg.payload.base64Data, 'Screenshot');
          }
          break;
        }

        case 'canvasImageResult': {
          if (msg.payload && msg.payload.imageBase64) {
            addImageToCanvas(msg.payload.imageBase64, msg.payload.label || 'AI Image');
          }
          break;
        }

        case 'canvasShowConfig': {
          showConfigPanel();
          break;
        }

        case 'canvasConfigSaved': {
          configSuccess.classList.add('visible');
          configActions.style.display = 'none';
          configSaveBtn.textContent = 'Save & Continue';
          configSaveBtn.disabled = false;
          setTimeout(function() {
            configOverlay.classList.remove('visible');
            showPromptStatusMessage('Image generation configured! Try your command again.', 'success');
            setTimeout(hidePromptStatus, 4000);
          }, 1500);
          break;
        }
      }
    });

    // ====================================================================
    // Initialize — request session from extension
    // ====================================================================
    vscodeApi.postMessage({ type: 'canvasReady' });
    console.log('[Mysti Canvas] Canvas fully initialized, canvasReady sent');

    } // end createCanvas
    } // end initCanvas

  })();
  </script>
</body>
</html>`;
}
