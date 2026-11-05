/* Preparation boundary controls only; no editor, provider or application starts. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const c = require('./codex-f2-compact-campaign.cjs');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.mkdtempSync(path.join(root, 'f2-compact-preparation-controls-'));
const read = file => JSON.parse(fs.readFileSync(file));
const compiled = fs.realpathSync(process.argv[2]); c.contained(root, compiled);
const release = path.join(root, 'overnight-20261011/suggestion-ownership-release');
const sourceFile = process.env.MYSTI_PB02_F2_COMPACT_SOURCE_IDENTITY || path.join(release, 'source-identity.json');
const packageFile = process.env.MYSTI_PB02_F2_COMPACT_PACKAGE_IDENTITY || path.join(release, 'package-identity.json');
const script = path.join(__dirname, 'prepare-vscode-codex-f2-compact.cjs');
const env = { ...process.env, MYSTI_PB02_F2_COMPACT_SEGMENT: '1', MYSTI_PB02_F2_COMPACT_COMPILED_DIR: compiled,
  MYSTI_PB02_F2_COMPACT_SOURCE_IDENTITY: sourceFile, MYSTI_PB02_F2_COMPACT_PACKAGE_IDENTITY: packageFile };
const python=fs.realpathSync('/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9');
env.MYSTI_PB02_F2_COMPACT_PYTHON=python;
const browser=path.join(root,'overnight-20261011/f2-selected-browser-validation/selected-browser-scoped.cjs');
env.MYSTI_PB02_F2_COMPACT_BROWSER_ORACLE=browser;env.MYSTI_PB02_F2_COMPACT_BROWSER_ORACLE_SHA=c.identity(browser).sha256;
const cloneOptions=name=>({python,report:path.join(directory,name+'.clone.json')});
const checks = [], check = (name, fn) => { fn(); checks.push({ name, status: 'PASS' }); };
function rejected(name, target, extra, pattern) {
  assert(!fs.existsSync(target));
  const before = fs.readdirSync(path.join(repo, '.vscode-test/profiles')).sort();
  const result = spawnSync(process.execPath, [script], { env: { ...env, MYSTI_PB02_F2_COMPACT_CAMPAIGN_DIR: target, ...extra }, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(result.status, 0, name); assert.equal(result.signal, null); assert.match(result.stderr, pattern); assert(!fs.existsSync(target));
  assert.deepEqual(fs.readdirSync(path.join(repo, '.vscode-test/profiles')).sort(), before, 'Rejected prep creates no profile');
  fs.writeFileSync(path.join(directory, `${name}.process.json`), JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2), { flag: 'wx' });
}
check('invalid segment rejects before creation', () => rejected('invalid-segment', path.join(directory, 'invalid-segment-attempt'), { MYSTI_PB02_F2_COMPACT_SEGMENT: '3' }, /includes\(segment\)/));
check('out-of-root target rejects before creation', () => rejected('outside-root', path.join(repo, '.vscode-test/f2-forbidden-attempt'), {}, /Owned descendant required/));
check('missing parent rejects before creation', () => rejected('missing-parent', path.join(directory, 'missing/attempt'), {}, /ENOENT/));
check('aliased parent rejects before creation', () => {
  const alias = path.join(directory, 'alias'); fs.symlinkSync(directory, alias, 'dir');
  rejected('aliased-parent', path.join(alias, 'forbidden'), {}, /AssertionError/);
});
for (const marker of ['prepared.json', 'campaign.json']) check(`${marker} ancestor rejects before creation`, () => {
  const parent = path.join(directory, marker + '-parent'); fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, marker), '{}');
  rejected(marker + '-ancestor', path.join(parent, 'forbidden'), {}, /Never prepare inside earlier native evidence/);
});
check('existing campaign cannot be overwritten', () => {
  const target = path.join(directory, 'existing'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.txt'), 'exact preserved bytes');
  const result = spawnSync(process.execPath, [script], { env: { ...env, MYSTI_PB02_F2_COMPACT_CAMPAIGN_DIR: target }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exclusive new directory/); assert.deepEqual(fs.readdirSync(target), ['keep.txt']); assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'exact preserved bytes');
});
check('segment two requires an actual pinned prior campaign', () => rejected('missing-campaign', path.join(directory, 'missing-campaign-attempt'), { MYSTI_PB02_F2_COMPACT_SEGMENT: '2' }, /ENOENT/));
check('compiled code cannot be borrowed from a prepared evidence tree', () => {
  const parent = path.join(directory, 'compiled-parent'); fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, 'prepared.json'), '{}');
  const child = path.join(parent, 'compiled'); fs.mkdirSync(child);
  rejected('compiled-ancestor', path.join(directory, 'compiled-forbidden'), { MYSTI_PB02_F2_COMPACT_COMPILED_DIR: child }, /Never prepare inside earlier native evidence/);
});
check('source freeze mismatch rejects before any campaign copy', () => {
  const changed = read(sourceFile); changed.files[Object.keys(changed.files)[0]] = '0'.repeat(64);
  const file = path.join(directory, 'wrong-source.json'); fs.writeFileSync(file, JSON.stringify(changed));
  rejected('wrong-source', path.join(directory, 'wrong-source-attempt'), { MYSTI_PB02_F2_COMPACT_SOURCE_IDENTITY: file }, /Frozen source\/test bytes required/);
});
check('package archive mismatch rejects before any campaign copy', () => {
  const changed = { ...read(packageFile), sha256: '0'.repeat(64) }, file = path.join(directory, 'wrong-package.json'); fs.writeFileSync(file, JSON.stringify(changed));
  rejected('wrong-package', path.join(directory, 'wrong-package-attempt'), { MYSTI_PB02_F2_COMPACT_PACKAGE_IDENTITY: file }, /AssertionError/);
});
const deps = path.join(directory, 'dependency-source'); fs.mkdirSync(path.join(deps, '.bin'), { recursive: true }); fs.mkdirSync(path.join(deps, 'tool'));
const executable = path.join(deps, 'tool/index.cjs'); fs.writeFileSync(executable, 'process.stdout.write(__dirname);\n');
fs.symlinkSync('../tool/index.cjs', path.join(deps, '.bin/tool'));
check('old default copy redirects a relative executable into source and is detected', () => {
  const target = path.join(directory, 'old-copy'); fs.cpSync(deps, target, { recursive: true });
  assert.equal(fs.realpathSync(path.join(target, '.bin/tool')), executable);
  assert.notEqual(fs.realpathSync(path.join(target, '.bin/tool')), path.join(target, 'tool/index.cjs'));
});
check('private copied executable resolves and runs solely inside owned copied dependency root', () => {
  const target = path.join(directory, 'private-copy'), receipt = c.copyPrivateDependencies(deps, target, cloneOptions(path.basename(target)));
  assert.equal(receipt.files, 1); assert.equal(fs.readlinkSync(path.join(target, '.bin/tool')), '../tool/index.cjs');
  assert.equal(execFileSync(process.execPath, [path.join(target, '.bin/tool')], { encoding: 'utf8' }), path.join(target, 'tool'));
  fs.writeFileSync(path.join(target, 'tool/index.cjs'), 'owned changed bytes'); assert.equal(fs.readFileSync(executable, 'utf8'), 'process.stdout.write(__dirname);\n');
});
for (const absolute of [false, true]) check(`${absolute ? 'absolute' : 'external relative'} dependency link rejects before copy`, () => {
  const file = path.join(deps, '.bin/rejected'); fs.symlinkSync(absolute ? executable : '../../../outside.cjs', file);
  if (!absolute) fs.writeFileSync(path.join(directory, 'outside.cjs'), 'outside');
  const target = path.join(directory, absolute ? 'absolute-copy' : 'external-copy');
  try { assert.throws(() => c.copyPrivateDependencies(deps, target, cloneOptions(path.basename(target)))); assert(!fs.existsSync(target)); } finally { fs.unlinkSync(file); }
});
check('nested dependency copy cannot recursively consume its own output', () => assert.throws(() => c.copyPrivateDependencies(deps, path.join(deps, 'copy'), cloneOptions('nested'))));
const report = { status: 'PASS_PREPARATION_BOUNDARIES_NO_NATIVE_INFERENCE', checkedAt: new Date().toISOString(),
  preparer: c.identity(script), contract: c.identity(require.resolve('./codex-f2-compact-campaign.cjs')), sourceIdentity: c.identity(sourceFile), packageIdentity: c.identity(packageFile), checks,
  limitations: ['No complete campaign was prepared and no real profile or provider was launched.', 'The dependency executable is a tiny owned synthetic control. Actual campaign preparation separately verifies all source dependency links before copying them.'] };
const target = path.join(directory, 'checks.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: target, sha256: c.identity(target).sha256, passed: checks.length }));
