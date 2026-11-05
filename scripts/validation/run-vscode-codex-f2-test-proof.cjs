'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-test-proof.cjs');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_F2_TEST_PROOF_ARTIFACT_DIR); c.contained(root, directory);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json'))); assert.equal(manifest.stage, c.STAGE);
assert.equal(c.identity(manifest.campaign.identity.path).sha256, manifest.campaign.identity.sha256);
process.env.MYSTI_PB02_F2_TEST_PROOF_REPO = repo;
require('./ordinary-profile-runner.cjs').runOwnedEditor({ caseId: 'PB-02', envPrefix: 'MYSTI_PB02_F2_TEST_PROOF',
  suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), manifest.compiledDirectory), 'codex-f2-test-proof'),
  label: '[PB-02 F2 client-test authority proof]', plannedInputs: 1, timeoutMs: 600_000 });
