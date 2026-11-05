/* Synthetic PB-02 controls only. The fake Node child never invokes Codex. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createPB02FullCli } = require('./pb02-full-cli-fixture.cjs');
const { exactCommand, patchScope } = require('./codex-stage-oracle.cjs');
const fullOracle = require('./codex-full-oracle.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'full-harness-controls-'));
const checks = [], hash = value => createHash('sha256').update(value).digest('hex');
const backend = path.join(directory, 'fake-backend.cjs');
const outputFile = path.join(directory, 'output-bytes');
fs.writeFileSync(backend, `
const fs = require('fs');
const [capture, output] = process.argv.slice(2);
process.on('SIGTERM', () => process.exit(0));
fs.writeFileSync(capture + '.args', JSON.stringify(process.argv.slice(4)));
let data = Buffer.alloc(0);
process.stdin.on('data', chunk => { data = Buffer.concat([data, chunk]); fs.writeFileSync(capture, data); });
process.stdin.on('end', () => {
  const bytes = fs.readFileSync(output); let offset = 0;
  function write() { if (offset < bytes.length) { process.stdout.write(bytes.subarray(offset, ++offset)); setImmediate(write); } }
  write();
});
`);
const turn = marker => JSON.stringify({ id: 4, method: 'turn/start', params: { threadId: 'owned-thread', effort: 'low', input: [{ type: 'text', text: `PB02_REQUEST:${marker}\nOwned unicode ☃ 👩‍💻` }] } });
function fixture(name, counterFile = path.join(directory, `${name}-counter.json`), maxInputs = 10) {
  const folder = path.join(directory, name); fs.mkdirSync(folder);
  const capture = path.join(folder, 'input');
  const cli = createPB02FullCli({ directory: folder, node: process.execPath, executable: process.execPath, prefixArgs: [backend, capture, outputFile], workspace: folder, counterFile, maxInputs, token: 'PB02_TOKEN' });
  return { ...cli, capture, counterFile, workspace: folder };
}
function run(fixture, args = ['app-server']) {
  const child = spawn(fixture.launcher, args, { stdio: ['pipe', 'pipe', 'pipe'] }), output = [];
  child.stdout.on('data', bytes => output.push(bytes)); child.stderr.resume(); child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic process timed out')); }, 10000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(output), receipts: fs.existsSync(fixture.receipts) ? fs.readFileSync(fixture.receipts, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [] });
    });
  });
  return { child, done };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic receipt timeout');
}
async function check(name, action) { await action(); checks.push({ name, status: 'PASS' }); }

(async () => {
  await check('split UTF8 malformed JSON and final unterminated input retain exact bytes', async () => {
    const output = Buffer.from('null\n{"message":{"content":{"unexpected":true}}}\nordinary ☃ 👩‍💻\n'); fs.writeFileSync(outputFile, output);
    const f = fixture('bytes'), child = run(f), input = Buffer.from('malformed {json}\nnull\n' + turn('BYTES'));
    for (const byte of input) child.child.stdin.write(Buffer.from([byte])); child.child.stdin.end();
    const result = await child.done; assert.equal(result.code, 0); assert.deepEqual(fs.readFileSync(f.capture), input); assert.deepEqual(result.stdout, output);
    assert.equal(result.receipts.filter(value => value.event === 'request').length, 1); assert(!result.receipts.some(value => value.event === 'instrumentation-error'));
  });
  await check('native request turn item approval and result receipts retain exact ownership', async () => {
    const f = fixture('protocol');
    const changes = [{ path: path.join(f.workspace, 'src/retry.cjs'), kind: { type: 'update', movePath: null }, diff: '-old\n+new' }];
    const params = { threadId: 'owned-thread', turnId: 'owned-turn' };
    const item = { id: 'owned-item', type: 'fileChange', changes, status: 'inProgress' };
    const wire = [
      { id: 3, result: { thread: { id: 'owned-thread' }, model: 'gpt-6.1-sol', modelProvider: 'openai', approvalPolicy: 'untrusted', sandbox: { type: 'readOnly', networkAccess: false }, cwd: f.workspace, approvalsReviewer: 'user', reasoningEffort: 'low' } },
      { id: 4, result: { turn: { id: 'owned-turn' } } },
      { method: 'item/started', params: { ...params, item } },
      { id: 77, method: 'item/fileChange/requestApproval', params: { ...params, itemId: item.id, reason: 'Owned patch' } },
      { method: 'item/completed', params: { ...params, item: { ...item, status: 'completed' } } },
      { method: 'item/completed', params: { ...params, item: { id: 'empty-command', type: 'commandExecution', status: 'completed', aggregatedOutput: '', exitCode: 0 } } },
      { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'completed' } } },
    ];
    const bytes = Buffer.from(wire.map(JSON.stringify).join('\n') + '\n'); fs.writeFileSync(outputFile, bytes);
    const input = [{ id: 3, method: 'thread/start', params: { model: 'gpt-6.1-sol', cwd: f.workspace, sandbox: 'read-only', approvalPolicy: 'untrusted', config: { model_reasoning_effort: 'low', mcp_servers: { local: { enabled: false } }, apps: { _default: { enabled: false } } } } }, JSON.parse(turn('PROTOCOL')), { id: 77, result: { decision: 'accept' } }];
    const child = run(f); child.child.stdin.end(input.map(JSON.stringify).join('\n') + '\n'); const result = await child.done;
    assert.equal(result.code, 0); assert.deepEqual(result.stdout, bytes);
    const request = result.receipts.find(value => value.event === 'request'), completed = result.receipts.find(value => value.event === 'turn-completed');
    const session = result.receipts.find(value => value.event === 'session');
    assert.equal(session.actualModel, 'gpt-6.1-sol'); assert.equal(session.modelProvider, 'openai');
    assert.deepEqual(session.returnedPolicy, { approvalPolicy: 'untrusted', sandbox: 'readOnly', networkAccess: false, approvalsReviewer: 'user', ownedCwd: true, reasoningEffort: 'low' });
    assert.equal(request.sessionHash, hash('owned-thread')); assert.equal(completed.turnHash, hash('owned-turn')); assert.equal(completed.inputIndex, request.inputIndex);
    const approval = result.receipts.find(value => value.event === 'approval-request'), decision = result.receipts.find(value => value.event === 'approval-decision');
    assert.equal(approval.nativeRequestIdHash, decision.nativeRequestIdHash); assert.equal(approval.itemIdHash, hash(item.id));
    assert.equal(approval.toolInputSha256, hash(JSON.stringify({ changes, reason: 'Owned patch' })));
    const results = result.receipts.filter(value => value.event === 'tool-result');
    assert.equal(results[0].outputSha256, hash(JSON.stringify(changes))); assert.equal(results[1].outputSha256, hash(''));
  });
  await check('unhandled native action types are reported without recording their content', async () => {
    const f = fixture('unknown-items');
    const rejected = ['webSearch', 'dynamicToolCall', 'collabAgentToolCall', 'imageGeneration', 'unknownFutureAction'];
    const allowed = ['userMessage', 'agentMessage', 'reasoning', 'plan'];
    const wire = [...rejected, ...allowed].map((type, index) => ({ method: 'item/completed', params: { threadId: 'owned-thread', turnId: 'owned-turn', item: { id: String(index), type, content: 'PRIVATE_SYNTHETIC_BODY' } } }));
    const bytes = Buffer.from(wire.map(JSON.stringify).join('\n') + '\n'); fs.writeFileSync(outputFile, bytes);
    const child = run(f); child.child.stdin.end(); const result = await child.done;
    assert.equal(result.code, 0); assert.deepEqual(result.stdout, bytes);
    assert.deepEqual(result.receipts.filter(value => value.event === 'unexpected-tool-item').map(value => value.type), rejected);
    assert(!JSON.stringify(result.receipts).includes('PRIVATE_SYNTHETIC_BODY'));
  });
  await check('cap refusal cannot forward an extra turn or report success when child exits zero', async () => {
    fs.writeFileSync(outputFile, ''); const f = fixture('cap', undefined, 1), child = run(f), first = turn('FIRST') + '\n';
    child.child.stdin.write(first); await waitFor(() => fs.existsSync(f.capture) && fs.readFileSync(f.capture, 'utf8') === first);
    child.child.stdin.write(turn('BLOCKED') + '\n'); const result = await child.done;
    assert.equal(result.code, 1); assert.equal(fs.readFileSync(f.capture, 'utf8'), first); assert.equal(result.receipts.filter(value => value.event === 'input-cap-refusal').length, 1);
  });
  await check('concurrent wrappers share one fail-closed input cap', async () => {
    const counter = path.join(directory, 'shared-counter.json');
    const results = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const f = fixture(`parallel-${index}`, counter, 2), child = run(f); child.child.stdin.end(turn(`PARALLEL_${index}`) + '\n'); return { f, result: await child.done };
    }));
    const forwarded = results.filter(({ f }) => fs.existsSync(f.capture) && fs.readFileSync(f.capture).length);
    assert(forwarded.length > 0 && forwarded.length <= 2); assert.equal(JSON.parse(fs.readFileSync(counter)).forwardedInputs, forwarded.length);
    assert(results.filter(({ result }) => result.code === 0).length <= 2);
  });
  await check('oversized unterminated input is refused without forwarding or a successful wrapper exit', async () => {
    const f = fixture('oversized'), child = run(f);
    await waitFor(() => fs.existsSync(f.capture + '.args'));
    child.child.stdin.write(Buffer.alloc(8 * 1024 * 1024 + 65536, 120));
    const result = await child.done;
    assert.equal(result.code, 1); assert(!fs.existsSync(f.capture));
    assert(result.receipts.some(value => value.event === 'oversized-input-refusal'));
    assert(!fs.existsSync(f.counterFile));
  });
  await check('auxiliary exec input and version discovery are reported separately', async () => {
    const f = fixture('auxiliary'), child = run(f, ['exec', '-']); child.child.stdin.end('Synthetic auxiliary task'); const result = await child.done;
    assert.equal(result.code, 0); assert.equal(result.receipts.filter(value => value.event === 'auxiliary-input').length, 1); assert(!fs.existsSync(f.counterFile));
    const probe = fixture('probe'), launched = run(probe, ['--version']); launched.child.stdin.end(); const observed = await launched.done;
    assert.equal(observed.code, 0); assert(observed.receipts.some(value => value.event === 'probe-start'));
  });
  await check('shell approval accepts only exact literal command bodies and known wrappers', async () => {
    const command = 'node --test test/retry.test.cjs';
    for (const actual of [command, `/bin/zsh -lc '${command}'`, ['/bin/bash', '-c', command]]) assert(exactCommand(actual, command));
    for (const actual of [command + '; touch canary', `echo ${command}`, ['/bin/zsh', '-lc', command, 'extra'], `bash -lc '${command}'`]) assert(!exactCommand(actual, command));
  });
  await check('patch approval confines one exact update and rejects extra files rename delete or lines', async () => {
    const workspace = path.join(directory, 'patch-root');
    const change = { path: path.join(workspace, 'src/retry.cjs'), kind: { type: 'update', movePath: null }, diff: '@@\n-  return Math.min(cap, base * (attempt + 1));\n+  return Math.min(cap, base * 2 ** attempt);\n' };
    assert(patchScope([change], workspace, 'fix'));
    assert(!patchScope([change, change], workspace, 'fix')); assert(!patchScope([{ ...change, path: '../outside.cjs' }], workspace, 'fix'));
    assert(!patchScope([{ ...change, kind: { type: 'delete' } }], workspace, 'fix')); assert(!patchScope([{ ...change, kind: { type: 'update', movePath: '/outside' } }], workspace, 'fix'));
    assert(!patchScope([{ ...change, diff: change.diff + '+execute_unowned_action();\n' }], workspace, 'fix'));
  });
  await check('full revision approval stays in one owned existing source file and tests append only', async () => {
    const workspace = path.join(directory, 'scope');
    const change = { path: path.join(workspace, 'src/retry.cjs'), kind: { type: 'update' }, diff: '-old\n+new\n // Developer unstaged note: preserve' };
    assert(fullOracle.patchScope([change], workspace, 'revision'));
    assert(!fullOracle.patchScope([{ ...change, path: '../outside.cjs' }], workspace, 'revision'));
    assert(!fullOracle.patchScope([{ ...change, diff: '-// Developer unstaged note: preserve\n+removed' }], workspace, 'revision'));
    const tests = { ...change, path: path.join(workspace, 'test/retry.test.cjs'), diff: '@@\n+test("new", () => {});' };
    assert(fullOracle.patchScope([tests], workspace, 'tests'));
    assert(!fullOracle.patchScope([{ ...tests, diff: '-test("original", () => {});\n+test("new", () => {});' }], workspace, 'tests'));
  });
  await check('read-only outcome separates actual denial from no-attempt refusal and rejects ambiguity', async () => {
    const started = { event: 'tool-start', type: 'fileChange', itemIdHash: 'one' };
    const failed = { ...started, event: 'tool-result', status: 'failed' };
    assert.equal(fullOracle.readonlyOutcome({ tools: [started, failed], content: '', permissionRequests: 0 }), 'PASS_NATIVE_TOOL_DENIAL');
    assert.equal(fullOracle.readonlyOutcome({ tools: [], content: 'I cannot edit in Read Only mode.', permissionRequests: 0 }), 'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT');
    for (const evidence of [
      { tools: [started], content: 'I cannot edit in Read Only mode.', permissionRequests: 0 },
      { tools: [{ ...failed, status: 'completed' }], content: '', permissionRequests: 0 },
      { tools: [], content: 'I cannot edit in Read Only mode.', permissionRequests: 1 },
      { tools: [], content: 'All done.', permissionRequests: 0 },
    ]) assert.throws(() => fullOracle.readonlyOutcome(evidence));
  });
  await check('native image receipts hash actual owned bytes and reject an unowned path without reading it', async () => {
    const f = fixture('images'), png = path.join(f.workspace, 'blue.png'), bytes = Buffer.from([137,80,78,71,255,0,1]); fs.writeFileSync(png, bytes);
    const wire = [png, '/unowned-missing-pb02.png'].map((itemPath, index) => ({ method: 'item/completed', params: { threadId: 'owned-thread', turnId: 'owned-turn', item: { id: String(index), type: 'imageView', path: itemPath } } }));
    fs.writeFileSync(outputFile, wire.map(JSON.stringify).join('\n') + '\n');
    const child = run(f); child.child.stdin.end(); const result = await child.done;
    const images = result.receipts.filter(value => value.event === 'image-view');
    assert.equal(images[0].ownedPath, true); assert.equal(images[0].sha256, hash(bytes)); assert.equal(images[0].relativePath, 'blue.png');
    assert.equal(images[1].ownedPath, false); assert.equal(images[1].sha256, undefined);
  });
  await check('full live result and exact bounded persisted output are independently verified', async () => {
    const id = 'owned-result';
    const output = 'a'.repeat(4095) + '😀' + 'native output after the persisted preview';
    const liveTool = { id, output };
    const nativeResult = { itemIdHash: hash(id), outputSha256: hash(output) };
    const persistedTool = { id, output: output.slice(0, 4096), truncated: true };
    const proof = fullOracle.assertToolOutputProjection({ nativeResult, liveTool, persistedTool });
    assert.equal(proof.outputTruncated, true); assert.equal(proof.persistedOutputLength, 4096);
    assert.equal(persistedTool.output.charCodeAt(4095), 0xd83d, 'Contract slices UTF-16, even within a surrogate pair');
    for (const evidence of [
      { nativeResult, liveTool: { ...liveTool, output: output + 'WRONG' }, persistedTool },
      { nativeResult, liveTool, persistedTool: { ...persistedTool, output: 'WRONG' + output.slice(5, 4096) } },
      { nativeResult, liveTool, persistedTool: { id, output: persistedTool.output } },
      { nativeResult, liveTool, persistedTool: { ...persistedTool, truncated: false } },
      { nativeResult: { ...nativeResult, itemIdHash: hash('another-item') }, liveTool, persistedTool },
    ]) assert.throws(() => fullOracle.assertToolOutputProjection(evidence));
    const short = { id, output: 'short result' }, shortNative = { itemIdHash: hash(id), outputSha256: hash(short.output) };
    assert.equal(fullOracle.assertToolOutputProjection({ nativeResult: shortNative, liveTool: short, persistedTool: short }).outputTruncated, false);
    assert.throws(() => fullOracle.assertToolOutputProjection({ nativeResult: shortNative, liveTool: short, persistedTool: { ...short, output: 'short resulX' } }));
    const boundary = { id, output: 'x'.repeat(4096) };
    assert.equal(fullOracle.assertToolOutputProjection({ nativeResult: { itemIdHash: hash(id), outputSha256: hash(boundary.output) }, liveTool: boundary, persistedTool: boundary }).outputTruncated, false);
  });
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'PASS', checks, realBackendLaunches: 0, inferenceInputs: 0, editorLaunches: 0, clipboardAccesses: 0 }, null, 2));
  console.log(JSON.stringify({ directory, status: 'PASS', checks: checks.length }));
})().catch(error => {
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', checks, error: { name: error.name, message: error.message } }, null, 2));
  console.error(error); process.exitCode = 1;
});
