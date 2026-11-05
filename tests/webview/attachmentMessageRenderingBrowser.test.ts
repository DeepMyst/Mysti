import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import { createHarness } from '../helpers/autoContextSendHarness';
import { clearMockConfig } from '../helpers/mockVscode';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() { /* No model subprocess in this fixture. */ }
} }));

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const ready = { ...INITIAL_STATE, panelId: 'sidebar', conversation: { id: 'browser-chat', messages: [] },
  providers: registry.getAll().map(provider => provider.config), providerManifest: buildProviderManifestPayload(registry) };
const png = fs.readFileSync('resources/icons/check.png');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const injection = '"><b data-metadata-injected="1">Injected</b><img src="bad" onerror="window.__metadataxss=1" data-tail="';
// Blob/File normalizes MIME metadata to lowercase before it reaches the reader.
const malformedMime = ('image/png' + injection).toLowerCase();
const settings = { provider: 'claude-code', model: 'claude-opus-4-6', mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
let browser: Browser, page: Page, errors: string[], evidence: any[];
let harness: ReturnType<typeof createHarness>, manager: ConversationManager, context: any;
const receive = (type: string, payload?: unknown) => page.evaluate(message =>
  window.dispatchEvent(new MessageEvent('message', { data: message })), { type, payload });
const attachment = (extra: Record<string, unknown> = {}) => ({
  id: 'image-a', type: 'image', fileName: 'check.png', mimeType: 'image/png', size: png.length, base64Data: png.toString('base64'), ...extra,
});

beforeAll(async () => {
  if (CHROMIUM_UNAVAILABLE) throw new Error(CHROMIUM_UNAVAILABLE);
  browser = await chromium.launch();
});
beforeEach(async () => {
  clearMockConfig(); errors = []; evidence = [];
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Attachment rendering fixture forbids external provider requests'); }));
  harness = createHarness(); harness.setStream([{ type: 'text', content: 'Controlled answer.' }, { type: 'done' }]);
  const storage: Record<string, any> = {};
  context = { globalState: { get: (key: string, fallback: unknown) => key in storage ? clone(storage[key]) : fallback,
    update: async (key: string, value: unknown) => { storage[key] = clone(value); } } };
  manager = new ConversationManager(context);
  const host = harness.provider as any;
  host._conversationManager = manager;
  host._panelStates.get('sidebar').currentConversationId = manager.getCurrentConversation()!.id;
  host._generateTitleAsync = vi.fn();
  page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(composeChatHtml()); await receive('initialState', ready);
});
afterEach(async () => {
  if (page && process.env.MYSTI_ATTACHMENT_MESSAGE_RECEIPTS) {
    const dom = await page.evaluate(() => ({
      injectedElements: document.querySelectorAll('[data-metadata-injected]').length,
      executed: (window as any).__metadataxss ?? null,
      images: Array.from(document.querySelectorAll('.message-attachment-img')).map(node => ({
        src: node.getAttribute('src'), onerror: node.getAttribute('onerror'), alt: node.getAttribute('alt'),
      })), labels: Array.from(document.querySelectorAll('.message-attachment-label')).map(node => node.textContent),
    }));
    fs.appendFileSync(process.env.MYSTI_ATTACHMENT_MESSAGE_RECEIPTS, JSON.stringify({ test: expect.getState().currentTestName, evidence, dom }) + '\n');
  }
  await page?.close();
  if (harness) { await (harness.provider as any)._agentInitPromise; harness.dispose(); }
  vi.unstubAllGlobals(); expect(errors).toEqual([]);
});
afterAll(async () => { await browser?.close(); registry.dispose(); });

async function hostRoundTrip(attachments: any[], payload?: any) {
  await (harness.provider as any)._handleSendMessage(payload ?? { content: 'Inspect attachment', settings, context: [], attachments }, 'sidebar');
  const message = harness.sidebarMessages.find(event => event.type === 'messageAdded' && event.payload?.role === 'user')?.payload;
  expect(message).toBeDefined();
  expect(harness.providerManager.sendMessage).toHaveBeenCalledTimes(1);
  const delivered = vi.mocked(harness.providerManager.sendMessage).mock.calls[0][7] as any[];
  expect(delivered).toEqual(attachments); expect(message.attachments).toEqual(attachments);
  expect(manager.getCurrentConversation()!.messages.find(item => item.role === 'user')!.attachments!.every(item => item.base64Data === undefined)).toBe(true);
  evidence.push({ operation: 'actual-host-display-and-provider-boundary', messageId: message.id,
    attachments: delivered.map(item => ({ fileName: item.fileName, mimeType: item.mimeType,
      bytes: Buffer.from(item.base64Data ?? '', 'base64').length, sha256: hash(Buffer.from(item.base64Data ?? '', 'base64')) })), storedWithoutBytes: true });
  return clone(message);
}
async function assertLiteralThumbnail(item: any) {
  const thumbnails = page.locator('.message-attachment-img');
  expect(await thumbnails.count()).toBe(1);
  expect(await thumbnails.getAttribute('src')).toBe('data:' + item.mimeType + ';base64,' + item.base64Data);
  expect(await thumbnails.getAttribute('alt')).toBe(item.fileName);
  expect(await page.locator('[data-metadata-injected], .message-attachments [onerror], .message-attachments [data-tail]').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__metadataxss)).toBeUndefined();
}

describe('EW05 attachment message attributes across real host and browser boundaries', () => {
  for (const field of ['mimeType', 'base64Data'] as const) for (const route of ['messageAdded', 'conversationChanged', 'initialState'] as const) {
    it(`${route}: contains malformed ${field} inside the image source attribute`, async () => {
      const item = attachment({ [field]: field === 'mimeType' ? malformedMime : injection });
      const message = await hostRoundTrip([item]);
      if (route === 'messageAdded') await receive(route, message);
      else if (route === 'conversationChanged') await receive(route, { id: 'live-cache', messages: [message] });
      else await receive(route, { ...ready, conversation: { id: 'live-cache', messages: [message] } });
      await assertLiteralThumbnail(item);
    });
  }
  for (const route of ['paste', 'drop'] as const) {
    it(`${route}: keeps actual File MIME metadata inert through composer, host and message display`, async () => {
      const acceptedType = await page.evaluate(({ route, type, bytes }) => {
        const file = new File([new Uint8Array(bytes)], 'pasted.png', { type });
        const data = new DataTransfer(); data.items.add(file);
        const input = document.getElementById('message-input')!;
        input.dispatchEvent(route === 'paste' ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
        return file.type;
      }, { route, type: malformedMime, bytes: [...png] });
      expect(acceptedType).toBe(malformedMime);
      await page.waitForFunction(() => document.querySelectorAll('.attachment-preview-item').length === 1 && !document.querySelector('.attachment-reading'));
      expect(await page.locator('#attachment-previews [data-metadata-injected], #attachment-previews [onerror]').count()).toBe(0);
      await page.locator('#message-input').fill('Inspect pasted image'); await page.locator('#send-btn').click();
      const request = await page.evaluate(() => (window as any).__posted.find((event: any) => event.type === 'sendMessage').payload);
      const item = request.attachments[0]; expect(item.mimeType).toBe(malformedMime);
      expect(hash(Buffer.from(item.base64Data, 'base64'))).toBe(hash(png));
      const display = await hostRoundTrip([item], request); await receive('messageAdded', display);
      await assertLiteralThumbnail(item);
    });
  }
  for (const type of ['png', 'svg'] as const) {
    it(`displays a normal ${type} image and preserves exact provider-bound bytes`, async () => {
      const bytes = type === 'png' ? png : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>');
      const item = attachment({ fileName: `valid.${type}`, mimeType: type === 'png' ? 'image/png' : 'image/svg+xml', size: bytes.length, base64Data: bytes.toString('base64') });
      const message = await hostRoundTrip([item]); await receive('messageAdded', message);
      await assertLiteralThumbnail(item);
      await page.waitForFunction(() => { const image = document.querySelector('.message-attachment-img') as HTMLImageElement; return image?.complete && image.naturalWidth > 0; });
      expect(hash(Buffer.from((vi.mocked(harness.providerManager.sendMessage).mock.calls[0][7] as any[])[0].base64Data, 'base64'))).toBe(hash(bytes));
    });
  }
  for (const route of ['storage reload', 'import', 'export/import'] as const) {
    it(`${route}: strips embedded bytes and retains a literal attachment label`, async () => {
      const name = '<img src=x onerror="window.__metadataxss=1">.png';
      const message = await hostRoundTrip([attachment({ fileName: name, mimeType: malformedMime })]);
      let restored;
      if (route === 'storage reload') restored = new ConversationManager(context).getCurrentConversation()!;
      else {
        const raw = route === 'export/import' ? manager.exportToJson(manager.getCurrentConversation()!.id)
          : JSON.stringify({ format: 'mysti', version: 1, conversation: { ...manager.getCurrentConversation(), messages: [message] } });
        restored = manager.importFromContent(raw, 'fixture.mysti.json')!;
      }
      expect(restored.messages[0].attachments![0].base64Data).toBeUndefined();
      await receive('conversationChanged', clone(restored));
      expect(await page.locator('.message-attachment-img').count()).toBe(0);
      expect(await page.locator('.message-attachment-label').textContent()).toBe(name);
      expect(await page.locator('.message-attachments [onerror]').count()).toBe(0);
    });
  }
  for (const type of ['file', 'image']) {
    it(`keeps an empty ${type} attachment as a literal label without creating an image`, async () => {
      const name = '<b>empty</b>.txt';
      const item = attachment({ type, fileName: name, base64Data: '', size: 0 });
      await receive('messageAdded', await hostRoundTrip([item]));
      expect(await page.locator('.message-attachment-img, .message-attachments b').count()).toBe(0);
      expect(await page.locator('.message-attachment-label').textContent()).toContain(name);
    });
  }
});
