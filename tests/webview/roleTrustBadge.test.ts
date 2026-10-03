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
 * Plan 27 lane M (§21.6c #5) — role trust must be VISIBLE where the user
 * picks a role.
 *
 * Lane F made every non-integrity-verified role run as the read-only Advisor
 * stance with its body fenced. The webview never learned: the `@agent:role`
 * picker showed the role's own name and its file-DECLARED access ("writes"),
 * both of which the extension had just overridden. The picker payload now
 * carries `trusted` (lane K, producer side); this pins the consumer:
 *
 *  1. the role menu item carries the flag,
 *  2. a `trusted === false` role renders a visible "unverified" badge whose
 *     title says it is advisory only,
 *  3. the access badge shows the EFFECTIVE access (read-only) for such a
 *     role, not the file's declared `gated-write`,
 *  4. a payload without the flag (older extension host) renders unchanged.
 *
 * Static: chat.js is read as text (see the sibling tests/webview suites).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const CHAT_JS = fs.readFileSync(path.resolve(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');

/** The role-menu builder: from the "Roles for @" header to the empty-state branch. */
function roleMenuSegment(): string {
  const start = CHAT_JS.indexOf("agentsHeader.textContent = 'Roles for @'");
  const end = CHAT_JS.indexOf('mention-menu-empty', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // Include the scoredRoles push above the header as well.
  const pushAt = CHAT_JS.lastIndexOf("type: 'role',", start);
  expect(pushAt).toBeGreaterThan(0);
  return CHAT_JS.slice(pushAt, end);
}

describe('role picker trust badge (webview, static)', () => {
  const seg = roleMenuSegment();

  it('carries the trusted flag from the picker payload into the menu item', () => {
    expect(seg).toMatch(/trusted:\s*r\.trusted/);
  });

  it('renders an "unverified" badge only when trusted === false (strict, not falsy)', () => {
    expect(seg).toContain("item.trusted === false");
    expect(seg).toContain('mention-unverified');
    expect(seg).toMatch(/title="not integrity-verified[^"]*advisory only/);
    // Absent flag (older host) must NOT be treated as untrusted.
    expect(seg).not.toMatch(/!item\.trusted\b/);
  });

  it('shows the EFFECTIVE access for an unverified role — read-only, never "writes"', () => {
    // The extension clamps an untrusted role to read-only (AgentContextManager
    // .buildRoleContext); the badge must say what will actually happen.
    const effective = /var effectiveAccess = item\.trusted === false \? 'read-only' : item\.access;/;
    expect(seg).toMatch(effective);
    expect(seg).toContain("effectiveAccess === 'gated-write'");
    expect(seg).not.toMatch(/item\.access === 'gated-write'/);
  });

  it('escapes nothing new: the badge is static markup with no interpolated role text', () => {
    const badge = /var trustBadge = item\.trusted === false\s*\?\s*'([^']*)'\s*:\s*'';/.exec(seg);
    expect(badge).not.toBeNull();
    expect(badge![1]).not.toContain('+');
  });
});
