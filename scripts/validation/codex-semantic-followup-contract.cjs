/* Exact immutable owned copy for a two-reply semantic correction. No launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { exactCommand } = require('./codex-stage-oracle.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const originalDirectory = path.join(root, 'resume-20261010/native-acceptance-verified');
const BASE_SOURCE_SHA = 'c469e1ad064b9ac2e4f19e496bcc4363a8e6c1c9590ecb87687ae65c24f17987';
const BASE_TESTS_SHA = '8c29579e5b289e1e459702e09ebb1f46122c01fee4ec44a42bf266bab48b1765';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function treeIdentities(directory) {
  assert.equal(fs.realpathSync(directory), directory); assert(!fs.lstatSync(directory).isSymbolicLink());
  const result = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); assert(!entry.isSymbolicLink(), 'No symlink in preserved tree');
      if (entry.isDirectory()) visit(file);
      else { assert(entry.isFile()); result.push({ path: file, sha256: hash(file) }); }
    }
  };
  visit(directory); return result.sort((a, b) => a.path.localeCompare(b.path));
}
const relativeTree = directory => treeIdentities(directory).map(value => ({ relativePath: path.relative(directory, value.path), sha256: value.sha256 }));
function git(directory, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.autoRefreshIndex=false', ...args], { cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
}
function verifyPreservedBase(fixture) {
  const base = fixture.base, manifest = read(path.join(originalDirectory, 'prepared.json'));
  assert.equal(base.originalDirectory, originalDirectory);
  assert.equal(base.originalWorkspace, path.join(originalDirectory, 'window-A/workspace'));
  assert.equal(base.sourceSha256, BASE_SOURCE_SHA); assert.equal(base.testsSha256, BASE_TESTS_SHA);
  assert.deepEqual(treeIdentities(originalDirectory), base.identities, 'Original native acceptance evidence remains unchanged');
  for (const key of ['profile', 'sharedDataDir']) {
    const snapshot = base.storageSnapshots[key]; assert.equal(snapshot.root, fs.realpathSync(manifest.windows.A[key]));
    assert.deepEqual(treeIdentities(snapshot.root), snapshot.identities, 'Original editor storage remains unchanged');
  }
}
function verifyCopiedFixture(fixture, panelId) {
  const workspace = fixture.workspace; assert.equal(fs.realpathSync(workspace), workspace); assert.deepEqual(fixture.editableFiles, []);
  const identities = treeIdentities(workspace).filter(value => !value.path.startsWith(path.join(workspace, '.git') + path.sep));
  const hashes = Object.fromEntries(identities.map(value => [path.relative(workspace, value.path), value.sha256]));
  for (const [relative, expected] of Object.entries(fixture.files)) assert.equal(hashes[relative], expected.sha256, `Copied file remains unchanged: ${relative}`);
  const extras = Object.keys(hashes).filter(relative => !fixture.files[relative]);
  const history = panelId ? `.mysti/compaction/${panelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}/history.jsonl` : null;
  assert(extras.every(relative => panelId && (relative === '.mysti/compaction/.gitignore' || relative === history)), 'Only current panel history additions allowed');
  assert.deepEqual(relativeTree(path.join(workspace, '.git')), fixture.base.gitIdentities, 'Copied Git bytes and index remain unchanged');
  assert.equal(git(workspace, ['ls-files', '--stage']), fixture.originalIndex);
  // Copied inodes differ from the index stat cache. A refreshing diff would
  // write that cache; all worktree and Git bytes are checked directly above.
  return { hashes, productArtifacts: extras.map(relative => ({ relative, sha256: hashes[relative] })), indexUnchanged: true,
    canaryUnchanged: true, preservedNotes: true };
}
function copyPreservedFixture(destination) {
  assert(path.isAbsolute(destination) && destination.startsWith(root + path.sep)); assert(!fs.existsSync(destination));
  assert.equal(fs.realpathSync(path.dirname(destination)), path.dirname(destination));
  assert(!destination.startsWith(originalDirectory + path.sep));
  const manifest = read(path.join(originalDirectory, 'prepared.json')), original = manifest.windows.A.workspace;
  assert.equal(manifest.stage, 'FULL_25_ACCEPTANCE'); assert.equal(manifest.model, 'gpt-5.6-sol');
  assert.equal(original, path.join(originalDirectory, 'window-A/workspace')); assert.equal(fs.realpathSync(original), original);
  assert.equal(read(path.join(originalDirectory, 'native-result.json')).status, 'PASS');
  assert.equal(read(path.join(originalDirectory, 'independent-audit.json')).status, 'PASS_FULL_25_BOUNDED');
  assert.equal(hash(path.join(original, 'src/retry.cjs')), BASE_SOURCE_SHA); assert.equal(hash(path.join(original, 'test/retry.test.cjs')), BASE_TESTS_SHA);
  const identities = treeIdentities(originalDirectory);
  const base = { originalDirectory, originalWorkspace: original, sourceSha256: BASE_SOURCE_SHA, testsSha256: BASE_TESTS_SHA,
    authorModel: manifest.model, identities, storageSnapshots: Object.fromEntries(['profile', 'sharedDataDir'].map(key => {
      const directory = fs.realpathSync(manifest.windows.A[key]); return [key, { root: directory, identities: treeIdentities(directory) }];
    })), gitIdentities: relativeTree(path.join(original, '.git')),
    initialUnstagedPaths: git(original, ['diff', '--name-only', '-z']).split('\0').filter(Boolean).sort() };
  fs.cpSync(original, destination, { recursive: true, force: false, errorOnExist: true });
  const files = {};
  for (const value of treeIdentities(original)) {
    const relative = path.relative(original, value.path); if (relative.startsWith('.git' + path.sep)) continue;
    const bytes = fs.readFileSync(value.path), known = manifest.fixture.files[relative];
    files[relative] = { sha256: value.sha256, bytes: bytes.length, ...(known && !relative.endsWith('.png') ? { text: bytes.toString('utf8') } : {}) };
  }
  const fixture = { ...manifest.fixture, workspace: destination, files, originalIndex: git(original, ['ls-files', '--stage']),
    originalStatus: git(original, ['status', '--short']), editableFiles: [], base,
    fixtureScope: 'Exact final workspace and Git bytes copied, including existing product history. No file is editable. Copied Read Only probe is unchanged and is never authorized to run.' };
  verifyPreservedBase(fixture); verifyCopiedFixture(fixture); return fixture;
}
module.exports = { BASE_SOURCE_SHA, BASE_TESTS_SHA, originalDirectory, exactCommand, treeIdentities, copyPreservedFixture, verifyPreservedBase, verifyCopiedFixture };
