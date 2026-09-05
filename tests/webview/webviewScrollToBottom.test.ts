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
 * D-2 — `scrollToBottom()` was called 21 times and defined zero times.
 *
 * `media/chat/chat.js` is ONE IIFE with no `window` export, so an undefined
 * `scrollToBottom` is not a silently-missing scroll: it is a ReferenceError
 * that aborts whatever render called it, half-built. The call sites include
 * the coordinator card, the background-job card, the brainstorm synthesis
 * message and `handlePermissionRequest` — i.e. the throw landed immediately
 * after `card.focus()` on the security-critical approval path.
 *
 * `media/**\/*.js` is not linted at all (`npm run lint` covers `src/**\/*.ts`
 * only), which is exactly why a symbol with 21 references and no definition
 * survived. These tests are the substitute for the lint that does not exist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CHAT_JS = path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js');

let src: string;
let lines: string[];
beforeAll(() => {
  src = fs.readFileSync(CHAT_JS, 'utf8');
  lines = src.split('\n');
});

/** Extract a top-level `function name(...) { ... }` declaration by brace matching. */
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
      if (depth === 0) { return source.slice(start, i + 1); }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

describe('D-2: scrollToBottom is defined in the scope that calls it', () => {
  it('chat.js is a single IIFE, so a missing declaration cannot be rescued by a global', () => {
    // Line 1 is blank; the IIFE opens on line 2 and is the LAST thing to close.
    const openIdx = lines.findIndex(l => l.trim() === '(function() {');
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeLessThan(5);

    const closeIdx = lines.map(l => l.trim()).lastIndexOf('})();');
    expect(closeIdx).toBeGreaterThan(openIdx);
    // Nothing but whitespace after the IIFE closes.
    expect(lines.slice(closeIdx + 1).join('').trim()).toBe('');

    // And nothing hangs scrollToBottom off window as an escape hatch.
    expect(src).not.toMatch(/window\.scrollToBottom\s*=/);
  });

  it('declares scrollToBottom exactly once, at the top level of that IIFE', () => {
    const declarations = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(x => /^\s*function\s+scrollToBottom\s*\(/.test(x.l));

    expect(declarations).toHaveLength(1);

    // Statements at the top level of the IIFE body are indented exactly six
    // spaces in this file. A declaration nested any deeper would be invisible
    // to the call sites below, which is the bug being guarded against.
    expect(declarations[0].l).toMatch(/^ {6}function scrollToBottom\(\) \{$/);
  });

  it('every call site resolves to that declaration', () => {
    const openIdx = lines.findIndex(l => l.trim() === '(function() {');
    const closeIdx = lines.map(l => l.trim()).lastIndexOf('})();');
    const declLine = lines.findIndex(l => /^\s*function\s+scrollToBottom\s*\(/.test(l));
    expect(declLine).toBeGreaterThan(openIdx);

    const callLines = lines
      .map((l, i) => ({ l, n: i }))
      .filter(x => x.n !== declLine && /(^|[^.\w])scrollToBottom\s*\(/.test(x.l))
      // Skip the doc comment above the declaration.
      .filter(x => !/^\s*\*/.test(x.l));

    // The defect report counted 21; assert the shape, not a brittle exact count.
    expect(callLines.length).toBeGreaterThanOrEqual(20);
    for (const c of callLines) {
      expect(c.n).toBeGreaterThan(openIdx);
      expect(c.n).toBeLessThan(closeIdx);
    }
  });

  it('the security-critical renders that used to throw all still call it', () => {
    // handlePermissionRequest is the worst of them: the ReferenceError landed
    // after card.focus(), so the handler never returned normally.
    const permission = extractFunction(src, 'handlePermissionRequest');
    expect(permission).toContain('card.focus()');
    expect(permission).toContain('scrollToBottom()');
  });

  it('scrolls the transcript, and tolerates a missing #messages', () => {
    const body = extractFunction(src, 'scrollToBottom');
    const el = { scrollTop: 0, scrollHeight: 4242 };
    let target: unknown = el;
    const documentStub = { getElementById: (id: string) => (id === 'messages' ? target : null) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('document', `${body}; return scrollToBottom;`)(documentStub) as () => void;

    fn();
    expect(el.scrollTop).toBe(4242);

    target = null;
    expect(() => fn()).not.toThrow();
  });
});
