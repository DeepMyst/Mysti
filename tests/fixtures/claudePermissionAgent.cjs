/* Mysti — SPDX-License-Identifier: Apache-2.0 */
// Real child process: its only side effect happens after the native allow reply.
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const [directory, panel] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const done = () => send({ type: 'result', subtype: 'success', result: 'fixture complete' });
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
    const hook = msg.request.hooks.PreToolUse[0].hookCallbackIds[0];
    if (hook !== 'mysti-pre-tool') { process.exit(2); }
    initialized = true;
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
  } else if (msg.type === 'user') {
    if (!initialized) { process.exit(3); }
    send({ type: 'control_request', request_id: 'hook', request: {
      subtype: 'hook_callback', callback_id: 'mysti-pre-tool', input: {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'fixture-tool',
      },
    } });
  } else if (msg.type === 'control_response' && msg.response.request_id === 'hook') {
    if (msg.response.response.hookSpecificOutput.permissionDecision === 'deny') { done(); return; }
    send({ type: 'control_request', request_id: 'permission', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'fixture-tool', input: {},
    } });
  } else if (msg.type === 'control_response' && msg.response.request_id === 'permission') {
    if (msg.response.response.behavior === 'allow') {
      fs.appendFileSync(path.join(directory, panel), 'executed\n');
    }
    done();
  }
});
