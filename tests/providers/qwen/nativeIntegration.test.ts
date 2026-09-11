/** Installed runtimes, real tools, fake model endpoint, OS-isolated credentials/network/writes. */
import { createServer } from 'http';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { TestableGeminiProvider, TestableQwenProvider } from '../../helpers/providerFactory';
import { createGeminiSession, createQwenSession } from '../../helpers/sessionFactory';
import { AcpNativeClient } from '../../../src/providers/base/AcpNativeClient';
import type { AcpNativeLaunch, AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../../src/types';

const project = path.resolve(__dirname, '../../..');
const installed = { qwen: '/usr/local/bin/qwen', gemini: '/usr/local/bin/gemini' };
type Flavor = keyof typeof installed;
type Scenario = 'allow-edit' | 'allow-replace' | 'allow-command' | 'deny' | 'readonly' | 'cancel' | 'background' | 'unsupported-shell' | 'read';
const settings: Settings = { provider: 'qwen-code', model: 'qwen3-coder', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' };

async function nativeCase(root: string, flavor: Flavor, scenario: Scenario) {
  const privateDir = path.join(root, `${flavor}-${scenario}`);
  const state = path.join(privateDir, 'state'); const work = path.join(privateDir, 'work');
  await fs.mkdir(state, { recursive: true }); await fs.mkdir(work);
  const target = path.join(work, 'marker.txt');
  if (scenario === 'read') { await fs.writeFile(target, 'inert read'); }
  if (scenario === 'allow-replace') { await fs.writeFile(target, 'before'); }
  // Inherited allow rules must never bypass the bundled explicit ask rules.
  if (flavor === 'qwen') { await fs.writeFile(path.join(state, 'settings.json'), JSON.stringify({ $version: 4, permissions: { allow: ['read_file', 'edit', 'notebook_edit', 'run_shell_command'] } })); }
  const name = scenario === 'read' ? 'read_file' : ['allow-command', 'background', 'unsupported-shell'].includes(scenario) ? 'run_shell_command'
    : flavor === 'qwen' ? 'edit' : scenario === 'allow-replace' ? 'replace' : 'write_file';
  const args = name === 'read_file' ? { file_path: target }
    : name === 'run_shell_command' ? { command: `printf approved >> ${target}`, ...(scenario === 'background' ? { is_background: true } : {}) }
      : scenario === 'allow-replace' ? { file_path: target, old_string: 'before', new_string: 'approved', instruction: 'Replace before with approved.' }
        : flavor === 'qwen' ? { file_path: target, old_string: '', new_string: 'approved' } : { file_path: target, content: 'approved' };
  let modelCalls = 0; let failure: unknown; let stderr = '';
  const cards: NativeApprovalRequest[] = []; const pendingChecks: boolean[] = []; const pendingContents: string[] = []; const frames: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) { raw += part; }
      if (request.url?.includes('countTokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"totalTokens":1}'); return; }
      if (!request.url?.includes('chat/completions') && !request.url?.includes('generateContent') && !request.url?.includes('streamGenerateContent')) {
        response.writeHead(404).end(); return;
      }
      const body = JSON.parse(raw); modelCalls++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (flavor === 'qwen') {
        const chunk = { id: `inert-${modelCalls}`, object: 'chat.completion.chunk', created: 1, model: body.model,
          choices: [{ index: 0, delta: modelCalls === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${scenario}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'complete' }, finish_reason: null }] };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: modelCalls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`);
      } else {
        const part = modelCalls === 1 ? { functionCall: { id: `tool-${scenario}`, name, args } } : { text: 'complete' };
        response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }], modelVersion: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 } })}\n\n`);
      }
      response.end();
    } catch (error) { failure = error; response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const provider = flavor === 'qwen' ? new TestableQwenProvider() : new TestableGeminiProvider();
  (provider as unknown as { _extensionContext: { extensionPath: string } })._extensionContext.extensionPath = project;
  const policy = { ...settings, provider: flavor === 'qwen' ? 'qwen-code' : 'google-gemini', model: flavor === 'qwen' ? 'qwen3-coder' : 'gemini-2.5-flash',
    ...(scenario === 'readonly' ? { accessLevel: 'read-only' as const } : {}) };
  const controller = new AbortController();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: privateDir, QWEN_HOME: state,
    GEMINI_CLI_HOME: state, OPENAI_API_KEY: 'mysti-inert-key', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    GEMINI_API_KEY: 'mysti-inert-key', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}`, NO_BROWSER: '1',
    QWEN_MODEL: 'qwen3-coder', GEMINI_MODEL: 'gemini-2.5-flash' };
  const launcher = provider as unknown as { _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch> };
  const launch = await launcher._prepareAcpLaunch({ settings: policy, session: flavor === 'qwen' ? createQwenSession() : createGeminiSession(), cwd: work, env, cliPath: installed[flavor], signal: controller.signal });
  const sandbox = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${port}"))`
    + `(deny file-read-data (subpath "${os.homedir()}"))(allow file-read-data (subpath "${project}/resources"))`
    + `(deny file-write* (require-all (require-not (subpath "${root}")) (require-not (subpath "/dev"))))`;
  const proc = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, launch.cliPath!, ...launch.args], { cwd: work, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', part => { stderr += part; });
  let buffer = ''; proc.stdout.on('data', part => { buffer += part; let index: number; while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { frames.push(JSON.parse(line)); } catch { /* shared client reports malformed output */ }
  } });
  const client = new AcpNativeClient({ process: proc, providerId: policy.provider, label: flavor, panelId: scenario, signal: controller.signal,
    settings: policy, launch, isCurrent: () => proc.exitCode === null && proc.signalCode === null,
    terminate: () => { proc.kill('SIGKILL'); }, handler: request => {
      cards.push(request); pendingChecks.push(existsSync(target));
      if (existsSync(target)) { pendingContents.push(readFileSync(target, 'utf8')); }
      return new Promise<boolean>(resolve => setTimeout(() => {
        pendingChecks.push(existsSync(target)); if (scenario === 'cancel') { controller.abort(); }
        if (existsSync(target)) { pendingContents.push(readFileSync(target, 'utf8')); }
        resolve(scenario !== 'deny' && scenario !== 'read');
      }, 150));
    }, startupTimeoutMs: 15000, inactivityTimeoutMs: 15000 });
  const chunks: StreamChunk[] = [];
  const timeout = setTimeout(() => { failure ||= new Error('Installed native probe timed out'); controller.abort(); }, 25000);
  try {
    await client.initialize(); await client.newSession(work); await client.setMode('default'); await launch.assertUnchanged?.();
    client.startPrompt([{ type: 'text', text: `Mysti user request:\n\nInert fixture ${scenario}.` }]);
    for await (const chunk of client.stream()) { chunks.push(chunk); }
  } catch (error) { failure ||= error; }
  finally {
    clearTimeout(timeout); client.dispose(); controller.abort(); proc.kill('SIGKILL');
    await new Promise<void>(resolve => proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.once('close', () => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve())); provider.dispose();
  }
  return { flavor, scenario, stateFiles: await fs.readdir(state, { recursive: true }), failure: failure instanceof Error ? failure.message : failure, stderr, modelCalls, pendingChecks, pendingContents,
    cards: cards.map(card => ({ name: card.toolCall.name, input: card.toolCall.input })), frames, chunks,
    exists: existsSync(target), content: existsSync(target) ? await fs.readFile(target, 'utf8') : undefined };
}

describe('installed Gemini/Qwen native authority', () => {
  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') || !existsSync(installed.qwen) || !existsSync(installed.gemini))(
    'holds real file/command effects until allow and rejects deny, readonly, cancelled and unsupported actions', { timeout: 150000 }, async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-native-family-')));
      const evidence = path.join(project, 'out-test/release-evidence', `item5-native-family-${Date.now()}`); await fs.mkdir(evidence, { recursive: true });
      try {
        const cases: [Flavor, Scenario][] = [['qwen', 'allow-command'], ['qwen', 'allow-edit'], ['qwen', 'deny'], ['qwen', 'readonly'],
          ['qwen', 'cancel'], ['qwen', 'background'], ['qwen', 'read'], ['gemini', 'allow-edit'], ['gemini', 'allow-replace'], ['gemini', 'deny'],
          ['gemini', 'readonly'], ['gemini', 'unsupported-shell'], ['gemini', 'read'], ['gemini', 'cancel']];
        for (const [flavor, scenario] of cases) {
          const result = await nativeCase(root, flavor, scenario);
          await fs.writeFile(path.join(evidence, `${flavor}-${scenario}.json`), JSON.stringify(result, null, 2));
          const diagnostic = `${evidence}\n${JSON.stringify({ ...result, frames: result.frames.filter((frame: any) => frame.id !== undefined || frame.params?.update?.sessionUpdate === 'tool_call_update') }).slice(0, 18000)}`;
          expect(result.failure, diagnostic).toBeUndefined();
          expect(result.chunks.some(chunk => chunk.type === 'error'), diagnostic).toBe(false);
          if (scenario === 'allow-command' || scenario === 'allow-edit' || scenario === 'allow-replace') {
            expect(result.pendingChecks, diagnostic).toEqual(scenario === 'allow-replace' ? [true, true] : [false, false]); expect(result.content, diagnostic).toBe('approved');
            if (scenario === 'allow-replace') { expect(result.pendingContents, diagnostic).toEqual(['before', 'before']); }
            expect(result.cards, diagnostic).toHaveLength(1);
          } else if (scenario !== 'read') { expect(result.exists, diagnostic).toBe(false); }
          if (scenario === 'deny' || scenario === 'cancel') { expect(result.pendingChecks, diagnostic).toEqual([false, false]); }
          if (scenario === 'background' || scenario === 'readonly' || scenario === 'unsupported-shell') { expect(result.cards, diagnostic).toHaveLength(0); }
          if (scenario === 'read') { expect(result.cards, diagnostic).toHaveLength(1); }
        }
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
});
