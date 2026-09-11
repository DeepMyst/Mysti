import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpNativeClient, type AcpNativeClientOptions } from '../../../src/providers/base/AcpNativeClient';
import type { AcpNativeLaunch } from '../../../src/providers/base/AcpNativeTypes';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { StreamChunk } from '../../../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const roots: string[] = [];
const clients: AcpNativeClient[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  clients.splice(0).forEach(client => client.dispose());
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGKILL'); await closed;
    }
  }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});
const launch: AcpNativeLaunch = {
  args: [], expectedAgentInfo: { name: 'fixture', version: '1.0.0' },
  decodePermission: params => {
    const tool = params.toolCall as Record<string, unknown>;
    return { id: tool.toolCallId as string, name: 'Edit', input: tool.rawInput as Record<string, unknown>, status: 'running' };
  },
  decodeUsage: update => {
    const usage = update.usage as { inputTokens: number; outputTokens: number } | undefined;
    return usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : undefined;
  },
};
async function harness(scenario = 'normal', handler?: NativeApprovalHandler, extra: Partial<AcpNativeClientOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-acp-client-')); roots.push(root);
  const proc = spawn(process.execPath, [path.resolve(__dirname, '../../fixtures/acpNativeAgent.cjs'), root, scenario],
    { cwd: root, env: {}, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(proc);
  const controller = new AbortController();
  const terminate = vi.fn(() => proc.kill('SIGKILL'));
  const client = new AcpNativeClient({ process: proc, providerId: 'inert-acp', label: 'Inert ACP', panelId: root,
    signal: controller.signal, settings: { mode: 'ask-before-edit', accessLevel: 'ask-permission' },
    handler, launch, terminate, isCurrent: () => true, ...extra }); clients.push(client);
  const start = async () => { await client.initialize(); await client.newSession(root); client.startPrompt([{ type: 'text', text: 'inert task' }]); };
  const collect = async () => { const chunks: StreamChunk[] = []; for await (const chunk of client.stream()) { chunks.push(chunk); } return chunks; };
  const command = (method: string) => proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { root, marker: path.join(root, 'effect.txt'), proc, client, controller, terminate, start, collect, command };
}

describe('native ACP process approval authority', () => {
  it('holds the exact final input until allow_once, then records one effect and usage', async () => {
    const decision = deferred<boolean>(); const card = deferred<NativeApprovalRequest>();
    const h = await harness('normal', request => { card.resolve(request); return decision.promise; });
    await h.start(); const collecting = h.collect(); const request = await card.promise;
    expect(existsSync(h.marker)).toBe(false);
    expect(request.toolCall.input.content).toBe('executed\n');
    expect(Object.isFrozen(request.toolCall.input.nested)).toBe(true);
    decision.resolve(true);
    const chunks = await collecting;
    expect(await fs.readFile(h.marker, 'utf8')).toBe('executed\n');
    expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(1);
    expect(chunks.filter(chunk => chunk.type === 'error')).toHaveLength(0);
    expect(h.client.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(request.signal.aborted).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(h.root, 'initialize.json'), 'utf8')).clientCapabilities)
      .toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  });

  it.each(['deny', 'missing', 'readonly', 'persistent-only', 'decoder-deny'])('prevents effects for %s', async scenario => {
    const handler = vi.fn(async () => scenario !== 'deny');
    const h = await harness(scenario === 'persistent-only' ? scenario : 'normal', scenario === 'missing' ? undefined : handler,
      scenario === 'readonly' ? { settings: { mode: 'default', accessLevel: 'read-only' } }
        : scenario === 'decoder-deny' ? { launch: { ...launch, decodePermission: () => undefined } } : {});
    await h.start(); await h.collect();
    expect(existsSync(h.marker)).toBe(false);
    if (['readonly', 'persistent-only', 'decoder-deny'].includes(scenario)) { expect(handler).not.toHaveBeenCalled(); }
    expect(JSON.parse(await fs.readFile(path.join(h.root, 'response.json'), 'utf8')).outcome.optionId).not.toBe('yes');
  });

  it.each(['Stop', 'exit', 'changed input', 'completion', 'mode change'])('%s revokes pending permission and ignores late allow', async action => {
    const decision = deferred<boolean>(); const card = deferred<NativeApprovalRequest>();
    const h = await harness('normal', request => { card.resolve(request); return decision.promise; });
    await h.start(); const collecting = h.collect(); const request = await card.promise;
    if (action === 'Stop') { h.controller.abort(); }
    else if (action === 'exit') { h.proc.kill('SIGKILL'); }
    else { h.command(action === 'changed input' ? 'fixture/change' : action === 'completion' ? 'fixture/complete' : 'fixture/mode'); }
    await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
    decision.resolve(true); await collecting;
    expect(existsSync(h.marker)).toBe(false);
  });

  it.each(['replay', 'conflicting-tool', 'wrong-session', 'bad-json', 'unsupported'])('terminates invalid native protocol for %s without effects', async scenario => {
    const h = await harness(scenario, () => new Promise(() => {}));
    await h.start(); const chunks = await h.collect();
    expect(chunks.filter(chunk => chunk.type === 'error')).toHaveLength(1);
    expect(h.terminate).toHaveBeenCalled(); expect(existsSync(h.marker)).toBe(false);
  });

  it('revokes pending permission when the provider rejects changed native options', async () => {
    const decision = deferred<boolean>(); const card = deferred<NativeApprovalRequest>();
    const h = await harness('normal', request => { card.resolve(request); return decision.promise; }, { launch: { ...launch,
      validateUpdate(update) {
        if (update.sessionUpdate === 'config_option_update') {
          expect(Object.isFrozen(update.configOptions)).toBe(true);
          throw new Error('Native permission option changed.');
        }
      },
    } });
    await h.start(); const collecting = h.collect(); const request = await card.promise;
    h.command('fixture/config');
    await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
    decision.resolve(true);
    expect((await collecting).some(chunk => chunk.type === 'error' && chunk.content?.includes('permission option changed'))).toBe(true);
    expect(existsSync(h.marker)).toBe(false);
  });

  it('rejects an unsupported protocol version before creating a session or prompt', async () => {
    const h = await harness('bad-version');
    await expect(h.start()).rejects.toThrow('protocol version 1');
    expect(existsSync(path.join(h.root, 'prompt.json'))).toBe(false);
  });

  it('keeps independent panels and native request IDs separate', async () => {
    const firstDecision = deferred<boolean>(); const secondDecision = deferred<boolean>();
    const firstCard = deferred<NativeApprovalRequest>(); const secondCard = deferred<NativeApprovalRequest>();
    const a = await harness('normal', request => { firstCard.resolve(request); return firstDecision.promise; });
    const b = await harness('normal', request => { secondCard.resolve(request); return secondDecision.promise; });
    await Promise.all([a.start(), b.start()]);
    const collecting = Promise.all([a.collect(), b.collect()]);
    const [first, second] = await Promise.all([firstCard.promise, secondCard.promise]);
    expect(first.nativeRequestId).toBe(second.nativeRequestId); expect(first.id).not.toBe(second.id);
    a.controller.abort(); firstDecision.resolve(true); secondDecision.resolve(true); await collecting;
    expect(existsSync(a.marker)).toBe(false); expect(await fs.readFile(b.marker, 'utf8')).toBe('executed\n');
  });

  it('rejects a verified optional client write without granting host filesystem access', async () => {
    const h = await harness('optional-write', async () => true, { launch: { ...launch, nonFatalUnsupportedRequests: ['fs/write_text_file'] } });
    await h.start(); const chunks = await h.collect();
    expect(chunks.filter(chunk => chunk.type === 'error')).toHaveLength(0);
    expect(await fs.readFile(h.marker, 'utf8')).toBe('executed\n');
    expect(existsSync(path.join(h.root, 'host-write.txt'))).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(h.root, 'unsupported-response.json'), 'utf8')).code).toBe(-32601);
  });
});

describe('ACP inactivity and immediate process exit', () => {
  it('pauses the watchdog during approval and restarts it after settlement', async () => {
    vi.useFakeTimers();
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null }) as unknown as ChildProcess;
    const decision = deferred<boolean>(); const card = deferred<NativeApprovalRequest>();
    const terminate = vi.fn(); const controller = new AbortController();
    const client = new AcpNativeClient({ process: proc, providerId: 'fixture', label: 'fixture', panelId: 'panel', signal: controller.signal,
      handler: request => { card.resolve(request); return decision.promise; }, settings: { mode: 'ask-before-edit', accessLevel: 'ask-permission' },
      launch, isCurrent: () => true, terminate, inactivityTimeoutMs: 1000 }); clients.push(client);
    let input = '';
    proc.stdin!.on('data', data => {
      input += data.toString(); let line;
      while ((line = input.indexOf('\n')) >= 0) {
        const frame = JSON.parse(input.slice(0, line)); input = input.slice(line + 1);
        if (frame.method === 'initialize' || frame.method === 'session/new') {
          const result = frame.method === 'initialize' ? { protocolVersion: 1, agentInfo: { name: 'fixture', version: '1.0.0' } } : { sessionId: 'session' };
          (proc.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
        }
      }
    });
    await client.initialize(); await client.newSession('/fixture'); client.startPrompt([{ type: 'text', text: 'test' }]);
    (proc.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 'session',
      toolCall: { toolCallId: 'edit', rawInput: {} }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } }) + '\n');
    const request = await card.promise;
    await vi.advanceTimersByTimeAsync(30000); expect(terminate).not.toHaveBeenCalled();
    decision.resolve(false); await Promise.resolve(); expect(request.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(terminate).toHaveBeenCalledOnce();
  });
});
