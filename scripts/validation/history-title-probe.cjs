/* PC-08: one explicitly authorized title diagnostic in the ordinary editor host. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const DEADLINE_MS = 30000;
const MARKER = 'PC08_TITLE_PROBE';
const MESSAGE = `${MARKER}: Add bounded retries for transient 503 errors in a local HTTP client.`;
const PROMPT = `Generate a short, concise title (3-6 words max) for this chat conversation based on the user's first message. Return ONLY the title, no quotes, no explanation.

User message: "${MESSAGE.substring(0, 500)}"

Title:`;
const digest = value => createHash('sha256').update(value).digest('hex');

// Never persist stderr, credentials, environment values, or arbitrary CLI text.
function classifyDiagnosticText(text) {
  if (!text.trim()) return 'none';
  if (/unknown model|invalid model|model[^\n]{0,90}(?:not found|not available|not supported|does not exist)/i.test(text)) return 'model-unavailable';
  if (/not logged in|authentication (?:failed|required)|invalid api.?key|login required|please (?:log|sign) in|unauthorized|invalid (?:access |refresh )?token/i.test(text)) return 'authentication';
  if (/rate.?limit|too many requests|quota|usage limit/i.test(text)) return 'rate-or-quota';
  if (/unknown option|unknown argument|unexpected argument|invalid argument/i.test(text)) return 'arguments';
  if (/eacces|eperm|permission denied|read.only file system/i.test(text)) return 'filesystem-permission';
  if (/enotfound|econnrefused|econnreset|etimedout|network|certificate|tls|timed? ?out/i.test(text)) return 'network-or-timeout';
  return 'other-diagnostic';
}

function safeControlledTitle(text) {
  // Even stdout is untrusted. Only a short title made from this synthetic
  // task's vocabulary is eligible for plaintext evidence; always retain hash.
  const words = new Set(('add adding bounded retry retries transient 503 error errors local http client for to in a an the with and implement implementing handle handling request requests robust reliable reliability exponential backoff logic policy limit limits').split(' '));
  const title = text.trim().substring(0, 50);
  if (!/^[A-Za-z0-9 ,:.-]{3,50}$/.test(title)) return undefined;
  const tokens = title.toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.length >= 2 && tokens.every(word => words.has(word)) ? title : undefined;
}

exports.runTitleProbe = async function runTitleProbe({ manifest, artifactDir, executable }) {
  assert.equal(manifest.case, 'PC-08');
  assert.equal(process.platform, 'darwin', 'This scoped diagnostic owns a macOS process group only');
  assert.equal(process.env.MYSTI_PC08_STAGE, 'title-probe');
  const root = fs.realpathSync(path.dirname(manifest.diskRunner.helper));
  const destination = path.resolve(artifactDir);
  assert.equal(path.dirname(destination), root);
  assert.equal(path.basename(destination), 'title-probe');
  const hooksPath = path.join(manifest.cliDirectory, 'claude-settings.json');
  assert.equal(fs.realpathSync(path.dirname(hooksPath)), fs.realpathSync(manifest.cliDirectory));
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksPath, 'utf8')), { disableAllHooks: true });
  assert.equal(typeof executable, 'string');
  assert(path.isAbsolute(executable));
  const realExecutable = fs.realpathSync(executable);
  fs.mkdirSync(destination, { recursive: true });
  // A duplicate helper activation must not make another paid request.
  fs.writeFileSync(path.join(destination, 'one-request-reservation.json'), JSON.stringify({ marker: MARKER, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });

  const receiptPath = path.join(destination, 'title-probe-receipts.jsonl');
  const record = data => fs.appendFileSync(receiptPath, JSON.stringify({ at: Date.now(), ...data }) + '\n', { mode: 0o600 });
  const args = ['--print', '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001', '--settings', hooksPath];
  const started = Date.now();
  // No cwd/env options: exactly the ordinary extension host's inherited values.
  const proc = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0;
  let inputAt, firstStdoutAt, firstStderrAt, exitedAt, closedAt;
  let exitCode = null, exitSignal = null, errorCategory, timedOut = false, inputWrites = 0;
  const stdoutHash = createHash('sha256');
  const groupSignals = [];
  const groupAlive = () => {
    if (!proc.pid) return false;
    try { process.kill(-proc.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  const killOwnedGroup = reason => {
    if (!proc.pid) return;
    try { process.kill(-proc.pid, 'SIGKILL'); groupSignals.push({ reason, signal: 'SIGKILL', at: Date.now() }); }
    catch (error) { if (error.code !== 'ESRCH') errorCategory ||= 'group-cleanup-error'; }
  };

  await new Promise(resolve => {
    let settled = false, finalTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(finalTimer);
      resolve();
    };
    const boundClose = () => { finalTimer ||= setTimeout(finish, 1500); };
    proc.stdout.on('data', chunk => {
      firstStdoutAt ??= Date.now(); stdoutBytes += chunk.length; stdoutHash.update(chunk);
      if (stdout.length < 65536) stdout += chunk.toString('utf8').substring(0, 65536 - stdout.length);
    });
    proc.stderr.on('data', chunk => {
      firstStderrAt ??= Date.now(); stderrBytes += chunk.length;
      if (stderr.length < 65536) stderr += chunk.toString('utf8').substring(0, 65536 - stderr.length);
    });
    proc.stdin.on('error', () => { errorCategory ||= 'stdin-error'; killOwnedGroup('stdin-error'); boundClose(); });
    proc.on('error', () => { errorCategory ||= 'spawn-error'; killOwnedGroup('spawn-error'); boundClose(); });
    proc.once('spawn', () => {
      record({ event: 'spawn', childPid: proc.pid });
      try {
        inputAt = Date.now();
        proc.stdin.end(PROMPT);
        inputWrites++;
        record({ event: 'title-input-write', childPid: proc.pid, marker: MARKER, promptSha256: digest(PROMPT), characters: PROMPT.length });
      } catch {
        errorCategory ||= 'stdin-error'; killOwnedGroup('stdin-throw'); boundClose();
      }
    });
    proc.once('exit', (code, signal) => {
      exitedAt = Date.now(); exitCode = code; exitSignal = signal;
      record({ event: 'exit', childPid: proc.pid, exitCode: code, signal });
      clearTimeout(deadline);
      // A completed launcher can still own descendants holding its pipes open.
      killOwnedGroup('leader-exit'); boundClose();
    });
    proc.once('close', () => { closedAt = Date.now(); finish(); });
    const deadline = setTimeout(() => { timedOut = true; killOwnedGroup('deadline'); boundClose(); }, DEADLINE_MS);
  });

  killOwnedGroup('final-cleanup');
  const cleanupDeadline = Date.now() + 1000;
  while (groupAlive() && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  const aliveAfterCleanup = groupAlive();
  const title = safeControlledTitle(stdout);
  const result = {
    case: 'PC-08', marker: MARKER,
    status: timedOut ? 'TIMEOUT' : errorCategory ? 'PROCESS_ERROR' : exitCode !== 0 ? 'CLI_ERROR' : stdout.trim() ? 'SUCCESS' : 'EMPTY_OUTPUT',
    model: 'claude-haiku-4-5-20251001', deadlineMs: DEADLINE_MS,
    actualExecutable: realExecutable, inheritedEnvironmentUnchanged: true, inheritedWorkingDirectorySha256: digest(process.cwd()),
    ownedHooksDisabled: true, extensionHostPid: process.pid, childPid: proc.pid,
    stdinInputWriteCount: inputWrites, promptSha256: digest(PROMPT),
    elapsedMs: Date.now() - started, firstStdoutAfterInputMs: firstStdoutAt && inputAt ? firstStdoutAt - inputAt : null,
    firstStderrAfterInputMs: firstStderrAt && inputAt ? firstStderrAt - inputAt : null,
    exitAfterInputMs: exitedAt && inputAt ? exitedAt - inputAt : null, closeAfterInputMs: closedAt && inputAt ? closedAt - inputAt : null,
    exitCode, exitSignal, timedOut, errorCategory, stdoutBytes, stderrBytes,
    stdoutSha256: stdoutHash.digest('hex'), titleCandidateSha256: stdout.trim() ? digest(stdout.trim().substring(0, 50)) : null,
    controlledTitleText: title, stdoutTextOmitted: title === undefined,
    stderrCategory: classifyDiagnosticText(stderr), stdoutCategory: classifyDiagnosticText(stdout),
    diagnosticCategory: classifyDiagnosticText(stderr + '\n' + stdout),
    cleanup: { ownedProcessGroup: proc.pid, signals: groupSignals, groupAliveAfterCleanup: aliveAfterCleanup },
    limits: ['One diagnostic request, not a latency distribution.', 'Cold spawn in the same host environment; production may consume a warm worker.', 'Input receipt proves one stdin write; it does not independently prove remote request acceptance.', 'Only allowlisted title words can appear in plaintext; stderr and environment values are never retained.']
  };
  fs.writeFileSync(path.join(destination, 'title-probe.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
};
