import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { SESSION_SHAPES } from '../../src/managers/sessionShapes';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { createHarness } from '../helpers/autoContextSendHarness';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const settings = { provider: 'claude-code', model: 'claude-opus-4-6', mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
const question = 'Keep this exact question after cancellation.';
const attachment = { id: 'original-attachment', type: 'file', fileName: 'original.txt', mimeType: 'text/plain',
  size: 14, base64Data: Buffer.from('ORIGINAL_BYTES').toString('base64') };
let browser: Browser, page: Page, root: string, file: string, h: ReturnType<typeof createHarness>, host: any;
let manager: ConversationManager, errors: string[], cursor: number, releases: Array<() => void>, closed: number, opened: number;
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const posted = () => page.evaluate(() => (window as any).__posted as any[]);
const sends = async () => (await posted()).filter(event => ['sendMessage', 'sendBrainstormMessage', 'startSession'].includes(event.type));
const cards = () => page.locator('.unsent-message');

beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
beforeEach(async () => {
  clearMockConfig(); setMockConfig('autoContext', false); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-submission-recovery-')); file = path.join(root, 'context.ts');
  fs.writeFileSync(file, 'OWNED_FILE'); errors = []; cursor = 0; releases = []; opened = 0; closed = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Submission recovery fixture forbids provider requests'); }));
  h = createHarness(); host = h.provider as any; h.setStream([{ type: 'text', content: 'Owned answer.' }, { type: 'done' }]);
  h.providerManager.getAllProviderIds = () => ['claude-code', 'openai-codex'];
  const storage: Record<string, unknown> = {};
  manager = new ConversationManager({ globalState: { get: (key: string, fallback: unknown) => key in storage ? structuredClone(storage[key]) : fallback,
    update: async (key: string, value: unknown) => { storage[key] = structuredClone(value); } } } as any);
  host._conversationManager = manager; host._generateTitleAsync = vi.fn();
  host._panelStates.get('sidebar').currentConversationId = manager.getCurrentConversation()!.id;
  await h.contextManager.addFileToContext(file, 'sidebar');
  page = await browser.newPage({ viewport: { width: 500, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort()); await page.setContent(composeChatHtml());
  await receive('initialState', { ...INITIAL_STATE, panelId: 'sidebar', settings, conversation: manager.getCurrentConversation(),
    providerAvailability: { 'claude-code': { available: true }, 'openai-codex': { available: true } },
    context: h.contextManager.getContext('sidebar'), providers: registry.getAll().map(entry => entry.config), providerManifest: buildProviderManifestPayload(registry) });
});
afterEach(async () => {
  for (const release of releases) release();
  if (process.env.MYSTI_SUBMISSION_RECOVERY_RECEIPTS) fs.appendFileSync(process.env.MYSTI_SUBMISSION_RECOVERY_RECEIPTS, JSON.stringify({
    test: expect.getState().currentTestName, opened, closed, providerCalls: h.providerManager.sendMessage.mock.calls.length,
    settled: h.sidebarMessages.filter(message => message.type === 'composerSubmissionSettled'),
    cards: await cards().allTextContents(), draft: await page.locator('#message-input').inputValue(),
    submissions: (await sends()).map(event => ({ type: event.type, submissionId: event.payload.submissionId, content: event.payload.content,
      attachments: event.payload.attachments?.map((item: any) => ({ name: item.fileName, bytes: item.size, sha256: createHash('sha256').update(Buffer.from(item.base64Data ?? '', 'base64')).digest('hex') })) })),
  }) + '\n');
  await page?.close(); await host?._agentInitPromise; h?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true }); expect(errors).toEqual([]); expect(closed).toBe(opened);
});
afterAll(async () => { await browser?.close(); registry.dispose(); });
async function pump() {
  for (; cursor < h.sidebarMessages.length; cursor++) { const event = h.sidebarMessages[cursor]; await receive(event.type, event.payload); }
}
async function dispatch(message: any) {
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage(message, 'sidebar', owner.webview); await pump();
}
async function stage(item = attachment) { await receive('fileAttachmentSelected', { attachments: [item] }); }
async function submit(text = question, provider = 'claude-code') {
  if (provider !== 'claude-code') { await page.locator('#agent-select-btn').click(); await page.locator(`#agent-menu .agent-menu-item[data-agent="${provider}"]`).click(); }
  await stage(); await page.locator('#message-input').fill(text); await page.locator('#send-btn').click();
  const message = (await sends()).at(-1); expect(message).toBeDefined(); return message;
}
function holdRead() {
  const open = fs.promises.open.bind(fs.promises); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const held = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
    const handle = await (open as any)(...args); if (String(args[0]) !== file) return handle;
    opened++; const read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...readArgs: any[]) => { const result = await read(...readArgs); enter(); await held; return result; };
    handle.close = async () => { closed++; await close(); }; return handle;
  });
  return { entered, release };
}
async function heldSubmission() {
  const gate = holdRead(), message = await submit(), pending = dispatch(message);
  await Promise.race([gate.entered, pending.then(() => { throw new Error('Submission ended before the actual file read'); })]);
  return { gate, message, pending };
}
async function stop() {
  await page.locator('#stop-btn').click(); const message = (await posted()).filter(event => event.type === 'cancelRequest').at(-1);
  expect(message).toBeDefined(); await dispatch(message);
}
async function recoverOriginal() {
  expect(await cards().count()).toBe(1); expect(await cards().textContent()).toContain(question);
  await cards().locator('[data-action="restore"]').click();
  expect(await page.locator('#message-input').inputValue()).toBe(question);
  expect(await page.locator('.attachment-name').allTextContents()).toEqual(['original.txt']);
  expect(await cards().count()).toBe(0); expect(await sends()).toHaveLength(1);
  await page.locator('#send-btn').click(); const retry = (await sends()).at(-1);
  expect(retry.payload.attachments).toEqual([attachment]); expect(retry.payload.content).toBe(question);
}

describe('composer submission recovery before the real host records a question', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('Stop during context preparation keeps the original question and exact attachment bytes recoverable', async () => {
    const run = await heldSubmission(); await stop(); run.gate.release(); await run.pending;
    expect(h.providerManager.sendMessage).not.toHaveBeenCalled(); expect(manager.getCurrentConversation()!.messages).toEqual([]);
    await recoverOriginal();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Clear during context preparation keeps the abandoned question recoverable without sending it', async () => {
    const run = await heldSubmission(); h.contextManager.clearContext('sidebar'); run.gate.release(); await run.pending;
    expect(h.providerManager.sendMessage).not.toHaveBeenCalled(); await recoverOriginal();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a newer draft and its attachments survive until the user explicitly frees the composer', async () => {
    const run = await heldSubmission(); await page.locator('#message-input').fill('NEWER_DRAFT');
    await stage({ ...attachment, id: 'newer', fileName: 'newer.txt', base64Data: 'TkVX' }); await stop(); run.gate.release(); await run.pending;
    expect(await cards().count()).toBe(1); await cards().locator('[data-action="restore"]').click();
    expect(await page.locator('#message-input').inputValue()).toBe('NEWER_DRAFT'); expect(await page.locator('.attachment-name').allTextContents()).toEqual(['newer.txt']);
    expect(await cards().count()).toBe(1); await page.locator('#message-input').fill(''); await page.locator('.attachment-remove').click();
    await recoverOriginal();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a cancelled request stays with its original conversation when navigation changes the active draft', async () => {
    const original = structuredClone(manager.getCurrentConversation()!); const run = await heldSubmission();
    const other = { id: 'other-conversation', messages: [] };
    host._panelStates.get('sidebar').currentConversationId = other.id; host._panelStates.get('sidebar').navigationRevision = 1;
    await receive('conversationChanged', other); await page.locator('#message-input').fill('OTHER_CONVERSATION_DRAFT');
    run.gate.release(); await run.pending;
    expect(await cards().count()).toBe(0); expect(await page.locator('#message-input').inputValue()).toBe('OTHER_CONVERSATION_DRAFT');
    host._panelStates.get('sidebar').currentConversationId = original.id; await receive('conversationChanged', original);
    await recoverOriginal();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('accepted questions remain in history and do not become unsent messages after Stop', async () => {
    const message = await submit(); await dispatch(message);
    expect(manager.getCurrentConversation()!.messages.filter(item => item.role === 'user')).toHaveLength(1);
    await dispatch({ type: 'cancelRequest' }); expect(await cards().count()).toBe(0);
    expect(await page.locator('#message-input').inputValue()).toBe('');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('brainstorm cancellation preserves its original text and attachments before any agents start', async () => {
    const gate = holdRead(), message = await submit(question, 'brainstorm'); expect(message.type).toBe('sendBrainstormMessage');
    const pending = dispatch(message); await Promise.race([gate.entered, pending.then(() => { throw new Error('Brainstorm ended before reading'); })]);
    await stop(); gate.release(); await pending; await recoverOriginal();
    expect(h.providerManager.sendMessage).not.toHaveBeenCalled();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a session cancelled before its first lane restores the brief as a command', async () => {
    const gate = holdRead(); await receive('openSessionPicker', { commandId: 'session:review', brief: question,
      sessions: SESSION_SHAPES.map(shape => ({ ...shape, commandId: 'session:' + shape.id })) });
    await page.locator('.session-run-btn').click(); const message = (await sends()).at(-1); expect(message.type).toBe('startSession');
    const pending = dispatch(message); await Promise.race([gate.entered, pending.then(() => { throw new Error('Session ended before reading'); })]);
    await stop(); gate.release(); await pending;
    expect(await cards().count()).toBe(1); await cards().locator('[data-action="restore"]').click();
    expect(await page.locator('#message-input').inputValue()).toBe('/review ' + question);
    expect(await sends()).toHaveLength(1); expect(h.providerManager.sendMessage).not.toHaveBeenCalled();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a failed settings write returns the submission without trying a file read or provider', async () => {
    const message = await submit(); const failed = Promise.reject(new Error('Owned settings write fault')); failed.catch(() => {});
    host._panelStates.get('sidebar').pendingSettingsUpdates = new Set([failed]); await dispatch(message);
    expect(h.providerManager.sendMessage).not.toHaveBeenCalled(); expect(opened).toBe(0); await recoverOriginal();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('Stop during compaction returns the original question when preparation settles', async () => {
    let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
    host._panelCompactions.set('sidebar', paused); const message = await submit(), pending = dispatch(message);
    await expect.poll(() => host._mystiRunGen.get('sidebar')).toBe(1); await stop();
    host._panelCompactions.delete('sidebar'); release(); await pending; await recoverOriginal();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('duplicate acknowledgements and a detached Restore button cannot duplicate recovered bytes', async () => {
    const run = await heldSubmission(); await stop(); run.gate.release(); await run.pending;
    const settled = h.sidebarMessages.find(event => event.type === 'composerSubmissionSettled')!; expect(settled).toBeDefined();
    await receive(settled.type, settled.payload); expect(await cards().count()).toBe(1);
    const restore = await cards().locator('[data-action="restore"]').elementHandle(); await restore!.click();
    await page.locator('#message-input').fill('NEWER_DRAFT'); await restore!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await receive(settled.type, settled.payload); expect(await cards().count()).toBe(0);
    expect(await page.locator('#message-input').inputValue()).toBe('NEWER_DRAFT'); expect(await sends()).toHaveLength(1);
  });
  for (const draft of ['KEEP_DRAFT', '/review KEEP_DRAFT']) it.skipIf(CHROMIUM_UNAVAILABLE)(`Dismiss drops recovery without affecting the draft ${draft}`, async () => {
    const run = await heldSubmission(); await stop(); run.gate.release(); await run.pending;
    await page.locator('#message-input').fill(draft); await cards().locator('[data-action="dismiss"]').click();
    expect(await cards().count()).toBe(0); expect(await page.locator('#message-input').inputValue()).toBe(draft); expect(await sends()).toHaveLength(1);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a returned queued submission preserves the independent composer draft and bytes', async () => {
    await receive('responseStarted', { provider: 'claude-code' }); await stage(); await page.locator('#message-input').fill(question); await page.locator('#message-input').press('Tab');
    await page.locator('#message-input').fill('QUEUE_DRAFT'); await stage({ ...attachment, id: 'draft-only', fileName: 'draft.txt' });
    const gate = holdRead(); await receive('responseComplete', { message: { id: 'parent-response', role: 'assistant', content: 'Done.' } });
    const message = (await sends()).at(-1), pending = dispatch(message); await gate.entered; await stop(); gate.release(); await pending;
    expect(await cards().count()).toBe(1); expect(await page.locator('#message-input').inputValue()).toBe('QUEUE_DRAFT');
    expect(await page.locator('.attachment-name').allTextContents()).toEqual(['draft.txt']); expect(await sends()).toHaveLength(1);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a replaced panel cannot return its pending submission into the successor', async () => {
    const run = await heldSubmission(), original = host._panelStates.get('sidebar');
    host._panelStates.set('sidebar', { ...original, navigationRevision: 1 }); run.gate.release(); await run.pending;
    expect(h.sidebarMessages.filter(event => event.type === 'composerSubmissionSettled')).toEqual([]); expect(await cards().count()).toBe(0);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a newly submitted successor is not reset by an older cancellation receipt', async () => {
    const run = await heldSubmission(); await stop(); await page.locator('#message-input').fill('SUCCESSOR_REQUEST'); await page.locator('#send-btn').click();
    const successor = (await sends()).at(-1), pending = dispatch(successor); await expect.poll(() => opened).toBe(2);
    run.gate.release(); await Promise.all([run.pending, pending]);
    expect(h.providerManager.sendMessage).toHaveBeenCalledTimes(1); expect(await cards().count()).toBe(1);
    expect(await cards().textContent()).toContain(question); expect(await cards().textContent()).not.toContain('SUCCESSOR_REQUEST');
    expect(manager.getCurrentConversation()!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['SUCCESSOR_REQUEST']);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('accepted receipt is emitted before a provider response and cannot be reversed by a late false receipt', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
    h.providerManager.sendMessage.mockImplementation(async function* () { enter(); await held; yield { type: 'done' }; });
    const message = await submit(), pending = dispatch(message); await entered; await pump();
    const settled = h.sidebarMessages.find(event => event.type === 'composerSubmissionSettled')!;
    expect(settled.payload.accepted).toBe(true); await stop(); release(); await pending;
    await receive(settled.type, { ...settled.payload, accepted: false }); expect(await cards().count()).toBe(0);
    expect(manager.getCurrentConversation()!.messages.filter(item => item.role === 'user')).toHaveLength(1);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('renders literal text and filenames in a bounded narrow recovery card', async () => {
    const text = '<img src=x onerror="window.injected=1"> ' + 'Long'.repeat(200);
    const named = { ...attachment, fileName: '<svg onload="window.injected=1">' + 'name'.repeat(100) };
    const gate = holdRead(); await stage(named); await page.locator('#message-input').fill(text); await page.locator('#send-btn').click();
    const message = (await sends()).at(-1), pending = dispatch(message); await gate.entered; await stop(); gate.release(); await pending;
    expect(await cards().textContent()).toContain(text); expect(await cards().locator('img, svg').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
    await page.setViewportSize({ width: 390, height: 800 }); const box = await cards().boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390); expect(box!.height).toBeLessThan(180);
    await cards().locator('[data-action="restore"]').click(); expect(await page.locator('#message-input').inputValue()).toBe(text);
    await page.locator('#send-btn').click(); expect((await sends()).at(-1).payload.attachments).toEqual([named]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps an explicitly empty attachment through cancellation and manual retry', async () => {
    const empty = { ...attachment, size: 0, base64Data: '' }, gate = holdRead();
    await stage(empty); await page.locator('#message-input').fill(question); await page.locator('#send-btn').click();
    const message = (await sends()).at(-1), pending = dispatch(message); await gate.entered; await stop(); gate.release(); await pending;
    await cards().locator('[data-action="restore"]').click(); await page.locator('#send-btn').click();
    expect((await sends()).at(-1).payload.attachments).toEqual([empty]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('ignores unknown or wrong-conversation acknowledgements without consuming the pending submission', async () => {
    const run = await heldSubmission();
    await receive('composerSubmissionSettled', { submissionId: 'not-ours', conversationId: manager.getCurrentConversation()!.id, accepted: false });
    await receive('composerSubmissionSettled', { submissionId: run.message.payload.submissionId, conversationId: 'not-ours', accepted: false });
    expect(await cards().count()).toBe(0); await stop(); run.gate.release(); await run.pending; await recoverOriginal();
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('rebinding the view clears recovery and ignores old acknowledgements even after returning to the old panel id', async () => {
    const run = await heldSubmission(); await stop(); run.gate.release(); await run.pending; expect(await cards().count()).toBe(1);
    const settled = h.sidebarMessages.find(event => event.type === 'composerSubmissionSettled')!;
    for (const panelId of ['replacement', 'sidebar']) {
      await receive('initialState', { ...INITIAL_STATE, panelId, settings, conversation: manager.getCurrentConversation(),
        providers: registry.getAll().map(entry => entry.config), providerManifest: buildProviderManifestPayload(registry) });
      await receive(settled.type, settled.payload); expect(await cards().count()).toBe(0);
    }
  });
});
