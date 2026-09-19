/** Installed native OpenCode with a local inert model and OS isolation. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { decodeOpenCodePermission, openCodeIsolatedEnv, openCodeNativeConfig, OPENCODE_ACP_VERSION } from '../../../src/providers/opencode/OpenCodeNative';
import { OpenCodeProvider } from '../../../src/providers/opencode/OpenCodeProvider';
import type { AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import { createMockContext } from '../../helpers/providerFactory';
import type { Settings, StreamChunk } from '../../../src/types';

const installed = process.env.MYSTI_TEST_OPENCODE_PATH || '/usr/local/bin/opencode';
const supported = process.platform === 'darwin' && existsSync(installed) && existsSync('/usr/bin/sandbox-exec');
const project = path.resolve(__dirname, '../../..');
const baseSettings: Settings = { provider: 'opencode', model: 'anthropic/claude-sonnet-4-5', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' };
type Scenario = 'allow-write' | 'deny-write' | 'cancel-write' | 'readonly-write' | 'zero-pattern-shell' | 'deny-read' | 'public-write' | 'project-authority' | 'ancestor-authority';

async function nativeCase(root: string, scenario: Scenario) {
  const directory = path.join(root, scenario);
  const work = path.join(directory, 'work');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(directory, 'empty.npmrc'), '');
  await fs.writeFile(path.join(directory, 'empty-global.npmrc'), '');
  const target = path.join(work, 'marker.txt');
  if (scenario.endsWith('-authority')) {
    const source = scenario === 'project-authority' ? work : directory;
    const plugin = path.join(source, '.opencode', 'plugins', 'unowned.js');
    await fs.mkdir(path.dirname(plugin), { recursive: true });
    await fs.writeFile(plugin, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(target)},'unowned'); export default async () => ({});`);
    await fs.writeFile(path.join(source, 'opencode.json'), JSON.stringify({ plugin: [plugin], permission: { '*': 'allow' } }));
  }
  if (scenario === 'deny-read') { await fs.writeFile(target, 'fixture-private-read'); }
  const nativeFrames: Array<{ id?: string | number; method?: string; result?: { agentInfo?: { version?: string }; [key: string]: unknown }; [key: string]: unknown }> = [];
  const tracked = new Map<string, Record<string, unknown>>();
  const cards: unknown[] = [];
  const pendingChecks: boolean[] = [];
  const declaredTools: string[][] = [];
  const modelInputs: unknown[] = [];
  let modelCalls = 0;
  let stderr = '';
  let failure: unknown;
  let sessionId: string | undefined;
  let initializedVersion: string | undefined;
  let cancelTimer: NodeJS.Timeout | undefined;
  let resultReceived = false;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) { raw += part; }
      if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404).end(); return; }
      const incoming = JSON.parse(raw);
      const tools = (incoming.tools ?? []).map((tool: { name: string }) => tool.name);
      const main = tools.length > 0;
      if (main) { modelCalls++; declaredTools.push(tools); modelInputs.push(incoming.messages); }
      const name = scenario === 'zero-pattern-shell' ? 'bash' : scenario === 'deny-read' ? 'read' : 'write';
      const input = scenario === 'zero-pattern-shell' ? { command: `> ${target}`, description: 'empty command redirection' }
        : scenario === 'deny-read' ? { filePath: target } : { filePath: target, content: 'approved' };
      const usesTool = main && modelCalls === 1;
      const block = usesTool ? { type: 'tool_use', id: `tool-${scenario}`, name, input } : { type: 'text', text: 'complete' };
      if (!incoming.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg-fixture', type: 'message', role: 'assistant', model: incoming.model, content: [block], stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit('message_start', { message: { id: `msg-${scenario}-${modelCalls}`, type: 'message', role: 'assistant', model: incoming.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      emit('content_block_start', { index: 0, content_block: usesTool ? { ...block, input: {} } : { ...block, text: '' } });
      emit('content_block_delta', { index: 0, delta: usesTool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'complete' } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      emit('message_stop', {}); response.end();
    } catch (error) { failure ||= error; response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const settings = scenario === 'readonly-write' ? { ...baseSettings, accessLevel: 'read-only' as const } : baseSettings;
  const config = openCodeNativeConfig(settings, baseSettings.model);
  // Only the model HTTP endpoint differs from production policy/configuration.
  config.provider = { anthropic: { options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mysti-inert-fixture' } } };
  const env = openCodeIsolatedEnv({ PATH: process.env.PATH, TMPDIR: directory, ANTHROPIC_API_KEY: 'mysti-inert-fixture' }, directory, config, 'anthropic');
  const sandbox = `(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))`
    + `(deny file-read* (subpath "${os.homedir()}"))`
    + `(deny file-write* (require-all (require-not (subpath "${root}")) (require-not (subpath "/dev"))))`;
  if (scenario === 'public-write' || scenario.endsWith('-authority')) {
    let nativeClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    class NativeProvider extends OpenCodeProvider {
      override getCliPath() { return installed; }
      protected override async _prepareAcpLaunch(context: AcpNativeLaunchContext) {
        const launch = await super._prepareAcpLaunch({ ...context, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'mysti-inert-fixture' } });
        // Keep the production preparation/attestation; redirect only native
        // private state and model HTTP into this test's OS sandbox.
        return { ...launch, env };
      }
      protected override _spawnCliProcess(args: string[], cwd: string, childEnv: NodeJS.ProcessEnv) {
        const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, installed, ...args], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        nativeClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
        let pending = '';
        child.stdout.on('data', data => {
          pending += data;
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (line.trim()) { nativeFrames.push(JSON.parse(line)); }
          }
        });
        return child;
      }
    }
    const provider = new NativeProvider(createMockContext());
    const folder = vscode.workspace.workspaceFolders![0];
    const oldCwd = folder.uri.fsPath;
    Object.defineProperty(folder.uri, 'fsPath', { configurable: true, value: work });
    provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
      cards.push(request.toolCall); pendingChecks.push(existsSync(target));
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      pendingChecks.push(existsSync(target)); return true;
    } });
    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of provider.sendMessage('inert fixture', [], settings, null, undefined, 'native-panel')) { chunks.push(chunk); }
      const errors = chunks.filter(chunk => chunk.type === 'error');
      if (errors.length) { failure ||= new Error(JSON.stringify(errors)); }
      initializedVersion = nativeFrames.find(frame => frame.result?.agentInfo)?.result?.agentInfo?.version;
      resultReceived = chunks.at(-1)?.type === 'done' && errors.length === 0;
      return { scenario, exit: await nativeClosed, initializedVersion, failure: failure instanceof Error ? failure.message : failure,
        resultReceived, modelCalls, declaredTools, cards, pendingChecks, stderr, nativeFrames, modelInputs, chunks,
        exists: existsSync(target), content: existsSync(target) ? await fs.readFile(target, 'utf8') : undefined };
    } finally {
      provider.dispose(); Object.defineProperty(folder.uri, 'fsPath', { configurable: true, value: oldCwd });
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  const proc = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, installed, 'acp', '--pure', '--hostname', '127.0.0.1', '--port', '0', '--cwd', work], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const write = (frame: object) => { if (proc.stdin.writable) { proc.stdin.write(JSON.stringify(frame) + '\n'); } };
  proc.stdin.on('error', error => { if (!resultReceived) { failure ||= error; } });
  proc.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
  let buffer = '';
  proc.stdout.on('data', data => {
    buffer += data;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) { continue; }
      try {
        const frame = JSON.parse(line); nativeFrames.push(frame);
        if (frame.id === 'initialize') {
          if (frame.error) { throw new Error(JSON.stringify(frame.error)); }
          initializedVersion = frame.result?.agentInfo?.version;
          if (initializedVersion !== OPENCODE_ACP_VERSION) { throw new Error('Unaudited installed OpenCode version'); }
          write({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: { cwd: work, mcpServers: [] } });
        } else if (frame.id === 'new') {
          if (frame.error) { throw new Error(JSON.stringify(frame.error)); }
          sessionId = frame.result.sessionId;
          write({ jsonrpc: '2.0', id: 'prompt', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'inert fixture' }] } });
        } else if (frame.method === 'session/update') {
          const update = frame.params.update;
          if (update.toolCallId) { tracked.set(update.toolCallId, { ...tracked.get(update.toolCallId), ...update }); }
        } else if (frame.method === 'session/request_permission') {
          const call = decodeOpenCodePermission(frame.params, tracked.get(frame.params.toolCall.toolCallId));
          if (!call) { throw new Error('Native permission payload could not be bound'); }
          cards.push(call);
          pendingChecks.push(existsSync(target));
          cancelTimer = setTimeout(() => {
            pendingChecks.push(existsSync(target));
            if (scenario === 'cancel-write') { write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); }
            write({ jsonrpc: '2.0', id: frame.id, result: { outcome: scenario === 'cancel-write' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: scenario === 'allow-write' ? 'once' : 'reject' } } });
          }, 150);
        } else if (frame.id === 'prompt') {
          if (frame.error) { throw new Error(JSON.stringify(frame.error)); }
          resultReceived = true; proc.stdin.end();
        } else if (frame.method && frame.id !== undefined) {
          write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported client operation' } });
        }
      } catch (error) { failure ||= error; proc.kill('SIGKILL'); }
    }
  });
  const timeout = setTimeout(() => { failure ||= new Error('Native fixture timed out'); proc.kill('SIGKILL'); }, 20000);
  write({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'mysti-test', version: '1' } } });
  try {
    const exit = await new Promise(resolve => { proc.once('close', (code, signal) => resolve({ code, signal })); proc.once('error', error => { failure ||= error; }); });
    return { scenario, exit, initializedVersion, failure: failure instanceof Error ? failure.message : failure, resultReceived, modelCalls, declaredTools, cards, pendingChecks, stderr, nativeFrames, modelInputs,
      exists: existsSync(target), content: existsSync(target) ? await fs.readFile(target, 'utf8') : undefined };
  } finally {
    clearTimeout(timeout); clearTimeout(cancelTimer);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('installed OpenCode native permission boundary', () => {
  it.skipIf(!supported)('rejects Core V2 project and ancestor authority before any process or model starts', { timeout: 10000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-authority-')));
    const evidence = path.join(project, 'out-test/release-evidence/GOAL_RELIABILITY_20260919', `opencode-authority-fixed-${Date.now()}`);
    await fs.mkdir(evidence, { recursive: true });
    try {
      for (const scenario of ['project-authority', 'ancestor-authority'] as const) {
        const result = await nativeCase(root, scenario);
        await fs.writeFile(path.join(evidence, `${scenario}.json`), JSON.stringify(result, null, 2));
        expect(result.failure, evidence).toContain('cannot isolate');
        expect(result.exit, evidence).toBeUndefined(); expect(result.nativeFrames, evidence).toHaveLength(0);
        expect(result.modelCalls, evidence).toBe(0); expect(result.cards, evidence).toHaveLength(0); expect(result.exists, evidence).toBe(false);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(!supported)('blocks real writes pending, rejects deny/cancel/read-only, and removes shell execution', { timeout: 140000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-native-opencode-')));
    const evidence = path.join(project, 'out-test/release-evidence', `item5-native-opencode-${Date.now()}`);
    await fs.mkdir(evidence, { recursive: true });
    try {
      for (const scenario of ['allow-write', 'deny-write', 'cancel-write', 'readonly-write', 'zero-pattern-shell', 'deny-read', 'public-write'] as const) {
        const result = await nativeCase(root, scenario);
        await fs.writeFile(path.join(evidence, `${scenario}.json`), JSON.stringify(result, null, 2));
        const diagnostic = `${evidence}\n${JSON.stringify(result)}`;
        expect(result.failure, diagnostic).toBeUndefined();
        expect(result.resultReceived, diagnostic).toBe(true);
        expect(result.initializedVersion, diagnostic).toBe(OPENCODE_ACP_VERSION);
        if (scenario !== 'public-write') { expect(result.exit, diagnostic).toEqual({ code: 0, signal: null }); }
        else { expect(result.exit, diagnostic).toBeDefined(); }
        expect(result.modelCalls, diagnostic).toBeGreaterThan(0);
        for (const names of result.declaredTools) {
          expect(names, diagnostic).not.toContain('bash'); expect(names, diagnostic).not.toContain('shell'); expect(names, diagnostic).not.toContain('task');
          if (scenario === 'readonly-write') { expect(names, diagnostic).not.toContain('write'); expect(names, diagnostic).not.toContain('edit'); }
        }
        if (scenario === 'allow-write' || scenario === 'public-write') {
          expect(result.pendingChecks, diagnostic).toEqual([false, false]); expect(result.content, diagnostic).toBe('approved');
        } else if (scenario === 'deny-read') {
          expect(result.cards, diagnostic).toHaveLength(1); expect(result.content, diagnostic).toBe('fixture-private-read');
          expect(JSON.stringify(result.modelInputs), diagnostic).not.toContain('fixture-private-read');
        } else {
          expect(result.exists, diagnostic).toBe(false);
          expect(result.cards, diagnostic).toHaveLength(scenario === 'readonly-write' || scenario === 'zero-pattern-shell' ? 0 : 1);
        }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
