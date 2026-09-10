import readline from 'node:readline';
import fs from 'node:fs';
const [mode, marker] = process.argv.slice(2);
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const threadId = 'owned-thread';
const turnId = 'owned-turn';
const itemId = 'owned-item';
const file = mode.startsWith('file');
const item = file
  ? { id: itemId, type: 'fileChange', status: 'inProgress', changes: [{ path: marker, kind: { type: mode === 'file-delete' ? 'delete' : 'update', move_path: null }, diff: '-before\n+after' }] }
  : { id: itemId, type: 'commandExecution', status: 'inProgress', command: `write effect ${marker}`, cwd: process.cwd(), aggregatedOutput: null, exitCode: null };
let sent = false;
let effects = 0;
const complete = () => {
  send({ method: 'item/completed', params: { threadId, turnId, item: { ...item, status: effects ? 'completed' : 'declined', exitCode: effects ? 0 : 1 } } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message', delta: 'finished' } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'message', type: 'agentMessage', text: 'finished' } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 } } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') { send({ id: frame.id, result: { userAgent: `codex-app-server/${mode === 'version' ? '0.154.0' : '0.153.4'} (test)`, platformFamily: 'unix', platformOs: 'linux', codexHome: '/unused' } }); }
  if (frame.method === 'config/read') { send({ id: frame.id, result: { config: {}, layers: [] } }); }
  if (frame.method === 'configRequirements/read') { send({ id: frame.id, result: { requirements: null } }); }
  if (frame.method === 'thread/start') {
    send({ id: frame.id, result: { thread: { id: threadId }, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: mode === 'policy' ? 'dangerFullAccess' : 'readOnly', networkAccess: false } } });
  }
  if (frame.method === 'turn/start') {
    if (mode !== 'unknown-early') { send({ id: frame.id, result: { turn: { id: turnId } } }); }
    send({ method: 'item/started', params: { threadId, turnId, item } });
    const request = {
      id: 'native-1', method: file ? 'item/fileChange/requestApproval' : mode.startsWith('unknown') ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval',
      params: { threadId: mode === 'wrong-thread' ? 'foreign' : threadId, turnId, itemId, startedAtMs: Date.now(), ...(file ? { grantRoot: mode === 'file-root' ? process.cwd() : null } : { kind: mode === 'stdin' ? 'writeStdin' : 'command', command: mode === 'mismatch' ? 'changed command' : item.command, cwd: item.cwd, environmentId: null, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] }) },
    };
    if (mode === 'unknown-early') {
      send(request);
      send({ id: frame.id, result: { turn: { id: turnId } } });
    }
    else if (mode === 'file-delayed') { setTimeout(() => send(request), 50); } else { send(request); }
    if (mode === 'resolved') { setTimeout(() => { send({ method: 'serverRequest/resolved', params: { threadId, requestId: 'native-1' } }); complete(); }, 20); }
    if (mode === 'crash') { setTimeout(() => process.exit(23), 20); }
    if (mode === 'replay') { setTimeout(() => send(request), 20); }
    sent = true;
  }
  if (sent && frame.id === 'native-1' && frame.result) {
    fs.writeFileSync(`${marker}.decision`, JSON.stringify(frame.result));
    if (frame.result.decision === 'accept') { fs.appendFileSync(marker, 'effect\n'); effects++; }
    complete();
  }
  if (frame.method === 'turn/interrupt') { process.exit(0); }
}
