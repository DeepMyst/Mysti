import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { BaseCliProvider } from '../../src/providers/base/BaseCliProvider';

vi.mock('vscode', async () => {
  const base = await vi.importActual<any>('../helpers/mockVscode');
  return { ...base, window: { ...base.window, showOpenDialog: vi.fn() } };
});
vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

const LIMIT = 10 * 1024 * 1024; // Independent oracle for the advertised picker limit.
const realStat = fs.promises.stat.bind(fs.promises);
const realReadFile = fs.promises.readFile.bind(fs.promises);
const realOpen = fs.promises.open.bind(fs.promises);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let root: string, host: any, posted: any[], events: any[];
let afterStat: (file: string) => void;
interface HandleReceipt { path: string; reads: Array<{ requested: number; bytes: number; sha256: string }>; closes: number; closed: boolean }
let handles: HandleReceipt[];
let afterOpen: (file: string) => void, beforeRead: (file: string, index: number) => void;
let afterRead: (file: string) => void, afterClose: (file: string) => void;

function bytes(size: number, fill = 0x61) {
  const value = Buffer.alloc(size, fill);
  if (size) value[size - 1] = 0; // Binary attachments must retain NUL bytes.
  return value;
}
function ownedFile(name: string, content: Buffer) {
  const file = path.join(root, name); fs.writeFileSync(file, content); return file;
}
async function pick(files: string[]) {
  vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(files.map(vscode.Uri.file));
  await host._handleRequestFileAttachment('owner');
}
function selected() {
  return posted.filter(message => message.type === 'fileAttachmentSelected')
    .flatMap(message => message.payload.attachments);
}
function assertSelected(file: string, content: Buffer) {
  expect(selected()).toHaveLength(1);
  const attachment = selected()[0];
  expect(attachment.fileName).toBe(path.basename(file));
  expect(attachment.filePath).toBe(file);
  expect(attachment.size).toBe(content.length);
  expect(hash(Buffer.from(attachment.base64Data, 'base64'))).toBe(hash(content));
  expect(posted.filter(message => message.type === 'attachmentWarning')).toEqual([]);
}
function assertClosed(file: string) {
  const receipt = handles.find(handle => handle.path === file);
  expect(receipt).toBeDefined();
  expect(receipt!.closed).toBe(true); expect(receipt!.closes).toBe(1);
  expect(receipt!.reads.every(read => read.requested > 0 && read.requested <= 64 * 1024)).toBe(true);
  expect(receipt!.reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThanOrEqual(LIMIT + 1);
  return receipt!;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-ew05-size-')));
  posted = []; events = []; handles = []; afterStat = () => undefined;
  afterOpen = () => undefined; beforeRead = () => undefined; afterRead = () => undefined; afterClose = () => undefined;
  host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: new Map([['owner', { currentConversationId: 'owned-conversation' }]]),
    _mystiRunGen: new Map(), _getPanelAgent: () => 'claude-code',
    _providerManager: { getProviderInstance: () => ({ capabilities: { supportsImages: true, supportsFileAttachments: true } }) },
    _postToPanel: (panelId: string, message: unknown) => { expect(panelId).toBe('owner'); posted.push(message); },
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Attachment fixture forbids external requests'); }));
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: any, ...options: any[]) => {
    const stat = await (realStat as any)(file, ...options);
    if (String(file).startsWith(root + path.sep)) {
      events.push({ operation: 'stat', path: String(file), size: Number(stat.size) });
      afterStat(String(file));
    }
    return stat;
  }) as any);
  vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: any, ...options: any[]) => {
    const result = await (realReadFile as any)(file, ...options);
    if (String(file).startsWith(root + path.sep)) events.push({ operation: 'readFile', path: String(file), bytes: Buffer.byteLength(result), sha256: hash(Buffer.from(result)) });
    return result;
  }) as any);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (file: any, ...options: any[]) => {
    const handle = await (realOpen as any)(file, ...options);
    if (!String(file).startsWith(root + path.sep)) return handle;
    const receipt: HandleReceipt = { path: String(file), reads: [], closes: 0, closed: false }; handles.push(receipt);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation(async (...args: any[]) => {
      beforeRead(String(file), receipt.reads.length);
      const result = await read(...args);
      const content = Buffer.from(result.buffer.buffer, result.buffer.byteOffset + args[1], result.bytesRead);
      receipt.reads.push({ requested: args[2], bytes: result.bytesRead, sha256: hash(content) });
      afterRead(String(file)); return result;
    });
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      receipt.closes++; await close(); receipt.closed = true; afterClose(String(file));
    });
    afterOpen(String(file)); return handle;
  }) as any);
});

afterEach(() => {
  if (process.env.MYSTI_ATTACHMENT_SIZE_RECEIPTS) {
    const messages = posted.map(message => message.type !== 'fileAttachmentSelected' ? message : {
      type: message.type, payload: { attachments: message.payload.attachments.map((attachment: any) => {
        const { base64Data, ...metadata } = attachment;
        const content = Buffer.from(base64Data, 'base64');
        return { ...metadata, actualBytes: content.length, sha256: hash(content) };
      }) },
    });
    fs.appendFileSync(process.env.MYSTI_ATTACHMENT_SIZE_RECEIPTS, JSON.stringify({
      test: expect.getState().currentTestName, limit: LIMIT, events, handles, messages,
    }) + '\n');
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true });
});

describe('EW05 actual attachment picker byte boundaries', () => {
  for (const size of [LIMIT - 1, LIMIT]) {
    it(`accepts exact binary bytes at ${size} bytes`, async () => {
      const content = bytes(size), file = ownedFile('accepted.bin', content);
      await pick([file]); assertSelected(file, content);
    });
  }
  it('rejects a file initially one byte above the limit', async () => {
    const file = ownedFile('oversized.bin', bytes(LIMIT + 1));
    await pick([file]); expect(selected()).toEqual([]);
    expect(posted).toContainEqual({ type: 'attachmentWarning', payload: { message: expect.stringContaining('attachment limit') } });
    expect(events.filter(event => event.operation === 'readFile')).toEqual([]);
  });
  it('rejects growth beyond the limit after the initial metadata check', async () => {
    const file = ownedFile('growing.bin', bytes(8));
    afterStat = target => { if (target === file) { fs.writeFileSync(file, bytes(LIMIT + 1, 0x62)); afterStat = () => undefined; } };
    await pick([file]); expect(selected()).toEqual([]);
    expect(posted).toContainEqual({ type: 'attachmentWarning', payload: { message: expect.stringContaining('attachment limit') } });
  });
  for (const [initial, final] of [[8, 129], [129, 8]]) {
    it(`reports actual accepted byte length when the file changes from ${initial} to ${final}`, async () => {
      const content = bytes(final, 0x63), file = ownedFile('changed.bin', bytes(initial));
      afterStat = target => { if (target === file) { fs.writeFileSync(file, content); afterStat = () => undefined; } };
      await pick([file]); assertSelected(file, content);
    });
  }
  it('bounds actual reads when the file grows after the opened-handle size check', async () => {
    const file = ownedFile('growth-during-read.bin', bytes(8));
    beforeRead = (target, index) => { if (target === file && index === 0) fs.writeFileSync(file, bytes(LIMIT + 1024)); };
    await pick([file]); expect(selected()).toEqual([]);
    expect(posted).toContainEqual({ type: 'attachmentWarning', payload: { message: expect.stringContaining('attachment limit') } });
    const receipt = assertClosed(file);
    expect(receipt.reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(LIMIT + 1);
    expect(events.filter(event => event.operation === 'readFile')).toEqual([]);
  });
  it('retains a readable empty file and closes its EOF handle', async () => {
    const content = bytes(0), file = ownedFile('empty.bin', content);
    await pick([file]); assertSelected(file, content);
    expect(assertClosed(file).reads.map(read => read.bytes)).toEqual([0]);
  });
  for (const when of ['open', 'read', 'close'] as const) {
    it(`drops the selection and closes the handle if its conversation changes during ${when}`, async () => {
      const file = ownedFile('cancelled.bin', bytes(128 * 1024));
      const change = () => { host._panelStates.get('owner').currentConversationId = 'replacement'; };
      if (when === 'open') afterOpen = change;
      if (when === 'read') afterRead = change;
      if (when === 'close') afterClose = change;
      await pick([file]); expect(posted).toEqual([]);
      const receipt = assertClosed(file);
      if (when === 'open') expect(receipt.reads).toEqual([]);
      if (when === 'read') expect(receipt.reads).toHaveLength(1);
    });
  }
  for (const change of ['panel replacement', 'sent draft'] as const) {
    it(`does not stage partially read bytes after ${change}`, async () => {
      const file = ownedFile('owned-turn.bin', bytes(128 * 1024));
      afterRead = () => {
        if (change === 'panel replacement') host._panelStates.set('owner', { currentConversationId: 'owned-conversation' });
        else host._mystiRunGen.set('owner', 1);
      };
      await pick([file]); expect(posted).toEqual([]); expect(assertClosed(file).reads).toHaveLength(1);
    });
  }
  it('rejects a partial read failure while keeping a later valid file', async () => {
    const broken = ownedFile('broken.bin', bytes(128 * 1024)), content = bytes(17);
    const valid = ownedFile('valid.bin', content);
    beforeRead = (file, index) => { if (file === broken && index === 1) throw new Error('Owned read failure'); };
    await pick([broken, valid]); expect(selected()).toHaveLength(1);
    expect(selected()[0].fileName).toBe('valid.bin');
    expect(hash(Buffer.from(selected()[0].base64Data, 'base64'))).toBe(hash(content));
    expect(posted).toContainEqual({ type: 'attachmentWarning', payload: { message: 'Could not read broken.bin.' } });
    expect(assertClosed(broken).reads).toHaveLength(1); assertClosed(valid);
  });
  it('rechecks provider capability after the asynchronous read', async () => {
    const file = ownedFile('unsupported-after-read.bin', bytes(9));
    afterRead = () => { host._providerManager.getProviderInstance = () => ({ capabilities: {} }); };
    await pick([file]); expect(selected()).toEqual([]); assertClosed(file);
    expect(posted).toContainEqual({ type: 'attachmentWarning', payload: { message: expect.stringContaining('does not accept file attachments') } });
  });
  it('omits a growing oversized item without losing a valid item in the same picker result', async () => {
    const oversized = ownedFile('growth.bin', bytes(1)), content = bytes(31);
    const valid = ownedFile('safe.bin', content);
    afterStat = file => { if (file === oversized) fs.writeFileSync(file, bytes(LIMIT + 1)); };
    await pick([oversized, valid]); expect(selected()).toHaveLength(1);
    expect(selected()[0].fileName).toBe('safe.bin'); expect(selected()[0].size).toBe(content.length);
    expect(hash(Buffer.from(selected()[0].base64Data, 'base64'))).toBe(hash(content));
    expect(assertClosed(oversized).reads).toEqual([]); assertClosed(valid);
    expect(posted).toContainEqual({ type: 'attachmentWarning', payload: { message: 'growth.bin exceeds the 10 MB attachment limit.' } });
  });
  it('delivers the accepted limit-sized binary snapshot to real CLI attachment preparation', async () => {
    const content = bytes(LIMIT, 0x5a), file = ownedFile('transport.bin', content);
    await pick([file]); assertSelected(file, content); assertClosed(file);
    fs.writeFileSync(file, 'Changed after selection');
    const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(root) }] });
    const provider: any = Object.assign(Object.create(BaseCliProvider.prototype), { displayName: 'Owned attachment transport' });
    const attachment = { ...selected()[0] };
    let cleanup: (() => Promise<void>) | null = null;
    try {
      cleanup = await provider.prepareAttachments([attachment], []);
      expect(attachment.filePath).not.toBe(file);
      expect(path.relative(root, attachment.filePath).startsWith('..')).toBe(false);
      const delivered = await realReadFile(attachment.filePath);
      expect(delivered.length).toBe(LIMIT); expect(hash(delivered)).toBe(hash(content));
      events.push({ operation: 'prepared-cli-bytes', path: attachment.filePath, bytes: delivered.length, sha256: hash(delivered) });
      await cleanup!(); cleanup = null; expect(fs.existsSync(attachment.filePath)).toBe(false);
    } finally {
      await cleanup?.();
      if (descriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', descriptor);
      else Reflect.deleteProperty(vscode.workspace, 'workspaceFolders');
    }
  });
  for (const change of ['modified', 'deleted'] as const) {
    it(`delivers the selected empty snapshot after its original file is ${change}`, async () => {
      const file = ownedFile('empty-transport.txt', Buffer.alloc(0));
      await pick([file]); assertSelected(file, Buffer.alloc(0)); assertClosed(file);
      if (change === 'modified') fs.writeFileSync(file, 'Later file contents');
      else fs.unlinkSync(file);
      const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(root) }] });
      const provider: any = Object.assign(Object.create(BaseCliProvider.prototype), { displayName: 'Owned empty attachment transport' });
      const attachment = { ...selected()[0] };
      let cleanup: (() => Promise<void>) | null = null;
      try {
        cleanup = await provider.prepareAttachments([attachment], []);
        expect(attachment.filePath).not.toBe(file);
        const delivered = await realReadFile(attachment.filePath);
        expect(delivered).toEqual(Buffer.alloc(0));
        events.push({ operation: 'prepared-empty-cli-bytes', path: attachment.filePath, bytes: delivered.length, sha256: hash(delivered) });
        await cleanup!(); cleanup = null; expect(fs.existsSync(attachment.filePath)).toBe(false);
        if (change === 'modified') expect(fs.readFileSync(file, 'utf8')).toBe('Later file contents');
        else expect(fs.existsSync(file)).toBe(false);
      } finally {
        await cleanup?.();
        if (descriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', descriptor);
        else Reflect.deleteProperty(vscode.workspace, 'workspaceFolders');
      }
    });
  }
});
