/* Synthetic Claude control-protocol worker for native editor attachment checks.
 * No real CLI forwarding, model inference, network, account or tool execution.
 * Reads only Mysti's generated attachment files inside the owned workspace.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const { createHash } = require('node:crypto');
exports.run = function run(directory, workspace, args) {
  const receipts = path.join(directory, 'cli-receipts.jsonl');
  const record = value => fs.appendFileSync(receipts, JSON.stringify({ at: Date.now(), pid: process.pid, ...value }) + '\n');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const persistent = flag('--input-format') === 'stream-json';
  record({ event: 'spawn', persistent, model: flag('--model') });
  process.on('exit', code => record({ event: 'exit', code }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { record({ event: 'signal', signal }); process.exit(0); });
  if (args.includes('--version')) { process.stdout.write('2.1.284 (Mysti synthetic fixture)\n'); return; }
  if (args.includes('--help')) { process.stdout.write('Synthetic fixture --input-format stream-json --output-format stream-json\n'); return; }
  if (args.includes('login') || args.includes('logout')) { record({ event: 'unexpected-auth-command' }); process.exitCode = 3; return; }
  if (!persistent) {
    let input = '';
    process.stdin.on('data', part => { input += part; if (input.length > 1024 * 1024) process.exit(4); });
    process.stdin.on('end', () => { record({ event: 'auxiliary', bytes: Buffer.byteLength(input) }); process.stdout.write('Owned fixture title\n'); });
    return;
  }
  let initialized = false, turn = 0;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { record({ event: 'invalid-json' }); process.exit(5); }
    if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
      initialized = true; record({ event: 'initialized' });
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
      send({ type: 'system', subtype: 'init', session_id: 'owned-attachment-session-' + process.pid, model: flag('--model') || 'sonnet' });
      return;
    }
    if (message.type !== 'user' || !initialized) { record({ event: 'unexpected-input', type: message.type }); process.exit(6); }
    const prompt = typeof message.message.content === 'string' ? message.message.content
      : message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (prompt.trim() === '/compact') { record({ event: 'compact-held' }); return; }
    const prefix = path.join(workspace, '.mysti', 'tmp') + path.sep;
    const paths = [...new Set(prompt.match(/\/[^\n]*?mysti-attachment-[a-f0-9-]+\.[a-z0-9]+/g) || [])];
    const attachments = paths.map(file => {
      // Prompt may surround a path with display labels: retain only the owned prefix.
      const start = file.indexOf(prefix); if (start < 0) throw new Error('Unowned attachment path');
      file = file.slice(start);
      if (path.dirname(file) !== prefix.slice(0, -1) || !fs.statSync(file).isFile()) throw new Error('Unexpected attachment');
      const bytes = fs.readFileSync(file);
      return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
    });
    record({ event: 'request', turn: ++turn, prompt, attachments });
    send({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 80, output_tokens: 8 } } });
    send({ type: 'result', subtype: 'success', result: 'Owned attachment fixture response.' });
  });
};
