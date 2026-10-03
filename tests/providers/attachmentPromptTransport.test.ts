import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
const registry = new ProviderRegistry({ subscriptions: [], globalState: { get: () => undefined }, secrets: {} } as any);
afterAll(() => registry.dispose());
describe('attachment transport reaches actual CLI prompts', () => {
  for (const provider of registry.getAll().filter(p => p.capabilities.supportsImages || p.capabilities.supportsFileAttachments)) {
    it(`${provider.id}: writes bytes, references both attachment types and cleans up`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-attachment-transport-'));
      const p = provider as any;
      const folders = vscode.workspace.workspaceFolders;
      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(dir) }];
      const guidance = vi.spyOn(p, 'buildAgentInstructionsAsync').mockResolvedValue('Review carefully.');
      try {
        const attachments = [
          { id: 'image', type: 'image', fileName: 'sample.png', mimeType: 'image/png', base64Data: Buffer.from('image fixture bytes').toString('base64') },
          { id: 'file', type: 'file', fileName: 'notes.txt', base64Data: Buffer.from('File fixture contents').toString('base64') },
        ];
        const cleanup = await p.prepareAttachments(attachments, []);
        const prompt = await p.buildPromptAsync('Review the attachments', [], null, { mode: 'default' }, undefined, undefined, attachments);
        expect(prompt).toContain('Review carefully.');
        for (const attachment of attachments as any[]) {
          expect(fs.readFileSync(attachment.filePath).toString('base64')).toBe(attachment.base64Data);
          const transportedPath = prompt.includes(attachment.filePath) ? attachment.filePath : JSON.stringify(attachment.filePath).slice(1, -1);
          expect(prompt).toContain(transportedPath);
          expect(prompt.split(transportedPath)).toHaveLength(2);
        }
        const repeat = attachments.map(a => ({ ...a }));
        const repeatCleanup = await p.prepareAttachments(repeat, []);
        for (let i = 0; i < repeat.length; i++) expect((repeat[i] as any).filePath).not.toBe((attachments[i] as any).filePath);
        await cleanup();
        for (const attachment of repeat as any[]) expect(fs.existsSync(attachment.filePath)).toBe(true);
        await repeatCleanup();
        for (const attachment of attachments as any[]) expect(fs.existsSync(attachment.filePath)).toBe(false);
      } finally { (vscode.workspace as any).workspaceFolders = folders; guidance.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
