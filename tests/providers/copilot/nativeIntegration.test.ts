/** Installed pinned agents, real tools, production public turns, inert local models. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { ClineProvider } from '../../../src/providers/cline/ClineProvider';
import { CopilotProvider } from '../../../src/providers/copilot/CopilotProvider';
import type { AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import type { Settings, StreamChunk, ToolCall } from '../../../src/types';
import { createMockContext } from '../../helpers/providerFactory';

const installed = { cline: '/usr/local/lib/node_modules/cline/bin/.cline', copilot: '/usr/local/bin/copilot' };
const supported = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
type Scenario = 'allow-command' | 'deny-command' | 'allow-write' | 'readonly-command' | 'cancel-command' | 'deny-write' | 'readonly-write' | 'cancel-write' | 'blocked-shell' | 'blocked-write' | 'read' | 'outside-read';

async function nativeCase(kind: keyof typeof installed, scenario: Scenario) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mysti-${kind}-native-`)));
  const work = path.join(directory, 'work'); await fs.mkdir(work);
  const target = path.join(work, 'marker.txt');
  if (scenario === 'read') { await fs.writeFile(target, 'inert existing content'); }
  // Outside both the workspace and the private TMPDIR, which Copilot trusts.
  const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-copilot-outside-')));
  const outside = path.join(outsideDir, 'outside-secret.txt');
  if (scenario === 'outside-read') { await fs.writeFile(outside, 'inert outside secret'); }
  const bodies: string[] = [];
  let calls = 0; let stderr = ''; let frames = ''; const cards: ToolCall[] = []; const pendingChecks: boolean[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) { raw += chunk; }
    bodies.push(raw); const body = JSON.parse(raw); const first = ++calls === 1;
    const command = `printf approved >> ${target}`;
    const write = scenario.endsWith('-write');
    const name = kind === 'cline' ? (write ? 'editor' : 'run_commands') : scenario === 'read' || scenario === 'outside-read' ? 'view' : (write ? 'apply_patch' : 'bash');
    const input = kind === 'cline'
      ? (write ? { path: target, new_text: 'approved' } : { commands: [command] })
      : scenario === 'read' ? { path: target } : scenario === 'outside-read' ? { path: outside } : (write ? { input: `*** Begin Patch\n*** Add File: ${target}\n+approved\n*** End Patch` } : { command, description: 'Write inert marker' });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (kind === 'cline') {
      const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit('message_start', { message: { id: 'fixture-message', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      emit('content_block_start', { index: 0, content_block: first ? { type: 'tool_use', id: 'fixture-tool', name, input: {} } : { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: first ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'complete' } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      emit('message_stop', {});
    } else {
      const emit = (delta: object, finishReason: string | null) => response.write(`data: ${JSON.stringify({ id: 'fixture-message', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      emit(first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { role: 'assistant', content: 'complete' }, null);
      emit({}, first ? 'tool_calls' : 'stop'); response.write('data: [DONE]\n\n');
    }
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let nativeClosed: Promise<void> | undefined;
  const Provider = kind === 'cline' ? ClineProvider : CopilotProvider;
  class NativeProvider extends Provider {
    protected override async _prepareAcpLaunch(context: AcpNativeLaunchContext) {
      const fixtureEnv = { PATH: process.env.PATH, TMPDIR: directory, ...(kind === 'cline'
        ? { CLINE_API_KEY: 'mysti-inert-fixture', CLINE_PROVIDER: 'anthropic' }
        : { COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`, COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_MODEL_ID: 'gpt-4o' }) };
      const launch = await super._prepareAcpLaunch({ ...context, env: fixtureEnv });
      if (kind === 'cline') {
        // Synthetic model routing in this turn's new private profile only.
        const settingsDir = path.join(launch.env!.CLINE_DATA_DIR!, 'settings'); await fs.mkdir(settingsDir, { recursive: true });
        await fs.writeFile(path.join(settingsDir, 'providers.json'), JSON.stringify({ version: 1, providers: { anthropic: { settings: { provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'mysti-inert-fixture', model: 'claude-sonnet-4-5' }, updatedAt: '2026-09-11T00:00:00Z', tokenSource: 'manual' } } }));
      }
      return launch;
    }
    protected override _spawnCliProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
      const state = realpathSync(env.CLINE_DIR ?? env.COPILOT_HOME!);
      const literal = (value: string) => JSON.stringify(value);
      const sandbox = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${port}"))`
        + `(deny file-read* (subpath ${literal(os.homedir())}))`
        + `(deny file-write* (require-all (require-not (subpath ${literal(directory)})) (require-not (subpath ${literal(state)})) (require-not (subpath "/dev"))))`;
      const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, installed[kind], ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      nativeClosed = new Promise(resolve => child.once('close', () => resolve()));
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000); });
      child.stdout.on('data', chunk => { frames = (frames + chunk).slice(-18000); });
      return child;
    }
  }
  const provider = new NativeProvider(createMockContext());
  const folder = vscode.workspace.workspaceFolders![0]; const previous = folder.uri.fsPath;
  Object.defineProperty(folder.uri, 'fsPath', { configurable: true, value: work });
  provider.setNativeApprovalHost({ handlerForPanel: () => async request => {
    cards.push(request.toolCall); pendingChecks.push(existsSync(target));
    await new Promise(resolve => setTimeout(resolve, 200)); pendingChecks.push(existsSync(target));
    if (scenario.startsWith('cancel-')) { provider.cancelCurrentRequest('native-fixture'); return true; }
    return scenario.startsWith('allow-');
  } });
  const settings: Settings = { provider: provider.id, model: kind === 'cline' ? 'claude-sonnet-4-5' : 'gpt-4o', mode: 'default', accessLevel: scenario.startsWith('readonly-') ? 'read-only' : 'ask-permission', contextMode: 'auto', thinkingLevel: 'none' };
  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage('/allow-all on\nWrite the inert marker.', [], settings, null, undefined, 'native-fixture')) { chunks.push(chunk); }
    expect(pendingChecks.every(value => value === false)).toBe(true);
    expect(chunks.filter(chunk => chunk.type === 'error'), stderr).toEqual([]);
    expect(calls, stderr).toBeGreaterThan(0);
    if (scenario.startsWith('allow-')) {
      expect(cards, stderr + frames).toHaveLength(1); expect((await fs.readFile(target, 'utf8')).trim()).toBe('approved');
      expect(cards[0].name).toBe(scenario === 'allow-command' ? 'Bash' : 'Edit');
    } else if (scenario === 'read') { expect(await fs.readFile(target, 'utf8')).toBe('inert existing content'); expect(cards).toHaveLength(0); }
    else if (scenario === 'outside-read') { expect(bodies.join('\n'), stderr + frames).not.toContain('inert outside secret'); expect(cards).toHaveLength(0); }
    else { expect(existsSync(target), stderr).toBe(false); }
    if (scenario.startsWith('deny-') || scenario.startsWith('cancel-')) { expect(cards, stderr).toHaveLength(1); }
    if (scenario.startsWith('readonly-') || scenario === 'blocked-shell') { expect(cards).toHaveLength(0); }
  } finally {
    provider.dispose(); Object.defineProperty(folder.uri, 'fsPath', { configurable: true, value: previous });
    if (nativeClosed) { await nativeClosed; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
}

for (const kind of ['cline', 'copilot'] as const) {
  describe.skipIf(!supported || !existsSync(installed[kind]))(`${kind} installed native ACP`, () => {
    it.each<Scenario>(kind === 'cline' ? ['allow-command', 'deny-command', 'allow-write', 'readonly-command', 'cancel-command'] : ['blocked-write', 'readonly-write', 'blocked-shell', 'readonly-command', 'read', 'outside-read'])('%s with no real model or credential access', async scenario => {
      await nativeCase(kind, scenario);
    }, 60000);
  });
}
