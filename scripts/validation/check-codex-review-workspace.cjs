/* Pure workspace-auditor controls on a NEW synthetic copy. No model/editor. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { copyPreservedFixture, verifyPreservedBase } = require('./codex-review-contract.cjs');
const { auditWorkspace } = require('./audit-vscode-codex-review.cjs');
const directory = fs.mkdtempSync(path.resolve(__dirname, '../../out-test/feature-tests/PB-02/codex-review-workspace-controls-'));
const fixture = copyPreservedFixture(path.join(directory, 'workspace'));
const file = relative => path.join(fixture.workspace, relative);
const source = fs.readFileSync(file('src/retry.cjs'), 'utf8').replace('    const timestamp = Date.parse(trimmed);',
  '    const timestamp = Date.parse(i === 2 ? `${trimmed} GMT` : trimmed);');
fs.writeFileSync(file('src/retry.cjs'), source);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = Object.fromEntries(Object.keys(fixture.files).map(relative => [relative, digest(fs.readFileSync(file(relative)))]));
const common = { manifest: { fixture }, owner: { workspace: fixture.workspace } };
const acceptance = { panelId: 'synthetic-peer', files: { hashes, productArtifacts: [], indexUnchanged: true, canaryUnchanged: true, preservedNotes: true } };
const checks = [];
const testFile = file('test/retry.test.cjs'), beforeTests = fs.readFileSync(testFile);
const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: fixture.workspace, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
});
assert.deepEqual(git(['diff', '--name-only']).trim().split('\n'), ['src/retry.cjs', 'test/retry.test.cjs']);
function check(name, run) {
  try { run(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); }
}
check('Preserved pre-existing test diff is allowed with exact test bytes/index and approved source repair', () => auditWorkspace(common, acceptance));
check('A new test mutation remains rejected even when acceptance hashes are updated', () => {
  fs.appendFileSync(testFile, '\n// unauthorized new test edit\n');
  const forged = structuredClone(acceptance); forged.files.hashes['test/retry.test.cjs'] = digest(fs.readFileSync(testFile));
  try { assert.throws(() => auditWorkspace(common, forged), /Unapproved file changed: test\/retry.test.cjs/); }
  finally { fs.writeFileSync(testFile, beforeTests); }
});
check('Staging the pre-existing test changes remains rejected by exact index preservation', () => {
  const index = file('.git/index'), originalIndex = fs.readFileSync(index);
  git(['add', '--', 'test/retry.test.cjs']);
  try { assert.throws(() => auditWorkspace(common, acceptance)); }
  finally { fs.writeFileSync(index, originalIndex); }
});
verifyPreservedBase(fixture);
const result = { status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL', checks,
  originalPreserved: true, realProviderInputs: 0, editorLaunches: 0,
  scope: 'New synthetic workspace only; no actual native replay and no mutation of prior evidence.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, ...result })); process.exitCode = result.status === 'PASS' ? 0 : 1;
