/* Launch only after explicit review of a freshly prepared supplement. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_HELPER_QUALITY_ARTIFACT_DIR);
assert(directory.startsWith(root + path.sep));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json')));
assert.equal(manifest.stage, 'HELPER_QUALITY_3');
const compiled = fs.realpathSync(manifest.compiledDirectory);
assert(compiled.startsWith(root + path.sep));
require('./codex-helper-quality-contract.cjs').verifyPreservedBase(manifest.fixture);
process.env.MYSTI_PB02_HELPER_QUALITY_REPO = repo;
require('./ordinary-profile-runner.cjs').runOwnedEditor({
  caseId: 'PB-02', envPrefix: 'MYSTI_PB02_HELPER_QUALITY',
  // The shared runner uses this only to resolve and pin the two compiled files.
  suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), compiled), 'codex-helper-quality'),
  label: '[PB-02 helper quality followup]', plannedInputs: 3, timeoutMs: 900000,
});
