import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as factory from '../helpers/providerFactory';
import type { Settings } from '../../src/types';
import { clearMockConfig } from '../helpers/mockVscode';

const owned: string[] = [], children = new Set<ChildProcess>(), cleanups: Array<() => void> = [];
afterEach(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear(); cleanups.splice(0).forEach(dispose => dispose());
  owned.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })); clearMockConfig(); vi.restoreAllMocks();
});
const settings = (overrides: Partial<Settings> = {}): Settings => ({ provider: 'google-gemini', model: '', mode: 'ask-before-edit',
  accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'manual', ...overrides });

describe('PC-12 notification-only permission transport', () => {
  it.each([
    { mode: 'quick-plan', accessLevel: 'full-access' },
    { mode: 'detailed-plan', accessLevel: 'ask-permission' },
    { mode: 'default', accessLevel: 'read-only' },
  ] as const)('Cursor explicitly selects its documented read-only mode for $mode/$accessLevel', overrides => {
    const provider = new factory.TestableCursorProvider(); cleanups.push(() => provider.dispose());
    const args = provider.buildCliArgs(settings(overrides), (provider as any)._getSession('panel'));
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    expect(args).not.toContain('--force');
  });
  it('Gemini Ask cannot change the owned canary before a delayed consumer can deny the tool notification', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc12-notification-')); owned.push(directory);
    const canary = path.join(directory, 'canary.txt'), receipt = path.join(directory, 'receipt.json');
    const provider = new factory.TestableGeminiProvider(); cleanups.push(() => provider.dispose());
    const session = (provider as any)._getSession('owned-panel');
    let args: string[];
    try { args = provider.buildCliArgs(settings(), session); }
    catch (error) {
      expect(String(error)).toMatch(/cannot.*approval|native approval/i);
      expect(fs.existsSync(canary)).toBe(false);
      return;
    }
    const child = spawn(process.execPath, [path.resolve('tests/fixtures/notificationPermissionCli.cjs'), canary, receipt, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.add(child);
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stdout!.pause();
    // Delayed pipe consumption is valid on an overloaded extension host. The
    // backend receives no approval response while continuing its own event loop.
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(receipt) && Date.now() < deadline) await delay(10);
    expect(fs.existsSync(receipt)).toBe(true);
    let parsed = false;
    child.stdout!.on('data', data => {
      parsed ||= provider.parseStreamLine(String(data).trim(), session)?.type === 'tool_use';
      child.kill('SIGKILL'); // earliest observed deny cannot roll back an earlier write
    });
    child.stdout!.resume(); await closed;
    expect(parsed).toBe(true);
    expect(fs.existsSync(canary), 'Ask must hold execution before an approval, not merely pause after a notification').toBe(false);
  });

  for (const Provider of [factory.TestableGeminiProvider, factory.TestableClineProvider, factory.TestableCursorProvider,
    factory.TestableQwenProvider, factory.TestableOpenCodeProvider, factory.TestableCopilotProvider]) {
    it.skipIf(process.platform === 'win32')(`${Provider.name} public sendMessage rejects Ask before an executable can run or Cline rules can change`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pc12-send-')); owned.push(directory);
      const canary = path.join(directory, 'canary.txt'), receipt = path.join(directory, 'invoked.json');
      const rules = path.join(directory, '.clinerules'), executable = path.join(directory, 'owned CLI.cjs');
      const rulesBytes = Buffer.from('User-owned rules\r\nPreserve exact bytes.\n');
      fs.writeFileSync(rules, rulesBytes);
      // This exact executable is positively checked first: if any adapter
      // reaches spawn, it records invocation and changes only this owned file.
      fs.writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(receipt)}, 'invoked');\nfs.writeFileSync(${JSON.stringify(canary)}, 'unexpected backend execution');\n`, { mode: 0o700 });
      const child = spawn(executable, [], { cwd: directory, stdio: 'ignore' }); children.add(child);
      const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      expect(code).toBe(0); expect(fs.existsSync(receipt)).toBe(true); expect(fs.existsSync(canary)).toBe(true);
      fs.rmSync(receipt); fs.rmSync(canary);
      const originalStat = fs.statSync(rules, { bigint: true });
      const previousFolders = vscode.workspace.workspaceFolders;
      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
      cleanups.push(() => { (vscode.workspace as any).workspaceFolders = previousFolders; });
      const provider = new Provider(); cleanups.push(() => provider.dispose());
      vi.spyOn(provider as any, 'getCliPath').mockReturnValue(executable);
      vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
      vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Use the owned fixture only.');
      vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('Temporary agent instructions must never replace these rules.');
      const errors: string[] = [];
      try {
        for await (const chunk of provider.sendMessage('Review this owned file and ask before editing.', [], settings({ provider: provider.id }), null, undefined, 'owned-panel')) {
          if (chunk.type === 'error') errors.push(chunk.content ?? '');
        }
      } catch (error) { errors.push(String(error)); }
      expect(errors.join('\n')).toMatch(/cannot.*approval|native approval/i);
      expect(errors.join('\n')).toMatch(/Read Only|plan mode/);
      expect(fs.existsSync(receipt)).toBe(false);
      expect(fs.existsSync(canary)).toBe(false);
      expect(fs.readFileSync(rules)).toEqual(rulesBytes);
      expect(fs.statSync(rules, { bigint: true }).mtimeNs).toBe(originalStat.mtimeNs);
    });
    it.each([
      { mode: 'ask-before-edit', accessLevel: 'ask-permission' },
      { mode: 'ask-before-edit', accessLevel: 'full-access' },
      { mode: 'default', accessLevel: 'ask-permission' },
      { mode: 'edit-automatically', accessLevel: 'ask-permission' },
    ] as const)(`${Provider.name} rejects unsupported mode=$mode access=$accessLevel before dispatch`, overrides => {
      const provider = new Provider(); cleanups.push(() => provider.dispose());
      expect(() => provider.buildCliArgs(settings(overrides), (provider as any)._getSession('panel'))).toThrow(/native approval|cannot.*approval/i);
    });
    it(`${Provider.name} enforces its supported read-only and unrestricted choices`, () => {
      const provider = new Provider(); cleanups.push(() => provider.dispose());
      const modernCline = Provider === factory.TestableClineProvider;
      if (modernCline) (provider as any)._cachedCliVersion = '3.0.61';
      for (const overrides of [
        { mode: 'quick-plan', accessLevel: 'ask-permission' }, { mode: 'detailed-plan', accessLevel: 'full-access' },
        { mode: 'ask-before-edit', accessLevel: 'read-only' },
      ] as const) {
        const build = () => provider.buildCliArgs(settings(overrides), (provider as any)._getSession('panel'));
        if (modernCline) expect(build).toThrow(/Cline 3\.0\.61 cannot use Plan or Read Only safely/);
        else if (Provider === factory.TestableOpenCodeProvider) expect(build).toThrow(/OpenCode CLI cannot enforce.*native approvals/);
        else if (Provider === factory.TestableQwenProvider) expect(build).toThrow(/Qwen Code CLI cannot enforce Plan, Read Only/);
        else expect(build).not.toThrow();
      }
      for (const mode of ['edit-automatically', 'default'] as const) {
        const args = provider.buildCliArgs(settings({ mode, accessLevel: 'full-access' }), (provider as any)._getSession('panel'));
        if (modernCline) {
          expect(args).toContain('--auto-approve');
          expect(args[args.indexOf('--auto-approve') + 1]).toBe('true');
          expect(args).not.toContain('--plan');
        }
      }
    });
  }
});
