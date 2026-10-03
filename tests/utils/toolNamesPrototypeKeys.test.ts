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
 * CANVAS-LANE-07 — hostile tool names must not reach `Object.prototype` through
 * the tool-name lookup tables.
 *
 * `parseToolName` did `TOOL_NAME_ALIASES[bare.toLowerCase()] ?? bare` against a
 * PLAIN object literal, so a tool literally named `constructor` (or
 * `__proto__`, `toString`, …) resolved to the inherited prototype member — a
 * function/object, not a string. Every consumer immediately calls
 * `.toLowerCase()` on it, so the sole permission-classification authority threw
 * a TypeError instead of fail-closing, taking the whole assistant turn with it.
 *
 * These are security tests, not tidiness tests: `classifyToolAction` is the ONE
 * enforcement point for every CLI backend (all of them run with native
 * permissions bypassed), and a third-party MCP server chooses its own tool
 * names.
 */
import { describe, it, expect } from 'vitest';
import { parseToolName, normalizeToolName, toolKind, ACTION_TOOLS } from '../../src/utils/toolNames';
import { classifyToolAction, shouldGateToolUse } from '../../src/utils/permissionClassifier';
import type { Settings } from '../../src/types';

/** Every name that resolves to a member of `Object.prototype` when lowercased. */
const HOSTILE_NAMES = ['constructor', '__proto__', 'tostring', 'valueof', 'hasownproperty', 'isprototypeof'];

const SETTINGS: Settings = {
  provider: 'claude-code',
  mode: 'ask-before-edit',
  accessLevel: 'ask-permission',
} as unknown as Settings;

describe('CANVAS-LANE-07 — prototype-key tool names', () => {
  for (const name of HOSTILE_NAMES) {
    it(`parseToolName("${name}") returns a string name`, () => {
      const parsed = parseToolName(name);
      expect(typeof parsed.name).toBe('string');
      expect(parsed.name).toBe(name);
    });

    it(`parseToolName("mcp__evil__${name}") returns a string name`, () => {
      const parsed = parseToolName(`mcp__evil__${name}`);
      expect(typeof parsed.name).toBe('string');
      expect(parsed.name).toBe(name);
      expect(parsed.mcpServer).toBe('evil');
    });

    it(`normalizeToolName("${name}") returns a string`, () => {
      expect(typeof normalizeToolName(name)).toBe('string');
    });

    it(`classifyToolAction("${name}") fail-closes instead of throwing`, () => {
      expect(() => classifyToolAction(name)).not.toThrow();
      // Unknown tool ⇒ fail closed at command-level risk.
      expect(classifyToolAction(name)).toBe('bash-command');
    });

    it(`classifyToolAction("mcp__evil__${name}") fail-closes instead of throwing`, () => {
      expect(classifyToolAction(`mcp__evil__${name}`)).toBe('bash-command');
    });

    it(`toolKind("${name}") does not throw`, () => {
      expect(() => toolKind(name)).not.toThrow();
      expect(typeof toolKind(name)).toBe('string');
    });

    it(`shouldGateToolUse gates "${name}"`, () => {
      expect(shouldGateToolUse(SETTINGS, name)).toBe(true);
    });
  }

  it('ACTION_TOOLS does not inherit Object.prototype members', () => {
    // `ACTION_TOOLS['constructor']` being truthy would be RETURNED as a
    // PermissionActionType by classifyToolAction's `const known = ACTION_TOOLS[key]`.
    expect(ACTION_TOOLS['constructor' as string]).toBeUndefined();
    expect(ACTION_TOOLS['__proto__' as string]).toBeUndefined();
    expect(ACTION_TOOLS['hasownproperty' as string]).toBeUndefined();
  });
});
