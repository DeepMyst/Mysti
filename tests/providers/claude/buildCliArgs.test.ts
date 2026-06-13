import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';
import type { ClaudeSessionState } from '../../../src/providers/claude/ClaudeCodeProvider';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default',
    thinkingLevel: 'none',
    accessLevel: 'ask-permission',
    contextMode: 'auto',
    model: 'claude-sonnet-4-5-20250929',
    provider: 'claude-code',
    ...overrides,
  };
}

describe('ClaudeCodeProvider.buildCliArgs', () => {
  let provider: TestableClaudeProvider;
  let session: ClaudeSessionState;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableClaudeProvider();
    session = createClaudeSession();
  });

  it('should include base flags', () => {
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--verbose');
    expect(args).toContain('--print');
  });

  it('should use plan permission mode for quick-plan', () => {
    const args = provider.buildCliArgs(defaultSettings({ mode: 'quick-plan' }), session);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('should use plan permission mode for read-only access', () => {
    const args = provider.buildCliArgs(defaultSettings({ accessLevel: 'read-only' }), session);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
  });

  it('should skip permissions for full-access + edit-automatically', () => {
    const args = provider.buildCliArgs(defaultSettings({
      accessLevel: 'full-access',
      mode: 'edit-automatically',
    }), session);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('should include --resume with session ID', () => {
    session.sessionId = 'sess_test123';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--resume');
    expect(args).toContain('sess_test123');
  });

  it('should not include --resume without session ID', () => {
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).not.toContain('--resume');
  });

  it('should include model from settings', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'claude-opus-4-6' }), session);
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4-6');
  });

  it('should prefer custom model from config over settings', () => {
    setMockConfig('claudeCodeModel', 'my-custom-model');
    const args = provider.buildCliArgs(defaultSettings({ model: 'claude-sonnet-4-5-20250929' }), session);
    expect(args).toContain('--model');
    expect(args).toContain('my-custom-model');
  });

  it('should include --append-system-prompt for channel context', () => {
    session.channelSystemContext = 'You are a helpful assistant';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('You are a helpful assistant');
  });

  // ==========================================================================
  // Issue #32 — 1M-context model claude-opus-4-6[1m]
  // ==========================================================================
  describe('1M context model (issue #32)', () => {
    // BaseCliProvider's shell-mode argument safety gate (BaseCliProvider.ts ~975).
    // Plan 01 Phase 2 relaxed this set to ADMIT square brackets ([ ]) — they are
    // glob characters, not shell-injection vectors, and the spawn path single-
    // quotes bracketed args (_quoteShellArgsForBrackets) so the model id reaches
    // the CLI verbatim. The gate still refuses genuine injection metacharacters.
    const SHELL_UNSAFE_ARG = /[;&|`$(){}<>!"'\\#~*?\n\r]/;
    const originalPlatform = process.platform;

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value: platform });
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should expose claude-opus-4-6[1m] in the model list with a 1M context window', () => {
      const entry = provider.config.models.find(m => m.id === 'claude-opus-4-6[1m]');
      expect(entry).toBeDefined();
      expect(entry?.contextWindow).toBe(1000000);
    });

    it('should pass the bracketed model verbatim as a single argv entry on non-shell spawn (macOS/Linux default)', () => {
      setPlatform('darwin');
      const args = provider.buildCliArgs(defaultSettings({ model: 'claude-opus-4-6[1m]' }), session);
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      // Array-args spawn — no shell interpretation, value must reach the CLI unmodified
      expect(args[modelIdx + 1]).toBe('claude-opus-4-6[1m]');
    });

    it('should pass the bracketed model verbatim on Windows (shell:true is always used there)', () => {
      // Plan 01 Phase 2 reconciliation (#32): buildCliArgs no longer strips the
      // bracket suffix on shell-mode platforms. The id reaches argv intact; the
      // spawn path single-quotes bracketed args for glob-safety. So the value
      // here must be the full bracketed id, not the stripped base.
      setPlatform('win32');
      const args = provider.buildCliArgs(defaultSettings({ model: 'claude-opus-4-6[1m]' }), session);
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(args[modelIdx + 1]).toBe('claude-opus-4-6[1m]');
      // The relaxed shell-mode gate no longer treats brackets as unsafe.
      for (const arg of args) {
        expect(SHELL_UNSAFE_ARG.test(arg)).toBe(false);
      }
    });

    it('should pass the bracketed model verbatim when mysti.useShellForCli is enabled on POSIX', () => {
      setPlatform('linux');
      setMockConfig('useShellForCli', true);
      const args = provider.buildCliArgs(defaultSettings({ model: 'claude-opus-4-6[1m]' }), session);
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe('claude-opus-4-6[1m]');
      // Brackets pass the relaxed gate; quoting (not stripping) handles glob-safety.
      for (const arg of args) {
        expect(SHELL_UNSAFE_ARG.test(arg)).toBe(false);
      }
    });

    it('should leave bracket-free models untouched on Windows', () => {
      setPlatform('win32');
      const args = provider.buildCliArgs(defaultSettings({ model: 'claude-opus-4-6' }), session);
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe('claude-opus-4-6');
    });
  });
});
