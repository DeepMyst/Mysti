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
  // F-6: locally bundled sandbox runtime (no unpkg CDN). The parent webview
  // fetches these (same-origin to itself) and inlines them as <script> text
  // inside the sandboxed iframe srcdoc, so generated/Stitch code runs in a
  // unique opaque origin with no allow-same-origin and no network dependency.
  const sandboxReactUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'canvas-sandbox', 'react.production.min.js'));
  const sandboxReactDomUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'canvas-sandbox', 'react-dom.production.min.js'));
  const sandboxBabelUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'canvas-sandbox', 'babel.min.js'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data: blob: https:;
             media-src data: blob:;
             frame-src 'self' blob: data:;
             child-src 'self' blob: data:;
             style-src 'unsafe-inline' https:;
             script-src 'nonce-${nonce}' 'unsafe-eval' ${webview.cspSource};
             font-src ${webview.cspSource} https: data:;
             connect-src ${webview.cspSource} https: data:;">
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

    /* Zoom preset menu */
    .zoom-preset-menu {
      position: absolute; bottom: 36px; right: 0;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.98));
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px; padding: 4px 0; z-index: 60;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); min-width: 140px;
      display: none;
    }
    .zoom-preset-menu.visible { display: block; }
    .zoom-preset-item {
      padding: 6px 16px; cursor: pointer; font-size: 12px;
      color: var(--vscode-editor-foreground);
      display: flex; justify-content: space-between; align-items: center;
    }
    .zoom-preset-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)); }
    .zoom-preset-shortcut {
      color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 16px;
    }
    .zoom-preset-separator {
      height: 1px; background: var(--vscode-panel-border, #444); margin: 4px 0;
    }

    /* Screen list panel */
    .screen-list-panel {
      position: absolute; top: 0; left: 0; width: 200px; height: 100%;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.95));
      border-right: 1px solid var(--vscode-panel-border, #444);
      z-index: 45; display: none; flex-direction: column; overflow: hidden;
    }
    .screen-list-panel.visible { display: flex; }
    .screen-list-header {
      padding: 8px 12px; font-size: 11px; font-weight: 600;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      display: flex; justify-content: space-between; align-items: center;
    }
    .screen-list-body { flex: 1; overflow-y: auto; padding: 4px 0; }
    .screen-list-item {
      padding: 6px 12px; cursor: pointer; font-size: 12px;
      color: var(--vscode-editor-foreground);
      display: flex; align-items: center; gap: 8px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .screen-list-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
    .screen-list-item.selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(55,148,255,0.15));
      color: var(--vscode-list-activeSelectionForeground);
    }
    .screen-list-icon { width: 14px; text-align: center; opacity: 0.5; flex-shrink: 0; }

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
    .stitch-iframe-wrapper {
      position: absolute; overflow: hidden;
      pointer-events: none;
      border-radius: 4px;
      background: #fff;
    }
    .stitch-iframe-wrapper iframe {
      border: none;
      pointer-events: none;
      transform-origin: 0 0;
    }

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
      position: relative;
    }
    .actions-panel {
      width: 160px;
      overflow-y: auto;
      overflow-x: hidden;
      background: var(--vscode-sideBar-background, #252526);
      border-left: 1px solid var(--vscode-panel-border, #555);
      transition: width 0.2s ease;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
    }
    .actions-panel.collapsed { width: 0; overflow: hidden; }
    .actions-panel-toggle {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 20;
      width: 16px;
      height: 48px;
      background: var(--vscode-sideBar-background, #252526);
      border: 1px solid var(--vscode-panel-border, #555);
      border-right: none;
      border-radius: 4px 0 0 4px;
      color: var(--vscode-foreground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      padding: 0;
      opacity: 0.7;
      transition: opacity 0.15s;
    }
    .actions-panel-toggle:hover { opacity: 1; }
    .actions-panel-toggle.panel-open { right: 160px; }
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
    .actions-section-header {
      padding: 6px 12px 2px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground, #888);
      margin-top: 4px;
      white-space: nowrap;
    }
    .actions-section-header:first-child { margin-top: 0; }
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
    .assets-filter-bar {
      display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;
    }
    .asset-filter-btn {
      padding: 4px 10px; border-radius: 12px; font-size: 11px;
      border: 1px solid var(--vscode-widget-border, #444);
      background: transparent; color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .asset-filter-btn:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
    .asset-filter-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .asset-card { position: relative; }
    .asset-card .asset-type-badge {
      position: absolute; top: 6px; right: 6px;
      font-size: 9px; padding: 2px 6px; border-radius: 8px;
      background: rgba(0,0,0,0.6); color: #fff; text-transform: uppercase;
    }
    .asset-card .asset-prompt-preview {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      padding: 0 8px 6px;
    }
    /* Themes panel */
    .themes-toolbar { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
    .themes-grid { display: grid; grid-template-columns: 1fr; gap: 8px; padding: 8px; overflow-y: auto; }
    .theme-card {
      background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px; padding: 10px; cursor: pointer; transition: border-color 0.15s;
    }
    .theme-card.active { border-color: var(--vscode-button-background); border-width: 2px; }
    .theme-card:hover { border-color: var(--vscode-focusBorder, #007fd4); }
    .theme-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .theme-card-name { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
    .theme-card-actions { display: flex; gap: 4px; }
    .theme-card-actions button {
      background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground);
      font-size: 11px; padding: 2px 4px; border-radius: 3px;
    }
    .theme-card-actions button:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
    .theme-swatches { display: flex; gap: 3px; margin-bottom: 6px; }
    .theme-swatch { width: 20px; height: 20px; border-radius: 4px; border: 1px solid rgba(128,128,128,0.3); }
    .theme-card-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .theme-editor {
      position: absolute; inset: 0; z-index: 10; background: var(--vscode-editor-background);
      display: flex; flex-direction: column;
    }
    .theme-editor-header {
      display: flex; gap: 8px; padding: 8px; align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .theme-editor-input {
      flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444); padding: 4px 8px; border-radius: 4px; font-size: 12px;
    }
    .theme-editor-body { flex: 1; padding: 8px; overflow-y: auto; }
    .theme-editor-footer { padding: 8px; border-top: 1px solid var(--vscode-panel-border, #333); }
    .theme-color-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .theme-color-row label { flex: 1; font-size: 11px; color: var(--vscode-foreground); }
    .theme-color-row input[type="color"] { width: 28px; height: 22px; border: none; cursor: pointer; background: none; padding: 0; }
    .theme-color-row input[type="text"] {
      width: 70px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444); padding: 2px 6px; border-radius: 3px; font-size: 11px; font-family: monospace;
    }
    .theme-section-title { font-size: 11px; font-weight: 600; margin: 10px 0 6px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }

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
    <button class="tool-btn" data-tool="text" title="Text (T)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5V3h12v2"/><path d="M10 3v14"/><path d="M7 17h6"/></svg></button>
    <button class="tool-btn" data-tool="image" title="Import Image (I)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l4-4 3 3 4-4 5 5"/></svg></button>
    <button class="tool-btn" data-tool="pan" title="Pan (Space)"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v10M7 5V3.5a1.5 1.5 0 013 0M13 5V3.5a1.5 1.5 0 00-3 0M7 5v7a1.5 1.5 0 01-3 0V9M13 5v7a1.5 1.5 0 003 0V9M7 12a5 5 0 005 5h0a5 5 0 005-5"/></svg></button>
    <div class="tool-separator"></div>
    <button class="tool-btn" id="btn-undo" title="Undo (Ctrl+Z)" disabled><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h10a3 3 0 010 6H11"/><path d="M7 5L4 8l3 3"/></svg></button>
    <button class="tool-btn" id="btn-redo" title="Redo (Ctrl+Shift+Z)" disabled><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8H6a3 3 0 000 6h3"/><path d="M13 5l3 3-3 3"/></svg></button>
    <div class="tool-separator"></div>
    <label class="tool-label">Color</label>
    <input type="color" id="tool-color" class="tool-color-input" value="#ffffff">
  </div>

  <!-- Global tab bar -->
  <div class="canvas-global-tabs" id="canvas-global-tabs">
    <button class="global-tab active" id="tab-design" data-tab="design">Design</button>
    <button class="global-tab" id="tab-assets" data-tab="assets">Assets</button>
    <button class="global-tab" id="tab-themes" data-tab="themes">Themes</button>
    <button class="global-tab" id="tab-code" data-tab="code">Code</button>
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
      <button class="zoom-level" id="zoom-level-btn" title="Click for zoom presets">100%</button>
      <button class="zoom-btn" id="btn-zoom-in" title="Zoom in (Ctrl+=)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8h10M8 3v10"/></svg></button>
      <button class="zoom-btn" id="btn-zoom-fit" title="Zoom to fit (Ctrl+0)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button>
      <span style="width:1px;height:16px;background:var(--vscode-widget-border,#444);margin:0 2px;"></span>
      <button class="zoom-btn" id="btn-preview-toggle" title="Toggle Preview (Shift+P)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg></button>
      <div class="zoom-preset-menu" id="zoom-preset-menu">
        <div class="zoom-preset-item" data-zoom="0.25">25%</div>
        <div class="zoom-preset-item" data-zoom="0.5">50%</div>
        <div class="zoom-preset-item" data-zoom="0.75">75%</div>
        <div class="zoom-preset-item" data-zoom="1">100%<span class="zoom-preset-shortcut">⌘1</span></div>
        <div class="zoom-preset-item" data-zoom="1.5">150%</div>
        <div class="zoom-preset-item" data-zoom="2">200%</div>
        <div class="zoom-preset-separator"></div>
        <div class="zoom-preset-item" data-zoom="fit">Zoom to fit<span class="zoom-preset-shortcut">⌘0</span></div>
      </div>
    </div>
    <!-- Screen list panel -->
    <div class="screen-list-panel" id="screen-list-panel">
      <div class="screen-list-header">
        <span>Screens</span>
        <button class="zoom-btn" id="btn-close-screen-list" style="width:20px;height:20px;" title="Close (L)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8"/></svg>
        </button>
      </div>
      <div class="screen-list-body" id="screen-list-body"></div>
    </div>
    <!-- Tab placeholder overlay (positioned over selected frame when tab content missing) -->
    <div class="tab-placeholder-overlay" id="tab-placeholder-overlay">
      <div class="tab-placeholder-icon" id="tab-placeholder-icon"></div>
      <div class="tab-placeholder-label" id="tab-placeholder-label">No content</div>
      <button class="tab-placeholder-btn" id="tab-placeholder-btn">Generate</button>
    </div>
    <!-- Assets panel (unified asset library, shown on Assets tab) -->
    <div class="frames-panel" id="assets-panel">
      <div class="assets-filter-bar" id="assets-filter-bar">
        <button class="asset-filter-btn active" data-filter="all">All</button>
        <button class="asset-filter-btn" data-filter="image">Images</button>
        <button class="asset-filter-btn" data-filter="video">Videos</button>
        <button class="asset-filter-btn" data-filter="svg">SVGs</button>
        <button class="asset-filter-btn" data-filter="icon">Icons</button>
      </div>
      <div class="frames-grid" id="assets-grid"></div>
    </div>
    <!-- Themes Panel -->
    <div class="frames-panel" id="themes-panel">
      <div class="themes-toolbar">
        <button class="canvas-header-btn" id="btn-theme-generate">+ Generate</button>
        <button class="canvas-header-btn" id="btn-theme-new">+ Blank</button>
      </div>
      <div class="themes-grid" id="themes-grid"></div>
      <div class="theme-editor" id="theme-editor" style="display:none;">
        <div class="theme-editor-header">
          <input type="text" id="theme-editor-name" class="theme-editor-input" placeholder="Theme name" />
          <button class="canvas-header-btn" id="btn-theme-editor-close">&times;</button>
        </div>
        <div class="theme-editor-body" id="theme-editor-body"></div>
        <div class="theme-editor-footer">
          <button class="canvas-header-btn primary" id="btn-theme-editor-save">Save</button>
        </div>
      </div>
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
  <!-- Actions panel toggle -->
  <button class="actions-panel-toggle panel-open" id="actions-panel-toggle" title="Toggle actions panel">&#9654;</button>
  <!-- Collapsible right actions panel -->
  <div class="actions-panel" id="actions-panel">
    <div class="actions-section-header">Design</div>
    <button class="action-btn" id="action-generate-design" title="Generate a new design with AI"><span class="action-icon">&#127912;</span> Generate Design</button>
    <button class="action-btn" id="action-reimagine" title="Edit screen with AI"><span class="action-icon">&#9998;</span> Edit Screen</button>
    <button class="action-btn" id="action-theme" title="Apply or generate a theme"><span class="action-icon">&#127917;</span> Apply Theme</button>
    <button class="action-btn" id="action-preview" title="Toggle Preview (Shift+P)"><span class="action-icon">&#128065;</span> Toggle Preview</button>
    <div class="actions-section-header">Assets</div>
    <button class="action-btn" id="action-generate" title="Generate image"><span class="action-icon">&#128444;</span> Generate Image</button>
    <button class="action-btn" id="action-video" title="Generate video"><span class="action-icon">&#127916;</span> Generate Video</button>
    <button class="action-btn" id="action-gen-assets" title="Generate all unresolved assets"><span class="action-icon">&#128230;</span> Generate All Assets</button>
    <div class="actions-section-header">Code</div>
    <button class="action-btn" id="action-code" title="Generate component code"><span class="action-icon">&lt;/&gt;</span> Generate Code</button>
    <button class="action-btn action-integrate" id="action-integrate" title="Integrate into project"><span class="action-icon">&#128204;</span> Integrate</button>
    <div class="actions-separator" id="element-actions-sep" style="display:none;"></div>
    <button class="action-btn" id="action-edit-element" style="display:none;" title="Edit element with AI"><span class="action-icon">&#9998;</span> Edit Element</button>
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
             placeholder="Type a prompt, or /design, /edit, /image, /code..."
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

    // F-6: locally bundled sandbox runtime URIs (replaces unpkg CDN). The
    // parent fetches these once (same-origin to itself), caches the text, and
    // inlines them into the sandboxed iframe srcdoc.
    var _SANDBOX_URIS = {
      react: ${JSON.stringify(sandboxReactUri.toString())},
      reactDom: ${JSON.stringify(sandboxReactDomUri.toString())},
      babel: ${JSON.stringify(sandboxBabelUri.toString())}
    };
    var _sandboxRuntimeCache = null; // { react, reactDom, babel } text
    var _sandboxRuntimePromise = null;
    function _loadSandboxRuntime() {
      if (_sandboxRuntimeCache) { return Promise.resolve(_sandboxRuntimeCache); }
      if (_sandboxRuntimePromise) { return _sandboxRuntimePromise; }
      _sandboxRuntimePromise = Promise.all([
        fetch(_SANDBOX_URIS.react).then(function(r) { return r.text(); }),
        fetch(_SANDBOX_URIS.reactDom).then(function(r) { return r.text(); }),
        fetch(_SANDBOX_URIS.babel).then(function(r) { return r.text(); })
      ]).then(function(parts) {
        _sandboxRuntimeCache = { react: parts[0], reactDom: parts[1], babel: parts[2] };
        return _sandboxRuntimeCache;
      }).catch(function(err) {
        console.error('[Mysti Canvas] Failed to load bundled sandbox runtime:', err);
        _sandboxRuntimePromise = null;
        throw err;
      });
      return _sandboxRuntimePromise;
    }
    // Prefetch so React/Babel are warm before the first component renders.
    _loadSandboxRuntime().catch(function() {});

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

    // ====================================================================
    // Design Spec — structured design hierarchy (Canvas v3)
    // ====================================================================
    var _designSpec = null;          // DesignSpec JSON — source of truth
    var _nodeMap = {};               // { nodeId: { fabricObj, designNode } }
    var _currentFrameScope = null;   // nodeId when zoomed into a frame
    var _breadcrumbPath = [];        // array of nodeIds from root to current scope
    var _previewMode = false;        // toggle: wireframe vs HTML preview overlays

    function _registerDesignNode(fabricObj, designNode) {
      fabricObj._designNode = designNode;
      _nodeMap[designNode.id] = { fabricObj: fabricObj, designNode: designNode };
    }

    function _unregisterDesignNode(nodeId) {
      var entry = _nodeMap[nodeId];
      if (entry && entry.fabricObj) {
        delete entry.fabricObj._designNode;
      }
      delete _nodeMap[nodeId];
    }

    function _getChildNodes(parentId) {
      if (!_designSpec) return [];
      var results = [];
      function walk(nodes) {
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].parentId === parentId) { results.push(nodes[i]); }
          if (nodes[i].children) { walk(nodes[i].children); }
        }
      }
      walk(_designSpec.rootNodes);
      return results;
    }

    function _getAllDescendantNodes(parentId) {
      var descendants = [];
      var directChildren = _getChildNodes(parentId);
      for (var i = 0; i < directChildren.length; i++) {
        descendants.push(directChildren[i]);
        var sub = _getAllDescendantNodes(directChildren[i].id);
        for (var j = 0; j < sub.length; j++) { descendants.push(sub[j]); }
      }
      return descendants;
    }

    function _getFrameBoundingBox(obj) {
      // Compute union bounding box of a root frame and all its descendant fabric objects
      var left = obj.left;
      var top = obj.top;
      var right = left + (obj.width * (obj.scaleX || 1));
      var bottom = top + (obj.height * (obj.scaleY || 1));

      if (obj._designNode) {
        var descendants = _getAllDescendantNodes(obj._designNode.id);
        for (var i = 0; i < descendants.length; i++) {
          var entry = _nodeMap[descendants[i].id];
          if (entry && entry.fabricObj) {
            var fo = entry.fabricObj;
            var foLeft = fo.left;
            var foTop = fo.top;
            var foRight = foLeft + (fo.width * (fo.scaleX || 1));
            var foBottom = foTop + (fo.height * (fo.scaleY || 1));
            if (foLeft < left) left = foLeft;
            if (foTop < top) top = foTop;
            if (foRight > right) right = foRight;
            if (foBottom > bottom) bottom = foBottom;
          }
        }
      }
      return { left: left, top: top, width: right - left, height: bottom - top };
    }

    function _syncChildPositions(parentId, deltaX, deltaY) {
      var children = _getChildNodes(parentId);
      children.forEach(function(child) {
        var entry = _nodeMap[child.id];
        if (entry && entry.fabricObj) {
          entry.fabricObj.set({
            left: entry.fabricObj.left + deltaX,
            top: entry.fabricObj.top + deltaY
          });
          entry.fabricObj.setCoords();
        }
        _syncChildPositions(child.id, deltaX, deltaY);
      });
    }

    function _renderDesignTree(nodes, theme) {
      // Clear existing design nodes from canvas
      Object.keys(_nodeMap).forEach(function(id) {
        var entry = _nodeMap[id];
        if (entry && entry.fabricObj) {
          canvas.remove(entry.fabricObj);
          if (entry.fabricObj._contentText) { canvas.remove(entry.fabricObj._contentText); }
          if (entry.fabricObj._typeBadge) { canvas.remove(entry.fabricObj._typeBadge); }
          if (entry.fabricObj._assetPlaceholders) {
            entry.fabricObj._assetPlaceholders.forEach(function(p) { canvas.remove(p); });
          }
        }
      });
      _nodeMap = {};

      // Recursively create fabric rects for each node
      function renderNode(node, parentOffset, depth) {
        var absX = parentOffset.x + node.x;
        var absY = parentOffset.y + node.y;

        // Border color varies by depth — fully opaque for visibility
        var borderColors = ['#3B82F6', '#8B5CF6', '#F59E0B', '#10B981', '#EF4444'];
        var borderColor = borderColors[depth % borderColors.length];

        // Resolve background from theme
        var bgColor = 'transparent';
        if (node.style && node.style.background) {
          var bg = node.style.background;
          if (theme && theme.colors && theme.colors[bg]) {
            bgColor = theme.colors[bg];
          } else if (bg.startsWith('#') || bg.startsWith('rgb')) {
            bgColor = bg;
          }
        }

        // Fill: use resolved bg or a subtle tint from border color
        var fillAlphas = [0.08, 0.06, 0.05, 0.04, 0.03];
        var fillAlpha = fillAlphas[Math.min(depth, fillAlphas.length - 1)];
        var fillColor = bgColor !== 'transparent' ? bgColor : _hexToRgba(borderColor, fillAlpha);

        var rect = new fabric.Rect(Object.assign({}, controlStyle, {
          left: absX,
          top: absY,
          width: node.width,
          height: node.height,
          fill: fillColor,
          stroke: borderColor,
          strokeWidth: depth === 0 ? 2 : 1,
          opacity: 1,
          rx: (node.style && node.style.radius) || 0,
          ry: (node.style && node.style.radius) || 0,
          selectable: true,
          hasControls: true,
          lockRotation: true,
        }));

        rect.label = node.name;
        rect.description = node.description || '';
        rect.nodeType = node.type;
        rect.id = node.id || 'node-' + (++objectIdCounter);

        _registerDesignNode(rect, node);
        canvas.add(rect);
        // Labels are now rendered in after:render (no separate objects needed)

        // Render text content
        if (node.text) {
          var typo = node.typography || {};
          var textFontSize = typo.size || 14;
          var textWeight = typo.weight || 400;
          var textColor = 'rgba(220,220,220,0.9)';
          if (typo.color && theme && theme.colors && theme.colors[typo.color]) {
            textColor = theme.colors[typo.color];
          } else if (typo.color && (typo.color.startsWith('#') || typo.color.startsWith('rgb'))) {
            textColor = typo.color;
          }
          var textAlign = typo.align || 'left';
          var labelH = 16;
          var textObj = new fabric.Textbox(node.text, {
            left: absX + 8,
            top: absY + labelH,
            width: node.width - 16,
            fontSize: textFontSize,
            fontWeight: String(textWeight),
            fill: textColor,
            fontFamily: typo.family || (theme && theme.typography ? theme.typography.fontFamily : '') || 'system-ui, sans-serif',
            textAlign: textAlign,
            selectable: false,
            evented: false,
            _isFrameLabel: true,
            splitByGrapheme: false,
          });
          rect._contentText = textObj;
          canvas.add(textObj);
        }

        // Render asset placeholders (or live HTML iframes for Stitch screens)
        if (node.assets && node.assets.length) {
          rect._assetPlaceholders = [];
          var assetY = absY + (node.text ? 40 : 20);

          // Check if this is a Stitch node with HTML — prefer live iframe over screenshot
          var htmlAsset = null;
          var imageAsset = null;
          for (var ai = 0; ai < node.assets.length; ai++) {
            if (node.assets[ai].type === 'html' && node.assets[ai].src) { htmlAsset = node.assets[ai]; }
            if (node.assets[ai].type === 'image' && node.assets[ai].src && node.assets[ai].src.indexOf('data:image/') === 0) { imageAsset = node.assets[ai]; }
          }

          if (htmlAsset && node.metadata && node.metadata.engine === 'stitch') {
            // Store Stitch ref on fabric object for editing commands
            rect._stitchScreenRef = {
              projectId: node.metadata.stitchProjectId,
              screenId: node.metadata.stitchScreenId,
              htmlContent: htmlAsset.src,
              imageBase64: imageAsset ? imageAsset.src.replace(new RegExp('^data:image/[a-z]+;base64,'), '') : undefined,
            };

            // Make the fabric rect nearly invisible but still selectable (fabric needs some fill for hit detection)
            rect.set({ fill: 'rgba(255,255,255,0.01)', stroke: 'rgba(59,130,246,0.3)', strokeWidth: 1, opacity: 1 });

            // Render live HTML iframe overlay for full-resolution display
            _createStitchIframe(rect, htmlAsset.src, node.width, node.height);

            // Also render the screenshot as a low-opacity fallback (visible when iframe is loading)
            if (imageAsset) {
              var fallbackImg = new Image();
              fallbackImg.onload = function() {
                var fImg = new fabric.Image(fallbackImg, {
                  left: absX,
                  top: absY,
                  scaleX: node.width / fallbackImg.width,
                  scaleY: node.height / fallbackImg.height,
                  selectable: false,
                  evented: false,
                  _isFrameLabel: true,
                  opacity: 0.15,
                });
                canvas.add(fImg);
                rect._assetPlaceholders.push(fImg);
                canvas.renderAll();
              };
              fallbackImg.src = imageAsset.src;
            }
          } else {
            // Non-Stitch nodes: render assets normally
            node.assets.forEach(function(asset) {
            // For image assets with inline data, render actual image
            if (asset.type === 'image' && asset.src && asset.src.indexOf('data:image/') === 0) {
              var imgEl = new Image();
              imgEl.onload = function() {
                var scaleX = node.width / imgEl.width;
                var scaleY = node.height / imgEl.height;
                var scale = Math.min(scaleX, scaleY);
                var fImg = new fabric.Image(imgEl, {
                  left: absX,
                  top: absY,
                  scaleX: scale,
                  scaleY: scale,
                  selectable: false,
                  evented: false,
                  _isFrameLabel: true,
                });
                canvas.add(fImg);
                rect._assetPlaceholders.push(fImg);
                canvas.renderAll();
                zoomToFit();
              };
              imgEl.onerror = function() {
                console.error('[Mysti Canvas] Failed to load screenshot image');
                var errPh = new fabric.Rect({
                  left: absX + 8, top: assetY, width: node.width - 16, height: Math.min(80, node.height * 0.4),
                  fill: 'rgba(255,80,80,0.15)', stroke: 'rgba(255,80,80,0.3)', strokeWidth: 1,
                  strokeDashArray: [4, 4], rx: 4, ry: 4,
                  selectable: false, evented: false, _isFrameLabel: true,
                });
                canvas.add(errPh);
                rect._assetPlaceholders.push(errPh);
                canvas.renderAll();
              };
              imgEl.src = asset.src;
              return; // Skip the placeholder rendering
            }
            // Skip HTML assets (rendered via iframe for Stitch, unused for others)
            if (asset.type === 'html') { return; }

            var phH = Math.min(80, node.height * 0.4);
            var phW = node.width - 16;
            var ph = new fabric.Rect({
              left: absX + 8,
              top: assetY,
              width: phW,
              height: phH,
              fill: 'rgba(100,100,100,0.15)',
              stroke: 'rgba(150,150,150,0.3)',
              strokeWidth: 1,
              strokeDashArray: [4, 4],
              rx: 4, ry: 4,
              selectable: false,
              evented: false,
              _isFrameLabel: true,
            });
            canvas.add(ph);
            var iconMap = { image: '\uD83D\uDDBC', video: '\uD83C\uDFAC', svg: '\u25C7', icon: '\u2605' };
            var phLabel = (iconMap[asset.type] || '\uD83D\uDCCE') + ' ' + (asset.alt || asset.prompt || asset.type);
            var phText = new fabric.Text(phLabel, {
              left: absX + 8 + phW / 2,
              top: assetY + phH / 2,
              originX: 'center',
              originY: 'center',
              fontSize: 11,
              fill: 'rgba(180,180,180,0.7)',
              fontFamily: 'system-ui, sans-serif',
              selectable: false,
              evented: false,
              _isFrameLabel: true,
            });
            canvas.add(phText);
            rect._assetPlaceholders.push(ph, phText);
            assetY += phH + 8;
          }); // end forEach
          } // end else (non-Stitch)
        }

        // Component type badge
        if (node.componentType) {
          var badge = new fabric.Text(node.componentType, {
            left: absX + node.width - 4,
            top: absY + 2,
            originX: 'right',
            originY: 'top',
            fontSize: 9,
            fill: 'rgba(150,180,255,0.7)',
            fontFamily: 'system-ui, sans-serif',
            selectable: false,
            evented: false,
            _isFrameLabel: true,
          });
          rect._typeBadge = badge;
          canvas.add(badge);
        }

        // Render children
        if (node.children) {
          node.children.forEach(function(child) {
            renderNode(child, { x: absX, y: absY }, depth + 1);
          });
        }
      }

      nodes.forEach(function(node) {
        renderNode(node, { x: 0, y: 0 }, 0);
      });

      canvas.renderAll();
    }

    function _updateBreadcrumb(nodeId) {
      _breadcrumbPath = [];
      if (!_designSpec || !nodeId) return;
      // Walk up ancestors
      function findAncestors(nodes, targetId, path) {
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].id === targetId) {
            path.push(nodes[i].id);
            return true;
          }
          if (nodes[i].children) {
            path.push(nodes[i].id);
            if (findAncestors(nodes[i].children, targetId, path)) return true;
            path.pop();
          }
        }
        return false;
      }
      findAncestors(_designSpec.rootNodes, nodeId, _breadcrumbPath);
    }

    function _getDefaultTheme() {
      return {
        colors: {
          primary: '#3B82F6', secondary: '#6366F1', accent: '#F59E0B',
          background: '#FFFFFF', surface: '#F9FAFB',
          text: '#111827', textSecondary: '#6B7280', border: '#E5E7EB',
          error: '#EF4444', success: '#10B981'
        },
        typography: {
          fontFamily: 'Inter, system-ui, sans-serif',
          scale: [12, 14, 16, 20, 24, 32, 48],
          lineHeight: 1.5,
          weights: { regular: 400, medium: 500, bold: 700 }
        },
        spacing: { unit: 4, scale: [1, 2, 3, 4, 6, 8, 12, 16] },
        radii: { sm: 4, md: 8, lg: 16, full: 9999 },
        shadows: {
          sm: '0 1px 2px rgba(0,0,0,0.05)',
          md: '0 4px 6px rgba(0,0,0,0.1)',
          lg: '0 10px 15px rgba(0,0,0,0.1)'
        }
      };
    }

    // ====================================================================
    // Preview Rendering — DesignNode → styled HTML overlays
    // ====================================================================
    var _previewOverlays = {}; // nodeId -> { div, designNode }

    function _togglePreviewMode() {
      _previewMode = !_previewMode;
      var btn = document.getElementById('btn-preview-toggle');
      if (btn) { btn.style.color = _previewMode ? 'var(--vscode-button-background)' : ''; }
      if (_previewMode) {
        _showPreviewOverlays();
      } else {
        _hidePreviewOverlays();
      }
    }

    function _showPreviewOverlays() {
      _hidePreviewOverlays();
      if (!_designSpec) return;
      var theme = _designSpec.theme;

      // Only create overlays for top-level page nodes (they contain everything)
      _designSpec.rootNodes.forEach(function(rootNode) {
        var entry = _nodeMap[rootNode.id];
        if (!entry || !entry.fabricObj) return;
        _createPreviewOverlay(rootNode, entry.fabricObj, theme);
      });
    }

    function _hidePreviewOverlays() {
      Object.keys(_previewOverlays).forEach(function(id) {
        var ov = _previewOverlays[id];
        if (ov.div && ov.div.parentNode) { ov.div.parentNode.removeChild(ov.div); }
      });
      _previewOverlays = {};
    }

    function _createPreviewOverlay(node, fabricObj, theme) {
      var div = document.createElement('div');
      div.style.cssText = 'position:absolute;z-index:85;pointer-events:none;overflow:hidden;';
      div.innerHTML = _designNodeToHtml(node, theme);

      var container = document.getElementById('iframe-overlay-container');
      if (container) { container.appendChild(div); }

      _previewOverlays[node.id] = { div: div, designNode: node };
      _syncPreviewOverlayPosition(node.id, fabricObj);
    }

    function _syncPreviewOverlayPosition(nodeId, fabricObj) {
      var ov = _previewOverlays[nodeId];
      if (!ov || !ov.div) return;
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      var left = fabricObj.left * zoom + vpt[4];
      var top = fabricObj.top * zoom + vpt[5];
      var width = fabricObj.width * fabricObj.scaleX * zoom;
      var height = fabricObj.height * fabricObj.scaleY * zoom;
      ov.div.style.left = left + 'px';
      ov.div.style.top = top + 'px';
      ov.div.style.width = width + 'px';
      ov.div.style.height = height + 'px';
      ov.div.style.transform = 'scale(1)';
    }

    function _syncAllPreviewOverlays() {
      Object.keys(_previewOverlays).forEach(function(id) {
        var entry = _nodeMap[id];
        if (entry && entry.fabricObj) { _syncPreviewOverlayPosition(id, entry.fabricObj); }
      });
    }

    function _hexToRgba(hex, alpha) {
      var r = parseInt(hex.slice(1, 3), 16);
      var g = parseInt(hex.slice(3, 5), 16);
      var b = parseInt(hex.slice(5, 7), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function _escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _designNodeToHtml(node, theme) {
      var style = _resolveNodeCss(node, theme);
      var html = '<div style="' + style + '">';

      // Text content
      if (node.text) {
        var typoStyle = _resolveTypoCss(node.typography, theme);
        html += '<span style="' + typoStyle + '">' + _escapeHtml(node.text) + '</span>';
      }

      // Assets
      if (node.assets) {
        node.assets.forEach(function(asset) {
          if (asset.src) {
            if (asset.type === 'video') {
              html += '<video src="' + asset.src + '" autoplay muted loop style="width:100%;object-fit:' + (asset.fit || 'cover') + ';"></video>';
            } else {
              html += '<img src="' + asset.src + '" alt="' + _escapeHtml(asset.alt || '') + '" style="width:100%;object-fit:' + (asset.fit || 'cover') + ';" />';
            }
          } else {
            html += '<div style="background:#e5e7eb;display:flex;align-items:center;justify-content:center;padding:8px;color:#6b7280;font-size:11px;border-radius:4px;min-height:40px;">' + _escapeHtml(asset.alt || asset.prompt || asset.type) + '</div>';
          }
        });
      }

      // Children
      if (node.children) {
        node.children.forEach(function(child) {
          html += _designNodeToHtml(child, theme);
        });
      }

      html += '</div>';
      return html;
    }

    function _resolveNodeCss(node, theme) {
      var parts = [];
      var l = node.layout || {};
      var s = node.style || {};

      // Layout
      parts.push('display:' + (l.display || 'flex'));
      if (l.display === 'flex') {
        parts.push('flex-direction:' + (l.direction || 'column'));
        if (l.wrap) parts.push('flex-wrap:wrap');
      }
      if (l.display === 'grid' && l.gridCols) {
        parts.push('grid-template-columns:repeat(' + l.gridCols + ',1fr)');
      }
      if (l.gap !== undefined) parts.push('gap:' + l.gap + 'px');
      if (l.padding !== undefined) {
        if (Array.isArray(l.padding)) {
          parts.push('padding:' + l.padding.map(function(p) { return p + 'px'; }).join(' '));
        } else {
          parts.push('padding:' + l.padding + 'px');
        }
      }
      var alignMap = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' };
      var justifyMap = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between', around: 'space-around' };
      if (l.align) parts.push('align-items:' + (alignMap[l.align] || l.align));
      if (l.justify) parts.push('justify-content:' + (justifyMap[l.justify] || l.justify));

      // Style
      if (s.background) parts.push('background-color:' + _resolveThemeToken(s.background, theme));
      if (s.radius !== undefined) parts.push('border-radius:' + s.radius + 'px');
      if (s.shadow) parts.push('box-shadow:' + _resolveThemeToken(s.shadow, theme));
      if (s.opacity !== undefined) parts.push('opacity:' + s.opacity);
      if (s.overflow) parts.push('overflow:' + s.overflow);
      if (s.border) parts.push('border:' + s.border.width + 'px ' + s.border.style + ' ' + _resolveThemeToken(s.border.color, theme));

      // Size — use 100% relative to parent
      parts.push('width:100%');
      parts.push('box-sizing:border-box');

      return parts.join(';');
    }

    function _resolveTypoCss(typo, theme) {
      if (!typo) return '';
      var parts = [];
      if (typo.family) parts.push('font-family:' + typo.family);
      else if (theme && theme.typography && theme.typography.fontFamily) parts.push('font-family:' + theme.typography.fontFamily);
      if (typo.size) parts.push('font-size:' + typo.size + 'px');
      if (typo.weight) parts.push('font-weight:' + typo.weight);
      if (typo.color) parts.push('color:' + _resolveThemeToken(typo.color, theme));
      if (typo.lineHeight) parts.push('line-height:' + typo.lineHeight);
      if (typo.align) parts.push('text-align:' + typo.align);
      return parts.join(';');
    }

    function _collectAssetsFromNodes(nodes) {
      nodes.forEach(function(node) {
        if (node.assets) {
          node.assets.forEach(function(asset) {
            if (!_designAssets.find(function(a) { return a.id === asset.id; })) {
              _designAssets.push(asset);
            }
          });
        }
        if (node.children) { _collectAssetsFromNodes(node.children); }
      });
    }

    function _resolveThemeToken(value, theme) {
      if (!value || !theme) return value;
      if (theme.colors && theme.colors[value]) return theme.colors[value];
      if (theme.shadows && theme.shadows[value]) return theme.shadows[value];
      return value;
    }

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

    // Touch/pinch state
    var _touchState = { active: false, lastDist: 0, lastCenter: null };

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

      canvas.isDrawingMode = false;
      canvas.selection = (tool === 'select');
      canvas.defaultCursor = (tool === 'pan') ? 'grab' : 'default';

      document.getElementById('status-tool').textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
    }

    // Color control
    document.getElementById('tool-color').addEventListener('input', function(e) {
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

      // Shift+click multi-select (Figma-style)
      if (opt.e && opt.e.shiftKey && opt.target && currentTool === 'select' && !opt.target._isFrameLabel) {
        var activeObj = canvas.getActiveObject();
        if (activeObj && activeObj !== opt.target) {
          if (activeObj.type === 'activeselection') {
            var selObjs = activeObj.getObjects();
            if (selObjs.indexOf(opt.target) >= 0) {
              activeObj.removeWithUpdate(opt.target);
            } else {
              activeObj.addWithUpdate(opt.target);
            }
            canvas.requestRenderAll();
          } else {
            var sel = new fabric.ActiveSelection([activeObj, opt.target], { canvas: canvas });
            canvas.setActiveObject(sel);
            canvas.requestRenderAll();
          }
          opt.e.preventDefault();
          return;
        }
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
        // F-13: object left/top are world (scene) coordinates, so the click
        // point must be in scene space too. getViewportPoint returns element
        // space, which is offset by pan/zoom — getScenePoint is the world point.
        var pointer = canvas.getScenePoint(opt.e);
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
        // F-13: report the cursor in scene/world coordinates (what object
        // positions use) rather than element/viewport space.
        var pointer = canvas.getScenePoint(opt.e);
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
      // Use aCoords for accurate world-space bounds
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      objects.forEach(function(obj) {
        var coords = obj.aCoords || obj.calcACoords();
        if (!coords) return;
        var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
        var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
        minX = Math.min(minX, Math.min.apply(null, xs));
        minY = Math.min(minY, Math.min.apply(null, ys));
        maxX = Math.max(maxX, Math.max.apply(null, xs));
        maxY = Math.max(maxY, Math.max.apply(null, ys));
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

    // Zoom/Pan with mouse wheel — Figma model:
    // Bare scroll = pan, Ctrl/Cmd+scroll = zoom, Shift+scroll = horizontal pan
    // Browsers set ctrlKey=true for trackpad pinch gestures, so pinch-to-zoom works automatically
    canvas.on('mouse:wheel', function(opt) {
      var e = opt.e;
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey || e.metaKey) {
        // ZOOM: Ctrl+scroll or pinch-to-zoom — instant (no animation) for responsiveness
        var zoom = canvas.getZoom();
        // Normalize: mouse wheel sends large deltaY (~100), trackpad pinch sends small (~1-5)
        var delta = e.deltaY;
        if (Math.abs(delta) > 10) delta = delta / 25; // normalize mouse wheel
        var newZoom = Math.max(0.1, Math.min(5, zoom * Math.pow(0.93, delta)));
        canvas.zoomToPoint(new fabric.Point(e.offsetX, e.offsetY), newZoom);
        updateZoomDisplay(newZoom);
        _debouncedSyncAllIframes();
      } else {
        // PAN: bare scroll
        if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; }
        var vpt = canvas.viewportTransform.slice();
        if (e.shiftKey) {
          vpt[4] -= e.deltaY; // Shift+scroll = horizontal pan
        } else {
          vpt[4] -= e.deltaX;
          vpt[5] -= e.deltaY;
        }
        canvas.setViewportTransform(vpt);
        updateZoomDisplay(canvas.getZoom());
        _debouncedSyncAllIframes();
      }
    });

    // Pinch-to-zoom (touch events for tablets/touch screens)
    canvasArea.addEventListener('touchstart', function(e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        var t1 = e.touches[0], t2 = e.touches[1];
        _touchState.active = true;
        _touchState.lastDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        _touchState.lastCenter = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
      }
    }, { passive: false });

    canvasArea.addEventListener('touchmove', function(e) {
      if (!_touchState.active || e.touches.length !== 2) return;
      e.preventDefault();
      var t1 = e.touches[0], t2 = e.touches[1];
      var dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      var center = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };

      // Zoom based on pinch distance change
      var zoomFactor = dist / _touchState.lastDist;
      var rect = canvasArea.getBoundingClientRect();
      var pointX = center.x - rect.left;
      var pointY = center.y - rect.top;
      var zoom = canvas.getZoom();
      var newZoom = Math.max(0.1, Math.min(5, zoom * zoomFactor));
      canvas.zoomToPoint(new fabric.Point(pointX, pointY), newZoom);

      // Pan based on center movement
      var dx = center.x - _touchState.lastCenter.x;
      var dy = center.y - _touchState.lastCenter.y;
      var vpt = canvas.viewportTransform.slice();
      vpt[4] += dx;
      vpt[5] += dy;
      canvas.setViewportTransform(vpt);

      _touchState.lastDist = dist;
      _touchState.lastCenter = center;
      updateZoomDisplay(canvas.getZoom());
      _debouncedSyncAllIframes();
    }, { passive: false });

    canvasArea.addEventListener('touchend', function(e) {
      if (e.touches.length < 2) { _touchState.active = false; }
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
    document.getElementById('btn-preview-toggle').addEventListener('click', _togglePreviewMode);
    // Zoom presets dropdown
    var zoomPresetMenu = document.getElementById('zoom-preset-menu');
    document.getElementById('zoom-level-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      zoomPresetMenu.classList.toggle('visible');
    });
    document.addEventListener('click', function() {
      zoomPresetMenu.classList.remove('visible');
    });
    zoomPresetMenu.addEventListener('click', function(e) {
      var item = e.target.closest('.zoom-preset-item');
      if (!item) return;
      e.stopPropagation();
      var val = item.getAttribute('data-zoom');
      if (val === 'fit') {
        zoomToFit();
      } else {
        var targetZoom = parseFloat(val);
        smoothZoomTo(targetZoom, canvasArea.clientWidth / 2, canvasArea.clientHeight / 2);
      }
      zoomPresetMenu.classList.remove('visible');
    });
    document.getElementById('status-zoom').addEventListener('click', zoomToFit);

    // ====================================================================
    // Screen list panel (L key toggle)
    // ====================================================================
    var screenListPanel = document.getElementById('screen-list-panel');
    var screenListBody = document.getElementById('screen-list-body');
    var screenListVisible = false;

    function toggleScreenList() {
      screenListVisible = !screenListVisible;
      screenListPanel.classList.toggle('visible', screenListVisible);
      if (screenListVisible) _refreshScreenList();
    }

    function _refreshScreenList() {
      screenListBody.innerHTML = '';
      var activeObj = canvas.getActiveObject();
      var items = canvas.getObjects().filter(function(obj) {
        if (obj._isFrameLabel || obj._contentText || obj._typeBadge) return false;
        if (obj._designNode && obj._designNode.parentId) return false;
        if (!obj.label && !obj.description && !obj.id) return false;
        return true;
      });
      if (items.length === 0) {
        screenListBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:11px;">No screens yet</div>';
        return;
      }
      items.forEach(function(obj) {
        var label = obj.label || obj.description || obj.id || 'Untitled';
        var item = document.createElement('div');
        item.className = 'screen-list-item' + (obj === activeObj ? ' selected' : '');
        var icon = (obj.id && obj.id.indexOf('frame-') === 0) ? '▢' : (obj.type === 'image' ? '⬜' : '◇');
        var iconSpan = document.createElement('span');
        iconSpan.className = 'screen-list-icon';
        iconSpan.textContent = icon;
        var labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        labelSpan.style.overflow = 'hidden';
        labelSpan.style.textOverflow = 'ellipsis';
        item.appendChild(iconSpan);
        item.appendChild(labelSpan);
        item.addEventListener('click', function() {
          canvas.setActiveObject(obj);
          _zoomToObject(obj);
          _refreshScreenList();
        });
        screenListBody.appendChild(item);
      });
    }

    document.getElementById('btn-close-screen-list').addEventListener('click', toggleScreenList);

    // Refresh screen list on selection/object changes
    canvas.on('selection:created', function() { if (screenListVisible) _refreshScreenList(); });
    canvas.on('selection:cleared', function() { if (screenListVisible) _refreshScreenList(); });
    canvas.on('object:added', function() { if (screenListVisible) _refreshScreenList(); });
    canvas.on('object:removed', function() { if (screenListVisible) _refreshScreenList(); });

    // ====================================================================
    // Undo / Redo
    // ====================================================================
    var customJsonProps = ['id', 'label', 'description', 'metadata', 'videoData', 'videoMimeType', 'isVideo', '_viewData'];

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

    // Shared restore helper using fabric v6's promise-based loadFromJSON (F-2):
    // v5's callback arg is treated as a per-object *reviver* in v6 (runs once
    // per revived object, and NEVER when the restored state has zero objects),
    // which left isUndoRedoing stuck true forever — permanently suppressing
    // autosave/history. The promise resolves exactly once after the whole load,
    // including the empty-canvas case, so the zero-object hang is fixed too.
    function _restoreHistoryState(stateJson) {
      isUndoRedoing = true;
      var parsed;
      try {
        parsed = JSON.parse(stateJson);
      } catch (e) {
        console.error('[Mysti Canvas] History parse failed:', e);
        isUndoRedoing = false;
        return;
      }
      canvas.loadFromJSON(parsed).then(function() {
        canvas.getObjects().forEach(function(obj) { obj.set(controlStyle); });
        canvas.renderAll();
        isUndoRedoing = false;
        updateUndoRedoButtons();
        updateObjectCount();
      }).catch(function(e) {
        console.error('[Mysti Canvas] History restore failed:', e);
        isUndoRedoing = false;
        updateUndoRedoButtons();
      });
    }

    function undo() {
      // F-12: the undo stack always has the *current* canvas as its top entry
      // (saveHistoryState pushes the post-change state). To undo we drop that
      // top entry onto the redo stack, then load the NEW top (the previous
      // state). This needs at least 2 entries (current + previous) so the
      // first undo after a single object add actually reverts.
      if (undoStack.length < 2) return;
      clearTimeout(historyTimer);
      // Exit any active text editing before undo
      var active = canvas.getActiveObject();
      if (active && active.isEditing) { active.exitEditing(); }
      canvas.discardActiveObject();
      var currentState = undoStack.pop();
      redoStack.push(currentState);
      var prevState = undoStack[undoStack.length - 1];
      _restoreHistoryState(prevState);
    }

    function redo() {
      if (redoStack.length === 0) return;
      clearTimeout(historyTimer);
      // Exit any active text editing before redo
      var active = canvas.getActiveObject();
      if (active && active.isEditing) { active.exitEditing(); }
      canvas.discardActiveObject();
      var nextState = redoStack.pop();
      // Keep the restored state as the new top of the undo stack so a
      // subsequent undo has both current + previous to work with.
      undoStack.push(nextState);
      _restoreHistoryState(nextState);
    }

    function updateUndoRedoButtons() {
      // F-12: undo requires both a current snapshot and a previous one on the
      // stack, so it's only enabled once there are >= 2 entries.
      document.getElementById('btn-undo').disabled = undoStack.length < 2;
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
    // Dot grid background (optimized with cached pattern tile)
    // ====================================================================
    var _gridPatternCache = null;
    var _gridPatternZoom = 0;

    function _getGridPattern(ctx, zoom) {
      var gridSize = 20;
      var dotRadius = 0.8;
      var scaledGrid = Math.round(gridSize * zoom);
      // Reuse cached pattern if zoom hasn't changed significantly
      if (_gridPatternCache && Math.abs(_gridPatternZoom - scaledGrid) < 1) {
        return _gridPatternCache;
      }
      if (scaledGrid < 3) return null; // too small to render
      var tile = document.createElement('canvas');
      tile.width = scaledGrid;
      tile.height = scaledGrid;
      var tctx = tile.getContext('2d');
      tctx.fillStyle = 'rgba(128,128,128,0.15)';
      tctx.beginPath();
      tctx.arc(0, 0, dotRadius, 0, Math.PI * 2);
      tctx.fill();
      _gridPatternCache = ctx.createPattern(tile, 'repeat');
      _gridPatternZoom = scaledGrid;
      return _gridPatternCache;
    }

    canvas.on('after:render', function() {
      var ctx = canvas.getContext();
      var vpt = canvas.viewportTransform;
      var zoom = canvas.getZoom();
      if (zoom < 0.15) return;
      var pattern = _getGridPattern(ctx, zoom);
      if (!pattern) return;
      ctx.save();
      // Offset pattern to align with world grid
      var offsetX = vpt[4] % (20 * zoom);
      var offsetY = vpt[5] % (20 * zoom);
      ctx.translate(offsetX, offsetY);
      ctx.fillStyle = pattern;
      ctx.fillRect(-offsetX, -offsetY, canvasArea.clientWidth, canvasArea.clientHeight);
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
      if (now - lastMinimapUpdate < 200) return;  // 5fps is enough for minimap
      lastMinimapUpdate = now;

      var mw = 150, mh = 100;
      minimapCtx.clearRect(0, 0, mw, mh);

      var objects = canvas.getObjects();
      if (!objects.length) {
        minimapViewport.style.display = 'none';
        return;
      }

      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;

      // Single pass: collect world bounds for all objects
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      var objBounds = [];
      objects.forEach(function(obj) {
        var b = obj.getBoundingRect();
        var wLeft = (b.left - vpt[4]) / zoom;
        var wTop = (b.top - vpt[5]) / zoom;
        var wW = b.width / zoom;
        var wH = b.height / zoom;
        objBounds.push({ wLeft: wLeft, wTop: wTop, wW: wW, wH: wH });
        minX = Math.min(minX, wLeft); minY = Math.min(minY, wTop);
        maxX = Math.max(maxX, wLeft + wW); maxY = Math.max(maxY, wTop + wH);
      });

      // Add padding
      var pad = 100;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      var worldW = Math.max(1, maxX - minX);
      var worldH = Math.max(1, maxY - minY);
      var scale = Math.min(mw / worldW, mh / worldH);

      // Draw objects from cached bounds (no second getBoundingRect pass)
      minimapCtx.fillStyle = 'rgba(128,160,255,0.4)';
      objBounds.forEach(function(ob) {
        minimapCtx.fillRect(
          (ob.wLeft - minX) * scale,
          (ob.wTop - minY) * scale,
          Math.max(2, ob.wW * scale),
          Math.max(2, ob.wH * scale)
        );
      });

      // Show viewport rect
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
        var ac = active.aCoords || active.calcACoords();
        if (ac) {
          var axs = [ac.tl.x, ac.tr.x, ac.bl.x, ac.br.x];
          var ays = [ac.tl.y, ac.tr.y, ac.bl.y, ac.br.y];
          var aw = Math.max.apply(null, axs) - Math.min.apply(null, axs);
          var ah = Math.max.apply(null, ays) - Math.min.apply(null, ays);
          el.textContent = ' | ' + Math.round(aw) + ' \u00d7 ' + Math.round(ah);
        }
      } else {
        el.textContent = '';
      }
    }
    canvas.on('selection:created', updateSelectionStatus);
    canvas.on('selection:updated', updateSelectionStatus);
    canvas.on('selection:cleared', updateSelectionStatus);
    // NOTE: object:moving/scaling for updateSelectionStatus moved to consolidated handler

    // ====================================================================
    // Zoom-to-object (reusable animated navigation)
    // ====================================================================
    function _zoomToObject(obj) {
      // Use aCoords for accurate world-space bounds
      var coords = obj.aCoords || obj.calcACoords();
      if (!coords) return;
      var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
      var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
      var wLeft = Math.min.apply(null, xs);
      var wTop = Math.min.apply(null, ys);
      var wW = Math.max.apply(null, xs) - wLeft;
      var wH = Math.max.apply(null, ys) - wTop;
      var pad = 80;
      var newZoom = Math.min(
        (canvasArea.clientWidth - pad * 2) / wW,
        (canvasArea.clientHeight - pad * 2) / wH,
        5
      );
      newZoom = Math.max(0.1, newZoom);
      var cx = wLeft + wW / 2, cy = wTop + wH / 2;
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
        _debouncedSyncAllIframes();
        if (t < 1) zoomAnimationFrame = requestAnimationFrame(animateFocus);
        else zoomAnimationFrame = null;
      })(performance.now());
    }

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
      _zoomToObject(opt.target);
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

      // Arrow key nudge — move selected objects (1px, or 10px with Shift)
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.key) >= 0) {
        var activeObjs = canvas.getActiveObjects();
        if (activeObjs.length > 0) {
          var step = e.shiftKey ? 10 : 1;
          var dx = 0, dy = 0;
          if (e.key === 'ArrowLeft') dx = -step;
          if (e.key === 'ArrowRight') dx = step;
          if (e.key === 'ArrowUp') dy = -step;
          if (e.key === 'ArrowDown') dy = step;
          activeObjs.forEach(function(obj) {
            obj.set({ left: obj.left + dx, top: obj.top + dy });
            obj.setCoords();
            _repositionFrameLabel(obj);
          });
          canvas.renderAll();
          _debouncedSyncAllIframes();
          autoSave();
          e.preventDefault();
          return;
        }
      }

      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 'p':
          if (e.shiftKey) { _togglePreviewMode(); }
          break;
        case 't': setTool('text'); break;
        case 'i': setTool('image'); break;
        case 'l': toggleScreenList(); break;
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
    var actionsPanelToggle = document.getElementById('actions-panel-toggle');
    var actionIntegrate = document.getElementById('action-integrate');
    var placeholderOverlay = document.getElementById('tab-placeholder-overlay');
    var placeholderIcon = document.getElementById('tab-placeholder-icon');
    var placeholderLabel = document.getElementById('tab-placeholder-label');
    var placeholderBtn = document.getElementById('tab-placeholder-btn');
    var _placeholderAction = null; // 'generate' | 'svg' | 'code'
    var _actionsPanelOpen = true;

    // Toggle actions panel collapse/expand
    actionsPanelToggle.addEventListener('click', function() {
      _actionsPanelOpen = !_actionsPanelOpen;
      if (_actionsPanelOpen) {
        actionsPanel.classList.remove('collapsed');
        actionsPanelToggle.classList.add('panel-open');
        actionsPanelToggle.innerHTML = '&#9654;'; // right arrow
      } else {
        actionsPanel.classList.add('collapsed');
        actionsPanelToggle.classList.remove('panel-open');
        actionsPanelToggle.innerHTML = '&#9664;'; // left arrow
      }
    });

    canvas.on('selection:created', showSelectionControls);
    canvas.on('selection:updated', showSelectionControls);
    canvas.on('selection:cleared', hideSelectionControls);

    function hideSelectionControls() {
      // Panel stays visible — only hide context-dependent elements
      placeholderOverlay.classList.remove('visible');
      _placeholderAction = null;
      actionIntegrate.classList.remove('visible');
      document.getElementById('element-actions-sep').style.display = 'none';
      document.getElementById('action-edit-element').style.display = 'none';
      document.getElementById('action-edit-layout').style.display = 'none';
    }

    function showSelectionControls() {
      var active = canvas.getActiveObject();
      if (!active) { hideSelectionControls(); return; }

      // Update integrate button visibility
      var vd = _getViewData(active);
      if (_activeGlobalTab === 'code' && vd && vd.codeFiles && vd.codeFiles.length) {
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

      if (_activeGlobalTab === 'design') {
        if (!vd || !vd.imageDataUrl) {
          needsPlaceholder = true;
          icon = '&#9998;';
          label = 'No image generated';
          action = 'generate';
        }
      } else if (_activeGlobalTab === 'assets') {
        if (!vd || !vd.svgMarkup) {
          needsPlaceholder = true;
          icon = 'SVG';
          label = 'No SVG generated';
          action = 'svg';
        }
      } else if (_activeGlobalTab === 'code') {
        if (!vd || !vd.codeFiles || !vd.codeFiles.length) {
          needsPlaceholder = true;
          icon = '&lt;/&gt;';
          label = 'No component generated';
          action = 'code';
        }
      }
      // Frames tab: no placeholder — always shows grid

      if (needsPlaceholder) {
        placeholderIcon.innerHTML = icon;
        placeholderLabel.textContent = label;
        _placeholderAction = action;
        _placeholderTargetObj = obj;
        _repositionPlaceholder();
      } else {
        placeholderOverlay.classList.remove('visible');
        _placeholderAction = null;
        _placeholderTargetObj = null;
      }
    }

    // Dedicated lightweight reposition — called on every pan/zoom/move/scale
    var _placeholderTargetObj = null;
    function _repositionPlaceholder() {
      if (!_placeholderTargetObj || !_placeholderAction) return;
      var obj = _placeholderTargetObj;
      // Use aCoords (world-space) + manual viewport conversion — same as iframe overlays
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      var coords = obj.aCoords || obj.calcACoords();
      if (!coords) { placeholderOverlay.classList.remove('visible'); return; }
      var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
      var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
      var worldLeft = Math.min.apply(null, xs);
      var worldTop = Math.min.apply(null, ys);
      var worldRight = Math.max.apply(null, xs);
      var worldBottom = Math.max.apply(null, ys);
      var screenLeft = worldLeft * zoom + vpt[4];
      var screenTop = worldTop * zoom + vpt[5];
      var screenW = (worldRight - worldLeft) * zoom;
      var screenH = (worldBottom - worldTop) * zoom;

      if (screenW > 40 && screenH > 40) {
        placeholderOverlay.style.left = screenLeft + 'px';
        placeholderOverlay.style.top = screenTop + 'px';
        placeholderOverlay.style.width = screenW + 'px';
        placeholderOverlay.style.height = screenH + 'px';
        placeholderOverlay.classList.add('visible');
      } else {
        placeholderOverlay.classList.remove('visible');
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
        vscodeApi.postMessage({ type: 'canvasUnifiedPrompt', payload: { text: '/image ' + (desc || 'Generate image for this frame'), canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: selectedIds } });
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

    // NOTE: object:moving/scaling for showSelectionControls moved to consolidated handler

    document.getElementById('btn-response-close').addEventListener('click', function() {
      document.getElementById('prompt-response-panel').classList.remove('visible');
    });

    // ====================================================================
    // Background generation job tracker
    // ====================================================================
    var _genJobCounter = 0;
    var _genJobs = {}; // jobId -> { targetObject, targetBounds, overlayEl, type }

    function _worldBoundsFromObj(obj) {
      var coords = obj.aCoords || obj.calcACoords();
      if (!coords) return null;
      var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
      var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
      var l = Math.min.apply(null, xs), t = Math.min.apply(null, ys);
      return { left: l, top: t, width: Math.max.apply(null, xs) - l, height: Math.max.apply(null, ys) - t };
    }

    function genJobCreate(type) {
      var jobId = 'gen-' + (++_genJobCounter);
      var active = canvas.getActiveObject();
      var bounds = active ? _worldBoundsFromObj(active) : null;
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
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      // Check object still on canvas
      if (!canvas.getObjects().includes(obj)) {
        // Object was removed — fall back to stored world-space bounds
        if (job.targetBounds) {
          job.overlayEl.style.left = (job.targetBounds.left * zoom + vpt[4]) + 'px';
          job.overlayEl.style.top = (job.targetBounds.top * zoom + vpt[5]) + 'px';
          job.overlayEl.style.width = (job.targetBounds.width * zoom) + 'px';
          job.overlayEl.style.height = (job.targetBounds.height * zoom) + 'px';
        }
        return;
      }
      // Use aCoords (world-space) + viewport conversion — same as iframe overlays
      var coords = obj.aCoords || obj.calcACoords();
      if (!coords) return;
      var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
      var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
      var wl = Math.min.apply(null, xs), wt = Math.min.apply(null, ys);
      var wr = Math.max.apply(null, xs), wb = Math.max.apply(null, ys);
      job.overlayEl.style.left = (wl * zoom + vpt[4]) + 'px';
      job.overlayEl.style.top = (wt * zoom + vpt[5]) + 'px';
      job.overlayEl.style.width = ((wr - wl) * zoom) + 'px';
      job.overlayEl.style.height = ((wb - wt) * zoom) + 'px';
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

    // F-4: tear down EVERY tracked generation job and clear all pending
    // singletons. Used on canvas_error so no spinner overlay can leak — even
    // for action types that completion handlers forget (the structural F-4 bug
    // is properly fixed by jobIds in Phase 1; this is the interim safety net).
    function genJobClearAll() {
      for (var id in _genJobs) {
        if (Object.prototype.hasOwnProperty.call(_genJobs, id)) {
          var job = _genJobs[id];
          if (job && job.overlayEl) {
            job.overlayEl.style.opacity = '0';
            (function(ovl) {
              setTimeout(function() { if (ovl && ovl.parentNode) ovl.parentNode.removeChild(ovl); }, 200);
            })(job.overlayEl);
          }
        }
      }
      _genJobs = {};
      _pendingGenerateJob = null;
      _pendingReimagineJob = null;
      _pendingVideoJob = null;
      _pendingSvgJob = null;
      _pendingCodeJob = null;
      _pendingLayoutJob = null;
      _pendingMiscJob = null;
      _pendingBatchJobs = {};
    }

    function genJobGetBounds(jobId) {
      var job = _genJobs[jobId];
      if (!job) return null;
      // Get live world-space bounds from target object if still on canvas
      if (job.targetObject && canvas.getObjects().includes(job.targetObject)) {
        return _worldBoundsFromObj(job.targetObject);
      }
      return job.targetBounds;
    }

    // Reposition all active loader overlays on pan/zoom/move
    function _genJobRepositionAll() {
      for (var id in _genJobs) { _genJobPositionLoader(_genJobs[id]); }
    }
    // NOTE: object:moving/scaling for _genJobRepositionAll moved to consolidated handler

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
    // F-4: slot for action types without a dedicated completion handler
    // (design-dna, render, edit-element, edit-layout, stitch-edit,
    // stitch-variants, stitch-html). Tracked so their spinner overlay is torn
    // down by genJobClearAll() on canvas_error instead of leaking forever.
    var _pendingMiscJob = null;
    var _lastLayoutFrameMap = null;
    var _pendingBatchFrameMap = null;
    var _pendingBatchJobs = {};

    // Create a gen job for a specific canvas object (not the active selection)
    function genJobCreateForObject(fabricObj, type) {
      var jobId = 'gen-' + (++_genJobCounter);
      var bounds = _worldBoundsFromObj(fabricObj);
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
      var active = canvas.getActiveObject();

      // Smart edit: detect context
      if (active && active._stitchScreenRef) {
        // Stitch screen selected — use /edit for Stitch editing
        showInlineInput('Describe the edit:', 'e.g. make the header darker, add a CTA button', function(instruction) {
          var job = genJobCreate('stitch-edit');
          _pendingLayoutJob = job;
          showPromptStatus('Editing screen...', 5);
          vscodeApi.postMessage({
            type: 'canvasUnifiedPrompt',
            payload: {
              text: '/edit ' + instruction,
              canvasId: canvasSessionId,
              snapshot: buildSnapshot(),
              selectedObjectIds: getSelectedIds(),
              stitchScreenRef: active._stitchScreenRef
            }
          });
        });
      } else if (active && active._designNode && _designSpec) {
        // Design node selected — generate a variation with Stitch
        var job = genJobCreate('design');
        _pendingLayoutJob = job;
        showPromptStatus('Generating design variation...', 5);
        var nodeDesc = active._designNode.name || active._designNode.description || 'this design';
        vscodeApi.postMessage({
          type: 'canvasUnifiedPrompt',
          payload: {
            text: '/design Create a variation of ' + nodeDesc + ' with different layout, spacing, and visual hierarchy while keeping the same purpose',
            canvasId: canvasSessionId,
            snapshot: buildSnapshot(),
            selectedObjectIds: getSelectedIds(),
            designTheme: _designSpec.theme
          }
        });
      } else if (!active && _designSpec) {
        // No selection + design spec — generate a theme variation
        var themeJob = genJobCreate('theme');
        _pendingLayoutJob = themeJob;
        showPromptStatus('Generating theme variation...', 5);
        vscodeApi.postMessage({
          type: 'canvasUnifiedPrompt',
          payload: {
            text: '/theme Create a variation of the current theme with different colors and typography while maintaining contrast and accessibility',
            canvasId: canvasSessionId,
            snapshot: buildSnapshot(),
            designTheme: _designSpec.theme
          }
        });
      } else {
        // Fallback: reimagine image variants
        var reimagJob = genJobCreate('reimagine');
        _pendingReimagineJob = reimagJob;
        reimagineSourceBounds = reimagJob.targetBounds;
        reimagineVariantIndex = 0;
        showPromptStatus('Generating image variants...', 10);
        vscodeApi.postMessage({
          type: 'canvasReimagine',
          payload: { canvasId: canvasSessionId, prompt: '', snapshot: buildSnapshot(), selectedObjectIds: getSelectedIds(), action: 'reimagine' }
        });
      }
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
        payload: { text: '/image ' + prompt, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() }
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

    // ── Design section actions ──
    document.getElementById('action-generate-design').addEventListener('click', function() {
      showInlineInput('Describe the design to generate:', 'e.g. a SaaS pricing page with 3 tiers', function(desc) {
        var job = genJobCreate('design');
        _pendingLayoutJob = job;
        showPromptStatus('Generating design...', 5);
        vscodeApi.postMessage({
          type: 'canvasUnifiedPrompt',
          payload: { text: '/design ' + desc, canvasId: canvasSessionId, snapshot: buildSnapshot(), selectedObjectIds: getSelectedIds(), designTheme: _designSpec ? _designSpec.theme : null }
        });
      });
    });

    document.getElementById('action-theme').addEventListener('click', function() {
      showInlineInput('Describe the theme:', 'e.g. dark mode, neon accents, cyberpunk', function(desc) {
        var job = genJobCreate('theme');
        _pendingLayoutJob = job;
        showPromptStatus('Generating theme...', 5);
        vscodeApi.postMessage({
          type: 'canvasUnifiedPrompt',
          payload: { text: '/theme ' + desc, canvasId: canvasSessionId, snapshot: buildSnapshot(), designTheme: _designSpec ? _designSpec.theme : null }
        });
      });
    });

    document.getElementById('action-preview').addEventListener('click', function() {
      _togglePreviewMode();
    });

    // ── Assets section actions ──
    document.getElementById('action-gen-assets').addEventListener('click', function() {
      if (!_designAssets || !_designAssets.length) {
        showPromptStatusMessage('No assets to generate. Use /mockup first.', 'error');
        setTimeout(hidePromptStatus, 3000);
        return;
      }
      var unresolved = _designAssets.filter(function(a) { return !a.src && a.prompt; });
      if (unresolved.length === 0) {
        showPromptStatusMessage('All assets already generated!', 'success');
        setTimeout(hidePromptStatus, 3000);
        return;
      }
      showPromptStatus('Generating ' + unresolved.length + ' assets...', 5);
      vscodeApi.postMessage({
        type: 'canvasGenerateAllAssets',
        payload: { canvasId: canvasSessionId, assets: unresolved }
      });
    });

    // ── Code section actions ──
    document.getElementById('action-code').addEventListener('click', function() {
      var active = canvas.getActiveObject();
      if (!active) return;
      var desc = active.description || active.label || '';
      var job = genJobCreate('code');
      _pendingCodeJob = job;
      showPromptStatus('Generating code...', 10);
      var snapshot = buildSnapshot();
      var msgPayload = { text: '/code ' + desc, canvasId: canvasSessionId, snapshot: snapshot, selectedObjectIds: getSelectedIds() };
      // Always send full design context if available
      if (_designSpec) {
        msgPayload.designTheme = _designSpec.theme;
        msgPayload.designAssets = _designAssets;
      }
      // If this object has a design node, send it for deterministic code gen
      if (active._designNode) {
        msgPayload.designNode = active._designNode;
      }
      vscodeApi.postMessage({ type: 'canvasUnifiedPrompt', payload: msgPayload });
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
      { cmd: '/design', desc: 'Generate a UI design with Stitch AI', example: '/design a SaaS pricing page with 3 tiers' },
      { cmd: '/edit', desc: 'Edit selected Stitch screen with AI', example: '/edit make the header darker' },
      { cmd: '/variants', desc: 'Generate variants of selected Stitch screen', example: '/variants explore different layouts' },
      { cmd: '/website', desc: 'Generate multi-page website with Stitch', example: '/website SaaS landing page with pricing and docs' },
      { cmd: '/image', desc: 'Generate AI image from description', example: '/image a modern hero illustration' },
      { cmd: '/video', desc: 'Generate AI video from description', example: '/video a looping gradient background' },
      { cmd: '/svg', desc: 'Convert selected image to clean SVG', example: '/svg' },
      { cmd: '/code', desc: 'Generate component code from design', example: '/code React card with dark mode' },
      { cmd: '/theme', desc: 'Generate or change design theme', example: '/theme dark mode, neon accents, cyberpunk' },
      { cmd: '/render', desc: 'Capture page screenshot (URL or auto-detect)', example: '/render http://localhost:3000' },
      { cmd: '/html', desc: 'Export Stitch screen HTML', example: '/html' },
      { cmd: '/design-dna', desc: 'Extract design DNA from Stitch screen', example: '/design-dna' },
    ];

    function sendUnifiedPrompt() {
      var text = unifiedInput.value.trim();
      if (!text) return;
      promptBarSuggestions.classList.remove('visible');

      // F-4: action type names MUST match CanvasManager.parseUnifiedPrompt's
      // vocabulary so completion handlers fire and overlays don't leak. The
      // canonical set the parser returns is:
      //   render, design-dna, page (from /design), generate (from /image),
      //   video, website, svg, code, edit-element, edit-layout, theme,
      //   stitch-edit, stitch-variants, stitch-html, prompt.
      // Note: /design maps to 'page' (NOT 'design') to mirror the parser.
      var actionType = 'prompt';
      if (text.startsWith('/design-dna')) { actionType = 'design-dna'; }
      else if (text.startsWith('/design')) { actionType = 'page'; }
      else if (text.startsWith('/image')) { actionType = 'generate'; }
      else if (text.startsWith('/video')) { actionType = 'video'; }
      else if (text.startsWith('/website')) { actionType = 'website'; }
      else if (text.startsWith('/svg')) { actionType = 'svg'; }
      else if (text.startsWith('/code')) { actionType = 'code'; }
      else if (text.startsWith('/theme')) { actionType = 'theme'; }
      else if (text.startsWith('/render')) { actionType = 'render'; }
      else if (text.startsWith('/edit-element')) { actionType = 'edit-element'; }
      else if (text.startsWith('/edit-layout')) { actionType = 'edit-layout'; }
      else if (text.startsWith('/edit')) { actionType = 'stitch-edit'; }
      else if (text.startsWith('/variants')) { actionType = 'stitch-variants'; }
      else if (text.startsWith('/html')) { actionType = 'stitch-html'; }

      // F-3: the slash commands that operate on a Stitch screen (/edit,
      // /variants, /html, /design-dna) require the screen's stitchScreenRef.
      // The prompt bar never sent it, so the extension always errored. Attach
      // the active object's ref (null if none — the extension also has a
      // snapshot.selectedRegion fallback).
      var _activeForRef = canvas.getActiveObject();
      var stitchScreenRef = (_activeForRef && _activeForRef._stitchScreenRef) || null;

      // Create a background job for generation actions (not plain prompts).
      // F-4: EVERY non-prompt action is assigned a tracked slot so its overlay
      // is reliably cleared (by its completion handler or by genJobClearAll on
      // canvas_error).
      if (actionType !== 'prompt') {
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
        else if (actionType === 'theme' || actionType === 'page' || actionType === 'section'
            || actionType === 'component' || actionType === 'website') { _pendingLayoutJob = job; }
        else { _pendingMiscJob = job; } // design-dna, render, edit-element, edit-layout, stitch-*
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
          designTheme: _designSpec ? _designSpec.theme : null,
          stitchScreenRef: stitchScreenRef,
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
        // Context-aware placeholder
        var vd = _getViewData(sel);
        if (vd && vd.stitchScreenRef) {
          unifiedInput.placeholder = 'Edit this screen... (e.g. make the header darker)';
        } else if (vd && vd.imageDataUrl) {
          unifiedInput.placeholder = 'Describe changes... (e.g. /reimagine with a blue theme)';
        } else if (sel.type === 'rect' || (sel.label && !vd)) {
          unifiedInput.placeholder = 'Describe what to generate... (e.g. a login page)';
        } else {
          unifiedInput.placeholder = 'Describe a screen to generate, or type / for commands';
        }
      } else {
        unifiedInput.placeholder = 'Describe a screen to generate, or type / for commands';
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
      // F-1: fabric v6 toDataURL crops in screen/viewport space and keeps the
      // current zoom/pan. For a true full-scene capture, temporarily reset the
      // viewportTransform to identity so the whole scene (not just the visible
      // viewport) is rasterized, then restore the user's view afterwards.
      var fullCaptureVpt = canvas.viewportTransform.slice();
      var fullBase64;
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      try {
        fullBase64 = canvas.toDataURL({ format: 'png' }).replace(/^data:image\\/png;base64,/, '');
      } finally {
        canvas.setViewportTransform(fullCaptureVpt);
      }

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
          // F-1: the crop bounds above are in WORLD space (from aCoords), but
          // fabric v6 toDataURL interprets left/top/width/height in
          // SCREEN/VIEWPORT space (it subtracts left/top from the viewport
          // translation and keeps the current zoom). Convert world->screen:
          //   left_screen = left_world * zoom + vpt[4]
          //   top_screen  = top_world  * zoom + vpt[5]
          //   width_screen  = width_world  * zoom
          //   height_screen = height_world * zoom
          // and pass multiplier: 1/zoom so the output is rasterized at the
          // crop's native (world) resolution regardless of zoom level.
          var cropZoom = canvas.getZoom();
          var cropVpt = canvas.viewportTransform;
          var screenLeft = cropLeft * cropZoom + cropVpt[4];
          var screenTop = cropTop * cropZoom + cropVpt[5];
          var screenW = cropW * cropZoom;
          var screenH = cropH * cropZoom;
          var regionDataUrl = canvas.toDataURL({
            format: 'png',
            left: screenLeft,
            top: screenTop,
            width: screenW,
            height: screenH,
            multiplier: cropZoom > 0 ? 1 / cropZoom : 1,
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
            // F-18: fabric resizes via scaleX/scaleY, not width/height. Use the
            // SCALED dimensions so the image fills the frame's VISIBLE size
            // after the user has resized it with the handles.
            frameW = targetObject.getScaledWidth();
            frameH = targetObject.getScaledHeight();
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
              // F-18: use scaled dimensions so the video poster matches the
              // frame's visible size after handle-resizing.
              vFrameW = targetObject.getScaledWidth();
              vFrameH = targetObject.getScaledHeight();
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
      // Use aCoords (world-space) + viewport conversion — same as iframe overlays
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      var coords = activeVideoTarget.aCoords || activeVideoTarget.calcACoords();
      if (!coords) return;
      var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
      var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
      var wl = Math.min.apply(null, xs), wt = Math.min.apply(null, ys);
      var wr = Math.max.apply(null, xs), wb = Math.max.apply(null, ys);
      activeVideoOverlay.style.left = (wl * zoom + vpt[4]) + 'px';
      activeVideoOverlay.style.top = (wt * zoom + vpt[5]) + 'px';
      activeVideoOverlay.style.width = ((wr - wl) * zoom) + 'px';
      activeVideoOverlay.style.height = ((wb - wt) * zoom) + 'px';
    }

    // Close video overlay on pan/zoom/selection change
    canvas.on('selection:cleared', closeVideoOverlay);
    // NOTE: video overlay position sync moved to _debouncedSyncAllIframes

    canvas.on('mouse:dblclick', function(opt) {
      var target = opt.target;
      if (!target || !target.get('isVideo')) return;

      var videoData = target.get('videoData');
      var videoMimeType = target.get('videoMimeType') || 'video/mp4';
      if (!videoData) return;

      closeVideoOverlay();

      // Use aCoords (world-space) + viewport conversion for positioning
      var _vZoom = canvas.getZoom();
      var _vVpt = canvas.viewportTransform;
      var _vCoords = target.aCoords || target.calcACoords();
      var _vXs = [_vCoords.tl.x, _vCoords.tr.x, _vCoords.bl.x, _vCoords.br.x];
      var _vYs = [_vCoords.tl.y, _vCoords.tr.y, _vCoords.bl.y, _vCoords.br.y];
      var _vLeft = Math.min.apply(null, _vXs) * _vZoom + _vVpt[4];
      var _vTop = Math.min.apply(null, _vYs) * _vZoom + _vVpt[5];
      var _vW = (Math.max.apply(null, _vXs) - Math.min.apply(null, _vXs)) * _vZoom;
      var _vH = (Math.max.apply(null, _vYs) - Math.min.apply(null, _vYs)) * _vZoom;

      var overlay = document.createElement('div');
      overlay.id = 'video-playback-overlay';
      overlay.style.cssText = 'position:absolute;left:' + _vLeft + 'px;top:' + _vTop + 'px;width:' + _vW + 'px;height:' + _vH + 'px;z-index:100;background:#000;border-radius:4px;overflow:hidden;';

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
    var _currentPropsData = null; // { props, componentName, framework, sourceObjectId }

    document.getElementById('props-panel-close').addEventListener('click', function() {
      propsPanel.classList.remove('visible');
      _currentPropsData = null;
    });

    function showPropsPanel(props, componentName, framework, sourceObjectId) {
      if (!props || !props.length) return;
      // F-7: remember which object owns these props so Apply can resend the
      // real current SVG markup + component source (not an empty SVG).
      _currentPropsData = { props: props, componentName: componentName, framework: framework, sourceObjectId: sourceObjectId || null };
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

      // F-7: send the REAL current SVG markup and component source so the
      // model edits the actual design instead of regenerating from an empty
      // SVG. Pull them from the owning object's view data.
      var propsSvgMarkup = '';
      var propsCurrentSource = '';
      if (_currentPropsData.sourceObjectId) {
        var propsObj = _findObjectById(_currentPropsData.sourceObjectId);
        var propsVd = propsObj ? _getViewData(propsObj) : null;
        if (propsVd) {
          propsSvgMarkup = propsVd.svgMarkup || '';
          if (propsVd.codeFiles && propsVd.codeFiles.length) {
            // Prefer the component file; fall back to the first file.
            var compFile = null;
            for (var pfi = 0; pfi < propsVd.codeFiles.length; pfi++) {
              if (propsVd.codeFiles[pfi].fileType === 'component') { compFile = propsVd.codeFiles[pfi]; break; }
            }
            propsCurrentSource = (compFile || propsVd.codeFiles[0]).content || '';
          }
        }
      }

      showPromptStatus('Updating code with new properties...', 20);
      vscodeApi.postMessage({
        type: 'canvasUpdateProps',
        payload: {
          canvasId: canvasSessionId,
          modifiedProps: modifiedProps,
          componentName: _currentPropsData.componentName,
          framework: _currentPropsData.framework,
          svgMarkup: propsSvgMarkup,
          currentSource: propsCurrentSource,
        }
      });
    });

    // ====================================================================
    // Global Tab Bar — Frames | Design | Assets | Code
    // ====================================================================
    var _activeGlobalTab = 'design'; // 'frames' | 'design' | 'assets' | 'code'
    var tabDesign = document.getElementById('tab-design');
    var tabAssets = document.getElementById('tab-assets');
    var tabCode = document.getElementById('tab-code');
    var assetsPanel = document.getElementById('assets-panel');
    var assetsGrid = document.getElementById('assets-grid');
    var _assetFilter = 'all'; // current assets tab filter
    var tabThemes = document.getElementById('tab-themes');
    var themesPanel = document.getElementById('themes-panel');
    var themesGrid = document.getElementById('themes-grid');
    var themeEditor = document.getElementById('theme-editor');
    var themeEditorName = document.getElementById('theme-editor-name');
    var themeEditorBody = document.getElementById('theme-editor-body');

    // Theme library state
    var _themeLibrary = [];       // Array of { id, name, theme, createdAt }
    var _activeThemeId = null;    // ID of currently applied theme
    var _editingThemeId = null;   // ID of theme being edited (null = not editing)

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
      tabDesign.classList.toggle('active', _activeGlobalTab === 'design');
      tabAssets.classList.toggle('active', _activeGlobalTab === 'assets');
      tabCode.classList.toggle('active', _activeGlobalTab === 'code');
      tabThemes.classList.toggle('active', _activeGlobalTab === 'themes');
      // Show/hide overlay panels
      assetsPanel.classList.toggle('visible', _activeGlobalTab === 'assets');
      themesPanel.classList.toggle('visible', _activeGlobalTab === 'themes');
    }

    function _switchGlobalTab(tab) {
      if (_activeGlobalTab === tab) return;
      console.log('[Mysti Canvas] Global tab switch:', _activeGlobalTab, '->', tab);
      _activeGlobalTab = tab;
      _updateGlobalTabs();
      _applyGlobalTabView();
      if (tab === 'assets') { _buildAssetsGrid(); }
      if (tab === 'themes') { _buildThemesGrid(); }
      showSelectionControls(); // update placeholder + integrate visibility
    }

    function _applyGlobalTabView() {
      // Apply the correct visual representation to all objects based on the active tab
      var objects = canvas.getObjects();

      if (_activeGlobalTab === 'code') {
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
          if (_activeGlobalTab === 'design') {
            // Design tab: show image view (wireframes / generated images)
            if (vd.activeView !== 'image' && vd.imageDataUrl) {
              _showImageView(obj, vd);
            }
          }
          // Frames/Assets tabs: don't change object view, just show grid overlay
        });
        canvas.renderAll();
      }
    }

    // ====================================================================
    // Frames Grid — thumbnail view of all objects
    // ====================================================================

    // ====================================================================
    // Assets Grid — unified asset library
    // ====================================================================
    var _designAssets = []; // Array of { id, type, prompt, src, alt, fit, linkedNodeId? }

    function _buildAssetsGrid() {
      assetsGrid.innerHTML = '';
      var filtered = _assetFilter === 'all'
        ? _designAssets
        : _designAssets.filter(function(a) { return a.type === _assetFilter; });

      if (filtered.length === 0) {
        assetsGrid.innerHTML = '<div style="color:var(--vscode-descriptionForeground);text-align:center;padding:40px;grid-column:1/-1;">No assets yet. Use /mockup to generate a design with assets, or /generate to create images.</div>';
        return;
      }

      filtered.forEach(function(asset) {
        var card = document.createElement('div');
        card.className = 'frame-thumb asset-card';

        var thumb;
        if (asset.src && (asset.type === 'image' || asset.type === 'svg' || asset.type === 'icon')) {
          thumb = document.createElement('img');
          thumb.className = 'frame-thumb-img';
          thumb.src = asset.src;
          thumb.alt = asset.alt || asset.prompt || '';
        } else if (asset.src && asset.type === 'video') {
          thumb = document.createElement('video');
          thumb.className = 'frame-thumb-img';
          thumb.src = asset.src;
          thumb.muted = true;
          thumb.addEventListener('mouseenter', function() { try { thumb.play(); } catch(e) {} });
          thumb.addEventListener('mouseleave', function() { try { thumb.pause(); thumb.currentTime = 0; } catch(e) {} });
        } else {
          thumb = document.createElement('div');
          thumb.className = 'frame-thumb-img';
          thumb.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#333;color:#888;font-size:11px;';
          thumb.textContent = asset.type === 'video' ? 'Generating...' : (asset.prompt || asset.type);
        }

        var badge = document.createElement('span');
        badge.className = 'asset-type-badge';
        badge.textContent = asset.type;

        var label = document.createElement('div');
        label.className = 'frame-thumb-label';
        label.textContent = asset.alt || asset.id;

        var promptPreview = document.createElement('div');
        promptPreview.className = 'asset-prompt-preview';
        promptPreview.textContent = asset.prompt || '';

        card.appendChild(thumb);
        card.appendChild(badge);
        card.appendChild(label);
        if (asset.prompt) { card.appendChild(promptPreview); }

        card.addEventListener('click', function() {
          // Select this asset — show regenerate/reimagine in actions
          _selectedAssetId = asset.id;
          _buildAssetsGrid(); // re-render to show selection
        });
        if (_selectedAssetId === asset.id) {
          card.style.borderColor = 'var(--vscode-button-background)';
        }

        assetsGrid.appendChild(card);
      });
    }

    var _selectedAssetId = null;

    // Asset filter buttons
    var filterBtns = document.querySelectorAll('.asset-filter-btn');
    filterBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        _assetFilter = btn.getAttribute('data-filter');
        filterBtns.forEach(function(b) { b.classList.toggle('active', b === btn); });
        _buildAssetsGrid();
      });
    });

    // ====================================================================
    // Theme Library — save, switch, edit, manage themes
    // ====================================================================

    function _deepCloneTheme(theme) {
      return JSON.parse(JSON.stringify(theme));
    }

    function _initThemeLibrary() {
      if (_designSpec && _designSpec.themeLibrary && _designSpec.themeLibrary.length > 0) {
        _themeLibrary = _designSpec.themeLibrary;
      } else if (_designSpec && _designSpec.theme) {
        // Seed with current theme as "Default"
        var defaultTheme = {
          id: 'default-theme',
          name: 'Default',
          theme: _deepCloneTheme(_designSpec.theme),
          createdAt: Date.now()
        };
        _themeLibrary = [defaultTheme];
        _designSpec.themeLibrary = _themeLibrary;
      }
      // Find the active theme (match current _designSpec.theme)
      if (_themeLibrary.length > 0 && !_activeThemeId) {
        _activeThemeId = _themeLibrary[0].id;
      }
    }

    function _syncThemeLibraryToSpec() {
      if (_designSpec) {
        _designSpec.themeLibrary = _themeLibrary;
        _designSpec.updatedAt = Date.now();
      }
    }

    function _saveThemeToLibrary(name, theme) {
      var saved = {
        id: 'theme-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
        name: name || 'Untitled Theme',
        theme: _deepCloneTheme(theme),
        createdAt: Date.now()
      };
      _themeLibrary.push(saved);
      _syncThemeLibraryToSpec();
      if (_activeGlobalTab === 'themes') { _buildThemesGrid(); }
      return saved;
    }

    function _applyThemeFromLibrary(themeId) {
      var entry = null;
      for (var i = 0; i < _themeLibrary.length; i++) {
        if (_themeLibrary[i].id === themeId) { entry = _themeLibrary[i]; break; }
      }
      if (!entry || !_designSpec) return;
      _designSpec.theme = _deepCloneTheme(entry.theme);
      _designSpec.updatedAt = Date.now();
      _activeThemeId = themeId;
      // Re-render canvas with new theme
      if (_designSpec.rootNodes && _designSpec.rootNodes.length > 0) {
        _renderDesignTree(_designSpec.rootNodes, _designSpec.theme);
      }
      if (_activeGlobalTab === 'themes') { _buildThemesGrid(); }
      showPromptStatusMessage('Theme "' + entry.name + '" applied', 'success');
      setTimeout(hidePromptStatus, 2000);
    }

    function _deleteThemeFromLibrary(themeId) {
      if (themeId === 'default-theme') return; // Can't delete default
      _themeLibrary = _themeLibrary.filter(function(t) { return t.id !== themeId; });
      _syncThemeLibraryToSpec();
      // If deleted active, switch to first available
      if (_activeThemeId === themeId) {
        _activeThemeId = _themeLibrary.length > 0 ? _themeLibrary[0].id : null;
        if (_activeThemeId) { _applyThemeFromLibrary(_activeThemeId); }
      }
      if (_activeGlobalTab === 'themes') { _buildThemesGrid(); }
    }

    function _duplicateThemeInLibrary(themeId) {
      var entry = null;
      for (var i = 0; i < _themeLibrary.length; i++) {
        if (_themeLibrary[i].id === themeId) { entry = _themeLibrary[i]; break; }
      }
      if (!entry) return;
      _saveThemeToLibrary(entry.name + ' (Copy)', entry.theme);
    }

    function _buildThemesGrid() {
      themesGrid.innerHTML = '';
      if (_themeLibrary.length === 0) {
        themesGrid.innerHTML = '<div style="padding:24px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px;">No themes yet. Generate a mockup first or click "+ Blank" to create one.</div>';
        return;
      }
      _themeLibrary.forEach(function(saved) {
        var card = document.createElement('div');
        card.className = 'theme-card' + (saved.id === _activeThemeId ? ' active' : '');

        var colors = saved.theme.colors || {};
        var swatchColors = [colors.primary, colors.secondary, colors.accent, colors.background, colors.surface, colors.text].filter(Boolean);

        var swatchesHtml = '<div class="theme-swatches">';
        swatchColors.forEach(function(c) {
          swatchesHtml += '<div class="theme-swatch" style="background:' + c + ';"></div>';
        });
        swatchesHtml += '</div>';

        var dateStr = new Date(saved.createdAt).toLocaleDateString();
        var isDefault = saved.id === 'default-theme';
        var fontInfo = saved.theme.typography ? saved.theme.typography.fontFamily : '';

        card.innerHTML = '<div class="theme-card-header">' +
          '<span class="theme-card-name">' + saved.name + '</span>' +
          '<div class="theme-card-actions">' +
            '<button class="theme-action-btn" data-action="edit" data-id="' + saved.id + '" title="Edit">&#9998;</button>' +
            '<button class="theme-action-btn" data-action="duplicate" data-id="' + saved.id + '" title="Duplicate">&#10697;</button>' +
            (isDefault ? '' : '<button class="theme-action-btn" data-action="delete" data-id="' + saved.id + '" title="Delete">&#128465;</button>') +
          '</div>' +
        '</div>' +
        swatchesHtml +
        '<div class="theme-card-meta">' +
          (fontInfo ? fontInfo + ' &middot; ' : '') + dateStr +
          (saved.id === _activeThemeId ? ' &middot; <strong>Active</strong>' : '') +
        '</div>';

        // Click card to apply
        card.addEventListener('click', function(e) {
          if (e.target.closest('.theme-action-btn')) return; // ignore action button clicks
          _applyThemeFromLibrary(saved.id);
        });

        themesGrid.appendChild(card);
      });

      // Wire action buttons
      themesGrid.querySelectorAll('.theme-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var action = btn.getAttribute('data-action');
          var id = btn.getAttribute('data-id');
          if (action === 'edit') { _openThemeEditor(id); }
          else if (action === 'duplicate') { _duplicateThemeInLibrary(id); }
          else if (action === 'delete') { _deleteThemeFromLibrary(id); }
        });
      });
    }

    function _openThemeEditor(themeId) {
      var entry = null;
      for (var i = 0; i < _themeLibrary.length; i++) {
        if (_themeLibrary[i].id === themeId) { entry = _themeLibrary[i]; break; }
      }
      if (!entry) return;
      _editingThemeId = themeId;
      themeEditorName.value = entry.name;

      var html = '';
      // Colors section
      html += '<div class="theme-section-title">Colors</div>';
      var colorKeys = Object.keys(entry.theme.colors || {});
      colorKeys.forEach(function(key) {
        var val = entry.theme.colors[key];
        // Normalize short labels
        var label = key.replace(/([A-Z])/g, ' $1').replace(/^./, function(s) { return s.toUpperCase(); });
        html += '<div class="theme-color-row">' +
          '<label>' + label + '</label>' +
          '<input type="color" data-color-key="' + key + '" value="' + (val || '#000000') + '" />' +
          '<input type="text" class="theme-editor-input" data-color-text="' + key + '" value="' + (val || '#000000') + '" style="width:80px;" />' +
        '</div>';
      });

      // Typography section
      if (entry.theme.typography) {
        html += '<div class="theme-section-title">Typography</div>';
        html += '<div class="theme-color-row">' +
          '<label>Font Family</label>' +
          '<input type="text" class="theme-editor-input" id="theme-edit-fontFamily" value="' + (entry.theme.typography.fontFamily || '') + '" style="width:160px;" />' +
        '</div>';
        if (entry.theme.typography.headingFamily) {
          html += '<div class="theme-color-row">' +
            '<label>Heading Family</label>' +
            '<input type="text" class="theme-editor-input" id="theme-edit-headingFamily" value="' + (entry.theme.typography.headingFamily || '') + '" style="width:160px;" />' +
          '</div>';
        }
        html += '<div class="theme-color-row">' +
          '<label>Line Height</label>' +
          '<input type="number" class="theme-editor-input" id="theme-edit-lineHeight" value="' + (entry.theme.typography.lineHeight || 1.5) + '" step="0.1" style="width:70px;" />' +
        '</div>';
      }

      // Border radii section
      if (entry.theme.radii) {
        html += '<div class="theme-section-title">Border Radius</div>';
        ['sm', 'md', 'lg', 'full'].forEach(function(size) {
          if (entry.theme.radii[size] !== undefined) {
            html += '<div class="theme-color-row">' +
              '<label>' + size.toUpperCase() + '</label>' +
              '<input type="number" class="theme-editor-input" data-radius-key="' + size + '" value="' + entry.theme.radii[size] + '" style="width:70px;" />' +
            '</div>';
          }
        });
      }

      themeEditorBody.innerHTML = html;

      // Sync color picker ↔ text input
      themeEditorBody.querySelectorAll('input[type="color"]').forEach(function(picker) {
        var key = picker.getAttribute('data-color-key');
        var textInput = themeEditorBody.querySelector('input[data-color-text="' + key + '"]');
        picker.addEventListener('input', function() { if (textInput) textInput.value = picker.value; });
        if (textInput) {
          textInput.addEventListener('input', function() {
            if (/^#[0-9a-fA-F]{6}$/.test(textInput.value)) { picker.value = textInput.value; }
          });
        }
      });

      themeEditor.style.display = 'flex';
      themesGrid.style.display = 'none';
    }

    function _closeThemeEditor() {
      themeEditor.style.display = 'none';
      themesGrid.style.display = '';
      _editingThemeId = null;
    }

    function _saveThemeEdits() {
      if (!_editingThemeId) return;
      var entry = null;
      for (var i = 0; i < _themeLibrary.length; i++) {
        if (_themeLibrary[i].id === _editingThemeId) { entry = _themeLibrary[i]; break; }
      }
      if (!entry) return;

      // Update name
      entry.name = themeEditorName.value || entry.name;

      // Update colors
      themeEditorBody.querySelectorAll('input[data-color-text]').forEach(function(input) {
        var key = input.getAttribute('data-color-text');
        entry.theme.colors[key] = input.value;
      });

      // Update typography
      var fontInput = document.getElementById('theme-edit-fontFamily');
      if (fontInput) { entry.theme.typography.fontFamily = fontInput.value; }
      var headingInput = document.getElementById('theme-edit-headingFamily');
      if (headingInput) { entry.theme.typography.headingFamily = headingInput.value; }
      var lhInput = document.getElementById('theme-edit-lineHeight');
      if (lhInput) { entry.theme.typography.lineHeight = parseFloat(lhInput.value) || 1.5; }

      // Update radii
      themeEditorBody.querySelectorAll('input[data-radius-key]').forEach(function(input) {
        var key = input.getAttribute('data-radius-key');
        entry.theme.radii[key] = parseInt(input.value) || 0;
      });

      _syncThemeLibraryToSpec();

      // If this is the active theme, re-apply to canvas
      if (_activeThemeId === _editingThemeId && _designSpec) {
        _designSpec.theme = _deepCloneTheme(entry.theme);
        if (_designSpec.rootNodes && _designSpec.rootNodes.length > 0) {
          _renderDesignTree(_designSpec.rootNodes, _designSpec.theme);
        }
      }

      _closeThemeEditor();
      _buildThemesGrid();
      showPromptStatusMessage('Theme "' + entry.name + '" saved', 'success');
      setTimeout(hidePromptStatus, 2000);
    }

    // Theme panel button listeners
    document.getElementById('btn-theme-generate').addEventListener('click', function() {
      // Reuse the existing /theme action flow
      var desc = prompt('Describe the theme you want to generate:');
      if (!desc) return;
      vscode.postMessage({
        type: 'canvasAction',
        payload: { text: '/theme ' + desc, canvasId: canvasSessionId, snapshot: buildSnapshot(), designTheme: _designSpec ? _designSpec.theme : null }
      });
    });

    document.getElementById('btn-theme-new').addEventListener('click', function() {
      // Create a blank theme with defaults and open editor
      var blankTheme = {
        colors: { primary: '#3B82F6', secondary: '#6366F1', accent: '#F59E0B', background: '#FFFFFF', surface: '#F8FAFC', text: '#1E293B', textSecondary: '#64748B', border: '#E2E8F0', error: '#EF4444', success: '#22C55E' },
        typography: { fontFamily: 'Inter, system-ui, sans-serif', scale: [12, 14, 16, 20, 24, 32, 48], lineHeight: 1.5, weights: { regular: 400, medium: 500, bold: 700 } },
        spacing: { unit: 4, scale: [0, 4, 8, 12, 16, 24, 32, 48, 64] },
        radii: { sm: 4, md: 8, lg: 16, full: 9999 },
        shadows: { sm: '0 1px 2px rgba(0,0,0,0.05)', md: '0 4px 6px rgba(0,0,0,0.1)', lg: '0 10px 15px rgba(0,0,0,0.1)' }
      };
      var saved = _saveThemeToLibrary('Custom Theme', blankTheme);
      _openThemeEditor(saved.id);
    });

    document.getElementById('btn-theme-editor-close').addEventListener('click', function() {
      _closeThemeEditor();
    });

    document.getElementById('btn-theme-editor-save').addEventListener('click', function() {
      _saveThemeEdits();
    });

    // ====================================================================
    // Frame Labels — rendered as canvas overlay (always grouped with frame)
    // ====================================================================

    // Label bounds cache for click detection (screen-space)
    var _frameLabelBounds = []; // Array of { obj, left, top, width, height }

    // Render labels in after:render — they're painted directly on the canvas context,
    // so they always appear at the correct position (no separate objects to sync)
    canvas.on('after:render', function() {
      var ctx = canvas.getContext();
      var zoom = canvas.getZoom();
      var vpt = canvas.viewportTransform;
      _frameLabelBounds = [];

      canvas.getObjects().forEach(function(obj) {
        if (obj._isFrameLabel || obj._isContentText || obj._isTypeBadge) return;
        var label = obj.label || obj.description || '';
        if (!label) return;

        var coords = obj.aCoords || obj.calcACoords();
        if (!coords) return;

        // World-space bounds
        var xs = [coords.tl.x, coords.tr.x, coords.bl.x, coords.br.x];
        var ys = [coords.tl.y, coords.tr.y, coords.bl.y, coords.br.y];
        var wLeft = Math.min.apply(null, xs);
        var wTop = Math.min.apply(null, ys);
        var wW = Math.max.apply(null, xs) - wLeft;

        // Screen-space position
        var sLeft = wLeft * zoom + vpt[4];
        var sTop = wTop * zoom + vpt[5];
        var sW = wW * zoom;

        // Font size scales with zoom but stays readable
        var baseFontSize = Math.min(13, Math.max(9, wW / 18));
        var fontSize = baseFontSize * zoom;
        // Clamp rendered font size so labels stay readable when zoomed out
        if (fontSize < 8) return; // too small to show
        if (fontSize > 18) fontSize = 18;

        var labelY = sTop - fontSize - 3 * zoom;

        ctx.save();
        ctx.font = fontSize + 'px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = 'rgba(180,180,180,0.6)';
        ctx.textBaseline = 'top';

        // Truncate label if wider than frame
        var textWidth = ctx.measureText(label).width;
        var displayLabel = label;
        if (textWidth > sW) {
          while (displayLabel.length > 1 && ctx.measureText(displayLabel + '…').width > sW) {
            displayLabel = displayLabel.slice(0, -1);
          }
          displayLabel += '…';
          textWidth = ctx.measureText(displayLabel).width;
        }

        ctx.fillText(displayLabel, sLeft, labelY);
        ctx.restore();

        // Cache bounds for click detection
        _frameLabelBounds.push({
          obj: obj,
          left: sLeft,
          top: labelY,
          width: textWidth,
          height: fontSize,
        });
      });
    });

    // Stub _repositionFrameLabel — labels are now rendered in after:render,
    // but other code (content text, type badge, asset placeholders) still uses this
    function _repositionFrameLabel(obj) {
      if (obj._contentText) {
        var objW = (obj.width || 100) * (obj.scaleX || 1);
        obj._contentText.set({ left: obj.left + 8, top: obj.top + 16, width: objW - 16 });
        obj._contentText.setCoords();
      }
      if (obj._typeBadge) {
        var objW2 = (obj.width || 100) * (obj.scaleX || 1);
        obj._typeBadge.set({ left: obj.left + objW2 - 4, top: obj.top + 2 });
        obj._typeBadge.setCoords();
      }
      if (obj._assetPlaceholders && obj._assetPlaceholders.length) {
        var objW3 = (obj.width || 100) * (obj.scaleX || 1);
        var assetY = obj.top + (obj._contentText ? 40 : 20);
        for (var i = 0; i < obj._assetPlaceholders.length; i += 2) {
          var phRect = obj._assetPlaceholders[i];
          var phText = obj._assetPlaceholders[i + 1];
          var phW = objW3 - 16;
          var phH = phRect.height;
          phRect.set({ left: obj.left + 8, top: assetY, width: phW });
          phRect.setCoords();
          if (phText) {
            phText.set({ left: obj.left + 8 + phW / 2, top: assetY + phH / 2 });
            phText.setCoords();
          }
          assetY += phH + 8;
        }
      }
    }

    // Clean up associated objects on removal (content text, badge, placeholders, iframes)
    canvas.on('object:removed', function(e) {
      if (e.target && e.target._contentText) { canvas.remove(e.target._contentText); }
      if (e.target && e.target._typeBadge) { canvas.remove(e.target._typeBadge); }
      if (e.target && e.target._assetPlaceholders) {
        e.target._assetPlaceholders.forEach(function(p) { canvas.remove(p); });
      }
      if (e.target && e.target.id) { _destroyComponentIframe(e.target.id); }
    });

    // Click frame label → select parent object and zoom to it
    canvas.on('mouse:down', function(opt) {
      if (opt.target) return; // clicking an object, not empty space/label
      var e = opt.e;
      var rect = canvasArea.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      for (var i = 0; i < _frameLabelBounds.length; i++) {
        var lb = _frameLabelBounds[i];
        if (mx >= lb.left && mx <= lb.left + lb.width && my >= lb.top && my <= lb.top + lb.height) {
          canvas.setActiveObject(lb.obj);
          canvas.renderAll();
          _zoomToObject(lb.obj);
          opt.e.preventDefault();
          return;
        }
      }
    });

    // Track initial positions for delta calculation
    canvas.on('selection:created', function(e) {
      var obj = canvas.getActiveObject();
      if (obj) { obj._lastLeft = obj.left; obj._lastTop = obj.top; }
    });

    // ====================================================================
    // Consolidated object:moving / object:scaling handlers (perf optimization)
    // ====================================================================
    var _selCtrlThrottleTime = 0;
    function _throttledShowSelectionControls() {
      var now = performance.now();
      if (now - _selCtrlThrottleTime < 50) return;
      _selCtrlThrottleTime = now;
      showSelectionControls();
    }

    canvas.on('object:moving', function(e) {
      var target = e.target;
      updateSelectionStatus();
      _repositionFrameLabel(target);
      _syncIframePosition(target);
      if (target._designNode && target._lastLeft !== undefined) {
        var dx = target.left - target._lastLeft;
        var dy = target.top - target._lastTop;
        _syncChildPositions(target._designNode.id, dx, dy);
      }
      target._lastLeft = target.left;
      target._lastTop = target.top;
      _genJobRepositionAll();
      _throttledShowSelectionControls();
    });

    canvas.on('object:scaling', function(e) {
      var target = e.target;
      updateSelectionStatus();
      _repositionFrameLabel(target);
      _syncIframePosition(target);
      _genJobRepositionAll();
      _throttledShowSelectionControls();
    });

    // ====================================================================
    // Live Component iframes — overlay system
    // ====================================================================
    var _iframeOverlays = {}; // objectId -> { wrapper, iframe, objectRef }
    var _iframeContainer = document.getElementById('iframe-overlay-container');
    var _iframeSyncRaf = null;

    // F-6: bridge runs in a sandboxed iframe with NO allow-same-origin (opaque
    // origin). Communication uses a MessageChannel: the parent posts a private
    // port via the iframe window on load; the bridge replies/receives over that
    // port. Falls back to window.parent.postMessage until the port arrives.
    // The old same-origin DOM-rewrite "reload" path is removed — the parent
    // now recreates the iframe via srcdoc (no same-origin access needed).
    function _buildStandaloneHtmlWithBridge(code, componentName, framework, runtime) {
      var baseHtml = _buildStandaloneHtml(code, componentName, framework, runtime);
      // Inject bridge script before </body>
      var bridgeScript = '<script>'
        + '(function(){'
        + 'var selectedEl=null;'
        + 'var _port=null;'
        + 'function _send(msg){if(_port){_port.postMessage(msg);}else{try{window.parent.postMessage(msg,"*");}catch(ex){}}}'
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
        + '_send({type:"mysti-element-selected",payload:{'
        + 'selectorPath:buildSel(selectedEl),'
        + 'tagName:selectedEl.tagName.toLowerCase(),'
        + 'className:selectedEl.className||"",'
        + 'id:selectedEl.id||"",'
        + 'textContent:(selectedEl.childNodes.length===1&&selectedEl.childNodes[0].nodeType===3)?selectedEl.textContent:"",'
        + 'innerHTML:(selectedEl.innerHTML||"").substring(0,1000),'
        + 'computedStyles:extractStyles(cs),'
        + 'boundingRect:{left:0,top:0,width:selectedEl.offsetWidth,height:selectedEl.offsetHeight}'
        + '}});},true);'
        + 'function _handle(d){'
        + 'if(!d||!d.type)return;'
        + 'if(d.type==="mysti-apply-style"){'
        + 'var t=selectedEl;if(d.payload.selectorPath){try{t=document.querySelector(d.payload.selectorPath)||selectedEl;}catch(ex){}}if(t){var p=d.payload.property;if(p.indexOf("-")>=0){t.style.setProperty(p,d.payload.value);}else{t.style[p]=d.payload.value;}}}'
        + 'if(d.type==="mysti-apply-text"){'
        + 'var t2=selectedEl;if(d.payload.selectorPath){try{t2=document.querySelector(d.payload.selectorPath)||selectedEl;}catch(ex){}}if(t2)t2.textContent=d.payload.text;}'
        + 'if(d.type==="mysti-get-dom-tree"){'
        + '_send({type:"mysti-dom-tree",payload:{html:document.body.innerHTML.substring(0,5000)}});}'
        + '}'
        // Receive the private MessageChannel port from the parent, then route
        // all subsequent messages over it. Window-level listener stays as a
        // fallback for parents that have not yet posted a port.
        + 'window.addEventListener("message",function(e){'
        + 'if(e.data==="mysti-port"&&e.ports&&e.ports[0]){_port=e.ports[0];_port.onmessage=function(ev){_handle(ev.data);};return;}'
        + '_handle(e.data);'
        + '});'
        + '})();'
        + '<\\/script>';
      return baseHtml.replace('</body>', bridgeScript + '</body>');
    }

    // F-6: establish a private MessageChannel between the parent and a freshly
    // created sandboxed iframe. Called on the iframe's 'load' event so the
    // bridge's window listener is ready. The parent keeps port1; the iframe
    // receives port2 and routes its bridge traffic over it.
    function _wireIframePort(objId) {
      var overlay = _iframeOverlays[objId];
      if (!overlay || !overlay.iframe || !overlay.iframe.contentWindow) return;
      try {
        var channel = new MessageChannel();
        overlay.port = channel.port1;
        channel.port1.onmessage = function(ev) { _handleIframeBridgeMessage(objId, ev.data); };
        overlay.iframe.contentWindow.postMessage('mysti-port', '*', [channel.port2]);
      } catch (e) {
        console.log('[Mysti Canvas] Failed to wire iframe port:', e);
      }
    }

    function _createStitchIframe(obj, htmlContent, nodeWidth, nodeHeight) {
      if (!obj.id || _iframeOverlays[obj.id]) return;

      // Wrap raw HTML to ensure it renders at the intended design dimensions.
      // F-6: inject a restrictive inner CSP (opaque-origin sandbox).
      var stitchCspMeta = '<meta http-equiv="Content-Security-Policy" content="' + _SANDBOX_INNER_CSP + '">';
      var wrappedHtml = htmlContent;
      if (wrappedHtml.indexOf('<html') === -1) {
        wrappedHtml = '<!DOCTYPE html><html><head><meta charset="utf-8">' + stitchCspMeta
          + '<meta name="viewport" content="width=' + nodeWidth + '">'
          + '<style>*{margin:0;padding:0;box-sizing:border-box;}body{overflow:hidden;}</style>'
          + '</head><body>' + htmlContent + '</body></html>';
      }

      var wrapper = document.createElement('div');
      wrapper.className = 'stitch-iframe-wrapper';
      var iframe = document.createElement('iframe');
      // F-6: NO allow-same-origin — opaque origin can't reach the parent/vscodeApi.
      iframe.setAttribute('sandbox', 'allow-scripts');
      var objId = obj.id;
      iframe.addEventListener('load', function() { _wireIframePort(objId); });
      // Render at full design resolution — CSS transform scales to fit wrapper
      iframe.style.width = nodeWidth + 'px';
      iframe.style.height = nodeHeight + 'px';
      iframe.style.transformOrigin = '0 0';
      // F-6: srcdoc instead of Blob URL (Blob inherits the webview origin).
      iframe.setAttribute('srcdoc', wrappedHtml);
      wrapper.appendChild(iframe);
      _iframeContainer.appendChild(wrapper);

      _iframeOverlays[obj.id] = {
        wrapper: wrapper, iframe: iframe, objectRef: obj, port: null,
        designWidth: nodeWidth, designHeight: nodeHeight
      };
      _syncIframePosition(obj);
      console.log('[Mysti Canvas] Created Stitch iframe for object:', obj.id);
    }

    function _syncStitchIframeScale(objId) {
      var overlay = _iframeOverlays[objId];
      if (!overlay || !overlay.designWidth) return;
      var wrapperW = parseFloat(overlay.wrapper.style.width) || overlay.designWidth;
      var scaleX = wrapperW / overlay.designWidth;
      overlay.iframe.style.transform = 'scale(' + scaleX + ')';
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

      var framework = vd.framework || 'html';
      var needsRuntime = framework === 'react';

      // Create the wrapper/iframe immediately so position sync works; populate
      // srcdoc once the (cached) sandbox runtime resolves. F-6: NO
      // allow-same-origin; srcdoc instead of Blob URL.
      var wrapper = document.createElement('div');
      wrapper.className = 'component-iframe-wrapper';
      var iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      var objId = obj.id;
      iframe.addEventListener('load', function() { _wireIframePort(objId); });
      wrapper.appendChild(iframe);
      _iframeContainer.appendChild(wrapper);

      _iframeOverlays[obj.id] = { wrapper: wrapper, iframe: iframe, objectRef: obj, port: null };
      vd.liveIframeActive = true;
      _syncIframePosition(obj);

      var build = function(runtime) {
        // Bail if the overlay was destroyed before the runtime loaded.
        if (!_iframeOverlays[objId] || _iframeOverlays[objId].iframe !== iframe) return;
        var html = _buildStandaloneHtmlWithBridge(componentFile.content, vd.componentName || '', framework, runtime);
        vd.componentHtml = html;
        iframe.setAttribute('srcdoc', html);
      };
      if (needsRuntime) {
        _loadSandboxRuntime().then(build).catch(function() { build(null); });
      } else {
        build(null);
      }
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
      // Scale Stitch iframes to match wrapper size
      if (overlay.designWidth) {
        var scaleX = screenW / overlay.designWidth;
        overlay.iframe.style.transform = 'scale(' + scaleX + ')';
      }
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
        _genJobRepositionAll();
        if (_previewMode) { _syncAllPreviewOverlays(); }
        if (typeof updateVideoOverlayPosition === 'function') { updateVideoOverlayPosition(); }
        // Reposition placeholder overlay during pan/zoom (lightweight — no visibility recalc)
        _repositionPlaceholder();
        _iframeSyncRaf = null;
      });
    }

    function _destroyComponentIframe(objId) {
      var overlay = _iframeOverlays[objId];
      if (!overlay) return;
      // F-6: srcdoc-based iframes carry no Blob URL to revoke; close the
      // MessageChannel port instead.
      if (overlay.port) { try { overlay.port.close(); } catch (e) {} overlay.port = null; }
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
      var needsRuntime = framework === 'react';
      // F-6: reset srcdoc instead of the old same-origin rewrite/blob path.
      // Setting srcdoc reloads the iframe (firing 'load' → re-wiring a fresh
      // port). Close the stale port first.
      if (overlay.port) { try { overlay.port.close(); } catch (e) {} overlay.port = null; }
      var apply = function(runtime) {
        if (!_iframeOverlays[objId] || _iframeOverlays[objId] !== overlay) return;
        var newHtml = _buildStandaloneHtmlWithBridge(newCode, componentName, framework, runtime);
        overlay.iframe.setAttribute('srcdoc', newHtml);
        var obj = overlay.objectRef;
        if (obj && obj._viewData) { obj._viewData.componentHtml = newHtml; }
        console.log('[Mysti Canvas] Reloaded iframe for object:', objId);
      };
      if (needsRuntime) {
        _loadSandboxRuntime().then(apply).catch(function() { apply(null); });
      } else {
        apply(null);
      }
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

    // F-6: send a message TO an iframe bridge — prefer the private port, fall
    // back to window.postMessage (used before the port handshake completes).
    function _sendToIframeBridge(objId, msg) {
      var overlay = _iframeOverlays[objId];
      if (!overlay) return;
      if (overlay.port) {
        try { overlay.port.postMessage(msg); return; } catch (e) {}
      }
      if (overlay.iframe && overlay.iframe.contentWindow) {
        try { overlay.iframe.contentWindow.postMessage(msg, '*'); } catch (e) {}
      }
    }

    // F-6: unified handler for bridge messages, regardless of transport
    // (MessageChannel port or window-message fallback). objId is resolved by
    // the caller (port closure binds it; the window fallback matches source).
    function _handleIframeBridgeMessage(objId, data) {
      if (!data || typeof data.type !== 'string' || data.type.indexOf('mysti-') !== 0) return;
      if (!objId) return;

      if (data.type === 'mysti-element-selected') {
        _selectedElement = {
          objectId: objId,
          selectorPath: data.payload.selectorPath,
          tagName: data.payload.tagName,
          className: data.payload.className,
          id: data.payload.id,
          textContent: data.payload.textContent,
          innerHTML: data.payload.innerHTML,
          computedStyles: data.payload.computedStyles,
          boundingRect: data.payload.boundingRect,
          domSnapshot: null,
        };
        showElementInspector(_selectedElement);
        _updateElementActionButtons(true);
        console.log('[Mysti Canvas] Element selected:', _selectedElement.tagName, _selectedElement.selectorPath);
        // Request DOM tree for AI context
        _sendToIframeBridge(objId, { type: 'mysti-get-dom-tree' });
      }

      if (data.type === 'mysti-dom-tree') {
        if (_selectedElement) {
          _selectedElement.domSnapshot = data.payload.html;
        }
      }
    }

    // Window-message fallback: only fires before the per-iframe port is wired.
    // Identify the source iframe by its contentWindow (window-reference
    // identity still works without same-origin).
    window.addEventListener('message', function(event) {
      if (!event.data || typeof event.data.type !== 'string' || event.data.type.indexOf('mysti-') !== 0) return;
      var objectId = null;
      for (var id in _iframeOverlays) {
        if (_iframeOverlays[id].iframe && _iframeOverlays[id].iframe.contentWindow === event.source) {
          objectId = id; break;
        }
      }
      if (!objectId) return;
      _handleIframeBridgeMessage(objectId, event.data);
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
      // F-6: route through the MessageChannel bridge (port or window fallback).
      _sendToIframeBridge(objectId, {
        type: 'mysti-apply-style',
        payload: { selectorPath: selectorPath, property: cssProp, value: value }
      });
    }

    function _applyLiveEdit(objectId, selectorPath, cssProp, textValue) {
      if (textValue === undefined || textValue === null) return;
      _sendToIframeBridge(objectId, {
        type: 'mysti-apply-text',
        payload: { selectorPath: selectorPath, text: textValue }
      });
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
      if (_activeGlobalTab === 'code') {
        _createComponentIframe(obj, vd);
        obj.set('opacity', 0.05);
        canvas.renderAll();
        vd.activeView = 'component';
        console.log('[Mysti Canvas] Live component preview created for:', obj.id);
      }

      // Also send to extension for static screenshot fallback. F-6: inline the
      // bundled runtime so the produced HTML is self-contained (no unpkg).
      var _postRenderComponent = function(runtime) {
        var html = _buildStandaloneHtml(componentFile.content, componentName, framework, runtime);
        vscodeApi.postMessage({
          type: 'canvasRenderComponent',
          payload: {
            html: html,
            objectId: obj.id,
            componentName: componentName,
            framework: framework
          }
        });
      };
      if ((framework || 'react') === 'react') {
        _loadSandboxRuntime().then(_postRenderComponent).catch(function() { _postRenderComponent(null); });
      } else {
        _postRenderComponent(null);
      }
    }

    // F-6: build standalone page with the bundled React/Babel runtime inlined
    // as <script> text (no unpkg, no external src). The inner sandboxed
    // document carries its own permissive CSP — safe because, without
    // allow-same-origin, this opaque-origin frame cannot reach the parent
    // webview, vscodeApi, or workspace. 'runtime' is the cached bundle text
    // ({react, reactDom, babel}); for 'html'/'vue' it is not needed.
    var _SANDBOX_INNER_CSP = "default-src 'none'; "
      + "script-src 'unsafe-inline' 'unsafe-eval'; "
      + "style-src 'unsafe-inline'; "
      + "img-src data: blob: https:; "
      + "font-src data: https:; "
      + "connect-src 'none';";
    function _buildStandaloneHtml(code, componentName, framework, runtime) {
      var cspMeta = '<meta http-equiv="Content-Security-Policy" content="' + _SANDBOX_INNER_CSP + '">';
      if (framework === 'html') {
        return '<!DOCTYPE html><html><head><meta charset="utf-8">' + cspMeta + '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#fff;}</style></head><body>' + code + '</body></html>';
      }

      if (framework === 'react') {
        // Strip import/export to make it work inline
        var inlineCode = code
          .replace(/^import\\s+.*$/gm, '')
          .replace(/^export\\s+default\\s+/gm, 'var _Component = ')
          .replace(/^export\\s+/gm, 'var ');
        var reactJs = runtime && runtime.react ? runtime.react : '';
        var reactDomJs = runtime && runtime.reactDom ? runtime.reactDom : '';
        var babelJs = runtime && runtime.babel ? runtime.babel : '';
        return '<!DOCTYPE html><html><head><meta charset="utf-8">' + cspMeta
          + '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#fff;}</style>'
          + '<script>' + reactJs + '<\\/script>'
          + '<script>' + reactDomJs + '<\\/script>'
          + '<script>' + babelJs + '<\\/script>'
          + '</head><body><div id="root"></div>'
          + '<script type="text/babel">'
          + inlineCode
          + '\\nvar _Root = typeof _Component !== "undefined" ? _Component : typeof ' + componentName + ' !== "undefined" ? ' + componentName + ' : function() { return React.createElement("div", null, "Component not found"); };'
          + '\\nReactDOM.createRoot(document.getElementById("root")).render(React.createElement(_Root));'
          + '<\\/script></body></html>';
      }

      // Vue fallback — simpler approach
      return '<!DOCTYPE html><html><head><meta charset="utf-8">' + cspMeta + '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#fff;}</style></head><body><pre>' + code.replace(/</g, '&lt;') + '</pre></body></html>';
    }

    // Tab click handlers
    tabDesign.addEventListener('click', function() { _switchGlobalTab('design'); });
    tabAssets.addEventListener('click', function() { _switchGlobalTab('assets'); });
    tabCode.addEventListener('click', function() { _switchGlobalTab('code'); });
    tabThemes.addEventListener('click', function() { _switchGlobalTab('themes'); });

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
              // F-4: clear the misc job slot (render has no dedicated slot).
              if (_pendingMiscJob) { genJobComplete(_pendingMiscJob.id); _pendingMiscJob = null; }
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

            case 'canvas_multipass_progress': {
              var passLabel = 'Pass ' + (chunk.pass || 1) + '/' + (chunk.totalPasses || 3) + ': ' + (chunk.label || 'Processing...');
              var progressPct = 0;
              if (chunk.totalPasses && chunk.pass && chunk.total) {
                var passWeight = 100 / chunk.totalPasses;
                progressPct = Math.round((chunk.pass - 1) * passWeight + (chunk.current / Math.max(1, chunk.total)) * passWeight);
              }
              if (_pendingLayoutJob) {
                genJobUpdateLabel(_pendingLayoutJob.id, passLabel);
              }
              showPromptStatus(passLabel, progressPct);
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
              // Legacy handler — website generation now yields canvas_mockup_complete for hierarchical rendering
              if (_pendingLayoutJob) { genJobComplete(_pendingLayoutJob.id); _pendingLayoutJob = null; }
              break;
            }

            // ── Stitch Generation ─────────────────────────────────
            case 'canvas_stitch_started': {
              // F-4: stitch jobs may live in the layout slot (/design) or the
              // misc slot (/edit, /html, /variants) — label whichever is set.
              var _stitchStartJob = _pendingLayoutJob || _pendingMiscJob;
              if (_stitchStartJob) {
                genJobUpdateLabel(_stitchStartJob.id, 'Generating with Google Stitch...');
              }
              showPromptStatus('Generating with Google Stitch...', 10);
              break;
            }

            case 'canvas_stitch_screen_ready': {
              var _stitchReadyJob = _pendingLayoutJob || _pendingMiscJob;
              if (_stitchReadyJob && chunk.stitchScreenRef) {
                _stitchReadyJob.stitchRef = chunk.stitchScreenRef;
              }
              showPromptStatus('Downloading screen...', 50);
              break;
            }

            case 'canvas_stitch_html_ready': {
              var _stitchHtmlJob = _pendingLayoutJob || _pendingMiscJob;
              if (_stitchHtmlJob && chunk.stitchHtml) {
                _stitchHtmlJob.htmlContent = chunk.stitchHtml;
              }
              showPromptStatus('Screen ready', 90);
              break;
            }

            case 'canvas_stitch_variants_ready':
              // F-4: clear the misc job slot (/variants has no dedicated slot).
              if (_pendingMiscJob) { genJobComplete(_pendingMiscJob.id); _pendingMiscJob = null; }
              showPromptStatus('Variants generated (' + (chunk.variantCount || 0) + ')', 100);
              setTimeout(hidePromptStatus, 3000);
              break;

            case 'canvas_stitch_design_dna':
              // F-4: clear the misc job slot (/design-dna has no dedicated slot).
              if (_pendingMiscJob) { genJobComplete(_pendingMiscJob.id); _pendingMiscJob = null; }
              showPromptStatusMessage('Design DNA extracted — DESIGN.md created', 'success');
              setTimeout(hidePromptStatus, 5000);
              break;

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
                _switchGlobalTab('assets');
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
                // Show properties panel if props are available. F-7: pass the
                // owning object id so Apply can resend its real source.
                if (chunk.componentProps && chunk.componentProps.length > 0) {
                  showPropsPanel(chunk.componentProps, chunk.componentName, chunk.framework, codeSourceObj ? codeSourceObj.id : null);
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
                  _switchGlobalTab('code');
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
              // F-4: clear the misc job slot (/edit-element, /edit-layout).
              if (_pendingMiscJob) { genJobComplete(_pendingMiscJob.id); _pendingMiscJob = null; }
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
                    if (_activeGlobalTab === 'code') {
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

            // ── Mockup Generation (DesignNode JSON) ──────────────
            case 'canvas_mockup_started':
              showPromptStatus('Generating mockup...', 5);
              break;


            case 'canvas_mockup_complete': {
              // Complete the pending job (removes spinner overlay). F-4: stitch
              // edit/variants jobs land in the misc slot, plain /design and
              // website jobs in the layout slot — clear whichever is set.
              if (_pendingLayoutJob) {
                genJobComplete(_pendingLayoutJob.id);
                _pendingLayoutJob = null;
              }
              if (_pendingMiscJob) {
                genJobComplete(_pendingMiscJob.id);
                _pendingMiscJob = null;
              }

              // Discard selection before re-rendering
              canvas.discardActiveObject();

              if (chunk.designNodes && chunk.designNodes.length) {
                // Store the design spec
                if (!_designSpec) {
                  _designSpec = {
                    id: canvasSessionId || 'spec-' + Date.now(),
                    version: 1,
                    name: 'Mockup',
                    theme: chunk.designTheme || _getDefaultTheme(),
                    rootNodes: chunk.designNodes,
                    assets: [],
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                  };
                } else {
                  // Append to existing spec
                  chunk.designNodes.forEach(function(n) { _designSpec.rootNodes.push(n); });
                  _designSpec.updatedAt = Date.now();
                  if (chunk.designTheme) { _designSpec.theme = chunk.designTheme; }
                }

                // Initialize theme library from spec
                _initThemeLibrary();

                // Collect assets from nodes
                _collectAssetsFromNodes(chunk.designNodes);

                // Render on canvas
                _renderDesignTree(_designSpec.rootNodes, _designSpec.theme);
                _switchGlobalTab('design');

                // Zoom to fit (delay to allow async image loads to complete)
                setTimeout(function() {
                  zoomToFit();
                  canvas.renderAll();
                }, 500);

                showPromptStatusMessage('Mockup generated — ' + chunk.designNodes.length + ' top-level nodes', 'success');
              }
              setTimeout(hidePromptStatus, 2000);
              break;
            }

            case 'canvas_theme_complete': {
              // F-26: a /theme on a fresh canvas previously dropped the result
              // because _designSpec was null. Create a minimal default spec so
              // the generated theme is saved/applied instead of silently lost.
              if (chunk.designTheme && !_designSpec) {
                _designSpec = {
                  id: canvasSessionId || 'spec-' + Date.now(),
                  version: 1,
                  name: 'Untitled',
                  theme: chunk.designTheme,
                  rootNodes: [],
                  assets: [],
                  createdAt: Date.now(),
                  updatedAt: Date.now()
                };
              }
              if (chunk.designTheme && _designSpec) {
                _designSpec.theme = chunk.designTheme;
                _designSpec.updatedAt = Date.now();
                // Save to theme library
                var themeName = 'Generated Theme ' + (_themeLibrary.length);
                var savedTheme = _saveThemeToLibrary(themeName, chunk.designTheme);
                _activeThemeId = savedTheme.id;
                // Re-render with new theme
                if (_designSpec.rootNodes && _designSpec.rootNodes.length > 0) {
                  _renderDesignTree(_designSpec.rootNodes, _designSpec.theme);
                }
                if (_activeGlobalTab === 'themes') { _buildThemesGrid(); }
                showPromptStatusMessage('Theme generated and saved as "' + themeName + '"', 'success');
              }
              setTimeout(hidePromptStatus, 3000);
              break;
            }

            case 'canvas_asset_generated': {
              if (chunk.asset) {
                // Update asset in library
                var found = false;
                for (var ai = 0; ai < _designAssets.length; ai++) {
                  if (_designAssets[ai].id === chunk.asset.id) {
                    _designAssets[ai].src = chunk.asset.src;
                    found = true;
                    break;
                  }
                }
                if (!found) { _designAssets.push(chunk.asset); }
                if (_activeGlobalTab === 'assets') { _buildAssetsGrid(); }
              }
              break;
            }

            // ── Errors ─────────────────────────────────────────────
            case 'canvas_error':
              showPromptStatusMessage(chunk.error || 'Unknown error', 'error');
              safeEnable('btn-draft-generate');
              safeAddClass('draft-progress', 'hidden');
              // F-4: tear down ALL generation jobs (every _pending* slot AND
              // any untracked _genJobs entry) so no spinner overlay leaks,
              // regardless of which action type errored.
              genJobClearAll();
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
