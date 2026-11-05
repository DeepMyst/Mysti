'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-scoped-campaign.cjs');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_F2_SCOPED_ARTIFACT_DIR); c.contained(root, directory);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json'))); assert.equal(manifest.stage, c.STAGE);
assert.equal(c.identity(manifest.campaign.identity.path).sha256, manifest.campaign.identity.sha256);
process.env.MYSTI_PB02_F2_SCOPED_REPO = repo;
require('./ordinary-profile-runner.cjs').runOwnedEditor({ caseId: 'PB-02', envPrefix: 'MYSTI_PB02_F2_SCOPED',
  suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), manifest.compiledDirectory), 'codex-f2-scoped'),
  label: '[PB-02 scoped F2 segment]', plannedInputs: manifest.segment.index === 1 ? 13 : 12, timeoutMs: 3_900_000 });
