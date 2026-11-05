/* Future PB-02 text-only Claude accounting. No prompt/output bodies are retained. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const EXPECTED_ARGS = Object.freeze([
  '--print', '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001',
  '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
  '--safe-mode', '--no-chrome', '--no-session-persistence',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function classifyPrefix(prefix) {
  if (prefix.startsWith('Generate a short, concise title ')) return 'title';
  if (prefix.startsWith('Analyze this AI response and classify its interactive elements.')) return 'classification';
  if (prefix.startsWith('Given this AI response, suggest 6 follow-up actions as JSON array.')) return 'suggestion';
  return 'unknown';
}
function classifyDiagnostic(text) {
  if (/(?:unknown|unrecognized|unsupported|invalid)\s+(?:command.line\s+)?(?:option|flag)|unexpected argument|too many arguments/i.test(text)) return 'REJECTED_ARGUMENTS';
  if (/usage limit|rate[ -]?limit|(?:hit|exceeded|exhausted).{0,40}(?:quota|limit)|too many requests|resets? (?:at|in)\b/i.test(text)) return 'QUOTA_OR_RATE_LIMIT';
  if (/not (?:logged|signed) in|authentication (?:failed|required|error)|invalid (?:api key|authentication)|unauthorized|please (?:log|sign) in|login required/i.test(text)) return 'AUTHENTICATION';
  return 'UNKNOWN_OR_NONE';
}
function verifyInvocation(args, cwd, env) {
  const realCwd = fs.realpathSync(cwd);
  if (args.length === 1 && args[0] === '--version') {
    return { probe: true, cwd: realCwd };
  }
  assert.deepEqual(args, EXPECTED_ARGS, 'worker-argv');
  assert.equal(path.dirname(realCwd), fs.realpathSync(os.tmpdir()), 'worker-temp-parent');
  assert(/^mysti-text-worker-[A-Za-z0-9]+$/.test(path.basename(realCwd)), 'worker-temp-name');
  assert.equal(fs.statSync(realCwd).mode & 0o777, 0o700, 'worker-temp-mode');
  assert.equal(fs.statSync(realCwd).uid, process.getuid(), 'worker-temp-owner');
  assert.equal(fs.readdirSync(realCwd).length, 0, 'worker-temp-empty');
  assert.equal(fs.realpathSync(env.PWD), realCwd, 'worker-pwd');
  assert.equal(env.CLAUDE_CODE_SAFE_MODE, '1', 'worker-safe-mode');
  return { probe: false, cwd: realCwd };
}

function run(config) {
  const args = process.argv.slice(2);
  const { executable, prefixArgs = [], receiptFile, counterFile, maxInputs } = config;
  const record = value => fs.appendFileSync(receiptFile, JSON.stringify({
    window: 'A', provider: 'claude-code', lane: 'text-only-auxiliary', at: Date.now(), wrapperPid: process.pid, ...value,
  }) + '\n', { mode: 0o600 });
  let invocation;
  try {
    invocation = verifyInvocation(args, process.cwd(), process.env);
    assert(Number.isSafeInteger(maxInputs) && maxInputs > 0);
    assert.equal(fs.realpathSync(executable), executable, 'pinned-real-executable');
  } catch {
    record({ event: 'auxiliary-invocation-refusal', argsSha256: digest(JSON.stringify(args)), cwdSha256: digest(process.cwd()) });
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  function claimInput() {
    let lock;
    const deadline = Date.now() + 2000;
    while (lock === undefined) {
      try { lock = fs.openSync(counterFile + '.lock', 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      const prior = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, 'utf8')) : { forwardedInputs: 0, maxInputs };
      assert.equal(prior.maxInputs, maxInputs);
      assert(Number.isInteger(prior.forwardedInputs) && prior.forwardedInputs >= 0 && prior.forwardedInputs < maxInputs, 'auxiliary-input-cap');
      const next = prior.forwardedInputs + 1;
      const temporary = `${counterFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ forwardedInputs: next, maxInputs }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, counterFile);
      return next;
    } finally { fs.closeSync(lock); fs.unlinkSync(counterFile + '.lock'); }
  }
  const child = spawn(executable, [...prefixArgs, ...args], {
    cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let refused = false, inputIndex, inputBytes = 0, inputEnded = false, prefix = Buffer.alloc(0);
  let stdoutBytes = 0, stderrBytes = 0;
  const diagnostic = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const retainDiagnostic = (stream, bytes) => {
    // Fixed-size RAM only. Never serialize these bytes, even on errors.
    if (diagnostic[stream].length < 8192) diagnostic[stream] = Buffer.concat([diagnostic[stream], bytes.subarray(0, 8192 - diagnostic[stream].length)]);
  };
  const inputHash = createHash('sha256'), stdoutHash = createHash('sha256'), stderrHash = createHash('sha256');
  const metadata = () => ({ inputIndex, inputBytes, inputEnded, inputSha256: inputHash.copy().digest('hex'),
    purpose: inputBytes ? classifyPrefix(prefix.toString('utf8')) : 'no-input' });
  const refuse = event => {
    record({ event, maxInputs }); refused = true; process.stdin.pause(); child.kill('SIGTERM');
  };
  process.stdin.on('data', bytes => {
    if (refused || !bytes.length) return;
    if (invocation.probe) { refuse('auxiliary-probe-input-refusal'); return; }
    if (inputIndex === undefined) {
      try { inputIndex = claimInput(); }
      catch { refuse('auxiliary-input-cap-refusal'); return; }
      // Reservation and this durable receipt precede the very first child write.
      record({ event: 'auxiliary-input', inputIndex });
    }
    inputBytes += bytes.length; inputHash.update(bytes);
    if (prefix.length < 256) prefix = Buffer.concat([prefix, bytes.subarray(0, 256 - prefix.length)]);
    record({ event: 'auxiliary-input-progress', ...metadata() });
    if (!child.stdin.write(bytes)) { process.stdin.pause(); child.stdin.once('drain', () => { if (!refused) process.stdin.resume(); }); }
  });
  process.stdin.on('end', () => {
    inputEnded = true;
    record({ event: 'auxiliary-submission', ...metadata() });
    child.stdin.end();
  });
  child.stdout.on('data', bytes => {
    stdoutBytes += bytes.length; stdoutHash.update(bytes);
    retainDiagnostic('stdout', bytes);
    record({ event: 'auxiliary-output-progress', stream: 'stdout', bytes: stdoutBytes, sha256: stdoutHash.copy().digest('hex'), inputIndex });
  });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; stderrHash.update(bytes); retainDiagnostic('stderr', bytes); });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.on('spawn', () => {
    let processBirths = [];
    try {
      processBirths = execFileSync('/bin/ps', ['-p', `${process.pid},${child.pid}`, '-o', 'pid=,lstart='], { encoding: 'utf8', timeout: 2000 })
        .trim().split('\n').filter(Boolean).map(line => {
          const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match);
          return { pid: +match[1], startedAt: match[2] };
        });
    } catch { record({ event: 'auxiliary-birth-observation-error' }); }
    let pwdMatchesCwd = false;
    try { pwdMatchesCwd = fs.realpathSync(process.env.PWD) === invocation.cwd; } catch { /* Probes need no PWD. */ }
    record({ event: invocation.probe ? 'probe-start' : 'auxiliary-start', childPid: child.pid,
      executable, args, cwd: invocation.cwd, isolatedCwd: !invocation.probe, processBirths,
      childStartedAt: processBirths.find(value => value.pid === child.pid)?.startedAt,
      ...(!invocation.probe ? { cwdMode: 0o700, cwdInitiallyEmpty: true } : {}),
      environmentForwardedUnchanged: true,
      safeModeEnvironment: process.env.CLAUDE_CODE_SAFE_MODE === '1', pwdMatchesCwd });
  });
  child.on('error', () => { record({ event: 'auxiliary-launch-error' }); process.exitCode = 1; process.stdin.destroy(); });
  child.on('close', (exitCode, signal) => {
    const output = { stdoutBytes, stderrBytes, stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex') };
    if (!invocation.probe) record({ event: 'auxiliary-result', childPid: child.pid, ...metadata(), ...output, exitCode, signal,
      diagnosticClassification: classifyDiagnostic(diagnostic.stdout.toString('utf8') + '\n' + diagnostic.stderr.toString('utf8')),
      diagnosticEvidence: 'FIRST_8192_BYTES_PER_STREAM_PATTERN_ONLY',
      outcome: refused ? 'WRAPPER_REFUSED' : !inputBytes ? 'NO_INPUT_WORKER_EXIT' : signal || exitCode !== 0 ? 'TRANSPORT_FAILED' : stdoutBytes ? 'TEXT_RETURNED_UNVALIDATED' : 'EMPTY_TEXT',
      semanticSuccess: 'NOT_INFERRED_FROM_TRANSPORT' });
    record({ event: invocation.probe ? 'probe-exit' : 'exit', childPid: child.pid, exitCode, signal, ...output, inputIndex });
    process.stdin.destroy();
    if (refused) process.exitCode = 1;
    else if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exitCode = exitCode ?? 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
module.exports = { run, EXPECTED_ARGS, classifyPrefix, classifyDiagnostic, verifyInvocation };
