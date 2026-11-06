#!/usr/bin/env node
/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function getTestPlan(mode) {
  if (['unit', 'browser', 'performance'].includes(mode)) {
    // The root Vitest projects own file selection, budgets and worker limits.
    // Selecting a project also fails normally when it contains no test files.
    return { project: mode };
  }
  throw new Error('Usage: node scripts/test-release.cjs <unit|browser|performance> [Vitest reporter options]');
}

function main() {
  const [mode, ...extraArgs] = process.argv.slice(2);
  let plan;
  try { plan = getTestPlan(mode); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }

  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const args = [cli, 'run', '--project', plan.project, ...extraArgs];
  console.log(`[release tests] ${mode} project; Chromium required; no retries.`);
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
