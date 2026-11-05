'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-final-pair-campaign.cjs');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_F2_FINAL_PAIR_ARTIFACT_DIR); c.contained(root, directory);
const manifest = require('./codex-f2-compact-store.cjs').readJson(path.join(directory, 'prepared.json')); assert.equal(manifest.stage, c.STAGE);
assert.equal(c.identity(manifest.campaign.identity.path).sha256, manifest.campaign.identity.sha256);
process.env.MYSTI_PB02_F2_FINAL_PAIR_REPO = repo;
require('./ordinary-profile-runner.cjs').runOwnedEditor({ caseId: 'PB-02', envPrefix: 'MYSTI_PB02_F2_FINAL_PAIR',
  suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), manifest.compiledDirectory), 'codex-f2-final-pair'),
  label: '[PB-02 final-pair F2 segment]', plannedInputs: manifest.segment.index === 1 ? c.FIRST_SEGMENT_COUNT : c.TURN_COUNT - c.FIRST_SEGMENT_COUNT, timeoutMs: 3_900_000 });
