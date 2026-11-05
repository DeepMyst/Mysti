/* Ordinary VS Code launch for PC-08 disk persistence (NOT test-electron). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..');
const artifactDir = path.resolve(process.env.MYSTI_PC08_ARTIFACT_DIR);
const stage = process.env.MYSTI_PC08_STAGE;
assert(['preflight-write', 'preflight-read', 'create', 'restart', 'title-probe'].includes(stage));
const prepared = JSON.parse(fs.readFileSync(path.join(artifactDir, 'prepared.json')));
const disk = prepared.diskRunner; assert(disk);
const profile = fs.realpathSync(prepared.profile), profiles = fs.realpathSync(path.join(repo, '.vscode-test/profiles'));
assert(profile.startsWith(profiles + path.sep));
const marker = JSON.parse(fs.readFileSync(path.join(profile, '.mysti-test-owned.json')));
assert.equal(marker.case, 'PC-08'); assert.equal(marker.profile, profile);
if (stage === 'create' || stage === 'restart' || stage === 'title-probe') {
  for (const preflight of ['preflight-write', 'preflight-read']) {
    const audit = JSON.parse(fs.readFileSync(path.join(artifactDir, preflight, 'storage-audit.json')));
    assert.equal(audit.status, 'PASS_ACTUAL_DISK_STORAGE');
    assert.equal(audit.database, path.join(profile, 'User/globalStorage/state.vscdb'));
  }
}
if (stage === 'restart') {
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'create/runner-result.json'))).failures, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'create/editor-exit-process-check.json'))).status, 'PASS_OBSERVED_IDENTITIES_EXITED');
}
if (stage === 'title-probe') {
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'restart/runner-result.json'))).failures, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'restart/editor-exit-process-check.json'))).status, 'PASS_OBSERVED_IDENTITIES_EXITED');
}
const binary = path.join(repo, '.vscode-test/vscode-darwin-arm64-1.141.0/Visual Studio Code.app/Contents/MacOS/Code');
assert(fs.existsSync(binary));
const stageDir = path.join(artifactDir, stage); fs.mkdirSync(stageDir, { recursive: true });
assert(!fs.existsSync(path.join(stageDir, 'runner-result.json')), 'Preserve the previous stage outcome before another launch');
const portFile = path.join(prepared.profile, 'DevToolsActivePort'); if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
const env = { ...process.env, MYSTI_PC08: '1', MYSTI_PC08_DISK_RUNNER: '1', MYSTI_TEST_USER_DATA_DIR: prepared.profile,
  MYSTI_TEST_OWNED_PROFILE: prepared.profile, MYSTI_TEST_EXTENSION_PATH: disk.installedExtension };
delete env.ELECTRON_RUN_AS_NODE;
const args = [`--user-data-dir=${prepared.profile}`, `--shared-data-dir=${disk.sharedDataDir}`, `--extensions-dir=${disk.extensionsDir}`,
  `--extensionDevelopmentPath=${disk.helper}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--new-window',
  '--skip-welcome', '--skip-release-notes', path.join(repo, 'out-vscode-test/fixture-workspace')];
assert(args.every(arg => !/extensionTestsPath/i.test(arg)));
fs.writeFileSync(path.join(stageDir, 'launch.json'), JSON.stringify({ stage, args, profile: prepared.profile,
  productUnderDevelopment: false, extensionTestsPathUsed: false, extensionPath: disk.installedExtension }, null, 2));
const child = spawn(binary, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
let ended = false;
const owners = new Map(), details = new Map(); let rootBirth, timedOut = false;
function sample() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/); assert(m);
    return { pid: +m[1], parent: +m[2], startedAt: m[3], executableBasename: path.basename(m[4]) };
  });
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const root = byPid.get(child.pid); if (!rootBirth && root) { rootBirth = root.startedAt; owners.set(`${root.pid}|${root.startedAt}`, root); }
  let changed = true;
  while (changed) { changed = false; for (const row of rows) {
    const parent = byPid.get(row.parent), key = `${row.pid}|${row.startedAt}`;
    if (parent && owners.has(`${parent.pid}|${parent.startedAt}`) && !owners.has(key)) { owners.set(key, row); changed = true; }
  } }
  for (const row of rows) if (owners.has(`${row.pid}|${row.startedAt}`)) {
    const key = `${row.pid}|${row.startedAt}`, previous = details.get(key), now = new Date().toISOString();
    details.set(key, { pid: row.pid, startedAt: row.startedAt, parentPid: row.parent, parentStartedAt: byPid.get(row.parent)?.startedAt,
      executableBasename: row.executableBasename, firstObservedAt: previous?.firstObservedAt || now, lastObservedAt: now });
  }
  const observation = { processIdentities: { editor: [...owners.values()].map(({ pid, startedAt }) => ({ pid, startedAt })), conversational: [], auxiliaryReceipts: [] },
    processDetails: [...details.values()], receiptPaths: prepared.receiptsPathsByStage[stage], sampleIntervalMs: 250,
    scope: 'Ordinary editor descendants from launch, identified by PID plus process birth; safe basename/parent only. No command arguments or environment collected.' };
  fs.writeFileSync(path.join(stageDir, 'runner-process-ancestry.json'), JSON.stringify(observation, null, 2));
  if (stage.startsWith('preflight') || stage === 'title-probe') fs.writeFileSync(path.join(stageDir, 'process-ancestry.json'), JSON.stringify(observation, null, 2));
  return root;
}
sample(); const sampler = setInterval(() => { try { sample(); } catch { /* Final audit retains prior captured identities. */ } }, 250);
function signalOwnedGroup(signal) {
  const current = sample();
  if (current && rootBirth && current.startedAt === rootBirth) { process.kill(-child.pid, signal); return true; }
  return false; // A reused PID or exited leader must never be signalled.
}
const timeout = setTimeout(() => {
  timedOut = true;
  fs.writeFileSync(path.join(stageDir, 'watchdog-failure.json'), JSON.stringify({ stage, timeoutMs: stage === 'create' ? 1800000 : 180000, parentPid: child.pid, parentBirth: rootBirth, action: 'SIGTERM only if the originally spawned process-group leader still has its captured birth identity' }));
  signalOwnedGroup('SIGTERM'); setTimeout(() => { if (!ended) signalOwnedGroup('SIGKILL'); }, 5000);
}, stage === 'create' ? 1800000 : 180000);
const finished = new Promise(resolve => child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }); }));
(async () => {
  let browser;
  try {
    const deadline = Date.now() + 45000;
    while (!fs.existsSync(portFile) && !ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!fs.existsSync(portFile)) throw new Error('Ordinary editor did not expose its owned CDP endpoint');
    const endpoint = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
    // Authorize only the test's own workspace using the genuine trust dialog.
    // No security flag or storage mutation is used to bypass the product gate.
    while (!ended && Date.now() < deadline) {
      let trusted = false;
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        const initial = page.getByRole('button', { name: /Yes, I trust the authors/i });
        const manage = page.getByRole('button', { name: 'Trust', exact: true });
        const button = await initial.count() && await initial.isVisible() ? initial : manage;
        if (await button.count() && await button.isVisible()) {
          await button.click(); trusted = true;
          fs.writeFileSync(path.join(stageDir, 'trust-action.json'), JSON.stringify({ scope: 'Owned disposable fixture workspace', action: button === initial ? 'Clicked real Yes, I trust the authors dialog' : 'Clicked exact Trust button in public Manage Workspace Trust editor', at: new Date().toISOString() }));
          break;
        }
      }
      if (trusted || fs.existsSync(path.join(stageDir, 'helper-ready.json')) || fs.existsSync(path.join(stageDir, 'runner-result.json'))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (!ended) fs.writeFileSync(path.join(stageDir, 'driver-error.json'), JSON.stringify({ name: error.name, message: error.message }, null, 2));
  } finally { await browser?.close().catch(() => {}); }
  const exit = await finished;
  clearTimeout(timeout); clearInterval(sampler); sample();
  const resultFile = path.join(stageDir, 'runner-result.json');
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : { failures: 1, error: 'No helper outcome' };
  fs.writeFileSync(path.join(stageDir, 'editor-exit.json'), JSON.stringify({ ...exit, helperResult: result, timedOut }, null, 2));
  console.log('[PC-08 ordinary runner]', JSON.stringify({ stage, ...exit, failures: result.failures }));
  process.exitCode = timedOut || result.failures || exit.code !== 0 ? 1 : 0;
})().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
