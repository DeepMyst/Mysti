/* Controlled harness checks only: disposable Node children, no model/editor launch. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { createForksCli } = require('./forks-cli-fixture.cjs');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PC-10'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'harness-controls-'));
const results = [];
function check(name, action) { action(); results.push({ name, status: 'PASS' }); }
check('The generated ordinary-editor helper parses before any editor launch', () => {
  const source = fs.readFileSync(path.join(repo, 'scripts/validation/prepare-vscode-forks.cjs'), 'utf8');
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
check('Serialized observer captures actual menu owner and ignores unrelated events without business injection', () => {
  const output = ts.transpileModule(fs.readFileSync(path.join(repo, 'tests-vscode/forks-observer.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const callbacks = {}, exp = {};
  const context = { exports: exp, document: { addEventListener: (type, callback) => { callbacks['document:' + type] = callback; } },
    addEventListener: (type, callback) => { callbacks[type] = callback; } };
  vm.runInNewContext(output, context); exp.installForksObserver();
  callbacks.message({ data: { type: 'unrelated-secret', payload: 'must not be recorded' } });
  callbacks.message({ data: { type: 'responseChunk', payload: { type: 'thinking', content: 'private model reasoning' } } });
  const menu = { dataset: { conversationId: 'source', messageId: 'user5', commit: 'checkpoint' } };
  const item = { dataset: { action: 'fork-rewind' }, disabled: false, closest: () => menu };
  callbacks['document:click']({ target: { closest: () => item } });
  const events = JSON.parse(JSON.stringify(context.__pc10Events));
  assert.equal(events.length, 2); assert.equal(events[0].payload.content, undefined);
  assert.deepEqual(events[1].payload, { action: 'fork-rewind', disabled: false, conversationId: 'source', messageId: 'user5', commit: 'checkpoint' });
});
const child = path.join(directory, 'synthetic-protocol-child');
fs.writeFileSync(child, `#!${process.execPath}
const fs=require('fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(process.env.PC10_CONTROLLED_CAPTURE,input);process.stdout.write(process.argv.includes('app-server')?JSON.stringify({result:{thread:{id:'controlled-thread'}}})+'\\n':JSON.stringify({type:'system',subtype:'init',session_id:'controlled-session',model:'controlled-native-model'})+'\\n');});
`, { mode: 0o700 });
const hooks = path.join(directory, 'hooks.json'); fs.writeFileSync(hooks, '{}');
for (const provider of ['claude-code', 'openai-codex']) {
  check(`Transparent ${provider} protocol forwards bytes and counts the native request separately`, () => {
    const own = path.join(directory, provider); fs.mkdirSync(own);
    const wrapper = createForksCli({ directory: own, provider, executable: child, node: process.execPath, hooks, window: 'A', tokens: { issue: 'OWNED_TOKEN' } });
    const prompt = 'PC10_REQUEST:SOURCE_1 OWNED_TOKEN\n\n## Project memory — UNTRUSTED DATA (nonce abc123ef)\nReference notes.\n<<<UNTRUSTED abc123ef\nPC10_REQUEST:MEMORY_ONLY\nabc123ef UNTRUSTED>>>';
    const input = provider === 'claude-code'
      ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'
      : JSON.stringify({ method: 'thread/start', params: { model: 'controlled-model' } }) + '\n' + JSON.stringify({ method: 'turn/start', params: { threadId: 'controlled-thread', input: [{ type: 'text', text: prompt }] } }) + '\n';
    const capture = path.join(own, 'forwarded-input.txt');
    const args = provider === 'claude-code' ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'controlled-model'] : ['app-server'];
    const result = spawnSync(wrapper.launcher, args, { input, env: { ...process.env, PC10_CONTROLLED_CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
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
  const wrapper = createForksCli({ directory: own, provider: 'claude-code', executable: child, node: process.execPath, hooks, window: 'A', tokens: {} });
  const capture = path.join(own, 'forwarded-input.txt'), input = 'Synthetic title control';
  const result = spawnSync(wrapper.launcher, ['--print'], { input, env: { ...process.env, PC10_CONTROLLED_CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(fs.readFileSync(capture, 'utf8'), input);
  const receipts = fs.readFileSync(wrapper.receipts, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(receipts.filter(value => value.event === 'auxiliary-input').length, 1);
  assert.equal(receipts.filter(value => value.event === 'request').length, 0);
});
const evidence = { status: 'PASS_CONTROLLED_HARNESS_CHECKS', results, realModelLaunches: 0, editorLaunches: 0, directory };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
