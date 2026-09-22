/** Inert ACP process: writes only its private marker after matching allow_once. */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const [root, scenario = 'normal'] = process.argv.slice(2);
const marker = path.join(root, 'effect.txt');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const sessionId = 'native-session';
const toolId = 'native-tool';
let promptId;
let settled = false;
const finalInput = { file_path: marker, content: 'executed\n', nested: { final: true } };
const tool = { toolCallId: toolId, kind: 'edit', title: 'native edit', rawInput: finalInput };
const update = fields => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: toolId, ...fields } } });
const finish = () => send({ id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 3 } } });
const approval = { id: 7, method: 'session/request_permission', params: {
  sessionId: scenario === 'wrong-session' ? 'other-session' : sessionId, toolCall: tool,
  options: [{ optionId: 'yes', kind: scenario === 'persistent-only' ? 'allow_always' : 'allow_once', name: 'Allow' },
    { optionId: 'no', kind: 'reject_once', name: 'Reject' }],
} };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    if (scenario === 'stderr-flood') { fs.writeSync(2, Buffer.alloc(1024 * 1024, 120)); }
    fs.writeFileSync(path.join(root, 'initialize.json'), JSON.stringify(frame.params));
    send({ id: frame.id, result: { protocolVersion: scenario === 'bad-version' ? 99 : 1, agentInfo: { name: 'fixture', version: '1.0.0' } } });
  } else if (frame.method === 'session/new') {
    send({ id: frame.id, result: { sessionId, modes: { currentModeId: 'default' } } });
  } else if (frame.method === 'session/set_mode') {
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: frame.params.modeId } } });
    send({ id: frame.id, result: {} });
  } else if (frame.method === 'session/set_model' || frame.method === 'session/set_config_option') {
    send({ id: frame.id, result: {} });
  } else if (frame.method === 'session/prompt') {
    promptId = frame.id;
    fs.writeFileSync(path.join(root, 'prompt.json'), JSON.stringify(frame.params));
    if (scenario === 'bad-json') { process.stdout.write('{invalid json}\n'); return; }
    if (scenario === 'unsupported') { send({ id: 8, method: 'terminal/create', params: { sessionId, command: 'never run' } }); return; }
    if (scenario === 'detached-shell') {
      // Mirrors OpenCode's native shell: an approved command runs in its own
      // detached process group, with a background job inside that group.
      const script = `echo $$ > grandchild.pid; (sleep 1; printf late > late.txt) & sleep 1; printf late > late-leader.txt; wait`;
      require('node:child_process').spawn('/bin/sh', ['-c', script], { cwd: root, detached: true, stdio: 'ignore' }).unref();
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: toolId, kind: 'execute', title: 'shell', status: 'in_progress', rawInput: { command: script } } } });
      return;
    }
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', ...tool, rawInput: { content: 'earlier display draft' }, status: 'pending' } } });
    send(approval);
    if (scenario === 'replay') { send(approval); }
    if (scenario === 'conflicting-tool') { send({ ...approval, id: 9 }); }
  } else if (frame.method === 'fixture/change') {
    update({ rawInput: { ...finalInput, content: 'changed after request' } });
  } else if (frame.method === 'fixture/complete') {
    update({ status: 'completed', content: [] }); finish();
  } else if (frame.method === 'fixture/mode') {
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'unsafe' } } });
  } else if (frame.method === 'fixture/config') {
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'allow_all', currentValue: 'on' }] } } });
  } else if (frame.method === 'session/cancel') { process.exit(0); }
  else if (frame.id === 7 && frame.result && !settled) {
    settled = true;
    fs.writeFileSync(path.join(root, 'response.json'), JSON.stringify(frame.result));
    if (frame.result.outcome.optionId === 'yes') { fs.appendFileSync(marker, finalInput.content); }
    if (scenario === 'optional-write') {
      send({ id: 8, method: 'fs/write_text_file', params: { sessionId, path: path.join(root, 'host-write.txt'), content: 'must not write' } }); return;
    }
    update({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'tool complete' } }] });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    finish();
  } else if (frame.id === 8 && frame.error) {
    fs.writeFileSync(path.join(root, 'unsupported-response.json'), JSON.stringify(frame.error)); finish();
  }
});
