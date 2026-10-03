/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * review[20]: pins the P2.3 tier-routing / P0.2b precedence invariant — an
 * explicitly ROUTED model (Settings.routedModel, set by CollaboratorPool from a
 * delegation's spec.model) must WIN over a per-provider `mysti.<x>Model`
 * custom-model config in EVERY provider's _getEffectiveModel. This is enforced
 * by a hand-duplicated `if (settings.routedModel) return settings.routedModel`
 * at the top of 11 overrides + the base — nothing else guards that invariant, so
 * a copy-paste regression in any one provider would silently mis-route (a
 * tier="strong" task running on the user's pinned cheap model, or vice-versa).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setMockConfig, clearMockConfig } from '../helpers/mockVscode';
import {
  TestableClaudeProvider,
  TestableCodexProvider,
  TestableGeminiProvider,
} from '../helpers/providerFactory';
import type { Settings } from '../../src/types';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    mode: 'default',
    thinkingLevel: 'none',
    accessLevel: 'ask-permission',
    contextMode: 'auto',
    model: '',
    provider: 'claude-code',
    ...over,
  };
}

// Cast to reach the protected _getEffectiveModel for the invariant check.
type EffModel = { _getEffectiveModel(s: Settings): string | undefined };

const CASES = [
  { name: 'claude-code', cfgKey: 'claudeCodeModel', make: () => new TestableClaudeProvider() },
  { name: 'openai-codex', cfgKey: 'codexModel', make: () => new TestableCodexProvider() },
  { name: 'google-gemini', cfgKey: 'geminiModel', make: () => new TestableGeminiProvider() },
];

describe('routedModel precedence (P2.3 tier routing / review[20])', () => {
  beforeEach(() => { clearMockConfig(); });

  for (const c of CASES) {
    it(`${c.name}: routedModel WINS over the per-provider custom-model config`, () => {
      setMockConfig(c.cfgKey, 'user-pinned-model');
      const p = c.make() as unknown as EffModel;
      // With a routed model, it must win over BOTH the config custom-model and settings.model.
      expect(p._getEffectiveModel(settings({ model: 'dropdown-model', routedModel: 'tier-model' }))).toBe('tier-model');
      // Without a routed model, the per-provider custom-model config still applies.
      expect(p._getEffectiveModel(settings({ model: 'dropdown-model' }))).toBe('user-pinned-model');
    });
  }
});
