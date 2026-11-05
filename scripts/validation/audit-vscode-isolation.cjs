/* Independent post-exit PC-09 evidence audit; no editor or inference launch. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const directory = path.resolve(process.env.MYSTI_PC09_ARTIFACT_DIR);
assert(directory.startsWith(path.join(repo, 'out-test/feature-tests/PC-09') + path.sep));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = read(path.join(directory, 'prepared.json'));
assert.equal(manifest.case, 'PC-09');
const result = read(path.join(directory, 'native-result.json'));
assert.equal(result.status, 'PASS', 'A failed journey cannot be accepted by a later audit');
assert.equal(hash(path.join(manifest.sourcePackage, 'dist/extension.js')), manifest.bundleSha256);
assert.equal(hash(path.join(manifest.sourcePackage, 'media/chat/chat.js')), manifest.chatSha256);
const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  assert(match); return { pid: +match[1], startedAt: match[3] };
});
const live = new Map(rows.map(row => [row.pid, row.startedAt]));
const reports = [], readyHosts = new Set(), allResponses = [];
for (const id of ['A', 'B']) {
  const owner = manifest.windows[id];
  const installed = owner.installedExtension || manifest.installedExtension;
  assert.equal(hash(path.join(installed, 'dist/extension.js')), manifest.bundleSha256);
  assert.equal(hash(path.join(installed, 'media/chat/chat.js')), manifest.chatSha256);
  const launch = read(path.join(owner.directory, 'launch.json'));
  assert.equal(launch.profile, owner.profile);
  assert(launch.args.every(arg => !/extensionTestsPath/i.test(arg)));
  assert.equal(launch.installedExtension, installed);
  const exit = read(path.join(owner.directory, 'editor-exit.json'));
  assert.equal(exit.code, 0); assert.equal(exit.helper.failures, 0); assert.equal(exit.timedOut, false);
  const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
  const ancestry = read(path.join(owner.directory, 'process-ancestry.json'));
  assert(ancestry.processIdentities.length > 0);
  for (const identity of ancestry.processIdentities) assert.notEqual(live.get(identity.pid), identity.startedAt, `Observed ${id} process remains: ${identity.pid}`);
  const receipts = owner.receiptPaths.flatMap(file => fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  for (const receipt of receipts) for (const pid of [receipt.wrapperPid, receipt.childPid].filter(Boolean)) {
    if (!live.has(pid)) continue;
    // A currently reused PID is safe only when its different birth was captured.
    const captured = ancestry.processIdentities.filter(identity => identity.pid === pid);
    assert(captured.length && captured.every(identity => identity.startedAt !== live.get(pid)), `Unverified live receipt PID: ${pid}`);
  }
  const requests = receipts.filter(receipt => receipt.event === 'request');
  assert.equal(requests.length, id === 'A' ? 4 : 1);
  for (const request of requests) {
    assert.equal(request.window, id);
    assert.equal(request.contextScopes.length, 1);
    const scope = request.contextScopes[0]; assert(scope.startsWith(id));
    assert(request.markers.length > 0 && request.markers.every(marker => marker === scope || marker === scope + '_RECOVER'));
    assert.equal(request.provider, scope === 'A0' || scope === 'A2' ? 'claude-code' : 'openai-codex');
  }
  const events = read(path.join(owner.directory, 'observations.json'));
  assert.equal(events.filter(event => event.event === 'case-outcome' && event.state === 'passed').length, 1);
  assert.equal(events.filter(event => event.event === 'panel-ready').length, id === 'A' ? 3 : 1);
  const identity = events.find(event => event.event === 'identity'); assert(identity);
  readyHosts.add(identity.extensionHostPid);
  const responses = events.filter(event => event.event === 'response-verified');
  assert.equal(responses.length, id === 'A' ? 3 : 1);
  for (const response of responses) {
    assert(response.response.includes(manifest.tokens[response.label]));
    assert(response.response.includes(`PC09_DONE:${response.marker}`));
    for (const [scope, token] of Object.entries(manifest.tokens)) if (scope !== response.label) assert(!response.response.includes(token));
    allResponses.push(response);
  }
  for (const fixture of Object.values(owner.scopes)) assert.equal(hash(fixture.contextFile), fixture.contentSha256);
  reports.push({ window: id, profile: owner.profile, conversationalInputs: requests.length,
    auxiliaryInputs: receipts.filter(receipt => receipt.event === 'auxiliary-input').length,
    observedExitedIdentities: ancestry.processIdentities.length, completedResponses: responses.length });
}
assert.equal(readyHosts.size, 2); assert.notEqual(manifest.windows.A.profile, manifest.windows.B.profile);
const stopped = read(path.join(directory, 'barrier-A1-STOPPED.json'));
for (const label of ['A0', 'B0']) assert(allResponses.find(response => response.label === label).terminalAt > stopped.stopStartedAt);
for (let group = 0; group < 100; group++) for (let file = 0; file < 100; file++) {
  assert.equal(fs.readFileSync(path.join(manifest.windows.B.workspace, `package-${group}`, `module-${file}.ts`), 'utf8'), `export const fixture = ${group * 100 + file};\n`);
}
const audit = { status: 'PASS_BOUNDED_NATIVE_ISOLATION', auditedAt: new Date().toISOString(), reports,
  bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256,
  actualDistinctEditorHosts: readyHosts.size, stopStartedAt: stopped.stopStartedAt,
  limits: ['Two distinct profiles, not shared-profile global-store concurrency.', 'Observed process identities at 250ms cadence; short-lived children may be missed.',
    'Native repeated IDs, question and permission collisions are covered by controlled fixtures only.', 'No elapsed S/W/E/P profile, other backend/platform or minimum-editor acceptance claim.',
    'Input writes are not confirmed billable API acceptance; no spend claim.'] };
fs.writeFileSync(path.join(directory, 'native-acceptance-audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit));
