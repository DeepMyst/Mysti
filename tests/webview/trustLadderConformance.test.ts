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
 * Plan 28 Phase 1 — the webview's copy of the Trust ladder may not drift.
 *
 * `media/chat/chat.js` is a static asset, not a compiled module, so it cannot
 * import `src/utils/trustLadder.ts`. Its `CHAT_MODES` table and
 * `deriveChatMode()` are therefore a HAND-COPY of the ladder — the exact shape
 * that produced CANVAS-LANE-02, where a hand-copied never-gated rule drifted
 * the moment a new action type joined it.
 *
 * So the copy is pinned here: the table must equal the module's rungs, and the
 * webview's display mapping must agree with `trustForAuthority` on all fifteen
 * stored combinations. This test is the reason the duplication is acceptable.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  TRUST_STOPS,
  authorityForTrust,
  trustForAuthority,
  type TrustStop,
} from '../../src/utils/trustLadder';
import { ACCESS_LEVELS, OPERATION_MODES } from '../../src/utils/settingsClamp';
import type { AccessLevel, OperationMode } from '../../src/types';

const ROOT = path.resolve(__dirname, '../..');
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'media/chat/chat.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'media/chat/index.html'), 'utf8');

/** Pull the `CHAT_MODES` array literal out of the asset and evaluate it. */
function readChatModes(): Array<Record<string, string>> {
  const m = CHAT_JS.match(/var CHAT_MODES = (\[[\s\S]*?\n\s*\]);/);
  if (!m) { throw new Error('CHAT_MODES table not found in media/chat/chat.js'); }
  return new Function('return ' + m[1])();
}

/** Pull `deriveChatMode` out of the asset and make it callable with a fake state. */
function readDeriveChatMode(): (mode: string, access: string) => string {
  const m = CHAT_JS.match(/function deriveChatMode\(\)\s*\{[\s\S]*?\n(\s*)\}/);
  if (!m) { throw new Error('deriveChatMode() not found in media/chat/chat.js'); }
  const fn = new Function('state', `${m[0]}; return deriveChatMode();`);
  return (mode, access) =>
    fn({ autonomyLevel: 'manual', settings: { mode, accessLevel: access } });
}

describe('webview Trust ladder — the table matches the module', () => {
  it('has exactly the module rungs, in the module order', () => {
    const table = readChatModes();
    expect(table.map(r => r.id)).toEqual([...TRUST_STOPS]);
  });

  it('maps every rung to the same stored pair the module does', () => {
    for (const row of readChatModes()) {
      const a = authorityForTrust(row.id as TrustStop);
      expect(row.mode, `${row.id}.mode`).toBe(a.mode);
      expect(row.access, `${row.id}.access`).toBe(a.accessLevel);
    }
  });

  it('carries no autonomy field — unattended is a duration, not a rung', () => {
    for (const row of readChatModes()) {
      expect(Object.prototype.hasOwnProperty.call(row, 'autonomy'), `${row.id}`).toBe(false);
    }
  });
});

describe('webview Trust ladder — the display mapping matches the module', () => {
  it('agrees with trustForAuthority on all fifteen stored combinations', () => {
    const derive = readDeriveChatMode();
    for (const mode of OPERATION_MODES) {
      for (const access of ACCESS_LEVELS) {
        expect(derive(mode, access), `${mode}/${access}`)
          .toBe(trustForAuthority(mode as OperationMode, access as AccessLevel));
      }
    }
  });
});

describe('webview Trust ladder — the duplicate policy surface is gone', () => {
  it('the settings panel no longer carries its own policy selects', () => {
    // These were the second surface writing the same decision as the pill.
    for (const id of ['mode-select', 'access-select', 'autonomy-select']) {
      expect(INDEX_HTML, id).not.toContain(`id="${id}"`);
    }
  });

  it('the mode popup offers exactly the four rungs', () => {
    const offered = [...INDEX_HTML.matchAll(/class="mode-option"\s+data-mode="([a-z-]+)"/g)]
      .map(m => m[1]);
    expect(offered).toEqual([...TRUST_STOPS]);
  });
});

describe('the setup dismissal latch is released by every request path', () => {
  /*
   * `dismissedByUser` stops a stale poll re-raising a wall the user left. As a
   * one-way latch it also swallowed the prompts the user themselves asked for,
   * stranding the wizard at "Checking authentication…". The rule is therefore:
   * every path that REQUESTS setup must clear it first.
   *
   * Asserted statically rather than by clicking, because the reachable request
   * paths live inside the wizard's own render/bind cycle — a DOM test of them
   * ends up testing wizard bootstrapping, and one that clicks the wrong button
   * passes while proving nothing. This reads the shipped bytes.
   */
  it('every startProviderSetup post is preceded by its OWN re-arm', () => {
    const posts = [...CHAT_JS.matchAll(/type: 'startProviderSetup'/g)].map((m) => m.index ?? 0);
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const at of posts) {
      // A fixed lookback is not enough: the first two posts are ~145 bytes
      // apart, so a new branch added beside them would be "covered" by its
      // NEIGHBOUR's re-arm. Anchor instead on there being no other post
      // between this one and the nearest re-arm above it.
      const before = CHAT_JS.slice(0, at);
      // The call that owns this `type:` line.
      const ownPost = before.lastIndexOf('postMessageWithPanelId(');
      expect(ownPost, `no postMessageWithPanelId( owns startProviderSetup at ${at}`).toBeGreaterThan(-1);
      const rearm = before.slice(0, ownPost).lastIndexOf('rearmSetupOverlay();');
      expect(rearm, `startProviderSetup at ${at} has no rearmSetupOverlay() above it`)
        .toBeGreaterThan(-1);
      // Nothing may post between the re-arm and the request it belongs to.
      expect(before.slice(rearm, ownPost).includes('postMessageWithPanelId('),
        `the nearest rearmSetupOverlay() above startProviderSetup at ${at} belongs to a different post`)
        .toBe(false);
    }
  });

  it('selectAuthMethod re-arms — it bypasses startProviderSetup as well', () => {
    // It ends in `_pollAuthStatus`, whose setupComplete/setupFailed would be
    // swallowed by a set latch, so a user who once skipped setup got no
    // feedback at all when OAuth polling timed out.
    const at = CHAT_JS.indexOf("type: 'selectAuthMethod'");
    expect(at).toBeGreaterThan(-1);
    const ownPost = CHAT_JS.slice(0, at).lastIndexOf('postMessageWithPanelId(');
    const rearm = CHAT_JS.slice(0, ownPost).lastIndexOf('rearmSetupOverlay();');
    expect(rearm).toBeGreaterThan(-1);
    expect(CHAT_JS.slice(rearm, ownPost).includes('postMessageWithPanelId(')).toBe(false);
  });

  it('Retry is revived by TERMINAL messages, never by progress', () => {
    // Reviving on progress re-enabled the button during its own `npm install
    // -g` — SetupManager emits `checking, 5%` within milliseconds — so a second
    // click raced two global installs, which is the hazard the disable exists
    // for. Terminal messages and an explicit re-arm force it; progress must not.
    expect(CHAT_JS).toContain('function reviveSetupRetry(force)');
    for (const caller of ['function handleSetupFailed', 'function handleSetupComplete',
                          'function rearmSetupOverlay']) {
      const at = CHAT_JS.indexOf(caller);
      expect(at, caller).toBeGreaterThan(-1);
      expect(CHAT_JS.slice(at, at + 900), `${caller} must revive Retry`).toMatch(/reviveSetupRetry\(true\)/);
    }
    const prog = CHAT_JS.indexOf('function handleSetupProgress');
    expect(prog).toBeGreaterThan(-1);
    // Scope to THIS function — a fixed window runs into the next one, which
    // legitimately does revive.
    const nextFn = CHAT_JS.indexOf('\n      function ', prog + 1);
    expect(CHAT_JS.slice(prog, nextFn), 'progress must NOT revive Retry')
      .not.toContain('reviveSetupRetry(');
  });

  it('an in-flight retry cannot be started twice', () => {
    const at = CHAT_JS.indexOf("setupRetryBtn.addEventListener('click'");
    expect(CHAT_JS.slice(at, at + 900)).toContain('retryInFlight = true');
    expect(CHAT_JS).toContain('state.setup.retryInFlight && !force');
  });

  it('every way out of the auth prompt actually leaves', () => {
    // Both "Later" and the waiting state's button must record the dismissal
    // AND hide, or they are decoration on a full-screen wall.
    for (const id of ['auth-skip-btn', 'auth-wait-skip-btn']) {
      const at = CHAT_JS.indexOf(`document.getElementById('${id}')`);
      expect(at, id).toBeGreaterThan(-1);
      const body = CHAT_JS.slice(at, at + 700);
      expect(body, `${id} must record the dismissal`).toContain('dismissedByUser = true');
      expect(body, `${id} must hide the overlay`).toContain('hideSetupOverlay()');
    }
  });

  it('the Retry click never hides the pane that holds the only Skip button', () => {
    // `#setup-skip-btn` lives inside `.setup-error`; hiding it left a
    // full-screen overlay with no buttons for the length of an npm install.
    const at = CHAT_JS.indexOf("setupRetryBtn.addEventListener('click'");
    expect(at).toBeGreaterThan(-1);
    const body = CHAT_JS.slice(at, at + 1200);
    expect(body).not.toMatch(/setup-error'\)[\s\S]{0,80}classList\.add\('hidden'\)/);
  });

  it('the debug setup commands re-arm too — they bypass startProviderSetup', () => {
    // `mysti.debugSetup` / `mysti.debugSetupFailure` drive the overlay directly,
    // so without this they are silently inert for anyone who has ever skipped
    // setup, until the webview is reloaded.
    const provider = fs.readFileSync(path.join(ROOT, 'src/providers/ChatViewProvider.ts'), 'utf8');
    for (const fn of ['debugForceSetup(): void {', 'debugForceSetupFailure(): void {']) {
      const at = provider.indexOf(fn);
      expect(at, fn).toBeGreaterThan(-1);
      expect(provider.slice(at, at + 700), `${fn} must post setupRearm`).toContain("type: 'setupRearm'");
    }
    expect(CHAT_JS, 'the webview must handle setupRearm').toContain("case 'setupRearm':");
  });

  it('the latch is written false somewhere — it is not one-way', () => {
    expect(CHAT_JS).toMatch(/dismissedByUser\s*=\s*false/);
  });

  it('sign-in does NOT re-arm, because it cannot cause a setup message', () => {
    const at = CHAT_JS.indexOf("type: 'signInDeepMyst'");
    expect(at).toBeGreaterThan(-1);
    expect(CHAT_JS.slice(Math.max(0, at - 300), at)).not.toContain('rearmSetupOverlay();');
  });
});
