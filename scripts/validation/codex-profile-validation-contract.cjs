/* Owned profile files and immutable fixture contract. No editor/inference. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const fixture = require('./codex-semantic-followup-contract.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function profileSource(contextWindow) {
  assert([262144, 262145].includes(contextWindow));
  return `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\nmodel_context_window = ${contextWindow}\n`;
}
function resolveCodeHome() {
  return fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
function createOwnedProfiles({ artifactDir, controlHome }) {
  assert(path.isAbsolute(artifactDir) && artifactDir.startsWith(root + path.sep));
  assert.equal(fs.realpathSync(artifactDir), artifactDir);
  const codeHome = controlHome ? fs.realpathSync(controlHome) : resolveCodeHome();
  if (controlHome) assert(codeHome.startsWith(fs.realpathSync(root) + path.sep), 'Synthetic profile home is owned test data');
  const nonce = randomBytes(12).toString('hex'), profiles = {};
  for (const [label, contextWindow] of [['A', 262144], ['B', 262145]]) {
    const name = `pb02_d10_${label.toLowerCase()}_${nonce}`, file = path.join(codeHome, `${name}.config.toml`), source = profileSource(contextWindow);
    const fd = fs.openSync(file, 'wx', 0o600);
    let stat;
    try { fs.writeFileSync(fd, source); stat = fs.fstatSync(fd); }
    finally { fs.closeSync(fd); }
    profiles[label] = { name, path: file, sha256: sha(source), bytes: Buffer.byteLength(source), dev: stat.dev, ino: stat.ino,
      mode: stat.mode & 0o777, contextWindow };
    fs.writeFileSync(path.join(artifactDir, `owned-profile-${label}.config.toml`), source, { flag: 'wx', mode: 0o600 });
  }
  const missing = { name: `pb02_d10_missing_${nonce}`, path: path.join(codeHome, `pb02_d10_missing_${nonce}.config.toml`) };
  assert(!fs.existsSync(missing.path), 'The missing profile must actually be absent');
  const result = { codeHome, controlOnly: !!controlHome, profiles, invalidValue: '../pb02-invalid', missing };
  verifyOwnedProfiles(result);
  fs.writeFileSync(path.join(artifactDir, 'profile-files.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
}
function verifyOwnedProfiles(value) {
  assert.equal(fs.realpathSync(value.codeHome), value.codeHome);
  assert.deepEqual(Object.keys(value.profiles), ['A', 'B']);
  const names = [];
  for (const [label, profile] of Object.entries(value.profiles)) {
    assert.match(profile.name, new RegExp(`^pb02_d10_${label.toLowerCase()}_[a-f0-9]{24}$`));
    assert.equal(profile.path, path.join(value.codeHome, `${profile.name}.config.toml`));
    const stat = fs.lstatSync(profile.path); assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(fs.realpathSync(profile.path), profile.path); assert.equal(stat.dev, profile.dev); assert.equal(stat.ino, profile.ino);
    assert.equal(stat.mode & 0o777, 0o600); assert.equal(profile.mode, 0o600);
    const expected = profileSource(label === 'A' ? 262144 : 262145), actual = fs.readFileSync(profile.path);
    assert.equal(profile.contextWindow, label === 'A' ? 262144 : 262145); assert.equal(profile.bytes, actual.length);
    assert.equal(profile.sha256, sha(actual)); assert.equal(actual.toString('utf8'), expected); names.push(profile.name);
  }
  assert.notEqual(names[0], names[1]); assert.equal(value.invalidValue, '../pb02-invalid');
  assert.match(value.missing.name, /^pb02_d10_missing_[a-f0-9]{24}$/);
  assert.equal(value.missing.path, path.join(value.codeHome, `${value.missing.name}.config.toml`));
  assert(!fs.existsSync(value.missing.path));
  return { status: 'PASS_OWNED_PROFILE_IDENTITIES', names, contextWindows: [262144, 262145] };
}
function cleanupOwnedProfiles(value) {
  verifyOwnedProfiles(value); // Check both completely before removing either.
  const removed = [];
  for (const profile of Object.values(value.profiles)) {
    // Repeat the identity check immediately before the exact unlink.
    const stat = fs.lstatSync(profile.path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.dev === profile.dev && stat.ino === profile.ino);
    assert.equal(sha(fs.readFileSync(profile.path)), profile.sha256);
    fs.unlinkSync(profile.path); removed.push({ path: profile.path, sha256: profile.sha256, dev: profile.dev, ino: profile.ino, absent: !fs.existsSync(profile.path) });
  }
  return { status: 'PASS_OWNED_PROFILES_REMOVED', removed, scope: 'Only the two exclusively created files with matching exact path, inode, mode, bytes and hash were removed. No base config/auth access.' };
}
module.exports = { ...fixture, profileSource, resolveCodeHome, createOwnedProfiles, verifyOwnedProfiles, cleanupOwnedProfiles };
