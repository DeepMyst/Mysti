/** PC-05 opt-in account-backed review: real managers/CLIs, mocked VS Code API. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { expect, it, vi } from 'vitest';
import { ProviderManager } from '../src/managers/ProviderManager';
import { CollaborationManager } from '../src/managers/CollaborationManager';
import type { AgentContextManager } from '../src/managers/AgentContextManager';
import { runExplicitMentions } from '../src/managers/ExplicitMentionRunner';
import { CollaboratorPool } from '../src/services/CollaboratorPool';
import { planExplicitMentions, resolveExplicitMentions } from '../src/services/ExplicitMentionPlan';
import { getProviderDisplayName } from '../src/providers/base/ProviderManifest';
import { clearConfigurationListeners, clearMockConfig, createMockMemento, createMockSecretStorage, setMockConfig } from '../tests/helpers/mockVscode';
import type { Conversation, Settings, StreamChunk } from '../src/types';

type Event = { type: string; payload: Record<string, any>; sequence: number };
type ObservedRequest = {
  provider: string; model: string; panel: string | undefined; conversationId: string | undefined;
  startedAt: number; durationMs?: number; returned: boolean;
  chunks: Array<{ type: StreamChunk['type']; content?: string; sequence: number }>;
};

const source = 'export function retryDelay(attempt, baseMs = 73, capMs = 500) {\n  return Math.min(capMs, baseMs * attempt);\n}\n';
const reviewFormat = [
  'Use only the inline source and conversation; no tools, shell commands, file reads, or file changes.',
  'Give a concise review with all four formats: a Markdown table with attempt, actual, expected columns for attempts 0, 1, and 4;',
  'a fenced javascript block containing the corrected function; a fenced diff with the smallest proposed change;',
  'and a fenced mermaid flowchart of the corrected calculation. Include the literal Unicode phrase "Retry → cap ✅" exactly once.',
  'Do not repeat or quote your final marker elsewhere. Keep the whole answer below 400 words.',
].join(' ');

it('PC-05 preserves attributed rich reviews, ordered streamed text, and a real follow-up across Codex and Claude', async () => {
  const codexPath = process.env.MYSTI_PC05_CODEX_PATH;
  expect(codexPath, 'MYSTI_PC05_CODEX_PATH must select the verified disposable Codex installation').toBeTruthy();
  const claudePath = process.env.MYSTI_LIVE_CLAUDE || path.join(os.homedir(), '.local/bin/claude');
  const reportDir = path.resolve(process.env.MYSTI_PC05_LIVE_ARTIFACTS || 'out-test/feature-tests/PC-05/live');
  fs.mkdirSync(reportDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(reportDir, 'workspace-'));
  const fixtureFile = path.join(directory, 'retry.js');
  fs.writeFileSync(fixtureFile, source);
  const hooks = path.join(directory, 'claude-settings.json');
  fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }));
  const previousFolders = vscode.workspace.workspaceFolders;
  const previousTrust = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted');
  const context = { subscriptions: [], globalState: createMockMemento(), workspaceState: createMockMemento(),
    secrets: createMockSecretStorage(), extensionPath: path.resolve('.'), extensionUri: vscode.Uri.file(path.resolve('.')),
    globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')), storageUri: vscode.Uri.file(path.join(directory, 'storage')), extensionMode: 3,
  } as unknown as vscode.ExtensionContext;
  const report: Record<string, any> = { startedAt: new Date().toISOString(), status: 'RUNNING',
    scope: 'Three real CLI requests through ExplicitMentionRunner, CollaborationManager, CollaboratorPool and ProviderManager. VS Code API is mocked; this checks transport and rich Markdown source, not browser rendering or message actions. Existing logins; no account/profile changes or tools.',
    platform: { os: process.platform, arch: process.arch, node: process.version }, requests: [] as ObservedRequest[],
    turns: [], providerResponses: [], claudeLaunches: [],
  };
  const requests = report.requests as ObservedRequest[];
  let manager: ProviderManager | undefined;
  let collaboration: CollaborationManager | undefined;
  const panel = 'pc05-inline-code-review';
  const roots = new Set<ChildProcess>();
  const ownedPids = new Set<number>();
  let sequence = 0;
  const scanOwned = () => {
    // Ancestry only: never persist process arguments, credentials or environment.
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
  try {
    report.cliVersions = {
      codex: execFileSync(codexPath!, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
      claude: execFileSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
    };
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(directory), name: 'pc05-review', index: 0 }] });
    Object.defineProperty(vscode.workspace, 'isTrusted', { configurable: true, value: true });
    setMockConfig('codexPath', codexPath); setMockConfig('claudeCodePath', claudePath);
    setMockConfig('codexModel', 'gpt-5.6-sol'); setMockConfig('claudeCodeModel', 'sonnet');
    manager = new ProviderManager(context);
    const nativeApproval = vi.fn(async () => false);
    const collaborationApproval = vi.fn(async () => false);
    context.subscriptions.push(manager.setNativeApprovalHandler(nativeApproval));
    collaboration = new CollaborationManager(new CollaboratorPool(manager), {
      buildRoleContext: async () => null,
    } as unknown as AgentContextManager);
    const claude = manager.getProviderInstance('claude-code') as any;
    const build = claude.buildPersistentCliArgs.bind(claude);
    vi.spyOn(claude, 'buildPersistentCliArgs').mockImplementation((...args: unknown[]) => {
      const built: string[] = build(...args);
      report.claudeLaunches.push({ model: built[built.indexOf('--model') + 1], effort: built[built.indexOf('--effort') + 1] });
      return [...built, '--settings', hooks];
    });
    for (const id of ['openai-codex', 'claude-code']) {
      const provider = manager.getProviderInstance(id) as any;
      const parse = provider.parseStreamLine.bind(provider);
      vi.spyOn(provider, 'parseStreamLine').mockImplementation((line: string, session: any) => {
        const proc: ChildProcess | undefined = session.persistentProcess || session.process;
        if (proc && !roots.has(proc)) { roots.add(proc); scanOwned(); }
        try {
          const data = JSON.parse(line);
          if (id === 'claude-code' && data.type === 'system' && data.subtype === 'init' && typeof data.model === 'string') {
            report.providerResponses.push({ provider: id, event: 'system.init', model: data.model });
          }
          if (id === 'openai-codex' && typeof data.result?.model === 'string') {
            const method = session.appServer?.requests.get(data.id);
            if (method === 'thread/start' || method === 'thread/resume') {
              report.providerResponses.push({ provider: id, event: method, model: data.result.model });
            }
          }
        } catch { /* Observe only recognized non-secret response fields. */ }
        return parse(line, session);
      });
    }
    const send = manager.sendMessageToProvider.bind(manager);
    // Forward unchanged, recording the exact parsed text seen at the real manager boundary.
    vi.spyOn(manager, 'sendMessageToProvider').mockImplementation(async function* (...args: Parameters<ProviderManager['sendMessageToProvider']>) {
      const request: ObservedRequest = { provider: args[0], model: args[3].model, panel: args[6],
        conversationId: args[4]?.id, startedAt: Date.now(), returned: false, chunks: [] };
      requests.push(request);
      try {
        for await (const chunk of send(...args)) {
          request.chunks.push({ type: chunk.type, sequence: ++sequence,
            ...(chunk.type === 'text' ? { content: chunk.content || '' } : {}) });
          yield chunk;
        }
        request.returned = true;
      } finally { request.durationMs = Date.now() - request.startedAt; }
    });
    const settings: Settings = { provider: 'openai-codex', model: 'gpt-5.6-sol', mode: 'ask-before-edit',
      accessLevel: 'read-only', thinkingLevel: 'none', effortLevel: 'low', contextMode: 'manual' };
    const conversation: Conversation = { id: panel, title: 'Retry policy review', messages: [], createdAt: Date.now(),
      updatedAt: Date.now(), mode: settings.mode, provider: settings.provider, model: settings.model };

    const turn = async (prompt: string, expectedProviders: string[], markers: string[]) => {
      const events: Event[] = [];
      const start = Date.now(); const requestOffset = requests.length;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; collaboration!.cancelPanel(panel); }, 200_000);
      let answer = '';
      try {
        answer = await runExplicitMentions(collaboration!, planExplicitMentions(prompt, resolveExplicitMentions(prompt)), {
          settings, context: [], panelId: panel, conversation, isCancelled: () => timedOut, onGate: collaborationApproval,
        }, event => events.push({ ...event, sequence: ++sequence }));
      } finally {
        clearTimeout(timer);
        report.turns.push({ prompt, answer, events, durationMs: Date.now() - start, timedOut });
      }
      const observed = requests.slice(requestOffset);
      const completes = events.filter(event => event.type === 'collaborator' && event.payload.type === 'collab_complete');
      expect(timedOut).toBe(false);
      expect(observed.map(request => request.provider)).toEqual(expectedProviders);
      expect(completes.map(event => event.payload.agentId)).toEqual(expectedProviders);
      expect(events.filter(event => event.type === 'collaborationError' || ['collab_error', 'collab_skipped'].includes(event.payload.type))).toEqual([]);
      expect(events.filter(event => event.type === 'collaborationStarted')).toHaveLength(expectedProviders.length);
      expect(events.filter(event => event.type === 'collaborationComplete')).toHaveLength(expectedProviders.length);
      const bodies: string[] = [];
      for (const [index, request] of observed.entries()) {
        const complete = completes[index];
        expect(request.returned).toBe(true);
        expect(request.conversationId).toBe(panel);
        expect(request.chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
        expect(request.chunks.filter(chunk => ['error', 'auth_error', 'tool_use', 'tool_result'].includes(chunk.type))).toEqual([]);
        const doneAt = request.chunks.findIndex(chunk => chunk.type === 'done');
        expect(request.chunks.slice(doneAt + 1).filter(chunk => chunk.type === 'text')).toEqual([]);
        const text = request.chunks.filter(chunk => chunk.type === 'text' && chunk.content);
        expect(text.length, 'The provider must produce actual streaming text').toBeGreaterThan(1);
        const forwarded = events.filter(event => event.type === 'collaborator' && event.payload.type === 'collab_text'
          && event.payload.runId === complete.payload.runId && event.payload.collaboratorId === complete.payload.collaboratorId);
        expect(forwarded.map(event => event.payload.content)).toEqual(text.map(chunk => chunk.content));
        const body = text.map(chunk => chunk.content).join('');
        expect(complete.payload).toMatchObject({ responseText: body, hasError: false });
        expect(body.trimEnd().endsWith(markers[index])).toBe(true);
        expect(body.split(markers[index])).toHaveLength(2);
        expect(body).not.toContain('\uFFFD');
        expect(forwarded.every(event => event.sequence < complete.sequence)).toBe(true);
        if (index) {
          const started = events.find(event => event.payload.type === 'collab_started' && event.payload.runId === complete.payload.runId);
          expect(started!.sequence).toBeGreaterThan(completes[index - 1].sequence);
        }
        bodies.push(body);
      }
      expect(answer).toBe(bodies.map((body, index) => `## ${getProviderDisplayName(expectedProviders[index])}\n\n${body.trim()}`).join('\n\n---\n\n'));
      conversation.messages.push({ id: `user-${report.turns.length}`, role: 'user', content: prompt, timestamp: Date.now() },
        { id: `assistant-${report.turns.length}`, role: 'assistant', content: answer, timestamp: Date.now() });
      expect(fs.readFileSync(fixtureFile, 'utf8')).toBe(source);
      console.log('[PC-05]', JSON.stringify({ event: 'review-complete', providers: expectedProviders, durationMs: Date.now() - start,
        textChunks: observed.map(request => request.chunks.filter(chunk => chunk.type === 'text').length), exactTextPreserved: true }));
      return bodies;
    };

    // Shared prefix gives both assignments the original source as well as the
    // downstream review's actual Codex handoff; neither has to infer the input.
    const prompt = `This review concerns an inline retry.js bug. Contract: nonnegative integer attempt n returns min(capMs, baseMs * 2 ** n). Source:\n\`\`\`javascript\n${source}\`\`\`\n${reviewFormat}\n\n@codex Review the bug and recommend the smallest correction. Finish with CODEX_REVIEW_DONE.\nthen @claude Review the preceding Codex proposal against the original inline source and contract. State whether the proposed arithmetic is correct, using your own analysis. Finish with CLAUDE_REVIEW_DONE.`;
    const bodies = await turn(prompt, ['openai-codex', 'claude-code'], ['CODEX_REVIEW_DONE', 'CLAUDE_REVIEW_DONE']);
    for (const body of bodies) {
      expect(body).toMatch(/^\|.*attempt.*\|/im);
      expect(body).toMatch(/^\|\s*:?-{3,}/m);
      expect(body).toMatch(/```(?:javascript|js)\s*\n[\s\S]*?```/);
      expect(body).toMatch(/```diff\s*\n[\s\S]*?^-.*baseMs\s*\*\s*attempt[\s\S]*?^\+.*(?:2\s*\*\*\s*attempt|Math\.pow\(2,\s*attempt\))[\s\S]*?```/m);
      expect(body).toMatch(/```mermaid\s*\n\s*(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b[\s\S]*?```/);
      expect(body.split('Retry → cap ✅')).toHaveLength(2);
      // Independent arithmetic oracle for this synthetic fixture.
      for (const attempt of [0, 1, 4]) {
        const actual = Math.min(500, 73 * attempt);
        const expected = Math.min(500, 73 * 2 ** attempt);
        const rows = body.split('\n').filter(line => /^\|/.test(line))
          .map(line => line.replace(/[`*]/g, '').split('|').slice(1, -1).map(cell => cell.trim()));
        const row = rows.find(cells => cells[0] === String(attempt));
        expect(row, `The review must include attempt ${attempt}`).toBeDefined();
        // Permit explanatory parentheses after the exact numeric value, e.g.
        // "500 (raw 1168, capped)"; this is correct review content, not a loss.
        expect(row![1]).toMatch(new RegExp(`^${actual}(?:\\s*ms)?(?:\\s*\\([^)]*\\))?$`));
        expect(row![2]).toMatch(new RegExp(`^${expected}(?:\\s*ms)?(?:\\s*\\([^)]*\\))?$`));
      }
    }
    const [followup] = await turn('@codex Continue our retry review. The default cap changes to 250; keep the agreed exponential correction and base unchanged. Use only conversation context; no tools or file changes. Give the proposed corrected function in a javascript fence and a minimal diff against our original buggy source. Then state exactly PC05_VALUES:[73,146,250] for attempts 0,1,4 and finish with CODEX_FOLLOWUP_DONE. Keep below 200 words.', ['openai-codex'], ['CODEX_FOLLOWUP_DONE']);
    expect(followup).toContain('PC05_VALUES:[73,146,250]');
    expect(followup).toMatch(/baseMs\s*=\s*73/); expect(followup).toMatch(/capMs\s*=\s*250/);
    expect(followup).toMatch(/```(?:javascript|js)\b/); expect(followup).toMatch(/```diff\b/);
    expect(nativeApproval).not.toHaveBeenCalled(); expect(collaborationApproval).not.toHaveBeenCalled();
    expect(requests).toHaveLength(3);
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    scanOwned();
    const cleanupStarted = Date.now(); collaboration?.cancelPanel(panel); manager?.dispose(); context.subscriptions.forEach(item => item.dispose());
    let remaining = scanOwned();
    while (remaining.length && Date.now() - cleanupStarted < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 100)); remaining = scanOwned();
    }
    report.cleanup = { ownedProcessCount: ownedPids.size, remainingOwnedPids: remaining, durationMs: Date.now() - cleanupStarted };
    if (remaining.length) { report.status = 'FAIL'; report.cleanupFailure = 'Owned fixture processes remained after the cleanup deadline.'; }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(reportDir, 'observations.json'), JSON.stringify(report, null, 2) + '\n');
    vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: previousFolders });
    if (previousTrust) { Object.defineProperty(vscode.workspace, 'isTrusted', previousTrust); }
    else { delete (vscode.workspace as { isTrusted?: boolean }).isTrusted; }
    expect(remaining, 'Owned fixture processes must settle after provider disposal').toEqual([]);
  }
}, 450_000);
