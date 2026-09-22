import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [provider, scenario, marker] = process.argv.slice(2);
const send = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const sessionId = 'native-session'; let promptId;
const tool = provider === 'cline'
  ? { toolCallId: 'operation', title: 'run_commands: write marker', kind: 'execute', status: 'pending', rawInput: { commands: [`printf approved > ${marker}`] } }
  : { toolCallId: 'operation', title: 'Write marker', kind: 'edit', status: 'pending', rawInput: { fileName: marker, diff: '+effect' } };
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    send({ id: frame.id, result: { protocolVersion: 1, agentInfo: { name: provider === 'cline' ? 'cline' : 'Copilot', version: scenario === 'wrong-version' ? '99.0.0' : provider === 'cline' ? '3.0.64' : '1.0.83' } } });
  } else if (frame.method === 'session/new') {
    send({ id: frame.id, result: { sessionId, configOptions: [provider === 'cline' ? { id: 'auto_approve', currentValue: false } : { id: 'allow_all', currentValue: 'off' }] } });
  } else if (frame.method === 'session/set_mode' || frame.method === 'session/set_model') {
    send({ id: frame.id, result: {} });
  } else if (frame.method === 'session/prompt') {
    promptId = frame.id;
    if (!frame.params.prompt[0].text.startsWith('Mysti user request:\n\n')) { throw Error('Native slash routing was not suppressed'); }
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', ...tool } } });
    send({ id: 'approval', method: 'session/request_permission', params: { sessionId, toolCall: tool, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] } });
  } else if (frame.id === 'approval') {
    if (frame.result?.outcome?.optionId === 'allow') { appendFileSync(marker, 'effect\n'); }
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
}
