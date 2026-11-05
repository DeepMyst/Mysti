/* Local shutdown observation controls. Synthetic child only; no editor or provider input. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createPB02ProfileCompatibilityCli } = require('./pb02-profile-compatibility-cli-fixture.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'profile-shutdown-observation-controls-'));
const runtime = path.join(__dirname, 'pb02-profile-compatibility-cli-runtime.cjs');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const runtimeSha256 = hash(runtime), checks = [], cases = [];
const codeHome = path.join(directory, 'empty-synthetic-home'); fs.mkdirSync(codeHome);
const backend = path.join(directory, 'synthetic-backend.cjs');
fs.writeFileSync(backend, `
'use strict';
const fs = require('node:fs');
const log = process.argv[2];
const record = event => fs.appendFileSync(log, JSON.stringify({event, pid:process.pid, at:Date.now()})+'\\n');
let stopping = false;
function stop(reason) {
 if (stopping) return; stopping = true; record(reason);
 process.stderr.write('SYNTHETIC_SHUTDOWN مرحبا • café • € • 😀\\n', () => {
   record('stderr-write-callback'); setTimeout(() => { record('exit-zero'); process.exit(0); }, 120);
 });
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.stderr.on('error', error => { record('stderr-error-'+error.code); process.exit(19); });
process.stdin.on('data', bytes => record('unexpected-input-'+bytes.length));
process.stdin.on('end', () => stop('stdin-end'));
record('ready'); process.stdout.write('SYNTHETIC_READY\\n');
`, { flag: 'wx' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { assert(Date.now() < deadline, label); await delay(10); }
}
function birth(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim() || null; }
  catch { return null; }
}
function receipts(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []; }
async function scenario(name, mode) {
  const folder = path.join(directory, name); fs.mkdirSync(folder);
  const backendLog = path.join(folder, 'backend.jsonl');
  const fixture = createPB02ProfileCompatibilityCli({ directory: folder, executable: process.execPath,
    prefixArgs: [backend, backendLog], node: process.execPath, workspace: folder,
    counterFile: path.join(folder, 'counter.json'), token: 'SYNTHETIC', maxInputs: 1,
    profileValidation: { profiles: {}, missing: { name: 'missing-synthetic', path: path.join(codeHome, 'missing-synthetic.config.toml') }, codeHome } });
  const child = spawn(fixture.launcher, ['app-server'], { env: { ...process.env, CODEX_HOME: codeHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; child.stdin.on('error', () => {});
  child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
  let ended, nativePid, nativeBirth;
  const close = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { ended = { code, signal, at: Date.now() }; resolve(ended); }); });
  try {
    await until(() => Buffer.concat(stdout).includes('SYNTHETIC_READY\n'), 'Synthetic child ready');
    const start = receipts(fixture.receipts).find(value => value.event === 'start');
    assert(start); nativePid = start.childPid; nativeBirth = birth(nativePid); assert(nativeBirth);
    const actionAt = Date.now();
    if (mode === 'closed-pipes') {
      child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGTERM');
    } else if (mode === 'forced-observer-loss') {
      child.kill('SIGKILL');
    } else if (mode === 'eof') {
      child.stdin.end();
    } else {
      child.kill('SIGTERM');
    }
    await until(() => ended, 'Wrapper close observed'); await close;
    if (mode === 'forced-observer-loss' && birth(nativePid) === nativeBirth) process.kill(nativePid, 'SIGTERM');
    await until(() => birth(nativePid) !== nativeBirth, 'Owned synthetic native process exited');
    const wire = receipts(fixture.receipts), summaries = wire.filter(value => value.event === 'stderr-summary'), exits = wire.filter(value => value.event === 'exit');
    const result = { name, mode, actionAt, wrapperPid: child.pid, nativePid, nativeBirth, wrapperTerminal: ended,
      receipts: wire, backend: receipts(backendLog), stdoutHex: Buffer.concat(stdout).toString('hex'), stderrHex: Buffer.concat(stderr).toString('hex'),
      ownedNativeIdentityExited: true, summaries: summaries.length, exits: exits.length };
    cases.push(result);
    assert(!fs.existsSync(path.join(folder, 'counter.json'))); assert(!wire.some(value => value.event === 'request'));
    if (mode === 'closed-pipes' || mode === 'forced-observer-loss') {
      assert.equal(summaries.length, 0); assert.equal(exits.length, 0);
      if (mode === 'closed-pipes') assert.equal(ended.code, 1, 'Closed observer pipes can terminate the wrapper before child.close');
      else assert.equal(ended.signal, 'SIGKILL');
    } else {
      assert.equal(ended.code, 0); assert.equal(summaries.length, 1); assert.equal(exits.length, 1);
      assert.equal(exits[0].exitCode, 0); assert.equal(exits[0].signal, null); assert.equal(exits[0].childPid, nativePid);
      assert(wire.indexOf(summaries[0]) < wire.indexOf(exits[0]));
      const bytes = Buffer.concat(stderr); assert.equal(summaries[0].bytes, bytes.length);
      assert.equal(summaries[0].sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(summaries[0].runtimeOnlyProfileArgument, false);
      assert.equal(bytes.toString('utf8'), 'SYNTHETIC_SHUTDOWN مرحبا • café • € • 😀\n');
    }
    checks.push({ name, status: 'PASS' });
  } finally {
    if (!ended) child.kill('SIGKILL');
    if (nativePid && nativeBirth && birth(nativePid) === nativeBirth) process.kill(nativePid, 'SIGKILL');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
}
(async () => {
  await scenario('closed-parent-pipes-reproduces-missing-terminal', 'closed-pipes');
  await scenario('forced-observer-loss-retains-unknown-terminal', 'forced-observer-loss');
  await scenario('deliberate-boundary-with-live-observer-captures-terminal', 'signal');
  await scenario('stdin-eof-with-live-observer-captures-terminal', 'eof');
  assert.equal(hash(runtime), runtimeSha256);
  const result = { status: 'PASS', directory, checks, cases, runtime: { path: runtime, sha256: runtimeSha256 },
    nativeCLILaunches: 0, realProviderInputs: 0, editorLaunches: 0, actualAccountFilesReadOrWritten: 0,
    interpretation: 'The unchanged wrapper can lose terminal receipts when its observation lifetime ends first. Keeping its parent pipes alive across a deliberate lifecycle boundary captures the actual terminal. These controlled mechanisms do not identify the unknown cause of the original A55 gap.' };
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ status: result.status, directory, checks }));
})().catch(error => {
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', directory, checks, cases, error: { name: error.name, message: error.message, stack: error.stack } }, null, 2) + '\n', { flag: 'wx' });
  console.error(error); process.exitCode = 1;
});
