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
 *
 * There WAS a ninth, and this file could not see it: the scan only ever looked
 * at `cmd:` ids inside SlashCommandManager, so Claude's `/compact` — declared
 * in ClaudeCodeProvider, posting a `sendCliPassthrough` no webview handler has
 * ever received — stayed dead through the whole cleanup. The provider-declared
 * entries are now scanned too.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const SLASH = path.join(ROOT, 'src', 'managers', 'SlashCommandManager.ts');
const PROVIDERS_DIR = path.join(ROOT, 'src', 'providers');
const CHAT_JS = path.join(ROOT, 'media', 'chat', 'chat.js');
const PROVIDER = path.join(ROOT, 'src', 'providers', 'ChatViewProvider.ts');

let slash: string;
let js: string;
let provider: string;

/** Every provider source file that declares its own menu entries. */
function providerSources(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  for (const dir of fs.readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) { continue; }
    const sub = path.join(PROVIDERS_DIR, dir.name);
    for (const entry of fs.readdirSync(sub)) {
      if (!entry.endsWith('.ts')) { continue; }
      const file = path.join(sub, entry);
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('getSlashCommands')) { out.push({ file, src }); }
    }
  }
  return out;
}

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
    // every assertion below vacuously true. Plan 29 moved four entries
    // (review, critique, panel, brainstorm) out of the `cmd:` family and into
    // sessions, which the block below covers on its own terms.
    expect(menuEntries(slash).length).toBeGreaterThanOrEqual(12);
  });

  /**
   * Plan 29's session entries are generated from SESSION_SHAPES rather than
   * written out one by one, so the `cmd:`-only scan above cannot see them —
   * exactly the blind spot that let provider entries ship dead. They are alive
   * by a different contract: picking one opens the webview's agent picker, and
   * running it posts `startSession`, which the extension must receive.
   */
  it('every session shape is offered, and the picker that runs it is live', () => {
    const catalog = fs.readFileSync(path.join(ROOT, 'src', 'managers', 'sessionShapes.ts'), 'utf8');
    const shapes = [...catalog.matchAll(/id:\s*'(review|panel|critique|race|brainstorm)',/g)].map(m => m[1]);
    expect(new Set(shapes).size, 'a session shape lost its catalog entry').toBe(5);

    // The menu builds its Sessions section from that catalog, so one table
    // feeds both the offer and the dispatch.
    expect(slash).toContain('SESSION_SHAPES.map');

    // The webview turns a `session:` pick into the picker rather than firing
    // the command — without this branch every session entry is a dead row.
    expect(js).toContain("cmd.id.indexOf('session:') === 0");
    expect(js).toContain('openSessionPicker');

    // …and the picker's Run reaches a handler on the extension side.
    expect(js).toContain("type: 'startSession'");
    expect(provider).toContain("case 'startSession'");

    // Per-lane Stop, likewise: the button must reach something.
    expect(js).toContain("type: 'stopSessionLane'");
    expect(provider).toContain("case 'stopSessionLane'");

    // And the events the run emits must have a receiver.
    expect(provider).toContain("type: 'sessionEvent'");
    expect(js).toContain("case 'sessionEvent'");
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

describe('provider-declared menu entries are alive too', () => {
  it('the provider scan still finds files (guards against a vacuous pass)', () => {
    expect(providerSources().length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The gap that let Claude's `/compact` ship dead. A provider entry is not
   * covered by the `cmd:`-only scan above, so its posted message type is
   * checked here against the same receiver requirement.
   */
  it('no provider entry posts a message nothing receives', () => {
    const dead: string[] = [];
    for (const { file, src } of providerSources()) {
      for (const m of src.matchAll(/id:\s*['"]([a-z-]+:[a-z-]+)['"]/g)) {
        const id = m[1];
        // Terminal launch is handled generically by SlashCommandManager.
        if (id.endsWith(':terminal')) { continue; }
        const posted = postedType(slash, id);
        if (posted && !js.includes(`case '${posted}'`)) {
          dead.push(`${path.basename(file)} ${id} -> '${posted}'`);
        }
      }
    }
    expect(
      dead,
      'A provider declares a menu entry whose handler posts a message the webview never receives, '
      + 'so selecting it does nothing. Handle the message, invoke the capability directly, or drop the entry.',
    ).toEqual([]);
  });

  /**
   * `sendCliPassthrough` was the dead message type; nothing may POST it again.
   * The name is still allowed to appear in prose — the comment explaining why
   * the entry was removed is the reason anyone would know not to re-add it.
   */
  it('nothing posts sendCliPassthrough — it has never had a receiver', () => {
    const posts = /type:\s*'sendCliPassthrough'/;
    expect(js.includes("case 'sendCliPassthrough'")).toBe(false);
    expect(posts.test(slash)).toBe(false);
    for (const { file, src } of providerSources()) {
      expect(posts.test(src), `${path.basename(file)} posts it`).toBe(false);
    }
  });

  /**
   * A native command runs as a TURN against the backend, and the extension
   * refuses to send one without the panel's settings. A menu pick that omits
   * them is undeliverable — which is exactly what used to happen.
   */
  it('picking a menu item sends the same context typing one does', () => {
    const idx = js.indexOf('function executeSlashMenuItem');
    expect(idx).toBeGreaterThan(-1);
    const body = js.slice(idx, idx + 1600);
    expect(body).toContain('settings: state.settings');
    expect(body).toContain('context: state.context');
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
