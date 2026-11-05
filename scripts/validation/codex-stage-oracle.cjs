/* Exact PB-02 stage-one native command/patch approval constraints. */
'use strict';
const path = require('node:path');
exports.exactCommand = (actual, expected) => {
  if (actual === expected) return true;
  const shells = ['/bin/zsh', '/bin/bash', '/bin/sh'];
  if (Array.isArray(actual)) return actual.length === 3 && shells.includes(actual[0]) && ['-lc', '-c'].includes(actual[1]) && actual[2] === expected;
  return shells.some(shell => ['-lc', '-c'].some(flag => actual === `${shell} ${flag} '${expected}'` || actual === `${shell} ${flag} "${expected}"`));
};
exports.patchScope = (changes, workspace, purpose) => {
  if (!Array.isArray(changes) || changes.length !== 1) return false;
  const change = changes[0], expected = purpose === 'fix' ? 'src/retry.cjs' : 'canaries/approval.txt';
  if (typeof change.path !== 'string' || path.resolve(workspace, change.path) !== path.join(workspace, expected) || change.kind?.type !== 'update' || change.kind.move_path || change.kind.movePath || typeof change.diff !== 'string') return false;
  const removed = change.diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).map(line => line.slice(1).trim());
  const added = change.diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1).trim());
  if (removed.length !== 1 || added.length !== 1) return false;
  if (purpose === 'deny') return removed[0].endsWith(': KEEP_THIS_CANARY_UNCHANGED') && added[0] === removed[0].replace('KEEP_THIS_CANARY_UNCHANGED', 'REQUESTED_CHANGE');
  return removed[0] === 'return Math.min(cap, base * (attempt + 1));'
    && /^return Math\.min\(cap,\s*base\s*\*\s*(?:2\s*\*\*\s*attempt|\(2\s*\*\*\s*attempt\))\);$/.test(added[0]);
};
