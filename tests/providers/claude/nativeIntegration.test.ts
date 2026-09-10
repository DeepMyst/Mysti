/** Actual installed Claude tools; API, credentials, writes, and network are isolated. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeApprovalTransport } from '../../../src/providers/claude/ClaudeApproval';
import { NativeApprovalRequests } from '../../../src/providers/base/NativeApprovalRequests';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings } from '../../../src/types';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';

const project = path.resolve(__dirname, '../../..');
const installed = process.env.MYSTI_TEST_CLAUDE_PATH || path.join(os.homedir(), '.vscode/extensions/anthropic.claude-code-2.1.266-darwin-arm64/resources/native-binary/claude');
const supported = process.platform === 'darwin' && existsSync(installed) && existsSync('/usr/bin/sandbox-exec');
const settings: Settings = { provider: 'claude-code', mode: 'default', accessLevel: 'ask-permission', model: 'claude-sonnet-4-6', thinkingLevel: 'none', contextMode: 'auto' };

type Scenario = 'allow-bash' | 'allow-edit' | 'deny' | 'readonly' | 'cancel' | 'background' | 'read';
type NativeFrame = { type: string; request: { matched_ask_rule?: unknown };
  message: { content: Array<{ type: string; is_error?: boolean }> } } & Record<string, unknown>;

async function nativeCase(root: string, scenario: Scenario) {
  const privateDir = path.join(root, scenario);
  const state = path.join(privateDir, 'state');
  const work = path.join(privateDir, 'work');
  await fs.mkdir(state, { recursive: true }); await fs.mkdir(work);
  const target = path.join(work, 'marker.txt');
  if (scenario === 'read') { await fs.writeFile(target, 'fixture-read'); }
  let modelCalls = 0;
  const nativeFrames: NativeFrame[] = [];
  const cards: NativeApprovalRequest[] = [];
  const pendingChecks: boolean[] = [];
  let stderr = '';
  let failure: unknown;
  let resolveDecision: ((value: boolean) => void) | undefined;
  let pendingDecision: Promise<boolean> | undefined;
  const policy = scenario === 'readonly' ? { ...settings, accessLevel: 'read-only' as const } : settings;
  const controller = new AbortController();
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) { raw += part; }
      if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404).end(); return; }
      if (request.url.includes('count_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"input_tokens":1}'); return; }
      const incoming = JSON.parse(raw);
      modelCalls++;
      const input = scenario === 'allow-edit' || scenario === 'readonly'
        ? { file_path: target, old_string: '', new_string: 'approved' }
        : scenario === 'read' ? { file_path: target }
          : { command: `printf approved > ${target}`, ...(scenario === 'background' ? { run_in_background: true } : {}) };
      const name = scenario === 'allow-edit' || scenario === 'readonly' ? 'Edit' : scenario === 'read' ? 'Read' : 'Bash';
      const block = modelCalls === 1 ? { type: 'tool_use', id: `tool-${scenario}`, name, input } : { type: 'text', text: 'complete' };
      const stop = modelCalls === 1 ? 'tool_use' : 'end_turn';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit('message_start', { message: { id: `msg-${scenario}-${modelCalls}`, type: 'message', role: 'assistant', model: incoming.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
      emit('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'complete' } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      emit('message_stop', {}); response.end();
    } catch (error) { failure = error; response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const provider = new TestableClaudeProvider();
  (provider as unknown as { _extensionContext: { extensionPath: string } })._extensionContext.extensionPath = project;
  // Use the real production flags and static policy; bare isolates authentication and state.
  const args = provider.buildCliArgs(settings, createClaudeSession());
  args.push('--bare', '--no-session-persistence');
  const userDir = os.homedir();
  const sandbox = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${port}"))`
    + `(deny file-read* (subpath "${userDir}/.claude") (literal "${userDir}/.claude.json") (subpath "${userDir}/Library/Keychains"))`
    + `(deny file-write* (require-all (require-not (subpath "${root}")) (require-not (subpath "/dev"))))`;
  const proc = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, installed, ...args], { cwd: work,
    env: { PATH: process.env.PATH, TMPDIR: privateDir, CLAUDE_CODE_TMPDIR: privateDir, CLAUDE_CONFIG_DIR: state,
      ANTHROPIC_API_KEY: 'mysti-fixture-not-a-real-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const transport = new ClaudeApprovalTransport(proc);
  const requests = new NativeApprovalRequests({ providerId: 'claude-code', panelId: `panel-${scenario}`, process: proc,
    signal: controller.signal, isCurrent: () => proc.exitCode === null && proc.signalCode === null,
    handler: request => {
      cards.push(request);
      if (scenario === 'read') { return Promise.resolve(false); }
      pendingChecks.push(existsSync(target));
      pendingDecision = new Promise<boolean>(resolve => { resolveDecision = resolve; });
      setTimeout(() => {
        pendingChecks.push(existsSync(target));
        if (scenario === 'cancel') { controller.abort(); }
        resolveDecision?.(scenario !== 'deny');
      }, 150);
      return pendingDecision;
    },
  });
  let buffer = '';
  proc.stdin.on('error', error => { failure ||= error; });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      if (!line.trim()) { continue; }
      try {
        const data = JSON.parse(line); nativeFrames.push(data);
        if (data.type === 'system' && data.subtype === 'init') { transport.attest(data.claude_code_version); }
        if (data.type === 'control_request' || data.type === 'control_cancel_request') { transport.handle(data, requests, policy); }
        if (data.type === 'result') { proc.stdin.end(); }
      } catch (error) { failure ||= error; proc.kill('SIGKILL'); }
    }
  });
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `inert fixture ${scenario}` }] } }) + '\n');
  const timeout = setTimeout(() => { failure ||= new Error('Native fixture timed out'); proc.kill('SIGKILL'); }, 15000);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      proc.once('error', error => { failure ||= error; });
      proc.once('close', (code, signal) => resolve({ code, signal }));
    });
    const result = { scenario, exit, failure: failure instanceof Error ? failure.message : failure, stderr,
      modelCalls, pendingChecks, cards: cards.map(card => ({ name: card.toolCall.name, input: card.toolCall.input })),
      nativeFrames, exists: existsSync(target), content: existsSync(target) ? await fs.readFile(target, 'utf8') : undefined };
    await fs.writeFile(path.join(privateDir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    clearTimeout(timeout); requests.dispose(); controller.abort(); resolveDecision?.(false);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('installed Claude blocking native permission integration', () => {
  it.skipIf(!supported)('holds actual Bash/Edit, denies rejected/read-only/background actions, and cancels late allow', { timeout: 60000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-native-claude-')));
    const evidence = path.join(project, 'out-test/release-evidence', `item4-native-claude-${Date.now()}`);
    await fs.mkdir(evidence, { recursive: true });
    try {
      for (const scenario of ['allow-bash', 'allow-edit', 'deny', 'readonly', 'cancel', 'background', 'read'] as const) {
        const result = await nativeCase(root, scenario);
        await fs.copyFile(path.join(root, scenario, 'result.json'), path.join(evidence, `${scenario}.json`));
        const diagnostic = `${evidence}\n${JSON.stringify(result)}`;
        expect(result.failure, diagnostic).toBeUndefined();
        expect(result.exit, diagnostic).toEqual({ code: 0, signal: null });
        expect(result.modelCalls, diagnostic).toBe(2);
        const requests = result.nativeFrames.filter(frame => frame.type === 'control_request');
        // Native background execution is disabled at launch and rejected by
        // its schema before a permission request can reach the host.
        expect(requests, diagnostic).toHaveLength(scenario === 'background' ? 0 : 1);
        if (requests.length && scenario !== 'read') { expect(requests[0].request.matched_ask_rule, diagnostic).toEqual({ source: 'flagSettings', tool_name: '*' }); }
        expect(result.pendingChecks.every(present => !present), diagnostic).toBe(true);
        if (scenario === 'allow-bash' || scenario === 'allow-edit') {
          expect(result.pendingChecks, diagnostic).toEqual([false, false]);
          expect(result.content, diagnostic).toBe('approved');
        } else if (scenario === 'read') {
          expect(result.content, diagnostic).toBe('fixture-read');
          expect(result.cards, diagnostic).toHaveLength(1);
          const toolResult = result.nativeFrames.find(frame => frame.type === 'user' && frame.message.content.some(block => block.type === 'tool_result'));
          expect(toolResult?.message.content[0].is_error, diagnostic).toBe(true);
        } else {
          expect(result.exists, diagnostic).toBe(false);
          expect(result.cards, diagnostic).toHaveLength(scenario === 'readonly' || scenario === 'background' ? 0 : 1);
        }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
