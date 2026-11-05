import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as contextFileReader from '../../src/services/ContextFileReader';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ContextManager } from '../../src/managers/ContextManager';
import { createMockMemento } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
type Route = 'URI drop' | 'Explorer action' | 'legacy paths';
const routes: Route[] = ['URI drop', 'Explorer action', 'legacy paths'];
const realRead = contextFileReader.readContextFileText.bind(contextFileReader);
const realDirectory = fs.promises.opendir.bind(fs.promises);
let browser: Browser, page: Page, root: string, folder: string, host: any, context: ContextManager;
let errors: string[], messages: any[], deliveries: Promise<unknown>[], reads: string[], walks: string[];
let deniedFiles: Set<string>, deniedFolders: Set<string>;
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const warnings = () => page.locator('.mysti-toast').allTextContents();
const addedPaths = () => context.getContext('owner').map(item => item.path);
function failure() { return Object.assign(new Error('Controlled unreadable fixture'), { code: 'EACCES' }); }
function createFiles(count: number, directory = folder) {
  const files = Array.from({ length: count }, (_, i) => path.join(directory, `file-${String(i).padStart(2, '0')}.txt`));
  for (const file of files) fs.writeFileSync(file, `Owned bytes ${path.basename(file)} — العربية 🧪\n`);
  return files;
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) { return; }
  browser = await chromium.launch();
});
beforeEach(async () => {
  errors = []; messages = []; deliveries = []; reads = []; walks = []; deniedFiles = new Set(); deniedFolders = new Set();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-folder-feedback-')));
  folder = path.join(root, 'folder # العربية'); fs.mkdirSync(folder);
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
  vi.spyOn(contextFileReader, 'readContextFileText').mockImplementation((async (file: any, ...args: any[]) => {
    reads.push(String(file)); if (deniedFiles.has(String(file))) throw failure();
    return (realRead as any)(file, ...args);
  }) as any);
  vi.spyOn(fs.promises, 'opendir').mockImplementation((async (directory: any, ...args: any[]) => {
    walks.push(String(directory)); if (deniedFolders.has(String(directory))) throw failure();
    return (realDirectory as any)(directory, ...args);
  }) as any);
});
afterEach(async () => {
  await Promise.all(deliveries);
  if (page && process.env.MYSTI_CONTEXT_FOLDER_RECEIPTS) {
    fs.appendFileSync(process.env.MYSTI_CONTEXT_FOLDER_RECEIPTS, JSON.stringify({ test: expect.getState().currentTestName,
      reads, walks, deniedFiles: [...deniedFiles], deniedFolders: [...deniedFolders], messages,
      context: context.getContext('owner'), dom: { warnings: await warnings(), contextText: await page.locator('#context-panel').textContent() } }) + '\n');
  }
  vi.restoreAllMocks(); await page?.close(); fs.rmSync(root, { recursive: true, force: true }); expect(errors).toEqual([]);
});
afterAll(async () => { await browser?.close(); });

async function add(route: Route) {
  if (route === 'Explorer action') await host.addToContext(vscode.Uri.file(folder));
  else if (route === 'legacy paths') await host._handleMessage({ type: 'addContextPaths', panelId: 'owner', payload: [folder] });
  else {
    const uri = pathToFileURL(folder).href;
    const posted = await page.evaluate(uri => {
      const transfer = new DataTransfer(); transfer.setData('text/uri-list', uri);
      document.getElementById('context-panel')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      return (window as any).__posted.filter((message: any) => message.type === 'addContextUris').at(-1);
    }, uri);
    expect(posted).toBeDefined(); await host._handleMessage(posted);
  }
  await Promise.all(deliveries);
}
function assertFiles(expected: string[]) {
  expect(addedPaths()).toEqual(expected);
  for (const item of context.getContext('owner')) expect(item.content).toBe(fs.readFileSync(item.path, 'utf8'));
  expect(context.getContext('sibling')).toEqual([]);
}

describe('EW01 folder feedback through actual host routes and browser warning rendering', () => {
  for (const route of routes) {
    for (const count of [19, 20, 21]) {
      it.skipIf(CHROMIUM_UNAVAILABLE)(`${route}: ${count} files preserve the prefix cap and explain when it is reached`, async () => {
        const files = createFiles(count); await add(route); assertFiles(files.slice(0, 20));
        expect(reads).toEqual(files.slice(0, 20)); expect(walks).toEqual([folder]);
        const notices = await warnings();
        if (count < 20) expect(notices).toEqual([]);
        else {
          expect(notices.join(' ')).toMatch(/limit.*20|20.*limit/i);
          // At exactly 20, the bounded walk has no evidence of an omitted 21st file.
          if (count === 20) expect(notices.join(' ')).not.toMatch(/files? (?:were )?(?:omitted|excluded)|truncated/i);
        }
      });
    }
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${route}: an unreadable subfolder does not hide readable sibling files`, async () => {
      const denied = path.join(folder, 'a-denied-<img src=x onerror=alert(1)>'); fs.mkdirSync(denied); createFiles(1, denied);
      const later = path.join(folder, 'b-readable'); fs.mkdirSync(later); const files = createFiles(2, later);
      expect(fs.readdirSync(folder)).toEqual([path.basename(denied), path.basename(later)]);
      deniedFolders.add(denied); await add(route); assertFiles(files);
      expect((await warnings()).join(' ')).toContain(path.basename(denied));
      expect(await page.locator('.mysti-toast img').count()).toBe(0);
      expect(walks).toEqual([folder, denied, later]);
    });
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${route}: a partial file read failure is visible while valid files stay available`, async () => {
      const files = createFiles(3); deniedFiles.add(files[1]); await add(route); assertFiles([files[0], files[2]]);
      expect((await warnings()).join(' ')).toContain(path.basename(files[1]));
    });
  }
  for (const route of ['URI drop', 'Explorer action'] as const) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${route}: an empty folder explains why no context appeared`, async () => {
      await add(route); assertFiles([]); expect((await warnings()).join(' ')).toMatch(/no .*files|empty/i);
    });
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${route}: root enumeration failure is visible and leaves existing context intact`, async () => {
      const [existing] = createFiles(1, root); await context.addFileToContext(existing, 'owner'); deniedFolders.add(folder);
      await add(route); assertFiles([existing]); expect((await warnings()).join(' ')).toContain(path.basename(folder));
    });
    it.skipIf(CHROMIUM_UNAVAILABLE)(`${route}: a delayed folder error after navigation cannot warn or update the replacement chat`, async () => {
      createFiles(1);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      vi.mocked(fs.promises.opendir).mockImplementation((async (directory: any, ...args: any[]) => {
        walks.push(String(directory));
        if (String(directory) === folder) { entered(); await held; throw failure(); }
        return (realDirectory as any)(directory, ...args);
      }) as any);
      const pending = add(route);
      try {
        await started; host._panelStates.get('owner').currentConversationId = 'replacement'; context.clearContext('owner');
        await receive('conversationChanged', { id: 'replacement', messages: [] });
      } finally { release(); await pending; }
      assertFiles([]); expect(messages).toEqual([]); expect(await warnings()).toEqual([]);
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('a repeated folder does not describe already-present files as unreadable', async () => {
    const files = createFiles(2); await add('URI drop'); await add('URI drop'); assertFiles(files);
    expect(await warnings()).toEqual([]); expect(reads).toEqual(files);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('a failed candidate still counts toward the bounded prefix and is not reported as added', async () => {
    const files = createFiles(21); deniedFiles.add(files[0]); await add('URI drop'); assertFiles(files.slice(1, 20));
    expect(reads).toEqual(files.slice(0, 20));
    const notices = (await warnings()).join(' ');
    expect(notices).toMatch(/limit.*20|20.*limit/i); expect(notices).toContain(path.basename(files[0]));
    expect(notices).not.toMatch(/added 20/i);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('all unreadable candidates identify the failed files', async () => {
    const files = createFiles(2); files.forEach(file => deniedFiles.add(file)); await add('URI drop'); assertFiles([]);
    for (const file of files) expect((await warnings()).join(' ')).toContain(path.basename(file));
  });
});
