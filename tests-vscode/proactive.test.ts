/** Native editor smoke test; never connects accounts or enables monitoring. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildSync } from 'esbuild';

describe('Mysti Proactive native panel', function () {
  this.timeout(30_000);
  it('opens one native webview, renders packaged assets, and cleans up on disposal', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-proactive-host-'));
    let manager: any;
    try {
      const outfile = path.join(directory, 'manager.cjs');
      buildSync({ entryPoints: [path.resolve(__dirname, '../src/managers/ProactiveManager.ts')], outfile, bundle: true, platform: 'node', external: ['vscode'] });
      const Manager = require(outfile).ProactiveManager;
      const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')), workspaceState: { get: () => undefined, update: async () => {} } };
      const auth = { onDidChangeAuth: () => ({ dispose() {} }), isSignedIn: () => false };
      manager = new Manager(context, auth);
      await manager._refresh();
      manager.open(); const panel = manager._panel;
      assert.ok(panel.webview.html.includes('Watch a local repository'));
      assert.ok(panel.webview.html.includes('Content-Security-Policy'));
      assert.ok(!panel.webview.html.includes('{{scriptUri}}'));
      manager.open(); assert.strictEqual(manager._panel, panel);
      assert.strictEqual(manager._state.watches.length, 0);
      manager.dispose();
      assert.ok(!manager._panel);
    } finally { manager?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
