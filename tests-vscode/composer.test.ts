/**
 * PC-06 opt-in real editor queue/second-opinion journey, four actual requests.
 * MYSTI_PC06=1; --grep 'PC-06 real editor'; fresh runner profile plus exact
 * MYSTI_TEST_EXTENSION_PATH, MYSTI_PC06_CLAUDE_PATH, MYSTI_PC06_CODEX_PATH,
 * MYSTI_PC06_NODE_PATH. Optional MYSTI_PC06_ARTIFACT_DIR.
 * Small inline retry/cache task, NOT the full F2 repository. Existing accounts;
 * no credential/config-file mutations. Editor settings belong to the fresh
 * runner profile and are restored. Real Attach, queue, and opinion controls.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page, type Frame } from 'playwright';

/** Observe the real outer-webview bridge before its API captures the function.
 * Never acquire/replace the inner API or change any message/return/transfer.
 * The source is self-contained because Playwright serializes it verbatim.
 */
function observeComposerSends(): void {
  const win = globalThis as any;
  if (win.__pc06BridgeInstalled) return;
  win.__pc06BridgeInstalled = true;
  win.__pc06UiSends = [];
  let original: any;
  let forward: any;
  Object.defineProperty(win, '__vscode_post_message__', {
    configurable: true,
    get: () => forward,
    set: value => {
      original = value;
      forward = function (this: unknown, ...args: any[]): unknown {
        const message = args[0] === 'onmessage' ? args[1]?.message : undefined;
        if (message?.type === 'sendMessage') {
          const p = message.payload || {};
          const fixture = typeof p.content === 'string' && /^(?:@(?:claude|codex)\s+)?PC06_CURRENT_REQUEST:/.test(p.content);
          win.__pc06UiSends.push({ type: message.type, at: Date.now(), fixture,
            content: fixture ? p.content : '[non-fixture send omitted]',
            provider: p.settings?.provider, model: p.settings?.model,
            secondOpinion: p.secondOpinion && { provider: p.secondOpinion.provider, messageId: p.secondOpinion.messageId },
            attachments: (p.attachments || []).map((a: any) => ({
              fileName: /^PC06_ATTACHMENT_(?:INITIAL|DRAFT)\.txt$/.test(a.fileName) ? a.fileName : '[unexpected file]',
              size: typeof a.size === 'number' ? a.size : undefined, hasInlineData: typeof a.base64Data === 'string',
            })),
          });
        }
        return Reflect.apply(original, this, args);
      };
      win.__pc06BridgeActive = true;
    },
  });
}

/** Transparent selected-CLI launcher. Receipt schema contains only known
 * synthetic markers, attachment names, models, process ancestry and timing.
 * Raw protocol/prompt/output/argv/env/session/account identifiers are not saved.
 */
function createComposerCli(directory: string, provider: 'claude-code' | 'openai-codex', executable: string, node: string, hooks: string): string {
  const launcher = path.join(directory, provider + '-composer-fixture');
  const receipts = path.join(directory, provider + '-receipts.jsonl');
  const source = `#!${node}
'use strict';
const fs=require('fs'),{spawn}=require('child_process'),{StringDecoder}=require('string_decoder');
const provider=${JSON.stringify(provider)},args=process.argv.slice(2);
const flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const persistent=provider==='claude-code'?flag('--input-format')==='stream-json'&&flag('--output-format')==='stream-json':args.includes('app-server');
const claudeInference=provider==='claude-code'&&args.includes('--print');
const child=spawn(${JSON.stringify(executable)},claudeInference?[...args,'--settings',${JSON.stringify(hooks)}]:args,{env:process.env,stdio:['pipe','pipe','pipe']});
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(value);
let selectedModel=identifier(flag('--model'))?flag('--model'):undefined;
const record=value=>{if(persistent||claudeInference)fs.appendFileSync(${JSON.stringify(receipts)},JSON.stringify({provider,at:Date.now(),...value})+'\\n',{mode:0o600});};
const textBlocks=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(v=>v&&v.type==='text'&&typeof v.text==='string').map(v=>v.text).join('\\n'):'';
function captureInput(line){
  if(!persistent)return;
  let value;try{value=JSON.parse(line);}catch{return;}
  if(provider==='openai-codex'&&['thread/start','thread/resume'].includes(value.method)&&identifier(value.params?.model)){selectedModel=value.params.model;return;}
  let prompt,method;
  if(provider==='claude-code'&&value.type==='user'&&value.message?.role==='user'){prompt=textBlocks(value.message.content);method='user';}
  if(provider==='openai-codex'&&value.method==='turn/start'){prompt=textBlocks(value.params?.input);method='turn/start';}
  if(typeof prompt!=='string')return;
  const markers=['INITIAL','A','B_REMOVED','C','DRAFT','OTHER_DRAFT'].filter(marker=>prompt.includes('PC06_CURRENT_REQUEST:'+marker));
  const attachments=['PC06_ATTACHMENT_INITIAL.txt','PC06_ATTACHMENT_DRAFT.txt'].filter(name=>prompt.includes(name));
  record({event:'request',method,markers,attachments,...(selectedModel?{model:selectedModel}:{})});
}
function captureOutput(line){
  if(!persistent)return;
  let value;try{value=JSON.parse(line);}catch{return;}
  if(provider==='claude-code'&&value.type==='system'&&value.subtype==='init'&&identifier(value.model))record({event:'model',model:value.model});
  if(provider==='openai-codex'&&identifier(value.result?.model))record({event:'model',model:value.result.model});
}
function inspect(stream,capture){
  const decoder=new StringDecoder('utf8');let pending='',discarding=false;
  stream.on('data',chunk=>{const pieces=decoder.write(chunk).split('\\n');for(let i=0;i<pieces.length;i++){
    if(!discarding){if(pending.length+pieces[i].length>1024*1024){pending='';discarding=true;}else pending+=pieces[i];}
    if(i<pieces.length-1){if(!discarding)capture(pending);pending='';discarding=false;}
  }});
}
inspect(process.stdin,captureInput);inspect(child.stdout,captureOutput);
let auxiliaryInput=false;
process.stdin.on('data',chunk=>{if(claudeInference&&!persistent&&!auxiliaryInput&&chunk.length){auxiliaryInput=true;record({event:'auxiliary-input',...(selectedModel?{model:selectedModel}:{})});}});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.stdin.on('error',()=>{});
child.on('spawn',()=>record({event:persistent?'start':'auxiliary-start',wrapperPid:process.pid,childPid:child.pid}));
child.on('error',()=>{process.stderr.write('PC06 selected CLI failed to launch.\\n');process.exitCode=1;process.stdin.pause();});
child.on('close',(code,signal)=>{record({event:persistent?'exit':'auxiliary-exit',wrapperPid:process.pid,childPid:child.pid});process.stdin.unpipe(child.stdin);process.stdin.pause();if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});
`;
  fs.writeFileSync(launcher, source, { mode: 0o700 });
  return launcher;
}

if (process.env.MYSTI_PC06 === '1') {
  describe('PC-06 real editor draft, queue and second opinion', function () {
    this.timeout(660_000);
    let browser: Browser, workbench: Page, frame: Frame, bridgeFrame: Frame, chatTab: vscode.Tab | undefined;
    let artifactDir: string, cliDirectory: string, fixtureDirectory: string, initialFile: string, draftFile: string;
    let extensionPath: string, extensionHash: string, conversationId: string;
    let ready = false;
    let simpleDialogOriginal: unknown;
    let simpleDialogChanged = false;
    const observations: unknown[] = [], ownedPids = new Set<number>(), auxiliaryPids = new Set<number>(), originalTabs = new Set<vscode.Tab>();
    let liveAuxiliaryPids: number[] = [];
    const saved: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const initialAttachment = 'Synthetic retry review notes. No account data. Preserve the 500ms cap.\n';
    const draftAttachment = 'Private synthetic draft notes; this file must never accompany a submitted request.\n';
    const initialPrompt = 'PC06_CURRENT_REQUEST:INITIAL\nReview this small service retry/cache design using only the inline source below. No tools, file reads, commands, or changes. The attached notes are supplemental; do not open files.\n\n```javascript\nfunction retryDelay(attempt, baseMs = 73, capMs = 500) {\n  return Math.min(capMs, baseMs * attempt);\n}\nconst cacheKey = (tenant, requestId) => `${tenant}:${requestId}`;\n```\n\nThe contract is exponential backoff: attempt 0 starts at baseMs, with a cap. Explain the correction and how tenant-scoped idempotency keys avoid duplicate jobs. Give 12 numbered review points, 20–35 words each, so a developer can amend the task while you explain. Include exactly PC06_INITIAL_VALUES:[73,146,500] for attempts 0,1,4. End with PC06_INITIAL_DONE.';
    const amendmentA = '@codex PC06_CURRENT_REQUEST:A\nIndependently check the original inline retry function and cap from this conversation. No tools or file changes. Give a concise test recommendation and exactly PC06_A_VALUES:[73,146,500]. End with PC06_A_DONE.';
    const removedB = '@claude PC06_CURRENT_REQUEST:B_REMOVED\nThis queued amendment will be removed before dispatch. Do not act on it.';
    const amendmentC = '@claude PC06_CURRENT_REQUEST:C\nFor our original retry function, retain the exponential correction and base, but change the default cap to 250. No tools or file changes. Give the corrected function and exactly PC06_C_VALUES:[73,146,250]. End with PC06_C_DONE.';
    const draft = 'PC06_CURRENT_REQUEST:DRAFT\nUnsent notes: investigate cache eviction separately.\nKeep this draft and its attachment while the queue drains.';

    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { ...details, event, at: new Date().toISOString() }; observations.push(entry);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2)); console.log('[PC-06]', JSON.stringify(entry));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    function receipts(): any[] {
      if (!cliDirectory) return [];
      return ['claude-code', 'openai-codex'].flatMap(provider => {
        const file = path.join(cliDirectory, provider + '-receipts.jsonl');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      }).sort((a, b) => a.at - b.at);
    }
    function processes(): number[] {
      for (const receipt of receipts()) {
        // Persistent conversation transports belong to the private chat tab.
        // SuggestionManager title/warmup text processes belong to the editor.
        const owner = receipt.event === 'start' ? ownedPids : receipt.event === 'auxiliary-start' ? auxiliaryPids : undefined;
        if (owner) for (const pid of [receipt.wrapperPid, receipt.childPid]) if (Number.isInteger(pid)) owner.add(pid);
      }
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      for (const owner of [ownedPids, auxiliaryPids]) {
        let changed = true;
        while (changed) { changed = false; for (const [pid, parent] of rows) if (owner.has(parent) && !owner.has(pid)) { owner.add(pid); changed = true; } }
      }
      liveAuxiliaryPids = rows.filter(([pid]) => auxiliaryPids.has(pid)).map(([pid]) => pid);
      return rows.filter(([pid]) => ownedPids.has(pid)).map(([pid]) => pid);
    }
    async function events(type?: string): Promise<any[]> {
      const all = await frame.evaluate(() => (globalThis as any).__pc06Events || []);
      return type ? all.filter((event: any) => event.type === type) : all;
    }
    async function uiSends(): Promise<any[]> { return bridgeFrame.evaluate(() => (globalThis as any).__pc06UiSends || []); }
    async function configure(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
      const config = vscode.workspace.getConfiguration('mysti');
      if (!saved.some(old => old.key === key && old.target === target)) saved.push({ key, target,
        value: target === vscode.ConfigurationTarget.Global ? config.inspect(key)?.globalValue : config.inspect(key)?.workspaceValue });
      await config.update(key, value, target);
    }
    async function revealChat(): Promise<void> {
      assert.ok(chatTab); const group = vscode.window.tabGroups.all.find(value => value.tabs.includes(chatTab!)); assert.ok(group);
      const index = group.tabs.indexOf(chatTab); assert.ok(index >= 0 && index < 9);
      assert.strictEqual(vscode.window.tabGroups.activeTabGroup, group);
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`); assert.strictEqual(group.activeTab, chatTab); await workbench.bringToFront();
    }
    async function selectAgent(provider: string, expected: string): Promise<void> {
      await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent=${JSON.stringify(provider)}]:not(.disabled)`).click();
      await until('The requested provider must reach the actual picker', async () => (await frame.locator('#agent-name').innerText()).includes(expected));
    }
    async function attach(file: string): Promise<void> {
      assert.ok(path.dirname(file) === fixtureDirectory);
      const count = (await events('fileAttachmentSelected')).length;
      await frame.locator('#attach-btn').click();
      const input = workbench.locator('.quick-input-widget input[type="text"]');
      await input.waitFor({ state: 'visible' });
      await input.fill(file); await input.press('Enter');
      await until('Actual VS Code Attach picker must return the owned file', async () => (await events('fileAttachmentSelected')).length > count);
      await input.waitFor({ state: 'hidden' });
      const selected = (await events('fileAttachmentSelected')).at(-1).payload.attachments;
      assert.deepStrictEqual(selected.map((a: any) => a.fileName), [path.basename(file)]);
    }
    async function composer(expectedDraft: string, attachments: string[]): Promise<void> {
      assert.strictEqual(await frame.locator('#message-input').inputValue(), expectedDraft);
      assert.deepStrictEqual(await frame.locator('#attachment-previews .attachment-name').allTextContents(), attachments);
    }
    async function switchConversation(id: string): Promise<void> {
      const count = (await events('conversationHistory')).length;
      await frame.locator('#history-btn').click();
      await until('Real history menu must receive its conversation identities', async () => (await events('conversationHistory')).length > count);
      const payload = (await events('conversationHistory')).at(-1).payload;
      const index = payload.ids.indexOf(id); assert.ok(index >= 0);
      await frame.locator('#history-menu .history-item').nth(index).locator('.history-item-info').click();
      await until('History selection must restore the intended chat', async () => (await events('conversationChanged')).at(-1)?.payload.id === id);
    }
    async function assertNoFailure(): Promise<void> {
      const all = await events();
      for (const event of all.filter(item => item.type === 'permissionRequest')) {
        assert.match(event.payload.id, /^[a-zA-Z0-9_-]+$/);
        const deny = frame.locator(`.permission-card[data-id=${JSON.stringify(event.payload.id)}] [data-action="deny"]`);
        if (await deny.isVisible()) await deny.click();
      }
      assert.strictEqual(all.some(event => ['authError', 'error', 'permissionRequest', 'toolUse'].includes(event.type)), false, 'This inline-only task must not require tools or fail authentication');
      assert.strictEqual(all.some(event => event.type === 'collaborator' && ['collab_error', 'collab_skipped', 'collab_tool_use'].includes(event.payload.type)), false);
      assert.strictEqual(all.some(event => event.type === 'collaborator' && event.payload.type === 'collab_complete' && event.payload.hasError), false);
    }

    before(async () => {
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
      assert.ok(profile && path.isAbsolute(profile) && fs.existsSync(path.join(profile, 'DevToolsActivePort')));
      artifactDir = process.env.MYSTI_PC06_ARTIFACT_DIR || path.join(profile, 'pc06-evidence'); fs.mkdirSync(artifactDir, { recursive: true });
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      const requested = process.env.MYSTI_TEST_EXTENSION_PATH; assert.ok(requested && path.isAbsolute(requested));
      extensionPath = fs.realpathSync(extension.extensionPath); extensionHash = hash(fs.readFileSync(path.join(extensionPath, 'dist/extension.js')));
      record('loaded-extension-identity', { actualPath: extensionPath, requestedPath: fs.realpathSync(requested), actualHash: extensionHash,
        requestedHash: hash(fs.readFileSync(path.join(requested, 'dist/extension.js'))), vscode: vscode.version });
      assert.strictEqual(extensionPath, fs.realpathSync(requested)); assert.strictEqual(extensionHash, hash(fs.readFileSync(path.join(requested, 'dist/extension.js'))));
      const claude = process.env.MYSTI_PC06_CLAUDE_PATH, codex = process.env.MYSTI_PC06_CODEX_PATH, node = process.env.MYSTI_PC06_NODE_PATH;
      for (const file of [claude, codex, node]) assert.ok(file && path.isAbsolute(file) && fs.existsSync(file));
      assert.notStrictEqual(process.platform, 'win32', 'The selected-CLI wrappers use POSIX shebangs');
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
      const workspace = fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath);
      assert.strictEqual(workspace, fs.realpathSync(path.join(__dirname, 'fixture-workspace')));
      fixtureDirectory = fs.mkdtempSync(path.join(workspace, 'pc06-'));
      initialFile = path.join(fixtureDirectory, 'PC06_ATTACHMENT_INITIAL.txt'); draftFile = path.join(fixtureDirectory, 'PC06_ATTACHMENT_DRAFT.txt');
      fs.writeFileSync(initialFile, initialAttachment); fs.writeFileSync(draftFile, draftAttachment);
      cliDirectory = fs.mkdtempSync(path.join(artifactDir, 'cli-'));
      const hooks = path.join(cliDirectory, 'claude-settings.json'); fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
      await configure('claudeCodePath', createComposerCli(cliDirectory, 'claude-code', claude!, node!, hooks), vscode.ConfigurationTarget.Global);
      await configure('codexPath', createComposerCli(cliDirectory, 'openai-codex', codex!, node!, hooks), vscode.ConfigurationTarget.Global);
      for (const [key, value] of Object.entries({ defaultAgent: 'claude-code', defaultProvider: 'claude-code', defaultModel: 'sonnet',
        claudeCodeModel: 'sonnet', codexModel: 'gpt-5.6-sol', codexProfile: '', defaultEffortLevel: 'low', defaultThinkingLevel: 'none',
        defaultMode: 'ask-before-edit', accessLevel: 'read-only', autoContext: false, showSuggestions: false, 'agents.autoSuggest': false })) {
        if (key !== 'codexProfile') await configure(key, undefined, vscode.ConfigurationTarget.Workspace);
        await configure(key, value, vscode.ConfigurationTarget.Global);
      }
      simpleDialogOriginal = vscode.workspace.getConfiguration('files').inspect('simpleDialog.enable')?.globalValue;
      await vscode.workspace.getConfiguration('files').update('simpleDialog.enable', true, vscode.ConfigurationTarget.Global); simpleDialogChanged = true;
      const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const context of browser.contexts()) await context.addInitScript(observeComposerSends);
      for (const page of browser.contexts().flatMap(context => context.pages())) if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) originalTabs.add(tab);
      await extension.activate();
      const previousFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('Dedicated test chat tab must open', async () => {
        chatTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => !originalTabs.has(tab) && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat'));
        return !!chatTab;
      });
      await revealChat();
      await until('The dedicated chat webview must initialize', async () => {
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (previousFrames.has(candidate)) continue;
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() &&
            (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) candidates.push(candidate); } catch { /* Mounting. */ }
        }
        if (candidates.length !== 1) return false; frame = candidates[0]; return true;
      }, 30_000);
      const parent = frame.parentFrame(); assert.ok(parent); bridgeFrame = parent;
      assert.strictEqual(await bridgeFrame.evaluate(() => !!(globalThis as any).__pc06BridgeActive), true, 'Observe the actual outer bridge before acquisition; do not seed messages');
      if (await frame.locator('#setup-wizard').isVisible()) await frame.locator('.wizard-skip-btn').click();
      await frame.evaluate(() => {
        const win = globalThis as any; win.__pc06Events = [];
        const attachments = (values: any[]) => (values || []).map(a => ({ fileName: a.fileName, size: a.size }));
        win.__pc06Listener = (event: any) => {
          const message = event.data, p = message?.payload || {};
          if (!['conversationChanged', 'conversationHistory', 'messageAdded', 'responseStarted', 'responseChunk', 'responseComplete', 'collaborator',
            'fileAttachmentSelected', 'attachmentWarning', 'toolUse', 'permissionRequest', 'authError', 'error'].includes(message?.type)) return;
          let payload: any = {};
          if (message.type === 'conversationChanged') payload = { id: p.id };
          if (message.type === 'conversationHistory') payload = { ids: (p.conversations || []).map((c: any) => c.id), currentId: p.currentId };
          if (message.type === 'fileAttachmentSelected') payload = { attachments: attachments(p.attachments) };
          if (message.type === 'messageAdded') payload = { id: p.id, role: p.role, content: p.role === 'user' ? p.content : undefined, attachments: attachments(p.attachments) };
          if (message.type === 'responseStarted') payload = { provider: p.provider, model: p.model, participants: p.participants };
          if (message.type === 'responseChunk') payload = { type: p.type, ...(p.type === 'text' ? { content: p.content } : {}) };
          if (message.type === 'responseComplete') payload = { message: p.message && { id: p.message.id, content: p.message.content,
            provider: p.message.provider, model: p.message.model, participants: p.message.participants, toolCount: p.message.toolCalls?.length || 0 } };
          if (message.type === 'collaborator') payload = { type: p.type, agentId: p.agentId, runId: p.runId, collaboratorId: p.collaboratorId, hasError: p.hasError,
            ...(p.type === 'collab_text' ? { content: p.content } : {}), ...(p.type === 'collab_complete' ? { responseText: p.responseText } : {}) };
          if (message.type === 'permissionRequest') payload = { id: p.id };
          if (message.type === 'toolUse') payload = { id: p.id, name: p.name };
          win.__pc06Events.push({ type: message.type, payload, sequence: win.__pc06Events.length, at: Date.now() });
        };
        win.addEventListener('message', win.__pc06Listener);
      });
      await frame.locator('#new-conversation-btn').click();
      await until('New conversation must have a host identity', async () => (await events('conversationChanged')).length === 1);
      conversationId = (await events('conversationChanged'))[0].payload.id;
      await selectAgent('claude-code', 'Claude');
      record('fixture-scope', { fixtureDirectory, claude, codex,
        scope: 'Small inline retry/cache problem and two test-owned text files; not full F2. Four conversational requests; product title/classification calls and idle warmups are counted separately. No tools, account mutation, 8h/24h soak or restart-durable draft claim.',
        supportedDraftBoundary: 'Same live webview: agent/menu changes, conversation navigation and tab hide/reveal. Closing/reloading the webview is not claimed to retain unsent drafts.',
        queueReordering: 'NOT_REACHABLE: FIFO with removal only', midTurnSteering: 'UNSUPPORTED: Enter/Tab queue a later turn' });
    });

    afterEach(async function () {
      if (!artifactDir) return;
      record(this.currentTest?.state === 'failed' ? 'case-failed' : 'case-complete', { title: this.currentTest?.title,
        error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message },
        events: frame && await events().catch(() => []), uiSends: bridgeFrame && await uiSends().catch(() => []), wireReceipts: receipts() });
      if (this.currentTest?.state === 'failed' && workbench) await workbench.screenshot({ path: path.join(artifactDir, 'failure.png') }).catch(() => {});
    });
    after(async () => {
      let remaining: number[] = [], durationMs = 0;
      try {
        if (frame) {
          if (await frame.locator('#stop-btn').isVisible().catch(() => false)) await frame.locator('#stop-btn').click().catch(() => {});
          await frame.evaluate(() => { const win = globalThis as any; win.removeEventListener('message', win.__pc06Listener); }).catch(() => {});
        }
        if (cliDirectory) processes();
        const started = Date.now(); if (chatTab) await vscode.window.tabGroups.close(chatTab);
        remaining = cliDirectory ? processes() : [];
        while (remaining.length && Date.now() - started < 10_000) { await new Promise(resolve => setTimeout(resolve, 100)); remaining = processes(); }
        durationMs = Date.now() - started;
      } finally {
        for (const previous of saved.reverse()) await vscode.workspace.getConfiguration('mysti').update(previous.key, previous.value, previous.target);
        if (simpleDialogChanged) await vscode.workspace.getConfiguration('files').update('simpleDialog.enable', simpleDialogOriginal, vscode.ConfigurationTarget.Global);
        for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) if (!originalTabs.has(tab) && tab.input instanceof vscode.TabInputText && path.dirname(tab.input.uri.fsPath) === fixtureDirectory) await vscode.window.tabGroups.close(tab);
        await browser?.close();
      }
      // The test extension is still inside the editor. Do not call a shared
      // warm cache an orphan or claim editor-lifetime cleanup before exit.
      // The external runner must additionally read late append-only receipt
      // entries, since auxiliary workers can be replenished after this scan.
      if (cliDirectory) remaining = processes();
      if (artifactDir) fs.writeFileSync(path.join(artifactDir, 'process-ownership.json'), JSON.stringify({
        capturedAt: new Date().toISOString(), extensionHostParentPid: process.ppid, extensionHostPid: process.pid,
        conversational: { lifetime: 'private chat tab', observedPids: [...ownedPids], remainingAfterTabClose: remaining, durationMs },
        auxiliary: { lifetime: 'test editor window', observedPids: [...auxiliaryPids], remainingWhileEditorOpen: liveAuxiliaryPids,
          invocationCount: receipts().filter(receipt => receipt.event === 'auxiliary-input').length,
          warmOrTitleProcessStarts: receipts().filter(receipt => receipt.event === 'auxiliary-start').length,
          afterEditorExitStatus: 'PENDING_EXTERNAL_CHECK' },
        receiptPaths: cliDirectory ? ['claude-code', 'openai-codex'].map(provider => path.join(cliDirectory, provider + '-receipts.jsonl')) : [],
        externalCheck: 'After the test editor exits, merge every start/auxiliary-start PID from the final receipt files with observed descendants and verify none remain. No argv, env or prompt inspection is needed.',
      }, null, 2));
      if (artifactDir) record('cleanup', { ownedProcessCount: ownedPids.size, remainingOwnedPids: remaining, durationMs,
        scope: 'Per-conversation persistent transports. Shared auxiliary title/warmup workers belong to the extension lifecycle.',
        auxiliaryInvocations: receipts().filter(receipt => receipt.event === 'auxiliary-input').length,
        auxiliaryProcessStarts: receipts().filter(receipt => receipt.event === 'auxiliary-start').length,
        auxiliaryObservedPids: [...auxiliaryPids], auxiliaryRemainingWhileEditorOpen: liveAuxiliaryPids,
        auxiliaryAfterEditorExitStatus: 'PENDING_EXTERNAL_CHECK',
        initialFileUnchanged: !initialFile || fs.readFileSync(initialFile, 'utf8') === initialAttachment,
        draftFileUnchanged: !draftFile || fs.readFileSync(draftFile, 'utf8') === draftAttachment,
        immutableExtension: !extensionPath || hash(fs.readFileSync(path.join(extensionPath, 'dist/extension.js'))) === extensionHash });
      assert.deepStrictEqual(remaining, []);
      if (initialFile) assert.strictEqual(fs.readFileSync(initialFile, 'utf8'), initialAttachment);
      if (draftFile) assert.strictEqual(fs.readFileSync(draftFile, 'utf8'), draftAttachment);
      if (extensionPath) assert.strictEqual(hash(fs.readFileSync(path.join(extensionPath, 'dist/extension.js'))), extensionHash);
    });

    it('retains a multiline draft and attachment through real menus, conversation navigation and tab hide/reveal without sending', async () => {
      await frame.locator('#message-input').fill(initialPrompt); await attach(initialFile);
      for (const [provider, name] of [['openai-codex', 'Codex'], ['claude-code', 'Claude']]) {
        await selectAgent(provider, name);
        await frame.locator('#model-menu-btn').click(); await frame.locator('#model-menu').waitFor({ state: 'visible' });
        await frame.locator('#message-input').click();
        await frame.locator('#tools-menu-btn').click(); await frame.locator('#tools-menu').waitFor({ state: 'visible' });
        await frame.locator('#message-input').click(); await composer(initialPrompt, [path.basename(initialFile)]);
      }
      await frame.locator('#new-conversation-btn').click();
      await until('Other conversation must activate', async () => (await events('conversationChanged')).at(-1)?.payload.id !== conversationId);
      await composer('', []);
      const otherId = (await events('conversationChanged')).at(-1).payload.id;
      await frame.locator('#message-input').fill('PC06_CURRENT_REQUEST:OTHER_DRAFT\nUnsent separate-chat notes.');
      await switchConversation(conversationId); await composer(initialPrompt, [path.basename(initialFile)]);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(initialFile)); await vscode.window.showTextDocument(document);
      assert.strictEqual(chatTab!.isActive, false); await revealChat(); await composer(initialPrompt, [path.basename(initialFile)]);
      assert.deepStrictEqual(await uiSends(), []); assert.deepStrictEqual(receipts().filter(receipt => receipt.event === 'request'), []);
      assert.strictEqual((await events('messageAdded')).filter(event => event.payload.role === 'user').length, 0);
      record('draft-boundaries', { conversationId, otherId, draftSha256: hash(initialPrompt), attachment: path.basename(initialFile),
        menus: ['agent', 'model', 'tools'], tabHideReveal: true, perConversationDraft: true, actualInferenceRequests: 0 });
      ready = true;
    });

    it('runs initial → Codex amendment A → Claude amendment C → Codex second opinion once each while retaining the unrelated draft', async () => {
      assert.strictEqual(ready, true); await composer(initialPrompt, [path.basename(initialFile)]);
      await frame.locator('#send-btn').click();
      await frame.locator('#stop-btn').waitFor({ state: 'visible' });
      for (const [text, key] of [[amendmentA, 'Enter'], [removedB, 'Tab'], [amendmentC, 'Enter']]) {
        await frame.locator('#message-input').fill(text); await frame.locator('#message-input').press(key);
      }
      assert.deepStrictEqual(await frame.locator('.queued-chip-text').allTextContents(), [amendmentA, removedB, amendmentC]);
      await frame.locator('.queued-chip').nth(1).locator('.queued-chip-remove').click();
      assert.deepStrictEqual(await frame.locator('.queued-chip-text').allTextContents(), [amendmentA, amendmentC]);
      assert.strictEqual((await uiSends()).length, 1, 'Busy Enter/Tab may not inject a second request into the active transport');
      await frame.locator('#message-input').fill(draft); await attach(draftFile);
      await composer(draft, [path.basename(draftFile)]);
      await until('First real text must arrive while Stop remains available', async () => {
        await assertNoFailure();
        return (await events('responseChunk')).some(event => event.payload.type === 'text' && event.payload.content);
      }, 120_000);
      assert.strictEqual(await frame.locator('#stop-btn').isVisible(), true);
      let sampledAt = 0;
      await until('Both retained queued amendments must drain to real responses', async () => {
        await assertNoFailure(); await composer(draft, [path.basename(draftFile)]);
        if (Date.now() - sampledAt > 500) { processes(); sampledAt = Date.now(); }
        return (await events('responseComplete')).length === 3;
      }, 360_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      assert.strictEqual(await frame.locator('.queued-chip').count(), 0);
      const firstThree = await uiSends(); assert.deepStrictEqual(firstThree.map(send => send.content), [initialPrompt, amendmentA, amendmentC]);
      assert.deepStrictEqual(firstThree.map(send => send.attachments.map((a: any) => a.fileName)), [[path.basename(initialFile)], [], []]);
      const completions = await events('responseComplete');
      assert.strictEqual(completions[0].payload.message.provider, 'claude-code');
      assert.ok(completions[0].payload.message.content.includes('PC06_INITIAL_VALUES:[73,146,500]'));
      for (const [index, provider, sentinel] of [[1, 'openai-codex', 'PC06_A_VALUES:[73,146,500]'], [2, 'claude-code', 'PC06_C_VALUES:[73,146,250]']] as const) {
        const message = completions[index].payload.message;
        assert.deepStrictEqual(message.participants, [provider]); assert.ok(message.content.includes(sentinel));
      }
      const sourceUser = (await events('messageAdded')).find(event => event.payload.role === 'user' && event.payload.content === initialPrompt); assert.ok(sourceUser);
      const originalAnswer = frame.locator(`.message.assistant[data-id=${JSON.stringify(completions[0].payload.message.id)}]`);
      await originalAnswer.locator('[data-second-opinion]').click();
      assert.strictEqual(await frame.locator('.second-opinion-item[data-agent="claude-code"]').count(), 0);
      await frame.locator('.second-opinion-item[data-agent="openai-codex"]').click();
      await composer(draft, [path.basename(draftFile)]);
      await until('Actual Codex second opinion must complete', async () => {
        await assertNoFailure(); await composer(draft, [path.basename(draftFile)]);
        if (Date.now() - sampledAt > 500) { processes(); sampledAt = Date.now(); }
        return (await events('responseComplete')).length === 4;
      }, 150_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const sends = await uiSends(); assert.strictEqual(sends.length, 4); assert.ok(sends.every(send => send.fixture));
      assert.strictEqual(sends[3].content, initialPrompt, 'Opinion replays original Markdown exactly without changing mentions or whitespace');
      assert.deepStrictEqual(sends[3].secondOpinion, { provider: 'openai-codex', messageId: sourceUser.payload.id });
      assert.deepStrictEqual(sends[3].attachments.map((a: any) => a.fileName), [path.basename(initialFile)]);
      const last = (await events('responseComplete'))[3].payload.message;
      assert.strictEqual(last.provider, 'openai-codex'); assert.strictEqual(last.model, 'gpt-5.6-sol');
      assert.ok(last.content.includes('PC06_INITIAL_VALUES:[73,146,500]'));
      const users = (await events('messageAdded')).filter(event => event.payload.role === 'user');
      assert.deepStrictEqual(users.map(event => event.payload.content), [initialPrompt, amendmentA, amendmentC, initialPrompt]);
      assert.strictEqual(new Set(users.map(event => event.payload.id)).size, 4);
      assert.deepStrictEqual(users.map(event => event.payload.attachments.map((a: any) => a.fileName)), [[path.basename(initialFile)], [], [], [path.basename(initialFile)]]);
      const wire = receipts().filter(receipt => receipt.event === 'request'); assert.strictEqual(wire.length, 4, 'Four accepted sends must produce exactly four actual provider requests');
      assert.deepStrictEqual(wire.map(receipt => receipt.provider), ['claude-code', 'openai-codex', 'claude-code', 'openai-codex']);
      for (const [index, marker] of ['INITIAL', 'A', 'C', 'INITIAL'].entries()) assert.ok(wire[index].markers.includes(marker));
      assert.ok(wire.every(receipt => !receipt.markers.includes('B_REMOVED') && !receipt.markers.includes('DRAFT') && !receipt.markers.includes('OTHER_DRAFT')));
      assert.ok(wire.every(receipt => !receipt.attachments.includes(path.basename(draftFile))));
      assert.ok(wire[0].attachments.includes(path.basename(initialFile))); assert.ok(wire[3].attachments.includes(path.basename(initialFile)));
      const all = await events(), completed = all.filter(event => event.type === 'responseComplete'), started = all.filter(event => event.type === 'responseStarted');
      assert.strictEqual(started.length, 4); assert.strictEqual(completed.length, 4);
      for (let index = 1; index < 4; index++) assert.ok(started[index].sequence > completed[index - 1].sequence, 'Each queued/opinion turn begins after its predecessor completes');
      assert.deepStrictEqual((await events('collaborator')).filter(event => event.payload.type === 'collab_complete').map(event => event.payload.agentId), ['openai-codex', 'claude-code']);
      assert.strictEqual(await frame.locator('#messages .message.assistant').count(), 4);
      assert.strictEqual(await frame.locator('#messages .message.user').count(), 4);
      await composer(draft, [path.basename(draftFile)]);
      record('four-request-queue-and-opinion', { conversationId, exactUiPrompts: sends, wireRequests: wire,
        auxiliaryInvocations: receipts().filter(receipt => receipt.event === 'auxiliary-input').length,
        auxiliaryProcessStarts: receipts().filter(receipt => receipt.event === 'auxiliary-start').length,
        removedAmendmentDispatched: false, draftDispatched: false, originalOpinionAttachmentRetained: true,
        orderedCompletions: completed.map(event => ({ sequence: event.sequence, ...event.payload.message })),
        scope: 'Four real requests in one conversation; two retained FIFO amendments, removal, original-source second opinion. No live steering, reordering or elapsed soak.' });
      await workbench.screenshot({ path: path.join(artifactDir, 'queue-second-opinion.png') });
    });
  });
}
