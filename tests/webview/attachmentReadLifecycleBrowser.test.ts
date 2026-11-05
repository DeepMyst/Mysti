import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const ready = { ...INITIAL_STATE, panelId: 'reader-owner', conversation: { id: 'original', messages: [] },
  providers: registry.getAll().map(provider => provider.config), providerManifest: buildProviderManifestPayload(registry) };
let browser: Browser, page: Page, errors: string[];
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const sends = () => page.evaluate(() => (window as any).__posted.filter((event: any) =>
  ['sendMessage', 'sendBrainstormMessage', 'executeSlashCommand'].includes(event.type)));
const names = () => page.locator('.attachment-name').allTextContents();
const finish = () => receive('responseComplete', { message: { id: 'complete', role: 'assistant', content: 'Complete' } });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function installDelayedReaders() {
  await page.evaluate(() => {
    const NativeReader = window.FileReader;
    (window as any).__readers = [];
    (window as any).FileReader = class {
      static LOADING = 1;
      readyState = 0; result: string | ArrayBuffer | null = null;
      onload: any; onerror: any; onabort: any; savedLoad: any; savedError: any;
      native = new NativeReader(); nativeDone = false; aborts = 0; released = false; name = '';
      readAsDataURL(blob: File) {
        this.name = blob.name; this.readyState = 1;
        this.savedLoad = this.onload; this.savedError = this.onerror;
        (window as any).__readers.push(this);
        if ((window as any).__readerThrows) { this.nativeDone = true; throw new Error('Controlled read failure'); }
        this.native.onload = () => { this.result = this.native.result; this.nativeDone = true; };
        this.native.readAsDataURL(blob);
      }
      abort() { this.aborts++; this.readyState = 2; this.native.abort(); this.nativeDone = true; this.onabort?.({ target: this }); }
      release(fail: boolean) {
        this.released = true; this.readyState = 2;
        // Deliberately retain callbacks: simulate a completion already queued at cancellation.
        (fail ? this.savedError : this.savedLoad)?.({ target: this });
      }
    };
  });
}
async function select(route: 'paste' | 'drop', files: Array<{ name: string; bytes?: number[]; type?: string; size?: number }>) {
  await page.evaluate(({ route, files }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([file.size === undefined ? new Uint8Array(file.bytes ?? [65, 0, 255, 10]) : new Uint8Array(file.size)], file.name,
      { type: file.type ?? 'text/plain' }));
    const input = document.getElementById('message-input')!;
    if (route === 'paste') input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    else input.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { route, files });
  await page.waitForFunction(() => (window as any).__readers.every((reader: any) => reader.nativeDone));
}
async function release(indices?: number[], fail = false) {
  await page.evaluate(({ indices, fail }) => {
    (window as any).__readers.forEach((reader: any, index: number) => {
      if (indices ? indices.includes(index) : !reader.released) reader.release(fail);
    });
  }, { indices, fail });
}

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) throw new Error(CHROMIUM_UNAVAILABLE);
  browser = await chromium.launch();
});
beforeEach(async () => {
  errors = []; page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(composeChatHtml()); await receive('initialState', ready);
  await page.waitForFunction(() => (window as any).__posted.some((event: any) => event.type === 'uiReady'));
  await installDelayedReaders();
});
afterEach(async () => {
  if (page && process.env.MYSTI_ATTACHMENT_READ_RECEIPTS) {
    const evidence = await page.evaluate(() => ({
      readers: (window as any).__readers?.map((reader: any) => ({ name: reader.name, aborts: reader.aborts,
        released: reader.released, readyState: reader.readyState, handlersCleared: !reader.onload && !reader.onerror && !reader.onabort })),
      previews: Array.from(document.querySelectorAll('.attachment-name')).map(node => node.textContent),
      toasts: Array.from(document.querySelectorAll('.mysti-toast')).map(node => node.textContent),
      posted: (window as any).__posted.filter((event: any) => ['sendMessage', 'sendBrainstormMessage', 'executeSlashCommand'].includes(event.type)),
    }));
    fs.appendFileSync(process.env.MYSTI_ATTACHMENT_READ_RECEIPTS, JSON.stringify({ test: expect.getState().currentTestName, ...evidence }) + '\n');
  }
  await page?.close(); expect(errors).toEqual([]);
});
afterAll(async () => { await browser?.close(); registry.dispose(); });

describe('EW06 delayed browser attachment reads', () => {
  for (const route of ['paste', 'drop'] as const) {
    it(`${route}: sends captured binary and empty bytes once, then a text-only follow-up`, async () => {
      await select(route, [{ name: 'binary.txt' }, { name: 'empty.txt', bytes: [] }]); await release();
      await page.locator('#message-input').fill('Read these files'); await page.locator('#send-btn').click();
      const first = (await sends())[0]; expect(first.payload.attachments).toHaveLength(2);
      const binary = first.payload.attachments.find((attachment: any) => attachment.fileName === 'binary.txt');
      expect(hash(Buffer.from(binary.base64Data, 'base64'))).toBe(hash(Buffer.from([65, 0, 255, 10])));
      expect(binary).toMatchObject({ size: 4, mimeType: 'text/plain' });
      expect(first.payload.attachments.find((attachment: any) => attachment.fileName === 'empty.txt')).toMatchObject({ size: 0, base64Data: '' });
      await finish(); await page.locator('#message-input').fill('Follow-up'); await page.locator('#send-btn').click();
      expect((await sends())[1].payload.attachments).toBeUndefined(); expect(await names()).toEqual([]);
    });
    it(`${route}: revokes a delayed read across navigation, including away and back`, async () => {
      await select(route, [{ name: 'old-draft.txt' }]);
      await receive('conversationChanged', { id: 'other', messages: [] });
      await release(); expect(await names()).toEqual([]);
      expect(await page.evaluate(() => (window as any).__readers[0].aborts)).toBe(1);
      await receive('conversationChanged', { id: 'original', messages: [] });
      await release([0]); expect(await names()).toEqual([]);
      await page.locator('#message-input').fill('Clean original draft'); await page.locator('#send-btn').click();
      expect((await sends())[0].payload.attachments).toBeUndefined();
    });
    it(`${route}: keeps the draft unsent while its attachment is loading`, async () => {
      await select(route, [{ name: 'pending.txt' }]); await page.locator('#message-input').fill('Include the file');
      await page.locator('#send-btn').click(); expect(await sends()).toEqual([]);
      expect(await page.locator('#message-input').inputValue()).toBe('Include the file');
      expect(await page.locator('.mysti-toast').allTextContents()).toContain('Attachments are still loading. Wait or remove them before sending.');
      await release(); await page.locator('#send-btn').click();
      expect((await sends())[0].payload.attachments.map((attachment: any) => attachment.fileName)).toEqual(['pending.txt']);
    });
    it(`${route}: counts outstanding reads toward the ten-attachment limit`, async () => {
      await select(route, Array.from({ length: 8 }, (_, index) => ({ name: `first-${index}.txt` })));
      await select(route, Array.from({ length: 4 }, (_, index) => ({ name: `second-${index}.txt` })));
      expect(await page.evaluate(() => (window as any).__readers.length)).toBe(10);
      await release(); expect(await names()).toHaveLength(10);
      expect(await page.locator('.mysti-toast').allTextContents()).toContain('Maximum 10 attachments per message');
    });
    it(`${route}: reports a read error, releases its slot and retains another accepted file`, async () => {
      await select(route, [{ name: 'bad.txt' }, { name: 'good.txt' }]); await release([0], true); await release([1]);
      expect(await names()).toEqual(['good.txt']);
      expect(await page.locator('.mysti-toast').allTextContents()).toContain('Failed to read: bad.txt');
      await select(route, [{ name: 'replacement.txt' }]); await release([2]); expect(await names()).toEqual(['good.txt', 'replacement.txt']);
    });
    it(`${route}: removes a pending attachment without accepting a queued completion`, async () => {
      await select(route, [{ name: 'cancel-me.txt' }]);
      expect(await names()).toEqual(['cancel-me.txt']);
      if (route === 'paste' && process.env.MYSTI_ATTACHMENT_READ_PREVIEW) {
        await page.screenshot({ path: process.env.MYSTI_ATTACHMENT_READ_PREVIEW });
      }
      await page.locator('.attachment-remove').click(); await release(); expect(await names()).toEqual([]);
      expect(await page.evaluate(() => (window as any).__readers[0].aborts)).toBe(1);
    });
    it(`${route}: renders a hostile filename as text`, async () => {
      const name = '<img src=x onerror="window.__attachmentXss=1">.txt';
      await select(route, [{ name }]); await release();
      expect(await names()).toEqual([name]);
      expect(await page.locator('#attachment-previews img').count()).toBe(0);
      expect(await page.evaluate(() => (window as any).__attachmentXss)).toBeUndefined();
    });
  }
  it('keeps queued-message draining separate from a draft with an unfinished read', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await page.locator('#message-input').fill('Queued question'); await page.locator('#message-input').press('Tab');
    await select('paste', [{ name: 'draft.txt' }]); await page.locator('#message-input').fill('Unsent draft');
    await finish(); expect((await sends())[0].payload.content).toBe('Queued question');
    expect((await sends())[0].payload.attachments).toBeUndefined();
    await release(); expect(await names()).toEqual(['draft.txt']);
    expect(await page.locator('#message-input').inputValue()).toBe('Unsent draft');
  });
  it('reserves pending slots when host picker selections arrive', async () => {
    await select('drop', Array.from({ length: 9 }, (_, index) => ({ name: `pending-${index}.txt` })));
    await receive('fileAttachmentSelected', { attachments: ['accepted.txt', 'overflow.txt'].map(fileName => ({
      id: fileName, type: 'file', fileName, mimeType: 'text/plain', size: 0, base64Data: '',
    })) });
    await release(); expect(await names()).toHaveLength(10);
    expect(await names()).toContain('accepted.txt'); expect(await names()).not.toContain('overflow.txt');
  });
  it('revokes readers on page disposal and suppresses stale success/error callbacks', async () => {
    await select('drop', [{ name: 'disposed.txt' }]);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await release(); await release([0], true); expect(await names()).toEqual([]);
    expect(await page.locator('.mysti-toast').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__readers[0].aborts)).toBe(1);
  });
  it('keeps a loading attachment out of both busy keyboard queues and typed slash dispatch', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await select('paste', [{ name: 'queued.txt' }]); await page.locator('#message-input').fill('Owned question');
    await page.locator('#message-input').press('Tab');
    expect(await page.locator('.queued-chip').count()).toBe(0);
    expect(await page.locator('#message-input').inputValue()).toBe('Owned question');
    await finish(); await page.locator('#message-input').fill('/review'); await page.locator('#send-btn').click();
    expect(await sends()).toEqual([]); expect(await page.locator('#message-input').inputValue()).toBe('/review');
    await release(); await page.locator('#send-btn').click();
    expect((await sends())[0]).toMatchObject({ type: 'executeSlashCommand', payload: { command: 'review', attachments: [{ fileName: 'queued.txt' }] } });
  });
  it('preserves a draft when a busy slash-menu command is blocked by a pending read', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await select('drop', [{ name: 'menu.txt' }]); await page.locator('#message-input').fill('/rev');
    await receive('slashCommandMenu', { commands: [{ id: 'native:claude-code:review', nativeName: 'review',
      label: '/review', description: 'Controlled review', section: 'native' }], sections: [{ id: 'native', label: 'Agent commands', order: 1 }] });
    await page.locator('.slash-menu-item[data-command-id="native:claude-code:review"]').click();
    expect(await sends()).toEqual([]); expect(await page.locator('.queued-chip').count()).toBe(0);
    expect(await page.locator('#message-input').inputValue()).toBe('/rev');
    await release(); expect(await names()).toEqual(['menu.txt']);
  });
  it('revokes unfinished reads on an initial-state rebind to another conversation', async () => {
    await select('drop', [{ name: 'old-binding.txt' }]);
    await receive('initialState', { ...ready, conversation: { id: 'rebound', messages: [] } });
    await release(); expect(await names()).toEqual([]);
    expect(await page.evaluate(() => (window as any).__readers[0].aborts)).toBe(1);
  });
  it('keeps the same draft read across a same-conversation refresh and persisted pagehide', async () => {
    await select('drop', [{ name: 'retained.txt' }]);
    await receive('conversationChanged', { id: 'original', messages: [] });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await release(); expect(await names()).toEqual(['retained.txt']);
    expect(await page.evaluate(() => (window as any).__readers[0].aborts)).toBe(0);
  });
  it('cleans synchronous reader failures and malformed results without filling slots', async () => {
    await page.evaluate(() => { (window as any).__readerThrows = true; });
    await select('paste', [{ name: 'throws.txt' }]); expect(await names()).toEqual([]);
    await page.evaluate(() => { (window as any).__readerThrows = false; });
    await select('paste', [{ name: 'malformed.txt' }]);
    await page.evaluate(() => { (window as any).__readers[1].result = 'not a data URL'; }); await release([1]);
    expect(await names()).toEqual([]);
    expect(await page.locator('.mysti-toast').allTextContents()).toEqual(['Failed to read: throws.txt', 'Failed to read: malformed.txt']);
    expect(await page.evaluate(() => (window as any).__readers.every((reader: any) => !reader.onload && !reader.onerror && !reader.onabort))).toBe(true);
    await select('drop', [{ name: 'good.txt' }]); await release([2]); await release([2]);
    expect(await names()).toEqual(['good.txt']);
  });
  it('frees a reserved slot after failure while retaining the other nine reads', async () => {
    await select('paste', Array.from({ length: 10 }, (_, index) => ({ name: `reserved-${index}.txt` })));
    await release([0], true); await select('drop', [{ name: 'replacement.txt' }]); await release();
    expect(await names()).toHaveLength(10); expect(await names()).toContain('replacement.txt');
    expect(await names()).not.toContain('reserved-0.txt');
  });
  for (const route of ['paste', 'drop'] as const) for (const image of [false, true]) {
    it(`${route}: applies the ${image ? '5 MiB image' : '10 MiB file'} boundary before starting readers`, async () => {
      const limit = (image ? 5 : 10) * 1024 * 1024, type = image ? 'image/png' : 'text/plain';
      await select(route, [-1, 0, 1].map(delta => ({ name: `boundary-${delta}.${image ? 'png' : 'txt'}`, type, size: limit + delta })));
      expect(await page.evaluate(() => (window as any).__readers.length)).toBe(2);
      await release(); expect(await names()).toEqual([`boundary--1.${image ? 'png' : 'txt'}`, `boundary-0.${image ? 'png' : 'txt'}`]);
      expect((await page.locator('.mysti-toast').allTextContents()).join(' ')).toContain('too large');
    }, 15000);
  }
  it('renders an SVG image without executing its script and preserves its delivered bytes', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgAttachmentExecuted=1</script><rect width="1" height="1"/></svg>';
    await select('drop', [{ name: 'active.svg', type: 'image/svg+xml', bytes: [...Buffer.from(svg)] }]); await release();
    expect(await page.locator('#attachment-previews img').count()).toBe(1);
    expect(await page.evaluate(() => (window as any).__svgAttachmentExecuted)).toBeUndefined();
    await page.locator('#message-input').fill('Describe image'); await page.locator('#send-btn').click();
    expect((await sends())[0].payload.attachments[0]).toMatchObject({ type: 'image', mimeType: 'image/svg+xml', base64Data: Buffer.from(svg).toString('base64') });
  });
  for (const busy of [false, true]) it(`keeps a pending draft read separate from a ${busy ? 'queued' : 'direct'} second opinion`, async () => {
    await receive('messageAdded', { id: 'original-question', role: 'user', content: 'Original question' });
    await receive('responseComplete', { message: { id: 'original-answer', role: 'assistant', content: 'Answer', provider: 'claude-code' } });
    if (busy) await receive('responseStarted', { provider: 'claude-code' });
    await select('paste', [{ name: 'independent.txt' }]); await page.locator('#message-input').fill('Independent draft');
    await page.locator('[data-id="original-answer"] [data-second-opinion]').click();
    await page.locator('.second-opinion-item[data-agent="openai-codex"]').click();
    if (busy) { expect(await sends()).toEqual([]); await finish(); }
    expect((await sends())[0].payload).toMatchObject({ content: 'Original question', secondOpinion: { provider: 'openai-codex', messageId: 'original-question' } });
    expect((await sends())[0].payload.attachments).toBeUndefined();
    await release(); expect(await names()).toEqual(['independent.txt']);
    expect(await page.locator('#message-input').inputValue()).toBe('Independent draft');
  });
});
