/* PB-03 preparation/preflight only. Importing this module never starts Gemini. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const jsonc = require('jsonc-parser');
const OWNED_ROOT = path.resolve(__dirname, '../../out-test/feature-tests/PB-03');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = file => ({ path: fs.realpathSync(file), sha256: hash(fs.readFileSync(file)) });
function refuse(code) { const error = new Error(code); error.code = code; throw error; }
function inside(parent, child) {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function owned(file) {
  if (!inside(OWNED_ROOT, file)) refuse('OWNED_REALPATH_REQUIRED');
  return fs.realpathSync(file);
}
function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, file: { path: path.resolve(file), exists: false } };
  const bytes = fs.readFileSync(file);
  if (bytes.length > 1024 * 1024) refuse('SETTINGS_TOO_LARGE');
  const errors = [];
  const tree = jsonc.parseTree(bytes.toString('utf8'), errors, { allowTrailingComma: false, disallowComments: false });
  if (errors.length || tree?.type !== 'object') refuse('SETTINGS_PARSE_REJECTED');
  const visit = node => {
    if (node.type === 'object') {
      const keys = new Set();
      for (const item of node.children || []) {
        const key = item.children[0].value;
        if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) refuse('SETTINGS_DUPLICATE_OR_UNSAFE_KEY');
        keys.add(key);
      }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  // Configuration values are held in RAM only; callers serialize the metadata.
  return { settings: jsonc.getNodeValue(tree), file: { ...identity(file), exists: true } };
}
function migrationKeys(settings) {
  const keys = [];
  const boolean = (value, name) => { if (typeof value === 'boolean') keys.push(name); };
  boolean(settings.general?.disableAutoUpdate, 'general.disableAutoUpdate');
  boolean(settings.general?.disableUpdateNag, 'general.disableUpdateNag');
  boolean(settings.ui?.accessibility?.disableLoadingPhrases, 'ui.accessibility.disableLoadingPhrases');
  if (settings.ui?.accessibility?.enableLoadingPhrases === false && settings.ui?.loadingPhrases === undefined) keys.push('ui.accessibility.enableLoadingPhrases');
  boolean(settings.context?.fileFiltering?.disableFuzzySearch, 'context.fileFiltering.disableFuzzySearch');
  if (settings.tools?.approvalMode !== undefined) keys.push('tools.approvalMode');
  for (const key of ['codebaseInvestigatorSettings', 'cliHelpAgentSettings', 'plan']) {
    if (settings.experimental?.[key] !== undefined) keys.push(`experimental.${key}`);
  }
  return keys;
}
function inspectUnownedSettings(settings, sentinel) {
  if (migrationKeys(settings).length) refuse('SETTINGS_MIGRATION_WOULD_WRITE');
  for (const name of ['general', 'ui', 'context', 'tools', 'security', 'experimental', 'mcp', 'mcpServers']) {
    if (settings[name] !== undefined && (settings[name] === null || typeof settings[name] !== 'object' || Array.isArray(settings[name]))) refuse('SETTINGS_UNSUPPORTED_STRUCTURE');
  }
  if (settings.context?.includeDirectories !== undefined && (!Array.isArray(settings.context.includeDirectories) || settings.context.includeDirectories.length)) refuse('INHERITED_DIRECTORY_SCOPE_REQUIRES_REVIEW');
  if (settings.adminPolicyPaths?.length || settings.policyPaths?.length) refuse('CONFIGURED_POLICIES_REQUIRE_REVIEW');
  // Do not weaken a user's configured sandbox or silently start its runtime.
  if (settings.tools?.sandbox || settings.security?.toolSandboxing) refuse('CONFIGURED_SANDBOX_REQUIRES_REVIEW');
  if (Object.hasOwn(settings.mcpServers || {}, sentinel)) refuse('MCP_SENTINEL_COLLISION');
}
function inspectPolicyDirectory(directory) {
  if (!fs.existsSync(directory)) return { path: path.resolve(directory), exists: false, tomlFiles: 0 };
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) refuse('POLICY_DIRECTORY_REQUIRES_REVIEW');
  // A conservative stop preserves administrator policy. No regex attempts to
  // certify executable safety-checker TOML; a parser-backed review is separate.
  if (fs.readdirSync(directory).some(name => name.endsWith('.toml'))) refuse('EXISTING_POLICIES_REQUIRE_REVIEW');
  return { path: fs.realpathSync(directory), exists: true, tomlFiles: 0 };
}
function snapshotInstalledRuntime(packageRoot, node) {
  packageRoot = fs.realpathSync(packageRoot);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
  if (metadata.name !== '@google/gemini-cli' || metadata.version !== '0.58.0') refuse('UNREVIEWED_GEMINI_VERSION');
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) refuse('RUNTIME_SYMLINK_REQUIRES_REVIEW');
      if (entry.isDirectory()) visit(file);
      else {
        if (!entry.isFile()) refuse('RUNTIME_SPECIAL_FILE');
        files.push({ relative: path.relative(packageRoot, file), sha256: hash(fs.readFileSync(file)), bytes: fs.statSync(file).size });
      }
    }
  }
  visit(path.join(packageRoot, 'bundle'));
  files.push({ relative: 'package.json', sha256: hash(fs.readFileSync(path.join(packageRoot, 'package.json'))), bytes: fs.statSync(path.join(packageRoot, 'package.json')).size });
  return { packageRoot, version: metadata.version, entry: identity(path.join(packageRoot, 'bundle/gemini.js')), node: identity(node), files,
    scope: 'Entire installed bundle tree plus package.json; recorded without importing or executing the CLI.' };
}
function verifyRuntime(snapshot) {
  const current = snapshotInstalledRuntime(snapshot.packageRoot, snapshot.node.path);
  assert.deepEqual(current, snapshot, 'Pinned Gemini runtime changed');
}
function settingsFor(contextName) {
  return {
    hooksConfig: { enabled: false }, skills: { enabled: false },
    tools: { core: ['read_file'], discoveryCommand: '', callCommand: '', useRipgrep: false },
    mcp: { serverCommand: '' },
    experimental: { autoMemory: false, enableAgents: false, worktrees: false, extensionManagement: false,
      extensionConfig: false, extensionRegistry: false, gemmaModelRouter: { enabled: false } },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false, checkpointing: { enabled: false } },
    context: { fileName: contextName, includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false },
    telemetry: { enabled: false, logPrompts: false }, privacy: { usageStatisticsEnabled: false },
  };
}
function policyFor(allowedFiles) {
  const escaped = allowedFiles.map(file => JSON.stringify(file).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = `"file_path"\\s*:\\s*"(?:${escaped.join('|')})"`;
  if (pattern.includes("'") || /[\r\n]/.test(pattern)) refuse('POLICY_PATH_ENCODING_REQUIRES_REVIEW');
  return `# Owned PB03 read-only review. No tool outside the explicit paths is allowed.\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n\n[[rule]]\ntoolName = "read_file"\nargsPattern = '${pattern}'\ndecision = "allow"\npriority = 999\n`;
}
function prepareOwnedContract({ artifactDir, workspace, allowedFiles, model, runtime, maxInputs = 3 }) {
  artifactDir = owned(artifactDir); workspace = owned(workspace);
  if (!inside(artifactDir, workspace)) refuse('WORKSPACE_MUST_BELONG_TO_ATTEMPT');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(model)) refuse('EXPLICIT_MODEL_REQUIRED');
  if (!Number.isInteger(maxInputs) || maxInputs < 1 || maxInputs > 6) refuse('BOUNDED_INPUT_CAP_REQUIRED');
  allowedFiles = allowedFiles.map(file => {
    const real = owned(file); if (!inside(workspace, real) || !fs.statSync(real).isFile()) refuse('OWNED_READ_FILES_REQUIRED'); return real;
  });
  if (!allowedFiles.length || new Set(allowedFiles).size !== allowedFiles.length) refuse('EXACT_READ_ALLOWLIST_REQUIRED');
  const configDir = path.join(artifactDir, 'gemini-isolation'); fs.mkdirSync(configDir);
  const geminiDir = path.join(workspace, '.gemini'); fs.mkdirSync(geminiDir, { recursive: true });
  const sentinel = `pb03-no-mcp-${randomBytes(24).toString('hex')}`;
  const contextName = `PB03_CONTEXT_${randomBytes(12).toString('hex')}.md`;
  const systemSettings = path.join(configDir, 'settings.json'), defaults = path.join(configDir, 'system-defaults.json');
  const policy = path.join(configDir, 'readonly.toml'), localEnv = path.join(geminiDir, '.env');
  const workspaceSettings = path.join(geminiDir, 'settings.json');
  for (const [file, bytes] of [[systemSettings, JSON.stringify(settingsFor(contextName), null, 2)], [defaults, '{}'],
    [policy, policyFor(allowedFiles)], [localEnv, ''], [workspaceSettings, '{}']]) fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return { case: 'PB-03', stage: 'PREFLIGHT_ONLY', artifactDir, workspace, model, maxInputs, sentinel, contextName, runtime,
    allowedFiles: allowedFiles.map(identity), files: { systemSettings: identity(systemSettings), defaults: identity(defaults), policy: identity(policy), localEnv: identity(localEnv), workspaceSettings: identity(workspaceSettings) },
    injectedArgs: ['--extensions', 'none', '--allowed-mcp-server-names', sentinel, '--policy', policy],
    injectedEnvironment: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettings, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults },
    limitations: ['These are declared harness restrictions in addition to product Plan mode; not proof of unrestricted product permission enforcement.',
      'Remote MCP names are filtered by a fresh unconfigured opaque allowlist sentinel; managed policies remain applicable.',
      'Configured policies/sandboxes require separate review. No user or auth configuration is rewritten.',
      'Native CLI credential refresh/cache behavior is not executed or validated by this preparation.'] };
}
function verifyContract(contract) {
  if (contract.case !== 'PB-03' || contract.stage !== 'PREFLIGHT_ONLY') refuse('OWNED_CONTRACT_REQUIRED');
  owned(contract.artifactDir); owned(contract.workspace);
  if (!inside(contract.artifactDir, contract.workspace)) refuse('WORKSPACE_MUST_BELONG_TO_ATTEMPT');
  for (const file of [...Object.values(contract.files), ...contract.allowedFiles]) {
    owned(file.path); if (!inside(contract.artifactDir, file.path)) refuse('OWNED_CONFIG_ESCAPE');
    if (hash(fs.readFileSync(file.path)) !== file.sha256) refuse('OWNED_FILE_CHANGED');
  }
  assert.deepEqual(readSettings(contract.files.systemSettings.path).settings, settingsFor(contract.contextName));
  assert.equal(fs.readFileSync(contract.files.policy.path, 'utf8'), policyFor(contract.allowedFiles.map(file => file.path)));
  assert.equal(fs.readFileSync(contract.files.localEnv.path).length, 0);
  assert.deepEqual(readSettings(contract.files.workspaceSettings.path).settings, {});
  assert.deepEqual(readSettings(contract.files.defaults.path).settings, {});
  assert.deepEqual(contract.injectedArgs, ['--extensions', 'none', '--allowed-mcp-server-names', contract.sentinel, '--policy', contract.files.policy.path]);
  assert.deepEqual(contract.injectedEnvironment, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: contract.files.systemSettings.path, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: contract.files.defaults.path });
  verifyRuntime(contract.runtime);
}
function inspectConfigFiles({ contract, userSettingsPath, fixedPoliciesDir, userPoliciesDir, env }) {
  verifyContract(contract);
  const user = readSettings(userSettingsPath);
  inspectUnownedSettings(user.settings, contract.sentinel);
  for (const key of ['GEMINI_SYSTEM_MD', 'GEMINI_CLI_ACTIVITY_LOG_TARGET', 'GEMINI_CLI_EXTENSION_REGISTRY_URI']) {
    if (env[key]) refuse('INHERITED_STARTUP_OVERRIDE_REQUIRES_REVIEW');
  }
  if (env.GEMINI_CLI_IDE_WORKSPACE_PATH) {
    const entries = env.GEMINI_CLI_IDE_WORKSPACE_PATH.split(path.delimiter).filter(Boolean);
    if (entries.some(file => fs.realpathSync(file) !== contract.workspace)) refuse('IDE_DIRECTORY_SCOPE_REQUIRES_REVIEW');
  }
  const globalContext = path.join(path.dirname(userSettingsPath), contract.contextName);
  if (fs.existsSync(globalContext)) refuse('OWNED_CONTEXT_NAME_COLLISION');
  const policyDirectories = [fixedPoliciesDir, userPoliciesDir, path.join(contract.workspace, '.gemini/policies')].map(inspectPolicyDirectory);
  return { status: 'PASS_STATIC_PREFLIGHT', userSettings: user.file, policyDirectories, runtimeEntry: contract.runtime.entry,
    ownedFiles: contract.files, allowedFiles: contract.allowedFiles, argvRestrictions: contract.injectedArgs,
    preservedAuthenticationEnvironment: true, configMigrationPerformed: false, providerLaunches: 0, inferenceInputs: 0 };
}
function inspectCurrentConfiguration(contract, env = process.env) {
  const userRoot = env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
  const fixedRoot = process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli' : '/etc/gemini-cli';
  return inspectConfigFiles({ contract, env, userSettingsPath: path.join(userRoot, 'settings.json'),
    fixedPoliciesDir: path.join(fixedRoot, 'policies'), userPoliciesDir: path.join(userRoot, 'policies') });
}
module.exports = { OWNED_ROOT, identity, readSettings, migrationKeys, inspectUnownedSettings, inspectPolicyDirectory,
  snapshotInstalledRuntime, verifyRuntime, settingsFor, policyFor, prepareOwnedContract, verifyContract, inspectConfigFiles, inspectCurrentConfiguration };
