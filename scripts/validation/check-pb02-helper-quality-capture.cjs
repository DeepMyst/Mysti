/* Synthetic controls only: every wrapped executable here is an owned Node stand-in. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createPB02HelperQualityAuxiliaryCli } = require('./pb02-helper-quality-auxiliary-fixture.cjs');
const { EXPECTED_ARGS, classifyDiagnostic } = require('./pb02-helper-quality-auxiliary-runtime.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'helper-quality-capture-controls-'));
const checks = [], temporaryCwds = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const backend = path.join(directory, 'owned-node-backend.cjs');
fs.writeFileSync(backend, `
const fs = require('node:fs');
const [capture, stdoutFile, stderrFile] = process.argv.slice(2);
fs.writeFileSync(capture + '.launch', JSON.stringify({args:process.argv.slice(5),cwd:process.cwd(),pwd:process.env.PWD,safeMode:process.env.CLAUDE_CODE_SAFE_MODE,preserved:process.env.PB02_SYNTHETIC_ENV}));
let data = Buffer.alloc(0);
process.stdin.on('data', chunk => { data = Buffer.concat([data,chunk]); fs.writeFileSync(capture,data); });
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('end', () => {
  const streams = [[process.stdout,fs.readFileSync(stdoutFile)],[process.stderr,fs.readFileSync(stderrFile)]];
  for (const [stream,bytes] of streams) { let offset=0; const emit=()=>{if(offset<bytes.length){stream.write(bytes.subarray(offset,++offset));setImmediate(emit);}};emit(); }
});
`);
function fixture(name, { counterFile, maxInputs = 12, output = 'Owned answer ☃ 👩‍💻\n', error = '', allowlist = { maxOutputBytes: 32768, entries: [] } } = {}) {
  const folder = path.join(directory, name); fs.mkdirSync(folder);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-text-worker-')); temporaryCwds.push(cwd);
  const capture = path.join(folder, 'input');
  const outputFile = path.join(folder, 'stdout'), errorFile = path.join(folder, 'stderr');
  fs.writeFileSync(outputFile, output); fs.writeFileSync(errorFile, error);
  counterFile ||= path.join(folder, 'counter.json');
  const cli = createPB02HelperQualityAuxiliaryCli({ directory: folder, node: fs.realpathSync(process.execPath), executable: fs.realpathSync(process.execPath),
    prefixArgs: [backend, capture, outputFile, errorFile], counterFile, maxInputs, allowlist, probeDirectories: [directory] });
  return { ...cli, folder, capture, cwd, counterFile, outputFile, errorFile };
}
function start(f, { args = EXPECTED_ARGS, cwd = f.cwd, env = {} } = {}) {
  const child = spawn(f.launcher, args, { cwd, env: { ...process.env, PWD: cwd, CLAUDE_CODE_SAFE_MODE: '1', PB02_SYNTHETIC_ENV: 'preserved', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk)); child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned synthetic worker timed out')); }, 10000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
        receipts: fs.readFileSync(f.receipts, 'utf8').split('\n').filter(Boolean).map(JSON.parse) });
    });
  });
  return { child, done };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Owned receipt timeout');
}
async function check(name, action) { await action(); checks.push({ name, status: 'PASS' }); }
(async () => {
  await check('exact argv cwd environment and split UTF8 bytes are forwarded without content logging', async () => {
    const f = fixture('bytes', { output: 'not JSON {bad}\nnull\nOwned ☃ 👩‍💻', error: 'stderr ⚡\n' });
    const run = start(f);
    const prompt = Buffer.from('Analyze this AI response and classify its interactive elements.\nPRIVATE_SYNTHETIC_PROMPT ☃ 👩‍💻');
    for (let offset = 0; offset < prompt.length; offset++) { run.child.stdin.write(prompt.subarray(offset, offset + 1)); await new Promise(resolve => setImmediate(resolve)); }
    run.child.stdin.end(); const result = await run.done;
    assert.equal(result.code, 0); assert.deepEqual(fs.readFileSync(f.capture), prompt);
    assert.deepEqual(result.stdout, fs.readFileSync(f.outputFile)); assert.deepEqual(result.stderr, fs.readFileSync(f.errorFile));
    const launch = JSON.parse(fs.readFileSync(f.capture + '.launch'));
    assert.deepEqual(launch.args, EXPECTED_ARGS); assert.equal(fs.realpathSync(launch.cwd), fs.realpathSync(f.cwd));
    assert.equal(launch.preserved, 'preserved'); assert.equal(launch.safeMode, '1');
    const receipt = result.receipts.find(value => value.event === 'auxiliary-result');
    assert.equal(receipt.purpose, 'classification'); assert.equal(receipt.inputSha256, hash(prompt)); assert.equal(receipt.inputBytes, prompt.length);
    assert.equal(receipt.stdoutSha256, hash(result.stdout)); assert.equal(receipt.stderrSha256, hash(result.stderr));
    assert.equal(receipt.outcome, 'TEXT_RETURNED_UNVALIDATED');
    assert(!JSON.stringify(result.receipts).includes('PRIVATE_SYNTHETIC_PROMPT')); assert(!JSON.stringify(result.receipts).includes('not JSON'));
    const startReceipt = result.receipts.find(value => value.event === 'auxiliary-start');
    assert.equal(startReceipt.processBirths.length, 2); assert.equal(startReceipt.cwdMode, 0o700);
    assert.equal(startReceipt.cwdInitiallyEmpty, true); assert.equal(startReceipt.environmentForwardedUnchanged, true);
  });
  await check('input is reserved and recorded before forwarding even if EOF never arrives', async () => {
    const f = fixture('before-eof'), run = start(f), prompt = Buffer.from('Generate a short, concise title PRIVATE_PARTIAL');
    run.child.stdin.write(prompt);
    await waitFor(() => fs.existsSync(f.capture));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.counterFile)), { forwardedInputs: 1, maxInputs: 12 });
    const receipts = fs.readFileSync(f.receipts, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(receipts.filter(value => value.event === 'auxiliary-input').length, 1);
    assert.equal(receipts.filter(value => value.event === 'auxiliary-submission').length, 0);
    run.child.kill('SIGTERM'); const result = await run.done;
    const terminal = result.receipts.find(value => value.event === 'auxiliary-result');
    assert.equal(terminal.inputEnded, false); assert.equal(terminal.inputBytes, prompt.length); assert.equal(terminal.purpose, 'title');
  });
  await check('unknown argv and relaxed tool flags cannot start the backend', async () => {
    const variants = [['--print'], [...EXPECTED_ARGS, '--dangerously-skip-permissions'], EXPECTED_ARGS.map(value => value === 'dontAsk' ? 'bypassPermissions' : value), ['-p', 'PRIVATE_ARG']];
    for (const [index, args] of variants.entries()) {
      const f = fixture(`args-${index}`), run = start(f, { args }); run.child.stdin.end('PRIVATE_INPUT'); const result = await run.done;
      assert.equal(result.code, 1); assert(!fs.existsSync(f.capture + '.launch')); assert(!fs.existsSync(f.counterFile));
      assert(result.receipts.some(value => value.event === 'auxiliary-invocation-refusal')); assert(!JSON.stringify(result.receipts).includes('PRIVATE_ARG'));
    }
  });
  await check('wrong cwd nonempty cwd and missing isolation environment refuse before spawn', async () => {
    for (const variant of ['wrong-cwd', 'nonempty', 'mode', 'pwd', 'safe']) {
      const f = fixture(variant); const options = {};
      if (variant === 'wrong-cwd') options.cwd = directory;
      if (variant === 'nonempty') fs.writeFileSync(path.join(f.cwd, 'unexpected'), 'owned');
      if (variant === 'mode') fs.chmodSync(f.cwd, 0o755);
      if (variant === 'pwd') options.env = { PWD: directory };
      if (variant === 'safe') options.env = { CLAUDE_CODE_SAFE_MODE: '0' };
      const run = start(f, options); run.child.stdin.end(); const result = await run.done;
      assert.equal(result.code, 1); assert(!fs.existsSync(f.capture + '.launch'));
    }
  });
  await check('five concurrent workers forward exactly the two available inputs', async () => {
    const counterFile = path.join(directory, 'concurrent-counter.json');
    const runs = Array.from({ length: 5 }, (_, index) => {
      const f = fixture(`cap-${index}`, { counterFile, maxInputs: 2 }); const run = start(f); run.child.stdin.end('Given this AI response, suggest 6 follow-up actions as JSON array.'); return { f, run };
    });
    const results = await Promise.all(runs.map(({ run }) => run.done));
    assert.equal(results.filter(value => value.code === 0).length, 2); assert.equal(results.filter(value => value.code === 1).length, 3);
    assert.equal(runs.filter(({ f }) => fs.existsSync(f.capture)).length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(counterFile)), { forwardedInputs: 2, maxInputs: 2 });
    assert(!fs.existsSync(counterFile + '.lock'));
    const receipts = results.flatMap(value => value.receipts);
    assert.equal(receipts.filter(value => value.event === 'auxiliary-input').length, 2);
    assert.equal(receipts.filter(value => value.event === 'auxiliary-input-cap-refusal').length, 3);
  });
  await check('unused warm worker launches are real but consume zero inputs', async () => {
    const f = fixture('warm'), run = start(f);
    await waitFor(() => fs.existsSync(f.capture + '.launch')); run.child.kill('SIGTERM');
    const result = await run.done;
    assert.equal(result.receipts.filter(value => value.event === 'auxiliary-start').length, 1);
    assert.equal(result.receipts.filter(value => value.event === 'auxiliary-input').length, 0);
    assert.equal(result.receipts.find(value => value.event === 'auxiliary-result').outcome, 'NO_INPUT_WORKER_EXIT');
    assert(!fs.existsSync(f.counterFile));
  });
  await check('version probes are separate and any submitted probe input is refused', async () => {
    const f = fixture('version', { output: '2.1.296 (Claude Code)\n' }), run = start(f, { args: ['--version'], cwd: f.folder, env: { PWD: '/nonexistent/pb02-owned-probe' } });
    run.child.stdin.end(); const result = await run.done;
    assert.equal(result.code, 0); assert.equal(result.receipts.filter(value => value.event === 'probe-start').length, 1);
    assert.equal(result.receipts.filter(value => value.event === 'auxiliary-input').length, 0); assert(!fs.existsSync(f.counterFile));
    const blocked = fixture('probe-input'), next = start(blocked, { args: ['--version'], cwd: directory }); next.child.stdin.end('PRIVATE');
    const rejected = await next.done; assert.equal(rejected.code, 1); assert(!fs.existsSync(blocked.capture));
    assert(rejected.receipts.some(value => value.event === 'auxiliary-probe-input-refusal'));
  });
  await check('quota text on exit zero is not labeled successful classification', async () => {
    const f = fixture('quota', { output: 'You have reached your usage limit. PRIVATE_QUOTA_TEXT' }), run = start(f);
    run.child.stdin.end('Analyze this AI response and classify its interactive elements.'); const result = await run.done;
    const receipt = result.receipts.find(value => value.event === 'auxiliary-result');
    assert.equal(receipt.outcome, 'TEXT_RETURNED_UNVALIDATED'); assert.equal(receipt.semanticSuccess, 'NOT_INFERRED_FROM_TRANSPORT');
    assert.equal(receipt.diagnosticClassification, 'QUOTA_OR_RATE_LIMIT');
    assert(!JSON.stringify(result.receipts).includes('PRIVATE_QUOTA_TEXT'));
  });
  await check('bounded diagnostic categories distinguish rejected arguments auth and unknown without text retention', async () => {
    assert.equal(classifyDiagnostic("error: unknown option '--safe-mode'"), 'REJECTED_ARGUMENTS');
    assert.equal(classifyDiagnostic('Authentication failed. Please log in.'), 'AUTHENTICATION');
    assert.equal(classifyDiagnostic('You have hit your limit. Resets at 12:40.'), 'QUOTA_OR_RATE_LIMIT');
    assert.equal(classifyDiagnostic('A concise fixture title'), 'UNKNOWN_OR_NONE');
    const f = fixture('native-flag-rejection', { output: '', error: "error: unrecognized option '--safe-mode' PRIVATE_FLAG_BODY" });
    const run = start(f); run.child.stdin.end('Generate a short, concise title task'); const result = await run.done;
    assert.equal(result.receipts.find(value => value.event === 'auxiliary-result').diagnosticClassification, 'REJECTED_ARGUMENTS');
    assert(!JSON.stringify(result.receipts).includes('PRIVATE_FLAG_BODY'));
  });
  await check('owned completed exact input retains byte-identical split Unicode output and every prefix hash', async () => {
    const prompt = 'Generate a short, concise title OWNED_Café مرحبا € 😀';
    const allowlist = { maxOutputBytes: 32768, entries: [{ caseId: 'NONE', purpose: 'title', inputSha256: hash(prompt), inputBytes: Buffer.byteLength(prompt) }] };
    const f = fixture('owned-capture', { allowlist, output: 'Café مرحبا € 😀' }), run = start(f);
    for (const byte of Buffer.from(prompt)) run.child.stdin.write(Buffer.from([byte])); run.child.stdin.end();
    const result = await run.done; assert.equal(result.code, 0);
    const auth = result.receipts.filter(value => value.event === 'auxiliary-capture-authorization'); assert.equal(auth.length, 1); assert.equal(auth[0].status, 'OWNED_ALLOWLIST');
    const captures = result.receipts.filter(value => value.event === 'auxiliary-output-capture'); assert(captures.length > 0);
    const retained = fs.readFileSync(path.join(f.folder, captures.at(-1).relativePath)); assert.deepEqual(retained, result.stdout);
    assert.equal(fs.statSync(path.join(f.folder, captures.at(-1).relativePath)).mode & 0o777, 0o600);
    for (const capture of captures) { assert.equal(capture.sha256, hash(retained.subarray(0, capture.bytes))); assert.equal(capture.overflow, false); }
    assert(result.receipts.indexOf(auth[0]) > result.receipts.findIndex(value => value.event === 'auxiliary-submission'));
  });
  await check('one-byte or purpose mismatch never authorizes body retention', async () => {
    const expected = 'Generate a short, concise title OWNED';
    for (const [name, prompt, purpose] of [['bytes', expected + 'X', 'title'], ['purpose', expected, 'classification']]) {
      const f = fixture('mismatch-' + name, { allowlist: { maxOutputBytes: 32768, entries: [{ caseId: 'NONE', purpose, inputSha256: hash(expected), inputBytes: Buffer.byteLength(expected) }] } }), run = start(f);
      run.child.stdin.end(prompt); const result = await run.done; assert.equal(result.code, 0);
      assert.equal(result.receipts.find(value => value.event === 'auxiliary-capture-authorization').status, 'UNKNOWN_UNRETAINED');
      assert.deepEqual(fs.readdirSync(f.outputDirectory), []); assert(!result.receipts.some(value => value.event === 'auxiliary-output-capture'));
    }
  });
  await check('owned overflow retains only32KiB while forwarding and hashing the complete original stream', async () => {
    const prompt = 'Generate a short, concise title BOUNDED', output = 'x'.repeat(33000);
    const f = fixture('overflow', { output, allowlist: { maxOutputBytes: 32768, entries: [{ caseId: 'NONE', purpose: 'title', inputSha256: hash(prompt), inputBytes: Buffer.byteLength(prompt) }] } }), run = start(f);
    run.child.stdin.end(prompt); const result = await run.done; assert.equal(result.stdout.length, 33000);
    const captures = result.receipts.filter(value => value.event === 'auxiliary-output-capture'), last = captures.at(-1);
    assert.equal(last.bytes, 32768); assert.equal(last.overflow, true); assert.equal(last.sha256, hash(output.slice(0,32768)));
    assert.equal(fs.statSync(path.join(f.folder,last.relativePath)).size, 32768);
    assert.equal(result.receipts.filter(value => value.event === 'auxiliary-capture-limit').length, 1);
    assert.equal(result.receipts.find(value => value.event === 'auxiliary-result').stdoutSha256, hash(output));
  });
  await check('unused worker EOF creates neither input authorization nor an output body', async () => {
    const f = fixture('empty-eof'), run = start(f); run.child.stdin.end(); const result = await run.done;
    assert.equal(result.receipts.filter(value => value.event === 'auxiliary-capture-authorization').length, 0);
    assert.deepEqual(fs.readdirSync(f.outputDirectory), []);
  });
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'PASS', checks, realBackendLaunches: 0, editorLaunches: 0, actualInferenceInputs: 0 }, null, 2));
  console.log(JSON.stringify({ directory, status: 'PASS', checks: checks.length }));
})().catch(error => {
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', checks, error: { name: error.name, message: error.message } }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(() => { for (const cwd of temporaryCwds) fs.rmSync(cwd, { recursive: true, force: true }); });
