#!/usr/bin/env node
/** PC-01 installed-VSIX trust gate. No development-mode trust exemptions. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, '.vscode-test/vscode-darwin-arm64-1.141.0/Visual Studio Code.app/Contents');
const executable = process.env.MYSTI_TEST_VSCODE_EXECUTABLE || path.join(app, 'MacOS/Code');
const cli = process.env.MYSTI_TEST_VSCODE_CLI || path.join(app, 'Resources/app/bin/code');
const vsix = path.resolve(process.argv[2] || path.join(root, 'mysti-2.0.0.vsix'));
const base = path.join(root, 'out-test/feature-tests/PC-01');
fs.mkdirSync(base, { recursive: true });
const run = fs.mkdtempSync(path.join(base, 'trust-'));
// Keep the macOS Unix-domain socket path below its 103-byte limit. Evidence
// stays in the case directory; this fresh profile is retained alongside the
// other native test profiles and never reuses the developer's editor state.
const profile = fs.mkdtempSync(path.join(root, '.vscode-test/pc01-'));
// VS Code 1.141 stores trusted folders in APPLICATION_SHARED storage, which
// defaults to ~/.vscode-shared even with a fresh --user-data-dir. A fixture
// nested inside an already-trusted repository otherwise inherits real trust.
// Isolate that store too; never clear or rewrite the developer's trust records.
const sharedData = path.join(profile, 'shared');
const extensions = path.join(run, 'extensions');
const workspace = path.join(run, 'workspace');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# PC-01 untrusted workspace fixture\n');
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': true,
  'security.workspace.trust.startupPrompt': 'always',
  'security.workspace.trust.banner': 'always',
  'workbench.startupEditor': 'none',
  'extensions.ignoreRecommendations': true,
  'telemetry.telemetryLevel': 'off',
  'window.restoreWindows': 'none',
  'mysti.showSuggestions': false,
}, null, 2));
const evidence = { caseId: 'PC-01', startedAt: new Date().toISOString(), status: 'RUNNING',
  scope: 'Installed extension in fresh profile; restricted-workspace activation then explicit trust. Existing machine CLIs/accounts are not isolated.',
  profile, sharedData, workspace, extensions,
  vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'), observations: [] };
const report = path.join(run, 'result.json');
function record(step, values = {}) {
  evidence.observations.push({ at: new Date().toISOString(), step, ...values });
  fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
  console.log(`[PC-01 trust] ${step}`);
}
function filesBelow(directory, basename) {
  if (!fs.existsSync(directory)) { return []; }
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(child, basename) : entry.name === basename ? [child] : [];
  });
}
function activations() {
  return filesBelow(path.join(profile, 'logs'), 'exthost.log').flatMap(file =>
    fs.readFileSync(file, 'utf8').split('\n').filter(line => /_doActivateExtension DeepMyst\.mysti/i.test(line)));
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// The agent process may itself be launched by Electron's Node mode. The
// standalone editor must boot its GUI, and must not reuse a daily CLI server.
const editorEnv = { ...process.env };
const removedEnvironmentKeys = Object.keys(editorEnv).filter(key => key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_'));
for (const key of removedEnvironmentKeys) { delete editorEnv[key]; }
const isolatedPaths = ['--user-data-dir', profile, '--extensions-dir', extensions, '--shared-data-dir', sharedData];
async function until(label, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) { return; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

(async () => {
  let editor;
  let browser;
  let page;
  const output = fs.createWriteStream(path.join(run, 'editor.log'));
  try {
    assert.ok(fs.existsSync(executable), 'Set MYSTI_TEST_VSCODE_EXECUTABLE to the editor binary');
    assert.ok(fs.existsSync(cli), 'Set MYSTI_TEST_VSCODE_CLI to its CLI wrapper');
    record('Fresh user, extension, and shared-trust storage configured', { removedEnvironmentKeys });
    const install = execFileSync(cli, [...isolatedPaths,
      '--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 60_000, env: editorEnv });
    fs.writeFileSync(path.join(run, 'install.log'), install);
    record('VSIX installed into isolated profile');
    editor = spawn(executable, [...isolatedPaths,
      '--new-window', '--skip-welcome', '--skip-release-notes',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', workspace],
    { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: editorEnv });
    let spawnError;
    editor.on('error', error => { spawnError = error; });
    editor.stdout.pipe(output); editor.stderr.pipe(output);
    await until('editor CDP endpoint', () => {
      if (spawnError) { throw spawnError; }
      if (editor.exitCode !== null || editor.signalCode !== null) {
        throw new Error(`Editor exited before CDP was ready (${editor.exitCode ?? editor.signalCode}); inspect editor.log`);
      }
      return fs.existsSync(path.join(profile, 'DevToolsActivePort'));
    });
    const [port, endpoint] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`);
    await until('workbench page', () => {
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'));
      return !!page;
    });
    await page.bringToFront();
    await page.getByRole('button', { name: /No, I don.t trust/i }).click({ timeout: 30_000 });
    await page.getByText('Restricted Mode', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
    // Observe a real startup window after the host is running. This is a short
    // trust gate, not evidence for an S/W/P elapsed-time profile.
    await delay(5_000);
    assert.equal(activations().length, 0, 'Mysti activated in the explicitly untrusted workspace');
    await page.screenshot({ path: path.join(run, 'restricted.png') });
    record('Restricted Mode prevents Mysti activation', { activationCount: 0 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Control+Shift+p');
    const commandInput = page.locator('.quick-input-widget input').first();
    // Keep the command-mode prefix: removing it changes the palette into a
    // file search, and pressing Enter races that mode switch.
    await commandInput.fill('>Workspaces: Manage Workspace Trust');
    await page.locator('.quick-input-list .monaco-list-row')
      .filter({ hasText: 'Workspaces: Manage Workspace Trust' }).first().click({ timeout: 15_000 });
    const trust = page.getByRole('button', { name: 'Trust', exact: true });
    await trust.click({ timeout: 20_000 });
    await until('Mysti activates after explicit trust', () => activations().length > 0, 45_000);
    await page.screenshot({ path: path.join(run, 'trusted.png') });
    record('Explicit trust enables activation', { activations: activations() });
    evidence.status = 'PASS';
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.error = error instanceof Error ? error.message : String(error);
    if (page) {
      try { await page.screenshot({ path: path.join(run, 'failure.png') }); } catch { /* retain other evidence */ }
    }
    console.error(evidence.error);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    if (editor?.pid) {
      try { process.kill(process.platform === 'win32' ? editor.pid : -editor.pid, 'SIGTERM'); } catch { /* exited */ }
      const deadline = Date.now() + 5_000;
      while (editor.exitCode === null && editor.signalCode === null && Date.now() < deadline) { await delay(100); }
      if (editor.exitCode === null && editor.signalCode === null) {
        try { process.kill(process.platform === 'win32' ? editor.pid : -editor.pid, 'SIGKILL'); } catch { /* exited */ }
      }
    }
    output.end();
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${report}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
