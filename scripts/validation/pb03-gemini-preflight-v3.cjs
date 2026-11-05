/* Additive PB-03 correction for the installed CLI's home override semantics. */
'use strict';
const os = require('node:os');
const path = require('node:path');
const base = require('./pb03-gemini-preflight-v2.cjs');
function configurationPaths(env = process.env) {
  // CLI homedir() returns GEMINI_CLI_HOME, then Storage.getGlobalGeminiDir()
  // appends .gemini. The override is a home directory, not a config directory.
  const home = env.GEMINI_CLI_HOME || os.homedir();
  const userRoot = path.join(home || os.tmpdir(), '.gemini');
  const fixedRoot = process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli' : '/etc/gemini-cli';
  return { userSettingsPath: path.join(userRoot, 'settings.json'),
    fixedPoliciesDir: path.join(fixedRoot, 'policies'), userPoliciesDir: path.join(userRoot, 'policies') };
}
function inspectCurrentConfiguration(contract, env = process.env) {
  return base.inspectConfigFiles({ contract, env, ...configurationPaths(env) });
}
module.exports = { ...base, configurationPaths, inspectCurrentConfiguration };
