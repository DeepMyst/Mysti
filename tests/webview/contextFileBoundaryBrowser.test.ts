import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ContextManager } from '../../src/managers/ContextManager';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { createMockMemento } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
const LIMIT = 10 * 1024 * 1024;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const realBulkRead = fs.promises.readFile.bind(fs.promises), realOpen = fs.promises.open.bind(fs.promises);
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const manifest = buildProviderManifestPayload(registry), provider = manifest.providers.find(entry => entry.id === 'openai-codex')!;
let browser: Browser, page: Page, root: string, context: ContextManager, host: any, store: ReturnType<typeof createMockMemento>;
let messages: any[], deliveries: Promise<unknown>[], errors: string[], bulk: any[], handles: any[], restoration: Promise<unknown> | undefined;
let growPath: string | undefined;
let afterOpen: (() => Promise<void>) | undefined, afterRead: (() => Promise<void>) | undefined, afterClose: (() => Promise<void>) | undefined;
const receive = (type: string, payload?: unknown) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const notices = async () => (await page.locator('.mysti-toast').allTextContents()).join(' ');
function owned(name: string, bytes: Buffer | string) { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; }
function summary(items: any[]) { return items.map(({ content, ...item }) => ({ ...item, bytes: typeof content === 'string' ? Buffer.byteLength(content) : null, sha256: typeof content === 'string' ? hash(content) : null })); }
function grow(file: string) { if (file === growPath) { fs.appendFileSync(file, Buffer.alloc(LIMIT + 1, 0x61)); growPath = undefined; } }

beforeAll(async () => { if (CHROMIUM_UNAVAILABLE) throw new Error(CHROMIUM_UNAVAILABLE); browser = await chromium.launch(); });
beforeEach(async () => {
  messages = []; deliveries = []; errors = []; bulk = []; handles = []; restoration = undefined; growPath = undefined;
  afterOpen = afterRead = afterClose = undefined;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-context-bytes-')));
  page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.route('**/*', route => route.abort());
  await page.setContent(composeChatHtml()); await receive('initialState', { ...INITIAL_STATE, panelId: 'sidebar', conversation: { id: 'original', messages: [] } });
  store = createMockMemento(); context = new ContextManager({ workspaceState: store } as any);
  const restore = context.restorePanelContext.bind(context);
  vi.spyOn(context, 'restorePanelContext').mockImplementation((...args: any[]) => { restoration = (restore as any)(...args); return restoration as any; });
  const conversation = { id: 'original', messages: [], title: 'Owned context boundary' };
  const owner = { id: 'sidebar', currentConversationId: 'original', navigationRevision: 0, panel: { active: true },
    webview: { postMessage: (message: any) => { messages.push(message); const pending = receive(message.type, message.payload); deliveries.push(pending); return pending; } } };
  host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: new Map([['sidebar', owner]]), _sidebarId: 'sidebar', _contextManager: context, _mirrorToHub: vi.fn(),
    _extensionContext: { extension: { packageJSON: { version: '0.0.0' } }, globalState: { get: (_key: string, fallback: any) => fallback, update: async () => {} } },
    _agentInitPromise: Promise.resolve(), _getPanelProvider: () => provider.id, _getPanelAgent: () => provider.id,
    _getPanelModel: () => provider.defaultModel, _tryPreSpawnPersistentProcess: vi.fn(),
    _setupManager: { ensureProviderStatusFresh: async () => {}, getWizardStatusCached: () => ({ anyReady: true, providers: [{ providerId: provider.id, installed: true, authenticated: true }] }) },
    _conversationManager: { getCurrentConversation: () => conversation, getConversation: () => conversation },
    _providerManager: { getProviders: () => [{ ...provider, name: provider.id }], cancelRequest: vi.fn() },
    _modelRegistry: { getModels: () => ({ models: provider.models, defaultModel: provider.defaultModel }) },
    _mapAgentLists: () => ({ availablePersonas: [], availableSkills: [], availableRoles: [] }),
    _buildManifestPayload: () => manifest, _agentContextManager: { getTokenBudget: () => 2000 },
    _engagementManager: { getUsageStats: () => ({}), getAllBadges: () => [], getUnlockedCount: () => 0 },
    _activeModeManager: { isInstalled: () => false, getDaemonStatus: () => 'stopped' },
    _checkpointManager: { isAvailable: async () => false }, _getCachedGithubStarCount: () => 0,
    _getGithubStarCount: async () => 0, _pushInAppMessages: async () => {},
  });
  vi.spyOn(fs.promises, 'readFile').mockImplementation((async (target: any, ...args: any[]) => {
    if (String(target).startsWith(root + path.sep)) grow(String(target));
    const value = await (realBulkRead as any)(target, ...args);
    if (String(target).startsWith(root + path.sep)) bulk.push({ path: String(target), bytes: Buffer.byteLength(value), sha256: hash(value) });
    return value;
  }) as any);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (target: any, ...args: any[]) => {
    const handle = await (realOpen as any)(target, ...args);
    if (!String(target).startsWith(root + path.sep)) return handle;
    const record = { path: String(target), reads: [] as any[], closes: 0, closed: false }; handles.push(record);
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle);
    vi.spyOn(handle, 'stat').mockImplementation(async () => { const value = await stat(); grow(String(target)); return value; });
    vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
      const value = await read(...readArgs); record.reads.push({ requested: readArgs[2], bytes: value.bytesRead }); await afterRead?.(); return value;
    });
    vi.spyOn(handle, 'close').mockImplementation(async () => { record.closes++; await close(); record.closed = true; await afterClose?.(); });
    await afterOpen?.();
    return handle;
  }) as any);
});
afterEach(async () => {
  await restoration?.catch(() => undefined); await Promise.all(deliveries);
  if (process.env.MYSTI_CONTEXT_FILE_RECEIPTS) fs.appendFileSync(process.env.MYSTI_CONTEXT_FILE_RECEIPTS, JSON.stringify({
    test: expect.getState().currentTestName, bulk, handles, context: summary(context.getContext('sidebar')), notices: await notices(),
    messages: messages.map(message => ({ type: message.type, payload: message.type === 'contextUpdated' ? summary(message.payload) : message.type === 'contextWarning' ? message.payload : undefined })),
  }) + '\n');
  vi.restoreAllMocks(); await page?.close(); fs.rmSync(root, { recursive: true, force: true }); expect(errors).toEqual([]);
  expect(handles.every(record => record.closed && record.closes === 1)).toBe(true);
  for (const record of handles) {
    expect(record.reads.every((read: any) => read.requested > 0 && read.requested <= 64 * 1024)).toBe(true);
    expect(record.reads.reduce((sum: number, read: any) => sum + read.bytes, 0)).toBeLessThanOrEqual(LIMIT + 1);
  }
});
afterAll(async () => { await browser?.close(); registry.dispose(); });
async function add(files: string[]) {
  await host._handleMessage({ type: 'addContextUris', panelId: 'sidebar', payload: files.map(file => pathToFileURL(file).href) }); await Promise.all(deliveries);
}
async function restore(files: string[]) {
  store._store.set('mysti.context:sidebar', files.map((file, i) => ({ id: 'saved-' + i, type: 'file', path: file, enabled: true })));
  await host._sendInitialState('sidebar'); expect(restoration).toBeDefined(); await restoration; await Promise.all(deliveries);
}
function assertContents(file: string, bytes: Buffer) {
  const items = context.getContext('sidebar'); expect(items).toHaveLength(1); expect(items[0].path).toBe(file); expect(hash(items[0].content!)).toBe(hash(bytes));
  expect(context.getContext('sibling')).toEqual([]);
}

const fixtures = [
  { name: 'empty', bytes: () => Buffer.alloc(0), accepted: true },
  { name: 'Unicode BOM and literal replacement character', bytes: () => Buffer.from('\ufeffالعربية 🧪\nValid literal �\r\n'), accepted: true },
  { name: 'exact 10 MiB', bytes: () => Buffer.concat([Buffer.alloc(LIMIT - 4, 0x61), Buffer.from('🧪')]), accepted: true },
  { name: 'over 10 MiB', bytes: () => Buffer.alloc(LIMIT + 1, 0x61), accepted: false, reason: /10.*MiB/i },
  { name: 'invalid UTF-8', bytes: () => Buffer.from([0xc3, 0x28]), accepted: false, reason: /UTF-8/i },
  { name: 'binary NUL', bytes: () => Buffer.from('a\0b'), accepted: false, reason: /UTF-8|binary/i },
  { name: 'UTF-16 BOM', bytes: () => Buffer.from([0xff, 0xfe, 0x61, 0]), accepted: false, reason: /UTF-8/i },
];
describe('EW01/EW02 bounded text files through actual add and startup restoration', () => {
  for (const route of ['add', 'restore'] as const) {
    for (const fixture of fixtures) {
      it(`${route}: ${fixture.name} has explicit, byte-preserving disposition`, async () => {
        const bytes = fixture.bytes(), file = owned('input.txt', bytes);
        if (route === 'add') await add([file]); else await restore([file]);
        if (fixture.accepted) { assertContents(file, bytes); expect(await notices()).toBe(''); }
        else { expect(context.getContext('sidebar')).toEqual([]); expect(await notices()).toContain('input.txt'); expect(await notices()).toMatch(fixture.reason!); }
      });
    }
  }
  for (const fixture of fixtures.filter(fixture => !fixture.accepted)) {
    it(`refresh: ${fixture.name} cannot replace valid cached text`, async () => {
      const file = owned('changing.txt', 'original valid text'); await context.addFileToContext(file, 'sidebar');
      fs.writeFileSync(file, fixture.bytes()); await context.refreshContext('sidebar');
      expect(context.getContext('sidebar')).toEqual([]);
    });
  }
  it('a mixed folder retains valid and empty files while naming encoding and size failures', async () => {
    const valid = owned('a-valid.txt', 'Owned العربية 🧪'), empty = owned('b-empty.txt', '');
    owned('c-binary.bin', Buffer.from('binary\0bytes')); owned('d-large.txt', Buffer.alloc(LIMIT + 1, 0x61));
    await add([root]); expect(context.getContext('sidebar').map(item => item.path)).toEqual([valid, empty]);
    expect(await notices()).toMatch(/c-binary.*UTF-8|c-binary.*binary/i); expect(await notices()).toMatch(/d-large.*10.*MiB/i);
  });
  it('a file growing after metadata capture is rejected without reading beyond the overflow byte', async () => {
    const file = owned('growing.txt', ''); growPath = file; await add([file]);
    expect(context.getContext('sidebar')).toEqual([]); expect(await notices()).toMatch(/10.*MiB/i);
    expect(bulk).toEqual([]); expect(handles).toHaveLength(1);
    expect(handles[0].reads.reduce((sum: number, read: any) => sum + read.bytes, 0)).toBe(LIMIT + 1);
  });
  for (const phase of ['open', 'read', 'close'] as const) {
    it(`stale ${phase} completion cannot commit bytes or send a rejection to the next chat`, async () => {
      const file = owned('late.txt', phase === 'close' ? Buffer.alloc(LIMIT + 1, 0x61) : Buffer.from([0xc3, 0x28]));
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const pause = async () => { entered(); await held; };
      if (phase === 'open') afterOpen = pause; else if (phase === 'read') afterRead = pause; else afterClose = pause;
      const pending = phase === 'close' ? restore([file]) : add([file]);
      try {
        await started; context.clearContext('sidebar'); host._panelStates.get('sidebar').currentConversationId = 'replacement';
      } finally { release(); await pending; }
      expect(context.getContext('sidebar')).toEqual([]); expect(await notices()).toBe('');
      expect(messages.filter(message => ['contextUpdated', 'contextWarning'].includes(message.type))).toEqual([]);
      expect(handles).toHaveLength(1);
    });
  }
  it('Clear during an actual refresh read does not repopulate or report the cleared context', async () => {
    const file = owned('refresh.txt', 'valid text'); await context.addFileToContext(file, 'sidebar'); fs.writeFileSync(file, Buffer.from('binary\0bytes'));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    afterRead = async () => { entered(); await held; };
    const failures = vi.fn(); const pending = context.refreshContext('sidebar', failures);
    try { await started; context.clearContext('sidebar'); } finally { release(); await pending; }
    expect(context.getContext('sidebar')).toEqual([]); expect(store._store.get('mysti.context:sidebar')).toEqual([]);
    expect(failures).not.toHaveBeenCalled();
  });
  it('restoration keeps valid files and disabled selection snapshots alongside rejected files', async () => {
    const valid = owned('valid.txt', 'Current valid bytes 🧪'), bad = owned('invalid.bin', Buffer.from('binary\0bytes'));
    const selection = { id: 'selection', type: 'selection', path: valid, content: 'Saved selection العربية', enabled: false, startLine: 1, endLine: 1 };
    store._store.set('mysti.context:sidebar', [{ id: 'valid', type: 'file', path: valid, enabled: true }, selection, { id: 'invalid', type: 'file', path: bad, enabled: true }]);
    await host._sendInitialState('sidebar'); await restoration; await Promise.all(deliveries);
    expect(context.getContext('sidebar')).toEqual([expect.objectContaining({ path: valid, content: 'Current valid bytes 🧪' }), selection]);
    expect((store._store.get('mysti.context:sidebar') as any[]).map(item => item.id)).toEqual(['valid', 'selection']);
    expect(await notices()).toMatch(/invalid.bin.*UTF-8/);
  });
  it('malformed persisted file paths do not break restoration feedback or valid siblings', async () => {
    const valid = owned('valid.txt', 'Owned valid bytes');
    store._store.set('mysti.context:sidebar', [
      { id: 'bad', type: 'file', path: null, enabled: true }, { id: 'valid', type: 'file', path: valid, enabled: true },
    ]);
    await host._sendInitialState('sidebar'); await restoration; await Promise.all(deliveries);
    assertContents(valid, Buffer.from('Owned valid bytes')); expect(await notices()).toMatch(/could not read/i);
    expect((store._store.get('mysti.context:sidebar') as any[]).map(item => item.id)).toEqual(['valid']);
  });
});
