/* Prepare only owned PC-08 state BEFORE extension activation; no inference. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHistoryCliFixture } = require('./history-cli-fixture.cjs');
const repo = path.resolve(__dirname, '../..');
const artifactDir = path.resolve(process.env.MYSTI_PC08_ARTIFACT_DIR || path.join(repo, 'out-test/feature-tests/PC-08/native'));
assert(artifactDir.startsWith(path.join(repo, 'out-test/feature-tests/PC-08') + path.sep));
fs.mkdirSync(artifactDir, { recursive: true });
const manifestFile = path.join(artifactDir, 'prepared.json');
assert(!fs.existsSync(manifestFile), 'Refuse to overwrite a prepared history test');
const claude = process.env.MYSTI_PC08_CLAUDE_PATH;
const codex = process.env.MYSTI_PC08_CODEX_PATH;
const node = process.env.MYSTI_PC08_NODE_PATH || process.execPath;
for (const executable of [claude, codex, node]) assert(executable && path.isAbsolute(executable) && fs.existsSync(executable));
const profiles = path.join(repo, '.vscode-test/profiles');
fs.mkdirSync(profiles, { recursive: true });
const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pc08-')));
fs.writeFileSync(path.join(profile, '.mysti-test-owned.json'), JSON.stringify({ case: 'PC-08', profile }), { mode: 0o600 });
const cliDirectory = fs.mkdtempSync(path.join(artifactDir, 'cli-'));
const hooks = path.join(cliDirectory, 'claude-settings.json');
fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
const claudeFixture = createHistoryCliFixture(cliDirectory, 'claude-code', claude, node, hooks);
const codexFixture = createHistoryCliFixture(cliDirectory, 'openai-codex', codex, node, hooks);
const workspace = fs.realpathSync(path.join(repo, 'out-vscode-test/fixture-workspace'));
const fixtureDirectory = fs.mkdtempSync(path.join(workspace, 'pc08-'));
const contextFile = path.join(fixtureDirectory, 'retry-contract.ts');
const contextContent = '// PC08 owned retry contract: retry transient errors at most 3 times.\nexport const maxRetries = 3;\n';
fs.writeFileSync(contextFile, contextContent);
const settings = {
  'files.simpleDialog.enable': true,
  'mysti.claudeCodePath': claudeFixture.path, 'mysti.codexPath': codexFixture.path,
  'mysti.defaultAgent': 'claude-code', 'mysti.defaultProvider': 'claude-code', 'mysti.defaultModel': 'sonnet',
  'mysti.claudeCodeModel': 'sonnet', 'mysti.codexModel': 'gpt-5.6-sol', 'mysti.codexProfile': '',
  'mysti.defaultEffortLevel': 'low', 'mysti.defaultThinkingLevel': 'none', 'mysti.defaultMode': 'ask-before-edit',
  'mysti.accessLevel': 'ask-permission', 'mysti.autoContext': false, 'mysti.showSuggestions': false, 'mysti.agents.autoSuggest': false,
};
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
const manifest = { case: 'PC-08', profile, cliDirectory, fixtureDirectory, contextFile, contextContent,
  receiptsPathsByStage: Object.fromEntries(['preflight-write', 'preflight-read', 'create', 'restart', 'title-probe'].map(stage => [stage, [claudeFixture.receiptsPaths[stage], codexFixture.receiptsPaths[stage]]])),
  wrappers: { 'claude-code': claudeFixture.path, 'openai-codex': codexFixture.path },
  accountMutation: false, preparedBeforeActivation: true };
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ prepared: manifestFile, profile, artifactDir, launchStages: ['create', 'restart'], conversationalRequestsPlanned: 21 }));
