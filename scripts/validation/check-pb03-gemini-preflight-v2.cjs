/* PB-03 static qualification only: never imports or executes the Gemini CLI. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const childProcess = require('node:child_process');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helperPath = path.join(__dirname, 'pb03-gemini-preflight-v2.cjs');
const helperPin = '5c7911b26e65e6136f1391ee4df46f2f09d48fc605d005777982fb3305e08349';
assert.equal(hash(fs.readFileSync(helperPath)), helperPin, 'Existing helper changed; review before qualification');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = () => { throw new Error('Native process launch forbidden in static qualification'); };
}
globalThis.fetch = () => { throw new Error('Network forbidden in static qualification'); };
const p = require(helperPath);
fs.mkdirSync(p.OWNED_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(p.OWNED_ROOT, 'preflight-v2-controls-'));
const rows = [];
let sequence = 0;
const write = (file, value) => { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); return file; };
const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
const fresh = label => fs.mkdtempSync(path.join(root, `${String(++sequence).padStart(3, '0')}-${label}-`));
function check(name, run, kind = 'contract') {
  try { run(); rows.push({ name, kind, status: 'PASS' }); }
  catch (error) { rows.push({ name, kind, status: 'FAIL', error: String(error.message) }); }
}
function rejects(fn, code) {
  assert.throws(fn, error => code ? error.code === code : error instanceof Error, `Expected rejection${code ? `: ${code}` : ''}`);
}
function settings(value, label = 'settings') {
  return json(path.join(fresh(label), 'settings.json'), value);
}
function fixture() {
  const artifactDir = fresh('contract');
  const workspace = path.join(artifactDir, 'workspace'); fs.mkdirSync(workspace);
  const allowed = write(path.join(workspace, 'review.cjs'), 'exports.retryDelay = n => n * 100;\n');
  return { artifactDir, workspace, allowedFiles: [allowed], model: 'gemini-2.5-flash', runtime, maxInputs: 3 };
}
function contract() { const c = p.prepareOwnedContract(fixture()); p.verifyContract(c); return c; }
function input(c, env = {}) {
  const syntheticUser = fresh('synthetic-user');
  return { contract: c, userSettingsPath: json(path.join(syntheticUser, 'settings.json'), {}),
    fixedPoliciesDir: path.join(syntheticUser, 'fixed-policies'), userPoliciesDir: path.join(syntheticUser, 'user-policies'), env };
}
const fakePackage = fresh('synthetic-runtime');
fs.mkdirSync(path.join(fakePackage, 'bundle'));
json(path.join(fakePackage, 'package.json'), { name: '@google/gemini-cli', version: '0.58.0' });
write(path.join(fakePackage, 'bundle/gemini.js'), '// Synthetic runtime bytes. Never executed.\n');
const fakeNode = write(path.join(fakePackage, 'synthetic-node'), 'NOT AN EXECUTABLE\n');
const runtime = p.snapshotInstalledRuntime(fakePackage, fakeNode);

check('missing settings are metadata-only and empty', () => {
  const result = p.readSettings(path.join(fresh('missing'), 'absent.json'));
  assert.deepEqual(result.settings, {}); assert.equal(result.file.exists, false);
});
check('JSONC comments accepted, settings values not serialized in metadata', () => {
  const file = write(path.join(fresh('jsonc'), 'settings.json'), '{/* local comment */"syntheticSecret":"DO_NOT_SERIALIZE"}');
  const result = p.readSettings(file); assert.equal(result.settings.syntheticSecret, 'DO_NOT_SERIALIZE');
  assert.equal(JSON.stringify(result.file).includes('DO_NOT_SERIALIZE'), false);
});
for (const [label, source, code] of [
  ['malformed', '{', 'SETTINGS_PARSE_REJECTED'],
  ['array root', '[]', 'SETTINGS_PARSE_REJECTED'],
  ['trailing comma', '{"a":1,}', 'SETTINGS_PARSE_REJECTED'],
  ['duplicate root', '{"a":1,"a":2}', 'SETTINGS_DUPLICATE_OR_UNSAFE_KEY'],
  ['duplicate nested', '{"a":{"b":1,"b":2}}', 'SETTINGS_DUPLICATE_OR_UNSAFE_KEY'],
  ['unsafe nested key', '{"a":{"__proto__":{}}}', 'SETTINGS_DUPLICATE_OR_UNSAFE_KEY'],
  ['unsafe array object key', '{"a":[{"constructor":{}}]}', 'SETTINGS_DUPLICATE_OR_UNSAFE_KEY'],
]) check(`settings reject ${label}`, () => rejects(() => p.readSettings(write(path.join(fresh('bad-settings'), 'settings.json'), source)), code));
check('settings larger than one MiB rejected', () => rejects(() => p.readSettings(write(path.join(fresh('large-settings'), 'settings.json'), ' '.repeat(1024 * 1024 + 1))), 'SETTINGS_TOO_LARGE'));
for (const value of [
  { general: { disableAutoUpdate: false } }, { general: { disableUpdateNag: true } },
  { ui: { accessibility: { disableLoadingPhrases: true } } },
  { ui: { accessibility: { enableLoadingPhrases: false } } },
  { context: { fileFiltering: { disableFuzzySearch: false } } },
  { tools: { approvalMode: 'plan' } }, { experimental: { codebaseInvestigatorSettings: {} } },
  { experimental: { cliHelpAgentSettings: {} } }, { experimental: { plan: {} } },
]) check(`migration-bearing settings rejected ${rows.length}`, () => rejects(() => p.inspectUnownedSettings(value, 'sentinel'), 'SETTINGS_MIGRATION_WOULD_WRITE'));
for (const key of ['general', 'ui', 'context', 'tools', 'security', 'experimental', 'mcp', 'mcpServers']) {
  check(`malformed ${key} structure rejected`, () => rejects(() => p.inspectUnownedSettings({ [key]: [] }, 'sentinel'), 'SETTINGS_UNSUPPORTED_STRUCTURE'));
}
check('explicit empty include directories accepted', () => p.inspectUnownedSettings({ context: { includeDirectories: [] } }, 'sentinel'));
for (const includeDirectories of [['/synthetic/unrelated'], 'invalid']) {
  check(`inherited directory scope rejected ${rows.length}`, () => rejects(() => p.inspectUnownedSettings({ context: { includeDirectories } }, 'sentinel'), 'INHERITED_DIRECTORY_SCOPE_REQUIRES_REVIEW'));
}
for (const key of ['adminPolicyPaths', 'policyPaths']) check(`${key} require review`, () => rejects(() => p.inspectUnownedSettings({ [key]: ['/synthetic/policy'] }, 'sentinel'), 'CONFIGURED_POLICIES_REQUIRE_REVIEW'));
for (const value of [{ tools: { sandbox: true } }, { security: { toolSandboxing: true } }]) {
  check(`configured sandbox requires review ${rows.length}`, () => rejects(() => p.inspectUnownedSettings(value, 'sentinel'), 'CONFIGURED_SANDBOX_REQUIRES_REVIEW'));
}
check('configured MCP sentinel collision rejected', () => rejects(() => p.inspectUnownedSettings({ mcpServers: { sentinel: {} } }, 'sentinel'), 'MCP_SENTINEL_COLLISION'));
check('absent and empty policy directories accepted', () => {
  const dir = fresh('empty-policy'); assert.equal(p.inspectPolicyDirectory(dir).tomlFiles, 0);
  assert.equal(p.inspectPolicyDirectory(path.join(dir, 'absent')).exists, false);
});
check('existing TOML policy rejected', () => {
  const dir = fresh('policy'); write(path.join(dir, 'policy.toml'), '');
  rejects(() => p.inspectPolicyDirectory(dir), 'EXISTING_POLICIES_REQUIRE_REVIEW');
});
check('policy directory symlink rejected', () => {
  const dir = fresh('policy-link'); fs.symlinkSync(fresh('policy-target'), path.join(dir, 'link'));
  rejects(() => p.inspectPolicyDirectory(path.join(dir, 'link')), 'POLICY_DIRECTORY_REQUIRES_REVIEW');
});
check('runtime snapshot verifies unchanged synthetic bytes', () => p.verifyRuntime(runtime));
check('unreviewed runtime version rejected', () => {
  const dir = fresh('runtime-version'); json(path.join(dir, 'package.json'), { name: '@google/gemini-cli', version: '999.0.0' });
  rejects(() => p.snapshotInstalledRuntime(dir, fakeNode), 'UNREVIEWED_GEMINI_VERSION');
});
check('runtime symlink rejected', () => {
  const dir = fresh('runtime-symlink'); json(path.join(dir, 'package.json'), { name: '@google/gemini-cli', version: '0.58.0' });
  fs.mkdirSync(path.join(dir, 'bundle')); fs.symlinkSync(fakeNode, path.join(dir, 'bundle/gemini.js'));
  rejects(() => p.snapshotInstalledRuntime(dir, fakeNode), 'RUNTIME_SYMLINK_REQUIRES_REVIEW');
});
check('changed runtime receipt rejected', () => {
  const altered = structuredClone(runtime); altered.files[0].sha256 = '0'.repeat(64); rejects(() => p.verifyRuntime(altered));
});
check('owned preparation and verification succeed without native launch', () => {
  const c = contract(); p.verifyContract(c);
  assert.equal(c.stage, 'PREFLIGHT_ONLY'); assert.equal(c.maxInputs, 3);
  for (const file of Object.values(c.files)) assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
});
for (const model of ['', 'bad model', '../bad', 'a'.repeat(161)]) check(`invalid explicit model rejected ${rows.length}`, () => rejects(() => p.prepareOwnedContract({ ...fixture(), model }), 'EXPLICIT_MODEL_REQUIRED'));
for (const maxInputs of [0, 7, 1.5]) check(`unbounded input cap rejected ${maxInputs}`, () => rejects(() => p.prepareOwnedContract({ ...fixture(), maxInputs }), 'BOUNDED_INPUT_CAP_REQUIRED'));
check('workspace must be below its artifact directory', () => {
  const f = fixture(); rejects(() => p.prepareOwnedContract({ ...f, workspace: fresh('unrelated-workspace') }), 'WORKSPACE_MUST_BELONG_TO_ATTEMPT');
});
for (const empty of [true, false]) check(`allowlist ${empty ? 'empty' : 'duplicate'} rejected`, () => {
  const f = fixture(); rejects(() => p.prepareOwnedContract({ ...f, allowedFiles: empty ? [] : [...f.allowedFiles, ...f.allowedFiles] }), 'EXACT_READ_ALLOWLIST_REQUIRED');
});
check('allowlist outside workspace rejected during preparation', () => {
  const f = fixture(); const outside = write(path.join(f.artifactDir, 'outside.cjs'), '// outside workspace');
  rejects(() => p.prepareOwnedContract({ ...f, allowedFiles: [outside] }), 'OWNED_READ_FILES_REQUIRED');
});
check('apostrophe policy path rejected', () => rejects(() => p.policyFor(["/synthetic/quote'path"]), 'POLICY_PATH_ENCODING_REQUIRES_REVIEW'));
check('policy regex escapes exact path and rejects suffix and neighboring path', () => {
  const file = '/synthetic/[review]+file.cjs'; const toml = p.policyFor([file]);
  const source = toml.match(/^argsPattern = '([^']+)'$/m)[1]; const pattern = new RegExp(source);
  assert.equal(pattern.test(JSON.stringify({ file_path: file })), true);
  assert.equal(pattern.test(JSON.stringify({ file_path: file + '.other' })), false);
  assert.equal(pattern.test(JSON.stringify({ file_path: '/synthetic/rreviewwfile.cjs' })), false);
});
check('changed owned file rejected', () => {
  const c = contract(); fs.appendFileSync(c.allowedFiles[0].path, '// changed'); rejects(() => p.verifyContract(c), 'OWNED_FILE_CHANGED');
});
check('changed injected argv rejected', () => {
  const c = contract(); c.injectedArgs.push('--yolo'); rejects(() => p.verifyContract(c));
});
check('changed injected environment rejected', () => {
  const c = contract(); c.injectedEnvironment.GEMINI_CLI_SYSTEM_SETTINGS_PATH = fakeNode; rejects(() => p.verifyContract(c));
});
check('static inspection preserves synthetic settings bytes and emits metadata only', () => {
  const i = input(contract()); const before = fs.readFileSync(i.userSettingsPath); const result = p.inspectConfigFiles(i);
  assert.deepEqual(fs.readFileSync(i.userSettingsPath), before); assert.equal(result.status, 'PASS_STATIC_PREFLIGHT');
  assert.equal(result.providerLaunches, 0); assert.equal(result.inferenceInputs, 0); assert.equal(result.configMigrationPerformed, false);
});
for (const key of ['GEMINI_SYSTEM_MD', 'GEMINI_CLI_ACTIVITY_LOG_TARGET', 'GEMINI_CLI_EXTENSION_REGISTRY_URI']) {
  check(`startup override ${key} rejected`, () => rejects(() => p.inspectConfigFiles(input(contract(), { [key]: '/synthetic/override' })), 'INHERITED_STARTUP_OVERRIDE_REQUIRES_REVIEW'));
}
check('IDE scope matching owned workspace accepted', () => {
  const c = contract(); p.inspectConfigFiles(input(c, { GEMINI_CLI_IDE_WORKSPACE_PATH: c.workspace }));
});
check('IDE scope including another directory rejected', () => {
  const c = contract(); rejects(() => p.inspectConfigFiles(input(c, { GEMINI_CLI_IDE_WORKSPACE_PATH: c.workspace + path.delimiter + root })), 'IDE_DIRECTORY_SCOPE_REQUIRES_REVIEW');
});
check('user context filename collision rejected', () => {
  const c = contract(); const i = input(c); write(path.join(path.dirname(i.userSettingsPath), c.contextName), 'synthetic collision');
  rejects(() => p.inspectConfigFiles(i), 'OWNED_CONTEXT_NAME_COLLISION');
});

// Adversarial qualification requirements. Failures remain visible; the original
// helper is deliberately not changed by this checker.
check('verification rejects a model changed after preparation', () => {
  const c = contract(); c.model = 'bad model'; rejects(() => p.verifyContract(c));
}, 'tamper-boundary');
check('verification rejects an input cap changed after preparation', () => {
  const c = contract(); c.maxInputs = 999; rejects(() => p.verifyContract(c));
}, 'tamper-boundary');
check('verification keeps allowed files inside the recorded workspace', () => {
  const c = contract(); const outside = write(path.join(c.artifactDir, 'outside-workspace.cjs'), '// synthetic outsider');
  c.allowedFiles = [p.identity(outside)]; fs.writeFileSync(c.files.policy.path, p.policyFor([outside])); c.files.policy = p.identity(c.files.policy.path);
  rejects(() => p.verifyContract(c));
}, 'tamper-boundary');
check('preparation rejects a redirected .gemini directory before writing', () => {
  const f = fixture(); const target = fresh('redirect-target'); fs.symlinkSync(target, path.join(f.workspace, '.gemini'));
  let rejected = false; try { p.prepareOwnedContract(f); } catch { rejected = true; }
  const escaped = ['.env', 'settings.json'].filter(name => fs.existsSync(path.join(target, name)));
  assert.equal(escaped.length, 0, `Preparation wrote outside its attempt via symlink: ${escaped.join(', ')}`);
  assert.equal(rejected, true, 'Redirected configuration directory was accepted');
}, 'write-boundary');
check('empty existing .gemini directory permits a valid roundtrip', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.workspace, '.gemini'));
  p.verifyContract(p.prepareOwnedContract(f));
}, 'write-boundary');
check('dangling .gemini symlink rejected before any configuration creation', () => {
  const f = fixture(); const target = path.join(fresh('dangling-target'), 'absent');
  fs.symlinkSync(target, path.join(f.workspace, '.gemini'));
  rejects(() => p.prepareOwnedContract(f), 'OWNED_SYMLINK_REJECTED');
  assert.equal(fs.existsSync(path.join(f.artifactDir, 'gemini-isolation')), false);
  assert.equal(fs.existsSync(target), false);
}, 'write-boundary');
check('symlinked workspace rejected before destination creation', () => {
  const f = fixture(); const link = path.join(f.artifactDir, 'workspace-link'); fs.symlinkSync(f.workspace, link);
  rejects(() => p.prepareOwnedContract({ ...f, workspace: link }), 'OWNED_SYMLINK_REJECTED');
  assert.equal(fs.existsSync(path.join(f.artifactDir, 'gemini-isolation')), false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.gemini')), false);
}, 'write-boundary');
check('existing local settings rejected without any partial new configuration', () => {
  const f = fixture(); const dir = path.join(f.workspace, '.gemini'); fs.mkdirSync(dir);
  const file = write(path.join(dir, 'settings.json'), '{"synthetic":true}'); const before = fs.readFileSync(file);
  rejects(() => p.prepareOwnedContract(f), 'FRESH_CONFIG_FILE_REQUIRED');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.artifactDir, 'gemini-isolation')), false);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
}, 'write-boundary');
check('hardlinked allowed file rejected', () => {
  const f = fixture(); fs.linkSync(f.allowedFiles[0], path.join(f.artifactDir, 'linked-source'));
  rejects(() => p.prepareOwnedContract(f), 'OWNED_FILE_TYPE_REQUIRED');
}, 'write-boundary');
for (const maxInputs of [1, 6]) check(`valid boundary input cap ${maxInputs}`, () => {
  p.verifyContract(p.prepareOwnedContract({ ...fixture(), maxInputs }));
});
check('empty allowlist rejected after preparation', () => {
  const c = contract(); c.allowedFiles = []; rejects(() => p.verifyContract(c), 'EXACT_READ_ALLOWLIST_REQUIRED');
}, 'tamper-boundary');
check('duplicate allowlist rejected after preparation', () => {
  const c = contract(); c.allowedFiles.push(c.allowedFiles[0]); rejects(() => p.verifyContract(c), 'EXACT_READ_ALLOWLIST_REQUIRED');
}, 'tamper-boundary');
check('invalid sentinel rejected even when argv is changed consistently', () => {
  const c = contract(); c.sentinel = ''; c.injectedArgs[3] = ''; rejects(() => p.verifyContract(c), 'OWNED_SENTINEL_REQUIRED');
}, 'tamper-boundary');
check('JSON structural equality accepts reordered null-prototype settings', () => {
  const c = contract(); const data = JSON.parse(fs.readFileSync(c.files.systemSettings.path));
  const reordered = Object.fromEntries(Object.entries(data).reverse());
  fs.writeFileSync(c.files.systemSettings.path, JSON.stringify(reordered)); c.files.systemSettings = p.identity(c.files.systemSettings.path);
  p.verifyContract(c);
});

// Parse exact installed source, then run only the small pure auth-selector
// function in a VM with synthetic environment values. No CLI module is loaded.
const installedRoot = '/usr/local/lib/node_modules/@google/gemini-cli';
const corePath = path.join(installedRoot, 'bundle/chunk-MFLFXOVQ.js');
const mainPath = path.join(installedRoot, 'bundle/gemini-CKAAKWBN.js');
const core = fs.readFileSync(corePath, 'utf8');
const main = fs.readFileSync(mainPath, 'utf8');
const start = core.indexOf('function getAuthTypeFromEnv() {');
const end = core.indexOf('\nvar VERTEX_AI_REQUEST_TYPE_HEADER', start);
assert.ok(start >= 0 && end > start, 'Installed source auth selector not located');
const selector = core.slice(start, end);
const authTypes = { LOGIN_WITH_GOOGLE: 'oauth-personal', USE_GEMINI: 'gemini-api-key', USE_VERTEX_AI: 'vertex-ai', GATEWAY: 'gateway', COMPUTE_ADC: 'compute-default-credentials' };
for (const [label, env, expected] of [
  ['unset', {}, undefined], ['GCA true', { GOOGLE_GENAI_USE_GCA: 'true' }, 'oauth-personal'],
  ['GCA false', { GOOGLE_GENAI_USE_GCA: 'false' }, undefined], ['GCA numeric truthiness rejected', { GOOGLE_GENAI_USE_GCA: '1' }, undefined],
  ['GCA takes precedence over API key', { GOOGLE_GENAI_USE_GCA: 'true', GEMINI_API_KEY: 'synthetic' }, 'oauth-personal'],
  ['Vertex selected independently', { GOOGLE_GENAI_USE_VERTEXAI: 'true' }, 'vertex-ai'],
  ['API key selected independently', { GEMINI_API_KEY: 'synthetic' }, 'gemini-api-key'],
]) check(`installed auth selector: ${label}`, () => assert.equal(vm.runInNewContext(`${selector}\ngetAuthTypeFromEnv()`, { process: { env }, AuthType2: authTypes }, { timeout: 100 }), expected), 'installed-source-extract');
check('headless source chooses configured auth or env without persisting selected type', () => {
  const a = main.indexOf('async function validateNonInteractiveAuth('); const b = main.indexOf('\n// packages/cli/src/utils/relaunch.ts', a);
  assert.ok(a >= 0 && b > a); const section = main.slice(a, b);
  assert.match(section, /configuredAuthType \|\| getAuthTypeFromEnv\(\)/);
  assert.equal(section.includes('.setValue('), false);
  assert.match(section, /enforcedType && effectiveAuthType !== enforcedType/);
}, 'installed-source-static');
const runtimeReport = p.snapshotInstalledRuntime(installedRoot, process.execPath);
json(path.join(root, 'installed-runtime.json'), runtimeReport);
const authReport = {
  status: 'SUPPORTED_PER_PROCESS_AUTH_SELECTION_STATIC_ONLY',
  selection: { name: 'GOOGLE_GENAI_USE_GCA', value: 'true', authType: 'oauth-personal' },
  inheritedSelectionMatches: process.env.GOOGLE_GENAI_USE_GCA === 'true',
  sourcePins: [p.identity(corePath), p.identity(mainPath), p.identity(path.join(installedRoot, 'bundle/gemini.js'))],
  selectorSha256: hash(selector),
  sourceLocations: { selector: 'chunk-MFLFXOVQ.js:310934', headlessValidation: 'gemini-CKAAKWBN.js:16324', cachedOAuthReuse: 'chunk-MFLFXOVQ.js:278580' },
  observed: { oauthCredentialFileExists: fs.existsSync(path.join(os.homedir(), '.gemini/oauth_creds.json')), credentialContentsRead: false, nativeCliLaunches: 0, inferenceInputs: 0 },
  limitations: [
    'The pure auth-selector extraction and static source inspection do not authenticate or prove service entitlement.',
    'OAuth initialization reads cached credentials and may refresh tokens and write normal credential/account caches; none of that path was executed.',
    'Use a per-child environment overlay and NO_BROWSER=true for a future headless attempt; do not change production settings or initiate interactive login.',
    'Configured/enforced authentication takes precedence and must be rechecked immediately before any future launch.',
  ],
};
json(path.join(root, 'auth-selection-review.json'), authReport);
assert.equal(hash(fs.readFileSync(helperPath)), helperPin, 'Existing helper changed during qualification');
const failed = rows.filter(row => row.status === 'FAIL');
const report = {
  status: failed.length ? 'FAIL_STATIC_QUALIFICATION' : 'PASS_STATIC_QUALIFICATION',
  case: 'PB-03', featureStatus: 'NOT_RUN', createdAt: new Date().toISOString(), root,
  checks: rows.length, passed: rows.length - failed.length, failed: failed.length, rows,
  pins: { helper: p.identity(helperPath), checker: p.identity(__filename), node: p.identity(process.execPath), installedRuntime: p.identity(path.join(root, 'installed-runtime.json')), authSelectionReview: p.identity(path.join(root, 'auth-selection-review.json')) },
  predecessorEvidence: { report: 'out-test/feature-tests/PB-03/preflight-controls-lgYxF1/checks.json', sha256: 'e5f158d482d0accd15b51a2dc0f9bf937fee56def5d71fd9bb0a2054adbccfd5', limitation: 'Original helper rejects every valid contract due to prototype equality. Generic rejection controls in that first report do not establish rejection of their intended mutations; this successor first verifies a clean baseline before every mutation.' },
  predecessorHelper: p.identity(path.join(__dirname, 'pb03-gemini-preflight.cjs')),
  scope: 'Synthetic settings/environment and owned filesystem controls, installed source inspection, and pure VM auth-selector controls only.',
  nativeCliLaunches: 0, inferenceInputs: 0, credentialContentsRead: false, productionSettingsModified: false,
  evidencePreserved: true,
};
const reportPath = json(path.join(root, 'checks.json'), report);
console.log(JSON.stringify({ status: report.status, checks: report.checks, passed: report.passed, failed: report.failed, report: p.identity(reportPath), failures: failed.map(row => ({ name: row.name, error: row.error.slice(0, 450) })) }));
process.exitCode = failed.length ? 1 : 0;
