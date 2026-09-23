/* global process, setTimeout */
import fs from 'node:fs';
import readline from 'node:readline';
const [mode, marker, trace] = process.argv.slice(2);
const sessionId = 'fixture-opencode';
let promptId;
const send = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const result = (id, value) => send({ id, result: value });
const call = { toolCallId: 'edit-one', kind: 'edit', rawInput: { filePath: marker, content: 'effect' }, status: 'pending', title: 'write' };
// Emulates OpenCode's V1 server-plugin bootstrap for configured plugins:
// server(input), then config(cfg) with the resolved plugin origins.
async function bootstrapPlugins(directory) {
  if (mode === 'no-plugin' || !process.env.OPENCODE_CONFIG_CONTENT) { return; }
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const origins = [...config.plugin, ...(mode === 'extra-plugin' ? ['file:///extra-plugin.js'] : [])];
  for (const spec of config.plugin) {
    const hooks = await (await import(spec)).default.server({ directory: mode === 'other-directory' ? `${directory}-other` : directory });
    await hooks.config?.({ ...config, plugin_origins: origins.map(origin => ({ spec: origin })) });
  }
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const frame = JSON.parse(line); fs.appendFileSync(trace, `${line}\n`);
  if (frame.method === 'initialize') {
    result(frame.id, { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: mode === 'version' ? '0.0.0' : '1.18.29' }, agentCapabilities: { promptCapabilities: { image: true } } });
  } else if (frame.method === 'session/new') {
    await bootstrapPlugins(frame.params.cwd);
    result(frame.id, { sessionId, configOptions: [{ id: 'mode', currentValue: mode === 'wrong-mode' ? 'build' : 'mysti-host' }] });
  } else if (frame.method === 'session/set_mode' || frame.method === 'session/set_model' || frame.method === 'session/set_config_option') {
    result(frame.id, {});
  } else if (frame.method === 'session/prompt') {
    promptId = frame.id;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', ...call } } });
    send({ id: 7, method: 'session/request_permission', params: { sessionId, toolCall: { ...call, rawInput: mode === 'incomplete' ? {} : { filepath: marker, diff: '--- empty\n+++ marker\n@@ -0,0 +1 @@\n+effect' } }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Once' }, { optionId: 'always', kind: 'allow_always', name: 'Always' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } });
    if (mode === 'crash') { setTimeout(() => process.exit(1), 30); }
  } else if (frame.id === 7) {
    const allowed = frame.result?.outcome?.optionId === 'once';
    if (allowed) {
      if (mode === 'redundant-write') { send({ id: 8, method: 'fs/write_text_file', params: { sessionId, path: marker, content: 'effect\n' } }); }
      fs.appendFileSync(marker, 'effect\n');
    }
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'written' : 'rejected' } }] } } });
    result(promptId, { stopReason: 'end_turn', usage: { inputTokens: 17, outputTokens: 4, totalTokens: 21 } });
  } else if (frame.method === 'session/cancel') {
    if (promptId) { result(promptId, { stopReason: 'cancelled' }); }
  }
});
