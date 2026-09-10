import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platform from '../../../src/utils/platform';
import { CLAUDE_NATIVE_POLICY } from '../../../src/providers/claude/ClaudeApproval';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';

const roots: string[] = [];
const settings: Settings = { provider: 'claude-code', mode: 'default', accessLevel: 'ask-permission', model: '', thinkingLevel: 'none', contextMode: 'auto' };
class PreflightClaude extends TestableClaudeProvider {
  verify(): Promise<void> { return this._validateNativeApprovalCli(createClaudeSession(), settings); }
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); }
});

async function harness(version: string | undefined = '2.1.266 (Claude Code)') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-claude-preflight-'));
  roots.push(root);
  const policyPath = path.join(root, 'resources/claude-policy/settings.json');
  await fs.mkdir(path.dirname(policyPath), { recursive: true });
  await fs.writeFile(policyPath, JSON.stringify(CLAUDE_NATIVE_POLICY));
  const cliPath = path.join(root, 'inert-cli');
  await fs.writeFile(cliPath, 'this inert version fixture is never executed');
  const probe = vi.spyOn(platform, 'probeCliVersion').mockResolvedValue(version);
  const provider = new PreflightClaude();
  (provider as unknown as { _extensionContext: { extensionPath: string } })._extensionContext.extensionPath = root;
  vi.spyOn(provider, 'getCliPath').mockReturnValue(cliPath);
  return { provider, probe, policyPath, cliPath };
}

describe('Claude permission bridge native preflight', () => {
  it.each(['2.0.71 (Claude Code)', '2.1.267 (Claude Code)', undefined])('refuses unverified version %s before model submission', async version => {
    const h = await harness(version);
    if (version === undefined) { h.probe.mockResolvedValue(undefined); }
    await expect(h.provider.verify()).rejects.toThrow(/Select Claude Code 2.1.266/);
    expect(h.probe).toHaveBeenCalledOnce();
  });

  it('reuses a verified executable identity and probes again when the file changes', async () => {
    const h = await harness();
    await h.provider.verify(); await h.provider.verify();
    expect(h.probe).toHaveBeenCalledOnce();
    await fs.appendFile(h.cliPath, ' changed');
    await h.provider.verify();
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it('verifies the policy again on every turn and rejects missing or changed ask rules', async () => {
    const h = await harness();
    await h.provider.verify();
    await fs.writeFile(h.policyPath, JSON.stringify({ disableAllHooks: true, permissions: { ask: [] } }));
    await expect(h.provider.verify()).rejects.toThrow(/policy is missing or changed/);
    expect(h.probe).toHaveBeenCalledOnce();
    await fs.rm(h.policyPath);
    await expect(h.provider.verify()).rejects.toThrow();
    expect(h.probe).toHaveBeenCalledOnce();
  });
});
