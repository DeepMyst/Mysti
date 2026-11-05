/* Actual new wrapper, synthetic backend only. No native CLI or model launches. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const { createOwnedProfiles, cleanupOwnedProfiles } = require('./codex-profile-validation-contract.cjs');
const { createPB02ProfileCompatibilityCli } = require('./pb02-profile-compatibility-cli-fixture.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'profile-compatibility-wrapper-controls-'));
const codeHome = path.join(directory, 'synthetic-home'); fs.mkdirSync(codeHome);
const artifacts = path.join(directory, 'profile-files'); fs.mkdirSync(artifacts);
const profileValidation = createOwnedProfiles({ artifactDir: artifacts, controlHome: codeHome });
const hash = value => createHash('sha256').update(value).digest('hex'), checks = [];
const backend = path.join(directory, 'fake-backend.cjs');
fs.writeFileSync(backend, `
const fs = require('fs');
const [capture, output, exitCode, stderrFile] = process.argv.slice(2);
fs.writeFileSync(capture + '.args', JSON.stringify(process.argv.slice(6)));
process.on('SIGTERM', () => process.exit(0));
let input = Buffer.alloc(0);
process.stdin.on('data', bytes => { input = Buffer.concat([input, bytes]); fs.writeFileSync(capture, input); });
process.stdin.on('end', () => {
 const bytes = fs.readFileSync(output); let offset = 0;
 function send() { if (offset < bytes.length) { process.stdout.write(bytes.subarray(offset, ++offset)); setImmediate(send); } else process.exitCode = Number(exitCode); }
 const errors = fs.readFileSync(stderrFile); let errorOffset = 0;
 function sendError() { if (errorOffset < errors.length) { process.stderr.write(errors.subarray(errorOffset, ++errorOffset)); setImmediate(sendError); } }
 send(); sendError();
});
`);
function fixture(name, exitCode = 0) {
  const folder = path.join(directory, name); fs.mkdirSync(folder);
  const capture = path.join(folder, 'input'), output = path.join(folder, 'output'); fs.writeFileSync(output, '');
  const counterFile = path.join(folder, 'counter.json'), stderr = path.join(folder, 'stderr'); fs.writeFileSync(stderr, '');
  return { ...createPB02ProfileCompatibilityCli({ directory: folder, executable: process.execPath, prefixArgs: [backend, capture, output, String(exitCode), stderr],
    node: process.execPath, workspace: folder, counterFile, token: 'OWNED', maxInputs: 3, profileValidation }), capture, output, counterFile, stderr };
}
function run(f, args) {
  const child = spawn(f.launcher, args, { stdio: ['pipe', 'pipe', 'pipe'] }), output = [], errors = [];
  child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes)); child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Synthetic timeout')); }, 10000);
    child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output: Buffer.concat(output), stderr: Buffer.concat(errors),
      receipts: fs.readFileSync(f.receipts, 'utf8').split('\n').filter(Boolean).map(JSON.parse) }); });
  });
  return { child, done };
}
async function check(name, fn) { await fn(); checks.push({ name, status: 'PASS' }); }
async function until(predicate) { const until = Date.now() + 3000; while (!predicate()) { assert(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10)); } }
(async () => {
  for (const label of ['A']) await check(`Profile${label} exact argv/config whitelist/RPC IDs and byte transparency`, async () => {
    const profile = profileValidation.profiles[label], f = fixture(label), args = ['--profile', profile.name, 'app-server'];
    const input = [{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'config/read', params: { includeLayers: false } }];
    const wire = [{ id: 1, result: {} }, { id: 2, result: { config: { model: 'gpt-5.6-sol', model_reasoning_effort: 'low', model_context_window: profile.contextWindow,
      api_key: 'SYNTHETIC_PRIVATE_SECRET', unknown: 'SYNTHETIC_PRIVATE_SECRET' } } }];
    const bytes = Buffer.from(wire.map(JSON.stringify).join('\n') + '\nordinary مرحبا • café • € • 😀\n'); fs.writeFileSync(f.output, bytes);
    const launched = run(f, args), sent = Buffer.from(input.map(JSON.stringify).join('\n') + '\n');
    for (const byte of sent) launched.child.stdin.write(Buffer.from([byte])); launched.child.stdin.end();
    const result = await launched.done; assert.equal(result.code, 0); assert.deepEqual(result.output, bytes); assert.deepEqual(fs.readFileSync(f.capture), sent);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.capture + '.args')), args);
    const invocation = result.receipts.find(value => value.event === 'invocation'); assert.deepEqual(invocation.args, args);
    assert.equal(invocation.selectedProfile, profile.name); assert.equal(invocation.profileOwnedPath, profile.path); assert.equal(invocation.profileFileSha256, profile.sha256);
    assert.equal(invocation.codeHomeMatches, false, 'Synthetic home differs from untouched real account home');
    const requests = result.receipts.filter(value => value.event === 'rpc-request'); assert.deepEqual(requests.map(value => value.method), ['initialize', 'config/read']);
    const config = result.receipts.find(value => value.event === 'profile-config');
    assert.equal(config.rpcIdHash, hash(JSON.stringify(2))); assert.equal(config.rpcIdHash, requests[1].rpcIdHash); assert.equal(config.selectedProfile, profile.name);
    assert.equal(config.model, 'gpt-5.6-sol'); assert.equal(config.reasoningEffort, 'low'); assert.equal(config.contextWindow, profile.contextWindow);
    assert.equal(result.receipts.find(value => value.event === 'rpc-result' && value.method === 'config/read').success, true);
    assert(!JSON.stringify(result.receipts).includes('SYNTHETIC_PRIVATE_SECRET')); assert(!fs.existsSync(f.counterFile));
  });
  await check('Exact missing profile records missing path/null hash and native startup failure without a turn', async () => {
    const f = fixture('missing', 1), missing = profileValidation.missing, launched = run(f, ['--profile', missing.name, 'app-server']);
    launched.child.stdin.end(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\n'); const result = await launched.done;
    assert.equal(result.code, 1); const invocation = result.receipts.find(value => value.event === 'invocation');
    assert.equal(invocation.selectedProfile, missing.name); assert.equal(invocation.profileOwnedPath, missing.path); assert.equal(invocation.profileFileSha256, null);
    assert.deepEqual(invocation.args, ['--profile', missing.name, 'app-server']); assert(!fs.existsSync(f.counterFile));
    assert.equal(result.receipts.find(value => value.event === 'exit').exitCode, 1);
    assert(!result.receipts.some(value => ['session', 'request', 'profile-config'].includes(value.event)));
  });
  await check('Unknown or padded name is not normalized/injected by observation wrapper', async () => {
    const f = fixture('unmodified'), args = ['--profile', `  ${profileValidation.profiles.A.name}  `, 'app-server'], launched = run(f, args);
    launched.child.stdin.end(); const result = await launched.done;
    assert.deepEqual(JSON.parse(fs.readFileSync(f.capture + '.args')), args); const invocation = result.receipts.find(value => value.event === 'invocation');
    assert.equal(invocation.selectedProfile, args[1]); assert.equal(invocation.profileOwnedPath, undefined); assert.equal(invocation.profileFileSha256, null);
    assert(!fs.existsSync(f.counterFile));
  });
  await check('Three input cap refuses the fourth before forwarding', async () => {
    const f = fixture('cap'), launched = run(f, ['--profile', profileValidation.profiles.A.name, 'app-server']);
    const turn = index => JSON.stringify({ id: index, method: 'turn/start', params: { threadId: 'owned', effort: 'low', input: [{ type: 'text', text: `PB02_REQUEST:CAP_${index}` }] } }) + '\n';
    const allowed = [1, 2, 3].map(turn).join(''); launched.child.stdin.write(allowed);
    await until(() => fs.existsSync(f.capture) && fs.readFileSync(f.capture, 'utf8') === allowed);
    launched.child.stdin.write(turn(4)); const result = await launched.done;
    assert.equal(result.code, 1); assert.equal(fs.readFileSync(f.capture, 'utf8'), allowed); assert.deepEqual(JSON.parse(fs.readFileSync(f.counterFile)), { forwardedInputs: 3, maxInputs: 3 });
    assert.equal(result.receipts.filter(value => value.event === 'request').length, 3); assert(result.receipts.some(value => value.event === 'input-cap-refusal'));
  });
  await check('Default argv is unmodified and carries no owned-profile attribution', async () => {
    const f = fixture('default'), launched = run(f, ['app-server']); launched.child.stdin.end(); const result = await launched.done;
    assert.deepEqual(JSON.parse(fs.readFileSync(f.capture + '.args')), ['app-server']);
    const invocation = result.receipts.find(value => value.event === 'invocation'); assert.equal(invocation.selectedProfile, undefined); assert.equal(invocation.profileOwnedPath, undefined); assert.equal(invocation.profileFileSha256, null);
    const summary = result.receipts.find(value => value.event === 'stderr-summary'); assert.equal(summary.bytes, 0); assert.equal(summary.sha256, hash(Buffer.alloc(0))); assert.equal(summary.runtimeOnlyProfileArgument, false);
    assert(result.receipts.indexOf(summary) < result.receipts.findIndex(value => value.event === 'exit'));
  });
  await check('Exact native unsupported signature split at every byte is hashed and forwarded unchanged', async () => {
    const f = fixture('split-diagnostic', 1), bytes = Buffer.from('Error: --profile only applies to runtime commands and `codex mcp`: SYNTHETIC_PRIVATE_DIAGNOSTIC مرحبا • café • € • 😀\n');
    fs.writeFileSync(f.stderr, bytes); const launched = run(f, ['--profile', profileValidation.profiles.A.name, 'app-server']);
    launched.child.stdin.end(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\n'); const result = await launched.done;
    assert.equal(result.code, 1); assert.deepEqual(result.stderr, bytes); const summaries = result.receipts.filter(value => value.event === 'stderr-summary'); assert.equal(summaries.length, 1);
    assert.equal(summaries[0].bytes, bytes.length); assert.equal(summaries[0].sha256, hash(bytes)); assert.equal(summaries[0].runtimeOnlyProfileArgument, true);
    assert(result.receipts.indexOf(summaries[0]) < result.receipts.findIndex(value => value.event === 'exit'));
    assert(!JSON.stringify(result.receipts).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC')); assert(!fs.existsSync(f.counterFile));
  });
  await check('Similar unsupported wording never matches the exact native diagnostic signature', async () => {
    const f = fixture('mismatched-diagnostic', 1), bytes = Buffer.from('Error: --profile only applies to runtime commands and codex mcp:\n');
    fs.writeFileSync(f.stderr, bytes); const launched = run(f, ['--profile', profileValidation.profiles.A.name, 'app-server']); launched.child.stdin.end();
    const result = await launched.done, summary = result.receipts.find(value => value.event === 'stderr-summary');
    assert.equal(summary.runtimeOnlyProfileArgument, false); assert.equal(summary.sha256, hash(bytes)); assert.equal(summary.bytes, bytes.length); assert.deepEqual(result.stderr, bytes);
  });
  cleanupOwnedProfiles(profileValidation);
  const result = { status: 'PASS', checks, realProviderInputs: 0, nativeCLILaunches: 0, editorLaunches: 0, directory };
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
})().catch(error => { fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', checks, error: { name: error.name, message: error.message } }, null, 2), { flag: 'wx' }); console.error(error); process.exitCode = 1; });
