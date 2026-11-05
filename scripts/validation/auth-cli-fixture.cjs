/* PC-03 test fixture: change only the selected child CLI's credential source. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** No credentials are read, copied, logged, created, or revoked by this helper. */
function createAuthCliFixture(directory, executable, nodePath) {
  if (![directory, executable, nodePath].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('Auth fixture paths must be absolute');
  }
  fs.mkdirSync(directory, { recursive: true });
  const wrapperPath = path.join(directory, 'codex-auth-fixture');
  const blockedActionsPath = path.join(directory, 'blocked-auth-actions.jsonl');
  const transitions = [];
  function setSignedOut(signedOut) {
    if (typeof signedOut !== 'boolean') throw new Error('Auth fixture mode must be boolean');
    const source = `#!${nodePath}\n'use strict';\n` +
      `const { spawn } = require('node:child_process');\n` +
      `const requestedArgs = process.argv.slice(2);\n` +
      `if (requestedArgs.includes('logout') || (requestedArgs.includes('login') && !requestedArgs.includes('status'))) { require('node:fs').appendFileSync(${JSON.stringify(blockedActionsPath)}, JSON.stringify({ action: requestedArgs.includes('logout') ? 'logout' : 'login', at: new Date().toISOString() }) + '\\n', { mode: 0o600 }); process.stderr.write('PC03 fixture blocked login/logout; credentials were not changed.\\n'); process.exit(3); }\n` +
      `const env = { ...process.env };\n` +
      (signedOut ? `for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];\n` : '') +
      `const args = ${signedOut ? '[\'-c\', \'cli_auth_credentials_store="ephemeral"\']' : '[]'}.concat(requestedArgs);\n` +
      `const child = spawn(${JSON.stringify(executable)}, args, { env, stdio: 'inherit' });\n` +
      `child.on('error', () => { process.stderr.write('PC03 selected CLI could not start.\\n'); process.exitCode = 1; });\n` +
      `child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });\n` +
      `for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!child.killed) child.kill(signal); });\n`;
    fs.writeFileSync(wrapperPath, source, { mode: 0o700 });
    fs.chmodSync(wrapperPath, 0o700);
    const transition = { mode: signedOut ? 'signed-out-ephemeral' : 'existing-account', at: new Date().toISOString() };
    transitions.push(transition);
    fs.writeFileSync(path.join(directory, 'mode-transitions.json'), JSON.stringify(transitions, null, 2), { mode: 0o600 });
  }
  setSignedOut(true);
  return { path: wrapperPath, blockedActionsPath, setSignedOut };
}

module.exports = { createAuthCliFixture };
