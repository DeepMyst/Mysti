/** PC-03: real CLI rejection alongside an account-backed sibling, then recovery.
 * The VS Code API is mocked; routing, transports and inference are real.
 * The disposable Codex wrapper uses a process-only credential store for failure.
 * No account is logged out, revoked, copied or rotated by this fixture.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { expect, it, vi } from 'vitest';
import { ProviderManager } from '../src/managers/ProviderManager';
import { CollaborationManager } from '../src/managers/CollaborationManager';
import { CollaboratorPool } from '../src/services/CollaboratorPool';
import { planExplicitMentions, resolveExplicitMentions } from '../src/services/ExplicitMentionPlan';
import { runExplicitMentions } from '../src/managers/ExplicitMentionRunner';
import { clearMockConfig, createMockMemento, createMockSecretStorage, setMockConfig } from '../tests/helpers/mockVscode';
import type { Conversation, Settings } from '../src/types';

it('PC-03 preserves a real Claude answer when Codex rejects authentication, then Codex continues the original task', async () => {
  const executable = process.env.MYSTI_PC03_CODEX_PATH;
  expect(executable, 'Point MYSTI_PC03_CODEX_PATH at the verified disposable Codex installation').toBeTruthy();
  const reportDir = path.resolve(process.env.MYSTI_PC03_LIVE_ARTIFACTS || 'out-test/feature-tests/PC-03/live');
  fs.mkdirSync(reportDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(reportDir, 'workspace-'));
  const fixtureFactory = require('../scripts/validation/auth-cli-fixture.cjs') as {
    createAuthCliFixture(directory: string, executable: string, nodePath: string): { path: string; setSignedOut(value: boolean): void };
  };
  const fixture = fixtureFactory.createAuthCliFixture(directory, executable!, process.execPath);
  fixture.setSignedOut(true);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), scope: 'Real CLI transport/inference with mocked VS Code API; process-only signed-out Codex; existing Claude and Codex accounts for successful turns.', events: [] };
  const previousFolders = vscode.workspace.workspaceFolders;
  const previousTrust = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted');
  let providers: ProviderManager | undefined;
  let collaboration: CollaborationManager | undefined;
  const context = { subscriptions: [], globalState: createMockMemento(), workspaceState: createMockMemento(),
    secrets: createMockSecretStorage(), extensionPath: path.resolve('.'), extensionUri: vscode.Uri.file(path.resolve('.')),
    globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')), storageUri: vscode.Uri.file(path.join(directory, 'storage')), extensionMode: 3,
  } as unknown as vscode.ExtensionContext;
  try {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(directory), name: 'pc03-auth', index: 0 }] });
    Object.defineProperty(vscode.workspace, 'isTrusted', { configurable: true, value: true });
    setMockConfig('codexPath', fixture.path);
    setMockConfig('codexModel', 'gpt-5.6-sol');
    setMockConfig('claudeCodePath', process.env.MYSTI_LIVE_CLAUDE || path.join(os.homedir(), '.local/bin/claude'));
    setMockConfig('claudeCodeModel', 'sonnet');
    providers = new ProviderManager(context);
    const codex = providers.getProviderInstance('openai-codex') as any;
    const parseCodex = codex.parseStreamLine.bind(codex);
    const protocolErrors: Array<Record<string, unknown>> = [];
    report.protocolErrors = protocolErrors;
    vi.spyOn(codex, 'parseStreamLine').mockImplementation((line: string, session: unknown) => {
      try {
        const data = JSON.parse(line);
        if (data.method === 'error') {
          const message = String(data.params?.error?.message || '');
          protocolErrors.push({ method: 'error', willRetry: data.params?.willRetry,
            message: /^Reconnecting\.\.\. \d+\/\d+$/.test(message) ? message
              : /unauthorized|401|authentication|not logged in|missing.*bearer/i.test(message) ? '[authentication failure]' : '[other error]',
            at: new Date().toISOString() });
        }
      } catch { /* Observe only known protocol metadata; transport is unchanged. */ }
      return parseCodex(line, session);
    });
    const hooks = path.join(directory, 'claude-settings.json');
    fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }));
    const claude = providers.getProviderInstance('claude-code') as any;
    const build = claude.buildPersistentCliArgs.bind(claude);
    vi.spyOn(claude, 'buildPersistentCliArgs').mockImplementation((...args: unknown[]) => [...build(...args), '--settings', hooks]);
    collaboration = new CollaborationManager(new CollaboratorPool(providers), { buildRoleContext: async () => null } as any);
    const send = vi.spyOn(providers, 'sendMessageToProvider');
    const settings: Settings = { provider: 'claude-code', model: 'sonnet', mode: 'ask-before-edit', accessLevel: 'ask-permission', thinkingLevel: 'none', effortLevel: 'low', contextMode: 'manual' };
    const conversation: Conversation = { id: 'pc03-original-task', title: 'PC-03 retry review', messages: [], createdAt: Date.now(), updatedAt: Date.now(), mode: settings.mode, provider: settings.provider, model: settings.model };
    const turn = async (content: string) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; collaboration!.cancelPanel('pc03'); }, 150_000);
      try {
        const answer = await runExplicitMentions(collaboration!, planExplicitMentions(content, resolveExplicitMentions(content)), {
          settings, context: [], panelId: 'pc03', conversation, isCancelled: () => timedOut,
          onGate: async () => { throw new Error('This inline review must not request tools'); },
        }, event => events.push(event));
        expect(timedOut).toBe(false);
        conversation.messages.push({ id: `user-${conversation.messages.length}`, role: 'user', content, timestamp: Date.now() },
          { id: `assistant-${conversation.messages.length}`, role: 'assistant', content: answer, timestamp: Date.now() });
        return answer;
      } finally { clearTimeout(timer); }
    };
    const first = await turn('@codex @claude Review this inline task without tools: retryDelay(attempt, base=73, cap=500) returns Math.min(cap, base * 2 ** attempt). What is the result at attempt 1? Reply exactly PC03_VALUE:146. Do not read files or run commands.');
    const completed = events.filter(event => event.payload.type === 'collab_complete');
    expect(completed).toHaveLength(2);
    expect(completed.find(event => event.payload.agentId === 'openai-codex')?.payload).toMatchObject({ hasError: true, failure: 'not-authenticated' });
    expect(completed.find(event => event.payload.agentId === 'claude-code')?.payload).toMatchObject({ hasError: false, responseText: expect.stringContaining('PC03_VALUE:146') });
    expect(events.filter(event => event.payload.type === 'collab_retry')).toHaveLength(0);
    expect(send.mock.calls.map(call => call[0]).sort()).toEqual(['claude-code', 'openai-codex']);
    expect(first).toContain('PC03_VALUE:146');
    expect(first).toContain('No opinion was substituted');
    report.firstTurn = { answer: first, completed: completed.map(event => event.payload), calls: send.mock.calls.length };

    // Restore the wrapper to the existing account. This is NOT an actual login
    // or credential-rotation claim; the next real request proves recovery.
    fixture.setSignedOut(false);
    events.length = 0;
    const recovered = await turn('@codex Continue the original inline retryDelay review. Use the exact base and cap from the previous user message: what is the result at attempt 2? Reply exactly PC03_RECOVERED:<number>. Do not use tools or read files.');
    expect(recovered).toContain('PC03_RECOVERED:292');
    expect(events.filter(event => event.payload.type === 'collab_complete')).toHaveLength(1);
    expect(events.find(event => event.payload.type === 'collab_complete')?.payload).toMatchObject({ agentId: 'openai-codex', hasError: false });
    expect(send.mock.calls.map(call => call[0])).toHaveLength(3);
    report.recovery = { answer: recovered, totalCalls: send.mock.calls.length, conversationId: conversation.id };
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    collaboration?.cancelPanel('pc03'); providers?.dispose();
    context.subscriptions.forEach(disposable => disposable.dispose());
    vi.restoreAllMocks(); clearMockConfig();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: previousFolders });
    if (previousTrust) { Object.defineProperty(vscode.workspace, 'isTrusted', previousTrust); }
    else { delete (vscode.workspace as { isTrusted?: boolean }).isTrusted; }
    report.finishedAt = new Date().toISOString();
    // Events contain synthetic prompts/results and typed failures only. No
    // account labels, credentials or process environment are inspected here.
    report.events = events;
    fs.writeFileSync(path.join(reportDir, 'observations.json'), JSON.stringify(report, null, 2) + '\n');
  }
}, 330_000);
