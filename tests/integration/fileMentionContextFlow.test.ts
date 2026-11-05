import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BaseCliProvider } from '../../src/providers/base/BaseCliProvider';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { ContextItem, Mention, Settings } from '../../src/types';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import { createHarness, installEditorWindowFixture } from '../helpers/autoContextSendHarness';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));
vi.mock('../../src/managers/PlanOptionManager', () => ({ PlanOptionManager: class {
  async classifyResponse() { return { questions: [], planOptions: [], context: '' }; }
  dispose() {}
} }));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  const deny = () => { throw new Error('File mention host fixture forbids subprocesses'); };
  const blocked = { spawn: deny, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
  return { ...actual, ...blocked, default: { ...actual, ...blocked } };
});

const CASES = ['unique', 'duplicate-b', 'multi-file', 'cache-reorder', 'surrounding-edit',
  'removed-selection', 'replaced-selection', 'queued-send', 'quoted-space', 'unicode',
  'literal-quote', 'relative-qualified', 'embedded-agent-name'] as const;
interface FileInput { path: string; content: string }
interface Receipt {
  caseId: string;
  selectedPaths: string[];
  composerBeforeSend: string;
  payload: { content: string; context: ContextItem[]; settings: Settings; mentions?: Mention[] };
  files: FileInput[];
}
interface Capture { panelId: string; providerId: string; content: string; context: ContextItem[]; prompt: string }
const externalReceipts = process.env.MYSTI_FILE_MENTION_BROWSER_RECEIPTS;
let fixtureRoot: string, ownedTemporaryRoot: string | undefined;
let receipts: Map<string, Receipt>;
let h: ReturnType<typeof createHarness>;
let host: any;
let editors: ReturnType<typeof installEditorWindowFixture>;
let workspaceDescriptor: PropertyDescriptor | undefined;
let findFilesDescriptor: PropertyDescriptor | undefined;
let captures: Capture[];
let currentReceipt: Receipt | undefined;
let beforeDelivery: () => Promise<void>;
let releaseWait: (() => void) | undefined;

function standaloneReceipts(): Receipt[] {
  // Ordinary test runs exercise host compatibility without needing out-test
  // artifacts. Qualified picker-to-wire runs REQUIRE actual browser receipts
  // through the environment above; these controls do not claim UI coverage.
  ownedTemporaryRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mysti-ew04-host-')));
  fixtureRoot = ownedTemporaryRoot;
  const names = ['packages/a/utils.ts', 'packages/b/utils.ts', 'unique.ts', 'space dir/with spaces.ts',
    'unicode/مرحبا-雪.ts', 'quotes/say "hello".ts', 'odd/ref @claude and @codex note.ts'];
  const files = names.map((name, index) => ({ path: path.join(fixtureRoot, name), content: `export const fixture_${index} = "HOST_FILE_${index}_EXACT_🧪";\n` }));
  for (const file of files) { mkdirSync(path.dirname(file.path), { recursive: true }); writeFileSync(file.path, file.content); }
  return CASES.map(caseId => {
    const selected = caseId === 'unique' ? [2] : caseId === 'multi-file' ? [0, 1]
      : caseId === 'removed-selection' ? [] : caseId === 'replaced-selection' ? [0]
        : caseId === 'quoted-space' ? [3] : caseId === 'unicode' ? [4]
          : caseId === 'literal-quote' ? [5] : caseId === 'embedded-agent-name' ? [6] : [1];
    const selectedPaths = selected.map(index => files[index].path);
    let content = 'Review these files: ';
    const mentions = selectedPaths.map(value => {
      const token = '@' + JSON.stringify(caseId === 'relative-qualified' ? path.relative(fixtureRoot, value) : value);
      const startIndex = content.length; content += token + ' ';
      return { type: 'file' as const, value: caseId === 'relative-qualified' ? path.relative(fixtureRoot, value) : value,
        displayName: token, startIndex, endIndex: startIndex + token.length };
    });
    return { caseId, files, selectedPaths, composerBeforeSend: content,
      payload: { content, context: [], mentions, settings: { provider: 'claude-code', model: '', mode: 'quick-plan',
        accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings } };
  });
}
beforeAll(() => {
  const rows: Receipt[] = externalReceipts
    ? readFileSync(externalReceipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Receipt)
    : standaloneReceipts();
  if (externalReceipts) {
    fixtureRoot = process.env.MYSTI_FILE_MENTION_FIXTURE_ROOT ?? '';
    expect(path.isAbsolute(fixtureRoot), 'Actual browser replay requires its owned fixture root').toBe(true);
  }
  receipts = new Map(rows.map(row => [row.caseId, row]));
  expect(receipts.size).toBe(rows.length);
  for (const id of CASES) {
    const row = receipts.get(id); expect(row, `Missing actual browser receipt: ${id}`).toBeDefined();
    expect(row!.payload.content).toBeTypeOf('string'); expect(Array.isArray(row!.files)).toBe(true);
    for (const file of row!.files) {
      expect(path.isAbsolute(file.path)).toBe(true);
      expect(path.relative(fixtureRoot, file.path).startsWith('..')).toBe(false);
      expect(readFileSync(file.path, 'utf8')).toBe(file.content);
    }
  }
});
afterAll(() => { if (ownedTemporaryRoot) { rmSync(ownedTemporaryRoot, { recursive: true, force: true }); } });
beforeEach(() => {
  clearMockConfig(); clearConfigurationListeners(); vi.useFakeTimers();
  setMockConfig('autoContext', false); setMockConfig('chat.disableAIFeatures', true);
  setMockConfig('models.autoRefresh', false); setMockConfig('updates.checkCliUpdates', false);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('File mention host fixture forbids network'); }));
  editors = installEditorWindowFixture();
  workspaceDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(fixtureRoot), name: 'owned-mention-fixtures', index: 0 }] });
  findFilesDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'findFiles');
  Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true,
    value: vi.fn(async () => (currentReceipt?.files || []).map(file => vscode.Uri.file(file.path))) });
  h = createHarness(); host = h.provider as any;
  host._panelStates.get('sidebar').currentConversationId = 'file-mention-conversation';
  h.conversationManager.getConversation = () => ({ id: 'file-mention-conversation', messages: [] });
  const builder = Object.assign(Object.create(BaseCliProvider.prototype), { id: 'claude-code', displayName: 'File mention fixture',
    capabilities: { supportsImages: false, supportsFileAttachments: false }, _nativeHistoryDeltas: new WeakSet() });
  const responder = (id: string) => ({ id,
    async *sendMessage(content: string, context: ContextItem[], settings: Settings, conversation: unknown,
      persona: unknown, panelId: string, _manager: unknown, agentConfig: unknown, attachments: unknown,
      resolveInput?: () => { content: string; context: ContextItem[] } | undefined) {
      await beforeDelivery();
      if (resolveInput) { const latest = resolveInput(); if (!latest) { return; } ({ content, context } = latest); }
      const prompt = await builder.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, attachments);
      captures.push({ panelId, providerId: id, content, context: structuredClone(context), prompt });
      yield { type: 'text', content: 'Deterministic file review.' }; yield { type: 'done' };
    },
  });
  const backends = new Map(['claude-code', 'openai-codex'].map(id => [id, responder(id)]));
  const router = Object.assign(Object.create(ProviderManager.prototype), { _registry: { get: (id: string) => backends.get(id) }, _panelProviders: new Map() });
  Object.assign(h.providerManager, {
    sendMessage: ProviderManager.prototype.sendMessage.bind(router),
    sendMessageToProvider: ProviderManager.prototype.sendMessageToProvider.bind(router),
    captureNativeApprovalHandler: () => undefined,
    getAllProviderIds: () => [...backends.keys()], getProviderDefaultModel: () => '',
    getProviderStatus: async () => ({ found: true, authenticated: true, path: '/unused' }),
    disposePersistentProcessForProvider: vi.fn(), suspendRequest: () => false, resumeRequest: () => false,
  });
  vi.spyOn(host._collaborationManager, 'run');
  captures = []; currentReceipt = undefined; beforeDelivery = async () => {}; releaseWait = undefined;
});
afterEach(() => {
  releaseWait?.();
  if (process.env.MYSTI_FILE_MENTION_HOST_RECEIPTS && currentReceipt) {
    appendFileSync(process.env.MYSTI_FILE_MENTION_HOST_RECEIPTS, JSON.stringify({
      test: expect.getState().currentTestName, caseId: currentReceipt.caseId,
      inputSource: externalReceipts ? 'ACTUAL_CHROMIUM_POSTED_PAYLOAD' : 'EXPLICIT_HOST_COMPATIBILITY_CONTROL',
      inputPayload: currentReceipt.payload, selectedPaths: currentReceipt.selectedPaths, captures,
      messages: h.sidebarMessages, userMessages: h.persistedCalls.filter(call => call[1] === 'user'),
      collaboratorDispatches: host._collaborationManager.run.mock.calls.length,
    }) + '\n');
  }
  try { h?.dispose(); } finally {
    if (workspaceDescriptor) Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceDescriptor);
    if (findFilesDescriptor) Object.defineProperty(vscode.workspace, 'findFiles', findFilesDescriptor);
    else Reflect.deleteProperty(vscode.workspace, 'findFiles');
    editors.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    clearMockConfig(); clearConfigurationListeners();
  }
});
async function send(row: Receipt) {
  currentReceipt = row;
  const owner = host._panelStates.get('sidebar');
  await host._receivePanelMessage({ type: 'sendMessage', payload: structuredClone(row.payload) }, 'sidebar', owner.webview);
  expect(h.sidebarMessages.filter(message => message.type === 'error')).toEqual([]);
}
function assertExactFiles(row: Receipt) {
  expect(host._collaborationManager.run).not.toHaveBeenCalled();
  expect(captures).toHaveLength(1); const capture = captures[0];
  expect(capture.panelId).toBe('sidebar'); expect(capture.providerId).toBe(row.payload.settings.provider);
  expect(capture.context.map(item => item.path).sort()).toEqual([...row.selectedPaths].sort());
  for (const file of row.files) {
    if (row.selectedPaths.includes(file.path)) {
      expect(capture.context.find(item => item.path === file.path)?.content).toBe(file.content);
      expect(capture.prompt).toContain(file.path); expect(capture.prompt).toContain(file.content);
    } else { expect(capture.prompt).not.toContain(file.content); }
  }
  expect(h.persistedCalls.filter(call => call[1] === 'user').map(call => call[3])).toEqual([row.payload.context]);
  expect(h.contextManager.getContext('sidebar')).toEqual([]);
  expect(host._runningPanels.has('sidebar')).toBe(false);
}

describe('EW04 file mention identity from composer payload to final provider prompt', () => {
  for (const caseId of CASES) {
    it(`${caseId}: sends exactly the intended file bytes through the real host resolver`, async () => {
      const row = receipts.get(caseId)!; await send(row); assertExactFiles(row);
    });
  }
  it('a file deleted after selection produces visible feedback and never substitutes another file', async () => {
    const row = receipts.get('unique')!; const selected = row.selectedPaths[0];
    expect(selected).toBeTruthy();
    const backup = selected + '.ew04-host-owned-backup';
    // Only this fixture-owned file is moved, then restored before any later
    // case. Qualified replay preserves the exact browser payload and path.
    renameSync(selected, backup);
    try {
      await send(row); expect(captures).toHaveLength(1); expect(captures[0].context).toEqual([]);
      expect(host._collaborationManager.run).not.toHaveBeenCalled();
      const warnings = h.sidebarMessages.filter(message => message.type === 'mentionWarning');
      expect(warnings).toHaveLength(1); expect(warnings[0].payload.message).toContain('Could not read');
      expect(warnings[0].payload.message).toContain(path.basename(selected));
      for (const file of row.files) { expect(captures[0].prompt).not.toContain(file.content); }
    } finally { renameSync(backup, selected); }
  });
  it('navigation during final preparation revokes resolved file bytes before transport', async () => {
    const row = receipts.get('unique')!;
    let announce!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const wait = new Promise<void>(resolve => { releaseWait = resolve; });
    beforeDelivery = () => { announce(); return wait; };
    const pending = send(row);
    try {
      await Promise.race([entered, pending.then(() => { throw new Error('Send ended before final provider preparation'); })]);
      const owner = host._panelStates.get('sidebar');
      await host._receivePanelMessage({ type: 'switchConversation', payload: { id: owner.currentConversationId } }, 'sidebar', owner.webview);
      releaseWait!(); await pending;
      expect(captures).toEqual([]); expect(h.persistedCalls.filter(call => call[1] === 'assistant')).toEqual([]);
      expect(host._runningPanels.has('sidebar')).toBe(false);
      expect(h.sidebarMessages.some(message => message.type === 'requestCancelled')).toBe(true);
    } finally { releaseWait!(); await pending; }
  });
});
