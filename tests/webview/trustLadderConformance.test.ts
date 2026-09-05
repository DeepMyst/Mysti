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
