/* Creates the throwaway workspace the VS Code integration tests open. */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'out-vscode-test', 'fixture-workspace');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'README.md'), '# Mysti canvas integration fixture\n');
console.log('[Mysti] vscode-test fixture workspace:', dir);
