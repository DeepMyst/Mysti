/* Serial in-editor runner. QUnit's core supports the minimum host's Node 18.17.1. */
const fs = require('node:fs');
const path = require('node:path');
const QUnit = require('qunit');

function discoverTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? discoverTests(file) : entry.name.endsWith('.test.js') ? [file] : [];
  }).sort();
}

async function runFiles(files) {
  if (files.length === 0) { throw new Error('No editor tests found'); }
  QUnit.config.autostart = false;
  QUnit.config.reorder = false;
  QUnit.config.testTimeout = 120_000;
  QUnit.config.failOnZeroTests = true;
  const uncaught = error => QUnit.onUncaughtException(error);
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', uncaught);
  try {
    const completed = new Promise((resolve, reject) => {
      QUnit.on('testEnd', result => {
        console.log(`[Editor test] ${result.status}: ${result.fullName.join(' > ')}`);
        for (const error of result.errors) { console.error(error.stack || error.message); }
      });
      QUnit.on('error', error => console.error('[Editor test error]', error.stack || error.message || error));
      QUnit.on('runEnd', result => {
        const counts = result.testCounts;
        console.log(`[Editor tests] ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.todo} todo; Node ${process.versions.node}`);
        if (result.status !== 'passed' || counts.failed || counts.todo || !counts.passed) {
          reject(new Error(`Editor acceptance failed: ${JSON.stringify(counts)}`));
        } else { resolve(); }
      });
    });
    for (const file of files) { require(file); }
    QUnit.start();
    await completed;
  } finally {
    process.removeListener('uncaughtException', uncaught);
    process.removeListener('unhandledRejection', uncaught);
  }
}

exports.runFiles = runFiles;
exports.run = () => runFiles(discoverTests(path.join(__dirname, '..', 'out-vscode-test')));
