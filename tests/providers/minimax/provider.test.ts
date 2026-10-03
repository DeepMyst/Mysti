import { describe, it, expect, beforeEach } from 'vitest';
import { TestableMiniMaxProvider } from '../../helpers/providerFactory';
import { setMockConfig, clearMockConfig } from '../../helpers/mockVscode';

describe('MiniMaxProvider', () => {
  let provider: TestableMiniMaxProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableMiniMaxProvider();
  });

  describe('metadata', () => {
    it('has the correct id', () => {
      expect(provider.id).toBe('minimax');
    });

    it('has the correct displayName', () => {
      expect(provider.displayName).toBe('MiniMax');
    });

    it('has MiniMax-M2.7 as the default model', () => {
      expect(provider.config.defaultModel).toBe('MiniMax-M2.7');
    });

    it('includes MiniMax-M2.7 and MiniMax-M2.7-highspeed models', () => {
      const modelIds = provider.config.models.map(m => m.id);
      expect(modelIds).toContain('MiniMax-M2.7');
      expect(modelIds).toContain('MiniMax-M2.7-highspeed');
      expect(modelIds).toHaveLength(2);
    });

    it('does not support tool use', () => {
      expect(provider.capabilities.supportsToolUse).toBe(false);
    });

    it('supports streaming', () => {
      expect(provider.capabilities.supportsStreaming).toBe(true);
    });
  });

  describe('discoverCli', () => {
    it('returns found=true when API key is configured', async () => {
      setMockConfig('minimaxApiKey', 'test-api-key');
      const result = await provider.discoverCli();
      expect(result.found).toBe(true);
    });

    it('returns found=false when no API key is set', async () => {
      // Ensure no env var either
      const originalEnv = process.env.MINIMAX_API_KEY;
      delete process.env.MINIMAX_API_KEY;
      const result = await provider.discoverCli();
      expect(result.found).toBe(false);
      if (originalEnv !== undefined) {
        process.env.MINIMAX_API_KEY = originalEnv;
      }
    });

    it('uses the configured base URL in discovery result', async () => {
      setMockConfig('minimaxApiKey', 'test-key');
      setMockConfig('minimaxBaseUrl', 'https://api.minimax.io/v1');
      const result = await provider.discoverCli();
      expect(result.path).toContain('minimax.io');
    });
  });

  describe('checkAuthentication', () => {
    it('returns authenticated=true when API key is set', async () => {
      setMockConfig('minimaxApiKey', 'test-api-key');
      const result = await provider.checkAuthentication();
      expect(result.authenticated).toBe(true);
    });

    it('returns authenticated=false when no API key is set', async () => {
      const originalEnv = process.env.MINIMAX_API_KEY;
      delete process.env.MINIMAX_API_KEY;
      const result = await provider.checkAuthentication();
      expect(result.authenticated).toBe(false);
      expect(result.error).toBeDefined();
      if (originalEnv !== undefined) {
        process.env.MINIMAX_API_KEY = originalEnv;
      }
    });
  });

  describe('getCliPath', () => {
    it('returns the default MiniMax base URL', () => {
      const path = provider.getCliPath();
      expect(path).toContain('minimax.io');
    });

    it('returns the configured base URL when overridden', () => {
      setMockConfig('minimaxBaseUrl', 'https://custom.endpoint/v1');
      // Create a fresh provider to pick up config
      const p = new TestableMiniMaxProvider();
      expect(p.getCliPath()).toBe('https://custom.endpoint/v1');
    });
  });
});
