/** Configuration/discovery remain read-only; agent execution requires a verified managed runtime. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { OpenClawManagedRuntime } from '../../../src/providers/openclaw/OpenClawManagedRuntime';
import type { Settings, StreamChunk } from '../../../src/types';

const settings: Settings = { provider: 'openclaw', mode: 'default', accessLevel: 'full-access',
  model: '', thinkingLevel: 'none', contextMode: 'auto' };
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  return chunks;
}

describe('OpenClaw explicit managed configuration', () => {
  let provider: TestableOpenClawProvider;
  let directory: string;
  let configFile: string;
  let executable: string;
  let internal: {
    _readOwnedRuntimeConfig(signal: AbortSignal): Promise<{
      cliPath: string; installedRoot: string; workspaceDir: string;
      baseConfig: Record<string, unknown>; fingerprint: string;
    }>;
  };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-config-test-'));
    configFile = path.join(directory, 'explicit.json');
    executable = path.join(directory, 'openclaw.mjs');
    fs.writeFileSync(executable, '// inert fixture');
    fs.writeFileSync(configFile, JSON.stringify({ agents: { defaults: { model: 'anthropic/configured' } },
      models: { providers: { anthropic: { apiKey: 'fixture-secret' } } } }));
    vi.stubEnv('OPENCLAW_CONFIG_PATH', configFile);
    provider = new TestableOpenClawProvider(); internal = provider as unknown as typeof internal;
    vi.spyOn(provider, 'discoverCli').mockResolvedValue({ found: true, path: executable, version: '2026.6.34' });
  });
  afterEach(() => { provider.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('reads the explicit host JSON and resolves the installed CLI without modifying either', async () => {
    const before = fs.readFileSync(configFile, 'utf8');
    const result = await internal._readOwnedRuntimeConfig(new AbortController().signal);
    expect(result.baseConfig).toMatchObject({ agents: { defaults: { model: 'anthropic/configured' } } });
    expect(result.cliPath).toBe(fs.realpathSync(executable)); expect(result.installedRoot).toBe(fs.realpathSync(directory));
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprint).not.toContain('fixture-secret');
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    expect(fs.readdirSync(directory).sort()).toEqual(['explicit.json', 'openclaw.mjs']);
  });

  it('resolves a discovery symlink to the actual installed package root', async () => {
    const link = path.join(directory, 'openclaw'); fs.symlinkSync(executable, link);
    vi.mocked(provider.discoverCli).mockResolvedValue({ found: true, path: link });
    const result = await internal._readOwnedRuntimeConfig(new AbortController().signal);
    expect(result.cliPath).toBe(fs.realpathSync(executable)); expect(result.installedRoot).toBe(fs.realpathSync(directory));
  });

  it('invalidates runtime identity when host model or environment credentials change', async () => {
    const first = await internal._readOwnedRuntimeConfig(new AbortController().signal);
    vi.stubEnv('ANTHROPIC_API_KEY', 'different-fixture-secret');
    const environment = await internal._readOwnedRuntimeConfig(new AbortController().signal);
    expect(environment.fingerprint).not.toBe(first.fingerprint);
    fs.writeFileSync(configFile, JSON.stringify({ agents: { defaults: { model: 'openai/other' } } }));
    const model = await internal._readOwnedRuntimeConfig(new AbortController().signal);
    expect(model.fingerprint).not.toBe(environment.fingerprint);
  });

  it.each(['{bad JSON with SECRET', '[]', 'null', '{ /* JSON5 */ "agents": {} }'])(
    'fails closed on unsupported config syntax without quoting credentials: %s', async source => {
      fs.writeFileSync(configFile, source);
      const start = vi.spyOn(OpenClawManagedRuntime, 'start');
      const cli = vi.spyOn(provider, 'buildCliArgs');
      const chunks = await collect(provider.sendMessage('hello', [], settings, null));
      expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
      expect(chunks[0].content).toContain('JSON object configuration');
      expect(chunks[0].content).not.toContain('SECRET');
      expect(start).not.toHaveBeenCalled(); expect(cli).not.toHaveBeenCalled();
    },
  );

  it('reports missing config with an explicit configuration remedy', async () => {
    fs.unlinkSync(configFile);
    await expect(internal._readOwnedRuntimeConfig(new AbortController().signal)).rejects.toThrow('OPENCLAW_CONFIG_PATH');
  });

  it('reports the pinned supported installation when discovery fails', async () => {
    vi.mocked(provider.discoverCli).mockResolvedValue({ found: false, path: '' });
    await expect(internal._readOwnedRuntimeConfig(new AbortController().signal)).rejects.toThrow('Install OpenClaw 2026.6.34');
  });

  it('does not read host config after discovery completes for a cancelled turn', async () => {
    const controller = new AbortController(); controller.abort();
    const read = vi.spyOn(fs.promises, 'readFile');
    await expect(internal._readOwnedRuntimeConfig(controller.signal)).rejects.toThrow('cancelled');
    expect(read).not.toHaveBeenCalled();
  });
});
