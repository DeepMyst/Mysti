/* One characterized seeded failure; never a general permission to ignore lint. */
'use strict';
const assert = require('node:assert/strict');
const base = require('./codex-f2-scoped-campaign.cjs');
const DIAGNOSTICS = Object.freeze([
  Object.freeze({ file: 'server/api/controllers/cards/delete.js', line: 47 }),
  Object.freeze({ file: 'server/api/controllers/users/update.js', line: 60 }),
  Object.freeze({ file: 'server/api/helpers/utils/send-webhooks.js', line: 172 }),
]);
function expectedSeededLintOutput(workspace) {
  const header = "\n> planka@1.26.3 server:lint\n> npm run lint --prefix server\n\n\n> lint\n> eslint . --max-warnings=0 --report-unused-disable-directives && echo '✔  Your .js files look good.'\n\n\n";
  return header + DIAGNOSTICS.map(({ file, line }) => `${workspace}/${file}\n  ${line}:1  error  Delete \`⏎\`  prettier/prettier\n\n`).join('')
    + '✖ 3 problems (3 errors, 0 warnings)\n  3 errors and 0 warnings potentially fixable with the `--fix` option.\n\n';
}
function assertCommandResult({ step, command, result, output, workspace }) {
  // Derive the exact command independently of the caller's mutable step object.
  const expected = base.buildSteps(workspace)[20];
  const seededLint = step.ordinal === 21 && step.marker === expected.marker
    && base.exactCommand(command, expected.commands[1]);
  if (seededLint) {
    assert.equal(step.expectedNonzero, undefined, 'No step-wide nonzero exception');
    assert.equal(result.status, 'failed', 'Known seeded lint has native failed status');
    assert.equal(result.exitCode, 1, 'Known seeded lint has exit one');
    assert.equal(output, expectedSeededLintOutput(workspace), 'Only the three exact seeded lint diagnostics are expected');
    return 'EXPECTED_SEEDED_LINT_FAILURE';
  }
  if (step.expectedNonzero) {
    assert.equal(step.ordinal, 6); assert.equal(step.marker, base.buildSteps(workspace)[5].marker);
    assert(base.exactCommand(command, base.buildSteps(workspace)[5].commands[0]));
    assert(['completed', 'failed'].includes(result.status));
    assert(Number.isInteger(result.exitCode) && result.exitCode !== 0);
    base.assertMissingScript(output);
    return 'EXPECTED_INJECTED_MISSING_SCRIPT';
  }
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
  return 'SUCCESS';
}
module.exports = { DIAGNOSTICS, expectedSeededLintOutput, assertCommandResult };
