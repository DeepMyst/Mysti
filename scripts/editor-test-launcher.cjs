/* Development-Node launcher; only editor-test-runner.cjs runs in the old editor. */
const path = require('node:path');

exports.launchEditor = async function (config, api = require('@vscode/test-electron')) {
  const root = path.resolve(__dirname, '..');
  const extensionsDir = path.join(root, '.vscode-test', 'extensions');
  const profile = config.env.MYSTI_TEST_USER_DATA_DIR;
  if (!path.isAbsolute(profile)) { throw new Error('Editor acceptance requires an absolute private profile'); }
  const options = {
    version: config.version,
    extensionDevelopmentPath: path.resolve(root, config.extensionDevelopmentPath),
    extensionTestsPath: path.join(root, 'scripts', 'editor-test-runner.cjs'),
    extensionTestsEnv: config.env,
    reuseMachineInstall: false,
    launchArgs: [path.resolve(root, config.workspaceFolder), ...config.launchArgs, `--extensions-dir=${extensionsDir}`],
  };
  for (const archive of config.installExtensions || []) {
    const result = await api.runVSCodeCommand([
      `--install-extension=${path.resolve(root, archive)}`, '--force',
      `--extensions-dir=${extensionsDir}`, `--user-data-dir=${profile}`, '--use-mock-keychain',
    ], { version: config.version, reuseMachineInstall: false, spawn: { timeout: 60_000 } });
    console.log(result.stdout);
  }
  const code = await api.runTests(options);
  if (code !== 0) { throw new Error(`Editor acceptance exited with code ${code}`); }
};
