/* Development-Node launcher; only editor-test-runner.cjs runs in the old editor. */
const path = require('node:path');
const { spawn } = require('node:child_process');

function cliScript(executable, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  return platform === 'darwin'
    ? paths.resolve(paths.dirname(executable), '../Resources/app/out/cli.js')
    : paths.join(paths.dirname(executable), 'resources', 'app', 'out', 'cli.js');
}

// Run the editor's CLI JavaScript through its own embedded Node. In particular,
// do not invoke Windows code.cmd through a shell: spaces and metacharacters in
// archive/profile paths must reach the CLI as literal individual arguments.
function runEditorCli(executable, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false, windowsHide: true, timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) { resolve({ stdout, stderr }); }
      else { reject(new Error(`Editor archive installation failed (${signal || code}): ${stderr || stdout}`)); }
    });
  });
}

exports.cliScript = cliScript;
exports.runEditorCli = runEditorCli;
exports.launchEditor = async function (config, api = require('@vscode/test-electron'), install = runEditorCli) {
  const root = path.resolve(__dirname, '..');
  const extensionsDir = path.join(root, '.vscode-test', 'extensions');
  const profile = config.env.MYSTI_TEST_USER_DATA_DIR;
  if (!path.isAbsolute(profile)) { throw new Error('Editor acceptance requires an absolute private profile'); }
  // Resolve stable once, so installation and execution cannot select different
  // editor releases if the stable channel changes between the two operations.
  const executable = await api.downloadAndUnzipVSCode({ version: config.version });
  const options = {
    version: config.version,
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: path.resolve(root, config.extensionDevelopmentPath),
    extensionTestsPath: path.join(root, 'scripts', 'editor-test-runner.cjs'),
    extensionTestsEnv: config.env,
    reuseMachineInstall: false,
    launchArgs: [path.resolve(root, config.workspaceFolder), ...config.launchArgs, `--extensions-dir=${extensionsDir}`],
  };
  for (const archive of config.installExtensions || []) {
    const result = await install(executable, cliScript(executable), [
      `--install-extension=${path.resolve(root, archive)}`, '--force',
      `--extensions-dir=${extensionsDir}`, `--user-data-dir=${profile}`, '--use-mock-keychain',
    ]);
    console.log(result.stdout);
  }
  const code = await api.runTests(options);
  if (code !== 0) { throw new Error(`Editor acceptance exited with code ${code}`); }
};
