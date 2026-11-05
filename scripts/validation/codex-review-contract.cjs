/* Narrow PB-02 peer-repair fixture/approval contract. No provider calls. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { exactCommand } = require('./codex-stage-oracle.cjs');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PB-02');
const originalDirectory = path.join(root, 'native-full');
const BASE_SOURCE_SHA = '34243ec7120dc873978369f8bac03670182bb29cdc0b2337ef4d78a4ca2fd6e7';
const digest = value => createHash('sha256').update(value).digest('hex');
const fileSha = file => digest(fs.readFileSync(file));
const oldLine = '    const timestamp = Date.parse(trimmed);';
// Accept the minimal conditional GMT normalization as concatenation or exact `${trimmed} GMT`.
// Template interpolation is the literal identifier only; no calls, expressions or escapes are accepted.
// A different valid implementation requires a separately reviewed scope, never an automatic retry.
const replacement = /^\s*const timestamp = Date\.parse\(\s*i\s*===\s*2\s*\?\s*(?:trimmed\s*\+\s*(['"]) GMT\1|`\$\{trimmed\} GMT`)\s*:\s*trimmed\s*\);\s*$/;
const expected = ['PEER_REVIEW', 'PEER_REPAIR', 'PEER_TESTS'];
const scopes = {
  PEER_REVIEW: { commands: ['cat README.md src/retry.cjs test/retry.test.cjs'], required: 'commandExecution' },
  PEER_REPAIR: { commands: ['cat src/retry.cjs'], patch: 'repair', required: 'fileChange' },
  PEER_TESTS: { commands: ['node --test test/retry.test.cjs'], required: 'commandExecution' },
};
function contained(parent, file) {
  const relative = path.relative(parent, file);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Owned descendant required');
}
function patchScope(changes, workspace, purpose) {
  if (purpose !== 'repair' || !Array.isArray(changes) || changes.length !== 1) return false;
  const change = changes[0];
  if (typeof change.path !== 'string' || path.resolve(workspace, change.path) !== path.join(workspace, 'src/retry.cjs')
    || change.kind?.type !== 'update' || change.kind.move_path || change.kind.movePath || typeof change.diff !== 'string' || change.diff.length > 4000) return false;
  const removed = change.diff.split('\n').filter(line => line.startsWith('-')).map(line => line.slice(1));
  const added = change.diff.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1));
  return removed.length === 1 && removed[0] === oldLine && added.length === 1 && replacement.test(added[0]);
}
function assertSourceRepair(original, actual) {
  assert.equal(digest(original), BASE_SOURCE_SHA);
  const before = original.toString('utf8'), after = actual.toString('utf8');
  assert.equal(before.split(oldLine).length, 2);
  const lines = after.split('\n').filter(line => replacement.test(line));
  assert.equal(lines.length, 1, 'Exactly one GMT-normalized timestamp initializer');
  assert.equal(after, before.replace(oldLine, lines[0]), 'Only the approved timestamp line may change');
}
function treeIdentities(directory) {
  const result = [];
  function visit(current) {
    assert(!fs.lstatSync(current).isSymbolicLink(), 'No symlinks in preserved fixture');
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) visit(file);
      else { assert(entry.isFile()); result.push({ path: fs.realpathSync(file), sha256: fileSha(file) }); }
    }
  }
  visit(directory); return result.sort((a, b) => a.path.localeCompare(b.path));
}
function verifyPreservedBase(fixture) {
  assert.equal(fixture.base.originalDirectory, originalDirectory);
  assert.equal(fixture.base.sourceSha256, BASE_SOURCE_SHA);
  const current = treeIdentities(originalDirectory);
  assert.deepEqual(current, fixture.base.identities, 'Every original native-full artifact and exact path list must remain unchanged');
  for (const pin of fixture.base.identities) {
    contained(originalDirectory, pin.path);
    assert.equal(fs.realpathSync(pin.path), pin.path);
    assert.equal(fileSha(pin.path), pin.sha256, 'Preserved native evidence changed');
  }
  const originalManifest = JSON.parse(fs.readFileSync(path.join(originalDirectory, 'prepared.json')));
  for (const key of ['profile', 'sharedDataDir']) {
    const snapshot = fixture.base.storageSnapshots[key];
    assert.equal(snapshot.root, fs.realpathSync(originalManifest.windows.A[key]));
    assert.deepEqual(treeIdentities(snapshot.root), snapshot.identities, 'Original editor storage must remain unchanged');
  }
}
function copyPreservedFixture(destination) {
  assert(path.isAbsolute(destination)); contained(root, destination);
  assert(destination !== originalDirectory && !destination.startsWith(originalDirectory + path.sep), 'Never write inside preserved evidence');
  assert(!fs.existsSync(destination), 'Copy must have a fresh destination');
  const manifestFile = path.join(originalDirectory, 'prepared.json');
  const originalManifest = JSON.parse(fs.readFileSync(manifestFile));
  assert.equal(originalManifest.case, 'PB-02'); assert.equal(originalManifest.stage, 'FULL_25');
  assert.equal(originalManifest.model, 'gpt-6.1-sol');
  const original = fs.realpathSync(originalManifest.windows.A.workspace);
  assert.equal(original, path.join(originalDirectory, 'window-A/workspace'));
  const sourceFile = path.join(original, 'src/retry.cjs'); assert.equal(fileSha(sourceFile), BASE_SOURCE_SHA);
  const identities = treeIdentities(originalDirectory);
  fs.mkdirSync(destination, { recursive: false });
  assert(fs.realpathSync(destination).startsWith(fs.realpathSync(root) + path.sep));
  const files = {};
  for (const relative of Object.keys(originalManifest.fixture.files)) {
    const file = path.join(original, relative), target = path.join(destination, relative);
    contained(original, file); contained(destination, target);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
    const bytes = fs.readFileSync(file);
    files[relative] = { ...originalManifest.fixture.files[relative], sha256: digest(bytes), bytes: bytes.length, ...(relative.endsWith('.png') ? {} : { text: bytes.toString('utf8') }) };
    assert.equal(fileSha(target), digest(bytes));
  }
  fs.cpSync(path.join(original, '.git'), path.join(destination, '.git'), { recursive: true, force: false, errorOnExist: true });
  const originalIndex = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--stage'], {
    cwd: destination, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.equal(originalIndex, originalManifest.fixture.originalIndex);
  const fixture = { ...originalManifest.fixture, workspace: fs.realpathSync(destination), files, originalIndex,
    editableFiles: ['src/retry.cjs'], base: { originalDirectory, originalWorkspace: original, sourceSha256: BASE_SOURCE_SHA,
      authorModel: originalManifest.model, identities, copiedFiles: Object.keys(files),
      storageSnapshots: Object.fromEntries(['profile', 'sharedDataDir'].map(key => {
        const directory = fs.realpathSync(originalManifest.windows.A[key]);
        return [key, { root: directory, identities: treeIdentities(directory) }];
      })),
      copyScope: 'Exact seven developer fixture files and Git metadata; original Mysti runtime history is preserved in place, not imported into the fresh peer chat.' } };
  verifyPreservedBase(fixture); return fixture;
}
module.exports = { BASE_SOURCE_SHA, expected, scopes, exactCommand, patchScope, assertSourceRepair, copyPreservedFixture, verifyPreservedBase };
