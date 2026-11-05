/**
 * PC-07 opt-in actual-editor Stop/session recovery. Eight conversational
 * requests across existing Claude/Codex accounts. No account/config-file writes;
 * only unique test-owned canaries are even proposed as tool targets. Neither
 * writer is approved. No synthetic webview messages or private extension calls.
 * MYSTI_PC07=1, --grep 'PC-07 real editor'; fresh runner profile and immutable
 * MYSTI_TEST_EXTENSION_PATH, MYSTI_PC07_{CLAUDE,CODEX,NODE}_PATH are required.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

type ProcessRow = [pid: number, parent: number, startedAt: string, executableBasename?: string];
type ProcessOwners = Map<number, Set<string>>;
function ownsProcess(owners: ProcessOwners, row: ProcessRow): boolean { return owners.get(row[0])?.has(row[2]) === true; }
/** Expand only through an ancestor's observed birth identity. Reused PIDs of
 * short-lived sampler children may never acquire unrelated process trees. */
function expandProcessOwnership(rows: ProcessRow[], owners: ProcessOwners): void {
  const byPid = new Map(rows.map(row => [row[0], row]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = byPid.get(row[1]);
      if (!parent || !ownsProcess(owners, parent) || ownsProcess(owners, row)) continue;
      const births = owners.get(row[0]) || new Set<string>(); births.add(row[2]); owners.set(row[0], births); changed = true;
    }
  }
}

/** Byte-for-byte forwarding, with only session hashes and known marker names
 * retained. Claude's owned settings disable personal hooks for --print calls.
 * No raw session IDs, prompts, outputs, tool arguments or environment receipts.
 */
function createCancellationCli(directory: string, provider: string, executable: string, node: string, hooks: string, nonce: string): string {
  const launcher = path.join(directory, provider + '-stop-fixture');
  const receipts = path.join(directory, provider + '-receipts.jsonl');
  fs.writeFileSync(launcher, `#!${node}
'use strict';
const fs=require('fs'),{spawn}=require('child_process'),{createHash}=require('crypto'),{StringDecoder}=require('string_decoder');
const provider=${JSON.stringify(provider)},args=process.argv.slice(2),flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const persistent=provider==='claude-code'?flag('--input-format')==='stream-json'&&flag('--output-format')==='stream-json':args.includes('app-server');
const inference=provider==='claude-code'&&args.includes('--print');
const digest=value=>typeof value==='string'&&value?createHash('sha256').update(value).digest('hex'):undefined;
const record=value=>{if(persistent||inference)fs.appendFileSync(${JSON.stringify(receipts)},JSON.stringify({provider,at:Date.now(),wrapperPid:process.pid,...value})+'\\n',{mode:0o600});};
const child=spawn(${JSON.stringify(executable)},inference?[...args,'--settings',${JSON.stringify(hooks)}]:args,{env:process.env,stdio:['pipe','pipe','pipe']});
const blocks=v=>typeof v==='string'?v:Array.isArray(v)?v.filter(x=>x&&x.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\\n'):'';
let sessionHash=digest(flag('--resume')),auxiliaryInput=false;
function captureInput(line){
 if(!persistent)return;let v;try{v=JSON.parse(line);}catch{return;}
 if(provider==='openai-codex'&&v.method==='thread/resume')sessionHash=digest(v.params?.threadId);
 if(provider==='openai-codex'&&v.method==='turn/interrupt')record({event:'interrupt',sessionHash:digest(v.params?.threadId)});
 let prompt,method;if(provider==='claude-code'&&v.type==='user'&&v.message?.role==='user'){prompt=blocks(v.message.content);method='user';}
 if(provider==='openai-codex'&&v.method==='turn/start'){prompt=blocks(v.params?.input);method='turn/start';sessionHash=digest(v.params?.threadId)||sessionHash;}
 if(typeof prompt!=='string')return;
 const markers=['CLAUDE_STOP','QUEUED_WRITER','CLAUDE_RECOVER','AFTER_SHUTDOWN','APPROVAL_STOP','CODEX_STOP','CODEX_RECOVER','AFTER_CLEAR','NEW_CHAT'].filter(x=>prompt.includes('PC07_CURRENT_REQUEST:'+x));
 record({event:'request',method,markers,sessionHash,containsPriorNonce:prompt.includes(${JSON.stringify(nonce)})});
}
function captureOutput(line){
 if(!persistent)return;let v;try{v=JSON.parse(line);}catch{return;}
 const id=provider==='claude-code'?v.type==='system'&&v.subtype==='init'?v.session_id:undefined:v.result?.thread?.id||(v.method==='thread/started'?v.params?.thread?.id:undefined);
 if(typeof id==='string'){sessionHash=digest(id);record({event:'session',sessionHash});}
}
function inspect(stream,capture){const decoder=new StringDecoder('utf8');let pending='',discard=false;stream.on('data',chunk=>{
 const pieces=decoder.write(chunk).split('\\n');for(let i=0;i<pieces.length;i++){if(!discard){if(pending.length+pieces[i].length>1024*1024){pending='';discard=true;}else pending+=pieces[i];}
 if(i<pieces.length-1){if(!discard)capture(pending);pending='';discard=false;}}});}
inspect(process.stdin,captureInput);inspect(child.stdout,captureOutput);
process.stdin.on('data',chunk=>{if(inference&&!persistent&&!auxiliaryInput&&chunk.length){auxiliaryInput=true;record({event:'auxiliary-input'});}});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
child.on('spawn',()=>record({event:persistent?'start':'auxiliary-start',childPid:child.pid,sessionHash}));
child.on('error',()=>{process.stderr.write('PC07 selected CLI failed to launch.\\n');process.exitCode=1;process.stdin.pause();});
child.on('close',(code,signal)=>{record({event:persistent?'exit':'auxiliary-exit',childPid:child.pid});process.stdin.unpipe(child.stdin);process.stdin.pause();if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});
`, { mode: 0o700 });
  return launcher;
}

if (process.env.MYSTI_PC07 === '1') {
  describe('PC-07 real editor Stop, session reset and next-turn recovery', function () {
    this.timeout(660_000);
    let browser: Browser, workbench: Page, frame: Frame, chatTab: vscode.Tab | undefined;
    let artifactDir: string, cliDirectory: string, fixtureDirectory: string, queuedCanary: string, approvalCanary: string;
    let extensionPath: string, extensionHash: string, originalConversation: string, firstSessionHash: string;
    let completedPhase = 0;
    let sampler: NodeJS.Timeout | undefined;
    let lastRows: ProcessRow[] = [];
    const nonce = 'PC07_MEMORY_' + randomBytes(12).toString('hex');
    const observations: unknown[] = [], allEditorPids = new Set<number>(), conversationPids = new Set<number>(), auxiliaryPids = new Set<number>();
    const stoppedSnapshots = new Map<string, any>();
    const processRoots = new Set([process.pid, process.ppid]);
    const editorBirths: ProcessOwners = new Map(), conversationBirths: ProcessOwners = new Map(), auxiliaryBirths: ProcessOwners = new Map();
    const seenLaunches = new Set<string>(), unidentifiedLaunchPids = new Set<number>();
    const processDetails = new Map<string, { pid: number; startedAt: string; parentPid: number; parentStartedAt?: string; executableBasename: string; firstObservedAt: string; lastObservedAt: string }>();
    const saved: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
    const originalTabs = new Set<vscode.Tab>();
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const markers = ['CLAUDE_STOP', 'QUEUED_WRITER', 'CLAUDE_RECOVER', 'AFTER_SHUTDOWN', 'APPROVAL_STOP', 'CODEX_STOP', 'CODEX_RECOVER', 'AFTER_CLEAR', 'NEW_CHAT'];

    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { ...details, event, at: new Date().toISOString() }; observations.push(entry);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-07]', JSON.stringify(entry));
    }
    function receipts(): any[] {
      if (!cliDirectory) return [];
      return ['claude-code', 'openai-codex'].flatMap(provider => {
        const file = path.join(cliDirectory, provider + '-receipts.jsonl');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      }).sort((a, b) => a.at - b.at);
    }
    function sampleProcesses(): void {
      // Ancestry only, never command lines or process environment. Start before
      // editor interactions and retain descendants even after reparenting.
      lastRows = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')
        .map(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/); assert.ok(match); return [Number(match[1]), Number(match[2]), match[3].trim(), path.basename(match[4])] as ProcessRow; });
      const byPid = new Map(lastRows.map(row => [row[0], row]));
      for (const root of processRoots) if (!editorBirths.has(root) && byPid.has(root)) editorBirths.set(root, new Set([byPid.get(root)![2]]));
      for (const receipt of receipts()) {
        const owner = receipt.event === 'start' ? conversationBirths : receipt.event === 'auxiliary-start' ? auxiliaryBirths : undefined;
        const key = `${receipt.event}:${receipt.wrapperPid}:${receipt.at}`;
        if (!owner || seenLaunches.has(key)) continue;
        seenLaunches.add(key);
        for (const pid of [receipt.wrapperPid, receipt.childPid]) if (Number.isInteger(pid)) {
          const row = byPid.get(pid), born = row && Date.parse(row[2]);
          if (row && Number.isFinite(born) && born! <= receipt.at && receipt.at - born! < 15_000) {
            const births = owner.get(pid) || new Set<string>(); births.add(row[2]); owner.set(pid, births);
          } else { unidentifiedLaunchPids.add(pid); }
        }
      }
      for (const [owners, pids] of [[editorBirths, allEditorPids], [conversationBirths, conversationPids], [auxiliaryBirths, auxiliaryPids]] as const) {
        expandProcessOwnership(lastRows, owners); for (const pid of owners.keys()) pids.add(pid);
      }
      const observedAt = new Date().toISOString();
      for (const row of lastRows) {
        if (![editorBirths, conversationBirths, auxiliaryBirths].some(owners => ownsProcess(owners, row))) continue;
        const key = `${row[0]}|${row[2]}`, previous = processDetails.get(key);
        processDetails.set(key, { pid: row[0], startedAt: row[2], parentPid: row[1], parentStartedAt: byPid.get(row[1])?.[2],
          executableBasename: row[3] || '[unknown]', firstObservedAt: previous?.firstObservedAt || observedAt, lastObservedAt: observedAt });
      }
      const identities = (owners: ProcessOwners) => [...owners].flatMap(([pid, starts]) => [...starts].map(startedAt => ({ pid, startedAt })));
      if (artifactDir) fs.writeFileSync(path.join(artifactDir, 'process-ancestry.json'), JSON.stringify({
        sampledAt: new Date().toISOString(), extensionHostPid: process.pid, editorRootPid: process.ppid,
        editorObservedPids: [...allEditorPids], conversationObservedPids: [...conversationPids], auxiliaryReceiptPids: [...auxiliaryPids],
        processIdentities: { editor: identities(editorBirths), conversational: identities(conversationBirths), auxiliaryReceipts: identities(auxiliaryBirths) },
        processDetails: [...processDetails.values()],
        receiptLaunchPidsWithoutBirthIdentity: [...unidentifiedLaunchPids],
        remainingEditorPids: lastRows.filter(row => ownsProcess(editorBirths, row)).map(([pid]) => pid),
        scope: 'Full test-editor descendant tree by PID plus lstart birth identity; includes sampler helpers and direct title/classifier workers. Reused PIDs cannot acquire unrelated descendants. Transient children between100ms samples can be missed.',
        receiptPaths: cliDirectory ? ['claude-code', 'openai-codex'].map(provider => path.join(cliDirectory, provider + '-receipts.jsonl')) : [],
        afterEditorExitStatus: 'PENDING_EXTERNAL_CHECK',
      }, null, 2));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function events(type?: string): Promise<any[]> {
      const result = await frame.evaluate(() => (globalThis as any).__pc07Events || []);
      return type ? result.filter((event: any) => event.type === type) : result;
    }
    function assertCanariesAbsent(): void {
      assert.strictEqual(fs.existsSync(queuedCanary), false, 'Stop must not dispatch the queued writer');
      assert.strictEqual(fs.existsSync(approvalCanary), false, 'A stopped permission request must never write the proposed file');
    }
    async function configure(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
      const config = vscode.workspace.getConfiguration('mysti');
      if (!saved.some(old => old.key === key && old.target === target)) saved.push({ key, target,
        value: target === vscode.ConfigurationTarget.Global ? config.inspect(key)?.globalValue : config.inspect(key)?.workspaceValue });
      await config.update(key, value, target);
    }
    async function selectAgent(provider: string, label: string): Promise<void> {
      await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent=${JSON.stringify(provider)}]:not(.disabled)`).click();
      await until('Selected provider must settle', async () => (await frame.locator('#agent-name').innerText()).includes(label));
    }
    async function assertNoError(offset: number): Promise<void> {
      const fresh = (await events()).slice(offset);
      assert.strictEqual(fresh.some(event => ['error', 'authError'].includes(event.type)), false, 'A genuine provider error must not count as cancellation or recovery');
      assertCanariesAbsent();
    }
    async function forbidTools(offset: number): Promise<void> {
      const fresh = (await events()).slice(offset);
      for (const event of fresh.filter(item => item.type === 'permissionRequest')) {
        const deny = frame.locator(`.permission-card[data-id=${JSON.stringify(event.payload.id)}] [data-action="deny"]`);
        if (await deny.isVisible()) await deny.click();
      }
      assert.strictEqual(fresh.some(event => ['permissionRequest', 'toolUse'].includes(event.type)), false, 'The inline analysis/recovery turn may not use a tool');
    }
    async function submit(marker: string, instructions: string): Promise<number> {
      assert.ok(markers.includes(marker));
      const offset = (await events()).length;
      await frame.locator('#message-input').fill(`PC07_CURRENT_REQUEST:${marker}\n${instructions}`);
      await frame.locator('#send-btn').click();
      await until('The selected CLI must receive the actual request', async () => receipts().some(receipt =>
        receipt.event === 'request' && receipt.markers.includes(marker)), 30_000);
      return offset;
    }
    function currentSession(provider: string): string {
      const receipt = receipts().filter(item => item.provider === provider && item.event === 'session').at(-1);
      assert.match(receipt?.sessionHash || '', /^[a-f0-9]{64}$/); return receipt.sessionHash;
    }
    async function stop(offset: number, label: string): Promise<void> {
      const started = Date.now();
      const queuedBefore = await frame.locator('.queued-chip').count();
      const wireRequestsBefore = receipts().filter(item => item.event === 'request').length;
      await frame.locator('#stop-btn').click();
      await until('Stop must acknowledge and restore the composer promptly', async () =>
        (await events()).slice(offset).some(event => event.type === 'requestCancelled') && !await frame.locator('#stop-btn').isVisible(), 5000);
      assert.strictEqual((await events()).slice(offset).filter(event => event.type === 'requestCancelled').length, 1);
      assert.strictEqual(await frame.locator('#message-input').isEnabled(), true);
      assert.strictEqual(await frame.locator('.queued-chip').count(), queuedBefore, 'Stop preserves queued instructions paused for an explicit later user decision');
      assert.strictEqual(await frame.locator('#messages .message.streaming').count(), 0);
      assert.strictEqual(await frame.locator('#messages .tool-call.running').count(), 0);
      await assertNoError(offset);
      const stoppedAt = (await events()).length;
      // A bounded quiet window detects late bytes before immediate recovery.
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.strictEqual((await events()).slice(stoppedAt).some(event => event.type === 'responseChunk'), false, 'Old response bytes must not escape after Stop acknowledgement');
      assert.strictEqual(receipts().filter(item => item.event === 'request').length, wireRequestsBefore, 'Stop may not dispatch a retained queued instruction');
      const fresh = (await events()).slice(offset);
      assert.strictEqual(fresh.filter(event => event.type === 'responseComplete').length, 0, 'Stop is one cancelled terminal, never a completed response');
      const text = fresh.filter(event => event.type === 'responseChunk' && event.payload.type === 'text').map(event => event.payload.content || '').join('');
      const partial = fresh.find(event => event.type === 'requestCancelled').payload.message;
      if (text) assert.ok(partial?.id, 'Real partial text must receive a persisted message identity at Stop');
      if (partial) {
        assert.strictEqual(partial.content, text.replace(/<<<MYSTI_CONNECT:[a-z0-9._-]*>>>/gi, ''), 'Stop snapshot preserves streamed text with only the host control-marker removal');
        assert.strictEqual(partial.provider, fresh.find(event => event.type === 'responseStarted')?.payload.provider);
        assert.ok(partial.toolCalls.every((tool: any) => !['running', 'pending'].includes(tool.status)), 'Interrupted tools must settle in the persisted snapshot');
        assert.strictEqual(await frame.locator(`.message.assistant[data-id=${JSON.stringify(partial.id)}]`).count(), 1, 'The stopped bubble must use its persisted identity exactly once');
        stoppedSnapshots.set(partial.id, partial);
      }
      assertCanariesAbsent();
      record('stopped', { label, acknowledgementMs: Date.now() - started - 300, requestCancelledCount: 1,
        partialTextChars: text.length, persistedSnapshot: partial, pausedQueueCount: queuedBefore,
        pendingPermissionCards: await frame.locator('.permission-card.pending').count() });
    }
    async function complete(marker: string, instructions: string, provider: string, expected: string): Promise<{ message: any; offset: number }> {
      const offset = await submit(marker, instructions);
      await until('A real next turn must complete', async () => {
        await assertNoError(offset); await forbidTools(offset);
        return (await events()).slice(offset).some(event => event.type === 'responseComplete');
      }, 120_000);
      await frame.locator('#stop-btn').waitFor({ state: 'hidden' });
      const fresh = (await events()).slice(offset), completes = fresh.filter(event => event.type === 'responseComplete');
      assert.strictEqual(completes.length, 1); assert.strictEqual(fresh.filter(event => event.type === 'responseStarted').length, 1);
      assert.strictEqual(completes[0].payload.message.provider, provider);
      assert.ok(completes[0].payload.message.content.includes(expected), 'The response must answer the recovery prompt');
      const text = fresh.filter(event => event.type === 'responseChunk' && event.payload.type === 'text').map(event => event.payload.content || '').join('');
      const normalizedText = text.replace(/<<<MYSTI_CONNECT:[a-z0-9._-]*>>>/gi, '').replace(/\n{3,}/g, '\n\n');
      assert.strictEqual(normalizedText, completes[0].payload.message.content, 'No lost, duplicated or foreign text after the documented host final-text transforms');
      assert.strictEqual(fresh.some(event => event.type === 'requestCancelled'), false, 'Old cleanup must not cancel the replacement');
      record('recovered', { marker, provider, message: completes[0].payload.message, sessionHash: currentSession(provider), textChunks: fresh.filter(event => event.type === 'responseChunk' && event.payload.type === 'text').length,
        rawStreamSha256: hash(text), normalizedStreamSha256: hash(normalizedText), hostNormalizationApplied: text !== normalizedText });
      return { message: completes[0].payload.message, offset };
    }

    before(async () => {
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR;
      assert.ok(profile && path.isAbsolute(profile) && fs.existsSync(path.join(profile, 'DevToolsActivePort')));
      artifactDir = process.env.MYSTI_PC07_ARTIFACT_DIR || path.join(profile, 'pc07-evidence'); fs.mkdirSync(artifactDir, { recursive: true });
      sampleProcesses(); sampler = setInterval(() => { try { sampleProcesses(); } catch (error) { record('process-sample-error', { message: String(error) }); } }, 100);
      const requested = process.env.MYSTI_TEST_EXTENSION_PATH; assert.ok(requested && path.isAbsolute(requested));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      extensionPath = fs.realpathSync(extension.extensionPath); extensionHash = hash(fs.readFileSync(path.join(extensionPath, 'dist/extension.js')));
      assert.strictEqual(extensionPath, fs.realpathSync(requested));
      assert.strictEqual(extensionHash, hash(fs.readFileSync(path.join(requested, 'dist/extension.js'))));
      record('loaded-extension-identity', { actualPath: extensionPath, requestedPath: requested, bundleSha256: extensionHash, vscode: vscode.version });
      const claude = process.env.MYSTI_PC07_CLAUDE_PATH, codex = process.env.MYSTI_PC07_CODEX_PATH, node = process.env.MYSTI_PC07_NODE_PATH;
      for (const file of [claude, codex, node]) assert.ok(file && path.isAbsolute(file) && fs.existsSync(file));
      assert.notStrictEqual(process.platform, 'win32');
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
      const workspace = fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath);
      assert.strictEqual(workspace, fs.realpathSync(path.join(__dirname, 'fixture-workspace')));
      fixtureDirectory = fs.mkdtempSync(path.join(workspace, 'pc07-')); queuedCanary = path.join(fixtureDirectory, 'queued-writer-canary.txt'); approvalCanary = path.join(fixtureDirectory, 'approval-canary.txt');
      cliDirectory = fs.mkdtempSync(path.join(artifactDir, 'cli-'));
      const hooks = path.join(cliDirectory, 'claude-settings.json'); fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
      await configure('claudeCodePath', createCancellationCli(cliDirectory, 'claude-code', claude!, node!, hooks, nonce), vscode.ConfigurationTarget.Global);
      await configure('codexPath', createCancellationCli(cliDirectory, 'openai-codex', codex!, node!, hooks, nonce), vscode.ConfigurationTarget.Global);
      for (const [key, value] of Object.entries({ defaultAgent: 'claude-code', defaultProvider: 'claude-code', defaultModel: 'sonnet', claudeCodeModel: 'sonnet',
        codexModel: 'gpt-5.6-sol', codexProfile: '', defaultEffortLevel: 'low', defaultThinkingLevel: 'none', defaultMode: 'ask-before-edit',
        accessLevel: 'ask-permission', autoContext: false, showSuggestions: false, 'agents.autoSuggest': false })) {
        if (key !== 'codexProfile') await configure(key, undefined, vscode.ConfigurationTarget.Workspace);
        await configure(key, value, vscode.ConfigurationTarget.Global);
      }
      const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) originalTabs.add(tab);
      await extension.activate();
      const previousFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('The dedicated test chat must mount', async () => {
        chatTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => !originalTabs.has(tab) && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('mysti.detachedChat'));
        const candidates: Frame[] = [];
        for (const candidate of browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames()))) {
          if (previousFrames.has(candidate)) continue;
          try { if (await candidate.locator('#message-input').count() && !await candidate.locator('body.view-hub').count() &&
            (await candidate.locator('#init-loading-overlay').getAttribute('class'))?.split(/\s+/).includes('hidden')) candidates.push(candidate); } catch { /* Mounting. */ }
        }
        if (!chatTab || candidates.length !== 1) return false; frame = candidates[0]; return true;
      }, 30_000);
      await workbench.bringToFront();
      if (await frame.locator('#setup-wizard').isVisible()) await frame.locator('.wizard-skip-btn').click();
      await frame.evaluate(() => {
        const win = globalThis as any; win.__pc07Events = [];
        const snapshot = (m: any) => m && ({ id: m.id, role: m.role, provider: m.provider, model: m.model, content: m.content,
          toolCalls: (m.toolCalls || []).map((t: any) => ({ id: t.id, name: t.name, status: t.status })) });
        win.__pc07Listener = (event: any) => {
          const message = event.data, p = message?.payload || {};
          if (!['conversationChanged', 'conversationHistory', 'sessionCleared', 'responseStarted', 'responseChunk', 'responseComplete', 'requestCancelled', 'permissionRequest', 'permissionDismissed', 'permissionExpired', 'toolUse', 'toolResult', 'error', 'authError', 'lifecycleEvent'].includes(message?.type)) return;
          let payload: any = {};
          if (message.type === 'conversationChanged') payload = { id: p.id, messageCount: p.messages?.length || 0, messages: (p.messages || []).map(snapshot) };
          if (message.type === 'conversationHistory') payload = { ids: (p.conversations || []).map((c: any) => c.id) };
          if (message.type === 'sessionCleared') payload = { message: p.message, reason: p.reason };
          if (message.type === 'responseStarted') payload = { provider: p.provider, model: p.model };
          if (message.type === 'responseChunk') payload = { type: p.type, ...(p.type === 'text' ? { content: p.content } : {}) };
          if (message.type === 'responseComplete') payload = { message: p.message && { id: p.message.id, provider: p.message.provider, model: p.message.model, content: p.message.content, toolCount: p.message.toolCalls?.length || 0 } };
          if (message.type === 'requestCancelled') payload = { message: snapshot(p.message) };
          if (message.type === 'permissionRequest') payload = { id: p.id, title: p.title, details: { toolName: p.details?.toolName, filePath: p.details?.filePath, toolInput: { file_path: p.details?.toolInput?.file_path, path: p.details?.toolInput?.path, content: p.details?.toolInput?.content === 'PC07_WRITE_MUST_BE_APPROVED' ? p.details.toolInput.content : '[unexpected content omitted]' } } };
          if (message.type === 'permissionDismissed' || message.type === 'permissionExpired') payload = { requestId: p.requestId, requestIds: p.requestIds };
          if (message.type === 'toolUse') payload = { id: p.id, name: p.name };
          if (message.type === 'lifecycleEvent') payload = { type: p.type, providerId: p.providerId, childPidCount: Array.isArray(p.childPids) ? p.childPids.length : undefined };
          win.__pc07Events.push({ type: message.type, payload, sequence: win.__pc07Events.length, at: Date.now() });
        };
        win.addEventListener('message', win.__pc07Listener);
      });
      await frame.locator('#new-conversation-btn').click();
      await until('The initial conversation must have a host identity', async () => (await events('conversationChanged')).length === 1);
      originalConversation = (await events('conversationChanged'))[0].payload.id;
      await selectAgent('claude-code', 'Claude');
      // Exercise the same literal command before spending any inference calls.
      // Wait for its real catalog so Enter cannot accidentally test only the
      // faster fallback path while the descriptive-match collision goes unseen.
      const beforeClearPreflight = originalConversation;
      const preflightConversationCount = (await events('conversationChanged')).length;
      try {
        assert.strictEqual(receipts().filter(item => item.event === 'request').length, 0);
        await frame.locator('#message-input').fill('/clear');
        await until('The real /clear catalog must settle before preflight Enter', async () =>
          await frame.locator('#slash-menu').isVisible() &&
          await frame.locator('#slash-menu-query').textContent() === 'clear' &&
          await frame.locator('#slash-menu [data-command-id="cmd:clear"]').count() === 1);
        const selectedCommand = await frame.locator('#slash-menu .slash-menu-item.selected').getAttribute('data-command-id');
        await frame.locator('#message-input').press('Enter');
        await until('Unpaid /clear preflight must create a new host conversation', async () =>
          (await events('conversationChanged')).length > preflightConversationCount);
        assert.strictEqual(selectedCommand, 'cmd:clear');
        const preflightConversation = (await events('conversationChanged')).at(-1).payload;
        assert.notStrictEqual(preflightConversation.id, beforeClearPreflight);
        assert.strictEqual(preflightConversation.messageCount, 0);
        assert.strictEqual(receipts().filter(item => item.event === 'request').length, 0, 'The local /clear preflight may not invoke a provider');
        originalConversation = preflightConversation.id;
        record('unpaid-clear-preflight', { selectedCommand, beforeConversationId: beforeClearPreflight, afterConversationId: originalConversation,
          catalogSettledBeforeEnter: true, wireConversationRequests: 0 });
      } catch (error) {
        record('unpaid-clear-preflight-failed', { error: error instanceof Error ? error.message : String(error), wireConversationRequests: receipts().filter(item => item.event === 'request').length });
        await workbench.screenshot({ path: path.join(artifactDir, 'clear-preflight-failure.png') }).catch(() => {});
        throw error;
      }
      record('scope', { fixtureDirectory, requestsPlanned: 8, canaries: [queuedCanary, approvalCanary],
        scope: 'Actual Claude mid-stream Stop, queue writer exclusion, recovery, conservative default shutdown-blocked for a wrapped CLI, supported disposable-profile protection override and shutdown, pending Write approval Stop, Codex pre-token Stop/recovery, public /clear and new conversation. No tools approved, no accounts changed, no real long-duration soak or near-final race claimed.',
        auxiliaryCoverage: 'All test-editor descendants sampled every100ms for external cleanup; only selected-wrapper auxiliary requests can be counted. Constructor-cached direct auxiliary invocations remain uncounted.' });
    });

    afterEach(async function () {
      if (!artifactDir) return;
      const state = this.currentTest?.state;
      record(state === 'failed' ? 'case-failed' : state === 'passed' ? 'case-complete' : 'case-not-reached', { title: this.currentTest?.title, state,
        error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message },
        events: frame && await events().catch(() => []), wireReceipts: receipts() });
      if (this.currentTest?.state === 'failed' && workbench) await workbench.screenshot({ path: path.join(artifactDir, 'failure.png') }).catch(() => {});
    });
    after(async () => {
      let remaining: number[] = [], durationMs = 0;
      try {
        if (frame && await frame.locator('#stop-btn').isVisible().catch(() => false)) await frame.locator('#stop-btn').click().catch(() => {});
        sampleProcesses(); const started = Date.now();
        if (chatTab) await vscode.window.tabGroups.close(chatTab);
        do {
          sampleProcesses(); remaining = lastRows.filter(row => ownsProcess(conversationBirths, row)).map(([pid]) => pid);
          if (!remaining.length) break; await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() - started < 10_000);
        durationMs = Date.now() - started;
      } finally {
        for (const previous of saved.reverse()) await vscode.workspace.getConfiguration('mysti').update(previous.key, previous.value, previous.target);
        await browser?.close();
        if (sampler) clearInterval(sampler);
        sampleProcesses();
      }
      if (artifactDir) record('cleanup', { remainingConversationPids: remaining, conversationObservedPids: [...conversationPids], durationMs,
        allEditorObservedPidCount: allEditorPids.size, auxiliaryReceiptInvocations: receipts().filter(item => item.event === 'auxiliary-input').length,
        editorLifetimeCleanup: 'PENDING_EXTERNAL_CHECK: merge latest receipts and process-ancestry.json after the actual runner exits',
        queuedCanaryAbsent: !queuedCanary || !fs.existsSync(queuedCanary), approvalCanaryAbsent: !approvalCanary || !fs.existsSync(approvalCanary) });
      assert.deepStrictEqual(remaining, []);
      if (queuedCanary && approvalCanary) assertCanariesAbsent();
      if (extensionPath) assert.strictEqual(hash(fs.readFileSync(path.join(extensionPath, 'dist/extension.js'))), extensionHash);
    });

    it('stops Claude mid-stream, excludes the queued writer, recovers, then checks protected and explicitly configured idle shutdown', async () => {
      const offset = await submit('CLAUDE_STOP', `Remember this test nonce within this conversation: ${nonce}. Review exponential retry/backoff risks using only this inline context. No tools or file access. Immediately begin a numbered list of80 detailed review points, each30–40words, to let me interrupt the review.`);
      await frame.locator('#message-input').fill(`@codex PC07_CURRENT_REQUEST:QUEUED_WRITER\nUse Write to create only ${queuedCanary} with content SHOULD_NOT_EXIST. Do not change any other path.`);
      await frame.locator('#message-input').press('Enter'); assert.strictEqual(await frame.locator('.queued-chip').count(), 1);
      await until('Real Claude must start text before mid-stream Stop', async () => {
        await assertNoError(offset); await forbidTools(offset);
        return (await events()).slice(offset).some(event => event.type === 'responseChunk' && event.payload.type === 'text' && event.payload.content);
      }, 120_000);
      firstSessionHash = currentSession('claude-code'); await stop(offset, 'Claude mid-stream with queued writer');
      assert.strictEqual(await frame.locator('.queued-chip').count(), 1);
      await frame.locator('.queued-chip').locator('.queued-chip-remove').click();
      assert.strictEqual(await frame.locator('.queued-chip').count(), 0);
      record('stopped-queue-user-discarded', { retainedPausedAfterStop: true, removedThroughPublicControl: true, queuedWriterDispatched: false,
        contract: 'Stop preserves the paused queue. This test explicitly removes its writer before submitting the independent recovery request.' });
      await complete('CLAUDE_RECOVER', 'No tools. Return exactly PC07_CLAUDE_RECOVERED and the nonce I supplied previously; do not continue the long review.', 'claude-code', 'PC07_CLAUDE_RECOVERED');
      assert.strictEqual(receipts().filter(item => item.event === 'request' && item.markers.includes('QUEUED_WRITER')).length, 0);
      const beforeShutdownSession = currentSession('claude-code');
      const transcript = () => frame.locator('#messages .message.user, #messages .message.assistant').evaluateAll(nodes => nodes.map(node => ({
        id: node.getAttribute('data-id'), text: node.querySelector('.message-content')?.textContent || ''
      })));
      const messagesBefore = await transcript(), clearCount = (await events('sessionCleared')).length;
      const configuration = vscode.workspace.getConfiguration('mysti');
      assert.strictEqual(configuration.inspect('lifecycle.protectActiveChildren')?.defaultValue, true);
      assert.strictEqual(configuration.get('lifecycle.protectActiveChildren'), true, 'First exercise the default protective policy');
      const lifecycleBefore = (await events('lifecycleEvent')).length;
      const requestsBeforeShutdown = receipts().filter(item => item.event === 'request').length;
      await frame.locator('#stop-agent-btn').click();
      await until('Default child protection must report the resident launcher child honestly', async () =>
        (await events('lifecycleEvent')).slice(lifecycleBefore).some(event => event.payload.type === 'shutdown-blocked'));
      assert.strictEqual((await events('sessionCleared')).length, clearCount);
      assert.deepStrictEqual(await transcript(), messagesBefore, 'User and assistant identities/content remain unchanged; lifecycle status notices are separate');
      assert.strictEqual(await frame.locator('#stop-agent-btn').isVisible(), true);
      assert.strictEqual(currentSession('claude-code'), beforeShutdownSession);
      assert.strictEqual(receipts().filter(item => item.event === 'request').length, requestsBeforeShutdown);
      record('default-wrapped-shutdown-blocked', { protectActiveChildren: true, transcriptUnchanged: true, sessionHash: beforeShutdownSession,
        observedEvents: (await events('lifecycleEvent')).slice(lifecycleBefore),
        limitation: 'PID ancestry alone cannot distinguish the wrapper transport child from active tool children. This is a conservative default block, not successful default idle shutdown.' });
      await configure('lifecycle.protectActiveChildren', false, vscode.ConfigurationTarget.Global);
      assert.strictEqual(vscode.workspace.getConfiguration('mysti').get('lifecycle.protectActiveChildren'), false);
      await frame.locator('#stop-agent-btn').click();
      await until('Public Stop agent session must finish', async () => (await events('sessionCleared')).length > clearCount);
      assert.strictEqual((await events('sessionCleared')).at(-1).payload.reason, 'shutdown');
      assert.deepStrictEqual(await transcript(), messagesBefore);
      const shutdown = await complete('AFTER_SHUTDOWN', 'No tools. Return PC07_AFTER_SHUTDOWN and the earlier nonce from the visible conversation; this is the same chat.', 'claude-code', 'PC07_AFTER_SHUTDOWN');
      assert.ok(shutdown.message.content.includes(nonce), 'Same-chat transcript replay is intentionally retained');
      assert.notStrictEqual(currentSession('claude-code'), beforeShutdownSession, 'Idle shutdown must discard the immediately preceding native session identity');
      record('idle-shutdown-native-reset', { stoppedSessionHash: firstSessionHash, oldSessionHash: beforeShutdownSession, newSessionHash: currentSession('claude-code'), transcriptRetained: true,
        configuration: { key: 'mysti.lifecycle.protectActiveChildren', default: true, testedShutdownValue: false, target: 'disposable test profile', restoredInCleanup: true },
        defaultWrappedIdleShutdown: 'BLOCKED_BY_PROTECTION', supportedOverrideShutdown: 'PASS' });
      completedPhase = 1;
    });

    it('stops an actual pending single-file approval without allowing its write', async function () {
      if (completedPhase !== 1) this.skip(); // Unreached is pending, never passed.
      const offset = await submit('APPROVAL_STOP', `Use the Write tool exactly once to create ${approvalCanary} with exact content PC07_WRITE_MUST_BE_APPROVED. This is a disposable test-owned new file. Do not run commands, read other files, or write anywhere else. Wait for permission.`);
      await until('Claude must request the actual owned Write permission', async () => {
        await assertNoError(offset);
        return (await events()).slice(offset).some(event => event.type === 'permissionRequest');
      }, 120_000);
      const permissions = (await events()).slice(offset).filter(event => event.type === 'permissionRequest'); assert.strictEqual(permissions.length, 1);
      const request = permissions[0].payload, input = request.details.toolInput;
      assert.strictEqual(String(request.details.toolName || request.title).toLowerCase(), 'write');
      assert.strictEqual(path.resolve(input.file_path || input.path || request.details.filePath), approvalCanary);
      assert.strictEqual(input.content, 'PC07_WRITE_MUST_BE_APPROVED'); assertCanariesAbsent();
      await stop(offset, 'Claude pending owned Write approval');
      await until('Stopped approval must no longer be actionable', async () => await frame.locator('.permission-card.pending').count() === 0);
      const card = frame.locator(`.permission-card[data-id=${JSON.stringify(request.id)}]`);
      assert.strictEqual(await card.count(), 1, 'The original cancelled approval must remain inspectable once');
      assert.strictEqual(await card.locator('button:enabled, input:enabled').count(), 0);
      assert.strictEqual((await events()).slice(offset).some(event => event.type === 'permissionExpired'), false, 'Stop must cancel the approval rather than wait for its deadline');
      assertCanariesAbsent(); record('approval-stopped', { requestId: request.id, canary: path.basename(approvalCanary), approvalGranted: false, canaryAbsent: true });
      completedPhase = 2;
    });

    it('stops Codex before first text, recovers, and resets history/session scope with public clear and new chat', async function () {
      if (completedPhase !== 2) this.skip(); // Do not spend more after a failed prerequisite.
      await selectAgent('openai-codex', 'Codex');
      const offset = await submit('CODEX_STOP', 'No tools or file access. Think through a retry-service design with80 numbered tradeoffs, then give a detailed explanation. I may stop this request before the first token.');
      assert.strictEqual((await events()).slice(offset).some(event => event.type === 'responseChunk' && event.payload.type === 'text'), false,
        'A completed fast response is not a valid pre-token Stop test');
      await stop(offset, 'Codex before first text');
      const recovered = await complete('CODEX_RECOVER', 'No tools. Return PC07_CODEX_RECOVERED and the earlier test nonce if the current conversation contains one. Do not continue the long review.', 'openai-codex', 'PC07_CODEX_RECOVERED');
      assert.ok(recovered.message.content.includes(nonce)); const previousCodex = currentSession('openai-codex');
      const conversationCount = (await events('conversationChanged')).length, requestsBeforeClear = receipts().filter(item => item.event === 'request').length;
      await frame.locator('#message-input').fill('/clear'); await frame.locator('#message-input').press('Enter');
      await until('Public /clear must start a visibly new conversation', async () => (await events('conversationChanged')).length > conversationCount);
      const cleared = (await events('conversationChanged')).at(-1).payload;
      assert.notStrictEqual(cleared.id, originalConversation); assert.strictEqual(cleared.messageCount, 0);
      assert.strictEqual(await frame.locator('#messages .message.user').count(), 0);
      assert.strictEqual(receipts().filter(item => item.event === 'request').length, requestsBeforeClear, '/clear is local and must not start inference');
      const afterClear = await complete('AFTER_CLEAR', 'No tools. If a previous message in THIS chat supplied a test nonce beginning PC07_MEMORY_, return that exact nonce. Otherwise return PC07_NO_PRIOR_NONCE. Do not guess.', 'openai-codex', 'PC07_NO_PRIOR_NONCE');
      assert.strictEqual(afterClear.message.content.includes(nonce), false); assert.notStrictEqual(currentSession('openai-codex'), previousCodex);
      const clearReceipt = receipts().filter(item => item.event === 'request' && item.markers.includes('AFTER_CLEAR')).at(-1);
      assert.strictEqual(clearReceipt.containsPriorNonce, false, 'New-chat transport must not receive old transcript context');
      const historyBefore = (await events('conversationHistory')).length;
      await frame.locator('#history-btn').click();
      await until('Old chat must remain in real history', async () => (await events('conversationHistory')).length > historyBefore);
      const historyIds = (await events('conversationHistory')).at(-1).payload.ids;
      assert.ok(historyIds.includes(originalConversation));
      await frame.locator('#history-menu .history-item').nth(historyIds.indexOf(originalConversation)).locator('.history-item-info').click();
      await until('The real History control must restore the original stopped conversation', async () =>
        (await events('conversationChanged')).at(-1)?.payload.id === originalConversation);
      const restored = (await events('conversationChanged')).at(-1).payload;
      assert.ok(stoppedSnapshots.size >= 1, 'At least the mid-stream Claude partial must be verified from history');
      for (const [id, snapshot] of stoppedSnapshots) {
        const matching = restored.messages.filter((message: any) => message.id === id);
        assert.strictEqual(matching.length, 1, 'History must persist each interrupted snapshot exactly once');
        assert.deepStrictEqual(matching[0], snapshot);
        assert.strictEqual(await frame.locator(`.message.assistant[data-id=${JSON.stringify(id)}]`).count(), 1);
      }
      assert.strictEqual(await frame.locator('.permission-card.pending, .tool-call.running').count(), 0, 'Restoring cancelled history may not reopen a gate or spinner');
      record('stopped-history-restored', { conversationId: originalConversation, stoppedMessageIds: [...stoppedSnapshots.keys()],
        exactSnapshotRoundTrip: true, noDuplicateStoppedMessages: true });
      const beforeNewChat = (await events('conversationChanged')).length;
      await frame.locator('#new-conversation-btn').click();
      await until('New chat button must start another host conversation', async () => (await events('conversationChanged')).length > beforeNewChat);
      assert.notStrictEqual((await events('conversationChanged')).at(-1).payload.id, originalConversation);
      await selectAgent('openai-codex', 'Codex');
      const newChat = await complete('NEW_CHAT', 'No tools. Return PC07_NEW_CHAT_READY. If there is any earlier test nonce in THIS chat, include it; otherwise say no earlier nonce.', 'openai-codex', 'PC07_NEW_CHAT_READY');
      assert.strictEqual(newChat.message.content.includes(nonce), false);
      const wire = receipts().filter(item => item.event === 'request'); assert.strictEqual(wire.length, 8);
      assert.strictEqual(wire.at(-1).containsPriorNonce, false);
      assert.deepStrictEqual(wire.map(item => item.provider), ['claude-code', 'claude-code', 'claude-code', 'claude-code', 'openai-codex', 'openai-codex', 'openai-codex', 'openai-codex']);
      assert.strictEqual(wire.some(item => item.markers.includes('QUEUED_WRITER')), false);
      assertCanariesAbsent(); record('eight-request-stop-and-recovery', { requests: wire, requestCount: wire.length,
        cancellationAcknowledgements: (await events('requestCancelled')).length, queuedWriterSent: false, canariesAbsent: true,
        originalConversationPreservedInHistory: true, clearCreatedNewConversation: true, auxiliaryRequestsMeasuredByWrapper: receipts().filter(item => item.event === 'auxiliary-input').length });
      await workbench.screenshot({ path: path.join(artifactDir, 'stop-recovery.png') });
    });
  });
}
