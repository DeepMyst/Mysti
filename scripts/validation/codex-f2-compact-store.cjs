/* Additive lossless storage for complete F2 boundary snapshots only. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto'), zlib = require('node:zlib');
const ROOT = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const TAG = '__pb02BoundaryRef', STORE = '.pb02-boundaries', MAX_RAW = 64 * 1024 * 1024, MAX_GZIP = 16 * 1024 * 1024;
const KEYS = ['applicationTemporarySnapshot', 'buildSnapshot', 'cacheSnapshot', 'dependencySnapshots', 'files'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = new WeakMap();
function exactDirectory(directory) {
  assert(path.isAbsolute(directory) && path.normalize(directory) === directory && (directory === ROOT || directory.startsWith(ROOT + path.sep)));
  assert.equal(fs.realpathSync(directory), directory); const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && stat.uid === process.getuid()); return directory;
}
function exactJson(file) { assert(path.isAbsolute(file) && path.normalize(file) === file && file.endsWith('.json')); exactDirectory(path.dirname(file)); return file; }
function readPrivate(file, limit) {
  assert.equal(fs.realpathSync(file), file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd); assert(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && before.size <= limit);
    const chunks = []; let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - total));
      const length = fs.readSync(fd, chunk, 0, chunk.length, null); if (!length) break;
      chunks.push(chunk.subarray(0, length)); total += length;
    }
    const bytes = Buffer.concat(chunks, total), after = fs.fstatSync(fd);
    assert(bytes.length <= limit && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function isBoundary(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === KEYS.join('|') &&
    value.files && typeof value.files === 'object' && Array.isArray(value.dependencySnapshots) &&
    (value.cacheSnapshot === null || value.cacheSnapshot && Array.isArray(value.cacheSnapshot.files));
}
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function validateReference(ref) {
  assert(ref && !Array.isArray(ref) && Object.keys(ref).sort().join('|') === [TAG, 'compressedBytes', 'compressedSha256', 'relative', 'uncompressedBytes', 'uncompressedSha256'].sort().join('|'));
  assert.equal(ref[TAG], 1); for (const key of ['compressedSha256', 'uncompressedSha256']) assert(/^[a-f0-9]{64}$/.test(ref[key]));
  assert(Number.isSafeInteger(ref.compressedBytes) && ref.compressedBytes > 0 && ref.compressedBytes <= MAX_GZIP);
  assert(Number.isSafeInteger(ref.uncompressedBytes) && ref.uncompressedBytes > 0 && ref.uncompressedBytes <= MAX_RAW);
  assert.equal(ref.relative, `${STORE}/${ref.uncompressedSha256}.json.gz`);
}
function loadReference(ref, directory) {
  validateReference(ref); exactDirectory(directory); const store = path.join(directory, STORE); exactDirectory(store);
  const file = path.join(directory, ref.relative), zipped = readPrivate(file, MAX_GZIP);
  assert.equal(zipped.length, ref.compressedBytes); assert.equal(digest(zipped), ref.compressedSha256);
  const raw = zlib.gunzipSync(zipped, { maxOutputLength: ref.uncompressedBytes });
  assert.equal(raw.length, ref.uncompressedBytes); assert.equal(digest(raw), ref.uncompressedSha256);
  const value = JSON.parse(raw.toString('utf8')); assert(isBoundary(value), 'A reference must hydrate a complete boundary object');
  assert(Buffer.from(JSON.stringify(value)).equals(raw), 'Stored bytes must be exact canonical UTF-8 JSON serialization');
  assert(!JSON.stringify(value).includes(`"${TAG}"`), 'Nested boundary references are forbidden');
  return value;
}
function storeBoundary(value, directory) {
  exactDirectory(directory); assert(isBoundary(value));
  const remembered = cache.get(value)?.get(directory);
  if (remembered) {
    const file = path.join(directory, remembered.relative), bytes = readPrivate(file, MAX_GZIP);
    assert.equal(bytes.length, remembered.compressedBytes); assert.equal(digest(bytes), remembered.compressedSha256); return remembered;
  }
  const raw = Buffer.from(JSON.stringify(value)); assert(raw.length > 0 && raw.length <= MAX_RAW);
  const zipped = zlib.gzipSync(raw, { level: 6 }); assert(zipped.length <= MAX_GZIP);
  const ref = { [TAG]: 1, relative: `${STORE}/${digest(raw)}.json.gz`, uncompressedSha256: digest(raw), uncompressedBytes: raw.length, compressedSha256: digest(zipped), compressedBytes: zipped.length };
  const store = path.join(directory, STORE);
  if (!fs.existsSync(store) && !fs.lstatSync(directory).isSymbolicLink()) fs.mkdirSync(store, { mode: 0o700 });
  exactDirectory(store); const file = path.join(directory, ref.relative);
  if (fs.existsSync(file) || (() => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } })()) {
    const existing = readPrivate(file, MAX_GZIP); assert.equal(digest(existing), ref.compressedSha256); assert.equal(existing.length, ref.compressedBytes);
  } else fs.writeFileSync(file, zipped, { flag: 'wx', mode: 0o600 });
  freeze(value); if (!cache.has(value)) cache.set(value, new Map()); cache.get(value).set(directory, freeze(ref)); return ref;
}
function encode(value, directory) {
  exactDirectory(directory);
  function walk(item) {
    if (!item || typeof item !== 'object') return item;
    assert(!Object.prototype.hasOwnProperty.call(item, TAG), 'Input must be hydrated, never pre-forged refs');
    if (isBoundary(item)) return storeBoundary(item, directory);
    if (Array.isArray(item)) return item.map(walk);
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
  }
  return walk(value);
}
function hydrate(value, directory) {
  exactDirectory(directory); const budget = { bytes: 0, refs: 0 }, loaded = new Map();
  function walk(item) {
    if (!item || typeof item !== 'object') return item;
    if (Object.prototype.hasOwnProperty.call(item, TAG)) {
      validateReference(item); budget.bytes += item.uncompressedBytes; budget.refs++;
      assert(budget.refs <= 256 && budget.bytes <= 768 * 1024 * 1024, 'Hydration budget exceeded');
      const key = JSON.stringify(item);
      if (!loaded.has(key)) loaded.set(key, loadReference(item, directory));
      return loaded.get(key);
    }
    if (Array.isArray(item)) return item.map(walk);
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
  }
  return walk(value);
}
function readJson(file) { exactJson(file); return hydrate(JSON.parse(readPrivate(file, MAX_RAW).toString('utf8')), path.dirname(file)); }
function stringify(file, value, space = 2) { exactJson(file); return JSON.stringify(encode(value, path.dirname(file)), null, space); }
function writeJson(file, value, options = { flag: 'wx', mode: 0o600 }) {
  const text = stringify(file, value) + '\n'; assert(['wx', 'w'].includes(options.flag || 'wx'));
  assert(Buffer.byteLength(text) <= MAX_RAW, 'JSON document exceeds reader bound');
  if (fs.existsSync(file) || (() => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } })()) {
    assert.equal(fs.realpathSync(file), file); const stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid());
    assert.equal(options.flag, 'w', 'Exclusive output already exists');
  }
  // Publish only a complete file. A failed write keeps its uniquely named
  // temporary evidence and never truncates the prior live observation.
  const temporary = path.join(path.dirname(file), `.pb02-write-${randomBytes(16).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_EXCL;
  const fd = fs.openSync(temporary, flags, 0o600);
  try { const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid()); fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if ((options.flag || 'wx') === 'wx') {
    // link() provides atomic no-clobber publication; remove the temporary
    // link synchronously before returning the completed private document.
    fs.linkSync(temporary, file); fs.unlinkSync(temporary);
  } else {
    if (fs.existsSync(file)) { const stat = fs.lstatSync(file); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid()); }
    fs.renameSync(temporary, file);
  }
}
module.exports = { TAG, STORE, MAX_RAW, MAX_GZIP, isBoundary, encode, hydrate, readJson, stringify, writeJson, storeBoundary, loadReference };
