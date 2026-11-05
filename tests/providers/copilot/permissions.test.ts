import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'github-copilot', ...overrides,
  };
}

/** Pretend discovery probed this `--version`. */
function pinVersion(provider: TestableCopilotProvider, version: string | null) {
  (provider as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = version;
}

describe('Copilot permission flag mapping', () => {
  let provider: TestableCopilotProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCopilotProvider();
    // Plan/read-only denials and the auto-approve combos are identical on both
    // CLI generations; the ask-tier split is covered in its own block below.
    pinVersion(provider, '1.0.83');
  });

  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should deny shell and write tools for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createCopilotSession());
    expect(args).toContain('--deny-tool');
    expect(args).toContain('shell');
    expect(args).toContain('write');
    expect(args).not.toContain('--allow-all-tools');
  });

  it('should deny shell and write tools for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createCopilotSession());
    expect(args).toContain('--deny-tool');
    expect(args).toContain('shell');
    expect(args).toContain('write');
    expect(args).not.toContain('--allow-all-tools');
  });

  // Auto-approve ONLY where the stream gate is intentionally off
  // (mirrors shouldGateToolUse — Copilot emits plain text, so the gate can
  // never fire and allow-all elsewhere would mean zero approval anywhere).
  it.each([
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'full-access' as const },
  ])('should use --allow-all-tools for mode=$mode access=$accessLevel (gate intentionally off)', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createCopilotSession());
    expect(args).toContain('--allow-all-tools');
    expect(args).not.toContain('--deny-tool');
  });

  describe('Ask needs a native approval channel on every CLI version', () => {
    for (const version of ['0.0.372', '1.0.83', null]) {
      it.each([
        { mode: 'default' as const, accessLevel: 'ask-permission' as const },
        { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
        { mode: 'ask-before-edit' as const, accessLevel: 'full-access' as const },
        { mode: 'edit-automatically' as const, accessLevel: 'ask-permission' as const },
      ])(`version ${version}: rejects mode=$mode access=$accessLevel before dispatch`, ({ mode, accessLevel }) => {
        pinVersion(provider, version);
        expect(() => provider.buildCliArgs(s({ mode, accessLevel }), createCopilotSession())).toThrow(/native approvals/);
      });
    }
    it('unknown version still uses modern JSON for an explicitly unrestricted turn', () => {
      pinVersion(provider, null);
      const args = provider.buildCliArgs(s({ accessLevel: 'full-access' }), createCopilotSession());
      expect(args.join(' ')).toContain('--output-format json');
      expect(args).toContain('--allow-all-tools');
    });
  });
});
