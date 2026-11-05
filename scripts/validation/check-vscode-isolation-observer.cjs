'use strict';
// Runs the exact compiled observer in a disposable browser-like VM; no editor or CLI.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { installIsolationObserver, hasIsolationModelProgress } = require('../../out-vscode-test/isolation-observer.js');
const checks = [];
let listener, clickListener, clock = 100;
const world = vm.createContext({
  addEventListener: (type, fn) => { assert.equal(type, 'message'); listener = fn; },
  document: { addEventListener: (type, fn, capture) => { assert.equal(type, 'click'); assert.equal(capture, true); clickListener = fn; } },
  Date: { now: () => ++clock },
});
vm.runInContext(`(${installIsolationObserver.toString()})()`, world);
const emit = (type, payload) => listener({ data: { type, payload } });
const events = () => JSON.parse(JSON.stringify(world.__pc09Events));
function check(name, test) { test(); checks.push({ name, status: 'PASS' }); }

check('responseStarted is not model progress', () => {
  emit('responseStarted', {}); assert.equal(hasIsolationModelProgress(events(), true), false);
});
check('empty or malformed thinking cannot open overlap barrier', () => {
  for (const content of ['', null, undefined, 42, {}]) emit('responseChunk', { type: 'thinking', content });
  assert.equal(hasIsolationModelProgress(events(), true), false);
});
check('nonempty thinking opens model-progress barrier without retaining thinking text', () => {
  emit('responseChunk', { type: 'thinking', content: 'controlled private thinking' });
  const event = events().at(-1);
  assert.equal(event.payload.contentLength, 'controlled private thinking'.length);
  assert.equal('content' in event.payload, false);
  assert.equal(JSON.stringify(events()).includes('controlled private thinking'), false);
  assert.equal(hasIsolationModelProgress(events(), true), true);
  assert.equal(hasIsolationModelProgress(events(), false), false);
});
check('nonempty text opens both progress modes and retains separate timestamp', () => {
  emit('responseChunk', { type: 'text', content: '' });
  assert.equal(hasIsolationModelProgress(events(), false), false);
  emit('responseChunk', { type: 'text', content: 'PC09_SCOPE:synthetic' });
  assert.equal(hasIsolationModelProgress(events(), false), true);
  const thinking = events().find(event => event.payload.contentLength > 0);
  assert.ok(events().at(-1).at > thinking.at);
  assert.equal(events().at(-1).payload.content, 'PC09_SCOPE:synthetic');
});
check('final-only reply and stopped partial remain available to ownership oracles', () => {
  emit('responseComplete', { message: { id: 'answer', content: 'final answer', provider: 'openai-codex', model: 'controlled-model' } });
  assert.deepEqual(events().at(-1).payload, { id: 'answer', content: 'final answer', provider: 'openai-codex', model: 'controlled-model' });
  emit('requestCancelled', { message: { id: 'partial', content: 'partial answer', provider: 'claude-code', model: 'controlled-model' } });
  assert.equal(events().at(-1).payload.content, 'partial answer');
});
check('invalid fabricated thinking lengths do not satisfy predicate', () => {
  for (const contentLength of [0, -1, '8', null, undefined, NaN, Infinity]) {
    assert.equal(hasIsolationModelProgress([{ type: 'responseChunk', payload: { type: 'thinking', contentLength } }], true), false);
  }
});
check('actual captured Stop click has its own timestamp and ignores unrelated clicks', () => {
  const before = events().length, preparedAt = clock;
  clickListener({ target: { closest: () => null } });
  assert.equal(events().length, before);
  clickListener({ target: { closest: selector => { assert.equal(selector, '#stop-btn'); return {}; } } });
  const clicked = events().at(-1);
  assert.equal(clicked.type, 'stopClicked'); assert.ok(clicked.at > preparedAt);
  emit('requestCancelled', {}); assert.ok(events().at(-1).at > clicked.at);
});

const result = { status: 'PASS', checks, editorLaunches: 0, modelInputs: 0,
  scope: 'Exact serialized observer and model-progress predicate; native overlap and completion are asserted only by the actual journey.' };
const output = path.resolve(__dirname, '../../out-test/feature-tests/PC-09/native-retry-3-observer-checks.json');
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
