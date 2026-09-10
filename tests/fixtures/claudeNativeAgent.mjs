/** Inert Claude stdio contract: only its private marker can change after allow. */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import process from 'node:process';
const root = process.env.MYSTI_CLAUDE_FIXTURE_ROOT;
if (!root) { throw new Error('Fixture root missing'); }
const send = data => process.stdout.write(JSON.stringify(data) + '\n');
let serial = 0;
const pending = new Map();
send({ type: 'system', subtype: 'init', claude_code_version: '2.1.266', session_id: 'fixture-session', slash_commands: ['compact'] });
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const data = JSON.parse(line);
  if (data.type === 'user') {
    const turn = JSON.parse(data.message.content[0].text);
    const marker = resolve(turn.marker);
    if (!marker.startsWith(resolve(root) + sep)) { throw new Error('Marker escaped its private fixture'); }
    const id = `request-${++serial}`;
    const toolId = `tool-${serial}`;
    const finalInput = { file_path: marker, old_string: '', new_string: 'approved\n' };
    pending.set(id, { marker, toolId, finalInput });
    // Notifications alone never authorize the following native request.
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: toolId, name: 'Edit' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ ...finalInput, new_string: 'earlier draft' }) } } });
    send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Edit',
      tool_use_id: toolId, input: finalInput, matched_ask_rule: { source: 'flagSettings', tool_name: '*' } } });
  } else if (data.type === 'control_response') {
    const request = pending.get(data.response.request_id);
    if (!request) { return; }
    pending.delete(data.response.request_id);
    const result = data.response.response;
    if (result?.behavior === 'allow') {
      if (JSON.stringify(result.updatedInput) !== JSON.stringify(request.finalInput)) { throw new Error('Final arguments changed'); }
      if ('updatedPermissions' in result) { throw new Error('Persistent grant attempted'); }
      appendFileSync(request.marker, result.updatedInput.new_string);
    }
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: request.toolId,
      content: result?.behavior || 'denied', is_error: result?.behavior !== 'allow' }] } });
    send({ type: 'result', result: 'fixture complete', is_error: false });
  }
});
input.on('close', () => process.exit(0));
