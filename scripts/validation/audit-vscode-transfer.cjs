/* PC-11 independent post-exit audit. No editor, model or clipboard access. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { inflateSync } = require('node:zlib');
const repo = path.resolve(__dirname, '../..'), directory = path.resolve(process.env.MYSTI_PC11_ARTIFACT_DIR);
assert(directory.startsWith(path.join(repo, 'out-test/feature-tests/PC-11') + path.sep));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(value).digest('hex'), digest = value => hash(canonical(value));
const manifest = read(path.join(directory, 'prepared.json')); assert.equal(manifest.case, 'PC-11'); assert.equal(manifest.artifactDir, directory);
assert.equal(read(path.join(directory, 'native-result.json')).status, 'PASS', 'Failed native attempts cannot be converted into PASS');
if (manifest.mode === 'ack-smoke') {
  assert.deepEqual(Object.keys(manifest.windows), ['A']); assert.equal(manifest.conversationalRequestsPlanned, 0);
  const owner = manifest.windows.A, acceptance = read(path.join(owner.directory, 'acceptance.json'));
  assert.equal(acceptance.status, 'PASS_NATIVE_IMPORT_ACKNOWLEDGEMENTS'); assert.equal(acceptance.clipboardAccessed, false);
  const marker = read(path.join(owner.profile, '.mysti-test-owned.json')); assert.equal(marker.case, 'PC-11'); assert.equal(marker.profile, fs.realpathSync(owner.profile));
  for (const extension of [manifest.sourcePackage, owner.installedExtension]) {
    assert.equal(hash(fs.readFileSync(path.join(extension, 'dist/extension.js'))), manifest.bundleSha256);
    assert.equal(hash(fs.readFileSync(path.join(extension, 'media/chat/chat.js'))), manifest.chatSha256);
  }
  const launch = read(path.join(owner.directory, 'launch.json')); assert.equal(launch.profile, owner.profile);
  assert(launch.args.every(value => !/extensionTestsPath/i.test(value))); assert.equal(read(path.join(directory, 'launch-reservation.json')).plannedConversationRequests, 0);
  const exit = read(path.join(owner.directory, 'editor-exit.json')); assert.equal(exit.code, 0); assert.equal(exit.helper.failures, 0); assert.equal(exit.timedOut, false);
  assert.equal(read(path.join(owner.directory, 'editor-exit-process-check.json')).status, 'PASS_OBSERVED_IDENTITIES_EXITED');
  const live = new Map(execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => { const m = line.trim().match(/^(\d+)\s+(.+)$/); assert(m); return [+m[1], m[2]]; }));
  const ancestry = read(path.join(owner.directory, 'process-ancestry.json')); assert(ancestry.processIdentities.length);
  for (const process of ancestry.processIdentities) assert.notEqual(live.get(process.pid), process.startedAt, `Observed process remains: ${process.pid}`);
  const receipts = owner.receiptPaths.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
  assert.equal(receipts.filter(value => ['request', 'auxiliary-input'].includes(value.event)).length, 0);
  const blockedInferenceLaunches = receipts.filter(value => value.event === 'inference-launch-refused').map(value => ({ provider: value.provider, at: value.at, wrapperPid: value.wrapperPid, reason: value.reason, invocationKind: value.invocationKind }));
  for (const attempt of acceptance.blockedInferenceLaunches) assert(blockedInferenceLaunches.some(value => digest(value) === digest(attempt)));
  const readOnlyVersionProbeLaunches = receipts.filter(value => value.event === 'read-only-probe-start').length;
  assert(readOnlyVersionProbeLaunches >= acceptance.readOnlyVersionProbeLaunches);
  assert(receipts.every(value => ['inference-launch-refused', 'read-only-probe-start', 'read-only-probe-exit'].includes(value.event)));
  const observations = read(path.join(owner.directory, 'observations.json')); assert.equal(observations.filter(value => value.event === 'case-outcome' && value.state === 'passed').length, 1);
  assert(!observations.some(value => /clipboard|native-response|request-submitted/.test(value.event)));
  const identity = observations.find(value => value.event === 'identity'); assert(identity); assert.equal(identity.extensionTestsPathUsed, false);
  assert(identity.isUnderDevelopment === false || identity.isUnderDevelopment === 'NOT_EXPOSED_BY_PUBLIC_API');
  const database = path.join(owner.profile, 'User/globalStorage/state.vscdb'); assert(fs.existsSync(database));
  const program = `import sqlite3,json,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
rows=list(db.execute("SELECT value FROM ItemTable WHERE lower(key)='deepmyst.mysti'"))
assert len(rows)==1
data=json.loads(rows[0][0]).get('mysti.conversations',{}).get('conversations',[])
for item in data: assert isinstance(item,list) and len(item)==2 and item[0]==item[1].get('id')
print(json.dumps([item[1] for item in data]))`;
  const stored = JSON.parse(execFileSync('python3', ['-c', program, database], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 }));
  assert.deepEqual(stored.map(value => value.id).sort(), acceptance.finalConversations.map(value => value.id).sort());
  for (const proof of acceptance.finalConversations) assert.equal(digest(stored.find(value => value.id === proof.id)), proof.canonicalSha256);
  assert.deepEqual(acceptance.imports.map(value => value.format), ['json', 'markdown', 'jsonl']);
  const requestIds = new Set();
  for (const [index, proof] of acceptance.imports.entries()) {
    const fixture = manifest.acknowledgementFixtures[index]; assert.equal(hash(fs.readFileSync(fixture.file)), fixture.sha256);
    assert.equal(proof.acknowledgement.operation, 'import'); assert.equal(proof.acknowledgement.success, true); assert(!('format' in proof.acknowledgement));
    assert(!requestIds.has(proof.acknowledgement.requestId)); requestIds.add(proof.acknowledgement.requestId);
    const imported = stored.find(value => value.id === proof.importedId); assert(imported);
    assert.equal(digest(imported.messages.map(value => ({ role: value.role, content: value.content }))), digest(fixture.messages));
    assert.deepEqual(proof.visibleProofs.map(value => ({ id: value.id, role: value.role })), imported.messages.map(value => ({ id: value.id, role: value.role })));
    assert(proof.visibleProofs.every(value => value.anchors.length > 0 && /^[a-f0-9]{64}$/.test(value.visibleTextSha256)));
  }
  assert.equal(acceptance.cancelled.operation, 'import'); assert.equal(acceptance.cancelled.cancelled, true); assert.equal(acceptance.cancelled.success, false); assert(!('format' in acceptance.cancelled));
  assert(!requestIds.has(acceptance.cancelled.requestId));
  for (const [relative, contents] of Object.entries(manifest.files)) assert.equal(hash(fs.readFileSync(path.join(owner.workspace, relative))), hash(contents));
  assert.equal(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--stage'], { cwd: owner.workspace, encoding: 'utf8', timeout: 10000 }), manifest.originalIndex);
  const audit = { status: 'PASS_NATIVE_IMPORT_ACKNOWLEDGEMENTS', auditedAt: new Date().toISOString(), profile: owner.profile, extensionHostPid: identity.extensionHostPid,
    bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256, imports: ['json', 'markdown', 'jsonl'], cancelledImport: true,
    conversationalInputs: 0, auxiliaryInputs: 0, blockedInferenceLaunches, readOnlyVersionProbeLaunches, clipboardAccessed: false, observedExitedIdentities: ancestry.processIdentities.length, diskConversations: stored.length,
    ownedFixtureFilesUnchanged: true, stagedEntriesUnchanged: true, limitations: acceptance.limits };
  fs.writeFileSync(path.join(directory, 'native-acceptance-audit.json'), JSON.stringify(audit, null, 2)); console.log(JSON.stringify(audit)); process.exit(0);
}
const source = read(path.join(manifest.exchange, 'source-ready.json'));
const acceptance = read(path.join(manifest.windows.B.directory, 'acceptance.json')); assert.equal(acceptance.status, 'PASS_BOUNDED_NATIVE_TRANSFER');
assert(source.clipboardCleanup.ok && (source.clipboardCleanup.restored || source.clipboardCleanup.preservedNewerClipboard));
const live = new Map(execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => { const m = line.trim().match(/^(\d+)\s+(.+)$/); assert(m); return [+m[1], m[2]]; }));
const reports = [], storedByWindow = {}, responses = [];
const expectedRequests = { A: ['SOURCE_1', 'SOURCE_2'], B: ['IMPORT_CONTINUE', 'SIBLING_LIVE', 'ACTIVE_IMPORT', 'AFTER_IMPORT', 'URI_CONTINUE'] };
const expectedProviders = { SOURCE_1: 'claude-code', SOURCE_2: 'openai-codex', IMPORT_CONTINUE: 'claude-code', SIBLING_LIVE: 'openai-codex', ACTIVE_IMPORT: 'claude-code', AFTER_IMPORT: 'openai-codex', URI_CONTINUE: 'claude-code' };
for (const id of ['A', 'B']) {
  const owner = manifest.windows[id];
  const marker = read(path.join(owner.profile, '.mysti-test-owned.json')); assert.equal(marker.case, 'PC-11'); assert.equal(marker.profile, fs.realpathSync(owner.profile));
  for (const extension of [manifest.sourcePackage, owner.installedExtension]) {
    assert.equal(hash(fs.readFileSync(path.join(extension, 'dist/extension.js'))), manifest.bundleSha256);
    assert.equal(hash(fs.readFileSync(path.join(extension, 'media/chat/chat.js'))), manifest.chatSha256);
  }
  const launch = read(path.join(owner.directory, 'launch.json')); assert.equal(launch.profile, owner.profile); assert.equal(launch.installedExtension, owner.installedExtension);
  assert(launch.args.every(value => !/extensionTestsPath/i.test(value)));
  const exit = read(path.join(owner.directory, 'editor-exit.json')); assert.equal(exit.code, 0); assert.equal(exit.helper.failures, 0); assert.equal(exit.timedOut, false);
  assert.equal(read(path.join(owner.directory, 'editor-exit-process-check.json')).status, 'PASS_OBSERVED_IDENTITIES_EXITED');
  assert(!fs.existsSync(path.join(owner.directory, 'clipboard-restore-failed.json')), 'A recovery path remains a failed attempt even if later recovered');
  const ancestry = read(path.join(owner.directory, 'process-ancestry.json')); assert(ancestry.processIdentities.length);
  for (const process of ancestry.processIdentities) assert.notEqual(live.get(process.pid), process.startedAt, `Observed process remains: ${process.pid}`);
  const receipts = owner.receiptPaths.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
  for (const receipt of receipts) for (const pid of [receipt.wrapperPid, receipt.childPid].filter(Boolean)) {
    if (!live.has(pid)) continue;
    const captured = ancestry.processIdentities.filter(value => value.pid === pid), birth = Date.parse(live.get(pid));
    assert((captured.length && captured.every(value => value.startedAt !== live.get(pid))) || (Number.isFinite(birth) && birth > receipt.at), 'Unverified live receipt PID');
  }
  const requests = receipts.filter(value => value.event === 'request').sort((a, b) => a.at - b.at); assert.equal(requests.length, expectedRequests[id].length);
  for (let n = 0; n < requests.length; n++) {
    const marker = expectedRequests[id][n], request = requests[n]; assert(request.markers.includes(marker)); assert.equal(request.provider, expectedProviders[marker]);
    assert(request.markerOrigins && Array.isArray(request.markerOrigins.outsideProjectMemoryMarkers));
    if (marker === 'AFTER_IMPORT') assert(['ACTIVE_IMPORT', 'IMPORT_CONTINUE', 'SIBLING_LIVE'].every(value => !request.markerOrigins.outsideProjectMemoryMarkers.includes(value)));
    if (marker === 'URI_CONTINUE') assert(['ACTIVE_IMPORT', 'AFTER_IMPORT', 'IMPORT_CONTINUE', 'SIBLING_LIVE'].every(value => !request.markerOrigins.outsideProjectMemoryMarkers.includes(value)));
  }
  const observations = read(path.join(owner.directory, 'observations.json')); assert.equal(observations.filter(value => value.event === 'case-outcome' && value.state === 'passed').length, 1);
  const identity = observations.find(value => value.event === 'identity'); assert(identity); assert.equal(identity.extensionTestsPathUsed, false);
  assert(identity.isUnderDevelopment === false || identity.isUnderDevelopment === 'NOT_EXPOSED_BY_PUBLIC_API');
  const completed = observations.filter(value => value.event === 'native-response'); assert.equal(completed.length, id === 'A' ? 2 : 4);
  for (const response of completed) {
    assert.equal(response.provider, expectedProviders[response.marker]);
    assert.equal(response.model, response.provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol');
    assert(response.content.includes(response.marker === 'SIBLING_LIVE' ? manifest.siblingToken : manifest.token)); assert(response.content.includes('PC11_DONE:' + response.marker)); responses.push(response);
  }
  const database = path.join(owner.profile, 'User/globalStorage/state.vscdb'); assert(fs.existsSync(database));
  const program = `import sqlite3,json,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
rows=list(db.execute("SELECT value FROM ItemTable WHERE lower(key)='deepmyst.mysti'"))
assert len(rows)==1
data=json.loads(rows[0][0]).get('mysti.conversations',{}).get('conversations',[])
for item in data: assert isinstance(item,list) and len(item)==2 and item[0]==item[1].get('id')
print(json.dumps([item[1] for item in data]))`;
  const stored = JSON.parse(execFileSync('python3', ['-c', program, database], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 })); storedByWindow[id] = stored;
  const expected = id === 'A' ? source.finalConversations : acceptance.finalConversations;
  assert.deepEqual(stored.map(value => value.id).sort(), expected.map(value => value.id).sort(), 'Real disk IDs must match public final history');
  for (const proof of expected) assert.equal(digest(stored.find(value => value.id === proof.id)), proof.canonicalSha256);
  reports.push({ window: id, profile: owner.profile, extensionHostPid: identity.extensionHostPid, conversationalInputs: requests.length,
    auxiliaryInputs: receipts.filter(value => value.event === 'auxiliary-input').length, observedExitedIdentities: ancestry.processIdentities.length,
    completedResponses: completed.length, diskConversations: stored.length,
    nativeContextOrigins: requests.filter(value => value.markers.includes('AFTER_IMPORT') || value.markers.includes('URI_CONTINUE')).map(value => value.markerOrigins) });
}
for (const [relative, contents] of Object.entries(manifest.files)) assert.equal(hash(fs.readFileSync(path.join(manifest.windows.A.workspace, relative))), hash(contents), 'Owned source file changed: ' + relative);
assert.equal(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--stage'], { cwd: manifest.windows.A.workspace, encoding: 'utf8', timeout: 10000 }), manifest.originalIndex, 'Staged-entry semantics changed');
assert.equal(fs.readFileSync(path.join(manifest.windows.B.workspace, 'README.md'), 'utf8'), 'Owned PC11 receiving workspace. Native agents may not change files.\n');
assert.notEqual(reports[0].extensionHostPid, reports[1].extensionHostPid); assert.notEqual(reports[0].profile, reports[1].profile);
assert.equal(hash(fs.readFileSync(manifest.exports.json)), source.jsonSha256); assert.equal(hash(fs.readFileSync(manifest.exports.markdown)), source.markdownSha256);
assert.equal(digest(read(manifest.exports.json).conversation), digest(source.source));
const imported = storedByWindow.B.find(value => value.id === acceptance.jsonImportId);
const markdownImport = storedByWindow.B.find(value => value.id === acceptance.markdownImportId);
const shared = storedByWindow.B.find(value => value.id === acceptance.sharedId);
function expectedImported(message) { const value = JSON.parse(JSON.stringify(message)); delete value.id; delete value.checkpoint; if (value.toolCalls) value.toolCalls = value.toolCalls.map(tool => ({ ...tool, historicalOnly: true })); return value; }
for (let i = 0; i < source.source.messages.length; i++) {
  const actual = imported.messages[i], original = source.source.messages[i]; assert.notEqual(actual.id, original.id); assert.equal(actual.checkpoint, undefined);
  assert((actual.toolCalls || []).every(tool => tool.historicalOnly === true));
  const withoutId = { ...actual }; delete withoutId.id;
  assert.equal(digest(withoutId), digest(expectedImported(original)));
}
assert.deepEqual(markdownImport.messages.map(value => ({ role: value.role, content: value.content })), source.source.messages.map(value => ({ role: value.role, content: value.content })));
const compact = JSON.parse(inflateSync(Buffer.from(new URL(source.uri).searchParams.get('data'), 'base64url'), { maxOutputLength: 1024 * 1024 })); assert.deepEqual(compact, source.shortShare);
assert.deepEqual(shared.messages.slice(0, compact.m.length).map(value => ({ r: value.role === 'user' ? 'u' : 'a', c: value.content })), compact.m);
assert(acceptance.siblingCompleteAt > acceptance.importAt);
const preflight = read(path.join(manifest.windows.B.directory, 'uri-routing-preflight.json'));
assert.equal(preflight.profile, manifest.windows.B.profile); assert.equal(preflight.extensionHostPid, reports[1].extensionHostPid); assert.equal(preflight.nonce, manifest.uriPreflightNonce);
const audit = { status: 'PASS_BOUNDED_NATIVE_TRANSFER', auditedAt: new Date().toISOString(), reports, bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256,
  clipboardOutcome: source.clipboardCleanup, ownedFixtureFilesUnchanged: true, stagedEntriesUnchanged: true, actualOwnedUriPreflight: true, importedCheckpointRefsRemoved: true, importedToolsHistoricalOnly: true,
  semanticReview: acceptance.semanticReview, limitations: [...acceptance.limits, 'Process identities sampled at 250ms; short-lived processes may be missed.', 'Input writes are not confirmed billable API acceptance; no spend claim.'] };
fs.writeFileSync(path.join(directory, 'native-acceptance-audit.json'), JSON.stringify(audit, null, 2)); console.log(JSON.stringify(audit));
