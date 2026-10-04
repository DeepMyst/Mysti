/* Mysti — SPDX-License-Identifier: Apache-2.0 */
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const [directory, panel] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let thread, turn = 0;
const complete = () => send({ method: 'turn/completed', params: { threadId: thread, turn: { id: String(turn), status: 'completed' } } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); }
  if (msg.method === 'config/read') { send({ id: msg.id, result: { config: { mcp_servers: { fixture: { command: 'must-not-run' } } } } }); }
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    if (msg.params.config.mcp_servers.fixture.enabled !== false) { process.exit(5); }
    thread = msg.params.threadId || 'thread-' + panel;
    if (msg.params.approvalsReviewer !== 'user' || msg.params.sandbox !== 'read-only') { process.exit(4); }
    send({ id: msg.id, result: { thread: { id: thread } } });
  }
  if (msg.method === 'turn/start') {
    turn++;
    send({ id: msg.id, result: { turn: { id: String(turn), status: 'inProgress' } } });
    send({ method: 'item/started', params: { threadId: thread, turnId: String(turn), item: {
      id: 'fixture-tool', type: 'commandExecution', command: 'fixture write', status: 'inProgress',
    } } });
    send({ id: 'permission', method: 'item/commandExecution/requestApproval', params: {
      threadId: thread, turnId: String(turn), itemId: 'fixture-tool', command: 'fixture write',
    } });
  }
  if (msg.id === 'permission' && msg.result) {
    if (msg.result.decision === 'accept') { fs.appendFileSync(path.join(directory, panel), 'executed\n'); }
    complete();
  }
});
