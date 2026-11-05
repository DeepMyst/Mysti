/** PC-04 opt-in live settings receipts. Real CLIs/accounts; mocked VS Code API. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { expect, it, vi } from 'vitest';
import { ProviderManager } from '../src/managers/ProviderManager';
import { clearConfigurationListeners, clearMockConfig, createMockMemento, createMockSecretStorage, setMockConfig } from '../tests/helpers/mockVscode';
import type { Conversation, Settings, StreamChunk } from '../src/types';

type Receipt = { method: string; model?: string; effort?: string; profile?: string };

it('PC-04 forwards selected Codex and Claude effort/model settings and continues each original task after effort changes', async () => {
  const executable = process.env.MYSTI_PC04_CODEX_PATH;
  expect(executable, 'MYSTI_PC04_CODEX_PATH must select the verified disposable installation').toBeTruthy();
  const reportDir = path.resolve(process.env.MYSTI_PC04_LIVE_ARTIFACTS || 'out-test/feature-tests/PC-04/live');
  fs.mkdirSync(reportDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(reportDir, 'workspace-'));
  const fixtureFactory = require('../scripts/validation/settings-cli-fixture.cjs') as {
    createSettingsCliFixture(directory: string, executable: string, nodePath: string): { path: string; receiptsPath: string };
  };
  const fixture = fixtureFactory.createSettingsCliFixture(directory, executable!, process.execPath);
  const hooks = path.join(directory, 'claude-settings.json');
  fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }));
  const claudePath = process.env.MYSTI_LIVE_CLAUDE || path.join(os.homedir(), '.local/bin/claude');
  const previousFolders = vscode.workspace.workspaceFolders;
  const previousTrust = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted');
  const context = { subscriptions: [], globalState: createMockMemento(), workspaceState: createMockMemento(),
    secrets: createMockSecretStorage(), extensionPath: path.resolve('.'), extensionUri: vscode.Uri.file(path.resolve('.')),
    globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')), storageUri: vscode.Uri.file(path.join(directory, 'storage')), extensionMode: 3,
  } as unknown as vscode.ExtensionContext;
  const report: Record<string, any> = { startedAt: new Date().toISOString(),
    scope: 'Four real CLI requests with existing accounts and mocked VS Code API. Settings receipts are observed without rewriting requests. No tools, account/profile mutations, or native editor claims.',
    platform: { os: process.platform, arch: process.arch, node: process.version }, turns: [], claudeLaunches: [], providerResponses: [],
  };
  let manager: ProviderManager | undefined;
  const roots = new Set<ChildProcess>();
  const ownedPids = new Set<number>();
  const scanOwned = () => {
    // Inspect only ancestry: never persist process arguments/environment.
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number));
    roots.forEach(proc => { if (proc.pid) { ownedPids.add(proc.pid); } });
    let added = true;
    while (added) {
      added = false;
      for (const [pid, ppid] of rows) {
        if (ownedPids.has(ppid) && !ownedPids.has(pid)) { ownedPids.add(pid); added = true; }
      }
    }
    return rows.filter(([pid]) => ownedPids.has(pid)).map(([pid]) => pid);
  };
  const captureProcess = (session: any) => {
    const proc: ChildProcess | undefined = session.persistentProcess || session.process;
    if (proc && !roots.has(proc)) { roots.add(proc); scanOwned(); }
  };
  const receipts = (): Receipt[] => fs.existsSync(fixture.receiptsPath)
    ? fs.readFileSync(fixture.receiptsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    report.cliVersions = {
      codex: execFileSync(executable!, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
      claude: execFileSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
    };
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(directory), name: 'pc04-settings', index: 0 }] });
    Object.defineProperty(vscode.workspace, 'isTrusted', { configurable: true, value: true });
    setMockConfig('codexPath', fixture.path); setMockConfig('claudeCodePath', claudePath);
    setMockConfig('codexModel', ''); setMockConfig('claudeCodeModel', '');
    manager = new ProviderManager(context);
    const approvals = vi.fn(async () => false);
    context.subscriptions.push(manager.setNativeApprovalHandler(approvals));
    const claude = manager.getProviderInstance('claude-code') as any;
    const build = claude.buildPersistentCliArgs.bind(claude);
    vi.spyOn(claude, 'buildPersistentCliArgs').mockImplementation((...args: unknown[]) => {
      const built: string[] = build(...args);
      const flag = (name: string) => built.includes(name) ? built[built.indexOf(name) + 1] : undefined;
      report.claudeLaunches.push({ model: flag('--model'), effort: flag('--effort'), resumed: built.includes('--resume') });
      // Fixture-only: prevent personal account hooks from executing during this inline review.
      return [...built, '--settings', hooks];
    });
    for (const id of ['openai-codex', 'claude-code']) {
      const provider = manager.getProviderInstance(id) as any;
      const parse = provider.parseStreamLine.bind(provider);
      vi.spyOn(provider, 'parseStreamLine').mockImplementation((line: string, session: any) => {
        captureProcess(session);
        try {
          const data = JSON.parse(line);
          if (id === 'claude-code' && data.type === 'system' && data.subtype === 'init' && typeof data.model === 'string') {
            report.providerResponses.push({ provider: id, event: 'system.init', model: data.model });
          }
          if (id === 'openai-codex' && data.result && typeof data.result.model === 'string') {
            const method = session.appServer?.requests.get(data.id);
            if (method === 'thread/start' || method === 'thread/resume') {
              report.providerResponses.push({ provider: id, event: method, model: data.result.model,
                ...(typeof data.result.reasoningEffort === 'string' ? { effort: data.result.reasoningEffort } : {}) });
            }
          }
        } catch { /* Only observe recognized non-secret response fields. */ }
        return parse(line, session);
      });
    }

    for (const [id, model, base] of [['openai-codex', 'gpt-5.6-sol', 73], ['claude-code', 'sonnet', 67]] as const) {
      const provider = manager.getProviderInstance(id)!;
      const panel = `pc04-${id}`;
      const settings: Settings = { provider: id, model, mode: 'ask-before-edit', accessLevel: 'ask-permission',
        thinkingLevel: 'none', effortLevel: 'low', contextMode: 'manual' };
      const conversation: Conversation = { id: panel, title: 'PC04 inline retry review', messages: [], createdAt: Date.now(),
        updatedAt: Date.now(), mode: settings.mode, provider: id, model };
      let originalSession: string | null = null;
      for (const [attempt, effort] of [[1, 'low'], [2, 'high']] as const) {
        const prompt = attempt === 1
          ? `Use only this inline JavaScript; do not use tools, files, commands, or make changes. function retryDelay(attempt, base=${base}, cap=500) { return Math.min(cap, base * 2 ** attempt); } What is retryDelay(1)? Reply exactly PC04_VALUE:${base * 2}. Remember the base and cap for the follow-up.`
          : 'Continue the original inline retryDelay review using its exact base and cap. What is retryDelay(2)? Do not use tools, files, commands, or make changes. Reply exactly PC04_CONTINUED:<number>.';
        const beforeReceipts = receipts().length;
        const start = Date.now(); const chunks: StreamChunk[] = [];
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; manager!.cancelRequest(panel); }, 120_000);
        try {
          for await (const chunk of manager.sendMessageToProvider(id, prompt, [], { ...settings, effortLevel: effort }, conversation, undefined, panel)) { chunks.push(chunk); }
        } finally { clearTimeout(timeout); }
        const answer = chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content || '').join('');
        const row: Record<string, unknown> = { provider: id, requested: { model, effort }, prompt, answer,
          durationMs: Date.now() - start, doneCount: chunks.filter(chunk => chunk.type === 'done').length,
          errorTypes: chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error').map(chunk => chunk.type),
          toolCount: chunks.filter(chunk => chunk.type === 'tool_use').length,
          wireReceipts: id === 'openai-codex' ? receipts().slice(beforeReceipts) : undefined,
        };
        report.turns.push(row); scanOwned();
        expect(timedOut).toBe(false); expect(row.errorTypes).toEqual([]); expect(row.doneCount).toBe(1); expect(row.toolCount).toBe(0);
        expect(answer.trim()).toBe(attempt === 1 ? `PC04_VALUE:${base * 2}` : `PC04_CONTINUED:${base * 4}`);
        if (id === 'openai-codex') {
          const observed = row.wireReceipts as Receipt[];
          expect(observed.filter(item => item.method === 'turn/start')).toEqual([{ method: 'turn/start', effort }]);
          expect(observed.find(item => item.method === (attempt === 1 ? 'thread/start' : 'thread/resume'))).toMatchObject({ model, effort });
        } else {
          expect(report.claudeLaunches.at(-1)).toMatchObject({ model, effort, resumed: attempt === 2 });
        }
        const session = provider.getSessionId(panel);
        expect(session).toBeTruthy();
        if (attempt === 1) { originalSession = session; }
        else { expect(session).toBe(originalSession); row.originalSessionRetained = true; }
        conversation.messages.push({ id: `user-${attempt}`, role: 'user', content: prompt, timestamp: Date.now() },
          { id: `assistant-${attempt}`, role: 'assistant', content: answer, provider: id, model, timestamp: Date.now() });
        console.log('[PC-04]', JSON.stringify({ event: 'turn-complete', provider: id, requested: { model, effort }, answer, durationMs: row.durationMs }));
      }
    }
    expect(approvals).not.toHaveBeenCalled();
    expect(report.turns).toHaveLength(4); report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    scanOwned();
    const cleanupStarted = Date.now(); manager?.dispose(); context.subscriptions.forEach(item => item.dispose());
    let remaining = scanOwned();
    while (remaining.length && Date.now() - cleanupStarted < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 100)); remaining = scanOwned();
    }
    report.cleanup = { ownedProcessCount: ownedPids.size, remainingOwnedPids: remaining, durationMs: Date.now() - cleanupStarted };
    if (remaining.length) {
      report.status = 'FAIL'; report.cleanupFailure = 'Owned fixture processes remained after the cleanup deadline.';
    }
    report.finishedAt = new Date().toISOString(); report.codexReceipts = receipts();
    fs.writeFileSync(path.join(reportDir, 'observations.json'), JSON.stringify(report, null, 2) + '\n');
    vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: previousFolders });
    if (previousTrust) { Object.defineProperty(vscode.workspace, 'isTrusted', previousTrust); }
    else { delete (vscode.workspace as { isTrusted?: boolean }).isTrusted; }
    expect(remaining, 'Owned live fixture processes must settle after provider disposal').toEqual([]);
  }
}, 500_000);
