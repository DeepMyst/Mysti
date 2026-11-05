import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { BrainstormManager } from '../../src/managers/BrainstormManager';
import { BaseCliProvider } from '../../src/providers/base/BaseCliProvider';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { createHarness } from '../helpers/autoContextSendHarness';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import type { ContextItem, Settings } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));

const settings = { provider: 'claude-code', model: 'claude-opus-4-6', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const clone = <T>(value: T): T => structuredClone(value);
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let browser: Browser, page: Page, root: string, h: ReturnType<typeof createHarness>, host: any;
let manager: ConversationManager, errors: string[], captures: Array<{ context: ContextItem[]; prompt: string }>;
let releases: Array<() => void>, reads: Array<{ path: string; bytes: number; closed: number }>;
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });

beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) { return; } browser = await chromium.launch(); });
beforeEach(async () => {
  clearMockConfig(); setMockConfig('autoContext', false); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  captures = []; errors = []; releases = []; reads = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-context-send-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Context freshness fixture forbids external provider requests'); }));
  h = createHarness(); host = h.provider as any;
  h.providerManager.getAllProviderIds = () => ['claude-code', 'openai-codex'];
  const storage: Record<string, unknown> = {};
  manager = new ConversationManager({ globalState: {
    get: (key: string, fallback: unknown) => key in storage ? clone(storage[key]) : fallback,
    update: async (key: string, value: unknown) => { storage[key] = clone(value); },
  } } as any);
  host._conversationManager = manager;
  host._panelStates.get('sidebar').currentConversationId = manager.getCurrentConversation()!.id;
  host._generateTitleAsync = vi.fn();
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), { id: 'claude-code',
    capabilities: { supportsImages: false, supportsFileAttachments: false }, _nativeHistoryDeltas: new WeakSet() });
  h.providerManager.sendMessage.mockImplementation(async function* (content: string, context: ContextItem[], runtime: Settings,
    conversation: unknown, persona: unknown, _panel: string, config: unknown, attachments: unknown, resolveInput?: () => any) {
    if (resolveInput) { const input = resolveInput(); if (!input) return; ({ content, context } = input); }
    captures.push({ context: clone(context), prompt: await builder.buildPromptAsync(content, context, conversation, runtime, persona, config, attachments) });
    yield { type: 'text', content: 'Controlled answer.' }; yield { type: 'done' };
  });
  page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort()); await page.setContent(composeChatHtml());
  await receive('initialState', { ...INITIAL_STATE, panelId: 'sidebar', settings, conversation: manager.getCurrentConversation(),
    providers: registry.getAll().map(provider => provider.config), providerManifest: buildProviderManifestPayload(registry) });
});
afterEach(async () => {
  for (const release of releases) release();
  if (process.env.MYSTI_CONTEXT_SEND_RECEIPTS) fs.appendFileSync(process.env.MYSTI_CONTEXT_SEND_RECEIPTS, JSON.stringify({
    test: expect.getState().currentTestName, reads, captures: captures.map(record => ({
      context: record.context.map(item => ({ ...item, content: undefined, bytes: Buffer.byteLength(item.content ?? ''), sha256: digest(item.content ?? '') })),
      promptBytes: Buffer.byteLength(record.prompt), promptSHA256: digest(record.prompt),
    })), warnings: h.sidebarMessages.filter(event => event.type === 'contextWarning'),
    errors: h.sidebarMessages.filter(event => event.type === 'error'),
  }) + '\n');
  await page?.close(); await host?._agentInitPromise; h?.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true });
  expect(errors).toEqual([]); expect(reads.every(read => read.closed === 1)).toBe(true);
});
afterAll(async () => { await browser?.close(); registry.dispose(); });

async function add(name = 'current.ts', content = 'ORIGINAL_FILE_BYTES') {
  const file = path.join(root, name); fs.writeFileSync(file, content);
  const item = await h.contextManager.addFileToContext(file, 'sidebar'); expect(item).not.toBeNull();
  await receive('contextUpdated', clone(h.contextManager.getContext('sidebar'))); return item!;
}
async function send(payload?: any, type = 'sendMessage') {
  if (!payload) {
    await page.locator('#message-input').fill('Inspect current context.'); await page.locator('#send-btn').click();
    const message = await page.evaluate(() => (window as any).__posted.filter((event: any) => event.type === 'sendMessage').at(-1));
    expect(message).toBeDefined(); payload = message.payload;
  }
  const start = h.sidebarMessages.length, owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type, payload }, 'sidebar', owner.webview);
  const events = h.sidebarMessages.slice(start);
  const failures = events.filter(event => ['error', 'sessionError', 'brainstormError', 'brainstormAgentError'].includes(event.type));
  expect(failures, JSON.stringify(failures)).toEqual([]);
  for (const event of events) await receive(event.type, event.payload);
}
function observeRead(file: string, hold = false) {
  const realOpen = fs.promises.open.bind(fs.promises);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
    const handle = await (realOpen as any)(...args);
    if (String(args[0]) !== file) return handle;
    const receipt = { path: file, bytes: 0, closed: 0 }; reads.push(receipt);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...readArgs: any[]) => { const result = await read(...readArgs); receipt.bytes += result.bytesRead; enter(); if (hold) await paused; return result; };
    handle.close = async () => { receipt.closed++; await close(); };
    return handle;
  });
  return { entered, release };
}
async function reach(gate: ReturnType<typeof observeRead>, pending: Promise<void>) {
  await Promise.race([gate.entered, pending.then(() => { throw new Error('Send completed without rereading the context file'); })]);
}

describe('EW02 persistent context freshness through composer, host, and prompt builder', () => {
  it.skipIf(CHROMIUM_UNAVAILABLE)('rereads each send and preserves earlier message snapshots', async () => {
    const item = await add(); await send();
    fs.writeFileSync(item.path, 'UPDATED_FILE_BYTES'); observeRead(item.path); await send();
    expect(captures).toHaveLength(2); expect(captures[1].context[0].content).toBe('UPDATED_FILE_BYTES');
    expect(captures[1].prompt).toContain('UPDATED_FILE_BYTES');
    expect(manager.getCurrentConversation()!.messages.filter(message => message.role === 'user').map(message => message.context![0].content))
      .toEqual(['ORIGINAL_FILE_BYTES', 'UPDATED_FILE_BYTES']);
    expect(h.contextManager.getContext('sidebar')[0].content).toBe('UPDATED_FILE_BYTES');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps an edited empty file as valid context', async () => {
    const item = await add(); fs.writeFileSync(item.path, ''); await send();
    expect(captures[0].context).toHaveLength(1); expect(captures[0].context[0].content).toBe('');
  });
  for (const fault of ['removed', 'oversized', 'invalid UTF-8', 'NUL', 'directory'] as const) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`drops ${fault} files, warns, and retains a valid sibling`, async () => {
      const bad = await add('bad.ts'), good = await add('good.ts', 'GOOD_ORIGINAL');
      if (fault === 'removed' || fault === 'directory') fs.unlinkSync(bad.path);
      if (fault === 'directory') fs.mkdirSync(bad.path);
      if (fault === 'oversized') fs.writeFileSync(bad.path, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
      if (fault === 'invalid UTF-8') fs.writeFileSync(bad.path, Buffer.from([0xc3, 0x28]));
      if (fault === 'NUL') fs.writeFileSync(bad.path, 'BAD\0TEXT');
      fs.writeFileSync(good.path, 'GOOD_UPDATED'); observeRead(bad.path); await send();
      expect(captures[0].context.map(item => [item.path, item.content])).toEqual([[good.path, 'GOOD_UPDATED']]);
      expect(captures[0].prompt).not.toContain('ORIGINAL_FILE_BYTES');
      expect(h.contextManager.getContext('sidebar').map(item => item.id)).toEqual([good.id]);
      expect(h.sidebarMessages.filter(event => event.type === 'contextWarning')).toHaveLength(1);
      expect(await page.locator('#context-items').textContent()).not.toContain('bad.ts');
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('does not reread disabled files and retains selected text snapshots', async () => {
    const item = await add(); h.contextManager.setItemEnabled(item.id, false, 'sidebar');
    const selection = await h.contextManager.addSelectionToContext(item.path, 'SELECTION_SNAPSHOT', 2, 4, 'typescript', 'sidebar');
    fs.unlinkSync(item.path); observeRead(item.path);
    await receive('contextUpdated', clone(h.contextManager.getContext('sidebar'))); await send();
    expect(captures[0].prompt).toContain('SELECTION_SNAPSHOT'); expect(captures[0].prompt).not.toContain('ORIGINAL_FILE_BYTES');
    expect(captures[0].context.find(entry => entry.id === selection!.id)?.content).toBe('SELECTION_SNAPSHOT');
    expect(reads).toEqual([]); expect(h.sidebarMessages.filter(event => event.type === 'contextWarning')).toEqual([]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('reuses the original question snapshot for a second opinion after the file is deleted', async () => {
    const item = await add(); await send(); fs.unlinkSync(item.path); observeRead(item.path);
    const question = manager.getCurrentConversation()!.messages.find(message => message.role === 'user')!;
    h.providerManager.getProvider = (id: string) => registry.get(id)?.config;
    h.providerManager.getModels = (id: string) => registry.get(id)?.config.models ?? [];
    await send({ content: 'Unrelated draft', context: [], settings, secondOpinion: { provider: 'claude-code', messageId: question.id } });
    expect(captures).toHaveLength(2); expect(captures[1].context[0].content).toBe('ORIGINAL_FILE_BYTES'); expect(reads).toEqual([]);
  });
  for (const action of ['clear', 'navigation', 'close', 'stop'] as const) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${action} while reading revokes the send without stale feedback`, async () => {
      const item = await add(); fs.writeFileSync(item.path, 'UPDATED_FILE_BYTES'); const gate = observeRead(item.path, true);
      const pending = send(); await reach(gate, pending);
      if (action === 'clear') h.contextManager.clearContext('sidebar');
      if (action === 'navigation') host._panelStates.get('sidebar').navigationRevision = 1;
      if (action === 'close') { host._panelStates.delete('sidebar'); h.contextManager.clearPanelContext('sidebar'); }
      if (action === 'stop') { const owner = host._panelStates.get('sidebar'); await host._receivePanelMessage({ type: 'cancelRequest' }, 'sidebar', owner.webview); }
      gate.release(); await pending; expect(captures).toEqual([]);
      expect(manager.getCurrentConversation()!.messages).toEqual([]);
      expect(h.sidebarMessages.filter(event => event.type === 'contextWarning' || event.type === 'contextUpdated')).toEqual([]);
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('disabling a file during the actual read excludes its bytes from this turn', async () => {
    const item = await add(); fs.writeFileSync(item.path, 'UPDATED_FILE_BYTES'); const gate = observeRead(item.path, true);
    const pending = send(); await reach(gate, pending); h.contextManager.setItemEnabled(item.id, false, 'sidebar');
    gate.release(); await pending;
    expect(captures).toHaveLength(1); expect(captures[0].context[0].enabled).toBe(false);
    expect(captures[0].prompt).not.toMatch(/ORIGINAL_FILE_BYTES|UPDATED_FILE_BYTES/);
    expect(h.contextManager.getContext('sidebar')[0].content).toBe('ORIGINAL_FILE_BYTES');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('cancelling a later read does not partially commit earlier refreshed files', async () => {
    const first = await add('first.ts', 'FIRST_ORIGINAL'), second = await add('second.ts', 'SECOND_ORIGINAL');
    fs.writeFileSync(first.path, 'FIRST_UPDATED'); fs.writeFileSync(second.path, 'SECOND_UPDATED');
    const gate = observeRead(second.path, true); const pending = send(); await reach(gate, pending);
    const owner = host._panelStates.get('sidebar'); await host._receivePanelMessage({ type: 'cancelRequest' }, 'sidebar', owner.webview);
    gate.release(); await pending; expect(captures).toEqual([]);
    expect(h.contextManager.getContext('sidebar').map(item => item.content)).toEqual(['FIRST_ORIGINAL', 'SECOND_ORIGINAL']);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves a newly added file without injecting it into an already submitted turn', async () => {
    const first = await add(); fs.writeFileSync(first.path, 'FIRST_UPDATED'); const gate = observeRead(first.path, true);
    const pending = send(); await reach(gate, pending); const added = await add('later.ts', 'LATER_PRIVATE');
    gate.release(); await pending;
    expect(captures[0].context.map(item => item.content)).toEqual(['FIRST_UPDATED']);
    expect(h.contextManager.getContext('sidebar').map(item => item.id)).toEqual([first.id, added.id]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a superseding submission owns the refresh and the only dispatched request', async () => {
    const item = await add(); const gate = observeRead(item.path, true);
    const request = { content: 'First request', context: clone(h.contextManager.getContext('sidebar')), settings };
    const first = send(request); await reach(gate, first); fs.writeFileSync(item.path, 'SUCCESSOR_FILE_BYTES');
    const second = send({ ...request, content: 'Successor request' });
    await expect.poll(() => reads.length).toBe(2); gate.release(); await Promise.all([first, second]);
    expect(captures).toHaveLength(1); expect(captures[0].context[0].content).toBe('SUCCESSOR_FILE_BYTES');
    expect(manager.getCurrentConversation()!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Successor request']);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('captures the list before compaction but reads its files after the wait', async () => {
    const item = await add(); let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
    host._panelCompactions.set('sidebar', paused);
    const request = { content: 'After compaction', context: clone(h.contextManager.getContext('sidebar')), settings };
    const pending = send(request); await expect.poll(() => host._mystiRunGen.get('sidebar')).toBe(1);
    request.context[0].path = path.join(root, 'not-submitted.ts'); request.context[0].content = 'MUTATED_PAYLOAD';
    fs.writeFileSync(item.path, 'AFTER_COMPACTION'); host._panelCompactions.delete('sidebar'); release(); await pending;
    expect(captures[0].context[0]).toMatchObject({ path: item.path, content: 'AFTER_COMPACTION' });
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('does not acquire a different panel’s file context', async () => {
    const first = await add(); const otherPath = path.join(root, 'other.ts'); fs.writeFileSync(otherPath, 'OTHER_PANEL_PRIVATE');
    await h.contextManager.addFileToContext(otherPath, 'other-panel'); fs.writeFileSync(first.path, 'FIRST_UPDATED'); await send();
    expect(captures[0].context.map(item => item.content)).toEqual(['FIRST_UPDATED']);
    expect(h.contextManager.getContext('other-panel')[0].content).toBe('OTHER_PANEL_PRIVATE');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps caller-supplied task snapshots that are not live panel attachments', async () => {
    const item = await add(); const snapshot = { ...item, id: 'task-snapshot', content: 'TASK_SNAPSHOT' }; fs.unlinkSync(item.path);
    observeRead(item.path); await host._handleSendMessage({ content: 'Internal task', context: [snapshot], settings }, 'sidebar');
    expect(captures[0].context).toEqual([snapshot]); expect(reads).toEqual([]);
  });
  for (const route of ['session', 'brainstorm', 'assignment', 'coordinator'] as const) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${route} receives refreshed file bytes through the real host route`, async () => {
      const item = await add(); fs.writeFileSync(item.path, 'ROUTE_UPDATED_BYTES');
      const input = { content: 'Inspect the context.', context: clone(h.contextManager.getContext('sidebar')), settings };
      Object.assign(h.providerManager, {
        getProviderDefaultModel: () => '', getProviderStatus: async () => ({ found: true, authenticated: true, path: '/unused' }),
        captureNativeApprovalHandler: () => undefined, setNativeApprovalHandlerForPanel: () => ({ dispose() {} }),
        disposePersistentProcessForProvider() {}, suspendRequest: () => false, resumeRequest: () => false,
        async *sendMessageToProvider(_id: string, content: string, context: ContextItem[], _settings: Settings,
          _conversation: unknown, _persona: unknown, _panel: string, resolveInput?: () => any) {
          const resolved = resolveInput ? resolveInput() : { content, context }; if (!resolved) return;
          captures.push({ context: clone(resolved.context), prompt: resolved.content });
          yield { type: 'text', content: '[]' }; yield { type: 'done' };
        },
      });
      if (route === 'session') await send({ ...input, shape: 'review', brief: input.content, agentIds: ['claude-code', 'openai-codex'] }, 'startSession');
      if (route === 'brainstorm') {
        setMockConfig('brainstorm.agents', ['claude-code', 'openai-codex']); setMockConfig('brainstorm.strategy', 'quick');
        setMockConfig('brainstorm.synthesisAgent', 'claude-code');
        host._brainstormManager = new BrainstormManager(h.extensionContext, h.providerManager);
        host._engagementManager.trackBrainstormCompleted = () => [];
        await send(input, 'sendBrainstormMessage'); host._brainstormManager.clearSession('sidebar');
      }
      if (route === 'assignment') await send({ ...input, content: '@claude Inspect the context.',
        mentions: [{ type: 'agent', value: 'claude-code', displayName: '@claude', startIndex: 0, endIndex: 7 }] });
      if (route === 'coordinator') {
        host._mystiCoordinator = { status: () => ({ ready: true }), resolveCoordinatorModel: async () => 'owned-test',
          supportsToolCalls: async () => false, contextWindowOf: async () => undefined,
          async *stream(messages: any[], options: any) {
            const resolved = options.resolveMessages?.() ?? messages;
            captures.push({ context: [], prompt: resolved.map((message: any) => message.content).join('\n') });
            yield { text: 'Owned reply' }; yield { done: true, model: 'owned-test' };
          } };
        host._mystiMcpToolset = async () => null; host._mystiVisualEnabled = () => ({ look: false, act: false });
        host._mystiSkillsEnabled = () => false; host._buildMystiProjectBrain = async () => '';
        await send({ ...input, settings: { ...settings, provider: 'mysti' } });
      }
      expect(captures.length).toBeGreaterThan(0);
      for (const capture of captures) { expect(capture.prompt + JSON.stringify(capture.context)).toContain('ROUTE_UPDATED_BYTES'); }
      expect(manager.getCurrentConversation()!.messages.find(message => message.role === 'user')!.context![0].content).toBe('ROUTE_UPDATED_BYTES');
    });
  }
});
