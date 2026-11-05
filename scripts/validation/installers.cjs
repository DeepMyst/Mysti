#!/usr/bin/env node
// Opt-in real installs into temporary npm prefixes; use disposable CI runners.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const versions = [
  ['claude-code', '@anthropic-ai/claude-code', '2.1.286', 'claude'],
  ['openai-codex', '@openai/codex', '0.159.3', 'codex'],
  ['google-gemini', '@google/gemini-cli', '0.62.0', 'gemini'],
  ['cline', 'cline', '3.0.67', 'cline'],
  ['github-copilot', '@github/copilot', '1.0.90', 'copilot'],
  ['opencode', 'opencode-ai', '1.18.34', 'opencode'],
  ['qwen-code', '@qwen-code/qwen-code', '0.24.7', 'qwen'],
  ['continue', '@continuedev/cli', '1.5.47', 'cn'],
  ['openclaw', 'openclaw', '2026.9.7', 'openclaw'],
];
const requested = (process.env.MYSTI_INSTALLER_PROVIDERS || '').split(',').map(id => id.trim()).filter(Boolean);
for (const id of requested) {
  if (!versions.some(row => row[0] === id)) { throw new Error(`Unknown installer provider: ${id}`); }
}
const selected = requested.length ? versions.filter(row => requested.includes(row[0])) : versions;
const parent = process.env.MYSTI_INSTALLER_ROOT ? path.resolve(process.env.MYSTI_INSTALLER_ROOT) : os.tmpdir();
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'mysti installer smoke-'));
const output = process.env.MYSTI_INSTALLER_REPORT || path.resolve('installer-validation.json');
const installTimeout = Number(process.env.MYSTI_INSTALLER_TIMEOUT_MS || 240000);
if (!Number.isInteger(installTimeout) || installTimeout < 1000 || installTimeout > 900000) {
  throw new Error('MYSTI_INSTALLER_TIMEOUT_MS must be an integer from 1000 to 900000.');
}
const npmCli = [process.env.npm_execpath,
  path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
].find(p => p && fs.existsSync(p));
if (!npmCli) throw new Error('Run via npm run validate:installers so npm_execpath is available.');
const report = { checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, root,
  scope: 'Actual npm global-layout installs into disposable prefixes containing spaces; invoke the installed shim and verify the requested version. Machine accounts remain available; no clean-OS, sign-in, or inference claim.', results: [] };
function run(executable, args, cwd, timeout) {
  return new Promise(resolve => {
    const env = { ...process.env, CI: '1', npm_config_engine_strict: 'true' };
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', expired = false;
    child.stdout.on('data', b => { text = (text + b).slice(-8000); });
    child.stderr.on('data', b => { text = (text + b).slice(-8000); });
    const timer = setTimeout(() => {
      expired = true;
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }, timeout);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !expired, code, timedOut: expired, output: text.trim() }); });
  });
}
(async () => {
  for (const [id, pkg, version, bin] of selected) {
    const prefix = path.join(root, id);
    fs.mkdirSync(prefix);
    const install = await run(process.execPath, [npmCli, 'install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', `${pkg}@${version}`], root, installTimeout);
    const row = { id, package: pkg, version, prefix, install };
    if (install.ok) {
      try {
        const pkgDir = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', pkg);
        const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const shim = path.join(prefix, process.platform === 'win32' ? '' : 'bin', bin + (process.platform === 'win32' ? '.cmd' : ''));
        row.shim = shim;
        row.launcherPresent = fs.existsSync(shim);
        row.manifestVersion = manifest.version;
        // Exercise the executable users actually select, including npm's shim.
        row.launch = process.platform === 'win32'
          ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`], root, 45000)
          : await run(shim, ['--version'], root, 45000);
        const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        row.versionMatches = manifest.version === version && new RegExp(`(?:^|[^\\w.+-])${escapedVersion}(?=$|[^\\w.+-])`).test(row.launch.output || '');
      } catch (error) { row.launch = { ok: false, error: error.message }; }
    }
    report.results.push(row);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`${id}: install=${install.ok} launcher=${row.launcherPresent ?? false} version=${row.launch?.ok && row.versionMatches || false}`);
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.results.every(r => r.install.ok && r.launcherPresent && r.launch?.ok && r.versionMatches) ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
