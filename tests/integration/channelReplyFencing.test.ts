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
 * Plan 27 Gate 3 — "every path reaching a model has ONE fencing implementation."
 *
 * `getReplyContext()` interpolates `ask.reply` — the literal text a REMOTE
 * THIRD PARTY sent over WhatsApp/Telegram via the OpenClaw gateway — into a
 * quoted line, and that string was joined straight into the backend's SYSTEM
 * position. It sat in `fullSystemContext` BETWEEN `projectInstructions` and
 * `autoMemory`, both of which are fenced for precisely this reason.
 *
 * The threat is stricter than the one D-7 closed: `mysti.md` at least requires
 * commit access to a repository the user chose to clone. A channel reply can be
 * written by anyone who can message the connected number.
 *
 * These tests assert the SOURCE shape (what ChannelBridge emits is attacker-
 * controlled and unescaped) and the SINK shape (ChatViewProvider fences it with
 * the one shared helper), which is what makes this a Gate 3 test rather than a
 * string-matching test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const PROVIDER = path.join(ROOT, 'src', 'providers', 'ChatViewProvider.ts');
const BRIDGE = path.join(ROOT, 'src', 'managers', 'ChannelBridge.ts');

let provider: string;
let bridge: string;

beforeAll(() => {
  provider = fs.readFileSync(PROVIDER, 'utf8');
  bridge = fs.readFileSync(BRIDGE, 'utf8');
});

describe('channel replies are attacker-controlled at the source', () => {
  it('getReplyContext interpolates the raw remote reply, unescaped', () => {
    // Pinning the premise: if this ever starts escaping/sanitising at the
    // source, the fence is still correct but this test should be revisited
    // rather than silently passing for the wrong reason.
    const idx = bridge.indexOf('getReplyContext(');
    expect(idx).toBeGreaterThan(-1);
    const body = bridge.slice(idx, idx + 1200);
    expect(body).toContain('${ask.reply}');
  });
});

describe('the sink fences them with the ONE shared implementation', () => {
  it('replyContext goes through _fenceUntrustedSystemBlock', () => {
    const idx = provider.indexOf('const replyContextRaw');
    expect(idx, 'replyContextRaw not found — was the fencing removed?').toBeGreaterThan(-1);
    const block = provider.slice(idx, idx + 900);
    expect(block).toContain('_fenceUntrustedSystemBlock');
    expect(block).toContain('replyContextRaw');
  });

  it('the raw reply text is never joined into the system context directly', () => {
    // The defect shape: `[channelSnippet, replyContext]` where replyContext was
    // the bridge's raw return value.
    expect(provider).not.toMatch(
      /const\s+replyContext\s*=\s*this\._channelBridge\.getReplyContext\(/,
    );
  });

  it('tells the model it is data, not instructions', () => {
    const idx = provider.indexOf('const replyContextRaw');
    const block = provider.slice(idx, idx + 900);
    expect(block).toMatch(/DATA, NOT instructions/i);
  });

  it('does NOT fence the host-authored channel snippet — that one IS an instruction', () => {
    // getChannelPromptSnippet teaches the marker grammar and lists connected
    // channels; fencing it would tell the model to ignore its own protocol.
    // The ASSIGNMENT itself, not the surrounding region — the fenced reply
    // block now sits between channelSnippet and channelContext, so slicing
    // between them would (wrongly) catch the reply's fence.
    const line = provider.split('\n').find((l) => l.includes('const channelSnippet ='));
    expect(line, 'channelSnippet assignment not found').toBeTruthy();
    expect(line as string).toContain('getChannelPromptSnippet()');
    expect(line as string).not.toContain('_fenceUntrustedSystemBlock');
  });
});

describe('every entry of the system context is accounted for', () => {
  it('fullSystemContext contains only fenced content or host-authored conventions', () => {
    const line = provider.split('\n').find((l) => l.includes('const fullSystemContext'));
    expect(line, 'fullSystemContext assembly not found').toBeTruthy();
    const entries = (line as string).slice((line as string).indexOf('[') + 1, (line as string).indexOf(']'))
      .split(',').map((x) => x.trim()).filter(Boolean);

    // If a NEW entry appears here, it must be classified deliberately: either
    // fenced, or a host-authored convention with no external interpolation.
    const FENCED = ['projectInstructions', 'autoMemory'];
    const FENCED_INSIDE = ['channelContext'];
    const HOST_AUTHORED = ['deepMystConnect', 'canvasSnippet', 'visualSnippet'];
    const known = new Set([...FENCED, ...FENCED_INSIDE, ...HOST_AUTHORED]);

    for (const e of entries) {
      expect(
        known.has(e),
        `${e} was added to the system context without being classified. It reaches a model's SYSTEM `
        + 'position: either fence it with _fenceUntrustedSystemBlock, or confirm it is host-authored '
        + 'with no external interpolation, then add it to the list in this test.',
      ).toBe(true);
    }
    expect(entries.length, 'the assembly changed shape').toBe(known.size);
  });
});
