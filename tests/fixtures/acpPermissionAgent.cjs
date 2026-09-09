const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const [directory, panel] = process.argv.slice(2);
let promptId;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture-session' } });
  } else if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'fixture-session', update: {
        sessionUpdate: 'tool_call', toolCallId: 'fixture-tool', kind: 'execute', rawInput: {},
      },
    } });
    send({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {
      sessionId: 'fixture-session', toolCall: { toolCallId: 'fixture-tool' },
      options: [
        { optionId: 'yes', kind: 'allow_once' },
        { optionId: 'no', kind: 'reject_once' },
      ],
    } });
  } else if (message.id === 77 && message.result) {
    if (message.result.outcome.optionId === 'yes') {
      fs.appendFileSync(path.join(directory, panel), 'executed\n');
    }
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
});
