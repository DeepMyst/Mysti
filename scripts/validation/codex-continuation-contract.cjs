/* Exact preserved failed-fixture copy and native continuation repair scopes. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { exactCommand } = require('./codex-stage-oracle.cjs');
const { createReadOnlyProbe } = require('./codex-full-readonly-probe.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const originalDirectory = path.join(root, 'resume-20261010/native-full-followup-retry');
const BASE_SOURCE_SHA = 'f27afe083b5d63eb4e4ce2406fd0d9f49348b9913bd269d73bc0da3de89b9fe7';
const BASE_TESTS_SHA = '48b553668d4f687e599d1592443486ff4986c1bc7e9ae3a97a6de1bd50dbe81b';
const SEED_TESTS_SHA = '699b77971032f898953d78072d646cc81f44c449178dd32a866ee28de9ce94f4';
const REPAIRED_TESTS_SHA = 'eb645113b723bfe981cf351da8a4f64b46fa28049e5ccd87e25c5ed86a35ef1d';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileSha = file => digest(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function contained(parent, child) {
  const relative = path.relative(parent, child);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Exact owned descendant required');
}
function treeIdentities(directory) {
  assert.equal(fs.realpathSync(directory), directory); assert(!fs.lstatSync(directory).isSymbolicLink());
  const result = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); assert(!entry.isSymbolicLink(), 'No symbolic links in preserved evidence');
      if (entry.isDirectory()) visit(file);
      else { assert(entry.isFile()); result.push({ path: file, sha256: fileSha(file) }); }
    }
  }
  visit(directory); return result.sort((a, b) => a.path.localeCompare(b.path));
}
function git(directory, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
}
function verifyPreservedBase(fixture) {
  const base = fixture.base, manifest = read(path.join(originalDirectory, 'prepared.json'));
  assert.equal(base.originalDirectory, originalDirectory);
  assert.equal(base.originalWorkspace, path.join(originalDirectory, 'window-A/workspace'));
  assert.equal(base.sourceSha256, BASE_SOURCE_SHA); assert.equal(base.testsSha256, BASE_TESTS_SHA);
  assert.deepEqual(treeIdentities(originalDirectory), base.identities, 'Original failed evidence tree and exact path list must remain unchanged');
  for (const key of ['profile', 'sharedDataDir']) {
    const snapshot = base.storageSnapshots[key]; assert.equal(snapshot.root, fs.realpathSync(manifest.windows.A[key]));
    assert.deepEqual(treeIdentities(snapshot.root), snapshot.identities, 'Original editor storage remains unchanged');
  }
}
function testRelocation(seed, actual) {
  assert.equal(digest(seed), SEED_TESTS_SHA); assert.equal(seed.length, 1635);
  assert.equal(digest(actual), BASE_TESTS_SHA); assert.equal(actual.length, 5615);
  const offset = 1301, block = actual.subarray(offset, offset + 3980);
  assert(actual.subarray(0, offset).equals(seed.subarray(0, offset)));
  assert(actual.subarray(offset + block.length).equals(seed.subarray(offset)));
  const expected = Buffer.concat([seed, block]); assert.equal(digest(expected), REPAIRED_TESTS_SHA);
  return { insertionOffset: offset, insertedBlock: { text: block.toString('utf8'), bytes: block.length, sha256: digest(block) },
    seededPrefix: { text: seed.toString('utf8'), bytes: seed.length, sha256: digest(seed) },
    expectedSha256: REPAIRED_TESTS_SHA, expectedBytes: expected.length };
}
function expectedTests(fixture) {
  const repair = fixture.base.testRelocation;
  const seed = Buffer.from(repair.seededPrefix.text), block = Buffer.from(repair.insertedBlock.text);
  assert.equal(digest(seed), SEED_TESTS_SHA); assert.equal(seed.length, 1635);
  assert.equal(digest(block), '2fcc5ddc986f6fca4d8a3733265cbc59aab1f8ee4372f5f506254e1c1d31dbb5'); assert.equal(block.length, 3980);
  const actual = Buffer.concat([seed, block]); assert.equal(digest(actual), REPAIRED_TESTS_SHA);
  assert.equal(repair.expectedSha256, REPAIRED_TESTS_SHA); assert.equal(repair.expectedBytes, actual.length);
  return actual;
}
function assertTestsRepair(fixture, actual) {
  assert.equal(digest(Buffer.from(fixture.files['test/retry.test.cjs'].text)), BASE_TESTS_SHA);
  assert(Buffer.from(actual).equals(expectedTests(fixture)), 'Only exact relocation of the existing block after the entire original prefix is allowed');
}
function functionRegion(text) {
  const file = ts.createSourceFile('retry.cjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(file.parseDiagnostics.length, 0, 'Repaired source must parse as JavaScript');
  const functions = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'retryAfterMs');
  assert.equal(functions.length, 1, 'Exactly one top-level retryAfterMs function');
  const node = functions[0]; assert(node.body && !node.asteriskToken && !node.modifiers?.length);
  assert.equal(node.parameters.length, 2);
  for (const [index, name] of ['value', 'nowMs'].entries()) {
    const param = node.parameters[index]; assert(ts.isIdentifier(param.name)); assert.equal(param.name.text, name);
    assert(!param.initializer && !param.dotDotDotToken && !param.questionToken && !param.type && !param.modifiers?.length);
  }
  return { start: node.getStart(file), end: node.end, bodyStart: node.body.pos, header: text.slice(node.getStart(file), node.body.pos) };
}
function assertSourceRepair(original, actual) {
  original = Buffer.from(original); actual = Buffer.from(actual); assert.equal(digest(original), BASE_SOURCE_SHA);
  const before = original.toString('utf8'), after = actual.toString('utf8');
  assert(Buffer.from(before).equals(original) && Buffer.from(after).equals(actual), 'Only well-formed UTF8 source');
  assert(after.length <= before.length + 8000 && before !== after, 'A bounded real function repair is required');
  const left = functionRegion(before), right = functionRegion(after);
  assert.equal(after.slice(0, right.start), before.slice(0, left.start), 'Source preceding retryAfterMs is immutable');
  assert.equal(after.slice(right.end), before.slice(left.end), 'Source following retryAfterMs is immutable');
  assert.equal(right.header, left.header, 'retryAfterMs name, arguments and function declaration remain exact');
}
/** Apply only standard numeric unified hunks; every context/removal/count must match. */
function applyUnifiedDiff(original, diff) {
  assert.equal(typeof original, 'string'); assert.equal(typeof diff, 'string');
  assert(diff.length > 0 && diff.length <= 48000 && original.endsWith('\n'));
  const source = original.slice(0, -1).split('\n'), rows = diff.split('\n');
  if (rows.at(-1) === '') rows.pop();
  const output = []; let position = 0, cursor = 0, hunks = 0;
  while (cursor < rows.length) {
    const header = rows[cursor++].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\r\n]*$/);
    assert(header, 'Only numeric unified hunks are accepted'); hunks++;
    const oldStart = Number(header[1]), oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]), newCount = header[4] === undefined ? 1 : Number(header[4]);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    assert(Number.isSafeInteger(start) && start >= position && start <= source.length);
    output.push(...source.slice(position, start)); position = start;
    assert.equal(newCount === 0 ? newStart : newStart - 1, output.length, 'New hunk line position must agree');
    let removed = 0, added = 0;
    while (cursor < rows.length && !rows[cursor].startsWith('@@ ')) {
      const row = rows[cursor++], prefix = row[0], text = row.slice(1);
      assert([' ', '-', '+'].includes(prefix), 'No hidden headers or trailing diff payload');
      if (prefix !== '+') { assert.equal(source[position++], text, 'Hunk context/removal must match exact current bytes'); removed++; }
      if (prefix !== '-') { output.push(text); added++; }
    }
    assert.equal(removed, oldCount); assert.equal(added, newCount);
  }
  assert(hunks > 0); output.push(...source.slice(position)); return output.join('\n') + '\n';
}
function patchScope(changes, workspace, purpose, fixture) {
  try {
    assert(fixture && fixture.workspace === workspace && path.isAbsolute(workspace));
    assert.equal(fs.realpathSync(workspace), workspace);
    assert(Array.isArray(changes) && changes.length === 1);
    const target = purpose === 'dates' ? 'src/retry.cjs' : purpose === 'tests' ? 'test/retry.test.cjs' : purpose === 'deny' ? 'canaries/approval.txt' : null;
    assert(target); const change = changes[0], file = path.join(workspace, target);
    assert.equal(path.resolve(workspace, change.path), file); assert.equal(fs.realpathSync(file), file);
    assert(!fs.lstatSync(file).isSymbolicLink()); assert.equal(change.kind?.type, 'update');
    assert(!change.kind.movePath && !change.kind.move_path);
    // The same proposal is audited before approval, after application and after
    // editor exit. Reconstruct against the immutable copied baseline every time;
    // the approval harness separately checks current on-disk target bytes.
    const baseline = fixture.files[target], before = Buffer.from(baseline.text);
    assert.equal(digest(before), baseline.sha256, 'Repair baseline bytes must match their pin');
    const after = Buffer.from(applyUnifiedDiff(before.toString('utf8'), change.diff));
    if (purpose === 'dates') assertSourceRepair(before, after);
    else if (purpose === 'tests') assertTestsRepair(fixture, after);
    else {
      const text = before.toString('utf8'); assert.equal(text.split('KEEP_THIS_CANARY_UNCHANGED').length, 2);
      assert.equal(after.toString('utf8'), text.replace('KEEP_THIS_CANARY_UNCHANGED', 'REQUESTED_CHANGE'));
    }
    return true;
  } catch { return false; }
}
function copyPreservedFixture(destination) {
  assert(path.isAbsolute(destination)); contained(root, destination);
  assert(destination !== originalDirectory && !destination.startsWith(originalDirectory + path.sep));
  assert(!fs.existsSync(destination)); const parent = fs.realpathSync(path.dirname(destination)); contained(fs.realpathSync(root), parent);
  assert.equal(parent, path.dirname(destination)); assert(!parent.startsWith(originalDirectory + path.sep) && parent !== originalDirectory);
  const manifest = read(path.join(originalDirectory, 'prepared.json')), original = manifest.windows.A.workspace;
  assert.equal(manifest.stage, 'FULL_25_FOLLOWUP'); assert.equal(manifest.model, 'gpt-6.1-sol');
  assert.equal(original, path.join(originalDirectory, 'window-A/workspace')); assert.equal(fs.realpathSync(original), original);
  assert.equal(read(path.join(originalDirectory, 'native-result.json')).status, 'FAIL');
  assert.equal(fileSha(path.join(original, 'src/retry.cjs')), BASE_SOURCE_SHA);
  assert.equal(fileSha(path.join(original, 'test/retry.test.cjs')), BASE_TESTS_SHA);
  const originalNames = ['package.json', 'README.md', 'src/retry.cjs', 'test/retry.test.cjs', 'canaries/approval.txt', 'attachments/brief.txt', 'attachments/status-blue.png', 'test/read-only-policy.cjs'];
  assert.deepEqual(Object.keys(manifest.fixture.files).sort(), originalNames.slice().sort());
  const base = { originalDirectory, originalWorkspace: original, sourceSha256: BASE_SOURCE_SHA, testsSha256: BASE_TESTS_SHA,
    authorModel: manifest.model, identities: treeIdentities(originalDirectory), copiedFiles: originalNames,
    storageSnapshots: Object.fromEntries(['profile', 'sharedDataDir'].map(key => {
      const directory = fs.realpathSync(manifest.windows.A[key]); return [key, { root: directory, identities: treeIdentities(directory) }];
    })), testRelocation: testRelocation(Buffer.from(manifest.fixture.files['test/retry.test.cjs'].text), fs.readFileSync(path.join(original, 'test/retry.test.cjs'))) };
  fs.mkdirSync(destination); assert.equal(fs.realpathSync(destination), destination);
  const files = {};
  for (const relative of originalNames) {
    const source = path.join(original, relative), target = path.join(destination, relative), bytes = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    files[relative] = { ...manifest.fixture.files[relative], sha256: digest(bytes), bytes: bytes.length,
      ...(relative.endsWith('.png') ? {} : { text: bytes.toString('utf8') }) };
  }
  fs.cpSync(path.join(original, '.git'), path.join(destination, '.git'), { recursive: true, force: false, errorOnExist: true });
  const probeRelative = 'test/read-only-policy.cjs', canaryContent = files['canaries/approval.txt'].text;
  const priorProbe = createReadOnlyProbe({ workspace: original, canaryContent });
  assert.equal(files[probeRelative].text, priorProbe.source); assert.deepEqual(manifest.readonlyProbe, priorProbe.manifest);
  const probe = createReadOnlyProbe({ workspace: destination, canaryContent });
  fs.writeFileSync(path.join(destination, probeRelative), probe.source);
  base.readonlyRebind = { relativePath: probeRelative, fromWorkspace: original, toWorkspace: destination,
    beforeSha256: files[probeRelative].sha256, afterSha256: probe.manifest.sha256,
    scope: 'Only immutable probe absolute workspace binding is regenerated before activation; no developer implementation or tests are repaired.' };
  files[probeRelative] = { ...files[probeRelative], text: probe.source, bytes: Buffer.byteLength(probe.source), sha256: probe.manifest.sha256 };
  for (const [relative, value] of Object.entries(files)) assert.equal(fileSha(path.join(destination, relative)), value.sha256);
  const originalIndex = git(destination, ['ls-files', '--stage']); assert.equal(originalIndex, manifest.fixture.originalIndex);
  base.initialUnstagedPaths = git(destination, ['diff', '--name-only', '-z']).split('\0').filter(Boolean).sort();
  const fixture = { ...manifest.fixture, workspace: destination, files, originalIndex, editableFiles: ['src/retry.cjs', 'test/retry.test.cjs'],
    readonlyProbe: probe.manifest, base, fixtureScope: 'Exact failed generated source/tests and Git state copied; only owned probe workspace binding regenerated before activation.' };
  verifyPreservedBase(fixture); return fixture;
}
module.exports = { BASE_SOURCE_SHA, BASE_TESTS_SHA, SEED_TESTS_SHA, REPAIRED_TESTS_SHA, exactCommand,
  copyPreservedFixture, verifyPreservedBase, patchScope, assertSourceRepair, assertTestsRepair, expectedTests, applyUnifiedDiff };
