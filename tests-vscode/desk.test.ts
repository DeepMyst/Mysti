import * as QUnit from 'qunit';
import { test, timeout } from './acceptance';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
import * as vscode from 'vscode';

QUnit.module('Mysti Desk — packaged native runtime in the actual editor', hooks => {
  timeout(hooks, 15_000);

  test('registers cross-machine commands while relay access defaults to disabled', async () => {
    const extension = vscode.extensions.getExtension('DeepMyst.mysti')!;
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['deskShareRemoteStatus', 'deskCheckRemoteStatus', 'deskShareRemoteLookup', 'deskLocateRemote']) {
      assert.ok(commands.includes(`mysti.${name}`), `Missing Desk command: ${name}`);
    }
    assert.strictEqual(vscode.workspace.getConfiguration('mysti').get('desk.relayUrl'), '');
  });

  const nativePresent = fs.existsSync(path.join(vscode.extensions.getExtension('DeepMyst.mysti')!.extensionUri.fsPath, 'resources/desk-native/manifest.json'));
  const nativeTest = nativePresent || process.env.MYSTI_TEST_DESK_NATIVE === '1' ? test : QUnit.skip;
  nativeTest('starts the exact packaged worker or refuses the minimum runtime before native access', async function () {
    const extension = vscode.extensions.getExtension('DeepMyst.mysti')!;
    const root = extension.extensionUri.fsPath;
    assert.ok(nativePresent, 'The platform archive is missing its native runtime');
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
      if (process.env[key]) { env[key] = process.env[key]; }
    }
    const child = fork(path.join(root, 'dist/deskIrohWorker.js'), [], {
      cwd: root, env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const closed = new Promise<number | null>(resolve => child.once('exit', resolve));
    const [major, minor] = process.versions.node.split('.').map(Number);
    const supported = major > 20 || (major === 20 && minor >= 3);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<{ endpointId?: string; exit?: number | null }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Packaged Desk worker did not settle')), 8000);
        child.once('error', reject);
        child.once('exit', exit => resolve({ exit }));
        child.once('message', raw => resolve(raw as { endpointId: string }));
        // An explicitly local, unserved relay address. This checks native load,
        // binding and teardown; it neither contacts nor accepts an external relay.
        child.send({ mode: 'serve', relayUrl: 'https://localhost/', bearer: 'b'.repeat(32) });
      });
      if (supported) { assert.match(result.endpointId ?? '', /^[a-f0-9]{64}$/, 'Packaged native initialization failed'); }
      else { assert.strictEqual(result.exit, 1, 'Minimum runtime must refuse native initialization'); }
      console.log(`[Desk native archive] ${process.platform}-${process.arch}, Node ${process.versions.node}: ${supported ? 'native bind passed' : 'minimum guard passed'}`);
    } finally {
      clearTimeout(timer); child.kill('SIGKILL'); await closed;
    }
  });
});
