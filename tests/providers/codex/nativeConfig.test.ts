/** Inert configuration fixtures only. Never starts Codex or reads an auth store. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertCodexServerConfigSafe, captureCodexNativeConfig, CODEX_NATIVE_CONFIG_OVERRIDES,
} from '../../../src/providers/codex/CodexNativeConfig';

const roots: string[] = [];
const hostPlatform = process.platform;
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(config = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-codex-config-'));
  roots.push(root);
  const userConfigDirectory = path.join(root, 'user-config');
  const systemConfigDirectory = path.join(root, 'system-config');
  const cwd = path.join(root, 'project', 'nested');
  await Promise.all([userConfigDirectory, systemConfigDirectory, cwd].map(directory => fs.mkdir(directory, { recursive: true })));
  if (config) { await fs.writeFile(path.join(userConfigDirectory, 'config.toml'), config); }
  const inspection = { userConfigDirectory, systemConfigDirectory, managedPreferencesPresent: async () => false };
  return { root, cwd, inspection, capture: () => captureCodexNativeConfig(cwd, {}, inspection) };
}

function nativeConfig(): { config: Record<string, unknown>; layers: unknown[] } {
  const config: Record<string, unknown> = {};
  for (const override of CODEX_NATIVE_CONFIG_OVERRIDES) {
    const index = override.indexOf('=');
    const parts = override.slice(0, index).split('.');
    let current = config;
    for (const part of parts.slice(0, -1)) {
      if (!current[part]) { current[part] = {}; }
      current = current[part] as Record<string, unknown>;
    }
    current[parts.at(-1)!] = JSON.parse(override.slice(index + 1));
  }
  return { config, layers: [{ name: { type: 'system' } }, { name: { type: 'user', profile: null } }, { name: { type: 'sessionFlags' } }] };
}

describe('Codex native configuration authority', () => {
  // These fixtures inspect POSIX policy layers. The native Windows boundary
  // is exercised separately below; it rejects before looking at any files.
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  it('accepts ordinary model, provider, auth method and project trust settings without reading auth files', async () => {
    const item = await fixture(`model = "a-model" # ordinary model selection
model_reasoning_effort = 'high'
approval_policy = "never"
sandbox_mode = "danger-full-access"
cli_auth_credentials_store = "keyring"
[projects."/workspace.with.dots/#literal"]
trust_level = "trusted"
[model_providers.local]
name = "local"
base_url = "http://127.0.0.1:10000/v1"
env_key = "MYSTI_INERT_MODEL_KEY"
wire_api = "responses"
requires_openai_auth = false
`);
    // A broken link would fail if the guard tried to inspect this credential store.
    await fs.symlink('/nonexistent/mysti-auth-store', path.join(item.inspection.userConfigDirectory, 'auth.json'));
    await expect(item.capture()).resolves.toHaveProperty('assertUnchanged');
    const snapshot = await item.capture();
    await expect(snapshot.assertUnchanged()).resolves.toBeUndefined();
  });

  it.each([
    '[mcp_servers.local]\ncommand = "do-not-run"',
    '["mcp_servers".local]\ncommand = "do-not-run"',
    '"mcp_servers".local.command = "do-not-run"',
    '[mcp_servers]',
    '[plugins.custom]\nenabled = true',
    '[hooks]\nPreToolUse = []',
    '[profiles.work]\nmodel = "a-model"',
    'profile = "work"',
    '[agents.custom]\nconfig_file = "hidden.toml"',
    'model_catalog_json = "hidden-tools.json"',
    'shell_environment_policy.set = { DANGEROUS = "value" }',
    'model = """multiline\ncontent"""',
    'model = "safe"\nmodel = "different"',
    '[model_providers.local]\nhttp_headers_helper = "do-not-run"',
    'features = { hooks = true }',
    'notify = ["do-not-run"]',
  ])('rejects unverified authority or unsupported TOML: %s', async config => {
    const item = await fixture(config);
    await expect(item.capture()).rejects.toThrow('cannot verify this configuration');
  });

  it('does not confuse commented authority or quoted # and = characters with executable configuration', async () => {
    const item = await fixture('# [mcp_servers.hidden]\nmodel = "value#=still-a-string"\n# command = "none"\n');
    await expect(item.capture()).resolves.toBeDefined();
  });

  it.each(['user', 'system', 'ancestor'])('rejects native allow rules from the %s layer without opening them', async layer => {
    const item = await fixture();
    const directory = layer === 'user' ? item.inspection.userConfigDirectory
      : layer === 'system' ? item.inspection.systemConfigDirectory : path.join(item.root, '.codex');
    await fs.mkdir(path.join(directory, 'rules'), { recursive: true });
    await fs.symlink('/unreadable/mysti-rule', path.join(directory, 'rules', 'default.rules'));
    await expect(item.capture()).rejects.toThrow('native .rules files can bypass host approval');
  });

  it('inspects root-checkout rules for a linked worktree', async () => {
    const item = await fixture();
    const main = path.join(item.root, 'main-checkout');
    const worktreeGit = path.join(main, '.git', 'worktrees', 'linked');
    await fs.mkdir(worktreeGit, { recursive: true });
    await fs.writeFile(path.join(item.cwd, '.git'), `gitdir: ${worktreeGit}\n`);
    await fs.writeFile(path.join(worktreeGit, 'commondir'), '../..\n');
    await fs.mkdir(path.join(main, '.codex', 'rules'), { recursive: true });
    await fs.writeFile(path.join(main, '.codex', 'rules', 'allow.rules'), 'not read');
    await expect(item.capture()).rejects.toThrow('native .rules files can bypass host approval');
  });

  it.each(['managed_config.toml', 'requirements.toml', 'hooks.json'])('rejects a %s authority source even when empty', async name => {
    const item = await fixture();
    await fs.writeFile(path.join(item.inspection.systemConfigDirectory, name), '');
    await expect(item.capture()).rejects.toThrow(`${name} requires a separate native authority review`);
  });

  it('rejects managed preferences before reading any configuration file', async () => {
    const item = await fixture();
    await fs.symlink('/nonexistent/invalid-config-source', path.join(item.inspection.userConfigDirectory, 'config.toml'));
    await expect(captureCodexNativeConfig(item.cwd, {}, { ...item.inspection, managedPreferencesPresent: async () => true }))
      .rejects.toThrow('managed preferences');
  });

  it('rejects configuration symlinks and hides rejected values in its error', async () => {
    const item = await fixture('unknown_option = "SECRET-MUST-NOT-APPEAR"');
    await expect(item.capture()).rejects.not.toThrow('SECRET-MUST-NOT-APPEAR');
    const filename = path.join(item.inspection.userConfigDirectory, 'config.toml');
    await fs.unlink(filename);
    await fs.symlink('/nonexistent/mysti-config', filename);
    await expect(item.capture()).rejects.toThrow('bounded regular files');
  });

  it('detects new rule files after the initial preflight', async () => {
    const item = await fixture();
    const snapshot = await item.capture();
    await fs.mkdir(path.join(item.inspection.userConfigDirectory, 'rules'));
    await fs.writeFile(path.join(item.inspection.userConfigDirectory, 'rules', 'later.rules'), 'not read');
    await expect(snapshot.assertUnchanged()).rejects.toThrow('native .rules files');
  });

  it('detects changed or removed config files after the native thread loads policy', async () => {
    const item = await fixture('model = "first"');
    const filename = path.join(item.inspection.userConfigDirectory, 'config.toml');
    const snapshot = await item.capture();
    await fs.writeFile(filename, 'model = "other"');
    await expect(snapshot.assertUnchanged()).rejects.toThrow('configuration changed');
    await fs.unlink(filename);
    await expect(snapshot.assertUnchanged()).rejects.toThrow('configuration changed');
  });

  it('detects a new ancestor project configuration after preflight', async () => {
    const item = await fixture();
    const snapshot = await item.capture();
    await fs.mkdir(path.join(item.root, '.codex'));
    await fs.writeFile(path.join(item.root, '.codex', 'config.toml'), 'model = "new"');
    await expect(snapshot.assertUnchanged()).rejects.toThrow('configuration changed');
  });

  it('requires absolute inspection paths without changing environment variables', async () => {
    const item = await fixture();
    const environment = Object.freeze({ MYSTI_INERT_VALUE: 'preserved' });
    await expect(captureCodexNativeConfig(item.cwd, environment, item.inspection)).resolves.toBeDefined();
    expect(environment.MYSTI_INERT_VALUE).toBe('preserved');
    await expect(captureCodexNativeConfig(item.cwd, environment, { ...item.inspection, userConfigDirectory: 'relative' }))
      .rejects.toThrow('must be absolute');
  });
});

it('rejects Windows native configuration before inspecting the filesystem', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  await expect(captureCodexNativeConfig('not-an-existing-workspace', {}))
    .rejects.toThrow('Windows native configuration and process ownership are not supported yet');
});

describe('Codex native effective configuration attestation', () => {
  it('requires every forced sandbox, approval and tool source override', () => {
    expect(() => assertCodexServerConfigSafe(nativeConfig(), { requirements: null })).not.toThrow();
    const readonly = nativeConfig();
    readonly.config.sandbox_mode = 'workspace-write';
    expect(() => assertCodexServerConfigSafe(readonly, { requirements: null })).toThrow('sandbox_mode');
    const hooks = nativeConfig();
    (hooks.config.features as Record<string, unknown>).hooks = true;
    expect(() => assertCodexServerConfigSafe(hooks, { requirements: null })).toThrow('features.hooks');
  });

  it.each([{}, null, { requirements: {} }, { requirements: { allowedApprovalPolicies: null } }])('rejects absent or non-null managed requirements: %j', requirements => {
    expect(() => assertCodexServerConfigSafe(nativeConfig(), requirements)).toThrow('managed requirements');
  });

  it.each(['mdm', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm', 'futureAuthority'])('rejects %s origins, including disabled provenance', type => {
    const response = nativeConfig();
    response.layers.push({ name: { type }, disabledReason: 'not trusted' });
    expect(() => assertCodexServerConfigSafe(response, { requirements: null })).toThrow('configuration source');
  });

  it('rejects native MCP servers and profiles that do not appear in the local allowed snapshot', () => {
    for (const extra of [{ mcp_servers: { hidden: { command: 'not run' } } }, { profiles: { hidden: {} } }, { profile: 'hidden' }]) {
      const response = nativeConfig();
      Object.assign(response.config, extra);
      expect(() => assertCodexServerConfigSafe(response, { requirements: null })).toThrow('profiles or MCP');
    }
    const response = nativeConfig();
    response.layers.push({ name: { type: 'user', profile: 'work' } });
    expect(() => assertCodexServerConfigSafe(response, { requirements: null })).toThrow('named profiles');
  });

  it('requires stdin approval and disables login shells and native snapshot hooks', () => {
    expect(CODEX_NATIVE_CONFIG_OVERRIDES).toContain('features.write_stdin_approval=true');
    expect(CODEX_NATIVE_CONFIG_OVERRIDES).toContain('allow_login_shell=false');
    expect(CODEX_NATIVE_CONFIG_OVERRIDES).toContain('features.shell_zsh_fork=false');
    expect(CODEX_NATIVE_CONFIG_OVERRIDES).not.toContain('approval_policy="untrusted"');
    const response = nativeConfig();
    (response.config.features as Record<string, unknown>).write_stdin_approval = false;
    expect(() => assertCodexServerConfigSafe(response, { requirements: null })).toThrow('write_stdin_approval');
  });
});
