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
 * Plan 27 Phase 4 — EIGHT of the sixteen slash-menu entries were dead.
 *
 * Each advertised a label and a description, and each posted a message type
 * that nothing anywhere handled:
 *
 *   /share /init-team /memory /rules  -> trigger*         (webview echo missing)
 *   /consult /review /critique /panel -> composeCollaboration (picker never built)
 *   /canvas                           -> openCanvas       (no handler)
 *
 * The trigger* four are the interesting case: ChatViewProvider has ALWAYS
 * handled those exact names as webview -> extension messages, and
 * SlashCommandManager has always sent them extension -> webview. The echo in
 * the middle — which `triggerExport` and `triggerImport` have — was never
 * written, so the direction never closed.
 *
 * This test asserts the property, not the fix: EVERY menu entry that posts a
 * message must have a receiver. A ninth dead entry fails here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const SLASH = path.join(ROOT, 'src', 'managers', 'SlashCommandManager.ts');
const CHAT_JS = path.join(ROOT, 'media', 'chat', 'chat.js');
const PROVIDER = path.join(ROOT, 'src', 'providers', 'ChatViewProvider.ts');

let slash: string;
let js: string;
let provider: string;

/** Menu entries: `id: 'cmd:x', label: '…'`. */
function menuEntries(src: string): Array<{ id: string; label: string }> {
  return [...src.matchAll(/id:\s*'(cmd:[\w-]+)',\s*\n\s*label:\s*'([^']+)'/g)]
    .map((m) => ({ id: m[1], label: m[2] }));
}

/** The first message type each `case 'cmd:x':` posts, if any. */
function postedType(src: string, id: string): string | null {
  const m = new RegExp(`case '${id}':[\\s\\S]{0,400}?type:\\s*'(\\w+)'`).exec(src);
  return m ? m[1] : null;
}

beforeAll(() => {
  slash = fs.readFileSync(SLASH, 'utf8');
  js = fs.readFileSync(CHAT_JS, 'utf8');
  provider = fs.readFileSync(PROVIDER, 'utf8');
});

describe('every slash-menu entry does something', () => {
  it('the menu is not empty and the parser still works', () => {
    // Guards against the regexes silently matching nothing, which would make
    // every assertion below vacuously true.
    expect(menuEntries(slash).length).toBeGreaterThanOrEqual(16);
  });

  it('no menu entry posts a message that nothing receives', () => {
    const dead = menuEntries(slash)
      .map((e) => ({ ...e, type: postedType(slash, e.id) }))
      .filter((e) => e.type && !js.includes(`case '${e.type}'`));

    expect(
      dead.map((d) => `${d.label} -> '${d.type}'`),
      'These menu entries advertise a description and post a message no webview handler receives, '
      + 'so selecting them does nothing at all. Either handle the message, or invoke the capability '
      + 'directly (vscode.commands.executeCommand), or remove the entry from the menu.',
    ).toEqual([]);
  });
});

describe('the four trigger* commands close the loop', () => {
  for (const type of ['triggerShareLink', 'triggerInitTeam', 'triggerOpenMemory', 'triggerOpenRules']) {
    it(`${type}: posted by the slash command, echoed by the webview, handled by the extension`, () => {
      expect(slash, `${type} is no longer posted`).toContain(`'${type}'`);
      expect(js, `${type} has no webview echo — the direction never closes`).toContain(`case '${type}'`);
      expect(provider, `${type} has no extension-side handler`).toContain(`case '${type}':`);
    });
  }

  it('the echo forwards a panelId — the handlers read msg.panelId', () => {
    const idx = js.indexOf("case 'triggerShareLink':");
    expect(idx).toBeGreaterThan(-1);
    expect(js.slice(idx, idx + 400)).toContain('postMessageWithPanelId');
  });
});

describe('the collaboration commands compose a real mention', () => {
  it('they no longer post the never-handled composeCollaboration', () => {
    expect(slash).not.toContain("type: 'composeCollaboration'");
  });

  it('they route through the QuickPick composer', () => {
    for (const cmd of ['cmd:consult', 'cmd:review', 'cmd:critique', 'cmd:panel']) {
      const m = new RegExp(`case '${cmd}':[\\s\\S]{0,200}?_composeCollaboration`).test(slash);
      expect(m, `${cmd} does not call _composeCollaboration`).toBe(true);
    }
  });

  it('the composer writes an @agent:role mention into the input, and does not dispatch', () => {
    const idx = slash.indexOf('private async _composeCollaboration');
    expect(idx).toBeGreaterThan(-1);
    const body = slash.slice(idx, idx + 2200);
    expect(body).toContain('showQuickPick');
    expect(body).toMatch(/@\$\{p\.id\}:\$\{role\}/);
    // setInputValue is the handler merged in Phase 2 — it accepts { value }.
    expect(body).toContain("type: 'setInputValue'");
  });

  it('it offers only REGISTERED providers, so a 16th backend needs no edit here', () => {
    const idx = slash.indexOf('private async _composeCollaboration');
    expect(slash.slice(idx, idx + 2200)).toContain('getAllProviders()');
  });

  it('it says why when there is nobody to collaborate with, instead of going silent', () => {
    const idx = slash.indexOf('private async _composeCollaboration');
    expect(slash.slice(idx, idx + 2200)).toMatch(/No other agent is available/);
  });
});

describe('user-feedback messages reach the user (Plan 27 Phase 4)', () => {
  /**
   * These four were posted and received by nothing, so the user was told
   * nothing. `mentionWarning` is the one that loses work: @-mentions past
   * MAX_MENTIONS_PER_MESSAGE are silently dropped, so eight mentions run five
   * agents with no explanation. `mystiUnavailable` is a dead end on the DEFAULT
   * agent — an empty synthesis and no reason.
   */
  for (const type of ['mentionWarning', 'mystiUnavailable', 'permissionResult', 'editApplied']) {
    it(`${type} is posted by the extension AND handled by the webview`, () => {
      expect(provider, `${type} is no longer posted`).toContain(`type: '${type}'`);
      expect(js, `${type} has no webview handler — the user is told nothing`).toContain(`case '${type}'`);
    });
  }

  it('they render through showToast, which uses textContent (no markup injection)', () => {
    const idx = js.indexOf("case 'mentionWarning':");
    expect(idx).toBeGreaterThan(-1);
    expect(js.slice(idx, idx + 900)).toContain('showToast');
    const toast = js.indexOf('function showToast');
    expect(js.slice(toast, toast + 400)).toContain('textContent');
  });

  it('the silent-truncation path warns rather than dropping quietly', () => {
    // The producer must still explain WHAT was dropped, not just that something was.
    const idx = provider.indexOf("type: 'mentionWarning'");
    expect(provider.slice(idx, idx + 300)).toMatch(/Only the first/);
  });
});
