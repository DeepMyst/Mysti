'use strict';
// Prelaunch-qualified bounded editor identity joining. No process launch or name normalization.
// New campaign-bound proof loading is additive; the qualified canonical witness algorithm is retained.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const one = (rows, why) => { assert.equal(rows.length, 1, why); return rows[0]; };
const key = row => `${row.pid}|${row.startedAt}`;
function pinShape(pin) { assert(pin && path.isAbsolute(pin.path)); assert.equal(path.normalize(pin.path), pin.path); assert(/^[a-f0-9]{64}$/.test(pin.sha256)); }
function readPinnedFile(pin) {
  pinShape(pin); assert.equal(fs.realpathSync(pin.path), pin.path, 'Canonical proof path without symlink components');
  const before = fs.lstatSync(pin.path); assert(before.isFile() && !before.isSymbolicLink(), 'Regular proof file'); assert.equal(before.nlink, 1, 'Private proof file cannot alias another path');
  const bytes = fs.readFileSync(pin.path); const after = fs.lstatSync(pin.path);
  for (const k of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(before[k], after[k], 'Proof cannot change during read');
  assert.equal(hash(bytes), pin.sha256, 'Exact proof bytes'); return bytes;
}
function secondsAtAmman(value) {
  assert.equal(typeof value, 'string');
  const m = value.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  assert(m, 'Exact recorded ps lstart format');
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[2]);
  const local = new Date(Date.UTC(+m[7], month, +m[3], +m[4], +m[5], +m[6]));
  assert.equal(local.getUTCMonth(), month); assert.equal(local.getUTCDate(), +m[3]);
  assert.equal(local.getUTCHours(), +m[4]); assert.equal(local.getUTCMinutes(), +m[5]); assert.equal(local.getUTCSeconds(), +m[6]);
  assert.equal(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][local.getUTCDay()], m[1]);
  // These October 2026 records use Asia/Amman, UTC+03:00; this is an explicit campaign constraint.
  // This is explicit evidence interpretation, independent of the reviewer's TZ.
  return local.getTime() / 1000 - 180 * 60;
}
function verifyRootIdentity(segment, proof) {
  assert(segment && proof); const { manifest, ancestry } = segment; const owner = manifest.windows.A;
  assert.equal(segment.exit.code, 0); assert.equal(segment.exit.signal, null); assert.equal(segment.exit.timedOut, false);
  assert.equal(segment.cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(segment.cleanup.remaining, []);
  for (const name of ['manifestIdentity','ancestryIdentity','discoveryIdentity','editorIdentity']) pinShape(proof[name]);
  assert.equal(proof.manifestIdentity.path, path.join(manifest.artifactDir, 'prepared.json'));
  assert.equal(proof.ancestryIdentity.path, path.join(owner.directory, 'process-ancestry.json'));
  assert.deepEqual(proof.ready.manifest, proof.manifestIdentity, 'Prospective observer belongs to this exact prepared manifest');
  assert.deepEqual(proof.ready.editorIdentity, proof.editorIdentity, 'Prospective canonical executable pin');
  assert.equal(path.basename(proof.editorIdentity.path), 'Code');
  assert.equal(proof.ready.status, 'READY_PASSIVE_NO_TARGET_INPUTS');
  assert.equal(proof.ready.observer.uid, proof.uid); assert(Number.isInteger(proof.uid) && proof.uid >= 0);
  assert.equal(proof.result.collectionComplete, true); assert.equal(proof.result.manifestUnchanged, true);
  assert.equal(proof.result.stopReason, 'explicit-root-stop'); assert.equal(proof.result.watcherExitCode, 0);
  assert.deepEqual(proof.result.events, proof.discoveryIdentity, 'Final passive result seals the complete discovery bytes');
  const launch = proof.launch;
  assert.equal(launch.window, 'A'); assert.equal(launch.profile, owner.profile); assert.equal(launch.extensionTestsPathUsed, false);
  assert.equal(launch.installedExtension, owner.installedExtension);
  for (const arg of [owner.workspace, `--user-data-dir=${owner.profile}`, `--extensions-dir=${owner.extensionsDir}`]) assert(launch.args.includes(arg));
  const roots = ancestry.processDetails.filter(row => ['Code', '(Code)'].includes(row.executableBasename) && !ancestry.processIdentities.some(parent => parent.pid === row.parentPid && parent.startedAt === row.parentStartedAt));
  const root = one(roots, 'Exactly one candidate root; only Code or (Code) may receive canonical proof');
  assert.equal(key(root), key(ancestry.processDetails[0]), 'Runner inserts its spawned editor root before descendants');
  assert.equal(key(root), key(ancestry.processIdentities[0]), 'First runner-owned process birth is the editor');
  one(ancestry.processIdentities.filter(row => key(row) === key(root)), 'Unique recorded editor birth');
  const receiptPaths = [...owner.receiptPaths, ...owner.auxiliaryReceiptPaths];
  assert.deepEqual(Object.keys(proof.receiptBytes).sort(), [...receiptPaths].sort());
  assert.deepEqual(proof.result.receipts.map(row => row.path).sort(), [...receiptPaths].sort());
  for (const file of receiptPaths) {
    const bytes = proof.receiptBytes[file]; assert(Buffer.isBuffer(bytes));
    const seal = one(proof.result.receipts.filter(row => row.path === file), 'One final passive receipt seal');
    assert.equal(seal.bytesRead, bytes.length); assert.equal(seal.partialLineBytes, 0); assert.equal(seal.completeUnchangedRead, true);
    assert.equal(seal.sha256, hash(bytes)); assert.deepEqual(seal.finalIdentity, { path: file, sha256: hash(bytes) });
  }
  assert(Array.isArray(proof.joins) && proof.joins.length >= 2, 'At least two independently timed prospective root witnesses');
  assert(new Set(proof.joins.map(row => row.at)).size >= 2, 'Repeated witnesses must have distinct observation times');
  const witnesses = [], seen = new Set(); let preciseIdentity;
  for (const join of proof.joins) {
    assert.equal(join.event, 'owned-ancestry-join'); assert(Number.isSafeInteger(join.seq)); assert(!seen.has(join.seq)); seen.add(join.seq);
    assert.equal(join.source.path, proof.ancestryIdentity.path); pinShape(join.source);
    assert(Number.isFinite(join.at) && Number.isFinite(Date.parse(join.source.sampledAt)));
    assert(Date.parse(join.source.sampledAt) <= join.at * 1000);
    assert(Date.parse(join.source.sampledAt) <= Date.parse(ancestry.sampledAt));
    const ref = join.receipt; assert(receiptPaths.includes(ref.path), 'Witness receipt belongs to this editor segment');
    const bytes = proof.receiptBytes[ref.path];
    assert(Number.isSafeInteger(ref.offset) && ref.offset >= 0 && Number.isSafeInteger(ref.bytes) && ref.bytes > 0);
    assert(ref.offset + ref.bytes <= bytes.length); assert(ref.offset === 0 || bytes[ref.offset - 1] === 10, 'Receipt byte range starts on a line boundary');
    const line = bytes.subarray(ref.offset, ref.offset + ref.bytes);
    assert.equal(line.at(-1), 10); assert.equal(hash(line), ref.sha256, 'Actual complete receipt byte-range pin');
    const receipt = JSON.parse(line.toString('utf8'));
    for (const field of ['event','wrapperPid','childPid','at','provider']) assert.equal(receipt[field], ref[field], 'Prospective witness matches actual receipt');
    assert(['probe-start', 'start', 'auxiliary-start'].includes(ref.event));
    assert(ref.at <= join.at * 1000);
    const historical = join.rootRow;
    assert.equal(historical.executableBasename, 'Code', 'Prospective live root was the exact canonical editor basename');
    for (const field of ['pid','parentPid','startedAt','parentStartedAt','firstObservedAt']) assert.equal(historical[field], root[field], 'Prospective and final runner root identities agree');
    assert(Date.parse(historical.lastObservedAt) <= Date.parse(root.lastObservedAt));
    assert(Date.parse(historical.lastObservedAt) <= Date.parse(join.source.sampledAt));
    const chain = join.liveChain; assert(Array.isArray(chain) && chain.length >= 2 && chain.length <= 32);
    assert.equal(new Set(chain.map(row => row.pid)).size, chain.length, 'Acyclic exact live ancestry chain');
    for (let i = 0; i < chain.length; i++) {
      const item = chain[i]; assert(Number.isSafeInteger(item.pid) && item.pid > 0);
      assert(Number.isSafeInteger(item.startSec) && Number.isSafeInteger(item.startUsec) && item.startUsec >= 0 && item.startUsec < 1000000);
      assert.equal(item.uid, proof.uid); assert(path.isAbsolute(item.executablePath));
      assert(item.startSec + item.startUsec / 1e6 <= join.at);
      one(ancestry.processIdentities.filter(row => row.pid === item.pid && secondsAtAmman(row.startedAt) === item.startSec), 'Kernel chain birth joins runner-owned identity');
      if (i + 1 < chain.length) assert.equal(item.ppid, chain[i + 1].pid, 'Unbroken live parent chain');
    }
    const first = chain[0], last = chain.at(-1);
    assert.equal(first.pid, ref.wrapperPid); assert.equal(first.pid, join.wrapperRow.pid);
    assert.equal(first.ppid, join.wrapperRow.parentPid); assert.equal(first.startSec, secondsAtAmman(join.wrapperRow.startedAt));
    assert.equal(chain[1].startSec, secondsAtAmman(join.wrapperRow.parentStartedAt));
    assert.equal(last.pid, root.pid); assert.equal(last.ppid, root.parentPid); assert.equal(last.pgid, last.pid);
    assert.equal(last.startSec, secondsAtAmman(root.startedAt)); assert.equal(last.executablePath, proof.editorIdentity.path);
    assert(proof.ready.observer.startSec + proof.ready.observer.startUsec / 1e6 < last.startSec + last.startUsec / 1e6, 'Observer is prospective to the root birth');
    const identity = { pid: last.pid, ppid: last.ppid, pgid: last.pgid, uid: last.uid, startSec: last.startSec, startUsec: last.startUsec, executablePath: last.executablePath };
    if (preciseIdentity) assert.deepEqual(identity, preciseIdentity, 'All independent witnesses agree on microsecond root birth'); else preciseIdentity = identity;
    witnesses.push({ seq: join.seq, at: join.at, receipt: ref, ancestrySource: join.source, root: identity });
  }
  return { status: 'VERIFIED_PRELAUNCH_BOUND_EDITOR_ROOT_IDENTITY', root: { ...root }, preciseIdentity, witnessCount: witnesses.length, witnesses,
    manifest: proof.manifestIdentity, ancestry: proof.ancestryIdentity, discovery: proof.discoveryIdentity, editorIdentity: proof.editorIdentity,
    timezone: 'Asia/Amman UTC+03:00, recorded October 2026',
    limitations: ['No PID exists in launch.json; runner-owned first birth is joined to prospective kernel ancestry instead.', 'Intermediate ancestry JSON was overwritten during collection; its recorded hash is retained, not compared with the different final file.', 'Canonical root identity does not establish complete kernel-exit coverage or change historical campaign outcomes.'] };
}

function fileIdentity(file) {
  pinShape({ path: file, sha256: '0'.repeat(64) });
  return { path: file, sha256: hash(fs.readFileSync(file)) };
}
function ownedProof(file, directory) {
  assert(file.startsWith(directory + path.sep), 'Proof must belong to its prelaunch-bound directory');
  assert.equal(fs.realpathSync(directory), directory); assert(fs.lstatSync(directory).isDirectory());
  assert.equal(fs.statSync(directory).uid, process.getuid());
  const identity = fileIdentity(file), bytes = readPinnedFile(identity);
  assert.equal(fs.statSync(file).uid, process.getuid()); return { identity, bytes };
}
function validateBindings(segment) {
  const manifest = segment.manifest, campaign = manifest.campaign, index = manifest.segment.index;
  assert.equal(manifest.stage, 'F2_TASK_DUE_DATE_TIMED_SEQUENTIAL'); assert.equal(campaign.stage, 'F2_TASK_DUE_DATE_TIMED_SEQUENTIAL');
  assert([1, 2].includes(index));
  assert.equal(manifest.artifactDir, path.join(campaign.directory, `segment-${index}`));
  assert.deepEqual(Object.keys(campaign.passiveEvidenceDirectories).sort(), ['1', '2']);
  const directory = campaign.passiveEvidenceDirectories[String(index)];
  assert(path.isAbsolute(directory)); assert.equal(path.normalize(directory), directory);
  assert.equal(directory, path.join(path.dirname(campaign.directory), `task-due-date-timed-segment-${index}-passive-processes`));
  assert.equal(manifest.passiveEvidenceDirectory, directory);
  assert.deepEqual(manifest.editorIdentity, campaign.editorIdentity, 'Exact canonical editor pin captured before launch');
  pinShape(manifest.editorIdentity); assert.equal(path.basename(manifest.editorIdentity.path), 'Code');
  assert.equal(manifest.windows.A.directory, path.join(manifest.artifactDir, 'window-A'));
  return { directory, editorIdentity: manifest.editorIdentity };
}
function loadProof(segment) {
  const manifest = segment.manifest, owner = manifest.windows.A;
  const { directory, editorIdentity } = validateBindings(segment), inputs = [];
  const load = (file, root, parse = true) => { const value = ownedProof(file, root); inputs.push(value.identity); return parse ? JSON.parse(value.bytes.toString('utf8')) : value; };
  const manifestIdentity = fileIdentity(path.join(manifest.artifactDir, 'prepared.json'));
  assert.deepEqual(load(manifestIdentity.path, manifest.artifactDir), manifest, 'Audited manifest is the exact saved prelaunch manifest');
  const campaign = load(path.join(manifest.campaign.directory, 'campaign.json'), manifest.campaign.directory);
  const { identity: campaignIdentity, ...embeddedCampaign } = manifest.campaign;
  assert.deepEqual(campaignIdentity, fileIdentity(path.join(campaign.directory, 'campaign.json')));
  assert.deepEqual(campaign, embeddedCampaign, 'Canonical executable and passive paths are bound to actual campaign bytes');
  const ancestryIdentity = fileIdentity(path.join(owner.directory, 'process-ancestry.json'));
  assert.deepEqual(load(ancestryIdentity.path, owner.directory), segment.ancestry);
  const launch = load(path.join(owner.directory, 'launch.json'), owner.directory);
  const ready = load(path.join(directory, 'ready.json'), directory), result = load(path.join(directory, 'result.json'), directory);
  assert.deepEqual(ready.editorIdentity, editorIdentity, 'Ready proof cannot choose a foreign executable with the same basename');
  readPinnedFile(editorIdentity); inputs.push(editorIdentity);
  for (const [field, name] of [['observerSource', 'observe-pb02-task-due-date-timed-native-processes.py'], ['watcherSource', 'pb02-kqueue-watch.py']]) {
    const expectedPath = path.join(__dirname, name), expected = one(manifest.harnessDependencyIdentities.filter(row => row.path === expectedPath), 'One prelaunch passive implementation pin');
    assert.deepEqual(ready[field], expected); readPinnedFile(expected); inputs.push(expected);
  }
  const discovery = load(path.join(directory, 'discovery.jsonl'), directory, false);
  const lines = discovery.bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert(discovery.bytes.length > 0 && discovery.bytes.at(-1) === 10, 'Complete passive discovery records');
  const receiptBytes = Object.fromEntries([...owner.receiptPaths, ...owner.auxiliaryReceiptPaths].map(file => {
    const value = load(file, owner.directory, false); return [file, value.bytes];
  }));
  return { manifestIdentity, ancestryIdentity, discoveryIdentity: discovery.identity, launch, ready, result,
    joins: lines.filter(row => row.event === 'owned-ancestry-join'), receiptBytes, editorIdentity,
    uid: process.getuid(), inputs };
}
function reviewSegment(segment) {
  const proof = loadProof(segment), review = verifyRootIdentity(segment, proof);
  return { ...review, evidenceInputs: proof.inputs,
    passiveCollection: { status: proof.result.status, observedKernelExits: proof.result.observedKernelExits,
      kernelUnknownEvents: proof.result.kernelUnknownEvents, discoveryGaps: proof.result.discoveryGaps },
    basis: 'Prelaunch-bound canonical executable, prepared manifest and prospective passive witnesses; no basename-only normalization.' };
}

function selectRoot(segment, proof) { return verifyRootIdentity(segment, proof).root; }
module.exports = { hash, readPinnedFile, secondsAtAmman, verifyRootIdentity, selectRoot, validateBindings, loadProof, reviewSegment };
