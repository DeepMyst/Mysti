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
 * B2 — webview side of the setup-wizard panelId round trip.
 *
 * The wizard is shown INSTEAD of initialState, so the showWizard payload is
 * the webview's only chance to learn its panelId. Without it, every outgoing
 * wizard message is stamped with panelId=null and the extension drops the
 * replies (_postToPanel(null) no-ops).
 *
 * Unlike tests/webview/mentionParsing.test.ts (which recreates logic), these
 * tests extract the REAL functions from the generated webview script and
 * execute them, so they cannot drift from the shipped artifact.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Extract a top-level `function name(...) { ... }` declaration from JS source by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

let html: string;

beforeAll(() => {
  // The chat script was extracted to media/chat/chat.js (Plan 03 Phase 3c
  // Step 1); read it directly as the function-extraction source.
  html = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
});

describe('webview handleShowWizard (B2)', () => {
  function runHandleShowWizard(state: any, payload: any): void {
    const src = extractFunction(html, 'handleShowWizard');
    const run = new Function(
      'state', 'dismissInitLoading', 'renderWizard', 'initWizardEventListeners', 'payload',
      `${src}\nhandleShowWizard(payload);`
    );
    run(state, () => undefined, () => undefined, () => undefined, payload);
  }

  it('should adopt the panelId carried by the showWizard payload', () => {
    const state: any = { panelId: null, wizard: {} };

    runHandleShowWizard(state, {
      panelId: 'sidebar',
      providers: [],
      npmAvailable: true,
      nodeVersion: 'v20.0.0',
      anyReady: false,
    });

    expect(state.panelId).toBe('sidebar');
    expect(state.wizard.visible).toBe(true);
  });

  it('should adopt a tab panelId too (wizard shown in a tab panel)', () => {
    const state: any = { panelId: null, wizard: {} };

    runHandleShowWizard(state, { panelId: 'panel-2', providers: [] });

    expect(state.panelId).toBe('panel-2');
  });

  it('should not clobber an existing panelId when the payload has none', () => {
    const state: any = { panelId: 'panel-7', wizard: {} };

    runHandleShowWizard(state, { providers: [] });

    expect(state.panelId).toBe('panel-7');
    expect(state.wizard.visible).toBe(true);
  });
});

describe('webview postMessageWithPanelId (B2 outbound hop)', () => {
  function runPostMessage(state: any, msg: any): any[] {
    const sent: any[] = [];
    const src = extractFunction(html, 'postMessageWithPanelId');
    const run = new Function(
      'state', 'vscode', 'msg',
      `${src}\npostMessageWithPanelId(msg);`
    );
    run(state, { postMessage: (m: unknown) => sent.push(m) }, msg);
    return sent;
  }

  it('should stamp outgoing messages with the panelId learned from showWizard', () => {
    const state: any = { panelId: 'sidebar' };

    const sent = runPostMessage(state, { type: 'requestWizardStatus' });

    expect(sent).toHaveLength(1);
    expect(sent[0].panelId).toBe('sidebar');
  });

  it('documents the pre-fix failure mode: without a learned panelId, messages go out with null', () => {
    // The extension-side guard (msg.panelId ?? sidebar) exists precisely
    // because this is what a wizard-only webview used to send.
    const state: any = { panelId: null };

    const sent = runPostMessage(state, { type: 'requestWizardStatus' });

    expect(sent[0].panelId).toBeNull();
  });
});
