'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-csv-export-awake-campaign.cjs');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_F2_CSV_EXPORT_AWAKE_ARTIFACT_DIR); c.contained(root, directory);
const manifest = require('./codex-f2-compact-store.cjs').readJson(path.join(directory, 'prepared.json')); assert.equal(manifest.stage, c.STAGE);
assert([1,2].includes(manifest.segment.index));
c.assertNativePreparationReady(manifest.campaign.priorBinding);
assert.equal(c.identity(manifest.campaign.identity.path).sha256, manifest.campaign.identity.sha256);
process.env.MYSTI_PB02_F2_CSV_EXPORT_AWAKE_REPO = repo;
const awake = require(path.join(root, 'overnight-20261011/f06-awake-native-preparation/awake-check.cjs'));
const awakeReceipt = awake.verifyLive(manifest.segment.index);
fs.writeFileSync(path.join(directory, 'awake-prelaunch.json'), JSON.stringify(awakeReceipt, null, 2) + '\n', {flag: 'wx'});
require('./ordinary-profile-runner.cjs').runOwnedEditor({ caseId: 'PB-02', envPrefix: 'MYSTI_PB02_F2_CSV_EXPORT_AWAKE',
  suiteStem: path.join(path.relative(path.join(repo, 'out-vscode-test'), manifest.compiledDirectory), 'codex-f2-csv-export-awake'),
  label: '[PB-02 F06 CSV export segment]', plannedInputs: manifest.segment.index === 1 ? c.FIRST_SEGMENT_COUNT : c.TURN_COUNT - c.FIRST_SEGMENT_COUNT, timeoutMs: 3_900_000 });
