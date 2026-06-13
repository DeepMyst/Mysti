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
 * validateModelName tests (Plan 01 Phase 2 — relaxed MODEL_NAME_PATTERN).
 * Brackets / colons / slashes now pass (Claude 1M ids, org/model:variant);
 * shell metacharacters and spaces still fail (argv safety).
 */
import { describe, it, expect } from 'vitest';
import { validateModelName, MODEL_NAME_MAX_LENGTH } from '../../src/utils/validation';

describe('validateModelName', () => {
  describe('newly-admitted ids (Plan 01 Phase 2)', () => {
    const accepted = [
      'claude-opus-4-6[1m]',          // #32 — bracketed 1M-context suffix
      'sonnet[1m]',                    // alias + bracket suffix
      'openrouter:anthropic/claude',   // colon + slash
      'org/model:variant',             // slash + colon
      'anthropic/claude-sonnet-4-5',   // OpenCode provider/model form
      'claude-sonnet-4-5-20250929',    // dashed dated id
      'gpt-5.2',                        // dotted id
      'gemini-3-pro-preview',          // dashed id
      'qwen3-coder-plus',
      'opus',                           // bare alias
    ];

    for (const model of accepted) {
      it(`accepts "${model}"`, () => {
        expect(validateModelName(model).valid).toBe(true);
      });
    }
  });

  describe('still rejected (argv / shell safety)', () => {
    const rejected: Array<[string, string]> = [
      ['claude opus 4', 'space'],
      ['model;rm -rf /', 'semicolon + space'],
      ['model|cat', 'pipe'],
      ['model&background', 'ampersand'],
      ['model`whoami`', 'backtick'],
      ['model$(id)', 'command substitution'],
      ['model>out', 'redirect'],
      ['model<in', 'redirect'],
      ['model{a,b}', 'brace expansion'],
      ['model*glob', 'asterisk glob'],
      ['model?q', 'question-mark glob'],
      ['model"quote', 'double quote'],
      ["model'quote", 'single quote'],
      ['model\\path', 'backslash'],
      ['model\nnewline', 'newline'],
      ['-leading-dash', 'leading dash (not alnum)'],
      ['/leading-slash', 'leading slash (not alnum)'],
      ['[leading-bracket', 'leading bracket (not alnum)'],
    ];

    for (const [model, reason] of rejected) {
      it(`rejects ${reason}: ${JSON.stringify(model)}`, () => {
        expect(validateModelName(model).valid).toBe(false);
      });
    }
  });

  describe('boundary cases', () => {
    it('rejects empty / whitespace-only', () => {
      expect(validateModelName('').valid).toBe(false);
      expect(validateModelName('   ').valid).toBe(false);
    });

    it('rejects ids longer than MODEL_NAME_MAX_LENGTH', () => {
      const tooLong = 'a'.repeat(MODEL_NAME_MAX_LENGTH + 1);
      expect(validateModelName(tooLong).valid).toBe(false);
    });

    it('accepts an id at exactly MODEL_NAME_MAX_LENGTH', () => {
      const atMax = 'a'.repeat(MODEL_NAME_MAX_LENGTH);
      expect(validateModelName(atMax).valid).toBe(true);
    });

    it('trims surrounding whitespace before validating', () => {
      expect(validateModelName('  claude-opus-4-6[1m]  ').valid).toBe(true);
    });
  });
});
