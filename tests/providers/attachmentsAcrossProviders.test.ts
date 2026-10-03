/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 Phase 5 — images reached ONE provider of fifteen.
 *
 * `prepareAttachments` was a no-op in the base with a single override in
 * ClaudeCodeProvider, so `supportsImages` was true for Claude Code and false
 * everywhere else — the attach button was dead on fourteen backends.
 *
 * The mechanism generalises: write the bytes to a temp file and put its PATH in
 * the prompt. That only works for a backend with file-read tools, so this test
 * also pins the NEGATIVE side — a provider that cannot open a path must not
 * claim image support, which is the "lying capability flag" class the audit
 * called out.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const P = path.join(__dirname, '..', '..', 'src', 'providers');
const read = (rel: string) => fs.readFileSync(path.join(P, rel), 'utf-8');
const flag = (src: string, name: string): boolean | null => {
  const m = new RegExp(`${name}:\\s*(true|false)`).exec(src);
  return m ? m[1] === 'true' : null;
};

describe('the attachment mechanism is shared', () => {
  it('the base class writes temp files and returns a cleanup', () => {
    const base = read('base/BaseCliProvider.ts');
    const i = base.indexOf('protected async prepareAttachments(');
    expect(i).toBeGreaterThan(-1);
    const body = base.slice(i, i + 2600);
    expect(body).toContain('writeFile');
    expect(body).toContain('att.filePath = target');
    expect(body).toContain('unlink');            // cleanup, or temp files accumulate
    expect(body).toContain("'.mysti', 'tmp'");   // reachable by a sandboxed CLI
  });

  it('a provider with no attachments does no filesystem work', () => {
    const base = read('base/BaseCliProvider.ts');
    const i = base.indexOf('protected async prepareAttachments(');
    expect(base.slice(i, i + 2600)).toContain('if (!attachments || attachments.length === 0) { return null; }');
  });
});

describe('supportsImages is truthful', () => {
  const CAN_READ_FILES = ['claude/ClaudeCodeProvider', 'gemini/GeminiProvider', 'codex/CodexProvider',
    'qwen/QwenCodeProvider', 'opencode/OpenCodeProvider', 'kimi/KimiCodeProvider', 'hermes/HermesProvider'];

  for (const rel of CAN_READ_FILES) {
    it(`${rel.split('/')[1]} declares image support and has the tools to honour it`, () => {
      const src = read(`${rel}.ts`);
      expect(flag(src, 'supportsImages'), 'should support images').toBe(true);
      // The path only helps a backend that can open it.
      expect(flag(src, 'supportsToolUse'), 'claims images but has no file tools').toBe(true);
    });
  }

  for (const rel of ['ollama/OllamaProvider', 'localai/LocalAIProvider']) {
    it(`${rel.split('/')[1]} does NOT claim image support — an HTTP provider cannot open a path`, () => {
      // These need base64 in the request payload. Flipping the flag without
      // that would be a control that does nothing.
      expect(flag(read(`${rel}.ts`), 'supportsImages')).toBe(false);
    });
  }

  it('Continue does not claim it either — no tool events at all', () => {
    const src = read('continue/ContinueProvider.ts');
    expect(flag(src, 'supportsImages')).toBe(false);
    expect(flag(src, 'supportsToolUse')).toBe(false);
  });
});
