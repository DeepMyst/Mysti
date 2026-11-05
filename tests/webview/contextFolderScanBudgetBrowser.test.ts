import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ContextManager } from '../../src/managers/ContextManager';
import { createMockMemento } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
const realBulk = fs.promises.readdir.bind(fs.promises);
const realOpen = fs.promises.opendir.bind(fs.promises);
let browser: Browser, page: Page, root: string, wide: string, sparse: string, deep: string, small: string;
let host: any, context: ContextManager, messages: any[], deliveries: Promise<unknown>[], errors: string[];
type HandleRecord = { path: string; bufferSize?: number; reads: number; entries: number; names: string[]; closeCalls: number; closed: boolean };
let bulk: { path: string; allocated: number }[], handles: HandleRecord[];
let activeHandles: number, maxActiveHandles: number;
let afterOpen: ((record: HandleRecord) => Promise<void>) | undefined;
let afterRead: ((record: HandleRecord) => Promise<void>) | undefined;
let afterClose: ((record: HandleRecord) => Promise<void>) | undefined;
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const notices = async () => (await page.locator('.mysti-toast').allTextContents()).join(' ');
function file(directory: string, name: string) {
  const target = path.join(directory, name); fs.writeFileSync(target, `Owned bytes ${name} — العربية 🧪\n`); return target;
}
function legacyPrefix(directory: string, result: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (result.length === 20) break;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) legacyPrefix(target, result); else if (entry.isFile()) result.push(target);
  }
  return result;
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) throw new Error(CHROMIUM_UNAVAILABLE);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-folder-budget-')));
  wide = path.join(root, 'wide'); sparse = path.join(root, 'sparse'); deep = path.join(root, 'deep'); small = path.join(root, 'small');
  for (const folder of [wide, sparse, deep, small]) fs.mkdirSync(folder);
  for (let i = 10000; i >= 0; i--) file(wide, `file-${String(i).padStart(5, '0')}.txt`);
  for (let i = 0; i < 200; i++) fs.mkdirSync(path.join(sparse, `empty-${String(i).padStart(3, '0')}`));
  let parent = deep;
  for (let i = 0; i < 201; i++) { parent = path.join(parent, 'd'); fs.mkdirSync(parent); }
  file(parent, 'too-deep.txt');
  const child = path.join(small, 'a-child'); fs.mkdirSync(child);
  for (const name of ['z.txt', 'A.txt', '\ue000.txt', '🧪.txt', 'é.txt', 'العربية.txt']) file(child, name);
  for (let i = 0; i < 17; i++) file(small, `z-${i}.txt`);
  browser = await chromium.launch();
}, 60000);
beforeEach(async () => {
  messages = []; deliveries = []; errors = []; bulk = []; handles = []; activeHandles = 0; maxActiveHandles = 0;
  afterOpen = afterRead = afterClose = undefined;
  page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort()); await page.setContent(composeChatHtml());
  await receive('initialState', { ...INITIAL_STATE, panelId: 'owner', conversation: { id: 'original', messages: [] } });
  context = new ContextManager({ workspaceState: createMockMemento() } as any);
  const owner = { id: 'owner', currentConversationId: 'original', navigationRevision: 0, panel: { active: true },
    webview: { postMessage: (message: any) => {
      messages.push(message); const pending = receive(message.type, message.payload); deliveries.push(pending); return pending;
    } } };
  host = Object.assign(Object.create(ChatViewProvider.prototype), { _panelStates: new Map([['owner', owner]]),
    _contextManager: context, _sidebarId: 'owner', _mirrorToHub: () => undefined });
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
    const entries = await (realBulk as any)(...args); bulk.push({ path: String(args[0]), allocated: entries.length }); return entries;
  }) as any);
  vi.spyOn(fs.promises, 'opendir').mockImplementation((async (directory: any, options: any) => {
    const handle = await realOpen(directory, options);
    const record: HandleRecord = { path: String(directory), bufferSize: options?.bufferSize, reads: 0, entries: 0, names: [], closeCalls: 0, closed: false };
    handles.push(record); activeHandles++; maxActiveHandles = Math.max(maxActiveHandles, activeHandles);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation((async () => {
      record.reads++; const entry = await read(); if (entry) { record.entries++; record.names.push(entry.name); }
      await afterRead?.(record); return entry;
    }) as any);
    vi.spyOn(handle, 'close').mockImplementation((async () => {
      record.closeCalls++; await close(); record.closed = true; activeHandles--; await afterClose?.(record);
    }) as any);
    await afterOpen?.(record);
    return handle;
  }) as any);
});
afterEach(async () => {
  await Promise.all(deliveries);
  if (process.env.MYSTI_FOLDER_BUDGET_RECEIPTS) fs.appendFileSync(process.env.MYSTI_FOLDER_BUDGET_RECEIPTS, JSON.stringify({
    test: expect.getState().currentTestName, bulk, handles, maxActiveHandles, activeHandles,
    messages, context: (context as any)._panelContexts.get('owner') ?? [], notices: await notices(),
  }) + '\n');
  vi.restoreAllMocks(); await page?.close(); expect(errors).toEqual([]);
  expect(activeHandles).toBe(0); expect(handles.every(handle => handle.closed && handle.closeCalls === 1)).toBe(true);
});
afterAll(async () => { await browser?.close(); fs.rmSync(root, { recursive: true, force: true }); });
async function add(folder: string) {
  await host._handleMessage({ type: 'addContextUris', panelId: 'owner', payload: [pathToFileURL(folder).href] });
  await Promise.all(deliveries);
}
function assertExactBytes() {
  for (const item of context.getContext('owner')) expect(item.content).toBe(fs.readFileSync(item.path, 'utf8'));
  expect(context.getContext('sibling')).toEqual([]);
}

describe('EW01 actual directory work and visible partial-scan limits', () => {
  it('preserves the legacy depth-first UTF-8 prefix for listings within the scan budget', async () => {
    const expected = legacyPrefix(small); await add(small);
    expect(context.getContext('owner').map(item => item.path)).toEqual(expected); assertExactBytes();
    expect(await notices()).not.toMatch(/200|10,?000/);
  });
  it('does not allocate an entire oversized directory and explains the entry budget', async () => {
    await add(wide); expect(context.getContext('owner')).toHaveLength(20); assertExactBytes();
    expect(bulk).toEqual([]); expect(handles).toHaveLength(1);
    expect(handles[0].entries).toBe(10000); expect(handles[0].bufferSize).toBeLessThanOrEqual(32);
    expect(await notices()).toMatch(/10,?000/); expect(await notices()).toMatch(/more|incomplete|partial/i);
  });
  it('bounds sparse directory opens and does not falsely report an empty complete scan', async () => {
    await add(sparse); expect(context.getContext('owner')).toEqual([]);
    expect(bulk.length + handles.length).toBeLessThanOrEqual(200);
    expect(await notices()).toMatch(/200/); expect(await notices()).toMatch(/more|incomplete|partial/i);
    expect(await notices()).not.toContain('No files to add');
  });
  it('bounds deep traversal and closes each directory before opening its child', async () => {
    await add(deep); expect(context.getContext('owner')).toEqual([]);
    expect(bulk.length + handles.length).toBeLessThanOrEqual(200); expect(maxActiveHandles).toBeLessThanOrEqual(1);
    expect(await notices()).toMatch(/200/);
  });
  it('a revoked operation performs no directory work', async () => {
    expect(await context.addFolderToContext(wide, 'owner', () => false)).toEqual([]);
    expect(bulk).toEqual([]); expect(handles).toEqual([]); expect(messages).toEqual([]);
  });
  for (const phase of ['open', 'read'] as const) {
    for (const action of ['Clear', 'navigation', 'close'] as const) {
      it(`${action} during a pending directory ${phase} closes the late handle without adding or warning`, async () => {
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const pause = async (record: HandleRecord) => { if (record.path === small) { entered(); await held; } };
        if (phase === 'open') afterOpen = pause; else afterRead = pause;
        const pending = add(small);
        try {
          await started;
          if (action === 'Clear') context.clearContext('owner');
          else if (action === 'navigation') host._panelStates.get('owner').navigationRevision++;
          else { host._panelStates.delete('owner'); context.clearPanelContext('owner'); }
        } finally { release(); await pending; }
        expect(handles).toHaveLength(1); expect(handles[0].reads).toBe(phase === 'open' ? 0 : 1);
        expect((context as any)._panelContexts.get('owner') ?? []).toEqual([]);
        if (action === 'close') expect((context as any)._panelContexts.has('owner')).toBe(false);
        expect(messages).toEqual([]); expect(await notices()).toBe('');
      });
    }
  }
  it('retains observed entries after an iteration error and closes the failed directory', async () => {
    afterRead = async record => {
      if (record.path === small && record.entries === 2) throw Object.assign(new Error('controlled iteration failure'), { code: 'EIO' });
    };
    await add(small);
    const first = path.join(small, handles[0].names[0]);
    const expected = fs.statSync(first).isDirectory() ? legacyPrefix(first) : [first];
    expect(context.getContext('owner').map(item => item.path)).toEqual(expected); assertExactBytes();
    expect(await notices()).toContain('Could not read folder "small"');
  });
  it('reports a close error without discarding already-read valid entries or retrying closure', async () => {
    afterClose = async record => {
      if (record.path === small) throw Object.assign(new Error('controlled close result failure'), { code: 'EIO' });
    };
    await add(small); expect(context.getContext('owner').map(item => item.path)).toEqual(legacyPrefix(small));
    assertExactBytes(); expect(await notices()).toContain('Could not read folder "small"');
  });
  it('finishing exactly 200 directories does not claim a further directory was skipped', async () => {
    const last = path.join(sparse, 'empty-199'); fs.rmdirSync(last);
    try {
      await add(sparse); expect(handles).toHaveLength(200); expect(await notices()).not.toMatch(/200|more files/i);
      expect(await notices()).toContain('No files to add');
    } finally { fs.mkdirSync(last); }
  });
});
