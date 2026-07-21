/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * DeepMystGatewayClient streaming — native tool_calls SSE path (Plan 19 P4).
 * The gateway is the DEFAULT coordinator transport, so its tool_call
 * accumulation + `tools` request field are exercised directly here with a
 * stubbed global fetch (an allowlisted host so the dm_ key is attached).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';

const HOST = 'https://gateway.v2.deepmyst.com';

function sseResponse(frames: string[]): Response {
  return new Response(frames.map(f => `data: ${f}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeClient() {
  return new DeepMystGatewayClient(() => 'dm_test-key', () => HOST);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('DeepMystGatewayClient.streamChat — native tool_calls (Plan 19 P4)', () => {
  it('accumulates streamed tool_call deltas into one toolCalls event, then done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'write', arguments: '' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts",' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"x"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])));
    const client = makeClient();
    const out: any[] = [];
    for await (const ev of client.streamChat({ model: 'claude-haiku-4-5', messages: [] })) { out.push(ev); }
    const tc = out.find(e => e.toolCalls)?.toolCalls;
    expect(tc).toEqual([{ id: 'call_9', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]);
    expect(out.filter(e => e.toolCalls).length).toBe(1); // exactly once
    expect(out.some(e => e.done)).toBe(true);
  });

  it('flushes accumulated tool_calls even on a clean close without [DONE]', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } }] } }] }),
      // no finish_reason, no [DONE] — connection just closes
    ])));
    const client = makeClient();
    const out: any[] = [];
    for await (const ev of client.streamChat({ model: 'claude-haiku-4-5', messages: [] })) { out.push(ev); }
    expect(out.find(e => e.toolCalls)?.toolCalls).toEqual([{ id: 'call_1', name: 'ls', arguments: '{}' }]);
    expect(out.some(e => e.done)).toBe(true);
  });

  it('includes tools + tool_choice in the request body only when tools are provided', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]']));
    vi.stubGlobal('fetch', fetchImpl);
    const client = makeClient();
    const tools = [{ type: 'function', function: { name: 'read', description: 'd', parameters: {} } }];
    for await (const _ of client.streamChat({ model: 'claude-haiku-4-5', messages: [], tools })) { /* drain */ }
    for await (const _ of client.streamChat({ model: 'claude-haiku-4-5', messages: [] })) { /* drain */ }
    const body0 = JSON.parse((fetchImpl.mock.calls[0][1] as any).body);
    const body1 = JSON.parse((fetchImpl.mock.calls[1][1] as any).body);
    expect(body0.tools).toEqual(tools);
    expect(body0.tool_choice).toBe('auto');
    expect(body1.tools).toBeUndefined();
    expect(body1.tool_choice).toBeUndefined();
  });
});
