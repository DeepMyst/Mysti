/* Lossless boundary storage controls. No editor/application/provider launches. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const s = require('./codex-f2-compact-store.cjs'), c = require('./codex-f2-scoped-campaign.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'f2-compact-storage-controls-')), checks = [];
const check = (name, fn) => { fn(); checks.push({ name, status: 'PASS' }); };
const clone = value => JSON.parse(JSON.stringify(value));
check('readiness directly in the owned artifact root is readable without mutation', () => {
  const file = path.join(root, 'readiness.json'), before = fs.readFileSync(file);
  assert.deepEqual(s.readJson(file), JSON.parse(before)); assert.deepEqual(fs.readFileSync(file), before);
});
check('a sibling of the owned artifact root remains forbidden', () => {
  assert.throws(() => s.hydrate({}, path.dirname(root)));
});
const snapshot = { files: { original: 'exact-unchanged' }, dependencySnapshots: [{ target: '/owned', files: 2, treeSha256: 'a'.repeat(64) }],
  cacheSnapshot: { root: '/owned/cache', files: [{ relative: 'nested/cache', path: '/owned/cache/nested/cache', sha256: 'b'.repeat(64), bytes: 19 }], fileCount: 1, bytes: 19, httpActivity: [] },
  buildSnapshot: null, applicationTemporarySnapshot: null };
const file = path.join(directory, 'document.json'); let ref;
check('whole boundary roundtrip preserves every exact field and value', () => {
  s.writeJson(file, { snapshots: [snapshot, snapshot], rawNativeOutput: 'مرحبا\n tool text ${unchanged}' });
  const encoded = JSON.parse(fs.readFileSync(file, 'utf8')); ref = encoded.snapshots[0];
  assert.deepEqual(encoded.snapshots[0], encoded.snapshots[1]); assert.equal(encoded.rawNativeOutput, 'مرحبا\n tool text ${unchanged}');
  assert.deepEqual(s.readJson(file), { snapshots: [snapshot, snapshot], rawNativeOutput: 'مرحبا\n tool text ${unchanged}' });
  assert.equal(fs.readdirSync(path.join(directory, s.STORE)).length, 1);
});
check('repeated same snapshot in separate documents deduplicates per directory', () => {
  s.writeJson(path.join(directory, 'second.json'), { finalBoundary: clone(snapshot) });
  assert.equal(fs.readdirSync(path.join(directory, s.STORE)).length, 1);
});
check('encoded snapshot is immutable so cached references cannot become stale', () => {
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.cacheSnapshot.files[0])); assert.throws(() => { snapshot.cacheSnapshot.files[0].bytes = 99; });
});
check('same values in another directory use its own exact object root', () => {
  const other = path.join(directory, 'other'); fs.mkdirSync(other); s.writeJson(path.join(other, 'same.json'), snapshot);
  assert.deepEqual(s.readJson(path.join(other, 'same.json')), snapshot); assert(fs.existsSync(path.join(other, ref.relative)));
});
check('console serialization contains only references and untouched non-boundary text', () => {
  const text = s.stringify(file, { event: 'boundary', snapshot, content: 'same response' }, 0);
  assert(text.length < 800); assert.equal(JSON.parse(text).content, 'same response'); assert(!text.includes('treeSha256'));
});
for (const key of ['compressedSha256', 'uncompressedSha256']) check(`wrong ${key} rejects`, () => assert.throws(() => s.hydrate({ ...ref, [key]: '0'.repeat(64) }, directory)));
for (const key of ['compressedBytes', 'uncompressedBytes']) check(`wrong ${key} rejects`, () => assert.throws(() => s.hydrate({ ...ref, [key]: ref[key] + 1 }, directory)));
for (const relative of ['../other.json.gz', '/tmp/foreign.gz', '.pb02-boundaries/../foreign.gz']) check(`noncanonical relative ${relative} rejects`, () => assert.throws(() => s.hydrate({ ...ref, relative }, directory)));
check('unsupported reference version rejects', () => assert.throws(() => s.hydrate({ ...ref, [s.TAG]: 2 }, directory)));
check('extra reference field rejects', () => assert.throws(() => s.hydrate({ ...ref, ignored: true }, directory)));
check('missing object rejects without fallback to current workspace', () => {
  const other = path.join(directory, 'empty'); fs.mkdirSync(other); fs.mkdirSync(path.join(other, s.STORE)); assert.throws(() => s.hydrate(ref, other));
});
check('symlink object rejects', () => {
  const other = path.join(directory, 'symlink'); fs.mkdirSync(other); fs.mkdirSync(path.join(other, s.STORE)); fs.symlinkSync(path.join(directory, ref.relative), path.join(other, ref.relative)); assert.throws(() => s.hydrate(ref, other));
});
check('symlink object root rejects', () => {
  const other = path.join(directory, 'symlink-root'); fs.mkdirSync(other); fs.symlinkSync(path.join(directory, s.STORE), path.join(other, s.STORE), 'dir'); assert.throws(() => s.hydrate(ref, other));
});
check('hardlinked object rejects', () => {
  const original = path.join(directory, ref.relative), linked = path.join(directory, 'hardlinked.gz'); fs.linkSync(original, linked);
  try { assert.throws(() => s.hydrate(ref, directory)); } finally { fs.unlinkSync(linked); }
});
check('corrupt gzip rejects even with updated compressed hash', () => {
  const other = path.join(directory, 'corrupt'); fs.mkdirSync(other); fs.mkdirSync(path.join(other, s.STORE)); const bytes = Buffer.from('not gzip'); fs.writeFileSync(path.join(other, ref.relative), bytes);
  assert.throws(() => s.hydrate({ ...ref, compressedBytes: bytes.length, compressedSha256: c.hash(bytes) }, other));
});
check('decompression cannot exceed declared raw length', () => {
  assert.throws(() => s.hydrate({ ...ref, uncompressedBytes: 10 }, directory));
});
check('oversized declared gzip/raw bounds reject before reading', () => {
  assert.throws(() => s.hydrate({ ...ref, compressedBytes: s.MAX_GZIP + 1 }, directory)); assert.throws(() => s.hydrate({ ...ref, uncompressedBytes: s.MAX_RAW + 1 }, directory));
});
check('ref cannot hide an incomplete boundary object', () => {
  const other = path.join(directory, 'wrong-shape'); fs.mkdirSync(other); fs.mkdirSync(path.join(other, s.STORE));
  const raw = Buffer.from(JSON.stringify({ files: {} })), zipped = zlib.gzipSync(raw), sha = c.hash(raw), wrong = { ...ref, relative: `${s.STORE}/${sha}.json.gz`, uncompressedSha256: sha, uncompressedBytes: raw.length, compressedSha256: c.hash(zipped), compressedBytes: zipped.length };
  fs.writeFileSync(path.join(other, wrong.relative), zipped); assert.throws(() => s.hydrate(wrong, other));
});
check('self-consistent wrong snapshot is rejected by unchanged boundary comparison', () => {
  const wrong = clone(snapshot); wrong.files.original = 'tampered'; const changed = s.encode(wrong, directory); assert.throws(() => assert.deepEqual(s.hydrate(changed, directory), snapshot));
});
check('pre-forged reference cannot enter a writer as normal input', () => assert.throws(() => s.writeJson(path.join(directory, 'forged.json'), ref)));
check('exclusive output never overwrites evidence', () => assert.throws(() => s.writeJson(file, snapshot)));
check('intentional live observation overwrite preserves exact values', () => {
  const p = path.join(directory, 'live.json'); s.writeJson(p, { count: 1, snapshot }); s.writeJson(p, { count: 2, snapshot }, { flag: 'w' }); assert.equal(s.readJson(p).count, 2);
});
check('disk-full partial write preserves the previous complete observation', () => {
  const p = path.join(directory, 'live.json'), before = fs.readFileSync(p), original = fs.writeFileSync;
  fs.writeFileSync = (fd, text, ...args) => {
    if (typeof fd !== 'number') return original(fd, text, ...args);
    original(fd, String(text).slice(0, 7)); throw Object.assign(new Error('injected bounded disk-full write'), { code: 'ENOSPC' });
  };
  try { assert.throws(() => s.writeJson(p, { count: 3, snapshot }, { flag: 'w' }), { code: 'ENOSPC' }); }
  finally { fs.writeFileSync = original; }
  assert.deepEqual(fs.readFileSync(p), before); assert.equal(s.readJson(p).count, 2);
});
check('disk-full fresh write never publishes a partial evidence document', () => {
  const p = path.join(directory, 'unpublished.json'), original = fs.writeFileSync;
  fs.writeFileSync = (fd, text, ...args) => {
    if (typeof fd !== 'number') return original(fd, text, ...args);
    original(fd, String(text).slice(0, 7)); throw Object.assign(new Error('injected bounded disk-full write'), { code: 'ENOSPC' });
  };
  try { assert.throws(() => s.writeJson(p, { snapshot }), { code: 'ENOSPC' }); }
  finally { fs.writeFileSync = original; }
  assert(!fs.existsSync(p));
});
check('foreign-owner file metadata is rejected without changing contents', () => {
  const before = fs.readFileSync(file), original = fs.fstatSync;
  fs.fstatSync = (...args) => { const stat = original(...args); stat.uid = process.getuid() + 1; return stat; };
  try { assert.throws(() => s.readJson(file)); } finally { fs.fstatSync = original; }
  assert.deepEqual(fs.readFileSync(file), before);
});
check('self-consistent compressed invalid UTF-8 cannot silently change snapshot bytes', () => {
  const other = path.join(directory, 'invalid-utf8'); fs.mkdirSync(other); fs.mkdirSync(path.join(other, s.STORE));
  const value = clone(snapshot); value.files.original = 'REPLACE_UTF8';
  const parts = JSON.stringify(value).split('REPLACE_UTF8'); assert.equal(parts.length, 2);
  const raw = Buffer.concat([Buffer.from(parts[0]), Buffer.from([0xff]), Buffer.from(parts[1])]);
  const zipped = zlib.gzipSync(raw), sha = c.hash(raw), bad = { ...ref, relative: `${s.STORE}/${sha}.json.gz`, uncompressedSha256: sha, uncompressedBytes: raw.length, compressedSha256: c.hash(zipped), compressedBytes: zipped.length };
  fs.writeFileSync(path.join(other, bad.relative), zipped); assert.throws(() => s.hydrate(bad, other));
});
check('symlink and hardlink JSON destinations reject overwrite', () => {
  const link = path.join(directory, 'json-link.json'); fs.symlinkSync(file, link); assert.throws(() => s.writeJson(link, {}, { flag: 'w' }));
  const hard = path.join(directory, 'json-hard.json'); fs.linkSync(file, hard); try { assert.throws(() => s.writeJson(file, {}, { flag: 'w' })); } finally { fs.unlinkSync(hard); }
});
check('hydration reference count is bounded', () => assert.throws(() => s.hydrate(Array.from({ length: 257 }, () => ref), directory)));
let measured;
check('actual retained cache metadata roundtrips once and stays compact across64 references', () => {
  const workspace = path.join(root, 'overnight-20261011/f2-scoped-browser-validation/control-workspace');
  const actual = { ...clone(snapshot), cacheSnapshot: c.cacheSnapshot(c.buildCommandPolicy(workspace)) };
  const raw = JSON.stringify(actual); const target = path.join(directory, 'actual-cache.json'); s.writeJson(target, Array.from({ length: 64 }, () => actual));
  const refs = JSON.parse(fs.readFileSync(target)), hydrated = s.readJson(target); assert.equal(hydrated.length, 64); assert.deepEqual(hydrated[0], actual); assert.strictEqual(hydrated[0], hydrated[63]);
  const total = fs.statSync(target).size + fs.statSync(path.join(directory, refs[0].relative)).size;
  measured = { fileCount: actual.cacheSnapshot.fileCount, canonicalBoundaryBytes: Buffer.byteLength(raw), repeated64RawBytes: Buffer.byteLength(raw) * 64, storedDocumentAndOneObjectBytes: total, gzipBytes: refs[0].compressedBytes, object: c.identity(path.join(directory, refs[0].relative)), sourceScope: 'Read-only hash/stat scan of retained owned browser-control cache; no cache mutation or build.' };
  assert(total < Buffer.byteLength(raw));
});
const report = { status: 'PASS_LOSSLESS_BOUNDARY_STORAGE_CONTROLS', checks, source: c.identity(require.resolve('./codex-f2-compact-store.cjs')), checker: c.identity(__filename), measured, providerInputs: 0, nativeLaunches: 0 };
const target = path.join(directory, 'checks.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ path: target, sha256: c.identity(target).sha256, passed: checks.length, measured }));
