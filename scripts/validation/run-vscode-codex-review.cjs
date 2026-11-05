/* Launch only after explicit review of a freshly prepared supplement. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_REVIEW_ARTIFACT_DIR);
assert(directory.startsWith(root + path.sep));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json')));
assert.equal(manifest.stage, 'PEER_REVIEW_REPAIR');
const compiled = fs.realpathSync(manifest.compiledDirectory);
assert(compiled.startsWith(root + path.sep));
require('./codex-review-contract.cjs').verifyPreservedBase(manifest.fixture);
process.env.MYSTI_PB02_REVIEW_REPO = repo;
require('./ordinary-profile-runner.cjs').runOwnedEditor({
  caseId: 'PB-02', envPrefix: 'MYSTI_PB02_REVIEW',
  // The shared runner uses this only to resolve and pin the two compiled files.
  suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), compiled), 'codex-review'),
  label: '[PB-02 preserved HTTP-date peer repair]', plannedInputs: 3, timeoutMs: 900000,
});
