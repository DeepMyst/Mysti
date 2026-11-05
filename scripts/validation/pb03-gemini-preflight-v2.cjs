/* Additive PB-03 static preflight successor. No provider launch on import. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = require('./pb03-gemini-preflight.cjs');
function refuse(code) { const error = new Error(code); error.code = code; throw error; }
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function maybeStat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function canonicalOwned(file, type) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) refuse('OWNED_CANONICAL_PATH_REQUIRED');
  const absolute = path.resolve(file), root = fs.realpathSync(base.OWNED_ROOT);
  if (!inside(root, absolute)) refuse('OWNED_REALPATH_REQUIRED');
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) refuse('OWNED_SYMLINK_REJECTED');
  if (stat.uid !== process.getuid()) refuse('OWNED_UID_REQUIRED');
  if (type === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) refuse('OWNED_FILE_TYPE_REQUIRED');
  return absolute;
}
function limits(model, maxInputs) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(model)) refuse('EXPLICIT_MODEL_REQUIRED');
  if (!Number.isInteger(maxInputs) || maxInputs < 1 || maxInputs > 6) refuse('BOUNDED_INPUT_CAP_REQUIRED');
}
function locations(artifactDir, workspace) {
  artifactDir = canonicalOwned(artifactDir, 'directory');
  workspace = canonicalOwned(workspace, 'directory');
  if (!inside(artifactDir, workspace)) refuse('WORKSPACE_MUST_BELONG_TO_ATTEMPT');
  const geminiDir = path.join(workspace, '.gemini');
  if (maybeStat(geminiDir)) canonicalOwned(geminiDir, 'directory');
  const configDir = path.join(artifactDir, 'gemini-isolation');
  return { artifactDir, workspace, configDir, geminiDir, files: {
    systemSettings: path.join(configDir, 'settings.json'), defaults: path.join(configDir, 'system-defaults.json'),
    policy: path.join(configDir, 'readonly.toml'), localEnv: path.join(geminiDir, '.env'), workspaceSettings: path.join(geminiDir, 'settings.json'),
  } };
}
function allowedFiles(files, workspace) {
  if (!Array.isArray(files) || !files.length) refuse('EXACT_READ_ALLOWLIST_REQUIRED');
  const result = files.map(file => {
    const real = canonicalOwned(file, 'file');
    if (!inside(workspace, real)) refuse('OWNED_READ_FILES_REQUIRED');
    return real;
  });
  if (new Set(result).size !== result.length) refuse('EXACT_READ_ALLOWLIST_REQUIRED');
  return result;
}
// JSONC returns null-prototype records. Canonical serialization compares JSON
// values without copying keys into objects or depending on prototype identity.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function equalJson(actual, expected) { assert.equal(canonicalJson(actual), canonicalJson(expected)); }
function prepareOwnedContract(options) {
  const loc = locations(options.artifactDir, options.workspace);
  limits(options.model, options.maxInputs ?? 3);
  const files = allowedFiles(options.allowedFiles, loc.workspace);
  // Preflight every writable destination before base preparation creates any
  // files. This rejects redirected and dangling .gemini symlinks first.
  if (maybeStat(loc.configDir)) refuse('FRESH_CONFIG_DIRECTORY_REQUIRED');
  for (const file of Object.values(loc.files)) if (maybeStat(file)) refuse('FRESH_CONFIG_FILE_REQUIRED');
  base.policyFor(files); // Reject unsupported path encoding before mutation.
  return base.prepareOwnedContract({ ...options, artifactDir: loc.artifactDir, workspace: loc.workspace, allowedFiles: files });
}
function verifyContract(contract) {
  if (contract.case !== 'PB-03' || contract.stage !== 'PREFLIGHT_ONLY') refuse('OWNED_CONTRACT_REQUIRED');
  const loc = locations(contract.artifactDir, contract.workspace);
  limits(contract.model, contract.maxInputs);
  if (!/^pb03-no-mcp-[a-f0-9]{48}$/.test(contract.sentinel) || !/^PB03_CONTEXT_[a-f0-9]{24}\.md$/.test(contract.contextName)) refuse('OWNED_SENTINEL_REQUIRED');
  if (!contract.files || canonicalJson(Object.keys(contract.files).sort()) !== canonicalJson(Object.keys(loc.files).sort())) refuse('EXACT_CONFIG_FILES_REQUIRED');
  if (!Array.isArray(contract.allowedFiles)) refuse('EXACT_READ_ALLOWLIST_REQUIRED');
  const reads = allowedFiles(contract.allowedFiles.map(file => file.path), loc.workspace);
  canonicalOwned(loc.configDir, 'directory'); canonicalOwned(loc.geminiDir, 'directory');
  for (const [name, file] of Object.entries(contract.files)) {
    if (file.path !== loc.files[name]) refuse('OWNED_CONFIG_ESCAPE');
    canonicalOwned(file.path, 'file');
    if (base.identity(file.path).sha256 !== file.sha256) refuse('OWNED_FILE_CHANGED');
  }
  for (const file of contract.allowedFiles) if (base.identity(file.path).sha256 !== file.sha256) refuse('OWNED_FILE_CHANGED');
  equalJson(base.readSettings(loc.files.systemSettings).settings, base.settingsFor(contract.contextName));
  assert.equal(fs.readFileSync(loc.files.policy, 'utf8'), base.policyFor(reads));
  assert.equal(fs.readFileSync(loc.files.localEnv).length, 0);
  equalJson(base.readSettings(loc.files.workspaceSettings).settings, {});
  equalJson(base.readSettings(loc.files.defaults).settings, {});
  assert.deepEqual(contract.injectedArgs, ['--extensions', 'none', '--allowed-mcp-server-names', contract.sentinel, '--policy', loc.files.policy]);
  assert.deepEqual(contract.injectedEnvironment, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: loc.files.systemSettings, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: loc.files.defaults });
  base.verifyRuntime(contract.runtime);
}
function inspectConfigFiles({ contract, userSettingsPath, fixedPoliciesDir, userPoliciesDir, env }) {
  verifyContract(contract);
  const user = base.readSettings(userSettingsPath);
  base.inspectUnownedSettings(user.settings, contract.sentinel);
  for (const key of ['GEMINI_SYSTEM_MD', 'GEMINI_CLI_ACTIVITY_LOG_TARGET', 'GEMINI_CLI_EXTENSION_REGISTRY_URI']) {
    if (env[key]) refuse('INHERITED_STARTUP_OVERRIDE_REQUIRES_REVIEW');
  }
  if (env.GEMINI_CLI_IDE_WORKSPACE_PATH) {
    const entries = env.GEMINI_CLI_IDE_WORKSPACE_PATH.split(path.delimiter).filter(Boolean);
    if (entries.some(file => fs.realpathSync(file) !== contract.workspace)) refuse('IDE_DIRECTORY_SCOPE_REQUIRES_REVIEW');
  }
  const globalContext = path.join(path.dirname(userSettingsPath), contract.contextName);
  if (fs.existsSync(globalContext)) refuse('OWNED_CONTEXT_NAME_COLLISION');
  const policyDirectories = [fixedPoliciesDir, userPoliciesDir, path.join(contract.workspace, '.gemini/policies')].map(base.inspectPolicyDirectory);
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
module.exports = { ...base, prepareOwnedContract, verifyContract, inspectConfigFiles, inspectCurrentConfiguration };
