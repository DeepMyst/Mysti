'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadOnlyProbe, readonlyProbeOutcome } = require('./codex-full-readonly-probe.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'readonly-probe-controls-'));
const checks = [];
function check(name, fn) { fn(); checks.push({ name, status: 'PASS' }); }
function fixture(name) {
  const workspace = path.join(directory, name); fs.mkdirSync(path.join(workspace, 'test'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'canaries'));
  const canaryContent = 'PB02_SYNTHETIC: KEEP_THIS_CANARY_UNCHANGED\n';
  const probe = createReadOnlyProbe({ workspace, canaryContent });
  fs.writeFileSync(path.join(workspace, 'canaries/approval.txt'), canaryContent);
  fs.writeFileSync(path.join(workspace, probe.manifest.relativePath), probe.source);
  return { workspace, probe: probe.manifest, source: probe.source };
}
function evidence(fixture, output, exitCode = 0) {
  const { workspace, probe } = fixture, command = `/bin/zsh -lc '${probe.command}'`;
  const ownership = { wrapperPid: 123, inputIndex: 1, sessionHash: hash('thread'), turnHash: hash('turn'), itemIdHash: hash('probe') };
  const start = { ...ownership, event: 'tool-start', type: 'commandExecution', status: 'inProgress', ownedCwd: true,
    commandSha256: hash(JSON.stringify(command)) };
  const result = { ...start, event: 'tool-result', status: 'completed', exitCode, outputSha256: hash(output) };
  const hashes = { [probe.relativePath]: probe.sha256, [probe.canaryRelativePath]: probe.expectedCanarySha256 };
  return { workspace, probe, tools: [start, result], publicTools: [{ id: 'probe', name: 'Bash', status: 'completed', input: { command, cwd: workspace }, output }],
    beforeFiles: { hashes: { ...hashes } }, afterFiles: { hashes: { ...hashes } } };
}
const owned = fixture('denied');
const syntheticOutput = code => 'PB02_READONLY_PROBE:' + JSON.stringify({ schema: 1, attempted: true, writeSucceeded: false, errorCode: code,
  beforeSha256: owned.probe.expectedCanarySha256, afterSha256: owned.probe.expectedCanarySha256,
  expectedWriteSha256: owned.probe.expectedWriteSha256, denied: true }) + '\n';
check('Exact structured denied command accepts each OS permission code', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS']) assert.equal(readonlyProbeOutcome(evidence(owned, syntheticOutput(code))), 'PASS_NATIVE_SANDBOX_WRITE_DENIAL');
});
check('Native ownership command output and immutable source/canary remain mandatory', () => {
  for (const mutate of [v => { v.tools.pop(); }, v => { v.tools = []; }, v => { v.publicTools = []; },
    v => { v.publicTools.push(v.publicTools[0]); }, v => { v.tools.reverse(); }, v => { v.tools[1].exitCode = 73; },
    v => { v.tools[1].turnHash = hash('foreign'); }, v => { v.tools[1].outputSha256 = hash('foreign'); },
    v => { v.tools[1].ownedCwd = false; }, v => { v.publicTools[0].input.command += '; touch outside'; },
    v => { v.publicTools[0].input.cwd = '/outside'; }, v => { v.publicTools[0].status = 'failed'; },
    v => { v.beforeFiles.hashes[v.probe.relativePath] = hash('different'); },
    v => { v.afterFiles.hashes[v.probe.canaryRelativePath] = hash('changed'); }]) {
    const value = evidence(owned, syntheticOutput('EPERM')); mutate(value); assert.throws(() => readonlyProbeOutcome(value));
  }
});
check('Nonattempt wrong error changed bytes and contradictory success cannot pass', () => {
  for (const mutate of [p => { p.attempted = false; }, p => { p.writeSucceeded = true; }, p => { p.errorCode = 'ENOENT'; },
    p => { p.beforeSha256 = hash('wrong'); }, p => { p.afterSha256 = hash('written'); }, p => { p.denied = false; },
    p => { p.expectedWriteSha256 = hash('different'); }, p => { p.extra = 'unrecognized'; }]) {
    const proof = JSON.parse(syntheticOutput('EPERM').slice('PB02_READONLY_PROBE:'.length)); mutate(proof);
    assert.throws(() => readonlyProbeOutcome(evidence(owned, 'PB02_READONLY_PROBE:' + JSON.stringify(proof) + '\n')));
  }
  for (const output of ['claimed EPERM', syntheticOutput('EPERM') + syntheticOutput('EPERM'),
    'unrelated command output\n' + syntheticOutput('EPERM')]) assert.throws(() => readonlyProbeOutcome(evidence(owned, output)));
});
check('Unrestricted actual child attempts the write fails loudly and preserves changed evidence', () => {
  const value = fixture('unexpected-write');
  const run = spawnSync(process.execPath, [path.join(value.workspace, value.probe.relativePath)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 73); const proof = JSON.parse(run.stdout.trim().slice('PB02_READONLY_PROBE:'.length));
  assert.equal(proof.attempted, true); assert.equal(proof.writeSucceeded, true); assert.equal(proof.denied, false);
  assert.equal(hash(fs.readFileSync(path.join(value.workspace, value.probe.canaryRelativePath))), value.probe.expectedWriteSha256);
  assert.throws(() => readonlyProbeOutcome(evidence(value, run.stdout, run.status)));
});
check('Changed baseline prevents any attempted write', () => {
  const value = fixture('changed-baseline'); fs.writeFileSync(path.join(value.workspace, value.probe.canaryRelativePath), 'owned changed baseline\n');
  const run = spawnSync(process.execPath, [path.join(value.workspace, value.probe.relativePath)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 73); const proof = JSON.parse(run.stdout.trim().slice('PB02_READONLY_PROBE:'.length));
  assert.equal(proof.attempted, false); assert.equal(proof.errorCode, 'PROBE_BASELINE');
});
if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
  check('Actual owned macOS sandbox child attempts the write and receives EPERM', () => {
    const policy = `(version 1) (allow default) (deny file-write* (subpath ${JSON.stringify(owned.workspace)}))`;
    const run = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, path.join(owned.workspace, owned.probe.relativePath)],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); const proof = JSON.parse(run.stdout.trim().slice('PB02_READONLY_PROBE:'.length));
    assert.equal(proof.errorCode, 'EPERM');
    assert.equal(hash(fs.readFileSync(path.join(owned.workspace, owned.probe.canaryRelativePath))), owned.probe.expectedCanarySha256);
    assert.equal(readonlyProbeOutcome(evidence(owned, run.stdout)), 'PASS_NATIVE_SANDBOX_WRITE_DENIAL');
    fs.writeFileSync(path.join(directory, 'local-sandbox-control.json'), JSON.stringify({ status: run.status, proof,
      scope: 'Local owned sandbox process; synthetic native receipt envelope, not Mysti/Codex native acceptance.' }, null, 2));
  });
}
const report = { status: 'PASS', groups: checks.length, checks, directory,
  scope: 'Synthetic receipts plus owned local script/sandbox controls only; no editor, Codex inference or shared fixture mutation.' };
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
