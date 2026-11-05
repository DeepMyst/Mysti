import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as contextFileReader from '../../src/services/ContextFileReader';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ContextManager } from '../../src/managers/ContextManager';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { createMockMemento } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const content = 'Owned context bytes — العربية 🧪\n';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
let browser: Browser, page: Page, root: string, file: string, host: any, context: ContextManager;
let errors: string[], hostMessages: any[], probes: string[], posted: any[], deliveries: Promise<unknown>[];
let bridgeCursor: number;
const realStat = fs.promises.stat.bind(fs.promises);
const realRead = contextFileReader.readContextFileText.bind(contextFileReader);
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const sends = () => page.evaluate(() => (window as any).__posted.filter((event: any) => event.type === 'sendMessage'));
const warnings = () => page.locator('.mysti-toast').allTextContents();
const contextFiles = () => context.getContext('owner').map(item => item.path);

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  browser = await chromium.launch();
});
beforeEach(async () => {
  errors = []; hostMessages = []; probes = []; deliveries = []; posted = []; bridgeCursor = 0;
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-context-drop-')));
  // Win32 forbids '?' in a real filename. Retain URI-sensitive #, %, spaces,
  // Unicode and a literal '+' there; malformed query suffixes are tested below.
  const name = process.platform === 'win32' ? 'report # % + العربية.txt' : 'report # % ? العربية.txt';
  file = path.join(root, name); fs.writeFileSync(file, content);
  page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(composeChatHtml());
  await receive('initialState', { ...INITIAL_STATE, panelId: 'owner', conversation: { id: 'original', messages: [] },
    providers: registry.getAll().map(provider => provider.config), providerManifest: buildProviderManifestPayload(registry) });
  context = new ContextManager({ workspaceState: createMockMemento() } as any);
  const owner = { currentConversationId: 'original', navigationRevision: 0, webview: { postMessage: (message: any) => {
    hostMessages.push(message); const pending = receive(message.type, message.payload); deliveries.push(pending); return pending;
  } } };
  host = Object.assign(Object.create(ChatViewProvider.prototype), { _panelStates: new Map([['owner', owner]]),
    _contextManager: context, _sidebarId: 'owner', _mirrorToHub: () => undefined });
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (...args: any[]) => {
    probes.push(String(args[0])); return (realStat as any)(...args);
  }) as any);
});
afterEach(async () => {
  await Promise.all(deliveries);
  if (page && process.env.MYSTI_CONTEXT_DROP_RECEIPTS) {
    const dom = await page.evaluate(() => ({ url: location.href, overlay: document.getElementById('drop-overlay')?.className,
      previews: Array.from(document.querySelectorAll('.attachment-name')).map(node => node.textContent),
      toasts: Array.from(document.querySelectorAll('.mysti-toast')).map(node => node.textContent),
      sends: (window as any).__posted.filter((event: any) => event.type === 'sendMessage') }));
    fs.appendFileSync(process.env.MYSTI_CONTEXT_DROP_RECEIPTS, JSON.stringify({ test: expect.getState().currentTestName,
      posted, probes, hostMessages, context: context.getContext('owner'), dom }) + '\n');
  }
  vi.restoreAllMocks(); await page?.close(); fs.rmSync(root, { recursive: true, force: true }); expect(errors).toEqual([]);
});
afterAll(async () => { await browser?.close(); registry.dispose(); });

async function bridge() {
  const messages = await page.evaluate(() => (window as any).__posted);
  const batch = messages.slice(bridgeCursor); bridgeCursor = messages.length;
  for (const message of batch.filter((message: any) => ['addContextPaths', 'addContextUris'].includes(message.type))) {
    posted.push(message); await host._handleMessage(message);
  }
  await Promise.all(deliveries);
}
async function drop(target: 'context' | 'composer', data: Record<string, string>, includeFile = false) {
  const cancelled = await page.evaluate(({ target, data, includeFile, content, name }) => {
    const transfer = new DataTransfer();
    for (const [mime, value] of Object.entries(data)) transfer.setData(mime, value);
    if (includeFile) transfer.items.add(new File([content], name, { type: 'text/plain' }));
    const element = document.getElementById(target === 'context' ? 'context-panel' : 'message-input')!;
    element.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    element.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  }, { target, data, includeFile, content, name: path.basename(file) });
  expect(cancelled).toBe(true); expect(page.url()).toBe('about:blank');
}
async function assertContextFile(expected = file) {
  expect(contextFiles()).toEqual([expected]); expect(hash(context.getContext('owner')[0].content!)).toBe(hash(content));
  expect(context.getContext('sibling')).toEqual([]);
  expect(await page.locator('.attachment-preview-item').count()).toBe(0);
}

describe('EW06 actual browser drop targets into the host context reader', () => {
  for (const mime of ['text/uri-list', 'application/vnd.code.uri-list']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${mime}: preserves encoded filename bytes and deduplicates comments/repeated links`, async () => {
      const uri = pathToFileURL(file).href;
      await drop('context', { [mime]: '# comment\r\n' + uri + '\r\n' + uri + '\r\n' }); await bridge();
      await assertContextFile(); expect(await warnings()).toEqual([]);
    });
  }
  for (const prefix of ['file://localhost', 'FILE://LOCALHOST']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`resolves the native path from ${prefix} without inventing a relative path`, async () => {
      const uri = prefix + new URL(pathToFileURL(file)).pathname;
      await drop('context', { 'text/uri-list': uri }); await bridge(); await assertContextFile();
      expect(probes.every(probe => path.isAbsolute(probe))).toBe(true);
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('decodes percent escapes once, retaining a literal percent-encoded filename', async () => {
    const literal = path.join(root, '%2F.txt'); fs.writeFileSync(literal, content);
    await drop('context', { 'text/uri-list': pathToFileURL(literal).href }); await bridge(); await assertContextFile(literal);
  });
  for (const fault of ['relative', 'encoded separator', 'query', 'fragment', 'empty query', 'empty fragment',
    'backslash', 'raw tab', 'NUL', 'bad escape', 'non-file', ...(process.platform === 'win32' ? [] : ['remote authority'])]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`rejects ${fault} URI data before filesystem access and gives feedback`, async () => {
      const valid = pathToFileURL(file).href;
      const uri = fault === 'relative' ? 'file:report.txt'
        : fault === 'encoded separator' ? pathToFileURL(root).href + '/dir%2Ffile.txt'
        : fault === 'query' ? valid + '?download=1'
        : fault === 'fragment' ? valid + '#part'
        : fault === 'empty query' ? valid + '?'
        : fault === 'empty fragment' ? valid + '#'
        : fault === 'backslash' ? valid.replace('/report', '\\report')
        : fault === 'raw tab' ? valid.replace('/report', '/re\tport')
        : fault === 'NUL' ? valid + '%00'
        : fault === 'bad escape' ? valid + '%XX'
        : fault === 'non-file' ? 'https://example.invalid/file.txt'
        : 'file://remote.example' + new URL(valid).pathname;
      await drop('context', { 'text/uri-list': uri }); await bridge();
      expect(contextFiles()).toEqual([]); expect(probes).toEqual([]); expect((await warnings()).length).toBeGreaterThan(0);
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps a valid file from the secondary URI format when the standard format contains an unsupported URL', async () => {
    await drop('context', { 'text/uri-list': 'https://example.invalid/no-file', 'application/vnd.code.uri-list': pathToFileURL(file).href });
    await bridge(); await assertContextFile(); expect((await warnings()).length).toBeGreaterThan(0);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('retains valid files in a mixed URI batch and reports the unreadable item', async () => {
    await drop('context', { 'text/uri-list': [pathToFileURL(path.join(root, 'missing.txt')).href, pathToFileURL(file).href].join('\r\n') });
    await bridge(); await assertContextFile(); expect((await warnings()).join(' ')).toContain('missing.txt');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('deduplicates equivalent URI forms and later drops without false unreadable warnings', async () => {
    const uri = pathToFileURL(file).href;
    const alias = 'file://localhost' + new URL(uri).pathname;
    await drop('context', { 'text/uri-list': uri, 'application/vnd.code.uri-list': alias }); await bridge();
    await drop('context', { 'text/uri-list': alias }); await bridge();
    await assertContextFile(); expect(probes).toEqual([file]); expect(await warnings()).toEqual([]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('expands a folder URI through the real context reader', async () => {
    await drop('context', { 'text/uri-list': pathToFileURL(root).href }); await bridge();
    await assertContextFile(); expect(await warnings()).toEqual([]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('explains empty context drops rather than silently ignoring them', async () => {
    await drop('context', { 'text/uri-list': '# just a comment\r\n' }); await bridge();
    expect(contextFiles()).toEqual([]); expect(probes).toEqual([]);
    expect((await warnings()).join(' ')).toContain('+ Add');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('clears the document overlay after a context-target drop and resets nested drag accounting', async () => {
    await page.evaluate(() => document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true })));
    await drop('context', { 'text/uri-list': pathToFileURL(file).href }); await bridge();
    expect(await page.locator('#drop-overlay').evaluate(node => node.classList.contains('visible'))).toBe(false);
    await page.evaluate(() => {
      document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
      document.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
    });
    expect(await page.locator('#drop-overlay').evaluate(node => node.classList.contains('visible'))).toBe(false);
  });
  for (const target of ['composer', 'context'] as const) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${target}: the same file keeps its intended lifetime across two sends`, async () => {
      await drop(target, { 'text/uri-list': pathToFileURL(file).href }, true); await bridge();
      await page.waitForFunction(() => !document.querySelector('.attachment-reading'));
      for (const text of ['First question', 'Follow-up']) {
        await page.locator('#message-input').fill(text); await page.locator('#send-btn').click();
        await receive('responseComplete', { message: { id: text, role: 'assistant', content: 'Controlled completion.' } });
      }
      const requests = await sends(); expect(requests).toHaveLength(2);
      if (target === 'context') {
        await assertContextFile();
        for (const request of requests) {
          expect(request.payload.attachments).toBeUndefined();
          expect(request.payload.context[0]).toMatchObject({ path: file, content });
        }
      } else {
        expect(contextFiles()).toEqual([]);
        expect(hash(Buffer.from(requests[0].payload.attachments[0].base64Data, 'base64'))).toBe(hash(content));
        expect(requests[1].payload.attachments).toBeUndefined();
      }
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('explains the attachment fallback when a context drop has file bytes but no disk path', async () => {
    await drop('context', {}, true); await bridge();
    await page.waitForFunction(() => !document.querySelector('.attachment-reading'));
    expect(contextFiles()).toEqual([]); expect(await page.locator('.attachment-name').textContent()).toBe(path.basename(file));
    expect((await warnings()).join(' ')).toMatch(/message attachments/i);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('explains how to attach a URI-only composer drop without silently adding persistent context', async () => {
    await drop('composer', { 'text/uri-list': pathToFileURL(file).href }); await bridge();
    expect(contextFiles()).toEqual([]); expect(await page.locator('.attachment-preview-item').count()).toBe(0);
    expect((await warnings()).join(' ')).toMatch(/Context.*Attach/);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps a delayed context read out of a replacement conversation', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation((async (target: any, ...args: any[]) => {
      if (String(target) === file) { entered(); await held; }
      return (realRead as any)(target, ...args);
    }) as any);
    await drop('context', { 'text/uri-list': pathToFileURL(file).href });
    const pending = bridge();
    try {
      await started; host._panelStates.get('owner').currentConversationId = 'replacement'; context.clearContext('owner');
      await receive('conversationChanged', { id: 'replacement', messages: [] });
    } finally { release(); await pending; }
    expect(contextFiles()).toEqual([]); expect(hostMessages).toEqual([]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('suppresses malformed-link and read-failure warnings after navigation during a mixed batch', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation((async (target: any, ...args: any[]) => {
      if (String(target) === file) { entered(); await held; throw new Error('controlled read failure'); }
      return (realRead as any)(target, ...args);
    }) as any);
    await drop('context', { 'text/uri-list': 'https://example.invalid/no-file\r\n' + pathToFileURL(file).href });
    const pending = bridge();
    try {
      await started; host._panelStates.get('owner').navigationRevision++;
      await receive('conversationChanged', { id: 'replacement', messages: [] });
    } finally { release(); await pending; }
    expect(contextFiles()).toEqual([]); expect(hostMessages).toEqual([]); expect(await warnings()).toEqual([]);
  });
});
