#!/usr/bin/env node
/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const performanceFile = 'tests/webview/canvasPerfBrowser.test.ts';
const browserPattern = 'tests/webview/*Browser.test.ts';
// This integration suite also launches Chromium; keep it out of the unit phase.
const browserExtras = ['tests/integration/chatInitialStateDelivery.test.ts'];

function getTestPlan(mode) {
  if (mode === 'unit') {
    return { files: [], exclude: [browserPattern, ...browserExtras], maxWorkers: 2 };
  }
  if (mode === 'performance') {
    return { files: [performanceFile], exclude: [], maxWorkers: 1 };
  }
  if (mode === 'browser') {
    const files = fs.readdirSync(path.join(root, 'tests/webview'))
      .filter(name => name.endsWith('Browser.test.ts'))
      .map(name => `tests/webview/${name}`)
      .filter(file => file !== performanceFile);
    files.push(...browserExtras);
    files.sort();
    if (!files.length) { throw new Error('No browser suites found; refusing an empty release phase.'); }
    return { files, exclude: [], maxWorkers: 1 };
  }
  throw new Error('Usage: node scripts/test-release.cjs <unit|browser|performance> [Vitest reporter options]');
}

function main() {
  const [mode, ...extraArgs] = process.argv.slice(2);
  let plan;
  try { plan = getTestPlan(mode); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }

  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const args = [cli, 'run', ...plan.files,
    ...plan.exclude.flatMap(pattern => ['--exclude', pattern]),
    `--maxWorkers=${plan.maxWorkers}`, ...extraArgs];
  console.log(`[release tests] ${mode}: ${plan.maxWorkers} worker(s); Chromium required; no retries.`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, MYSTI_REQUIRE_CHROMIUM: '1' },
  });
  if (result.error) {
    console.error(`[release tests] Could not start Vitest: ${result.error.message}`);
    process.exitCode = 1;
  } else if (result.signal) {
    // Preserve termination instead of turning an interrupted phase into success.
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.status ?? 1;
  }
}

if (require.main === module) { main(); }
module.exports = { getTestPlan };
