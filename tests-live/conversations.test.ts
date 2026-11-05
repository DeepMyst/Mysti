/** Account-backed developer journeys. Explicit opt-in: npm run test:live:conversations.
 * Real routing, pool, ProviderManager, provider prompts, CLIs and inference;
 * only the VS Code API is replaced. All file work uses a disposable workspace.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from '../src/managers/ProviderManager';
import { CollaborationManager } from '../src/managers/CollaborationManager';
import { BrainstormManager } from '../src/managers/BrainstormManager';
import type { AgentContextManager } from '../src/managers/AgentContextManager';
import { CollaboratorPool } from '../src/services/CollaboratorPool';
import { planExplicitMentions, resolveExplicitMentions } from '../src/services/ExplicitMentionPlan';
import { runExplicitMentions } from '../src/managers/ExplicitMentionRunner';
import { PROVIDER_DISPLAY_META } from '../src/providers/base/ProviderManifest';
import { clearMockConfig, createMockMemento, createMockSecretStorage, setMockConfig } from '../tests/helpers/mockVscode';
import type { Conversation, Settings } from '../src/types';

const output = path.resolve(process.env.MYSTI_LIVE_REPORT || 'out-test/live-conversations.json');
const evidence: Record<string, unknown>[] = [];
const source = 'exports.retryDelay = (attempt, baseMs = 100, capMs = 1000) => Math.min(capMs, baseMs * attempt);\n';
let directory: string;
let context: vscode.ExtensionContext;
let providers: ProviderManager;
let collaboration: CollaborationManager;
let settings: Settings;
let originalFolders: typeof vscode.workspace.workspaceFolders;
let originalTrust: PropertyDescriptor | undefined;
let row: Record<string, unknown>;
let events: Array<{ type: string; payload: Record<string, unknown> }>;
let conversations: Map<string, Conversation>;

beforeEach(test => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-conversation-'));
  fs.writeFileSync(path.join(directory, 'retry.cjs'), source);
  fs.mkdirSync(path.join(directory, '.claude'));
  const claudeSettings = path.join(directory, '.claude/settings.json');
  fs.writeFileSync(claudeSettings, JSON.stringify({ disableAllHooks: true }));
  originalFolders = vscode.workspace.workspaceFolders;
  originalTrust = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted');
  Object.defineProperty(vscode.workspace, 'isTrusted', { configurable: true, value: true });
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true,
    value: [{ uri: vscode.Uri.file(directory), name: 'live-conversation', index: 0 }] });
  setMockConfig('claudeCodePath', process.env.MYSTI_LIVE_CLAUDE || path.join(os.homedir(), '.local/bin/claude'));
  setMockConfig('codexPath', process.env.MYSTI_LIVE_CODEX || 'codex');
  setMockConfig('claudeCodeModel', process.env.MYSTI_LIVE_CLAUDE_MODEL || 'sonnet');
  setMockConfig('codexModel', process.env.MYSTI_LIVE_CODEX_MODEL || 'gpt-5.6-sol');
  if (process.env.MYSTI_LIVE_GEMINI_MODEL) { setMockConfig('geminiModel', process.env.MYSTI_LIVE_GEMINI_MODEL); }
  setMockConfig('defaultProvider', 'claude-code');
  context = { subscriptions: [], globalState: createMockMemento(), workspaceState: createMockMemento(),
    secrets: createMockSecretStorage(), extensionPath: path.resolve('.'), extensionUri: vscode.Uri.file(path.resolve('.')),
    globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')), storageUri: vscode.Uri.file(path.join(directory, 'storage')),
    extensionMode: 3,
  } as unknown as vscode.ExtensionContext;
  providers = new ProviderManager(context);
  // Disable personal hooks for the fixture. All transport/prompt code stays real.
  const claude = providers.getProviderInstance('claude-code') as any;
  const build = claude.buildPersistentCliArgs.bind(claude);
  vi.spyOn(claude, 'buildPersistentCliArgs').mockImplementation((...args: unknown[]) => [...build(...args), '--settings', claudeSettings]);
  collaboration = new CollaborationManager(new CollaboratorPool(providers), {
    buildRoleContext: async () => null,
  } as unknown as AgentContextManager);
  settings = { provider: 'claude-code', model: process.env.MYSTI_LIVE_CLAUDE_MODEL || 'sonnet', mode: 'ask-before-edit',
    accessLevel: 'ask-permission', thinkingLevel: 'none', effortLevel: 'low', contextMode: 'manual' };
  events = []; conversations = new Map();
  row = { scenario: test.task.name, startedAt: new Date().toISOString(), turns: [], status: 'running' };
  evidence.push(row);
});

afterEach(test => {
  row.status = test.task.result?.state === 'fail' ? 'failed' : test.task.result?.state === 'skip' ? 'skipped' : 'passed';
  row.errors = test.task.result?.errors?.map(error => error.message);
  row.finishedAt = new Date().toISOString();
  row.events = events;
  providers.dispose();
  context.subscriptions.forEach(disposable => disposable.dispose());
  vi.restoreAllMocks(); clearMockConfig();
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: originalFolders });
  if (originalTrust) { Object.defineProperty(vscode.workspace, 'isTrusted', originalTrust); }
  else { delete (vscode.workspace as { isTrusted?: boolean }).isTrusted; }
  fs.rmSync(directory, { recursive: true, force: true });
  writeReport();
});
afterAll(writeReport);

function writeReport() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ platform: process.platform, node: process.version,
    scope: 'Real CLI inference through Mysti managers; mocked VS Code API; disposable synthetic repository.', scenarios: evidence }, null, 2) + '\n');
}

async function turn(prompt: string, panelId = 'developer', overrides: Partial<Settings> = {}) {
  let conversation = conversations.get(panelId);
  if (!conversation) {
    conversation = { id: panelId, title: panelId, messages: [], createdAt: Date.now(), updatedAt: Date.now(),
      mode: settings.mode, model: settings.model, provider: settings.provider };
    conversations.set(panelId, conversation);
  }
  const offset = events.length;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; collaboration.cancelPanel(panelId); }, 150_000);
  try {
    const answer = await runExplicitMentions(collaboration, planExplicitMentions(prompt, resolveExplicitMentions(prompt)), {
      settings: { ...settings, ...overrides }, context: [], panelId, conversation,
      isCancelled: () => timedOut,
      onGate: async (spec, tool) => {
        events.push({ type: 'approval', payload: { agentId: spec.agentId, tool: tool.name } });
        return true;
      },
    }, event => events.push(event));
    (row.turns as unknown[]).push({ prompt, answer, panelId });
    conversation.messages.push({ id: randomUUID(), role: 'user', content: prompt, timestamp: Date.now() },
      { id: randomUUID(), role: 'assistant', content: answer, timestamp: Date.now() });
    expect(timedOut, 'Conversation exceeded its deadline').toBe(false);
    return { answer, events: events.slice(offset) };
  } finally { clearTimeout(timer); }
}

function successful(result: Awaited<ReturnType<typeof turn>>, count: number) {
  const failures = result.events.filter(event => ['collab_error', 'collab_skipped'].includes(String(event.payload.type)) ||
    event.type === 'collaborationError' || event.payload.hasError === true);
  expect(failures, JSON.stringify(failures)).toEqual([]);
  expect(result.events.filter(event => event.payload.type === 'collab_complete')).toHaveLength(count);
  expect(result.answer.trim()).not.toBe('');
}

describe('real developer conversations', () => {
  it('Claude and Codex independently find the bug, then remember a follow-up constraint', async () => {
    const result = await turn('@claude @codex Review retry.cjs in the current workspace. The contract is exponential backoff: attempt 0 returns baseMs, attempt 1 returns 2*baseMs, capped at capMs. Identify a failing input and recommend the smallest correction. Do not modify files. Keep your answer under 150 words.');
    successful(result, 2);
    expect(result.answer).toMatch(/attempt.?0|attempt.?=.?0|\b0\b/i);
    expect(fs.readFileSync(path.join(directory, 'retry.cjs'), 'utf8')).toBe(source);
    const followup = await turn('@codex Based on our previous review, what should attempt 0 return when baseMs is 73? Reply with the value and one sentence. Do not use tools.');
    successful(followup, 1);
    expect(followup.answer).toContain('73');
  }, 330_000);

  it('Claude implements, Codex reviews the handoff, then Codex handles a revised requirement', async () => {
    const result = await turn('@claude Fix retry.cjs: retryDelay(attempt, baseMs=100, capMs=1000) must return Math.min(capMs, baseMs * 2 ** attempt) for nonnegative integer attempts. Edit only retry.cjs using your file edit tool. Summarize your change, then @codex Review the implementation in retry.cjs and the preceding change summary against exponential backoff. Check attempts 0, 1, and 4. Do not edit files. End with REVIEW_COMPLETE.');
    successful(result, 2);
    expect(result.answer).toContain('REVIEW_COMPLETE');
    const verify = (expected: number[]) => {
      const actual = execFileSync(process.execPath, ['-e', 'const {retryDelay}=require("./retry.cjs"); console.log(JSON.stringify([0,1,4].map(n=>retryDelay(n))))'], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
      expect(JSON.parse(actual)).toEqual(expected);
    };
    verify([100, 200, 1000]);
    expect(result.events.some(event => event.type === 'approval')).toBe(true);
    const followup = await turn('@codex Update retry.cjs from our prior implementation: change the default capMs from 1000 to 500, keeping default baseMs and exponential behavior unchanged. Edit only retry.cjs using your file edit tool.');
    successful(followup, 1); verify([100, 200, 500]);
  }, 330_000);

  for (const third of ['google-gemini', 'github-copilot', 'cursor', 'opencode', 'qwen-code'] as const) {
    it(`${third} joins Claude and Codex for an attributed three-agent review`, async test => {
      const status = await providers.getProviderStatus(third);
      row.availability = { found: status?.found ?? false, authenticated: status?.authenticated ?? false };
      if (!status?.found || !status.authenticated) { row.reason = `${third} is not installed/authenticated`; test.skip(); }
      const result = await turn(`@claude @codex @${PROVIDER_DISPLAY_META[third].shortId} Review this proposed retry policy: delay = min(1000, 100 * attempt). Requirement: exponential backoff with attempt zero starting at 100ms. Give one failing example and a correction in at most 80 words. Do not use tools.`);
      successful(result, 3);
      expect(new Set(result.events.filter(event => event.payload.type === 'collab_complete').map(event => event.payload.agentId)).size).toBe(3);
    }, 180_000);
  }

  it('separate conversation panels keep their context after switching providers', async () => {
    const alpha = `ALPHA_${randomUUID().slice(0, 8)}`;
    const beta = `BETA_${randomUUID().slice(0, 8)}`;
    successful(await turn(`@claude Remember our feature flag ${alpha}. Reply with it. Do not use tools.`, 'alpha'), 1);
    successful(await turn(`@codex Remember our feature flag ${beta}. Reply with it. Do not use tools.`, 'beta'), 1);
    const a = await turn('@codex What exact feature flag did I give in this conversation? Reply only with it. Do not use tools.', 'alpha');
    const b = await turn('@claude What exact feature flag did I give in this conversation? Reply only with it. Do not use tools.', 'beta');
    successful(a, 1); successful(b, 1);
    expect(a.answer).toContain(alpha); expect(a.answer).not.toContain(beta);
    expect(b.answer).toContain(beta); expect(b.answer).not.toContain(alpha);
  }, 660_000);

  it('Stop cancels a real approval, prevents the queued writer, and permits the next turn', async () => {
    let cancelled = false;
    let gateSignal: AbortSignal | undefined;
    let observed!: () => void;
    const waiting = new Promise<void>(resolve => { observed = resolve; });
    const prompt = '@claude @codex Create cancelled.cjs containing CANCEL_TEST with your file edit tool. Invoke the tool now so Mysti can request approval. Do not ask in prose and do not use shell commands.';
    const work = runExplicitMentions(collaboration, planExplicitMentions(prompt, resolveExplicitMentions(prompt)), {
      settings, context: [], panelId: 'cancel-test', isCancelled: () => cancelled,
      onGate: async (_spec, _tool, request) => {
        gateSignal = request?.signal;
        observed();
        return new Promise<boolean>(resolve => {
          if (!gateSignal || gateSignal.aborted) { resolve(false); }
          else { gateSignal.addEventListener('abort', () => resolve(false), { once: true }); }
        });
      },
    }, event => events.push(event));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([waiting, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('No native approval request arrived')), 60_000);
      })]);
      expect(fs.existsSync(path.join(directory, 'cancelled.cjs'))).toBe(false);
    } finally {
      clearTimeout(timer); cancelled = true; collaboration.cancelPanel('cancel-test'); await work;
    }
    expect(gateSignal?.aborted).toBe(true);
    expect(events.filter(event => event.payload.type === 'collab_started').map(event => event.payload.agentId)).toEqual(['claude-code']);
    expect(fs.existsSync(path.join(directory, 'cancelled.cjs'))).toBe(false);
    const recovered = await turn('@codex Do not use tools. Reply exactly NEXT_TURN_READY.', 'cancel-test');
    successful(recovered, 1); expect(recovered.answer).toContain('NEXT_TURN_READY');
  }, 240_000);

  it('Quick Brainstorm obtains both real analyses and a synthesis', async () => {
    setMockConfig('brainstorm.agents', ['claude-code', 'openai-codex']);
    setMockConfig('brainstorm.strategy', 'quick');
    setMockConfig('brainstorm.synthesisAgent', 'claude-code');
    const brainstorm = new BrainstormManager(context, providers);
    const chunks: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => brainstorm.cancelSession('live-brainstorm'), 150_000);
    try {
      for await (const chunk of brainstorm.startBrainstormSession('A small Node service retries HTTP 429 responses. Discuss exponential backoff, jitter, Retry-After and a retry limit. Give a concrete recommendation under 150 words per response. Do not use tools.', [], { ...settings, accessLevel: 'read-only' }, 'live-brainstorm')) {
        chunks.push(chunk as unknown as Record<string, unknown>);
      }
      row.chunks = chunks;
      expect(chunks.filter(chunk => chunk.type === 'agent_error' || chunk.type === 'discussion_error' || chunk.type === 'synthesis_fallback')).toEqual([]);
      expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
      expect(chunks.some(chunk => chunk.type === 'synthesis_text' && String(chunk.content).trim())).toBe(true);
      expect(chunks.filter(chunk => chunk.type === 'agent_complete').length).toBeGreaterThanOrEqual(2);
    } finally { clearTimeout(timer); brainstorm.cancelSession('live-brainstorm'); }
  }, 180_000);
});
