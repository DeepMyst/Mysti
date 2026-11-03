/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Externally reported: the read-only allowlist matched on the bare name after
 * `mcp__<server>__` was stripped, so `search` on a connected mail/docs server
 * ran with no card — and was ALLOWED in read-only mode. Built-ins only.
 */
import { describe, it, expect } from 'vitest';
import { classifyToolAction, shouldGateToolUse } from '../../src/utils/permissionClassifier';
import { nativeToolDecision } from '../../src/providers/base/NativeApprovalPolicy';
import type { Settings } from '../../src/types';

const ask: Pick<Settings, 'mode' | 'accessLevel'> = { mode: 'ask-before-edit', accessLevel: 'ask-permission' };
const readOnly: Pick<Settings, 'mode' | 'accessLevel'> = { mode: 'default', accessLevel: 'read-only' };

describe('read-only allowlist requires built-in provenance', () => {
  for (const tool of ['search', 'read', 'list', 'Read', 'grep', 'read_file', 'list_directory']) {
    const mcp = `mcp__gmail__${tool}`;

    it(`${mcp} is not file-read and is gated`, () => {
      expect(classifyToolAction(mcp)).not.toBe('file-read');
      expect(shouldGateToolUse(ask, mcp)).toBe(true);
    });

    it(`${mcp} is denied in read-only mode`, () => {
      expect(nativeToolDecision(readOnly, mcp)).toBe('deny');
    });
  }

  it('built-in reads are still never gated', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'search', 'list']) {
      expect(classifyToolAction(tool)).toBe('file-read');
      expect(nativeToolDecision(readOnly, tool)).toBe('allow');
    }
  });
});
