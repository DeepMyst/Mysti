/* Serial in-editor runner. QUnit's core supports the minimum host's Node 18.17.1. */
const fs = require('node:fs');
const path = require('node:path');
const QUnit = require('qunit');
const manifest = require('./editor-test-manifest.cjs');
const identity = fullName => JSON.stringify(fullName);

function discoverTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? discoverTests(file) : entry.name.endsWith('.test.js') ? [file] : [];
  }).sort();
}

function assertUnfiltered() {
  for (const key of ['filter', 'module', 'moduleId', 'testId']) {
    const value = QUnit.config[key];
    if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      throw new Error(`Editor acceptance must not use QUnit.config.${key}`);
    }
  }
}

// Fault fixtures can supply smaller expected identity sets. The editor entry
// always uses the reviewed manifest; skip/focus policies apply to every run.
async function runFiles(files, { expectedTests } = {}) {
  if (files.length === 0) { throw new Error('No editor tests found'); }
  const expected = expectedTests && new Set(expectedTests.map(identity));
  if (expected && (!expected.size || expected.size !== expectedTests.length)) {
    throw new Error('Editor acceptance identities must be nonempty and unique');
  }
  QUnit.config.autostart = false;
  QUnit.config.reorder = false;
  QUnit.config.testTimeout = 120_000;
  QUnit.config.failOnZeroTests = true;
  assertUnfiltered();
  const violations = [];
  const observed = new Set();
  const focusGuards = [[QUnit, 'only'], [QUnit.test, 'only'], [QUnit.module, 'only']].map(([owner, key]) => {
    const original = owner[key];
    owner[key] = () => {
      violations.push('Focused editor acceptance is forbidden');
      throw new Error(violations[violations.length - 1]);
    };
    return () => { owner[key] = original; };
  });
  const uncaught = error => QUnit.onUncaughtException(error);
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', uncaught);
  try {
    const completed = new Promise((resolve, reject) => {
      QUnit.on('testEnd', result => {
        const key = identity(result.fullName);
        if (observed.has(key)) { violations.push(`Duplicate editor case: ${key}`); }
        observed.add(key);
        if (result.status === 'skipped' && (key !== identity(manifest.optionalNativeTest) || process.env.MYSTI_TEST_DESK_NATIVE === '1')) {
          violations.push(`Unexpected skipped editor case: ${key}`);
        }
        console.log(`[Editor test] ${result.status}: ${result.fullName.join(' > ')}`);
        for (const error of result.errors) { console.error(error.stack || error.message); }
      });
      QUnit.on('error', error => console.error('[Editor test error]', error.stack || error.message || error));
      QUnit.on('runEnd', result => {
        const counts = result.testCounts;
        console.log(`[Editor tests] ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.todo} todo; Node ${process.versions.node}`);
        try { assertUnfiltered(); } catch (error) { violations.push(error.message); }
        if (expected) {
          for (const key of expected) { if (!observed.has(key)) { violations.push(`Missing editor case: ${key}`); } }
          for (const key of observed) { if (!expected.has(key)) { violations.push(`Unexpected editor case: ${key}`); } }
        }
        if (result.status !== 'passed' || counts.failed || counts.todo || !counts.passed || violations.length) {
          reject(new Error(`Editor acceptance failed: ${JSON.stringify(counts)}${violations.length ? '\n' + violations.join('\n') : ''}`));
        } else { resolve(); }
      });
    });
    for (const file of files) { require(file); }
    assertUnfiltered();
    QUnit.start();
    await completed;
  } finally {
    process.removeListener('uncaughtException', uncaught);
    process.removeListener('unhandledRejection', uncaught);
    for (const restore of focusGuards) { restore(); }
  }
}

exports.runFiles = runFiles;
exports.run = () => runFiles(discoverTests(path.join(__dirname, '..', 'out-vscode-test')), { expectedTests: manifest.expectedTests });
