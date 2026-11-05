import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { composeChatHtml, INITIAL_STATE } from './chatPageHtml';
import { CHROMIUM_UNAVAILABLE } from './chromiumAvailability';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { buildProviderManifestPayload } from '../../src/providers/base/ProviderManifest';
import type { Mention } from '../../src/types';

interface CapturedPayload { content: string; mentions?: Mention[]; context: unknown[]; attachments?: unknown[] }

// Exercise the shipped menu, editor input and send/queue handlers. No copied
// parser or private webview-state hook participates in the identity oracle.
describe('selected file mention identity in the shipped browser', () => {
  let browser: Browser, page: Page, fixtureRoot: string, manifest: unknown;
  let browserLaunch: Promise<Browser> | undefined;
  let errors: string[], selectedRows: Array<{ selectedPath: string; observed: { value: string | null; name?: string | null; label: string | null } }>;
  let files: Array<{ path: string; content: string }>;
  let named: Record<string, string>;
  let multiRoot: { declaredWorkspaceRoots: string[]; suppliedWorkspaceCache: string[]; workspaceCacheHistory: string[][] } | undefined;
  const receive = (type: string, payload?: unknown) => page.evaluate(message => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  }, { type, payload });
  const input = () => page.locator('#message-input');
  const posted = () => page.evaluate(() => (window as any).__posted.filter((m: any) => m.type === 'sendMessage'));

  beforeAll(async () => {
    if (CHROMIUM_UNAVAILABLE) { return; }
    fixtureRoot = process.env.MYSTI_FILE_MENTION_FIXTURE_ROOT || mkdtempSync(path.join(tmpdir(), 'mysti-file-mention-'));
    const fixtureSpecs = [
      ['a', 'packages/a/utils.ts', 'export const identity = "EW04_PACKAGE_A";\n'],
      ['b', 'packages/b/utils.ts', 'export const identity = "EW04_PACKAGE_B";\n'],
      ['unique', 'notes/unique.md', 'EW04_UNIQUE_REFERENCE\n'],
      ['space', 'notes/retry contract.md', 'EW04_SPACE_REFERENCE\n'],
      ['unicode', 'notes/ملف.ts', 'const نص = "EW04_UNICODE_REFERENCE_🙂";\n'],
      ['quote', process.platform === 'win32' ? "notes/quote'note.ts" : 'notes/quote"note.ts', 'export const quoted = "EW04_QUOTED_REFERENCE";\n'],
      ['agentName', 'odd/ref @claude and @codex note.ts', 'EW04_LITERAL_AGENT_FILENAME\n'],
      ['backtick', 'odd/tick` @claude note.ts', 'EW04_BACKTICK_FILENAME\n'],
      ['rootA', 'root-a/src/util.ts', 'export const root = "EW04_MULTIROOT_A";\n'],
      ['rootB', 'root-b/src/util.ts', 'export const root = "EW04_MULTIROOT_B";\n'],
      ['rootBUnique', 'root-b/src/root-two-only.ts', 'export const root = "EW04_MULTIROOT_B_UNIQUE";\n'],
      ['shortDotfile', 'notes/.a', 'EW04_SHORT_DOTFILE_REFERENCE\n'],
    ];
    named = {};
    files = fixtureSpecs.map(([id, relative, content]) => {
      const file = path.join(fixtureRoot, relative);
      named[id] = file;
      mkdirSync(path.dirname(file), { recursive: true });
      if (existsSync(file)) expect(readFileSync(file, 'utf8')).toBe(content);
      else writeFileSync(file, content, { flag: 'wx' });
      return { path: file, content };
    });
    const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
    try { manifest = buildProviderManifestPayload(registry); }
    finally { registry.dispose(); }
    browserLaunch = chromium.launch({ timeout: 30_000 });
    browser = await browserLaunch;
  }, 60_000);
  beforeEach(async () => {
    if (CHROMIUM_UNAVAILABLE) return;
    errors = []; selectedRows = []; multiRoot = undefined;
    page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    page.setDefaultTimeout(3000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    // Loading the shipped assets is fixture startup; locator actions below
    // retain their separate 3s deadline after the page is ready.
    await page.setContent(composeChatHtml(), { timeout: 30_000 });
    await receive('initialState', {
      ...INITIAL_STATE, panelId: 'file-mention-owner', providerManifest: manifest,
      conversation: { id: 'file-mention-conversation', messages: [] },
      settings: { ...(INITIAL_STATE.settings as object), contextMode: 'manual' },
    });
    await receive('workspaceFiles', files.map(file => file.path));
  }, 60_000);
  afterEach(async () => { await page?.close(); if (errors) expect(errors).toEqual([]); }, 60_000);
  afterAll(async () => {
    try {
      // Retain startup ownership even if the setup hook fails before assigning
      // browser; a late launch must still be awaited and closed.
      const launched = await browserLaunch?.catch(() => undefined);
      await launched?.close();
    } finally {
      if (fixtureRoot && !process.env.MYSTI_FILE_MENTION_FIXTURE_ROOT) rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);

  async function selectFile(file: string, query: string, prefix = '') {
    await input().fill(prefix + '@' + query);
    const rows = page.locator('#mention-files-list .mention-menu-item');
    await rows.first().waitFor({ state: 'visible' });
    const observed = await rows.evaluateAll(elements => elements.map(element => ({
      value: element.getAttribute('data-value'),
      name: element.querySelector('.mention-name')?.textContent,
      label: element.textContent,
    })));
    // Literal quotes can affect a data attribute before the fix. A unique
    // visible filename still identifies the real item that a user can click.
    const index = observed.findIndex(row => row.value === file ||
      (file.includes('"') && row.name === path.basename(file)));
    expect(index, `selected file must be offered: ${file}`).toBeGreaterThanOrEqual(0);
    selectedRows.push({ selectedPath: file, observed: observed[index] });
    await rows.nth(index).click();
    return input().inputValue();
  }

  function assertIdentity(payload: CapturedPayload, selectedPaths: string[], composer: string, expectedAgents: string[] = []) {
    expect(payload.content).toBe(composer.trim());
    const mentions = (payload.mentions || []).filter((mention: Mention) => mention.type === 'file');
    expect(mentions.map((mention: Mention) => mention.value)).toEqual(selectedPaths);
    let previousEnd = -1;
    for (const mention of payload.mentions || []) {
      expect(Number.isInteger(mention.startIndex)).toBe(true);
      expect(Number.isInteger(mention.endIndex)).toBe(true);
      expect(mention.startIndex).toBeGreaterThanOrEqual(previousEnd);
      expect(mention.endIndex).toBeGreaterThan(mention.startIndex);
      expect(mention.endIndex).toBeLessThanOrEqual(payload.content.length);
      expect(payload.content[mention.startIndex]).toBe('@');
      expect(payload.content[mention.endIndex] || ' ').toMatch(/\s/);
      previousEnd = mention.endIndex;
    }
    expect(payload.context).toEqual([]);
    expect(payload.attachments).toBeUndefined();
    expect((payload.mentions || []).filter(mention => mention.type !== 'file').map(mention => mention.value)).toEqual(expectedAgents);
    for (const row of selectedRows) {
      expect(row.observed.value, 'the file row attribute must retain its exact path').toBe(row.selectedPath);
      expect(row.observed.name).toBe(path.basename(row.selectedPath));
    }
  }

  async function capture(caseId: string, selectedPaths: string[], composer: string, expectedAgents: string[] = []) {
    const sends = await posted();
    const receipt = { caseId, selectedPaths, composerBeforeSend: composer, selectedRows,
      payload: sends[0]?.payload, posted: sends, files, errors: [...errors], expectedDisposition: 'sent', expectedAgents,
      ...multiRoot,
      composerAfterSend: await input().inputValue(), queuedItemsAfterSend: await page.locator('.queued-chip').count() };
    // Retain the actual wrong or missing reference before the assertion fails.
    if (process.env.MYSTI_FILE_MENTION_BROWSER_RECEIPTS) {
      appendFileSync(process.env.MYSTI_FILE_MENTION_BROWSER_RECEIPTS, JSON.stringify(receipt) + '\n');
    }
    expect(sends).toHaveLength(1);
    assertIdentity(sends[0].payload, selectedPaths, composer, expectedAgents);
  }
  async function send(caseId: string, selectedPaths: string[], expectedAgents: string[] = []) {
    const composer = await input().inputValue();
    await page.locator('#send-btn').click();
    await capture(caseId, selectedPaths, composer, expectedAgents);
  }
  async function rejected(caseId: string, reason: RegExp) {
    const composer = await input().inputValue();
    await page.locator('#send-btn').click();
    const sends = await posted();
    const notice = page.locator('.mysti-toast').last();
    const receipt = { caseId, selectedPaths: [], composerBeforeSend: composer, selectedRows,
      payload: sends[0]?.payload, posted: sends, files, errors: [...errors], expectedDisposition: 'rejected',
      ...multiRoot,
      composerAfterSend: await input().inputValue(), notice: await notice.textContent(), noticeVisible: await notice.isVisible() };
    if (process.env.MYSTI_FILE_MENTION_BROWSER_RECEIPTS) {
      appendFileSync(process.env.MYSTI_FILE_MENTION_BROWSER_RECEIPTS, JSON.stringify(receipt) + '\n');
    }
    expect(sends).toEqual([]);
    expect(await input().inputValue()).toBe(composer);
    expect(receipt.noticeVisible).toBe(true);
    expect(receipt.notice).toMatch(reason);
  }

  async function setMultiRootCache(cache: string[]) {
    multiRoot ||= { declaredWorkspaceRoots: [path.join(fixtureRoot, 'root-a'), path.join(fixtureRoot, 'root-b')],
      suppliedWorkspaceCache: [], workspaceCacheHistory: [] };
    multiRoot.suppliedWorkspaceCache = [...cache];
    multiRoot.workspaceCacheHistory.push([...cache]);
    await receive('workspaceFiles', cache);
  }

  async function unknownSnapshot(caseId: string, composer: string, extra: Record<string, unknown> = {}) {
    const observation = await page.evaluate(() => ({
      posted: (window as any).__posted.filter((message: any) => ['sendMessage', 'sendBrainstormMessage'].includes(message.type)),
      notices: Array.from(document.querySelectorAll('.mysti-toast')).map(element => ({
        text: element.textContent,
        visible: (element as HTMLElement).getBoundingClientRect().width > 0,
      })),
    }));
    const receipt = { caseId, selectedPaths: [], composerBeforeSend: composer, ...observation,
      composerAfterSend: await input().inputValue(), files, errors: [...errors],
      attachmentNames: await page.locator('.attachment-name').allTextContents(),
      contextLabels: await page.locator('.context-item-path').allTextContents(),
      queuedTexts: await page.locator('.queued-chip-text').allTextContents(),
      stopVisible: await page.locator('#stop-btn').isVisible(), ...extra };
    if (process.env.MYSTI_FILE_MENTION_BROWSER_RECEIPTS) {
      appendFileSync(process.env.MYSTI_FILE_MENTION_BROWSER_RECEIPTS, JSON.stringify(receipt) + '\n');
    }
    return receipt;
  }

  async function rejectUnknown(caseId: string, physicalPath?: string, action: 'click' | 'Enter' | 'Tab' = 'click') {
    const composer = await input().inputValue();
    if (action === 'click') await page.locator('#send-btn').click();
    else await input().press(action);
    // Read existing DOM immediately: absent feedback must be a real assertion
    // failure, not an artificial locator timeout that hides the posted payload.
    const receipt = await unknownSnapshot(caseId, composer, { expectedDisposition: 'rejected-unavailable', action,
      physicalPath, physicallyExists: physicalPath ? existsSync(physicalPath) : undefined });
    expect(receipt.posted).toEqual([]);
    expect(receipt.composerAfterSend).toBe(composer);
    expect(receipt.notices.some(notice => notice.visible && /not.*available|unavailable|not.*in.*(?:cache|list)|no longer.*(?:cache|list)|refresh|choos.*file|select.*file|quoted/i.test(notice.text || ''))).toBe(true);
    expect(receipt.notices.map(notice => notice.text).join(' ')).not.toMatch(/does not exist|nonexistent|no such file/i);
    return receipt;
  }

  const draftAttachment = (name: string) => ({ id: name, type: 'file', fileName: name,
    mimeType: 'text/plain', base64Data: Buffer.from('Owned attachment: ' + name).toString('base64') });
  const stageAttachment = (attachment: ReturnType<typeof draftAttachment>) =>
    receive('fileAttachmentSelected', { attachments: [attachment] });
  const manualContext = () => [{ id: 'unknown-manual', type: 'file', path: named.unique,
    content: 'EW04_MANUAL_CONTEXT_PRESERVED', enabled: true }];
  const finish = (id: string) => receive('responseComplete', { message: {
    id, role: 'assistant', provider: 'claude-code', content: 'Controlled completion ' + id,
  } });

  it.skipIf(CHROMIUM_UNAVAILABLE)('refuses an unknown path-shaped reference with a nonempty cache without losing its draft', async () => {
    await receive('workspaceFiles', [named.unique]);
    await input().fill('Review @src/missing.ts please.');
    await rejectUnknown('unknown-nonempty-cache');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('refuses an unknown path-shaped reference omitted from the cache without claiming it does not exist', async () => {
    await receive('workspaceFiles', [named.unique]);
    await input().fill('Review @src/root-two-only.ts please.');
    await rejectUnknown('unknown-cache-omitted-existing', named.rootBUnique);
  });
  for (const token of ['@.a', '@a/', '@src/without-extension', '@missing.ts.', '@foo..bar']) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`refuses the unavailable explicit file shape ${token}`, async () => {
      await input().fill('Review ' + token + ' please.');
      await rejectUnknown('unknown-shape-' + token);
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('requires an explicit quoted path for a cached short dotfile and recovers with that exact file', async () => {
    await receive('workspaceFiles', [named.shortDotfile]);
    await input().fill('Review @.a please.');
    const blocked = await rejectUnknown('unknown-short-cached', named.shortDotfile);
    expect(blocked.notices.map(notice => notice.text).join(' ')).toMatch(/choos|select|quoted/i);
    await input().fill('Review @' + JSON.stringify(named.shortDotfile) + ' please.');
    await send('unknown-short-quoted-recovery', [named.shortDotfile]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves empty-cache Enter draft inputs and sends them exactly after an explicit cache retry', async () => {
    const attachment = draftAttachment('empty-cache.txt'), context = manualContext();
    await receive('workspaceFiles', []);
    await receive('contextUpdated', context); await stageAttachment(attachment);
    const composer = '  Review @src/root-two-only.ts please.  ';
    await input().fill(composer);
    const blocked = await rejectUnknown('unknown-empty-cache-enter', named.rootBUnique, 'Enter');
    expect(blocked.attachmentNames).toEqual([attachment.fileName]);
    expect(blocked.contextLabels).toHaveLength(1);
    expect(blocked.queuedTexts).toEqual([]); expect(blocked.stopVisible).toBe(false);
    await receive('workspaceFiles', [named.rootBUnique]);
    expect(await posted()).toEqual([]); expect(await input().inputValue()).toBe(composer);
    await input().press('Enter');
    const sent = await unknownSnapshot('unknown-empty-cache-recovery', composer, { expectedDisposition: 'sent-after-explicit-retry' });
    expect(sent.posted).toHaveLength(1);
    expect(sent.posted[0].payload).toMatchObject({ content: composer.trim(), context, attachments: [attachment],
      mentions: [{ type: 'file', value: named.rootBUnique }] });
    expect(sent.composerAfterSend).toBe(''); expect(sent.attachmentNames).toEqual([]);
  });
  for (const key of ['Enter', 'Tab'] as const) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`refuses unavailable ${key} enqueue without consuming active-turn draft inputs`, async () => {
      const attachment = draftAttachment('busy-' + key + '.txt'), context = manualContext();
      await receive('contextUpdated', context); await stageAttachment(attachment);
      await receive('responseStarted', { provider: 'claude-code' });
      await input().fill('Keep @src/missing.ts and this draft.');
      const blocked = await rejectUnknown('unknown-busy-' + key, undefined, key);
      expect(blocked.queuedTexts).toEqual([]); expect(blocked.stopVisible).toBe(true);
      expect(blocked.attachmentNames).toEqual([attachment.fileName]); expect(blocked.contextLabels).toHaveLength(1);
      await finish('busy-' + key); expect(await posted()).toEqual([]);
      await input().fill('Recovery keeps owned inputs.'); await page.locator('#send-btn').click();
      const recovered = await unknownSnapshot('unknown-busy-' + key + '-recovery', 'Recovery keeps owned inputs.');
      expect(recovered.posted).toHaveLength(1);
      expect(recovered.posted[0].payload).toMatchObject({ context, attachments: [attachment] });
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('retains an invalidated queue head and later draft inputs until an explicit valid recovery', async () => {
    const queuedAttachment = draftAttachment('queued-reference.txt'), laterAttachment = draftAttachment('later-draft.txt');
    const context = manualContext(), queuedText = 'Queued @src/root-two-only.ts please.', laterDraft = 'Keep the later draft untouched.';
    await receive('contextUpdated', context); await receive('workspaceFiles', [named.rootBUnique]);
    await receive('responseStarted', { provider: 'claude-code' }); await stageAttachment(queuedAttachment);
    await input().fill(queuedText); await input().press('Enter');
    expect(await page.locator('.queued-chip-text').allTextContents()).toEqual([queuedText]);
    await input().fill(laterDraft); await stageAttachment(laterAttachment);
    await receive('workspaceFiles', [named.unique]); await finish('queue-parent');
    const blocked = await unknownSnapshot('unknown-invalidated-queue-head', laterDraft, { expectedDisposition: 'queue-retained-unavailable' });
    expect(blocked.posted).toEqual([]); expect(blocked.composerAfterSend).toBe(laterDraft);
    expect(blocked.queuedTexts).toEqual([queuedText]); expect(blocked.attachmentNames).toEqual([laterAttachment.fileName]);
    expect(blocked.notices.some(notice => notice.visible && /available/i.test(notice.text || ''))).toBe(true);
    await receive('workspaceFiles', [named.rootBUnique]);
    expect(await posted()).toEqual([]); expect(await input().inputValue()).toBe(laterDraft);
    await page.locator('#send-btn').click(); await finish('queue-explicit-recovery');
    const recovered = await unknownSnapshot('unknown-invalidated-queue-recovery', laterDraft);
    expect(recovered.posted).toHaveLength(2);
    expect(recovered.posted[0].payload).toMatchObject({ content: laterDraft, attachments: [laterAttachment], context });
    expect(recovered.posted[1].payload).toMatchObject({ content: queuedText, attachments: [queuedAttachment], context,
      mentions: [{ type: 'file', value: named.rootBUnique }] });
    expect(recovered.queuedTexts).toEqual([]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('refuses unavailable brainstorm references and preserves inputs for a corrected public send', async () => {
    const attachment = draftAttachment('brainstorm.txt'), context = manualContext();
    await receive('contextUpdated', context); await stageAttachment(attachment);
    const row = page.locator('#agent-menu .agent-menu-item[data-agent="brainstorm"]');
    const initiallyDisabled = await row.evaluate(element => element.classList.contains('disabled'));
    // Provider discovery is a normal host event. The initial manifest alone
    // does not make Brainstorm selectable: it requires two available agents.
    await receive('providerAvailability', { providerAvailability: {
      'claude-code': { available: true }, 'openai-codex': { available: true },
    } });
    await page.locator('#agent-select-btn').click();
    const enabledAfterDiscovery = !(await row.evaluate(element => element.classList.contains('disabled')));
    await row.click();
    const providerUpdates = await page.evaluate(() => (window as any).__posted.filter((message: any) =>
      message.type === 'updateSettings' && message.payload?.provider === 'brainstorm'));
    const selectedProvider = await page.locator('#provider-select').inputValue();
    await unknownSnapshot('unknown-brainstorm-selection-precondition', '', {
      initiallyDisabled, enabledAfterDiscovery, selectedProvider, providerUpdates,
    });
    expect(initiallyDisabled).toBe(true); expect(enabledAfterDiscovery).toBe(true);
    expect(selectedProvider).toBe('brainstorm'); expect(providerUpdates).toHaveLength(1);
    await input().fill('Brainstorm @src/missing.ts please.');
    const blocked = await rejectUnknown('unknown-brainstorm');
    expect(blocked.attachmentNames).toEqual([attachment.fileName]); expect(blocked.contextLabels).toHaveLength(1);
    const composer = 'Brainstorm @src/root-two-only.ts please.';
    await input().fill(composer); await page.locator('#send-btn').click();
    const recovered = await unknownSnapshot('unknown-brainstorm-recovery', composer);
    expect(recovered.posted).toHaveLength(1); expect(recovered.posted[0].type).toBe('sendBrainstormMessage');
    expect(recovered.posted[0].payload).toMatchObject({ content: composer, context, attachments: [attachment],
      mentions: [{ type: 'file', value: named.rootBUnique }] });
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps a Stop-held queue paused when an unavailable draft is rejected', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await input().fill('Held valid followup'); await input().press('Enter');
    await page.locator('#stop-btn').click(); await receive('requestCancelled');
    // The baseline already refuses this quoted missing reference, isolating
    // queue-pause ownership from the new bare-unknown classification behavior.
    const composer = 'Reject @' + JSON.stringify(path.join(fixtureRoot, 'missing-stop.ts')) + ' without releasing Stop.';
    await input().fill(composer); await rejectUnknown('unknown-stop-held');
    await finish('late-after-invalid-draft');
    const retained = await unknownSnapshot('unknown-stop-held-late-completion', composer);
    expect(retained.posted).toEqual([]); expect(retained.composerAfterSend).toBe(composer);
    expect(retained.queuedTexts).toEqual(['Held valid followup']);
    await input().fill('Accepted new request'); await page.locator('#send-btn').click(); await finish('accepted-recovery');
    const recovered = await unknownSnapshot('unknown-stop-held-recovery', 'Accepted new request');
    expect(recovered.posted.map((message: any) => message.payload.content)).toEqual(['Accepted new request', 'Held valid followup']);
    expect(recovered.queuedTexts).toEqual([]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves unknown plain words and opaque email code and escaped file-like text', async () => {
    await input().fill('Ask @alice and @alice... with @claude. and @. and @.. or user@missing.ts and 𐐀@missing.ts. ' +
      'Keep \\@missing.ts and `@missing.ts` literal.\n```text\n@src/missing.ts\n```');
    await send('unknown-plain-and-opaque-text', []);
  });

  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps a unique selected file and its offsets', async () => {
    await selectFile(named.unique, 'unique');
    await send('unique', [named.unique]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('sends the selected second package when basenames match', async () => {
    await selectFile(named.b, 'utils');
    await send('duplicate-b', [named.b]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves two independently selected files with the same basename', async () => {
    const first = await selectFile(named.a, 'utils');
    await selectFile(named.b, 'utils', first + 'and ');
    await send('multi-file', [named.a, named.b]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('does not change the selected file after workspace cache reordering', async () => {
    await receive('workspaceFiles', [named.b, named.a]);
    await selectFile(named.b, 'utils');
    await receive('workspaceFiles', [named.a, named.b]);
    await send('cache-reorder', [named.b]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps selected identity and correct offsets after surrounding draft edits', async () => {
    const selected = await selectFile(named.b, 'utils');
    await input().fill('Please review ' + selected + 'then explain.');
    await send('surrounding-edit', [named.b]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('removes deleted selection identity from the outgoing draft', async () => {
    await selectFile(named.b, 'utils');
    await input().fill('No file reference remains.');
    await send('removed-selection', []);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('replaces a selection without retaining its previous file', async () => {
    await selectFile(named.b, 'utils');
    await selectFile(named.unique, 'unique');
    await send('replaced-selection', [named.unique]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves a queued selection across cache changes and a later draft', async () => {
    await receive('responseStarted', { provider: 'claude-code' });
    await receive('workspaceFiles', [named.b, named.a]);
    const composer = await selectFile(named.b, 'utils');
    await input().press('Enter');
    expect(await page.locator('.queued-chip').count()).toBe(1);
    expect(await posted()).toHaveLength(0);
    await input().fill('Keep this later draft unchanged.');
    await receive('workspaceFiles', [named.a, named.b]);
    await receive('responseComplete', { message: { id: 'preceding-answer', role: 'assistant', content: 'Finished.' } });
    await capture('queued-send', [named.b], composer);
    expect(await input().inputValue()).toBe('Keep this later draft unchanged.');
    expect(await page.locator('.queued-chip').count()).toBe(0);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves a selected path containing spaces', async () => {
    await selectFile(named.space, 'retry');
    await send('quoted-space', [named.space]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves a selected Unicode filename', async () => {
    await selectFile(named.unicode, 'ملف');
    await send('unicode', [named.unicode]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves a selected filename containing a literal quote', async () => {
    await selectFile(named.quote, 'quote');
    await send('literal-quote', [named.quote]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('preserves literal double quotes in browser cache metadata without a filesystem read', async () => {
    // Double quotes are valid hostile cache metadata on every host, even where
    // the local filesystem cannot create such a name. Keep that browser
    // boundary separate from the physical fixture used by the test above.
    const cachedPath = path.join(fixtureRoot, 'notes', 'cache"quote.ts');
    await receive('workspaceFiles', [cachedPath]);
    await selectFile(cachedPath, 'cache');
    await send('literal-double-quote-cache-metadata', [cachedPath]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('resolves an explicitly typed qualified relative path', async () => {
    await input().fill('Review @packages/b/utils.ts please.');
    await send('relative-qualified', [named.b]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('does not turn agent names inside the selected filename into agent mentions', async () => {
    await selectFile(named.agentName, 'note.ts');
    await send('embedded-agent-name', [named.agentName]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('refuses an ambiguous typed basename visibly while preserving the draft', async () => {
    await input().fill('Review @utils.ts please.');
    await rejected('typed-ambiguous', /ambiguous|multiple|more than one|choose|specific/i);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('accepts an explicitly typed exact quoted full path', async () => {
    await input().fill('Review @' + JSON.stringify(named.b) + ' please.');
    await send('typed-full-path', [named.b]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('ignores file and agent lookalikes in code and email text', async () => {
    await input().fill('Explain `@utils.ts @claude` and user@utils.ts.\n```text\n@utils.ts @codex\n```');
    await send('code-email', []);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('refuses a selected reference removed from the current cache without losing its draft', async () => {
    await selectFile(named.b, 'utils');
    await receive('workspaceFiles', [named.unique]);
    await rejected('deleted-cache', /not.*available|stale|removed|no longer|missing|not.*found/i);
  });
  for (const [caseId, newline] of [['cr-inline-boundary', '\r'], ['lf-inline-boundary', '\n']]) {
    it.skipIf(CHROMIUM_UNAVAILABLE)(`keeps a following-line file mention after public ${caseId} input`, async () => {
      await input().fill('Explain `unfinished' + newline + '@unique.md please.');
      // Preserve the actual supplied newline. The retained browser receipt
      // distinguishes raw CR from LF instead of assuming normalization.
      expect(await input().inputValue()).toBe('Explain `unfinished' + newline + '@unique.md please.');
      await send(caseId, [named.unique]);
    });
  }
  it.skipIf(CHROMIUM_UNAVAILABLE)('does not read an astral-letter email suffix as a file reference', async () => {
    await input().fill('Contact 𐐀@unique.md for details.');
    await send('astral-email', []);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('does not read an astral-number email suffix as a file reference', async () => {
    await input().fill('Contact 𝟘@unique.md for details.');
    await send('astral-number-email', []);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('still accepts a real file reference after a non-word emoji', async () => {
    await input().fill('Review 🙂@unique.md please.');
    await send('emoji-boundary', [named.unique]);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps a backtick filename opaque while preserving a real following agent', async () => {
    const selected = await selectFile(named.backtick, 'tick');
    await input().fill(selected + '@codex explain this.');
    await send('backtick-following-agent', [named.backtick], ['openai-codex']);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('records stale single-root cache resolution without claiming workspace-wide uniqueness', async () => {
    // Both files exist. The actual browser only knows the supplied A-only cache;
    // the host must independently qualify whether this shorthand is unique.
    await setMultiRootCache([named.rootA]);
    await input().fill('Review @src/util.ts please.');
    await send('multiroot-stale-cache-shorthand', [named.rootA]);
    const payload = (await posted())[0].payload as CapturedPayload;
    const mention = payload.mentions![0];
    expect(payload.content.slice(mention.startIndex, mention.endIndex)).toBe('@src/util.ts');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('refuses a shared relative suffix when both workspace roots are in the cache', async () => {
    await setMultiRootCache([named.rootA, named.rootB]);
    await input().fill('Review @src/util.ts please.');
    await rejected('multiroot-complete-cache-ambiguous', /ambiguous|multiple|more than one|choose|specific/i);
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('emits the absolute second-root path for a unique relative shorthand', async () => {
    await setMultiRootCache([named.rootA, named.rootB, named.rootBUnique]);
    await input().fill('Review @src/root-two-only.ts please.');
    await send('multiroot-unique-second-root', [named.rootBUnique]);
    const payload = (await posted())[0].payload as CapturedPayload;
    const mention = payload.mentions![0];
    expect(payload.content.slice(mention.startIndex, mention.endIndex)).toBe('@src/root-two-only.ts');
  });
  it.skipIf(CHROMIUM_UNAVAILABLE)('keeps an explicit full second-root path when cache root order reverses', async () => {
    await setMultiRootCache([named.rootA, named.rootB]);
    const token = '@' + JSON.stringify(named.rootB);
    await input().fill('Review ' + token + ' please.');
    await setMultiRootCache([named.rootB, named.rootA]);
    await send('multiroot-explicit-second-root', [named.rootB]);
    const payload = (await posted())[0].payload as CapturedPayload;
    const mention = payload.mentions![0];
    expect(payload.content.slice(mention.startIndex, mention.endIndex)).toBe(token);
  });
});
