/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * `opencode models --verbose` carries each model's window (`limit.context`);
 * the plain listing Mysti used to parse did not, so every model read as 200k.
 */
import { describe, it, expect } from 'vitest';
import { parseOpencodeModels } from '../../../src/providers/opencode/OpenCodeProvider';

// Shape of real `opencode models --verbose` output (1.18.29), trimmed.
const VERBOSE = `opencode/ling-3.0-flash-fin-free
{
  "id": "ling-3.0-flash-fin-free",
  "providerID": "opencode",
  "api": { "url": "https://opencode.ai/zen/v1", "npm": "@ai-sdk/openai-compatible" },
  "limit": {
    "context": 262144,
    "output": 32768
  }
}
opencode/big-pickle
{
  "id": "big-pickle",
  "limit": { "context": 200000, "input": 160000, "output": 32000 }
}
`;

describe('parseOpencodeModels', () => {
  it('reads each model window from the verbose listing', () => {
    expect(parseOpencodeModels(VERBOSE)).toEqual([
      { id: 'opencode/ling-3.0-flash-fin-free', name: 'opencode/ling-3.0-flash-fin-free', contextWindow: 262144 },
      { id: 'opencode/big-pickle', name: 'opencode/big-pickle', contextWindow: 200000 },
    ]);
  });

  it('still takes the plain listing (older CLI): ids, no windows, no duplicates', () => {
    expect(parseOpencodeModels('opencode/a\nanthropic/claude-x\nopencode/a\nsome log line\n')).toEqual([
      { id: 'opencode/a', name: 'opencode/a' },
      { id: 'anthropic/claude-x', name: 'anthropic/claude-x' },
    ]);
  });
});
