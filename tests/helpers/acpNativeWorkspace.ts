import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, afterEach } from 'vitest';

/** Public-turn fixtures need a real, private workspace for startup attestation. */
export function useAcpNativeWorkspace(): void {
  let directory: string;
  let original: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-acp-workspace-'));
    const uri = vscode.workspace.workspaceFolders![0].uri;
    original = uri.fsPath;
    Object.defineProperty(uri, 'fsPath', { configurable: true, value: directory });
  });
  afterEach(async () => {
    Object.defineProperty(vscode.workspace.workspaceFolders![0].uri, 'fsPath', { configurable: true, value: original });
    await fs.rm(directory, { recursive: true, force: true });
  });
}
