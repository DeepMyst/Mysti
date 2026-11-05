/* Launch only after explicit review of a freshly prepared supplement. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_PROFILE_VALIDATION_ARTIFACT_DIR);
assert(directory.startsWith(root + path.sep));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json')));
assert.equal(manifest.stage, 'PROFILE_VALIDATION_3');
const compiled = fs.realpathSync(manifest.compiledDirectory);
assert(compiled.startsWith(root + path.sep));
const contract = require('./codex-profile-validation-contract.cjs');
contract.verifyPreservedBase(manifest.fixture); contract.verifyOwnedProfiles(manifest.profileValidation);
assert.equal(manifest.profileValidation.controlOnly, false, 'Synthetic profile preparation can never launch native inference');
process.env.MYSTI_PB02_PROFILE_VALIDATION_REPO = repo;
require('./ordinary-profile-runner.cjs').runOwnedEditor({
  caseId: 'PB-02', envPrefix: 'MYSTI_PB02_PROFILE_VALIDATION',
  // The shared runner uses this only to resolve and pin the two compiled files.
  suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), compiled), 'codex-profile-validation'),
  label: '[PB-02 named profile validation]', plannedInputs: 4, timeoutMs: 900000,
});
