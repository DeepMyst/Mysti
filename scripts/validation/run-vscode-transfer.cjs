/* PC-11 ordinary editor, owned profiles, exact-process cleanup evidence. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { verifyClipboardRecovery } = require('./clipboard-recovery-marker.cjs');
const repo = path.resolve(__dirname, '../..');
const artifactDir = path.resolve(process.env.MYSTI_PC11_ARTIFACT_DIR);
assert(artifactDir.startsWith(path.join(repo, 'out-test/feature-tests/PC-11') + path.sep));
const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'prepared.json')));
assert.equal(manifest.case, 'PC-11'); assert.equal(manifest.artifactDir, artifactDir);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const owner of Object.values(manifest.windows)) {
  assert.equal(hash(path.join(owner.installedExtension, 'dist/extension.js')), manifest.bundleSha256);
  assert.equal(hash(path.join(owner.installedExtension, 'media/chat/chat.js')), manifest.chatSha256);
}
assert(fs.existsSync(path.join(repo, 'out-vscode-test/transfer.test.js')));
assert(fs.existsSync(path.join(repo, 'out-vscode-test/transfer-observer.js')));
fs.writeFileSync(path.join(artifactDir, 'launch-reservation.json'), JSON.stringify({ at: new Date().toISOString(), mode: manifest.mode, plannedConversationRequests: manifest.conversationalRequestsPlanned,
  harnessSha256: hash(path.join(repo, 'out-vscode-test/transfer.test.js')), observerSha256: hash(path.join(repo, 'out-vscode-test/transfer-observer.js')),
  clipboardClientSha256: hash(path.join(repo, 'out-vscode-test/clipboard-guard.js')), recoveryVerifierSha256: hash(path.join(repo, 'scripts/validation/clipboard-recovery-marker.cjs')),
  helperSha256: hash(path.join(manifest.helper, 'extension.cjs')), clipboardGuardSha256: hash(path.join(repo, 'scripts/validation/clipboard-guard.swift')) }), { flag: 'wx' });
const binary = path.join(repo, '.vscode-test/vscode-darwin-arm64-1.141.0/Visual Studio Code.app/Contents/MacOS/Code'); assert(fs.existsSync(binary));
const profilesRoot = fs.realpathSync(path.join(repo, '.vscode-test/profiles'));
const processes = [];
const launchedAt = Date.now();
function rows() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/); assert(m);
    return { pid: +m[1], parentPid: +m[2], startedAt: m[3], executableBasename: path.basename(m[4]) };
  });
}
const key = row => `${row.pid}|${row.startedAt}`;
function sample() {
  const current = rows(), byPid = new Map(current.map(row => [row.pid, row])), now = new Date().toISOString();
  for (const owned of processes) {
    const root = byPid.get(owned.child.pid);
    if (!owned.rootBirth && root) { owned.rootBirth = root.startedAt; owned.identities.set(key(root), root); }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of current) {
        const parent = byPid.get(row.parentPid);
        if (parent && owned.identities.has(key(parent)) && !owned.identities.has(key(row))) { owned.identities.set(key(row), row); changed = true; }
      }
    }
    for (const row of current) if (owned.identities.has(key(row))) {
      const prior = owned.details.get(key(row));
      owned.details.set(key(row), { ...row, parentStartedAt: byPid.get(row.parentPid)?.startedAt, firstObservedAt: prior?.firstObservedAt || now, lastObservedAt: now });
    }
    owned.remaining = current.filter(row => owned.identities.has(key(row)));
    fs.writeFileSync(path.join(owned.window.directory, 'process-ancestry.json'), JSON.stringify({ window: owned.window.id, sampledAt: now, sampleIntervalMs: 250,
      processIdentities: [...owned.identities.values()].map(({ pid, startedAt }) => ({ pid, startedAt })), processDetails: [...owned.details.values()],
      scope: 'Only each owned editor and observed descendants; exact PID plus birth. No process arguments or environment. Detached descendants retain identity after reparenting; children entirely between250ms samples can be missed.' }, null, 2));
  }
  return current;
}
function stopOwned(owned, signal) {
  const current = sample();
  if (recoveryFor(owned, current)) return;
  // Watchdog cleanup can reach captured detached CLI descendants too. Never
  // signal an unrelated process merely because an old PID has been reused.
  for (const row of current.filter(row => owned.identities.has(key(row))).reverse()) {
    try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
function recoveryFor(owned, current = rows()) {
  const file = path.join(owned.window.directory, 'clipboard-restore-failed.json');
  const readyFile = path.join(owned.window.directory, 'helper-ready.json');
  if (!fs.existsSync(file) || !fs.existsSync(readyFile)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(file)), ready = JSON.parse(fs.readFileSync(readyFile));
    const verified = verifyClipboardRecovery({ marker, secret: manifest.clipboardRecoveryKey, window: owned.window,
      hostPid: ready.extensionHostPid, identities: owned.identities, rows: current, launchedAt });
    if (!verified) return false;
    owned.clipboardRecovery = verified;
    fs.writeFileSync(path.join(owned.window.directory, 'retained-clipboard-processes.json'), JSON.stringify({ status: 'FAIL_RETAINED_CLIPBOARD_RECOVERY',
      verifiedMarker: verified, retainedIdentities: current.filter(row => owned.identities.has(key(row))),
      recoveryCommand: 'Mysti Validation: Retry PC11 Clipboard Restore', forcedCleanupPerformed: false }, null, 2));
    return true;
  } catch { return false; }
}
for (const window of Object.values(manifest.windows)) {
  const profile = fs.realpathSync(window.profile); assert(profile.startsWith(profilesRoot + path.sep));
  const marker = JSON.parse(fs.readFileSync(path.join(profile, '.mysti-test-owned.json')));
  assert.equal(marker.case, 'PC-11'); assert.equal(marker.profile, profile); assert.equal(marker.window, window.id);
  assert(!fs.existsSync(path.join(window.directory, 'runner-result.json')));
  const portFile = path.join(profile, 'DevToolsActivePort'); if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  const env = { ...process.env, MYSTI_PC11: '1', MYSTI_PC11_WINDOW: window.id, MYSTI_PC11_ARTIFACT_DIR: artifactDir,
    MYSTI_PC11_ACK_ONLY: manifest.mode === 'ack-smoke' ? '1' : '0',
    MYSTI_TEST_USER_DATA_DIR: profile, MYSTI_TEST_EXTENSION_PATH: window.installedExtension };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${profile}`, `--shared-data-dir=${window.sharedDataDir}`, `--extensions-dir=${window.extensionsDir}`,
    `--extensionDevelopmentPath=${manifest.helper}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--new-window',
    '--skip-welcome', '--skip-release-notes', window.workspace];
  assert(args.every(arg => !/extensionTestsPath/i.test(arg)));
  fs.writeFileSync(path.join(window.directory, 'launch.json'), JSON.stringify({ window: window.id, args, profile, extensionTestsPathUsed: false,
    installedExtension: window.installedExtension, bundleSha256: manifest.bundleSha256, chatSha256: manifest.chatSha256 }, null, 2));
  // File descriptors stay valid if exceptional clipboard recovery requires
  // the editor to outlive this driver; closed stdout pipes must not kill it.
  const stdout = fs.openSync(path.join(window.directory, 'editor-stdout.log'), 'a');
  const stderr = fs.openSync(path.join(window.directory, 'editor-stderr.log'), 'a');
  const child = spawn(binary, args, { env, detached: true, stdio: ['ignore', stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr);
  const owned = { child, window, portFile, identities: new Map(), details: new Map(), ended: false, rootBirth: undefined, remaining: [] };
  owned.finished = new Promise(resolve => {
    child.once('error', error => { owned.ended = true; resolve({ code: null, signal: null, error: error.code || 'spawn-error' }); });
    child.once('exit', (code, signal) => { owned.ended = true; resolve({ code, signal }); });
  });
  owned.finishedOrRecovery = new Promise(resolve => {
    const poll = setInterval(() => {
      if (recoveryFor(owned)) { clearInterval(poll); resolve({ code: null, signal: null, retainedForClipboardRecovery: true }); }
    }, 250);
    owned.finished.then(result => { clearInterval(poll); resolve(result); });
  });
  processes.push(owned);
}
sample();
const sampler = setInterval(() => { try { sample(); } catch { /* Preserve last verified identities for final check. */ } }, 250);
let timedOut = false;
let escalation;
const watchdog = setTimeout(() => {
  timedOut = true;
  fs.writeFileSync(path.join(artifactDir, 'watchdog-failure.json'), JSON.stringify({ timeoutMs: 1200000, at: Date.now(), scope: 'Only previously observed editor descendants with matching birth identity' }));
  for (const owned of processes) stopOwned(owned, 'SIGTERM');
  escalation = setTimeout(() => { for (const owned of processes) stopOwned(owned, 'SIGKILL'); }, 5000);
}, 1200000);

async function trustOwnedWindow(owned) {
  let browser;
  try {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(owned.portFile) && !owned.ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert(fs.existsSync(owned.portFile), 'Owned editor did not expose its CDP endpoint');
    const endpoint = fs.readFileSync(owned.portFile, 'utf8').trim().split(/\r?\n/);
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
    while (!owned.ended && Date.now() < deadline) {
      if (fs.existsSync(path.join(owned.window.directory, 'helper-ready.json'))) break;
      let trusted = false;
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        const initial = page.getByRole('button', { name: /Yes, I trust the authors/i }), manage = page.getByRole('button', { name: 'Trust', exact: true });
        const button = await initial.count() && await initial.isVisible() ? initial : manage;
        if (await button.count() && await button.isVisible()) {
          await button.click(); trusted = true;
          fs.writeFileSync(path.join(owned.window.directory, 'trust-action.json'), JSON.stringify({ window: owned.window.id, ownedWorkspace: owned.window.workspace,
            at: Date.now(), action: button === initial ? 'real startup trust dialog' : 'exact Trust in public workspace trust editor' }));
          break;
        }
      }
      if (trusted) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    fs.writeFileSync(path.join(owned.window.directory, 'driver-error.json'), JSON.stringify({ name: error.name, message: error.message }));
  } finally { await browser?.close().catch(() => {}); }
}
(async () => {
  await Promise.all(processes.map(trustOwnedWindow));
  const exits = await Promise.all(processes.map(owned => owned.finishedOrRecovery)); clearTimeout(watchdog);
  const cleanupStarted = Date.now();
  do { sample(); if (processes.every(owned => owned.clipboardRecovery || owned.remaining.length === 0)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  while (Date.now() - cleanupStarted < 10000);
  clearInterval(sampler); clearTimeout(escalation);
  const finalRows = rows(), finalByPid = new Map(finalRows.map(row => [row.pid, row]));
  const results = processes.map((owned, index) => {
    const file = path.join(owned.window.directory, 'runner-result.json');
    const helper = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { failures: 1, error: 'Missing helper outcome' };
    const receipts = owned.window.receiptPaths.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    const unverified = new Map(), reused = new Map();
    for (const receipt of receipts.filter(receipt => receipt.event === 'start' || receipt.event === 'auxiliary-start' || receipt.event === 'read-only-probe-start')) {
      for (const pid of [receipt.wrapperPid, receipt.childPid]) {
        const row = finalByPid.get(pid); if (!row || owned.identities.has(key(row))) continue;
        const born = Date.parse(row.startedAt);
        if (Number.isFinite(born) && born > receipt.at) reused.set(key(row), { pid, startedAt: row.startedAt });
        else unverified.set(key(row), { pid, startedAt: row.startedAt, receiptAt: receipt.at });
      }
    }
    const cleanup = { status: owned.clipboardRecovery ? 'FAIL_RETAINED_CLIPBOARD_RECOVERY' : owned.remaining.length ? 'FAIL_OBSERVED_PROCESSES_REMAIN' : unverified.size ? 'FAIL_UNVERIFIED_LIVE_RECEIPT_PIDS' : 'PASS_OBSERVED_IDENTITIES_EXITED', window: owned.window.id,
      elapsedMs: Date.now() - cleanupStarted, observedIdentityCount: owned.identities.size, remaining: owned.remaining,
      unverifiedLiveReceiptPids: [...unverified.values()], reusedReceiptPidsExcluded: [...reused.values()],
      conversationalInputs: receipts.filter(receipt => receipt.event === 'request').length, auxiliaryInputs: receipts.filter(receipt => receipt.event === 'auxiliary-input').length,
      blockedInferenceLaunchAttempts: receipts.filter(receipt => receipt.event === 'inference-launch-refused').length,
      readOnlyVersionProbeLaunches: receipts.filter(receipt => receipt.event === 'read-only-probe-start').length,
      scope: 'Observed editor descendant identities at250ms cadence; input counts only from selected transparent CLI wrappers; no unrelated processes signalled in normal cleanup.' };
    fs.writeFileSync(path.join(owned.window.directory, 'editor-exit-process-check.json'), JSON.stringify(cleanup, null, 2));
    const result = { window: owned.window.id, ...exits[index], helper, cleanup, timedOut };
    fs.writeFileSync(path.join(owned.window.directory, 'editor-exit.json'), JSON.stringify(result, null, 2)); return result;
  });
  const failed = timedOut || results.some(result => result.code !== 0 || result.helper.failures || result.cleanup.status !== 'PASS_OBSERVED_IDENTITIES_EXITED');
  if (results.some(result => !['PASS_OBSERVED_IDENTITIES_EXITED', 'FAIL_RETAINED_CLIPBOARD_RECOVERY'].includes(result.cleanup.status))) {
    // Preserve the failed normal-shutdown verdict above. Reclaim only known
    // surviving identities; an unverified receipt PID is never enough to kill.
    for (const owned of processes) if (owned.remaining.length) stopOwned(owned, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 250)); sample();
    for (const owned of processes) if (owned.remaining.length) stopOwned(owned, 'SIGKILL');
    const forcedDeadline = Date.now() + 1500;
    do { sample(); if (processes.every(owned => !owned.remaining.length)) break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < forcedDeadline);
    for (const owned of processes.filter(value => !value.clipboardRecovery)) fs.writeFileSync(path.join(owned.window.directory, 'forced-cleanup.json'), JSON.stringify({
      normalShutdownVerdictPreserved: results.find(result => result.window === owned.window.id).cleanup.status,
      remainingVerifiedIdentities: owned.remaining, unverifiedReceiptPidsWereNotSignalled: true,
      scope: 'Only previously observed PID plus birth identities; this cleanup does not turn a failed normal shutdown into PASS.' }, null, 2));
  }
  fs.writeFileSync(path.join(artifactDir, 'native-result.json'), JSON.stringify({ status: failed ? 'FAIL' : 'PASS', results }, null, 2));
  console.log('[PC-11 ordinary transfer editors]', JSON.stringify({ status: failed ? 'FAIL' : 'PASS', inputs: results.map(result => ({ window: result.window, conversations: result.cleanup.conversationalInputs, auxiliary: result.cleanup.auxiliaryInputs })) }));
  for (const owned of processes) { owned.child.stdout?.destroy(); owned.child.stderr?.destroy(); owned.child.unref(); }
  process.exitCode = failed ? 1 : 0;
})().catch(async error => {
  clearTimeout(watchdog); clearTimeout(escalation);
  fs.writeFileSync(path.join(artifactDir, 'driver-fatal.json'), JSON.stringify({ name: error.name, message: error.message, at: Date.now() }));
  // Failure must remain visible and may not strand detached workers after the
  // editor leader exits. stopOwned always rechecks each captured birth.
  for (const owned of processes) { try { stopOwned(owned, 'SIGTERM'); } catch { /* Continue other owned windows. */ } }
  await new Promise(resolve => setTimeout(resolve, 250));
  for (const owned of processes) { try { stopOwned(owned, 'SIGKILL'); } catch { /* Preserve failure outcome. */ } }
  await Promise.race([Promise.all(processes.map(owned => owned.finished)), new Promise(resolve => setTimeout(resolve, 2000))]);
  clearInterval(sampler); try { sample(); } catch { /* Existing identity receipts remain. */ }
  for (const owned of processes) { owned.child.stdout?.destroy(); owned.child.stderr?.destroy(); owned.child.unref(); }
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
});
