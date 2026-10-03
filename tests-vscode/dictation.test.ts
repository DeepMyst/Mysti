/** Real editor lifecycle; speech commands are substituted so tests never record ambient audio. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildSync } from 'esbuild';

describe('Mysti dictation editor bridge', function () {
  this.timeout(30_000);
  let Manager: any, manager: any, directory: string;
  let events: any[], commands: string[];
  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-voice-host-'));
    const outfile = path.join(directory, 'manager.cjs');
    buildSync({ entryPoints: [path.resolve(__dirname, '../src/managers/DictationManager.ts')], outfile, bundle: true, platform: 'node', external: ['vscode'] });
    Manager = require(outfile).DictationManager;
  });
  beforeEach(() => {
    events = []; commands = [];
    manager = new Manager((panelId: string, event: any) => events.push({ panelId, ...event }), async (command: string) => { commands.push(command); });
  });
  afterEach(async () => { await manager.cancelPanel('test-panel'); manager.dispose(); });
  after(() => { fs.rmSync(directory, { recursive: true, force: true }); });
  it('native command exists; bridges actual document changes and closes only its dirty scratch tab', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('workbench.action.editorDictation.start'));
    const source = await vscode.workspace.openTextDocument({ content: 'Keep this unrelated draft', language: 'plaintext' });
    await vscode.window.showTextDocument(source);
    await manager.start('test-panel', 'first');
    assert.strictEqual(events.at(-1).state, 'active', JSON.stringify(events));
    const dictation = vscode.window.activeTextEditor!;
    assert.notStrictEqual(dictation.document, source);
    await dictation.edit(edit => edit.insert(new vscode.Position(0, 0), 'Review the error handling'));
    assert.ok(events.some(e => e.text === 'Review the error handling'));
    await vscode.window.showTextDocument(source);
    await manager.finish('test-panel', 'first');
    assert.strictEqual(events.at(-1).text, 'Review the error handling');
    assert.strictEqual(events.at(-1).state, 'complete');
    assert.deepStrictEqual(commands, ['workbench.action.editorDictation.start', 'workbench.action.editorDictation.stop']);
    assert.strictEqual(source.getText(), 'Keep this unrelated draft');
    assert.ok(!source.isClosed);
    assert.ok(!vscode.window.tabGroups.all.flatMap(g => g.tabs).some(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === dictation.document.uri.toString()), 'scratch tab still open');
    await vscode.window.showTextDocument(source);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
  it('status bar finish and discard commands clean up the real scratch editors', async () => {
    await manager.start('test-panel', 'second');
    const finish = (await vscode.commands.getCommands(true)).find(id => id.startsWith('mysti.dictation.finish.'))!;
    await vscode.window.activeTextEditor!.edit(edit => edit.insert(new vscode.Position(0, 0), 'native finish'));
    await vscode.commands.executeCommand(finish);
    assert.strictEqual(events.at(-1).state, 'complete');
    assert.strictEqual(events.at(-1).text, 'native finish');
    await manager.start('test-panel', 'third');
    const cancel = (await vscode.commands.getCommands(true)).find(id => id.startsWith('mysti.dictation.cancel.'))!;
    await vscode.commands.executeCommand(cancel);
    assert.strictEqual(events.at(-1).state, 'cancelled');
  });
});
