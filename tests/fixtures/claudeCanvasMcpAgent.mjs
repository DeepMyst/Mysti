/**
 * Inert Claude stdio contract for the Canvas MCP credential. Like the real CLI
 * it reads `--mcp-config` ONCE at spawn and keeps that HTTP MCP session (URL +
 * bearer) for the life of the process; each user turn calls `tools/list` on it
 * and reports the outcome as the turn result. Never contacts anything but the
 * loopback URL named in its own config.
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const send = data => process.stdout.write(JSON.stringify(data) + '\n');
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const configPath = arg('--mcp-config');
const resume = arg('--resume') ?? null;

let connected = Promise.resolve(null);
let token = null;
if (configPath) {
  const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers['mysti-canvas'];
  if (!new URL(server.url).hostname.match(/^(127\.0\.0\.1|localhost)$/)) { throw new Error('Fixture only talks to loopback'); }
  token = server.headers.Authorization;
  const client = new Client({ name: 'claude-fixture', version: '1.0.0' }, { capabilities: {} });
  connected = client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  })).then(() => client, error => ({ error: String(error) }));
}

send({ type: 'system', subtype: 'init', claude_code_version: '2.1.266', session_id: 'fixture-session', slash_commands: [] });
const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  const data = JSON.parse(line);
  if (data.type !== 'user') { return; }
  const text = data.message.content[0].text;
  if (text === 'hold') { return; } // A turn that only Stop can end.
  const client = await connected;
  const report = { pid: process.pid, resume, token, ok: false, error: null, tools: 0 };
  if (!client) { report.error = 'no canvas mcp config'; }
  else if (client.error) { report.error = client.error; }
  else {
    try { report.tools = (await client.listTools()).tools.length; report.ok = true; }
    catch (error) { report.error = String(error); }
  }
  send({ type: 'result', result: JSON.stringify(report), is_error: false, session_id: 'fixture-session' });
});
input.on('close', () => process.exit(0));
