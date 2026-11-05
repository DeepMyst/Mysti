import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import type { Attachment } from '../../src/types';

const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
const providers = registry.getAll().filter(provider => provider.capabilities.supportsFileAttachments);
let root: string, folders: typeof vscode.workspace.workspaceFolders;
let cleanups: Array<() => Promise<void>>, receipts: unknown[];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileAttachment = (fileName: string, data?: string, filePath?: string): Attachment => ({
  id: 'reused-ui-id', type: 'file', fileName, mimeType: 'text/plain', size: 0,
  ...(data === undefined ? {} : { base64Data: data }), ...(filePath === undefined ? {} : { filePath }),
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-empty-snapshot-')));
  folders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  cleanups = []; receipts = [];
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Snapshot fixture forbids provider requests'); }));
});
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  if (process.env.MYSTI_ATTACHMENT_SNAPSHOT_RECEIPTS) fs.appendFileSync(process.env.MYSTI_ATTACHMENT_SNAPSHOT_RECEIPTS,
    JSON.stringify({ test: expect.getState().currentTestName, receipts }) + '\n');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  (vscode.workspace as any).workspaceFolders = folders;
  fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => registry.dispose());

async function prepare(provider: any, attachments: Attachment[]) {
  const cleanup = await provider.prepareAttachments(attachments, []);
  if (cleanup) cleanups.push(cleanup);
  receipts.push({ provider: provider.id, attachments: attachments.map(attachment => ({
    fileName: attachment.fileName, filePath: attachment.filePath, payloadPresent: typeof attachment.base64Data === 'string',
    exists: !!attachment.filePath && fs.existsSync(attachment.filePath),
    bytes: attachment.filePath && fs.existsSync(attachment.filePath) ? fs.statSync(attachment.filePath).size : null,
  })), hasCleanup: typeof cleanup === 'function' });
  return cleanup;
}

describe('empty attachment snapshots at registered CLI transport boundaries', () => {
  it('covers every currently advertised file-capable provider', () => {
    expect(providers.map(provider => provider.id).sort()).toEqual([
      'claude-code', 'google-gemini', 'hermes', 'kimi-code', 'openai-codex', 'opencode', 'qwen-code',
    ]);
  });
  for (const provider of providers) {
    for (const change of ['modified', 'deleted', 'no source path'] as const) {
      it(`${provider.id}: transports an empty snapshot when the source is ${change}`, async () => {
        const source = path.join(root, 'empty.txt'); fs.writeFileSync(source, '');
        const captured = fs.readFileSync(source).toString('base64');
        expect(captured).toBe('');
        const attachment = fileAttachment('empty.txt', captured, change === 'no source path' ? undefined : source);
        if (change === 'modified') fs.writeFileSync(source, 'Changed after attachment selection');
        if (change === 'deleted') fs.unlinkSync(source);
        const cleanup = await prepare(provider, [attachment]);
        expect(typeof cleanup).toBe('function');
        expect(attachment.filePath).toBeDefined(); expect(attachment.filePath).not.toBe(source);
        const bytes = fs.readFileSync(attachment.filePath!);
        expect(bytes.length).toBe(0); expect(digest(bytes)).toBe(digest(Buffer.alloc(0)));
        vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('');
        const prompt = await (provider as any).buildPromptAsync('Inspect this empty file', [], null, { mode: 'default' }, undefined, undefined, [attachment]);
        receipts.push({ preparedPath: attachment.filePath, bytes: bytes.length, sha256: digest(bytes), prompt });
        // Claude emits a native Read path; the shared renderer JSON-quotes its
        // references, including the backslashes in Windows paths.
        const reference = provider.id === 'claude-code' ? attachment.filePath! : JSON.stringify(attachment.filePath);
        expect(prompt.split(reference)).toHaveLength(2);
        await cleanup!();
        expect(fs.existsSync(attachment.filePath!)).toBe(false);
        if (change === 'modified') expect(fs.readFileSync(source, 'utf8')).toBe('Changed after attachment selection');
        if (change === 'deleted') expect(fs.existsSync(source)).toBe(false);
      });
    }
    it(`${provider.id}: preserves an intentional path-only attachment and never deletes its source`, async () => {
      const source = path.join(root, 'path-only.txt'); fs.writeFileSync(source, 'Path-only content');
      const attachment = fileAttachment('path-only.txt', undefined, source);
      const cleanup = await prepare(provider, [attachment]);
      expect(cleanup).toBeNull(); expect(attachment.filePath).toBe(source);
      expect(fs.readFileSync(source, 'utf8')).toBe('Path-only content');
    });
    it(`${provider.id}: isolates repeated empty snapshots and cleans only temporary files in a mixed batch`, async () => {
      const source = path.join(root, 'path-only.txt'); fs.writeFileSync(source, 'Keep the original');
      const original = fileAttachment('empty.txt', '');
      const nonempty = fileAttachment('binary.bin', Buffer.from([0, 255, 10]).toString('base64'));
      const first = { ...original }, second = { ...original };
      const pathOnly = fileAttachment('path-only.txt', undefined, source);
      const firstCleanup = await prepare(provider, [first, nonempty, pathOnly]);
      const secondCleanup = await prepare(provider, [second]);
      expect(first.filePath).toBeDefined(); expect(second.filePath).toBeDefined();
      expect(first.filePath).not.toBe(second.filePath);
      expect(fs.readFileSync(first.filePath!)).toEqual(Buffer.alloc(0));
      expect(fs.readFileSync(second.filePath!)).toEqual(Buffer.alloc(0));
      expect(fs.readFileSync(nonempty.filePath!)).toEqual(Buffer.from([0, 255, 10]));
      await firstCleanup!();
      expect(fs.existsSync(first.filePath!)).toBe(false); expect(fs.existsSync(nonempty.filePath!)).toBe(false);
      expect(fs.readFileSync(second.filePath!)).toEqual(Buffer.alloc(0));
      expect(fs.readFileSync(source, 'utf8')).toBe('Keep the original');
      await secondCleanup!(); expect(fs.existsSync(second.filePath!)).toBe(false);
      expect(fs.readdirSync(path.join(root, '.mysti', 'tmp'))).toEqual([]);
    });
  }
});
