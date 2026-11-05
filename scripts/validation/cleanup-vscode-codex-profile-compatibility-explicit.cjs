/* Remove only the two owned unchanged profile files after editor exit and audit. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { createHash } = require('node:crypto');
const { cleanupOwnedProfiles } = require('./codex-profile-validation-contract.cjs');
const root = fs.realpathSync(path.resolve(__dirname, '../../out-test/feature-tests/PB-02'));
const directory = fs.realpathSync(process.env.MYSTI_PB02_PROFILE_COMPATIBILITY_EXPLICIT_ARTIFACT_DIR);
assert(directory.startsWith(root + path.sep));
const read = file => JSON.parse(fs.readFileSync(file));
const manifest = read(path.join(directory, 'prepared.json'));
assert.equal(manifest.stage, 'PROFILE_COMPATIBILITY_EXPLICIT_2'); assert.equal(manifest.artifactDir, directory);
assert.equal(createHash('sha256').update(fs.readFileSync(manifest.profileFilesIdentity.path)).digest('hex'), manifest.profileFilesIdentity.sha256);
assert.deepEqual(read(manifest.profileFilesIdentity.path), manifest.profileValidation);
const owner = manifest.windows.A, audit = read(path.join(directory, 'independent-audit.json'));
const check = read(path.join(owner.directory, 'editor-exit-process-check.json'));
assert.equal(check.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(check.remaining, []); assert.deepEqual(check.unverifiedLiveReceiptPids, []);
const ancestry = read(path.join(owner.directory, 'process-ancestry.json'));
const live = new Map(execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
  const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return [+match[1], match[2]];
}));
for (const process of ancestry.processIdentities) assert.notEqual(live.get(process.pid), process.startedAt, 'An observed process still lives');
for (const file of [...owner.receiptPaths, ...owner.auxiliaryReceiptPaths]) {
  for (const receipt of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)) {
    for (const pid of [receipt.wrapperPid, receipt.childPid].filter(Boolean)) {
      if (!live.has(pid)) continue;
      const prior = ancestry.processIdentities.filter(value => value.pid === pid);
      assert(prior.length && prior.every(value => value.startedAt !== live.get(pid)) || Date.parse(live.get(pid)) > receipt.at, 'Unverified living receipt PID');
    }
  }
}
const output = path.join(directory, 'owned-profile-cleanup.json'); assert(!fs.existsSync(output));
const result = { ...cleanupOwnedProfiles(manifest.profileValidation), checkedAt: new Date().toISOString(), auditStatus: audit.status,
  profileFilesIdentity: manifest.profileFilesIdentity, observedProcessIdentitiesExited: ancestry.processIdentities.length };
fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify(result));
