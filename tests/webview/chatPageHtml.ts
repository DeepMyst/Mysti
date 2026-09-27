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
 *
 * The chat webview as one self-contained HTML document, for browser suites
 * that boot the real `media/chat/*` in Chromium. Same composition as
 * `chatComposerBrowser.test.ts` (copied, not moved, so that suite is not
 * edited alongside Plan 31's work on its neighbours).
 *
 * Every `.replace()` that injects file content passes a FUNCTION, never a
 * string: `String.prototype.replace` treats `$&`, `$'`, '$`' and `$n` in a
 * STRING replacement as substitution patterns, and minified libraries are
 * full of `$`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** The same payload `webviewContent.ts` emits, with the URIs stubbed. */
function bootPayload(): Record<string, unknown> {
  const logo = ['claude', 'openaiLight', 'openaiDark', 'gemini', 'cline', 'copilot', 'cursor',
    'openclaw', 'opencode', 'ollama', 'localai', 'qwen', 'hermes', 'continue', 'openrouter', 'kimi'];
  const boot: Record<string, unknown> = {
    mermaidUri: '', logoUri: '', version: '0.0.0-test', iconUris: {}, manifestSchemaVersion: 1,
  };
  for (const k of logo) { boot[`${k}LogoUri`] = ''; }
  boot.openaiLogoLightUri = '';
  boot.openaiLogoDarkUri = '';
  return boot;
}

/** The `initialState` payload every panel receives first. */
export const INITIAL_STATE: Record<string, unknown> = {
  settings: {
    provider: 'claude-code', model: '', mode: 'ask-before-edit',
    thinkingLevel: 'none', effortLevel: 'high', accessLevel: 'ask-permission',
    contextMode: 'auto', autonomousMode: false,
  },
  messages: [], context: [], conversations: [],
};

export function composeChatHtml(): string {
  let html = read('media/chat/index.html');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '');
  html = html
    .replace(/\{\{nonce\}\}/g, 'n')
    .replace(/\{\{cspSource\}\}/g, "'self'")
    .replace(/\{\{resourceBase\}\}/g, '')
    .replace(/\{\{version\}\}/g, '0.0.0-test')
    .replace('<link rel="stylesheet" href="{{chatCssUri}}">', () => `<style>${read('media/chat/chat.css')}</style>`)
    .replace('<link rel="stylesheet" href="{{deskCssUri}}">', () => `<style>${read('media/chat/desk.css')}</style>`)
    .replace('{{bootJson}}', () => JSON.stringify(bootPayload()))
    // Playwright waits for a STABLE box before acting; nothing here tests an animation.
    .replace('</head>', () => '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>');

  for (const [tag, file] of [
    ['<script nonce="n" src="/dompurify.min.js"></script>', 'resources/dompurify.min.js'],
    ['<script nonce="n" src="/marked.min.js"></script>', 'resources/marked.min.js'],
    ['<script nonce="n" src="/prism-bundle.js"></script>', 'resources/prism-bundle.js'],
  ] as const) {
    html = html.replace(tag, () => `<script>${read(file)}</script>`);
  }

  // The host API, stubbed: everything the webview posts lands in window.__posted.
  const stub = `<script>
    window.__posted = [];
    window.acquireVsCodeApi = function () {
      return {
        postMessage: function (m) { window.__posted.push(m); },
        getState: function () { return undefined; },
        setState: function () {}
      };
    };
  </script>`;
  const bootTag = '<script nonce="n">window.__MYSTI_BOOT__';
  if (!html.includes(bootTag)) { throw new Error('boot script tag not found — harness is out of date with index.html'); }
  html = html.replace(bootTag, () => `${stub}${bootTag}`);
  html = html
    .replace('<script nonce="n" src="{{markdownRendererJsUri}}"></script>', () => `<script>${read('media/chat/markdownRenderer.js')}</script>`)
    .replace('<script nonce="n" src="{{subAgentCardsJsUri}}"></script>', () => `<script>${read('media/chat/subAgentCards.js')}</script>`)
    .replace('<script nonce="n" src="{{agentMapJsUri}}"></script>', () => `<script>${read('media/chat/agentMap.js')}</script>`)
    .replace('<script nonce="n" src="{{chatJsUri}}"></script>', () => `<script>${read('media/chat/chat.js')}</script>`)
    .replace('<script nonce="n" src="{{deskJsUri}}"></script>', () => `<script>${read('media/chat/desk.js')}</script>`);
  return html;
}
