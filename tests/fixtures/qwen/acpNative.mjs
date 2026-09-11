import readline from 'node:readline';
import fs from 'node:fs';
const [flavor, scenario, target] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let promptId; let approval;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.id === 'approval') {
    approval = frame.result;
    if (approval?.outcome?.outcome === 'selected' && approval.outcome.optionId === 'proceed_once') { fs.appendFileSync(target, 'effect\n'); }
    send({ id: promptId, result: { stopReason: 'end_turn' } }); return;
  }
  if (frame.method === 'initialize') {
    send({ id: frame.id, result: { protocolVersion: 1, agentInfo: { name: flavor === 'qwen' ? 'qwen-code' : 'gemini-cli',
      version: scenario === 'version' ? '0.0.0' : flavor === 'qwen' ? '0.23.0' : '0.58.0' } } });
  } else if (frame.method === 'session/new') {
    send({ id: frame.id, result: { sessionId: 'owned-session', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } } });
  } else if (frame.method === 'session/set_mode' || frame.method === 'session/set_model') { send({ id: frame.id, result: {} });
  } else if (frame.method === 'session/prompt') {
    promptId = frame.id;
    if (String(frame.params.prompt[0].text).trimStart().startsWith('/')) { send({ id: promptId, error: { code: -1, message: 'Native slash command leaked' } }); return; }
    const toolCall = { toolCallId: 'actual-tool', status: 'pending', kind: 'edit',
      content: [{ type: 'diff', path: target, oldText: '', newText: 'effect\n' }], locations: [{ path: target }] };
    if (flavor === 'qwen') { Object.assign(toolCall, { _meta: { toolName: 'edit' }, rawInput: { file_path: target, old_string: '', new_string: 'effect\n' } }); }
    if (scenario === 'unsupported') { Object.assign(toolCall, { kind: 'execute', _meta: { toolName: 'agent' }, rawInput: { command: 'printf effect' } }); }
    send({ id: 'approval', method: 'session/request_permission', params: { sessionId: scenario === 'wrong-session' ? 'other-session' : 'owned-session', toolCall,
      options: [{ optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'cancel', name: 'Reject once', kind: 'reject_once' }, { optionId: 'proceed_always', name: 'Always allow', kind: 'allow_always' }] } });
  } else if (frame.method === 'session/cancel') { send({ id: promptId, result: { stopReason: 'cancelled' } }); }
});
