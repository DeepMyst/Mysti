import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpConfigManager } from '../../src/services/McpConfigManager';
import { workspace as mockWorkspace } from '../helpers/mockVscode';

const adapters = [
  ['claude-code', '.mcp.json', 'mcpServers'],
  ['google-gemini', '.gemini/settings.json', 'mcpServers'],
  ['qwen-code', '.qwen/settings.json', 'mcpServers'],
  ['opencode', '.config/opencode/opencode.json', 'mcp'],
  ['cline', 'globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json', 'mcpServers'],
] as const;

describe('MCP cleanup preserves unrelated existing configuration', () => {
  let directory: string;
  let manager: McpConfigManager;
  let savedFolders: unknown;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-mcp-noop-'));
    savedFolders = (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders;
    (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: directory }, name: 'owned-fixture', index: 0 },
    ];
    manager = new McpConfigManager(directory, path.join(directory, 'globalStorage'));
  });

  afterEach(() => {
    (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = savedFolders;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture(relativePath: string, contents: string, mode = 0o600) {
    const file = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode });
    // A fixed old timestamp makes an unnecessary same-byte write observable.
    fs.utimesSync(file, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    return file;
  }

  for (const [providerId, relativePath, rootKey] of adapters) {
    it(`leaves ${providerId} bytes and modification time unchanged when no managed entry exists`, async () => {
      const contents = `{ "theme" : "dark", "${rootKey}" : { "mine" : { "command" : "node" } } }\r\n`;
      const file = fixture(relativePath, contents);
      const before = fs.statSync(file, { bigint: true });

      const result = (await manager.removeAll()).find(row => row.providerId === providerId);

      expect(fs.readFileSync(file, 'utf8')).toBe(contents);
      expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
      expect(result).toMatchObject({ ok: true, action: 'skipped' });
    });
  }

  it('skips a read-only unrelated JSON file without reporting a removal or write error', async () => {
    const contents = '{"theme":"dark"}\n';
    const file = fixture('.gemini/settings.json', contents, 0o400);
    const before = fs.statSync(file, { bigint: true });

    const result = (await manager.removeAll()).find(row => row.providerId === 'google-gemini');

    expect(result).toMatchObject({ ok: true, action: 'skipped' });
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
    const after = fs.statSync(file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.mode).toBe(before.mode);
  });

  it('still removes managed entries while preserving other settings and servers', async () => {
    const file = fixture('.gemini/settings.json', JSON.stringify({
      theme: 'dark',
      mcpServers: {
        mine: { command: 'node' },
        'deepmyst-my-connections': { httpUrl: 'https://example.invalid/mcp' },
      },
    }));

    const result = (await manager.removeAll()).find(row => row.providerId === 'google-gemini');

    expect(result).toMatchObject({ ok: true, action: 'removed' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      theme: 'dark', mcpServers: { mine: { command: 'node' } },
    });
  });

  it('still reports an unparseable config without changing its bytes', async () => {
    const contents = '{ malformed JSON';
    const file = fixture('.gemini/settings.json', contents);

    const result = (await manager.removeAll()).find(row => row.providerId === 'google-gemini');

    expect(result).toMatchObject({ ok: false, action: 'error' });
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
  });
});
