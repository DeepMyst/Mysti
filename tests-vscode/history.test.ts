/**
 * PC-08 opt-in real-editor persistence across TWO actual VS Code launches.
 * Prepare scripts/validation/prepare-vscode-history.cjs first; launch stage
 * create, wait for editor exit/audit, then stage restart with the same owned
 * MYSTI_TEST_OWNED_PROFILE and immutable VSIX. Never prepare the workspace
 * again between launches. 20 small coding tasks + 1 interrupted request.
 * Stage restart uses public History/Delete only and makes no inference call.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
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

const TASKS = [
  ['Retry bound', 'for (let n=0; n<=maxRetries; n++) await request(); always calls request even after success. Explain the missing success exit and propose the minimal loop change.'],
  ['Cache expiry', 'A cache accepts entry.expiresAt >= Date.now(). Explain the exact expiry-boundary bug and name one deterministic clock test.'],
  ['JSON parser', 'function parse(input) { return JSON.parse(input) || {}; } throws for bad JSON and hides valid false. Suggest a result type that distinguishes parse failure from valid falsy JSON.'],
  ['Debounce timer', 'function debounce(f,ms){return ()=>setTimeout(f,ms)} never cancels the prior timer. Describe the fix and a fake-timer test for three rapid calls.'],
  ['Abort propagation', 'An async retry loop catches every error and retries, including AbortError. Explain how to preserve cancellation and avoid a later retry.'],
  ['Batch isolation', 'Promise.all processes 10 independent jobs but one failure rejects the entire batch. Compare allSettled for reporting each successful result and each error.'],
  ['Concurrency limit', 'A worker pool increments active before awaiting work but decrements only on success. Explain the deadlock on rejection and the finally fix.'],
  ['Pagination cursor', 'A client appends a page then repeats its current cursor instead of nextCursor. Explain the duplicate/infinite-loop failure and one defensive boundary.'],
  ['Idempotency key', 'A payment retry generates a new idempotency key on each attempt. Explain why duplicate charging remains possible and when the key should be created.'],
  ['Numeric sort', '[2, 10, 1].sort() produces lexical ordering. Give the numeric comparator and one regression assertion.'],
  ['Unicode length', 'An input limit uses JavaScript string.length to count displayed characters. Explain one emoji edge case and the distinction between code units and graphemes.'],
  ['URL query', 'A URL is constructed with "?q=" + userInput. Explain the failure with an ampersand and propose URLSearchParams.'],
  ['HTTP retry policy', 'The client retries every HTTP status, including 400. Suggest a bounded transient-error policy and mention Retry-After for 429.'],
  ['Map default', 'const total = counts.get(key) || 10 replaces a legitimate zero. Explain the nullish-coalescing fix and a zero-count regression.'],
  ['Async iteration', 'items.forEach(async item => await save(item)); returns before saves complete. Explain two valid awaited alternatives and their ordering differences.'],
  ['Stable deduplication', 'Duplicate objects are passed to new Set expecting equal ids to collapse. Explain reference identity and propose a Map keyed by id preserving first occurrence.'],
  ['Date rollover', 'Adding 24*60*60*1000 to a local date assumes every calendar day has 24 hours. Explain the daylight-saving boundary and distinguish elapsed time from calendar-day arithmetic.'],
  ['Request race', 'A slow earlier autocomplete request overwrites a fast newer result. Describe a request generation guard and a deterministic out-of-order completion test.'],
  ['Resource cleanup', 'A subscription is added on every mount without disposal. Explain the duplicate event symptom and the correct cleanup ownership.'],
  ['Cache key scope', 'An API cache key includes only the pathname and ignores tenant id. Explain cross-tenant result reuse and the necessary cache key components.'],
] as const;

if (process.env.MYSTI_PC08 === '1') {
  describe('PC-08 real editor history, titles and actual restart', function () {
    this.timeout(1_500_000);
    const stage = process.env.MYSTI_PC08_STAGE;
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    let artifactRoot: string, artifactDir: string, prepared: any, stageA: any;
    let browser: Browser, workbench: Page, frame: Frame, chatTab: vscode.Tab | undefined;
    let extensionPath: string, extensionHash: string, chatHash: string;
    let sampler: NodeJS.Timeout | undefined, lastRows: ProcessRow[] = [];
    let stageComplete = false;
    const observations: any[] = [], snapshots: any[] = [];
    const allEditorPids = new Set<number>(), conversationPids = new Set<number>(), auxiliaryPids = new Set<number>();
    const processRoots = new Set([process.pid, process.ppid]);
    const editorBirths: ProcessOwners = new Map(), conversationBirths: ProcessOwners = new Map(), auxiliaryBirths: ProcessOwners = new Map();
    const seenLaunches = new Set<string>(), unidentifiedLaunchPids = new Set<number>();
    const processDetails = new Map<string, { pid: number; startedAt: string; parentPid: number; parentStartedAt?: string; executableBasename: string; firstObservedAt: string; lastObservedAt: string }>();
    const originalTabs = new Set<vscode.Tab>();
    let requestBaseline = 0, auxiliaryBaseline = 0;

    function record(event: string, details: Record<string, unknown> = {}): void {
      const entry = { ...details, event, at: new Date().toISOString() }; observations.push(entry);
      fs.writeFileSync(path.join(artifactDir, 'observations.json'), JSON.stringify(observations, null, 2));
      console.log('[PC-08]', JSON.stringify(entry));
    }
    function receipts(): any[] {
      return (prepared?.receiptsPathsByStage[stage!] || []).flatMap((file: string) => fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []).sort((a: any, b: any) => a.at - b.at);
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
        scope: 'Full test-editor descendant tree by PID plus lstart birth identity; includes sampler helpers and direct title/classifier workers. Reused PIDs cannot acquire unrelated descendants. Transient children between250ms samples can be missed.',
        receiptPaths: prepared?.receiptsPathsByStage[stage!] || [],
        afterEditorExitStatus: 'PENDING_EXTERNAL_CHECK',
      }, null, 2));
    }
    async function until(label: string, predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(`${label}: timed out after ${timeout}ms`);
    }
    async function events(type?: string): Promise<any[]> {
      const result = await frame.evaluate(() => (globalThis as any).__pc08Events || []);
      return type ? result.filter((event: any) => event.type === type) : result;
    }
    async function noUnexpectedToolsOrErrors(offset = 0): Promise<void> {
      const fresh = (await events()).slice(offset);
      for (const event of fresh.filter(value => value.type === 'permissionRequest')) {
        const deny = frame.locator(`.permission-card[data-id=${JSON.stringify(event.payload.id)}] [data-action="deny"]`);
        if (await deny.isVisible()) await deny.click();
      }
      assert.deepStrictEqual(fresh.filter(value => ['permissionRequest', 'toolUse', 'error', 'authError'].includes(value.type)).map(value => value.type), [], 'Inline tasks must not use tools or hide a provider failure');
    }
    async function history(): Promise<any[]> {
      const count = (await events('conversationHistory')).length;
      if (await frame.locator('#history-menu').isVisible()) await frame.locator('#history-btn').click();
      await frame.locator('#history-btn').click();
      await until('Public History must receive current records', async () => (await events('conversationHistory')).length > count);
      return (await events('conversationHistory')).at(-1).payload.conversations;
    }
    async function switchConversation(id: string): Promise<any> {
      const conversations = await history(), index = conversations.findIndex(value => value.id === id);
      assert.ok(index >= 0, 'The intended owned conversation must remain in history');
      const count = (await events('conversationChanged')).length;
      await frame.locator(`#history-menu .history-item[data-conversation-id=${JSON.stringify(id)}] .history-item-info`).click();
      await until('Public History selection must restore its owner', async () =>
        (await events('conversationChanged')).length > count && (await events('conversationChanged')).at(-1).payload.id === id);
      return (await events('conversationChanged')).at(-1).payload;
    }
    async function newConversation(): Promise<string> {
      const count = (await events('conversationChanged')).length;
      if (await frame.locator('#history-menu').isVisible()) await frame.locator('#history-btn').click();
      await frame.locator('#new-conversation-btn').click();
      await until('New chat must have a real host identity', async () => (await events('conversationChanged')).length > count);
      const conversation = (await events('conversationChanged')).at(-1).payload;
      assert.deepStrictEqual(conversation.messages, []); return conversation.id;
    }
    async function selectProvider(provider: string): Promise<void> {
      await frame.locator('#agent-select-btn').click();
      await frame.locator(`#agent-menu .agent-menu-item[data-agent=${JSON.stringify(provider)}]:not(.disabled)`).click();
      await until('Selected provider must settle', async () => (await frame.locator('#agent-name').innerText()).includes(provider === 'claude-code' ? 'Claude' : 'Codex'));
    }
    function semanticSnapshot(conversation: any): any {
      // Exclude mutable timestamps/checkpoint completion; retain exact ordered
      // source, stable IDs, actual attribution, context and selected persona.
      return JSON.parse(JSON.stringify({ id: conversation.id, title: conversation.title, mode: conversation.mode, provider: conversation.provider, model: conversation.model,
        agentConfig: conversation.agentConfig || null,
        messages: conversation.messages.map((message: any) => ({ id: message.id, role: message.role, content: message.content,
          provider: message.provider, model: message.model, participants: message.participants, context: message.context || [],
          attachments: message.attachments || [], thinking: message.thinking, toolCalls: message.toolCalls || [], segments: message.segments || [] })) }));
    }
    async function assertRendered(conversation: any): Promise<void> {
      const displayed = conversation.messages.filter((message: any) => ['user', 'assistant'].includes(message.role));
      await until('Restored DOM must contain all persisted message IDs', async () =>
        await frame.locator('#messages .message.user, #messages .message.assistant').count() === displayed.length);
      const ids = await frame.locator('#messages .message.user, #messages .message.assistant').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')));
      assert.deepStrictEqual(ids, displayed.map((message: any) => message.id));
      for (const message of displayed.filter((item: any) => item.role === 'assistant')) {
        const element = frame.locator(`#messages .message[data-id=${JSON.stringify(message.id)}]`);
        assert.strictEqual(await element.getAttribute('data-provider'), message.provider);
        assert.ok((await element.locator('.message-content').allTextContents()).join('\n').trim(), 'Saved response must render visible content');
      }
    }
    async function titleReceipt(conversationId: string, marker: string, prompt: string): Promise<any> {
      await until('First prompt must produce an owned title or honest fallback', async () => (await events('titleUpdated')).some(value => value.payload.conversationId === conversationId), 15_000);
      const updates = (await events('titleUpdated')).filter(value => value.payload.conversationId === conversationId);
      const title = updates.at(-1).payload.title;
      const inputs = receipts().filter(value => value.event === 'auxiliary-input' && value.kind === 'title' && value.markers.includes(marker));
      assert.strictEqual(inputs.length, 1, 'Exactly one observed title input must belong to the first prompt');
      const candidates = receipts().filter(value => value.event === 'auxiliary-output' && value.wrapperPid === inputs[0].wrapperPid && value.at >= inputs[0].at);
      const fallback = prompt.trim().substring(0, 50) + (prompt.trim().length > 50 ? '...' : '');
      const generated = candidates.some(value => value.titleCandidateHash === hash(title));
      assert.ok(generated || title === fallback, 'Title must be the matching prompt worker output or documented source fallback');
      return { title, kind: generated ? 'generated' : 'fallback', titleHash: hash(title), inputWrapperPid: inputs[0].wrapperPid, marker };
    }
    async function sendTask(index: number): Promise<void> {
      const marker = `PC08_TASK_${String(index + 1).padStart(2, '0')}`, [topic, task] = TASKS[index];
      const provider = index % 2 === 0 ? 'claude-code' : 'openai-codex';
      const conversationId = await newConversation(); await selectProvider(provider);
      if (index === 0) {
        await frame.locator('#tools-menu-btn').click(); await frame.locator('#toolbar-persona-btn').click();
        const chip = frame.locator('#inline-suggestions-chips .recommendation-chip[data-agent-type="persona"]');
        const choices = await chip.evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-agent-id'), name: element.textContent?.trim() })).filter(value => value.id));
        assert.ok(choices.length > 0, 'A real non-default persona must be selectable');
        const choice = choices.find(value => /review|engineer|developer/i.test(value.name || '')) || choices[0];
        await frame.locator(`#inline-suggestions-chips .recommendation-chip[data-agent-id=${JSON.stringify(choice.id)}]`).click();
        await until('Persona must be persisted before first send', async () => (await events('agentConfigUpdated')).some(value => value.payload.personaId === choice.id));
        const contextCount = (await events('contextUpdated')).length;
        await vscode.commands.executeCommand('mysti.addToContext', vscode.Uri.file(prepared.contextFile));
        await until('Public context command must deliver the owned file', async () => (await events('contextUpdated')).length > contextCount &&
          (await events('contextUpdated')).at(-1).payload.some((item: any) => item.path === prepared.contextFile));
        record('oldest-setup', { conversationId, personaId: choice.id, contextPath: prepared.contextFile, contextSha256: hash(prepared.contextContent) });
      }
      const prompt = `${marker}: ${topic}\n${task}\nUse only the supplied inline/context text. No tools, shell, file access or changes. Reply in 30–60 words, starting with ${marker}, then the concrete diagnosis and fix. Do not ask a question.`;
      const offset = (await events()).length, before = receipts().filter(value => value.event === 'request').length;
      await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
      await until(`${marker} must finish a real response`, async () => { await noUnexpectedToolsOrErrors(offset); return (await events()).slice(offset).some(value => value.type === 'responseComplete'); }, 120_000);
      const fresh = (await events()).slice(offset), complete = fresh.filter(value => value.type === 'responseComplete');
      assert.strictEqual(complete.length, 1); assert.strictEqual(fresh.filter(value => value.type === 'responseStarted').length, 1);
      assert.strictEqual(complete[0].payload.message.provider, provider);
      assert.strictEqual(complete[0].payload.message.model, provider === 'claude-code' ? 'sonnet' : 'gpt-5.6-sol');
      assert.ok(complete[0].payload.message.content.includes(marker));
      const wire = receipts().filter(value => value.event === 'request').slice(before);
      assert.strictEqual(wire.length, 1); assert.strictEqual(wire[0].provider, provider); assert.deepStrictEqual(wire[0].markers, [marker]);
      const title = await titleReceipt(conversationId, marker, prompt);
      const conversation = (await history()).find(value => value.id === conversationId); assert.ok(conversation);
      const saved = semanticSnapshot(conversation);
      assert.deepStrictEqual(saved.messages.map((value: any) => value.role), ['user', 'assistant']);
      assert.strictEqual(saved.messages[0].content, prompt); assert.strictEqual(saved.messages[1].content, complete[0].payload.message.content);
      assert.strictEqual(saved.title, title.title);
      if (index === 0) {
        assert.ok(saved.agentConfig?.personaId);
        const context = saved.messages[0].context.find((item: any) => item.path === prepared.contextFile);
        assert.ok(context, 'The actual persisted user Message.context must include the selected context');
        assert.strictEqual(context.content, prepared.contextContent);
        await frame.locator('#history-btn').click();
        await frame.locator('#context-clear-btn').click();
      }
      snapshots.push({ marker, topic, requestedProvider: provider, titleReceipt: title, snapshot: saved });
      fs.writeFileSync(path.join(artifactRoot, 'created-conversations.json'), JSON.stringify(snapshots, null, 2));
      record('task-complete', { index: index + 1, marker, topic, conversationId, provider, titleKind: title.kind, title: title.title,
        orderedMessageIds: saved.messages.map((value: any) => value.id), transcriptSha256: hash(JSON.stringify(saved.messages)), sessionHash: wire[0].sessionHash });
    }

    before(async () => {
      assert.ok(stage === 'create' || stage === 'restart');
      artifactRoot = path.resolve(process.env.MYSTI_PC08_ARTIFACT_DIR!);
      prepared = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'prepared.json'), 'utf8'));
      assert.strictEqual(prepared.case, 'PC-08'); assert.strictEqual(prepared.preparedBeforeActivation, true);
      const profile = process.env.MYSTI_TEST_USER_DATA_DIR!;
      assert.strictEqual(fs.realpathSync(profile), fs.realpathSync(prepared.profile));
      assert.strictEqual(fs.realpathSync(process.env.MYSTI_TEST_OWNED_PROFILE!), fs.realpathSync(prepared.profile));
      artifactDir = path.join(artifactRoot, stage); fs.mkdirSync(artifactDir, { recursive: true });
      assert.ok(!fs.existsSync(path.join(artifactDir, 'observations.json')), 'Archive an earlier attempt instead of overwriting its evidence');
      requestBaseline = receipts().filter(value => value.event === 'request').length;
      assert.strictEqual(requestBaseline, 0, 'Fresh stage receipts must not hide an inference request sent before the test hook');
      auxiliaryBaseline = 0; // Include auxiliary inputs from activation before this hook.
      sampleProcesses(); sampler = setInterval(() => { try { sampleProcesses(); } catch (error) { record('process-sample-error', { message: String(error) }); } }, 250);
      if (stage === 'restart') {
        stageA = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'restart-expected.json'), 'utf8'));
        assert.strictEqual(stageA.stageComplete, true); assert.notStrictEqual(stageA.extensionHostPid, process.pid);
      } else assert.strictEqual(requestBaseline, 0);
      assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1);
      assert.strictEqual(fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), fs.realpathSync(path.join(__dirname, 'fixture-workspace')));
      assert.strictEqual(fs.readFileSync(prepared.contextFile, 'utf8'), prepared.contextContent);
      const config = vscode.workspace.getConfiguration('mysti');
      assert.strictEqual(config.get('claudeCodePath'), prepared.wrappers['claude-code']);
      assert.strictEqual(config.get('codexPath'), prepared.wrappers['openai-codex']);
      const requested = process.env.MYSTI_TEST_EXTENSION_PATH; assert.ok(requested && path.isAbsolute(requested));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      extensionPath = fs.realpathSync(extension.extensionPath); assert.strictEqual(extensionPath, fs.realpathSync(requested));
      extensionHash = hash(fs.readFileSync(path.join(extensionPath, 'dist/extension.js')));
      chatHash = hash(fs.readFileSync(path.join(extensionPath, 'media/chat/chat.js')));
      if (process.env.MYSTI_PC08_DISK_RUNNER === '1') {
        const developmentFlag = (extension as any).isUnderDevelopment;
        if (developmentFlag !== undefined) assert.strictEqual(developmentFlag, false);
        assert.strictEqual(extensionPath, fs.realpathSync(prepared.diskRunner.installedExtension));
        assert.strictEqual(extensionHash, prepared.diskRunner.bundleSha256);
        assert.strictEqual(chatHash, prepared.diskRunner.chatSha256);
      }
      if (stageA) { assert.strictEqual(extensionHash, stageA.bundleSha256); assert.strictEqual(chatHash, stageA.chatSha256); }
      record('loaded-extension-identity', { stage, actualPath: extensionPath, bundleSha256: extensionHash, chatSha256: chatHash, vscode: vscode.version,
        extensionHostPid: process.pid, reusedOwnedProfile: true, requestsBeforeLaunch: requestBaseline,
        isUnderDevelopment: (extension as any).isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API', installedPayload: process.env.MYSTI_PC08_DISK_RUNNER === '1' });
      const endpoint = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      for (const page of browser.contexts().flatMap(context => context.pages())) if (await page.locator('.monaco-workbench').count()) { workbench = page; break; }
      assert.ok(workbench); workbench.setDefaultTimeout(15_000);
      for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) originalTabs.add(tab);
      await extension.activate();
      const previousFrames = new Set(browser.contexts().flatMap(context => context.pages().flatMap(page => page.frames())));
      await vscode.commands.executeCommand('mysti.openInNewTab');
      await until('Dedicated test chat must mount', async () => {
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
        const win = globalThis as any; win.__pc08Events = [];
        win.__pc08Listener = (event: any) => {
          const message = event.data;
          if (!['conversationChanged', 'conversationHistory', 'messageAdded', 'responseStarted', 'responseChunk', 'responseComplete', 'requestCancelled',
            'titleUpdated', 'agentConfigUpdated', 'contextUpdated', 'permissionRequest', 'toolUse', 'error', 'authError'].includes(message?.type)) return;
          const p = message.payload || {};
          let payload = p;
          if (message.type === 'responseChunk') payload = { type: p.type, ...(p.type === 'text' ? { content: p.content } : {}) };
          if (message.type === 'permissionRequest') payload = { id: p.id };
          if (message.type === 'toolUse') payload = { id: p.id, name: p.name };
          win.__pc08Events.push({ type: message.type, payload, at: Date.now() });
        };
        win.addEventListener('message', win.__pc08Listener);
      });
      record('scope', { stage, conversationalRequestsPlanned: stage === 'create' ? 21 : 0,
        workload: '20 distinct small inline developer tasks; one stopped review; not the full F2 fixture or multi-day P/E workload.',
        contextContract: 'Persisted per-message context and historical attribution are compared; current composer provider/context are separate panel choices.' });
      if (stage === 'create') {
        const before = await newConversation();
        const eventCount = (await events('conversationChanged')).length;
        await frame.locator('#message-input').click();
        await vscode.commands.executeCommand('mysti.newConversation');
        await until('Public command must create a valid panel-owned conversation', async () => (await events('conversationChanged')).length > eventCount);
        const after = (await events('conversationChanged')).at(-1).payload;
        assert.match(after.id, /^[a-f0-9-]{36}$/); assert.notStrictEqual(after.id, before);
        assert.deepStrictEqual(after.messages, []);
        assert.strictEqual(await frame.locator('#messages .message.user, #messages .message.assistant').count(), 0);
        assert.strictEqual(receipts().filter(value => value.event === 'request').length, 0);
        record('unpaid-public-command-preflight', { command: 'mysti.newConversation', beforeId: before, afterId: after.id,
          validConversationPayload: true, emptyActualTranscript: true, conversationalRequests: 0, siblingScope: 'Not asserted by this single private-tab case' });
      }
    });

    afterEach(async function () {
      if (!artifactDir) return;
      record(this.currentTest?.state === 'passed' ? 'case-complete' : this.currentTest?.state === 'failed' ? 'case-failed' : 'case-not-reached', {
        title: this.currentTest?.title, state: this.currentTest?.state,
        error: this.currentTest?.err && { name: this.currentTest.err.name, message: this.currentTest.err.message } });
      if (this.currentTest?.state === 'failed' && workbench) await workbench.screenshot({ path: path.join(artifactDir, 'failure.png') }).catch(() => {});
    });
    after(async () => {
      if (!artifactDir) return;
      let remaining: number[] = []; const started = Date.now();
      try {
        if (frame && await frame.locator('#stop-btn').isVisible().catch(() => false)) await frame.locator('#stop-btn').click().catch(() => {});
        if (chatTab) await vscode.window.tabGroups.close(chatTab);
        do {
          sampleProcesses(); remaining = lastRows.filter(row => ownsProcess(conversationBirths, row)).map(([pid]) => pid);
          if (!remaining.length) break; await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() - started < 10_000);
      } finally {
        await browser?.close(); if (sampler) clearInterval(sampler); sampleProcesses();
      }
      const inputs = receipts().filter(value => value.event === 'auxiliary-input').slice(auxiliaryBaseline);
      record('cleanup', { stageComplete, remainingConversationPids: remaining, durationMs: Date.now() - started,
        conversationalRequestsThisLaunch: receipts().filter(value => value.event === 'request').length - requestBaseline,
        auxiliaryInputsThisLaunch: inputs.length, auxiliaryKinds: inputs.reduce((counts: Record<string, number>, value: any) => ({ ...counts, [value.kind]: (counts[value.kind] || 0) + 1 }), {}),
        editorLifetimeCleanup: 'PENDING_EXTERNAL_CHECK after actual editor exit; unused warm workers are not inference requests.' });
      assert.deepStrictEqual(remaining, []);
      assert.strictEqual(fs.readFileSync(prepared.contextFile, 'utf8'), prepared.contextContent);
      if (extensionPath && extensionHash) assert.strictEqual(hash(fs.readFileSync(path.join(extensionPath, 'dist/extension.js'))), extensionHash);
      if (extensionPath && chatHash) assert.strictEqual(hash(fs.readFileSync(path.join(extensionPath, 'media/chat/chat.js'))), chatHash);
    });

    if (stage === 'create') {
      it('creates 20 real titled developer conversations and revisits the oldest without losing attribution or context', async () => {
        for (let index = 0; index < TASKS.length; index++) await sendTask(index);
        const oldest = await switchConversation(snapshots[0].snapshot.id);
        assert.deepStrictEqual(semanticSnapshot(oldest), snapshots[0].snapshot); await assertRendered(oldest);
        assert.ok(!(await frame.locator('#toolbar-persona-name').innerText()).includes('No persona'));
        assert.strictEqual(receipts().filter(value => value.event === 'request').length, 20);
        record('oldest-round-trip', { id: oldest.id, exactSemanticSnapshot: true, messageContextPreserved: true, personaPreserved: true });
      });
      it('persists a genuinely interrupted response and deletes only the chosen completed conversation before shutdown', async function () {
        if (snapshots.length !== 20) { this.skip(); return; }
        const id = await newConversation(); await selectProvider('claude-code');
        const marker = 'PC08_TASK_INTERRUPTED';
        const prompt = `${marker}: Cancellation-safe retry review\nUse no tools. Immediately begin 80 numbered concrete review points, each 30–40 words, about cancellation-safe retries and cache consistency. This is an inline test; do not read or write files.`;
        const offset = (await events()).length;
        await frame.locator('#message-input').fill(prompt); await frame.locator('#send-btn').click();
        await until('Interrupted review must produce real text', async () => { await noUnexpectedToolsOrErrors(offset); return (await events()).slice(offset).some(value => value.type === 'responseChunk' && value.payload.type === 'text' && value.payload.content); }, 120_000);
        await frame.locator('#stop-btn').click();
        await until('Stop must acknowledge the persisted partial', async () => (await events()).slice(offset).some(value => value.type === 'requestCancelled') && !await frame.locator('#stop-btn').isVisible(), 5000);
        const cancelled = (await events()).slice(offset).filter(value => value.type === 'requestCancelled');
        assert.strictEqual(cancelled.length, 1); assert.ok(cancelled[0].payload.message?.content);
        assert.strictEqual((await events()).slice(offset).filter(value => value.type === 'responseComplete').length, 0);
        const title = await titleReceipt(id, marker, prompt);
        const interrupted = (await history()).find(value => value.id === id); assert.ok(interrupted);
        const interruptedSnapshot = semanticSnapshot(interrupted);
        assert.deepStrictEqual(interruptedSnapshot.messages.map((value: any) => value.role), ['user', 'assistant']);
        assert.strictEqual(interruptedSnapshot.messages[1].content, cancelled[0].payload.message.content);
        snapshots.push({ marker, requestedProvider: 'claude-code', titleReceipt: title, snapshot: interruptedSnapshot });
        // Delete a non-current completed conversation through its real row.
        const deleted = snapshots[9].snapshot;
        const allBefore = await history(), index = allBefore.findIndex(value => value.id === deleted.id); assert.ok(index >= 0);
        const count = (await events('conversationHistory')).length;
        await frame.locator(`#history-menu .history-item[data-conversation-id=${JSON.stringify(deleted.id)}] .history-item-delete`).click();
        await until('Public Delete must remove only its intended owner', async () => (await events('conversationHistory')).length > count);
        const allAfter = (await events('conversationHistory')).at(-1).payload.conversations;
        assert.deepStrictEqual(allAfter.map((value: any) => value.id).sort(), allBefore.filter(value => value.id !== deleted.id).map(value => value.id).sort());
        for (const saved of snapshots.filter(value => value.snapshot.id !== deleted.id)) {
          assert.deepStrictEqual(semanticSnapshot(allAfter.find((value: any) => value.id === saved.snapshot.id)), saved.snapshot);
        }
        assert.strictEqual(receipts().filter(value => value.event === 'request').length, 21);
        stageComplete = true;
        const expected = { stageComplete, extensionHostPid: process.pid, bundleSha256: extensionHash, chatSha256: chatHash, deletedConversationId: deleted.id,
          snapshots: snapshots.filter(value => value.snapshot.id !== deleted.id), interruptedConversationId: id, completedTaskCount: 20,
          totalConversationalRequests: 21, firstStageEndedAt: new Date().toISOString() };
        fs.writeFileSync(path.join(artifactRoot, 'restart-expected.json'), JSON.stringify(expected, null, 2));
        record('restart-prepared', { completedTaskCount: 20, retainedConversationCount: expected.snapshots.length, interruptedConversationId: id,
          deletedConversationId: deleted.id, noOtherTranscriptChanged: true, requests: 21 });
        await workbench.screenshot({ path: path.join(artifactDir, 'before-editor-shutdown.png') });
      });
    } else if (stage === 'restart') {
      it('restores exact completed and interrupted history after a real process restart and keeps deletion durable', async () => {
        const restored = await history();
        record('restart-observed-history', { expectedIds: stageA.snapshots.map((value: any) => value.snapshot.id), deletedId: stageA.deletedConversationId,
          restored: restored.map(value => ({ id: value.id, messageCount: value.messages.length, title: value.title })) });
        assert.ok(!restored.some(value => value.id === stageA.deletedConversationId), 'Deleted conversation must not resurrect after restart');
        for (const expected of stageA.snapshots) {
          const conversation = restored.find(value => value.id === expected.snapshot.id); assert.ok(conversation, 'Acknowledged conversation must survive shutdown');
          assert.deepStrictEqual(semanticSnapshot(conversation), expected.snapshot);
          const selected = await switchConversation(conversation.id);
          assert.deepStrictEqual(semanticSnapshot(selected), expected.snapshot); await assertRendered(selected);
          if (expected.snapshot.agentConfig?.personaId) assert.ok(!(await frame.locator('#toolbar-persona-name').innerText()).includes('No persona'));
          record('restart-conversation-verified', { marker: expected.marker, id: conversation.id, title: conversation.title,
            orderedMessageIds: selected.messages.map((value: any) => value.id), transcriptSha256: hash(JSON.stringify(expected.snapshot.messages)),
            provider: conversation.provider, model: conversation.model, agentConfigPreserved: true, messageContextPreserved: true });
        }
        assert.strictEqual(receipts().filter(value => value.event === 'request').length, requestBaseline, 'History navigation must not send a model request');
        const interrupted = await switchConversation(stageA.interruptedConversationId);
        assert.strictEqual(interrupted.messages.length, 2); assert.strictEqual(await frame.locator('#messages .message.streaming').count(), 0);
        assert.strictEqual(await frame.locator('#stop-btn').isVisible(), false); assert.strictEqual(await frame.locator('#message-input').isEnabled(), true);
        stageComplete = true;
        record('actual-restart-accepted', { exactConversations: stageA.snapshots.length, completedAndInterruptedRetained: true, deletionDurable: true,
          oldExtensionHostPid: stageA.extensionHostPid, newExtensionHostPid: process.pid, conversationalRequestsThisLaunch: 0 });
        await workbench.screenshot({ path: path.join(artifactDir, 'after-editor-restart.png') });
      });
    }
  });
}
