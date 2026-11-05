/* PC-09: disposable local protocol worker; never contacts an inference service. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const ledger = process.argv[2];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const record = message => fs.appendFileSync(ledger, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...message }) + '\n');
let thread = 'same-native-thread', turn = 0, prompt = '';
record({ event: 'spawn' });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'config/read') send({ id: message.id, result: { config: {} } });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    thread = message.params.threadId || thread;
    record({ event: message.method, requestedCwd: message.params.cwd, thread });
    send({ id: message.id, result: { thread: { id: thread } } });
  }
  if (message.method === 'turn/start') {
    turn++;
    prompt = message.params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
    record({ event: 'turn', prompt, requestedCwd: message.params.cwd });
    send({ id: message.id, result: { turn: { id: String(turn), status: 'inProgress' } } });
    send({ method: 'item/started', params: { threadId: thread, turnId: String(turn), item: {
      id: 'same-native-tool', type: 'commandExecution', command: 'write isolated PC09 canary', status: 'inProgress',
    } } });
    send({ id: 77, method: 'item/commandExecution/requestApproval', params: {
      threadId: thread, turnId: String(turn), itemId: 'same-native-tool', command: 'write isolated PC09 canary', cwd: process.cwd(),
    } });
  }
  if (message.id === 77 && message.result) {
    const allowed = message.result.decision === 'accept';
    if (allowed) fs.appendFileSync(path.join(process.cwd(), 'pc09-owned-canary.jsonl'), JSON.stringify({ prompt, pid: process.pid }) + '\n');
    record({ event: 'decision', allowed, prompt });
    send({ method: 'item/completed', params: { threadId: thread, turnId: String(turn), item: {
      id: 'reply', type: 'agentMessage', text: `${allowed ? 'allowed' : 'denied'}:${prompt}`,
    } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: String(turn), status: 'completed' } } });
  }
});
