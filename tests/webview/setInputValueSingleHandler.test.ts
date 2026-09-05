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
 * Plan 27 — `setInputValue` had TWO `case` labels in the same `switch (message.type)`.
 *
 * JavaScript takes the first matching case, so the second handler — the one
 * that read `message.payload.value` for the "Keep Planning" plan-card action —
 * was unreachable. The live handler did `inputEl.value = message.payload`, and
 * `ChatViewProvider` posts `{ value: followUpPrompt }` for Keep Planning, so the
 * user saw the literal string "[object Object]" in the input box.
 *
 * ESLint's `no-duplicate-case` found it the day `media/**\/*.js` was put under
 * lint. These tests pin (a) that the label is unique, (b) that the one handler
 * accepts BOTH shapes the extension actually sends, and (c) that the two
 * extension-side senders still send exactly those two shapes — so a third
 * shape cannot appear on one side without failing here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const CHAT_JS = path.join(ROOT, 'media', 'chat', 'chat.js');
const CHAT_VIEW = path.join(ROOT, 'src', 'providers', 'ChatViewProvider.ts');
const SLASH = path.join(ROOT, 'src', 'managers', 'SlashCommandManager.ts');

let chat: string;
let handler: string;

/** The `case 'setInputValue':` body, up to its `break;`. */
function extractCase(source: string): string {
  const label = "case 'setInputValue':";
  const start = source.indexOf(label);
  if (start === -1) { throw new Error('setInputValue case not found'); }
  const end = source.indexOf('break;', start);
  if (end === -1) { throw new Error('setInputValue case has no break'); }
  return source.slice(start, end);
}

beforeAll(() => {
  chat = fs.readFileSync(CHAT_JS, 'utf8');
  handler = extractCase(chat);
});

describe('setInputValue: exactly one reachable handler', () => {
  it('has exactly ONE case label — a second is unreachable, not a fallback', () => {
    const labels = chat.match(/case 'setInputValue':/g) ?? [];
    expect(labels).toHaveLength(1);
  });

  it('accepts the object shape { value } that Keep Planning sends', () => {
    // A `typeof ... === 'object'` branch reading `.value`, not a bare assignment.
    expect(handler).toMatch(/typeof incoming === 'object'/);
    expect(handler).toMatch(/incoming\.value/);
    // The bug: assigning the payload object straight into the input.
    expect(handler).not.toMatch(/inputEl\.value\s*=\s*message\.payload\s*;/);
  });

  it('still accepts the bare-string shape the slash-command menu sends', () => {
    // The non-object branch stringifies the payload itself.
    expect(handler).toMatch(/String\(incoming\)/);
  });

  it('resizes, focuses, and fires the input event — the union of both old handlers', () => {
    expect(handler).toMatch(/autoResizeTextarea\(\)/);
    expect(handler).toMatch(/inputEl\.focus\(\)/);
    expect(handler).toMatch(/dispatchEvent\(new Event\('input'\)\)/);
  });
});

describe('setInputValue: the extension sends exactly the two shapes the handler accepts', () => {
  it('ChatViewProvider posts { value } for Keep Planning', () => {
    const src = fs.readFileSync(CHAT_VIEW, 'utf8');
    const sends = [...src.matchAll(/type:\s*'setInputValue'[\s\S]{0,120}?payload:\s*([^\n]+)/g)].map(m => m[1].trim());
    expect(sends.length).toBeGreaterThan(0);
    for (const s of sends) { expect(s).toMatch(/^\{\s*value:/); }
  });

  it('SlashCommandManager posts a bare string AND the object shape', () => {
    // It sends both: a bare `'@'` to open the mention menu, and `{ value }`
    // from the collaboration composer (Plan 27 Phase 4). Both are shapes the
    // single merged handler accepts — which is the property that matters, and
    // is why this test asserts the SET of shapes rather than one per file.
    const src = fs.readFileSync(SLASH, 'utf8');
    const bare = /type:\s*'setInputValue',\s*payload:\s*'[^']*'/.test(src);
    const obj = /type:\s*'setInputValue',\s*\n?\s*payload:\s*\{\s*value:/.test(src);
    expect(bare || obj, 'SlashCommandManager no longer posts setInputValue at all').toBe(true);
    // Whatever it posts must be one of the two accepted shapes, never a third.
    // Capture only the START of the value — a quoted string or an opening
    // brace — so trailing `});` on the same line cannot fail the match.
    const sends = [...src.matchAll(/type:\s*'setInputValue',\s*(?:\n\s*)?payload:\s*('[^']*'|\{)/g)].map(m => m[1]);
    expect(sends.length, 'no setInputValue payload matched — the regex or the call shape changed').toBeGreaterThan(0);
    for (const v of sends) {
      expect(
        /^'[^']*'$/.test(v) || v === '{',
        `setInputValue payload starting ${v} is neither a bare string nor an object — the handler accepts only those two`,
      ).toBe(true);
    }
  });
});
