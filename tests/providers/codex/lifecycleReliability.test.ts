import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, createMockMemento, setMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';
import { ChatViewProvider } from '../../../src/providers/ChatViewProvider';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: mocks.kill,
}));

const providers: TestableCodexProvider[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(async () => {
  providers.splice(0).forEach(provider => provider.dispose());
  await tick();
  vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});

function harness() {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  const provider = new TestableCodexProvider(); providers.push(provider);
  const settings: Settings = { provider: 'openai-codex', model: provider.config.defaultModel, mode: 'quick-plan',
    accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none', effortLevel: 'low' };
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/codex');
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
  type Rpc = { id: number; method: string; params?: Record<string, any> };
  type Child = { process: ChildProcess; args: string[]; received: Rpc[]; emit(value: unknown): void };
  const children: Child[] = [];
  let onTurn: ((child: Child, rpc: Rpc) => void) | undefined;
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 76000 + children.length,
      exitCode: null, signalCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess;
    const child: Child = { process, args, received: [], emit: value => { stdout.write(JSON.stringify(value) + '\n'); } };
    children.push(child);
    let buffer = '';
    stdin.on('data', bytes => {
      buffer += bytes.toString(); let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const rpc: Rpc = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); child.received.push(rpc);
        setImmediate(() => {
          if (rpc.method === 'initialize') child.emit({ id: rpc.id, result: {} });
          else if (rpc.method === 'config/read') child.emit({ id: rpc.id, result: { config: {} } });
          else if (rpc.method === 'thread/start' || rpc.method === 'thread/resume') {
            child.emit({ id: rpc.id, result: { thread: { id: 'owned-native-thread', turns: [] } } });
          } else if (rpc.method === 'turn/start') { const receive = onTurn; onTurn = undefined; receive?.(child, rpc); }
        });
      }
    });
    return process;
  });
  const start = async (content: string, overrides: Partial<Settings> = {}) => {
    const received = new Promise<{ child: Child; rpc: Rpc }>(resolve => { onTurn = (child, rpc) => resolve({ child, rpc }); });
    const completion = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.sendMessage(content, [], { ...settings, ...overrides }, null, undefined, 'panel')) chunks.push(chunk);
      return chunks;
    })();
    const { child, rpc } = await received;
    return { child, rpc, completion, complete: async (id: string) => {
      child.emit({ id: rpc.id, result: { turn: { id } } });
      child.emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned-native-thread', turnId: id, itemId: `reply-${id}`, delta: content } });
      child.emit({ method: 'turn/completed', params: { threadId: 'owned-native-thread', turn: { id, status: 'completed' } } });
      const chunks = await completion;
      expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([]);
      expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe(content);
      return chunks;
    } };
  };
  return { provider, start, children, settings };
}

function modelSelectionHost(provider: TestableCodexProvider, discovered: string[] = []) {
  // Model selection depends on VS Code's settled write/read behavior; the
  // shared stub otherwise records writes without updating configuration.
  vi.spyOn(vscode.workspace.getConfiguration('mysti'), 'update').mockImplementation(async (key, value) => { setMockConfig(key, value); });
  const messages: Array<{type: string; payload?: any}> = [];
  const state = { id: 'panel', currentConversationId: 'conversation', settingsOverrides: { agent: provider.id, provider: provider.id },
    webview: { postMessage: (message: any) => { messages.push(message); return Promise.resolve(true); } } };
  const host: any = Object.create(ChatViewProvider.prototype);
  Object.assign(host, {
    _panelStates: new Map([['panel', state]]), _sidebarId: 'panel', _extensionContext: { globalState: createMockMemento() },
    _providerManager: {
      getProvider: (id: string) => id === provider.id ? provider.config : undefined,
      getProviders: () => [provider.config], getProviderInstance: () => provider,
      getModels: () => [...provider.config.models, ...discovered.map(id => ({ id, name: id }))],
    },
    _tryPreSpawnPersistentProcess: vi.fn(),
  });
  return { host, messages, async select(model: string, customModel: string) {
    await host._handleMessage({ type: 'updateSettings', panelId: 'panel', payload: { model, customModel } });
    return messages.filter(value => value.type === 'modelChanged').at(-1)!.payload;
  } };
}

describe('Codex app-server lifecycle ownership through public sends', () => {
  it.each([
    { progress: 'streamed', final: 'streamed', beforeAck: false },
    { progress: 'final-only', final: 'final-only', beforeAck: false },
    { progress: 'streamed', final: 'final-only', beforeAck: false },
    { progress: 'final-only', final: 'streamed', beforeAck: false },
    { progress: 'streamed', final: 'streamed', beforeAck: true },
  ])('separates distinct assistant items ($progress → $final, beforeAck=$beforeAck) without altering tool output', async ({ progress, final, beforeAck }) => {
    const h = harness(), sent = await h.start('Inspect the file and report the result.');
    const notify = (method: string, extra: Record<string, unknown>) => sent.child.emit({ method,
      params: { threadId: 'owned-native-thread', turnId: 'item-boundaries', ...extra } });
    const message = (id: string, parts: string[], delivery: string) => {
      notify('item/started', { item: { id, type: 'agentMessage' } });
      if (delivery === 'streamed') {
        for (const delta of parts) { notify('item/agentMessage/delta', { itemId: id, delta }); }
      }
      notify('item/completed', { item: { id, type: 'agentMessage', text: parts.join('') } });
    };
    const acknowledge = () => sent.child.emit({ id: sent.rpc.id, result: { turn: { id: 'item-boundaries' } } });
    if (!beforeAck) { acknowledge(); }
    message('progress', ['I inspected ', 'the file.'], progress);
    notify('item/started', { item: { id: 'read-file', type: 'commandExecution', command: 'cat retry.cjs', cwd: '/controlled' } });
    notify('item/completed', { item: { id: 'read-file', type: 'commandExecution', command: 'cat retry.cjs', cwd: '/controlled',
      status: 'completed', aggregatedOutput: 'exact tool bytes\n' } });
    message('final', ['Fixture identity: ', '`service-🧪`.'], final);
    notify('turn/completed', { turn: { id: 'item-boundaries', status: 'completed' } });
    if (beforeAck) { acknowledge(); }
    const chunks = await sent.completion;
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join(''))
      .toBe('I inspected the file.\n\nFixture identity: `service-🧪`.');
    expect(chunks.filter(chunk => chunk.type === 'tool_result').map(chunk => chunk.toolCall?.output)).toEqual(['exact tool bytes\n']);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([]);
    // A continued native session starts a new response, with no separator
    // carried over from the previous turn's final item.
    const continued = await h.start('Next response starts here.');
    expect(continued.child).toBe(sent.child);
    await continued.complete('next-turn');
  });

  it('preserves every byte of split Markdown and Unicode within one assistant item', async () => {
    const h = harness(), sent = await h.start('Return the source code.');
    sent.child.emit({ id: sent.rpc.id, result: { turn: { id: 'split-item' } } });
    const parts = ['```js\nconst value = "', '🧪', '";\n', '```\n\n', '**Result', ':** intact.'];
    for (const delta of parts) {
      sent.child.emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned-native-thread', turnId: 'split-item', itemId: 'one-item', delta } });
    }
    sent.child.emit({ method: 'item/completed', params: { threadId: 'owned-native-thread', turnId: 'split-item',
      item: { id: 'one-item', type: 'agentMessage', text: parts.join('') } } });
    sent.child.emit({ method: 'turn/completed', params: { threadId: 'owned-native-thread', turn: { id: 'split-item', status: 'completed' } } });
    const chunks = await sent.completion;
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(parts);
  });

  it('does not add a redundant separator when the next item streams its leading blank line in separate chunks', async () => {
    const h = harness(), sent = await h.start('Keep the already formatted paragraphs.');
    sent.child.emit({ id: sent.rpc.id, result: { turn: { id: 'split-boundary' } } });
    for (const [itemId, delta] of [['progress', 'Progress.'], ['final', '\n'], ['final', '\n'], ['final', 'Final.']]) {
      sent.child.emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned-native-thread', turnId: 'split-boundary', itemId, delta } });
    }
    sent.child.emit({ method: 'turn/completed', params: { threadId: 'owned-native-thread', turn: { id: 'split-boundary', status: 'completed' } } });
    const chunks = await sent.completion;
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('Progress.\n\nFinal.');
  });

  it.each([
    { progress: 'Progress.', final: ['\r', '\n', '\r', '\n', 'Final.'] },
    { progress: 'Progress.\n', final: ['\r', '\n', 'Final.'] },
  ])('preserves an existing CRLF boundary split into individual carriage-return/line-feed deltas: $progress', async ({ progress, final }) => {
    const h = harness(), sent = await h.start('Preserve split CRLF formatting.');
    sent.child.emit({ id: sent.rpc.id, result: { turn: { id: 'split-crlf' } } });
    for (const [itemId, delta] of [['progress', progress], ...final.map(part => ['final', part])]) {
      sent.child.emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned-native-thread', turnId: 'split-crlf', itemId, delta } });
    }
    sent.child.emit({ method: 'turn/completed', params: { threadId: 'owned-native-thread', turn: { id: 'split-crlf', status: 'completed' } } });
    const chunks = await sent.completion;
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe(progress + final.join(''));
  });

  it.each([
    { first: ['Progress.\n\n'], second: 'Final.' },
    { first: ['Progress.\n', '\n'], second: 'Final.' },
    { first: ['Progress.'], second: '\n\nFinal.' },
    { first: ['Progress.\n'], second: '\nFinal.' },
    { first: ['Progress.\r\n', '\r\n'], second: 'Final.' },
  ])('retains an existing paragraph boundary across assistant items: $first / $second', async ({ first, second }) => {
    const h = harness(), sent = await h.start('Preserve the existing formatting.');
    sent.child.emit({ id: sent.rpc.id, result: { turn: { id: 'existing-boundary' } } });
    for (const delta of first) {
      sent.child.emit({ method: 'item/agentMessage/delta', params: { threadId: 'owned-native-thread', turnId: 'existing-boundary', itemId: 'progress', delta } });
    }
    sent.child.emit({ method: 'item/completed', params: { threadId: 'owned-native-thread', turnId: 'existing-boundary',
      item: { id: 'empty', type: 'agentMessage', text: '' } } });
    sent.child.emit({ method: 'item/completed', params: { threadId: 'owned-native-thread', turnId: 'existing-boundary',
      item: { id: 'final', type: 'agentMessage', text: second } } });
    sent.child.emit({ method: 'turn/completed', params: { threadId: 'owned-native-thread', turn: { id: 'existing-boundary', status: 'completed' } } });
    const chunks = await sent.completion;
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe(first.join('') + second);
  });

  it.each([
    { model: 'gpt-6.1-sol', discovered: false },
    { model: 'future-codex-deployment', discovered: true },
  ])('runs the provider-owned $model acknowledged by the public picker after clearing its custom override', async ({ model, discovered }) => {
    const h = harness(), selection = modelSelectionHost(h.provider, discovered ? [model] : []);
    expect(h.provider.config.models.some(value => value.id === model)).toBe(false);
    // A custom model is inserted into the visible menu. Picking its ordinary
    // row later intentionally clears the override, not the model selection.
    expect(await selection.select(model, model)).toEqual({ provider: h.provider.id, model, customModel: model });
    const acknowledged = await selection.select(model, '');
    expect(acknowledged).toEqual({ provider: h.provider.id, model, customModel: '' });
    const settings = selection.host._withResolvedModel({ ...h.settings, model: acknowledged.model });
    const sent = await h.start('Use the explicitly selected model.', settings);
    await sent.complete('selected');
    expect(sent.child.received.find(value => value.method === 'thread/start')?.params?.model).toBe(model);
    expect(h.provider.getEffectiveModelForSettings(settings)).toBe(model);
  });

  it('keeps another provider’s inherited model from becoming the Codex native model', async () => {
    const h = harness();
    const sent = await h.start('Use the Codex default for an inherited foreign selection.', { provider: 'qwen-code', model: 'qwen3-coder' });
    await sent.complete('foreign-settings');
    expect(sent.child.received.find(value => value.method === 'thread/start')?.params?.model).toBe(h.provider.config.defaultModel);
  });

  it('sends an explicitly selected unavailable model unchanged and surfaces the native rejection without substituting a default', async () => {
    const h = harness(), selection = modelSelectionHost(h.provider);
    const model = 'pb02-intentionally-unavailable-model';
    const acknowledged = await selection.select(model, '');
    const sent = await h.start('Check this explicitly selected model.', { model: acknowledged.model });
    sent.child.emit({ id: sent.rpc.id, error: { code: -32000, message: `Model ${model} is unavailable.` } });
    const chunks = await sent.completion;
    expect(sent.child.received.find(value => value.method === 'thread/start')?.params?.model).toBe(model);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([expect.objectContaining({ content: `Codex turn/start failed: Model ${model} is unavailable.` })]);
    expect(h.children).toHaveLength(1);
    const replacement = await selection.select(h.provider.config.defaultModel, '');
    const recovered = await h.start('Retry on the explicitly chosen default.', { model: replacement.model });
    expect(recovered.child).not.toBe(sent.child);
    await recovered.complete('explicit-model-recovery');
  });

  it.each([false, true])('honors an explicit Codex selection also declared for another provider (discovered=%s)', async discovered => {
    const h = harness(), model = 'shared-custom-deployment';
    setMockConfig('customModels', { 'claude-code': [model] });
    const selection = modelSelectionHost(h.provider, discovered ? [model] : []);
    const acknowledged = await selection.select(model, '');
    expect(acknowledged.model).toBe(model);
    const settings = selection.host._withResolvedModel({ ...h.settings, model: acknowledged.model });
    const sent = await h.start('Run the model explicitly selected for Codex.', settings);
    await sent.complete('shared-selection');
    expect(sent.child.received.find(value => value.method === 'thread/start')?.params?.model).toBe(model);
  });

  it('preserves an honoured provider override above a separately selected picker model', async () => {
    const h = harness(), selection = modelSelectionHost(h.provider);
    const acknowledged = await selection.select(h.provider.config.defaultModel, 'explicit-codex-override');
    expect(acknowledged.customModel).toBe('explicit-codex-override');
    const settings = selection.host._withResolvedModel({ ...h.settings, model: acknowledged.model });
    expect(settings.routedModel).toBeUndefined();
    const sent = await h.start('Honor the configured Codex model override.', settings);
    await sent.complete('override-selection');
    expect(sent.child.received.find(value => value.method === 'thread/start')?.params?.model).toBe('explicit-codex-override');
  });

  it.each(['completed-initialize', 'unknown-request'])('ignores a stale %s error without killing or replacing the active native session', async kind => {
    const h = harness();
    const first = await h.start('Initial owned request.'); await first.complete('first');
    const second = await h.start('Continue the same task.');
    expect(second.child).toBe(first.child);
    const staleId = kind === 'completed-initialize'
      ? first.child.received.find(rpc => rpc.method === 'initialize')!.id : 9999;
    second.child.emit({ id: staleId, error: { code: -32000, message: 'Late failure for a request that does not own this turn.' } });
    await tick();
    expect(mocks.kill).not.toHaveBeenCalled();
    await second.complete('second');
    const third = await h.start('The healthy process still owns this continuation.');
    expect(third.child).toBe(first.child); expect(h.children).toHaveLength(1);
    await third.complete('third');
  });

  it('surfaces an error for the current request and recovers under the next explicit model/profile selection', async () => {
    const h = harness();
    const failed = await h.start('Request that the backend rejects.');
    failed.child.emit({ id: failed.rpc.id, error: { code: -32000, message: 'Selected model is temporarily unavailable.' } });
    const chunks = await failed.completion;
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([
      expect.objectContaining({ content: 'Codex turn/start failed: Selected model is temporarily unavailable.' }),
    ]);
    expect(mocks.kill).toHaveBeenCalledWith(failed.child.process, expect.any(Number), expect.any(Object));
    setMockConfig('codexProfile', 'recovery-profile');
    const recovered = await h.start('Retry explicitly on the chosen model.', { routedModel: 'gpt-5.6-terra', effortLevel: 'high' });
    expect(recovered.child).not.toBe(failed.child);
    expect(recovered.child.args).toEqual(['--profile', 'recovery-profile', 'app-server']);
    expect(recovered.child.received.find(rpc => rpc.method === 'thread/resume')).toMatchObject({
      params: { threadId: 'owned-native-thread', model: 'gpt-5.6-terra', config: { model_reasoning_effort: 'high' } },
    });
    expect(recovered.rpc.params).toMatchObject({ effort: 'high' });
    // Delayed process teardown must not null the replacement's process ref.
    failed.child.process.emit('close', 1, null);
    await recovered.complete('recovered');
    const next = await h.start('Continue after recovery.', { routedModel: 'gpt-5.6-terra', effortLevel: 'high' });
    expect(next.child).toBe(recovered.child); await next.complete('next');
  });
});
