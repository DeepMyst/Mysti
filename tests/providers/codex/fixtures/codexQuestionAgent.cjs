/* Mysti — SPDX-License-Identifier: Apache-2.0 */
// Fake `codex app-server`: Plan turns ask one request_user_input question and
// echo the answers Codex received; other turns echo their collaboration mode.
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let thread, turn = 0;
const say = text => send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: String(turn), itemId: 'msg-' + turn, delta: text } });
const complete = () => send({ method: 'turn/completed', params: { threadId: thread, turn: { id: String(turn), status: 'completed' } } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    // The real server rejects collaborationMode without this capability.
    if (msg.params.capabilities?.experimentalApi !== true) { process.exit(6); }
    send({ id: msg.id, result: {} });
  }
  if (msg.method === 'config/read') { send({ id: msg.id, result: { config: {} } }); }
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    thread = msg.params.threadId || 'thread-fixture';
    send({ id: msg.id, result: { thread: { id: thread }, model: 'fixture-model', reasoningEffort: 'low' } });
  }
  if (msg.method === 'turn/start') {
    turn++;
    send({ id: msg.id, result: { turn: { id: String(turn), status: 'inProgress' } } });
    const mode = msg.params.collaborationMode;
    if (mode?.mode !== 'plan') { say(`mode:${mode?.mode}`); complete(); return; }
    send({ id: 'question-' + turn, method: 'item/tool/requestUserInput', params: {
      threadId: thread, turnId: String(turn), itemId: 'call-' + turn, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'language', header: 'Language', question: 'Which language?', isOther: true, isSecret: false,
        options: [{ label: 'Python', description: '' }, { label: 'Go', description: '' }] }],
    } });
  }
  if (typeof msg.id === 'string' && msg.id.startsWith('question-') && msg.result) {
    say(`answered:${JSON.stringify(msg.result.answers)}`);
    complete();
  }
});
