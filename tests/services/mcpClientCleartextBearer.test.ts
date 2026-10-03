/**
 * The `dm_` bearer must never leave the machine in cleartext.
 *
 * `McpClient` is handed a URL built from `mysti.deepmyst.apiUrl`. One caller
 * re-checks it with `isDeepMystHost` (ChatViewProvider._mystiMcpToolset); the
 * canvas/fal caller does not. Whether or not a caller remembers, the client
 * itself must refuse to attach a live account credential to a plaintext
 * request to a remote host. Loopback stays allowed — that is how the local
 * CanvasMcpHttpServer is driven, and it never leaves the machine.
 */
import { describe, it, expect } from 'vitest';
import { McpClient } from '../../src/services/McpClient';

describe('McpClient bearer transport floor', () => {
  it('refuses to send a bearer over plain http to a remote host', async () => {
    const client = new McpClient({ url: 'http://broker.example.com/mcp', bearer: 'dm_live_key', timeoutMs: 500 });
    await expect(client.listTools()).rejects.toThrow(/cleartext/i);
    await expect(client.callTool('x', {})).rejects.toThrow(/cleartext/i);
  });

  it('refuses an unparseable endpoint rather than guessing', async () => {
    const client = new McpClient({ url: 'not-a-url', bearer: 'dm_live_key', timeoutMs: 500 });
    await expect(client.listTools()).rejects.toThrow(/not parseable/i);
  });

  it('does not block https, loopback, or bearer-less connections', async () => {
    // These must fail for NETWORK reasons, never for the policy reason —
    // otherwise the guard has quietly broken the local canvas MCP server.
    const cases = [
      new McpClient({ url: 'https://broker.invalid/mcp', bearer: 'dm_live_key', timeoutMs: 500 }),
      new McpClient({ url: 'http://127.0.0.1:1/mcp', bearer: 'dm_live_key', timeoutMs: 500 }),
      new McpClient({ url: 'http://localhost:1/mcp', bearer: 'dm_live_key', timeoutMs: 500 }),
      new McpClient({ url: 'http://broker.invalid/mcp', timeoutMs: 500 }),
    ];
    for (const client of cases) {
      await expect(client.listTools()).rejects.not.toThrow(/cleartext|not parseable/i);
    }
  }, 20_000);
});
