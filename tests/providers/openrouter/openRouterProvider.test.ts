/**
 * OpenRouterProvider tests (Plan 15). API-based provider: no CLI, SSE streaming.
 * The CLI stubs must be inert; sendMessage streams via an injected mock client.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearMockConfig } from '../../helpers/mockVscode';
import { TestableOpenRouterProvider } from '../../helpers/providerFactory';
import { createOpenRouterSession } from '../../helpers/sessionFactory';
import type { OpenRouterClient, OpenRouterStreamEvent } from '../../../src/services/OpenRouterClient';
import type { Settings, StreamChunk } from '../../../src/types';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    provider: 'openrouter', model: 'openrouter/free', mode: 'default',
    accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto', ...over,
  } as Settings;
}

function mockClient(events: OpenRouterStreamEvent[]): OpenRouterClient {
  return {
    streamChat: async function* () {
      for (const e of events) { yield e; }
    },
  } as unknown as OpenRouterClient;
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) { out.push(c); }
  return out;
}

describe('OpenRouterProvider', () => {
  let provider: TestableOpenRouterProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableOpenRouterProvider();
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  describe('identity + capabilities', () => {
    it('is the openrouter provider with API-shaped capabilities', () => {
      expect(provider.id).toBe('openrouter');
      expect(provider.displayName).toBe('OpenRouter');
      expect(provider.capabilities.supportsStreaming).toBe(true);
      expect(provider.capabilities.supportsToolUse).toBe(false); // pure completion API
      expect(provider.capabilities.emitsUsage).toBe(true);
      expect(provider.capabilities.sessionKind).toBe('prompt-history');
      expect(provider.config.defaultModel).toBe('openrouter/free'); // free by default
    });

    it('has inert CLI stubs (never spawns a process)', () => {
      const s = createOpenRouterSession();
      expect(provider.buildCliArgs(settings(), s)).toEqual([]);
      expect(provider.parseStreamLine('anything', s)).toBeNull();
    });
  });

  describe('auth / discovery from key presence', () => {
    it('reports found + authenticated when a key is present (via env)', async () => {
      expect((await provider.discoverCli()).found).toBe(true);
      expect((await provider.getAuthConfig()).isAuthenticated).toBe(true);
      expect((await provider.checkAuthentication()).authenticated).toBe(true);
    });

    it('reports not found when no key', async () => {
      delete process.env.OPENROUTER_API_KEY;
      expect((await provider.discoverCli()).found).toBe(false);
      expect((await provider.getAuthConfig()).isAuthenticated).toBe(false);
    });
  });

  describe('sendMessage (SSE)', () => {
    it('emits an auth_error when no key is configured', async () => {
      delete process.env.OPENROUTER_API_KEY;
      const chunks = await collect(provider.sendMessage('hi', [], settings(), null, undefined, 'p1'));
      expect(chunks[0].type).toBe('auth_error');
    });

    it('streams text + thinking, then a done chunk carrying usage', async () => {
      provider.setClient(mockClient([
        { text: 'Hello ' },
        { reasoning: 'thinking...' },
        { text: 'world' },
        { usage: { inputTokens: 12, outputTokens: 4 } },
        { done: true },
      ]));
      const chunks = await collect(provider.sendMessage('hi', [], settings(), null, undefined, 'p1'));

      const text = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
      expect(text).toBe('Hello world');
      expect(chunks.some(c => c.type === 'thinking' && c.content === 'thinking...')).toBe(true);
      const done = chunks.find(c => c.type === 'done');
      expect(done).toBeDefined();
      expect(done!.usage).toEqual({ input_tokens: 12, output_tokens: 4, normalized: true });
    });

    it('maps a stream error event to an error chunk (no done)', async () => {
      provider.setClient(mockClient([{ text: 'partial' }, { error: 'rate-limited (HTTP 429)' }]));
      const chunks = await collect(provider.sendMessage('hi', [], settings(), null, undefined, 'p1'));
      expect(chunks.some(c => c.type === 'error' && (c.content || '').includes('429'))).toBe(true);
      expect(chunks.some(c => c.type === 'done')).toBe(false);
    });

    it('emits exactly one done chunk on a clean stream', async () => {
      provider.setClient(mockClient([{ text: 'ok' }, { done: true }]));
      const chunks = await collect(provider.sendMessage('hi', [], settings(), null, undefined, 'p1'));
      expect(chunks.filter(c => c.type === 'done').length).toBe(1);
    });
  });
});
