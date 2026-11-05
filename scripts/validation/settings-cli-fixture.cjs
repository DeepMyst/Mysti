/* PC-04: observe selected request settings without recording conversation data. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Transparent Codex stdio/argv/env passthrough with a strict receipt schema. */
function createSettingsCliFixture(directory, executable, nodePath) {
  if (![directory, executable, nodePath].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('Settings fixture paths must be absolute');
  }
  fs.mkdirSync(directory, { recursive: true });
  const wrapperPath = path.join(directory, 'codex-settings-fixture');
  const receiptsPath = path.join(directory, 'settings-receipts.jsonl');
  const source = `#!${nodePath}\n'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const args = process.argv.slice(2);
const child = spawn(${JSON.stringify(executable)}, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const methods = new Set(['thread/start', 'thread/resume', 'turn/start']);
const efforts = new Set(['low', 'medium', 'high', 'xhigh']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(value);
const profileIndex = args.findIndex(arg => arg === '--profile' || arg === '-p');
const profile = profileIndex >= 0 && identifier(args[profileIndex + 1]) ? args[profileIndex + 1] : undefined;
const decoder = new StringDecoder('utf8');
let pending = '', discarding = false;
function capture(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || !methods.has(request.method) || !request.params || typeof request.params !== 'object') return;
  const params = request.params;
  const receipt = { method: request.method };
  if (identifier(params.model)) receipt.model = params.model;
  const effort = request.method === 'turn/start' ? params.effort : params.config && params.config.model_reasoning_effort;
  if (efforts.has(effort)) receipt.effort = effort;
  if (profile) receipt.profile = profile;
  // Never persist input, prompt, request/thread IDs, cwd, argv, environment,
  // protocol responses, or unknown fields. Recording never rewrites input.
  try { fs.appendFileSync(${JSON.stringify(receiptsPath)}, JSON.stringify(receipt) + '\\n', { mode: 0o600 }); }
  catch { process.stderr.write('PC04 receipt could not be written.\\n'); }
}
process.stdin.on('data', chunk => {
  const pieces = decoder.write(chunk).split('\\n');
  for (let i = 0; i < pieces.length; i++) {
    if (!discarding) {
      if (pending.length + pieces[i].length > 1024 * 1024) { pending = ''; discarding = true; }
      else pending += pieces[i];
    }
    if (i < pieces.length - 1) {
      if (!discarding) capture(pending);
      pending = ''; discarding = false;
    }
  }
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.on('error', () => { process.stderr.write('PC04 selected CLI could not start.\\n'); process.exitCode = 1; process.stdin.pause(); });
child.on('close', (code, signal) => {
  process.stdin.unpipe(child.stdin); process.stdin.pause();
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = code ?? 1;
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
`;
  fs.writeFileSync(wrapperPath, source, { mode: 0o700 });
  fs.chmodSync(wrapperPath, 0o700);
  return { path: wrapperPath, receiptsPath };
}

module.exports = { createSettingsCliFixture };
