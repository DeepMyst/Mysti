/* Owned version-only CLI fixture. First --version stalls past Mysti's deadline;
 * later probes succeed. Never forwards to a real CLI or runs model requests.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path');
exports.run = function run(directory, args) {
  const receipts = path.join(directory, 'probe-receipts.jsonl');
  const record = value => fs.appendFileSync(receipts, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + '\n');
  if (JSON.stringify(args) !== '["--version"]') {
    record({ event: 'rejected-non-version', argumentCount: args.length }); process.exitCode = 3; return;
  }
  let slow = false;
  try { fs.writeFileSync(path.join(directory, 'first-version-owned'), String(process.pid), { flag: 'wx' }); slow = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  record({ event: 'ready', mode: slow ? 'deadline' : 'success' });
  process.on('exit', code => record({ event: 'terminal', code }));
  if (slow) setTimeout(() => process.stdout.write('GitHub Copilot CLI 1.0.83\n'), 15_000);
  else process.stdout.write('GitHub Copilot CLI 1.0.83\n');
};
