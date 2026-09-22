/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * R11 witnesses against a real loopback SSE server (no OpenRouter account):
 *  1. opaque `reasoning_details` are captured in order and replayed unmodified
 *     on the next request of the coordinator's tool loop;
 *  2. direct chat reports the model that actually served the turn and its cost;
 *  3. Stop while the base prompt is still being built ends the turn promptly.
 */
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenRouterClient } from '../../../src/services/OpenRouterClient';
import { CoordinatorModelClient } from '../../../src/services/CoordinatorModelClient';
import type { DeepMystGatewayClient, GatewayChatMessage } from '../../../src/services/DeepMystGatewayClient';
import { CoordinatorTurnRunner } from '../../../src/coordinator/CoordinatorTurnRunner';
import { CoordinatorRunOrchestrator } from '../../../src/coordinator/CoordinatorRunOrchestrator';
import { TestableOpenRouterProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

const sse = (...frames: unknown[]) => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
const collect = async <T>(stream: AsyncIterable<T>) => { const out: T[] = []; for await (const item of stream) { out.push(item); } return out; };

/** Serves the scripted SSE bodies in order and records every request body. */
async function loopback(bodies: string[], run: (client: OpenRouterClient, requests: Record<string, unknown>[]) => Promise<void>) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(bodies[requests.length - 1] ?? sse({ choices: [{ delta: { content: 'extra' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Missing fixture address'); }
  const client = new OpenRouterClient(() => 'inert-loopback-key', {
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}/inert`, init),
  });
  try { await run(client, requests); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

// Streamed shape: text fragments of one block (signature on the last), then an
// opaque encrypted block that must never be merged, inspected or reordered.
const ENCRYPTED = { type: 'reasoning.encrypted', data: 'gAAAAB-opaque==', id: 'rs_2', format: 'openai-responses-v1', index: 1 };
const REASONING_TOOL_STREAM = sse(
  { model: 'anthropic/claude-sonnet-5', choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Need the ', id: 'rs_1', format: 'anthropic-claude-v1', index: 0 }] } }] },
  { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'file first.', index: 0, signature: 'sig-abc' }] } }] },
  { choices: [{ delta: { reasoning_details: [ENCRYPTED] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } },
);
const EXPECTED_DETAILS = [
  { type: 'reasoning.text', text: 'Need the file first.', id: 'rs_1', format: 'anthropic-claude-v1', index: 0, signature: 'sig-abc' },
  ENCRYPTED,
];
const ANSWER_STREAM = sse({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] });

afterEach(() => { clearMockConfig(); delete process.env.OPENROUTER_API_KEY; });

describe('R11 opaque reasoning replay', () => {
  it('surfaces the completed reasoning_details in order, merging only same-block text fragments', async () => {
    await loopback([REASONING_TOOL_STREAM], async client => {
      const events = await collect(client.streamChat({ model: 'anthropic/claude-sonnet-5', messages: [] }));
      expect(events.find(event => event.error)).toBeUndefined();
      expect(events.find(event => event.reasoningDetails)?.reasoningDetails).toEqual(EXPECTED_DETAILS);
      // Only readable reasoning is shown; the encrypted blob never reaches the UI.
      expect(events.filter(event => event.reasoning).map(event => event.reasoning).join('')).toBe('Need the file first.');
    });
  });

  it('does not surface reasoning_details from a stream that never completed', async () => {
    const truncated = REASONING_TOOL_STREAM.replace('data: [DONE]\n\n', '');
    await loopback([truncated], async client => {
      const events = await collect(client.streamChat({ model: 'm', messages: [] }));
      expect(events.at(-1)?.error).toBeDefined();
      expect(events.some(event => event.reasoningDetails)).toBe(false);
    });
  });

  it('replays the details unmodified on the assistant message of the next tool-loop request', async () => {
    await loopback([REASONING_TOOL_STREAM, ANSWER_STREAM], async (client, requests) => {
      const coordinator = new CoordinatorModelClient(
        {} as DeepMystGatewayClient, client, () => false,
        () => ({ freeModels: [], gatewayFallbackModel: '', openRouterModel: 'anthropic/claude-sonnet-5' }),
      );
      const runner = new CoordinatorTurnRunner({ nonce: 'n0nce', scanKinds: [], maxTurns: 3 }, {
        stream: (messages, options) => coordinator.stream(messages, options),
        isCancelled: () => false,
        registerAbort: () => undefined,
        getMaxTokens: () => 512,
        output: { beginTurn() {}, observe() {}, emitText() {}, estimateInterruptedTurn() {} },
      });
      const messages: GatewayChatMessage[] = [{ role: 'user', content: 'read a.ts' }];
      await new CoordinatorRunOrchestrator({
        turns: turnMessages => runner.turns(turnMessages),
        dispatchTool: async (turn, turnMessages) => {
          if (!turn.toolCalls?.length) { return { kind: 'unhandled' }; }
          // The real dispatcher's replay shape: assistant text, then a fenced user result.
          turnMessages.push({ role: 'assistant', content: turn.text }, { role: 'user', content: 'fenced result' });
          return { kind: 'handled' };
        },
        delegate: async () => 'handled',
        isCancelled: () => false,
        hasVisibleText: () => true,
        finalize: async () => undefined,
        onError: turn => { throw new Error(turn.message); },
      }).run(messages);

      expect(requests).toHaveLength(2);
      const replayed = (requests[1].messages as GatewayChatMessage[]).find(message => message.role === 'assistant');
      expect(replayed?.reasoning_details).toEqual(EXPECTED_DETAILS);
    });
  });
});

const SETTINGS: Settings = { provider: 'openrouter', model: 'openrouter/auto', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' };

describe('R11 direct-chat served model and cost', () => {
  it('reports the model that served the turn and the reported cost on done', async () => {
    await loopback([sse(
      { model: 'anthropic/claude-sonnet-5', choices: [{ delta: { content: 'hi' } }] },
      { model: 'anthropic/claude-sonnet-5', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, cost: 0.0042, prompt_tokens_details: { cached_tokens: 5 } } },
    )], async client => {
      setMockConfig('openrouter.apiKey', 'inert-loopback-key');
      const provider = new TestableOpenRouterProvider(); provider.setClient(client);
      try {
        const chunks = await collect(provider.sendMessage('hello', [], SETTINGS, null, undefined, 'panel'));
        const done = chunks.find(chunk => chunk.type === 'done');
        expect(done).toMatchObject({ model: 'anthropic/claude-sonnet-5', costUsd: 0.0042 });
        expect(done?.usage).toEqual({ input_tokens: 15, output_tokens: 2, cache_read_input_tokens: 5, normalized: true });
      } finally { provider.dispose(); }
    });
  });
});

describe('R11 base prompt cancellation', () => {
  it('Stop while the base prompt is being built ends the turn without waiting for it or fetching', async () => {
    await loopback([ANSWER_STREAM], async (client, requests) => {
      setMockConfig('openrouter.apiKey', 'inert-loopback-key');
      let releasePrompt!: (value: string) => void;
      let promptStarted!: () => void;
      const started = new Promise<void>(resolve => { promptStarted = resolve; });
      class SlowPromptProvider extends TestableOpenRouterProvider {
        protected override buildPromptAsync(): Promise<string> {
          promptStarted();
          return new Promise(resolve => { releasePrompt = resolve; });
        }
      }
      const provider = new SlowPromptProvider(); provider.setClient(client);
      try {
        const turn = provider.sendMessage('hello', [], SETTINGS, null, undefined, 'panel');
        const next = turn.next();
        await started;
        provider.cancelCurrentRequest('panel');
        const settled = await Promise.race([next, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500))]);
        expect(settled).toEqual({ done: true, value: undefined });
        releasePrompt('late prompt');
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(requests).toHaveLength(0);
      } finally { provider.dispose(); }
    });
  });
});

