import { describe, expect, it } from 'vitest';
import { TestableClaudeProvider, TestableCodexProvider, TestableGeminiProvider, TestableClineProvider, TestableQwenProvider, TestableCopilotProvider, TestableOpenCodeProvider, TestableOpenClawProvider } from '../helpers/providerFactory';
import { CLAUDE_NATIVE_VERSIONS } from '../../src/providers/claude/ClaudeApproval';
import { CODEX_APP_SERVER_VERSION } from '../../src/providers/codex/CodexAppServer';
import { GEMINI_ACP_VERSION } from '../../src/providers/gemini/GeminiNativeApproval';
import { VERIFIED_NATIVE_CLI_VERSIONS, getVerifiedNativeCliVersion } from '../../src/providers/base/NativeCliVersions';

describe('core native compatibility metadata', () => {
  it('keeps installer targets and native attestation on the same verified releases', () => {
    const rows = [
      [new TestableClaudeProvider(), '@anthropic-ai/claude-code', [...CLAUDE_NATIVE_VERSIONS][0]],
      [new TestableCodexProvider(), '@openai/codex', CODEX_APP_SERVER_VERSION],
      [new TestableGeminiProvider(), '@google/gemini-cli', GEMINI_ACP_VERSION],
      [new TestableClineProvider(), 'cline', VERIFIED_NATIVE_CLI_VERSIONS.cline],
      [new TestableQwenProvider(), '@qwen-code/qwen-code', VERIFIED_NATIVE_CLI_VERSIONS['qwen-code']],
      [new TestableCopilotProvider(), '@github/copilot', VERIFIED_NATIVE_CLI_VERSIONS['github-copilot']],
      [new TestableOpenCodeProvider(), 'opencode-ai', VERIFIED_NATIVE_CLI_VERSIONS.opencode],
    ] as const;
    for (const [provider, pkg, version] of rows) {
      expect(provider.getInstallCommand().replace(/^npm i /, 'npm install ')).toBe(`npm install -g ${pkg}@${version}`);
      expect(getVerifiedNativeCliVersion(provider.id)).toBe(version);
    }
    expect(getVerifiedNativeCliVersion('constructor')).toBeUndefined();
    expect(getVerifiedNativeCliVersion('not-a-provider')).toBeUndefined();
    expect(Object.isFrozen(VERIFIED_NATIVE_CLI_VERSIONS)).toBe(true);
  });

  it('does not advertise retired Codex Spark or Gemini 3 Pro Preview to new selections', () => {
    const codex = new TestableCodexProvider();
    const gemini = new TestableGeminiProvider();
    expect(codex.config.models.some(model => model.id === 'gpt-5.3-codex-spark')).toBe(false);
    expect(gemini.config.models.some(model => model.id === 'gemini-3-pro-preview')).toBe(false);
    expect(codex.config.models.find(model => model.id === 'gpt-5.5')?.description).toContain('October 14, 2026');
    expect(codex.config.models.some(model => model.id === codex.config.defaultModel)).toBe(true);
    expect(gemini.config.models.some(model => model.id === gemini.config.defaultModel)).toBe(true);
  });

  it('keeps OpenClaw install/update metadata aligned with its standalone owned-runtime attestation', async () => {
    // Import the shipped manifest only; no installed runtime or account is used.
    const { OPENCLAW_VERSION } = await import('../../resources/openclaw-policy/runtime-manifest.mjs');
    const provider = new TestableOpenClawProvider();
    const version = getVerifiedNativeCliVersion(provider.id);
    expect(version).toBe(OPENCLAW_VERSION);
    expect(provider.getInstallCommand()).toBe(`npm install -g openclaw@${version} && openclaw onboard --install-daemon`);
    expect(provider.getInstallMethods().map(method => method.command)).toEqual([
      `npm install -g openclaw@${version}`,
      `npm install -g openclaw@${version} && openclaw onboard --install-daemon`,
    ]);
    provider.dispose();
  });
});
