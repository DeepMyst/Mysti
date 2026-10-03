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

  /**
   * Ask-tier is the case Copilot CLI 1.0 changed.
   *
   * On 0.0.x the stream was plain text: no tool_use chunk ever reached Mysti's
   * gate, so there was nothing to approve and the only safe answer was to deny
   * shell and write outright — which also meant those tools were unusable in
   * ask-tier. 1.0's `--output-format json` carries tool.execution_start, so
   * Copilot is now gated the same way every other backend is.
   */
  describe('ask-tier depends on whether the CLI can report tool events', () => {
    const askTier = [
      { mode: 'default' as const, accessLevel: 'ask-permission' as const },
      { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
      { mode: 'ask-before-edit' as const, accessLevel: 'full-access' as const },
      { mode: 'edit-automatically' as const, accessLevel: 'ask-permission' as const },
    ];

    it.each(askTier)(
      'Copilot 1.0+: gated by Mysti for mode=$mode access=$accessLevel',
      ({ mode, accessLevel }) => {
        pinVersion(provider, '1.0.83');
        const args = provider.buildCliArgs(s({ mode, accessLevel }), createCopilotSession());
        // The CLI stops prompting (it cannot, through a pipe); Mysti's
        // stream-level gate approves each tool instead.
        expect(args).toContain('--allow-all-tools');
        expect(args).not.toContain('--deny-tool');
        expect(args.join(' ')).toContain('--output-format json');
      },
    );

    it.each(askTier)(
      'Copilot 0.0.x: still fails closed for mode=$mode access=$accessLevel',
      ({ mode, accessLevel }) => {
        pinVersion(provider, '0.0.372');
        const args = provider.buildCliArgs(s({ mode, accessLevel }), createCopilotSession());
        expect(args).toContain('--deny-tool');
        expect(args).toContain('shell');
        expect(args).toContain('write');
        expect(args).not.toContain('--allow-all-tools');
        // 0.0.x has no --output-format; passing it aborts the run.
        expect(args).not.toContain('--output-format');
      },
    );

    /**
     * An unprobed version must not silently drop a current install onto the
     * ungated plain-text path — that would leave shell and write unusable.
     */
    it('assumes the current CLI when the version is unknown', () => {
      pinVersion(provider, null);
      const args = provider.buildCliArgs(s({ accessLevel: 'ask-permission' }), createCopilotSession());
      expect(args.join(' ')).toContain('--output-format json');
      expect(args).toContain('--allow-all-tools');
    });
  });
});
