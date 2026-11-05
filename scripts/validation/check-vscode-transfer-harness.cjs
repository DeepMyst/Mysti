/* Controlled harness checks only: disposable Node children, no model/editor launch. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { createTransferCli } = require('./transfer-cli-fixture.cjs');
const { createHmac } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { verifyClipboardRecovery } = require('./clipboard-recovery-marker.cjs');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PC-11'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'harness-controls-'));
const results = [];
function check(name, action) { action(); results.push({ name, status: 'PASS' }); }
check('The generated ordinary-editor helper parses before any editor launch', () => {
  const source = fs.readFileSync(path.join(repo, 'scripts/validation/prepare-vscode-transfer.cjs'), 'utf8');
  const ast = ts.createSourceFile('prepare.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let template;
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(ast).includes("'extension.cjs'") && ts.isTemplateExpression(node.arguments[1])) template = node.arguments[1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert(template);
  const generated = vm.runInNewContext(template, { manifestFile: '/owned/control/prepared.json', repo });
  new vm.Script(generated);
  assert(!generated.includes('extensionTestsPath=')); assert(generated.includes("vscode.commands.executeCommand('workbench.action.quit')"));
});
check('Serialized observer captures real menu and import notices without business injection', () => {
  const output = ts.transpileModule(fs.readFileSync(path.join(repo, 'tests-vscode/transfer-observer.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const callbacks = {}, exp = {};
  const context = { exports: exp, document: { addEventListener: (type, callback) => { callbacks['document:' + type] = callback; } },
    addEventListener: (type, callback) => { callbacks[type] = callback; } };
  vm.runInNewContext(output, context); exp.installTransferObserver();
  callbacks.message({ data: { type: 'unrelated-secret', payload: 'must not be recorded' } });
  callbacks.message({ data: { type: 'responseChunk', payload: { type: 'thinking', content: 'private model reasoning' } } });
  const item = { id: 'export-json-btn', dataset: { composerAction: undefined, commandId: undefined, messageId: undefined } };
  callbacks['document:click']({ target: { closest: () => item } });
  callbacks.message({ data: { type: 'conversationImportNotice', payload: { conversationId: 'owned-import', notice: 'Historical tools cannot be undone' } } });
  const events = JSON.parse(JSON.stringify(context.__pc11Events));
  assert.equal(events.length, 3); assert.equal(events[0].payload.content, undefined);
  assert.deepEqual(events[1].payload, { id: 'export-json-btn' });
  assert.deepEqual(events[2].payload, { conversationId: 'owned-import', notice: 'Historical tools cannot be undone' });
});
const child = path.join(directory, 'synthetic-protocol-child');
fs.writeFileSync(child, `#!${process.execPath}
const fs=require('fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(process.env.PC11_CONTROLLED_CAPTURE,input);process.stdout.write(process.argv.includes('app-server')?JSON.stringify({result:{thread:{id:'controlled-thread'}}})+'\\n':JSON.stringify({type:'system',subtype:'init',session_id:'controlled-session',model:'controlled-native-model'})+'\\n');});
`, { mode: 0o700 });
const hooks = path.join(directory, 'hooks.json'); fs.writeFileSync(hooks, '{}');
for (const provider of ['claude-code', 'openai-codex']) {
  check(`Transparent ${provider} protocol forwards bytes and counts the native request separately`, () => {
    const own = path.join(directory, provider); fs.mkdirSync(own);
    const wrapper = createTransferCli({ directory: own, provider, executable: child, node: process.execPath, hooks, window: 'A', tokens: { issue: 'OWNED_TOKEN' } });
    const prompt = 'PC11_REQUEST:SOURCE_1 OWNED_TOKEN\n\n## Project memory — UNTRUSTED DATA (nonce abc123ef)\nReference notes.\n<<<UNTRUSTED abc123ef\nPC11_REQUEST:MEMORY_ONLY\nabc123ef UNTRUSTED>>>';
    const input = provider === 'claude-code'
      ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'
      : JSON.stringify({ method: 'thread/start', params: { model: 'controlled-model' } }) + '\n' + JSON.stringify({ method: 'turn/start', params: { threadId: 'controlled-thread', input: [{ type: 'text', text: prompt }] } }) + '\n';
    const capture = path.join(own, 'forwarded-input.txt');
    const args = provider === 'claude-code' ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'controlled-model'] : ['app-server'];
    const result = spawnSync(wrapper.launcher, args, { input, env: { ...process.env, PC11_CONTROLLED_CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0); assert.equal(fs.readFileSync(capture, 'utf8'), input);
    const receipts = fs.readFileSync(wrapper.receipts, 'utf8').trim().split('\n').map(JSON.parse);
    const request = receipts.filter(value => value.event === 'request'); assert.equal(request.length, 1);
    assert.deepEqual(request[0].markers, ['SOURCE_1', 'MEMORY_ONLY']); assert.deepEqual(request[0].contextScopes, ['issue']);
    assert.deepEqual(request[0].markerOrigins, { projectMemoryMarkers: ['MEMORY_ONLY'], outsideProjectMemoryMarkers: ['SOURCE_1'], projectMemoryFences: 1 });
    assert.equal(request[0].model, 'controlled-model'); assert(!receipts.some(value => value.event === 'auxiliary-input'));
    assert(receipts.some(value => value.event === 'session')); assert(receipts.some(value => value.event === 'exit' && value.exitCode === 0));
    assert(!fs.readFileSync(wrapper.receipts, 'utf8').includes('OWNED_TOKEN'));
  });
}
check('Auxiliary Claude input is forwarded but excluded from conversational counts', () => {
  const own = path.join(directory, 'auxiliary'); fs.mkdirSync(own);
  const wrapper = createTransferCli({ directory: own, provider: 'claude-code', executable: child, node: process.execPath, hooks, window: 'A', tokens: {} });
  const capture = path.join(own, 'forwarded-input.txt'), input = 'Synthetic title control';
  const result = spawnSync(wrapper.launcher, ['--print'], { input, env: { ...process.env, PC11_CONTROLLED_CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(fs.readFileSync(capture, 'utf8'), input);
  const receipts = fs.readFileSync(wrapper.receipts, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(receipts.filter(value => value.event === 'auxiliary-input').length, 1);
  assert.equal(receipts.filter(value => value.event === 'request').length, 0);
});
check('Acknowledgement smoke fails closed for inference variants and unknown commands before backend spawn', () => {
  for (const [label, provider, args] of [
    ['claude-conversation', 'claude-code', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json']],
    ['claude-auxiliary', 'claude-code', ['--print']], ['codex-conversation', 'openai-codex', ['app-server']],
    ['codex-exec', 'openai-codex', ['exec', 'do work']], ['claude-short-p', 'claude-code', ['-p', 'do work']],
    ['claude-positional', 'claude-code', ['do work']], ['unknown-command', 'openai-codex', ['future-inference-mode']],
    ['probe-with-extra-argument', 'openai-codex', ['--version', '--print']],
  ]) {
    const own = path.join(directory, label); fs.mkdirSync(own);
    const wrapper = createTransferCli({ directory: own, provider, executable: child, node: process.execPath, hooks, window: 'A', tokens: {}, forbidInference: true });
    const capture = path.join(own, 'must-not-exist.txt');
    const result = spawnSync(wrapper.launcher, args, { input: 'must never reach the synthetic child', env: { ...process.env, PC11_CONTROLLED_CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(fs.existsSync(capture), false);
    const receipts = fs.readFileSync(wrapper.receipts, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(receipts.length, 1); assert.equal(receipts[0].event, 'inference-launch-refused');
  }
});
check('Acknowledgement smoke permits only the exact recorded read-only version probe', () => {
  const own = path.join(directory, 'allowed-version-probe'); fs.mkdirSync(own);
  const wrapper = createTransferCli({ directory: own, provider: 'openai-codex', executable: child, node: process.execPath, hooks, window: 'A', tokens: {}, forbidInference: true });
  const capture = path.join(own, 'empty-probe-input.txt');
  const result = spawnSync(wrapper.launcher, ['--version'], { input: '', env: { ...process.env, PC11_CONTROLLED_CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(fs.readFileSync(capture, 'utf8'), '');
  const receipts = fs.readFileSync(wrapper.receipts, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(receipts.map(value => value.event), ['read-only-probe-start', 'read-only-probe-exit']);
});
check('Only an authenticated live owned clipboard failure can exempt cleanup', () => {
  const secret = 'controlled-secret', window = { id: 'A', profile: '/owned/profile' };
  const body = { status: 'FAIL_RETAINED_CLIPBOARD_RECOVERY', window: 'A', profile: window.profile, extensionHostPid: 101, guardPid: 102, guardStartedAt: 'birth-guard', at: 1000 };
  const sign = value => ({ ...value, signature: createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex') });
  const rows = [{ pid: 101, startedAt: 'birth-host' }, { pid: 102, startedAt: 'birth-guard' }];
  const base = { secret, window, hostPid: 101, rows, identities: new Map(rows.map(value => [`${value.pid}|${value.startedAt}`, value])), launchedAt: 900 };
  assert.deepEqual(verifyClipboardRecovery({ ...base, marker: sign(body) }), body);
  for (const marker of [{ ...sign(body), signature: '0'.repeat(64) }, sign({ ...body, profile: '/different/profile' }), sign({ ...body, window: 'B' }), sign({ ...body, at: 899 }), sign({ ...body, status: 'PASS' })]) {
    assert.equal(verifyClipboardRecovery({ ...base, marker }), false);
  }
  assert.equal(verifyClipboardRecovery({ ...base, marker: sign(body), identities: new Map() }), false);
  assert.equal(verifyClipboardRecovery({ ...base, marker: sign(body), rows: [{ pid: 101, startedAt: 'birth-host' }, { pid: 102, startedAt: 'reused-pid' }] }), false);
  assert.equal(verifyClipboardRecovery({ ...base, marker: sign(body), rows: [rows[1]] }), false);
});
check('Swift clipboard tests use only memory and preserve all flavors with guarded retry', () => {
  const result = spawnSync('swift', [path.join(repo, 'scripts/validation/clipboard-guard.swift'), '--self-test'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0); const evidence = JSON.parse(result.stdout.trim()); assert.equal(evidence.status, 'PASS_CONTROLLED_CLIPBOARD_GUARD');
  assert.equal(evidence.actualClipboardReads, 0); assert.equal(evidence.actualClipboardWrites, 0);
  fs.writeFileSync(path.join(directory, 'clipboard-controls.json'), JSON.stringify(evidence, null, 2));
});
function mockClipboardClient() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null; child.pid = 123;
  const exp = {}, timers = new Map(); let nextTimer = 0;
  const output = ts.transpileModule(fs.readFileSync(path.join(repo, 'tests-vscode/clipboard-guard.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = { exports: exp, require: name => name === 'child_process' ? { spawn: () => child } : require(name),
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, () => { timers.delete(id); callback(); }); return id; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(output, context);
  return { client: new exp.NativeClipboardGuard('/controlled-only.swift'), child, timers,
    reply: value => child.stdout.write(JSON.stringify(value) + '\n') };
}
(async () => {
  const probe = mockClipboardClient(); let firstRejected = false, secondResolved = false;
  const first = probe.client.request({ action: 'capture' }).catch(() => { firstRejected = true; });
  probe.timers.values().next().value(); await first; assert(firstRejected);
  const second = probe.client.request({ action: 'restore' }).then(value => { secondResolved = true; return value; });
  probe.reply({ requestId: '1', ok: true, status: 'LATE_CAPTURE' }); await Promise.resolve(); assert.equal(secondResolved, false);
  probe.reply({ requestId: '2', ok: true, status: 'RESTORED' }); assert.equal((await second).status, 'RESTORED');
  results.push({ name: 'Late clipboard metadata cannot satisfy a later restore command', status: 'PASS' });
  const refusal = probe.client.quit(); probe.reply({ requestId: '3', ok: false, status: 'RESTORE_FAILED' }); await assert.rejects(refusal, /retains its RAM snapshot/);
  assert.equal(probe.child.stdin.writableEnded, false);
  const retry = probe.client.quit(); probe.reply({ requestId: '4', ok: true, restored: true }); probe.child.exitCode = 0; probe.child.emit('exit', 0);
  assert.equal((await retry).restored, true); assert.equal(probe.timers.size, 0);
  results.push({ name: 'Failed quit retains helper input and explicit successful retry clears timers', status: 'PASS' });
  const failed = mockClipboardClient(); failed.child.emit('error', new Error('controlled spawn failure'));
  await assert.rejects(failed.client.request({ action: 'capture' }), /could not start/);
  results.push({ name: 'Spawn failure becomes a terminal error without waiting for metadata', status: 'PASS' });
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), source = fs.readFileSync(path.join(repo, 'tests-vscode/transfer.test.ts'), 'utf8');
    const ast = ts.createSourceFile('transfer.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); let actualFunction;
    function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'ownedCliUri') actualFunction = node.getText(ast); ts.forEachChild(node, visit); }
    visit(ast); assert(actualFunction);
    const code = ts.transpileModule(actualFunction + '\n exports.invoke = ownedCliUri;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const uri = 'vscode://MystiValidation.pc11-transfer-runner/preflight?nonce=controlled', evidence = [], exp = {};
    let fakeDispatches = 0;
    vm.runInNewContext(code, { exports: exp, assert, path, repo, process: { env: {} }, owner: { profile: '/owned/profile', sharedDataDir: '/owned/shared', extensionsDir: '/owned/extensions' },
      lastOwnedUri: undefined, workbench: page, hash: value => require('node:crypto').createHash('sha256').update(value).digest('hex'), record: (event, details) => evidence.push({ event, ...details }),
      vscode: { Uri: { parse: value => ({ authority: 'MystiValidation.pc11-transfer-runner', path: '/preflight', toString: () => value }) }, extensions: { getExtension: () => ({ packageJSON: { name: 'pc11-transfer-runner' } }) } },
      execFileAsync: async (_binary, args) => { assert(args.includes('--user-data-dir=/owned/profile')); assert(args.includes(uri)); fakeDispatches++; } });
    async function fixture(detail, checked) {
      await page.setContent('<div class="monaco-dialog-box" role="dialog"><div class="dialog-message-text"></div><div class="detail"></div><div role="checkbox" aria-checked="false"></div><button>Open</button></div>');
      await page.evaluate(({ detail, checked }) => {
        document.querySelector('.dialog-message-text').textContent = "Allow 'pc11-transfer-runner' extension to open this URI?";
        document.querySelector('.detail').setAttribute('title', detail); document.querySelector('[role="checkbox"]').setAttribute('aria-checked', String(checked));
        document.querySelector('button').addEventListener('click', () => document.querySelector('.monaco-dialog-box').remove());
      }, { detail, checked });
    }
    await fixture(uri, false); await exp.invoke(uri); assert(evidence.some(value => value.event === 'owned-uri-gate-opened' && value.exactDetailMatched && !value.trustCheckboxChecked));
    await fixture('vscode://another.extension/foreign', false); await assert.rejects(exp.invoke(uri), /exact expected synthetic URI/); assert.equal(await page.getByRole('button', { name: 'Open', exact: true }).count(), 1);
    await fixture(uri, true); await assert.rejects(exp.invoke(uri)); assert.equal(await page.getByRole('button', { name: 'Open', exact: true }).count(), 1);
    assert.equal(fakeDispatches, 3);
    results.push({ name: 'Actual URI gate function opens only exact owned URI detail with persistent trust unchecked', status: 'PASS' });
  } finally { await browser.close(); }
  const evidence = { status: 'PASS_CONTROLLED_HARNESS_CHECKS', results, realModelLaunches: 0, editorLaunches: 0, realClipboardReads: 0, realClipboardWrites: 0, directory };
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
})().catch(error => { console.error(error); process.exitCode = 1; });
