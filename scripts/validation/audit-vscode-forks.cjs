/* Independent read-only PC-10 audit after normal owned-editor exit. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const directory = path.resolve(process.env.MYSTI_PC10_ARTIFACT_DIR);
assert(directory.startsWith(path.join(repo, 'out-test/feature-tests/PC-10') + path.sep));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = file => digest(fs.readFileSync(file));
const manifest = read(path.join(directory, 'prepared.json'));
assert.equal(manifest.case, 'PC-10'); assert.equal(manifest.artifactDir, directory);
const owner = manifest.windows.A;
const marker = read(path.join(owner.profile, '.mysti-test-owned.json'));
assert.equal(marker.case, 'PC-10'); assert.equal(marker.profile, fs.realpathSync(owner.profile));
assert.equal(read(path.join(directory, 'native-result.json')).status, 'PASS');
for (const extension of [manifest.sourcePackage, owner.installedExtension]) {
  assert.equal(hash(path.join(extension, 'dist/extension.js')), manifest.bundleSha256);
  assert.equal(hash(path.join(extension, 'media/chat/chat.js')), manifest.chatSha256);
}
const launch = read(path.join(owner.directory, 'launch.json'));
assert.equal(launch.profile, owner.profile); assert.equal(launch.installedExtension, owner.installedExtension);
assert(launch.args.every(arg => !/extensionTestsPath/i.test(arg)));
const exit = read(path.join(owner.directory, 'editor-exit.json'));
assert.equal(exit.code, 0); assert.equal(exit.helper.failures, 0); assert.equal(exit.timedOut, false);
const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
assert.equal(cleanup.unverifiedLiveReceiptPids.length, 0);
const ancestry = read(path.join(owner.directory, 'process-ancestry.json'));
assert(ancestry.processIdentities.length > 0);
const live = new Map(execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
  const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return [+match[1], match[2]];
}));
for (const identity of ancestry.processIdentities) assert.notEqual(live.get(identity.pid), identity.startedAt, `Observed process still alive: ${identity.pid}`);
const receipts = owner.receiptPaths.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
for (const receipt of receipts) for (const pid of [receipt.wrapperPid, receipt.childPid].filter(Boolean)) {
  if (!live.has(pid)) continue;
  const captured = ancestry.processIdentities.filter(identity => identity.pid === pid);
  const birth = Date.parse(live.get(pid));
  assert((captured.length && captured.every(identity => identity.startedAt !== live.get(pid))) || (Number.isFinite(birth) && birth > receipt.at), `Unverified live receipt PID: ${pid}`);
}
const requests = receipts.filter(value => value.event === 'request'); assert.equal(requests.length, 5);
const expected = [['SOURCE_1', 'claude-code'], ['SOURCE_2', 'claude-code'], ['SOURCE_3', 'claude-code'], ['BRANCH_ALT', 'openai-codex'], ['SOURCE_CONTINUE', 'claude-code']];
const events = read(path.join(owner.directory, 'observations.json'));
assert.equal(events.filter(value => value.event === 'case-outcome' && value.state === 'passed').length, 1);
const responses = events.filter(value => value.event === 'native-response'); assert.equal(responses.length, 5);
for (let index = 0; index < expected.length; index++) {
  const [marker, provider] = expected[index], request = requests.slice().sort((a, b) => a.at - b.at)[index], response = responses[index];
  assert(request.markers.includes(marker)); assert.equal(request.provider, provider);
  if (marker === 'SOURCE_CONTINUE') assert(!request.markers.includes('BRANCH_ALT'));
  if (marker === 'BRANCH_ALT') assert(!request.markers.includes('SOURCE_CONTINUE'));
  assert.equal(response.marker, marker); assert.equal(response.provider, provider);
  assert.equal(response.model, provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol');
  assert(response.content.includes(manifest.token)); assert(response.content.includes(`PC10_DONE:${marker}`));
  if (index === 0) { assert(response.toolCount > 0); assert(response.segmentTypes.includes('tool')); }
}
const acceptance = read(path.join(owner.directory, 'acceptance.json'));
assert.equal(acceptance.status, 'PASS_BOUNDED_NATIVE_FORKS');
assert.equal(acceptance.finalConversations.length, 3);
assert.deepEqual(acceptance.menuClicks.map(value => value.action), ['fork', 'fork-rewind', 'fork-rewind']);
const database = path.join(owner.profile, 'User/globalStorage/state.vscdb');
assert(fs.existsSync(database), 'Ordinary launch must produce the actual disk-backed profile store');
// Read only Mysti's exact key in the exact owned database. No disk injection,
// no helper memento substitute, and no raw thinking is written to evidence.
const sqlite = `
import sqlite3,json,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
rows=list(db.execute("SELECT value FROM ItemTable WHERE lower(key)='deepmyst.mysti'"))
assert len(rows)==1,'Expected exactly one Mysti memento'
value=json.loads(rows[0][0]); blob=value.get('mysti.conversations',{})
conversations=blob.get('conversations',[])
assert isinstance(conversations,list)
for entry in conversations:
 assert isinstance(entry,list) and len(entry)==2 and entry[0]==entry[1].get('id')
print(json.dumps({'conversations':[entry[1] for entry in conversations],'schemaVersion':blob.get('schemaVersion')}))
`;
const stored = JSON.parse(execFileSync('python3', ['-c', sqlite, database], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
assert.deepEqual(stored.conversations.map(value => value.id).sort(), acceptance.finalPublicHistoryIds, 'Actual disk IDs must match final public history without orphan forks');
assert.deepEqual(acceptance.finalPublicHistoryIds, [...acceptance.initialHistoryIds, acceptance.alternateBranchId, acceptance.rewindBranchId].sort());
for (const expected of acceptance.finalConversations) {
  const actual = stored.conversations.find(value => value.id === expected.id); assert(actual, 'Every completed branch must be on actual disk');
  assert.equal(digest(canonical(actual)), expected.canonicalSha256, `Persisted conversation differs: ${expected.id}`);
  assert.deepEqual(actual.messages.map(value => value.id), expected.messages.map(value => value.id));
  for (let index = 0; index < actual.messages.length; index++) assert.equal(digest(canonical(actual.messages[index])), expected.messages[index].canonicalSha256);
}
const original = acceptance.finalConversations.find(value => value.id === acceptance.originalSourceId);
const alternate = acceptance.finalConversations.find(value => value.id === acceptance.alternateBranchId);
const rewind = acceptance.finalConversations.find(value => value.id === acceptance.rewindBranchId);
assert.equal(original.messages.length, 8); assert.equal(alternate.messages.length, 7); assert.equal(rewind.messages.length, 5);
for (const branch of [alternate, rewind]) assert.deepEqual(branch.messages.slice(0, 5).map(value => value.canonicalSha256), original.messages.slice(0, 5).map(value => value.canonicalSha256));
const fileContents = {};
function visit(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) visit(file); else { assert(entry.isFile()); fileContents[path.relative(owner.workspace, file)] = fs.readFileSync(file, 'utf8'); }
  }
}
visit(owner.workspace); assert.deepEqual(fileContents, acceptance.finalFiles);
assert.equal(execFileSync('git', ['ls-files', '--stage'], { cwd: owner.workspace, encoding: 'utf8' }), manifest.originalIndex);
const audit = { status: 'PASS_BOUNDED_NATIVE_FORKS', auditedAt: new Date().toISOString(), database,
  bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256, actualDiskConversationCount: stored.conversations.length,
  acceptedConversations: acceptance.finalConversations.map(value => ({ id: value.id, messageCount: value.messages.length, canonicalSha256: value.canonicalSha256 })),
  conversationalInputs: requests.length, auxiliaryInputs: receipts.filter(value => value.event === 'auxiliary-input').length,
  actualModelReceipts: receipts.filter(value => value.event === 'session').map(value => ({ provider: value.provider, model: value.model, sessionHash: value.sessionHash })),
  observedExitedIdentities: ancestry.processIdentities.length, limitations: acceptance.limitations,
  semanticReview: acceptance.semanticReview,
  indexEvidenceScope: acceptance.indexEvidenceScope,
};
fs.writeFileSync(path.join(directory, 'native-acceptance-audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit));
