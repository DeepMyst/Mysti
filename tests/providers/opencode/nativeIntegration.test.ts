/** Installed native OpenCode with a local inert model and OS isolation (macOS sandbox-exec only). */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { decodeOpenCodePermission, openCodeIsolatedEnv, openCodeNativeConfig, prepareOpenCodeNativeLaunch, OPENCODE_ACP_VERSION, OPENCODE_HOST_AGENT } from '../../../src/providers/opencode/OpenCodeNative';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import { OpenCodeProvider } from '../../../src/providers/opencode/OpenCodeProvider';
import type { AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import { createMockContext } from '../../helpers/providerFactory';
import type { Settings, StreamChunk } from '../../../src/types';

const installed = process.env.MYSTI_TEST_OPENCODE_PATH || '/usr/local/bin/opencode';
const supported = process.platform === 'darwin' && existsSync(installed) && existsSync('/usr/bin/sandbox-exec');
const project = path.resolve(__dirname, '../../..');
// Native startup alone took 22 s at load average ~70 during review; a bound
// that fails a correct run is not a safety property.
const CASE_BOUND_MS = 60000;
const evidenceDir = (name: string) => path.join(project, 'out-test/release-evidence/FU_OPENCODE_20260923', `${name}-${Date.now()}`);
const baseSettings: Settings = { provider: 'opencode', model: 'anthropic/claude-sonnet-4-5', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' };
type Scenario = 'allow-write' | 'deny-write' | 'cancel-write' | 'readonly-write' | 'zero-pattern-shell' | 'deny-read' | 'public-write' | 'project-authority' | 'ancestor-authority' | 'stop-active-shell'
  | 'ungated-no-pattern' | 'shell-no-pattern' | 'shell-allow' | 'shell-deny' | 'shell-background' | 'stop-background' | 'stop-orphaned-background' | 'shell-readonly' | 'extra-plugin' | 'missing-gate';
const shellCommand = (scenario: Scenario, target: string, started: string): string | undefined => ({
  'zero-pattern-shell': `> ${target}`, 'ungated-no-pattern': `> ${target}`, 'shell-no-pattern': `> ${target}`,
  'shell-allow': `printf approved > ${target}`, 'shell-deny': `printf approved > ${target}`, 'shell-readonly': `printf approved > ${target}`,
  'shell-background': `(sleep 4; printf late > ${target}) & printf started > ${started}`,
  'stop-background': `(sleep 2; printf late > ${target}) & printf started > ${started}`,
  'stop-orphaned-background': `(sleep 3; printf late > ${target}) & printf started > ${started}`,
  'stop-active-shell': `printf started > ${started}; (sleep 2; printf late >> ${target}) & wait`,
  'extra-plugin': `printf approved > ${target}`, 'missing-gate': `printf approved > ${target}`,
} as Partial<Record<Scenario, string>>)[scenario];
const publicPath = (scenario: Scenario) => scenario === 'public-write' || scenario.startsWith('shell-') || scenario.endsWith('-authority')
  || scenario.startsWith('stop-') || scenario === 'extra-plugin' || scenario === 'missing-gate';

async function nativeCase(root: string, scenario: Scenario) {
  const directory = path.join(root, scenario);
  const work = path.join(directory, 'work');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(directory, 'empty.npmrc'), '');
  await fs.writeFile(path.join(directory, 'empty-global.npmrc'), '');
  const target = path.join(work, 'marker.txt');
  const started = path.join(work, 'started.txt');
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
      const command = shellCommand(scenario, target, started);
      const name = command ? 'bash' : scenario === 'deny-read' ? 'read' : 'write';
      const input = command ? { command, description: 'inert shell fixture' }
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
  const settings = scenario === 'readonly-write' || scenario === 'shell-readonly' ? { ...baseSettings, accessLevel: 'read-only' as const } : baseSettings;
  const provider = { anthropic: { options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mysti-inert-fixture' } } };
  const config = openCodeNativeConfig(settings, baseSettings.model);
  if (scenario === 'ungated-no-pattern') {
    // Witness only: what shell `ask` means in this release without Mysti's gate.
    const permission = { ...(config.permission as Record<string, string>), bash: 'ask' };
    config.permission = permission;
    (config.agent as Record<string, Record<string, unknown>>)[OPENCODE_HOST_AGENT].permission = permission;
  }
  // Only the model HTTP endpoint differs from production policy/configuration.
  config.provider = provider;
  const env = openCodeIsolatedEnv({ PATH: process.env.PATH, TMPDIR: directory, ANTHROPIC_API_KEY: 'mysti-inert-fixture' }, directory, config, 'anthropic');
  const sandbox = (writable: string) => `(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))`
    + `(deny file-read* (subpath "${os.homedir()}"))`
    + `(deny file-write* (require-all (require-not (subpath "${root}")) (require-not (subpath "${writable}")) (require-not (subpath "/dev"))))`;
  if (publicPath(scenario)) {
    let spawnedAt = 0; const frameTimes: number[] = [];
    let nativeClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    class NativeProvider extends OpenCodeProvider {
      override getCliPath() { return installed; }
      protected override async _prepareAcpLaunch(context: AcpNativeLaunchContext) {
        const launch = await super._prepareAcpLaunch({ ...context, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'mysti-inert-fixture' } });
        // Keep the production preparation, policy, plugin and attestation;
        // redirect only model HTTP to the inert local fixture.
        const productionConfig = JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!);
        const privateDir = path.dirname(launch.env!.XDG_CONFIG_HOME!);
        if (scenario === 'extra-plugin') {
          // A plugin source appearing after the pre-launch checks: the private
          // global plugin directory stands in for any late V1 plugin origin.
          const extra = path.join(launch.env!.XDG_CONFIG_HOME!, 'opencode', 'plugins', 'late.js');
          await fs.mkdir(path.dirname(extra), { recursive: true });
          await fs.writeFile(extra, `import fs from 'node:fs'; export default async () => { fs.writeFileSync(${JSON.stringify(path.join(work, 'extra-ran.txt'))}, 'ran'); return {}; };`);
        }
        if (scenario === 'missing-gate') { await fs.rm(path.join(privateDir, 'mysti-shell-gate.mjs')); }
        return { ...launch, env: { ...launch.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...productionConfig, provider }) } };
      }
      protected override _spawnCliProcess(args: string[], cwd: string, childEnv: NodeJS.ProcessEnv) {
        spawnedAt = Date.now();
        const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox(path.dirname(childEnv.XDG_CONFIG_HOME!)), installed, ...args], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        nativeClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
        let pending = '';
        child.stdout.on('data', data => {
          pending += data;
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (line.trim()) { nativeFrames.push(JSON.parse(line)); frameTimes.push(Date.now() - spawnedAt); }
          }
        });
        return child;
      }
    }
    const native = new NativeProvider(createMockContext());
    const folder = vscode.workspace.workspaceFolders![0];
    const oldCwd = folder.uri.fsPath;
    Object.defineProperty(folder.uri, 'fsPath', { configurable: true, value: work });
    native.setNativeApprovalHost({ handlerForPanel: () => async request => {
      cards.push(request.toolCall); pendingChecks.push(existsSync(target), existsSync(started));
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      pendingChecks.push(existsSync(target), existsSync(started)); return scenario !== 'shell-deny';
    } });
    const chunks: StreamChunk[] = [];
    let stoppedActive = false;
    const activeStop = scenario.startsWith('stop-') ? setInterval(() => {
      if (existsSync(started)) {
        stoppedActive = true; clearInterval(activeStop);
        // Let the foreground shell exit first so the background job is orphaned.
        setTimeout(() => native.cancelCurrentRequest('native-panel'), scenario === 'stop-orphaned-background' ? 1000 : 0);
      }
    }, 25) : undefined;
    const bounded = setTimeout(() => { failure ||= new Error('Native public fixture timed out'); native.cancelCurrentRequest('native-panel'); }, CASE_BOUND_MS);
    try {
      for await (const chunk of native.sendMessage('inert fixture', [], settings, null, undefined, 'native-panel')) { chunks.push(chunk); }
      clearInterval(activeStop);
      // Outlive the native shell's delayed background write.
      if (scenario.startsWith('stop-') || scenario === 'shell-background') { await new Promise(resolve => setTimeout(resolve, 5000)); }
      const errors = chunks.filter(chunk => chunk.type === 'error');
      if (errors.length) { failure ||= new Error(JSON.stringify(errors)); }
      initializedVersion = nativeFrames.find(frame => frame.result?.agentInfo)?.result?.agentInfo?.version;
      resultReceived = chunks.at(-1)?.type === 'done' && errors.length === 0;
      return { scenario, exit: await nativeClosed, initializedVersion, failure: failure instanceof Error ? failure.message : failure,
        resultReceived, modelCalls, declaredTools, cards, pendingChecks, stderr, nativeFrames, modelInputs, chunks, stoppedActive,
        frameTimes, extraPluginRan: existsSync(path.join(work, 'extra-ran.txt')), started: existsSync(started),
        exists: existsSync(target), content: existsSync(target) ? await fs.readFile(target, 'utf8') : undefined };
    } finally {
      clearTimeout(bounded); clearInterval(activeStop);
      native.dispose(); Object.defineProperty(folder.uri, 'fsPath', { configurable: true, value: oldCwd });
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  const proc = spawn('/usr/bin/sandbox-exec', ['-p', sandbox(directory), installed, 'acp', '--pure', '--hostname', '127.0.0.1', '--port', '0', '--cwd', work], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const timeout = setTimeout(() => { failure ||= new Error('Native fixture timed out'); proc.kill('SIGKILL'); }, CASE_BOUND_MS);
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
  it.skipIf(process.platform === 'darwin')('keeps OpenCode shell removed on this platform: the native gate is verified on macOS only', async () => {
    const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-platform-')));
    try {
      const launch = await prepareOpenCodeNativeLaunch({ settings: baseSettings, session: createOpenCodeSession(), cwd,
        env: { ANTHROPIC_API_KEY: 'inert-fixture' }, cliPath: '/inert', signal: new AbortController().signal }, baseSettings.model);
      try {
        expect(launch.args).toContain('--pure'); expect(launch.env!.OPENCODE_PURE).toBe('true');
        expect(JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!).plugin).toEqual([]);
        expect(JSON.parse(launch.env!.OPENCODE_PERMISSION!)).toMatchObject({ '*': 'deny' });
      } finally { await launch.cleanup!(); }
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  });
  it.skipIf(!supported)('rejects Core V2 project and ancestor authority before any process or model starts', { timeout: 150000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-authority-')));
    const evidence = evidenceDir('authority');
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
  it.skipIf(!supported)('upstream witness: shell `ask` alone runs a no-pattern command with no permission request', { timeout: 90000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-witness-')));
    const evidence = evidenceDir('ungated-witness');
    await fs.mkdir(evidence, { recursive: true });
    try {
      // If this starts failing, upstream changed tool/shell.ts `ask`; re-audit the gate.
      const result = await nativeCase(root, 'ungated-no-pattern');
      await fs.writeFile(path.join(evidence, 'ungated-no-pattern.json'), JSON.stringify(result, null, 2));
      const diagnostic = `${evidence}\n${JSON.stringify({ ...result, nativeFrames: undefined, stderr: undefined })}`;
      expect(result.initializedVersion, diagnostic).toBe(OPENCODE_ACP_VERSION);
      expect(result.declaredTools[0], diagnostic).toContain('bash');
      expect(result.cards, diagnostic).toHaveLength(0); expect(result.exists, diagnostic).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(!supported)('gates every tested shell shape through one native approval before it runs', { timeout: 400000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-shell-')));
    const evidence = evidenceDir('shell-gate');
    await fs.mkdir(evidence, { recursive: true });
    try {
      for (const scenario of ['shell-allow', 'shell-deny', 'shell-no-pattern', 'shell-background', 'shell-readonly'] as const) {
        const result = await nativeCase(root, scenario);
        await fs.writeFile(path.join(evidence, `${scenario}.json`), JSON.stringify(result, null, 2));
        const diagnostic = `${evidence}\n${JSON.stringify({ ...result, nativeFrames: undefined, stderr: undefined, modelInputs: undefined })}`;
        expect(result.failure, diagnostic).toBeUndefined(); expect(result.resultReceived, diagnostic).toBe(true);
        expect(result.initializedVersion, diagnostic).toBe(OPENCODE_ACP_VERSION);
        for (const names of result.declaredTools) {
          if (scenario === 'shell-readonly') { expect(names, diagnostic).not.toContain('bash'); } else { expect(names, diagnostic).toContain('bash'); }
          expect(names, diagnostic).not.toContain('task');
        }
        // Nothing ran while a card was pending (target, started marker).
        expect(result.pendingChecks.every(check => check === false), diagnostic).toBe(true);
        const shellResult = result.chunks.find(chunk => chunk.type === 'tool_result')?.toolCall;
        if (scenario === 'shell-allow' || scenario === 'shell-deny' || scenario === 'shell-background') {
          expect(result.cards, diagnostic).toEqual([expect.objectContaining({ name: 'Bash', input: { command: expect.any(String) } })]);
          expect((result.cards[0] as { input: { command: string } }).input.command, diagnostic).toBe(shellCommand(scenario, path.join(root, scenario, 'work', 'marker.txt'), path.join(root, scenario, 'work', 'started.txt')));
        } else { expect(result.cards, diagnostic).toHaveLength(0); }
        if (scenario === 'shell-allow') { expect(result.content, diagnostic).toBe('approved'); }
        else if (scenario === 'shell-background') { expect(result.started, diagnostic).toBe(true); expect(result.content, diagnostic).toBe('late'); }
        else { expect(result.exists, diagnostic).toBe(false); expect(result.started, diagnostic).toBe(false); }
        if (scenario === 'shell-no-pattern') { expect(shellResult?.output, diagnostic).toContain('did not submit for approval'); }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(!supported)('Stop leaves no late effect from a running, background or orphaned background shell', { timeout: 300000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-stop-')));
    const evidence = evidenceDir('shell-stop');
    await fs.mkdir(evidence, { recursive: true });
    try {
      for (const scenario of ['stop-active-shell', 'stop-background', 'stop-orphaned-background'] as const) {
        const result = await nativeCase(root, scenario);
        await fs.writeFile(path.join(evidence, `${scenario}.json`), JSON.stringify(result, null, 2));
        const diagnostic = `${evidence}\n${JSON.stringify({ ...result, nativeFrames: undefined, stderr: undefined, modelInputs: undefined })}`;
        expect(result.initializedVersion, diagnostic).toBe(OPENCODE_ACP_VERSION);
        expect(result.cards, diagnostic).toHaveLength(1);
        expect(result.stoppedActive, diagnostic).toBe(true); expect(result.started, diagnostic).toBe(true);
        expect(result.exists, diagnostic).toBe(false);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(!supported)('refuses the turn before any model call when the gate is missing or another plugin loaded', { timeout: 150000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-opencode-attest-')));
    const evidence = evidenceDir('shell-attestation');
    await fs.mkdir(evidence, { recursive: true });
    try {
      for (const scenario of ['missing-gate', 'extra-plugin'] as const) {
        const result = await nativeCase(root, scenario);
        await fs.writeFile(path.join(evidence, `${scenario}.json`), JSON.stringify(result, null, 2));
        const diagnostic = `${evidence}\n${JSON.stringify({ ...result, nativeFrames: undefined, stderr: undefined })}`;
        expect(result.failure, diagnostic).toContain('did not attest');
        expect(result.modelCalls, diagnostic).toBe(0); expect(result.cards, diagnostic).toHaveLength(0);
        // Detection, not prevention: a plugin source that appears after the
        // pre-launch checks has already run its load-time code.
        expect(result.extraPluginRan, diagnostic).toBe(scenario === 'extra-plugin');
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(!supported)('blocks real writes pending, rejects deny/cancel/read-only, and keeps shell out of pure launches', { timeout: 450000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-native-opencode-')));
    const evidence = evidenceDir('file-matrix');
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
          // The public launch is shell-enabled through the gate; raw pure launches never declare shell.
          if (scenario !== 'public-write') { expect(names, diagnostic).not.toContain('bash'); expect(names, diagnostic).not.toContain('shell'); }
          expect(names, diagnostic).not.toContain('task');
          if (scenario === 'readonly-write') { expect(names, diagnostic).not.toContain('write'); expect(names, diagnostic).not.toContain('edit'); }
        }
        if (scenario === 'allow-write' || scenario === 'public-write') {
          expect(result.pendingChecks.every(check => check === false), diagnostic).toBe(true); expect(result.content, diagnostic).toBe('approved');
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
