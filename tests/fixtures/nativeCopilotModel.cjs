/* Transparent, opt-in real Copilot launcher for an owned native model-selection workspace.
 * Captures protocol metadata, never credentials or model reasoning. No mock replies.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
exports.run = function run(config, args) {
  const { artifacts, workspace, executable, nonce } = config;
  const receiptFile = path.join(artifacts, 'copilot-model-receipts.jsonl');
  const record = value => fs.appendFileSync(receiptFile, JSON.stringify({ at: Date.now(), wrapperPid: process.pid, ...value }) + '\n', { mode: 0o600 });
  const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const hash = value => createHash('sha256').update(value).digest('hex');
  const prompt = flag('-p') || flag('--prompt');
  const inference = typeof prompt === 'string';
  let marker;
  if (inference) {
    marker = [...prompt.matchAll(/COPILOT_MODEL:(EXPLICIT|INVALID|RECOVERY)/g)].at(-1)?.[1];
    const prior = fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    if (!marker || prior.filter(row => row.event === 'request').length >= 3 || path.resolve(process.cwd()) !== workspace) {
      record({ event: 'rejected-request', marker }); process.stderr.write('Native functional request bound rejected.\n'); process.exitCode = 1; return;
    }
    record({ event: 'request', marker, promptSha256: hash(prompt), containsNonce: prompt.includes(nonce),
      markers: [...prompt.matchAll(/COPILOT_MODEL:(EXPLICIT|INVALID|RECOVERY)/g)].map(match => match[1]),
      policy: { model: flag('--model'), outputFormat: flag('--output-format'), effort: flag('--effort'),
        denyTools: args.flatMap((value, index) => value === '--deny-tool' ? [args[index + 1]] : []),
        allowAllTools: args.includes('--allow-all-tools'), nativeResume: args.includes('--resume') } });
  }
  const prefix = inference ? ['--no-auto-update', '--no-custom-instructions', '--disable-builtin-mcps',
    '--no-remote-export', '--disallow-temp-dir', '--available-tools', 'view',
    '--deny-tool', 'shell', '--log-dir', path.join(artifacts, 'cli-logs')] : ['--no-auto-update'];
  const child = spawn(executable, [...prefix, ...args], { env: { ...process.env, COPILOT_AUTO_UPDATE: 'false' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let timer;
  child.once('spawn', () => {
    record({ event: inference ? 'start' : 'probe-start', marker, childPid: child.pid });
    if (inference) timer = setTimeout(() => { record({ event: 'deadline', marker, childPid: child.pid }); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); }, 100000);
  });
  if (inference) {
    const decoder = new StringDecoder('utf8'); let pending = '', discard = false;
    const inspect = line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      const data = value.data || {};
      const actualModel = data.model || data.chosenModel;
      if (typeof actualModel === 'string') record({ event: 'reported-model', marker, source: value.type, model: actualModel });
      if (value.type === 'session.auto_mode_resolved') record({ event: 'model', marker, model: data.chosenModel });
      if (value.type === 'tool.execution_start') record({ event: 'tool-start', marker, name: data.toolName,
        toolCallId: data.toolCallId, ownedFile: typeof data.arguments?.path === 'string' && path.resolve(workspace, data.arguments.path) === path.join(workspace, 'src/retry.cjs') });
      if (value.type === 'tool.execution_complete') record({ event: 'tool-result', marker, toolCallId: data.toolCallId,
        success: data.success, containsNonce: JSON.stringify(data.result || '').includes(nonce) });
      if (['session.error', 'session.shutdown', 'session.usage_checkpoint'].includes(value.type)) record({ event: value.type, marker });
    };
    child.stdout.on('data', chunk => {
      const pieces = decoder.write(chunk).split('\n');
      for (let i = 0; i < pieces.length; i++) {
        if (!discard) { pending += pieces[i]; if (pending.length > 1024 * 1024) { pending = ''; discard = true; } }
        if (i < pieces.length - 1) { if (!discard) inspect(pending); pending = ''; discard = false; }
      }
    });
    child.stdout.on('end', () => { if (!discard && pending) inspect(pending + decoder.end()); });
  }
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.on('error', () => { record({ event: 'spawn-error', marker }); process.exitCode = 1; process.stdin.pause(); });
  child.once('close', (code, signal) => {
    clearTimeout(timer); record({ event: inference ? 'exit' : 'probe-exit', marker, childPid: child.pid, code, signal });
    process.stdin.unpipe(child.stdin); process.stdin.pause(); process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { try { child.kill(signal); } catch { /* Already closed. */ } });
};
