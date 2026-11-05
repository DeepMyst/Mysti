/* Transparent PB-02 Codex app-server transport. No injected protocol replies. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

module.exports = function run(config) {
  const { executable, prefixArgs = [], receiptFile, workspace, counterFile, token, maxInputs = 10 } = config;
  const args = process.argv.slice(2);
  const profileValidation = config.profileValidation;
  const profileIndex = args.indexOf('--profile');
  const selectedProfile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
  const selectedOwned = Object.values(profileValidation.profiles).find(value => value.name === selectedProfile);
  const persistent = args.includes('app-server');
  const auxiliary = args.includes('exec');
  const hash = value => value === undefined ? undefined : createHash('sha256').update(String(value)).digest('hex');
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,160}$/.test(value) ? value : undefined;
  const record = value => fs.appendFileSync(receiptFile, JSON.stringify({
    window: 'A', provider: 'openai-codex', at: Date.now(), wrapperPid: process.pid, ...value,
  }) + '\n', { mode: 0o600 });
  const markers = value => [...new Set([...value.matchAll(/PB02_REQUEST:([A-Z0-9_]+)/g)].map(match => match[1]))];
  const requests = new Map();
  const items = new Map();
  let model, sessionHash, turnHash, policy, inputIndex, auxiliaryInput = false;

  function claimInput() {
    let lock;
    try {
      lock = fs.openSync(counterFile + '.lock', 'wx', 0o600);
      const previous = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, 'utf8')).forwardedInputs : 0;
      if (!Number.isInteger(previous) || previous >= maxInputs) throw new Error('input-cap');
      const next = previous + 1;
      fs.writeFileSync(counterFile, JSON.stringify({ forwardedInputs: next, maxInputs }), { mode: 0o600 });
      return next;
    } finally {
      if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(counterFile + '.lock'); }
    }
  }
  function inspectInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (typeof value.method === 'string' && value.id !== undefined) requests.set(String(value.id), value.method);
    const params = value.params || {};
    if (['initialize', 'config/read', 'thread/start', 'thread/resume', 'turn/start'].includes(value.method)) {
      record({ event: 'rpc-request', method: value.method, rpcIdHash: hash(JSON.stringify(value.id)),
        selectedProfile, sessionHash: hash(params.threadId) });
    }
    if (['thread/start', 'thread/resume'].includes(value.method)) {
      model = safe(params.model); sessionHash = hash(params.threadId) || sessionHash;
      const overrides = params.config || {}, mcp = overrides.mcp_servers || {}, apps = overrides.apps || {};
      policy = { approvalPolicy: safe(params.approvalPolicy), sandbox: safe(params.sandbox), approvalsReviewer: safe(params.approvalsReviewer),
        effort: safe(overrides.model_reasoning_effort), ownedCwd: params.cwd === workspace,
        mcpNames: Object.keys(mcp).map(hash).sort(), mcpAllDisabled: Object.values(mcp).every(value => value?.enabled === false),
        appNames: Object.keys(apps).filter(name => name !== '_default').map(hash).sort(), appsAllDisabled: Object.values(apps).every(value => value?.enabled === false), appsDefaultDisabled: apps._default?.enabled === false };
      record({ event: 'thread-config', method: value.method, rpcIdHash: hash(JSON.stringify(value.id)), sessionHash, model, policy });
    }
    if (value.method === 'turn/start') {
      inputIndex = claimInput();
      const prompt = (Array.isArray(params.input) ? params.input : []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
      const blocks = [...prompt.matchAll(/<<<UNTRUSTED ([a-z0-9]+)\n([\s\S]*?)\n\1 UNTRUSTED>>>/g)];
      let outside = prompt; for (const block of blocks) outside = outside.replace(block[0], '');
      sessionHash = hash(params.threadId) || sessionHash;
      record({ event: 'request', method: value.method, inputIndex, rpcIdHash: hash(JSON.stringify(value.id)), model, sessionHash,
        effort: safe(params.effort), policy, markers: markers(prompt), outsideMemoryMarkers: markers(outside),
        memoryMarkers: markers(blocks.map(block => block[2]).join('\n')), containsFixtureToken: prompt.includes(token),
        promptSha256: hash(prompt), promptBytes: Buffer.byteLength(prompt), inputTypes: (params.input || []).map(item => safe(item?.type)) });
    }
    if (!value.method && value.id !== undefined && value.result?.decision) {
      record({ event: 'approval-decision', nativeRequestIdHash: hash(JSON.stringify(value.id)), decision: safe(value.result.decision), inputIndex });
    }
    if (value.method === 'turn/interrupt') record({ event: 'interrupt-request', sessionHash: hash(params.threadId), turnHash: hash(params.turnId), inputIndex });
  }
  function inspectOutput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const params = value.params || {};
    const method = requests.get(String(value.id));
    if (!value.method && value.id !== undefined && method) {
      requests.delete(String(value.id));
      record({ event: 'rpc-result', method, rpcIdHash: hash(JSON.stringify(value.id)), success: !value.error, errorSha256: hash(JSON.stringify(value.error)), inputIndex });
      if (method === 'config/read' && value.result?.config) {
        const effective = value.result.config;
        record({ event: 'profile-config', selectedProfile, rpcIdHash: hash(JSON.stringify(value.id)),
          model: safe(effective.model), reasoningEffort: safe(effective.model_reasoning_effort),
          contextWindow: Number.isSafeInteger(effective.model_context_window) ? effective.model_context_window : undefined });
        record({ event: 'effective-tool-config', mcpNames: Object.keys(value.result.config.mcp_servers || {}).map(hash).sort(), appNames: Object.keys(value.result.config.apps || {}).filter(name => name !== '_default').map(hash).sort() });
      }
      if (['thread/start', 'thread/resume'].includes(method) && value.result?.thread?.id) {
        sessionHash = hash(value.result.thread.id);
        const result = value.result;
        record({ event: 'session', method, sessionHash, requestedModel: model, actualModel: safe(result.model || result.thread.model),
          modelProvider: safe(result.modelProvider), returnedPolicy: {
            approvalPolicy: safe(result.approvalPolicy), sandbox: safe(result.sandbox?.type),
            networkAccess: typeof result.sandbox?.networkAccess === 'boolean' ? result.sandbox.networkAccess : safe(result.sandbox?.networkAccess),
            approvalsReviewer: safe(result.approvalsReviewer), ownedCwd: result.cwd === workspace,
            reasoningEffort: safe(result.reasoningEffort),
          } });
      }
      if (method === 'turn/start' && value.result?.turn?.id) {
        turnHash = hash(value.result.turn.id); record({ event: 'turn-started', inputIndex, sessionHash, turnHash });
      }
    }
    if (typeof value.method === 'string' && value.method.endsWith('/requestApproval')) {
      const item = items.get(params.itemId) || {};
      const file = value.method === 'item/fileChange/requestApproval';
      const toolInput = file ? { changes: item.changes || [], reason: params.reason, grantRoot: params.grantRoot }
        : { command: params.command ?? item.command ?? '', cwd: params.cwd ?? workspace, reason: params.reason, network: params.networkApprovalContext };
      record({ event: 'approval-request', method: value.method, nativeRequestIdHash: hash(JSON.stringify(value.id)), itemIdHash: hash(params.itemId),
        sessionHash: hash(params.threadId), turnHash: hash(params.turnId), commandSha256: hash(JSON.stringify(params.command)), toolInputSha256: hash(JSON.stringify(toolInput)), inputIndex });
    }
    if (['item/started', 'item/completed'].includes(value.method) && params.item) {
      const item = params.item;
      items.set(item.id, item);
      if (!['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) {
        if (!['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(item.type)) {
          record({ event: 'unexpected-tool-item', phase: value.method, inputIndex, type: safe(item.type), itemIdHash: hash(item.id),
            sessionHash: hash(params.threadId), turnHash: hash(params.turnId) });
        }
        return;
      }
      record({ event: value.method === 'item/started' ? 'tool-start' : 'tool-result', inputIndex, itemIdHash: hash(item.id),
        sessionHash: hash(params.threadId), turnHash: hash(params.turnId), type: safe(item.type), status: safe(item.status), exitCode: item.exitCode,
        commandSha256: hash(JSON.stringify(item.command)), ownedCwd: item.cwd === workspace,
        changes: Array.isArray(item.changes) ? item.changes.map(change => ({ relativePath: typeof change.path === 'string' ? path.relative(workspace, path.resolve(workspace, change.path)) : undefined,
          kind: safe(change.kind?.type), diffSha256: hash(change.diff) })) : undefined,
        outputSha256: hash(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : JSON.stringify(item.result ?? item.changes ?? item.error ?? '')), containsFixtureToken: String(item.aggregatedOutput || '').includes(token) });
    }
    if (value.method === 'turn/completed') record({ event: 'turn-completed', inputIndex, sessionHash: hash(params.threadId), turnHash: hash(params.turn?.id), status: safe(params.turn?.status), errorSha256: hash(JSON.stringify(params.turn?.error)) });
    if (value.method === 'thread/tokenUsage/updated') record({ event: 'usage', inputIndex, sessionHash: hash(params.threadId), last: params.tokenUsage?.last, total: params.tokenUsage?.total });
    if (value.method === 'error') record({ event: 'native-error', inputIndex, willRetry: params.willRetry === true, errorSha256: hash(JSON.stringify(params.error)) });
  }
  const codeHome = fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  record({ event: 'invocation', kind: persistent ? 'app-server' : auxiliary ? 'auxiliary' : 'probe',
    ...(persistent || args.length === 1 && args[0] === '--version' ? { args } : { argsSha256: hash(JSON.stringify(args)) }),
    selectedProfile, profileOwnedPath: selectedOwned?.path || (selectedProfile === profileValidation.missing.name ? profileValidation.missing.path : undefined),
    profileFileSha256: selectedOwned ? hash(fs.readFileSync(selectedOwned.path)) : null,
    codeHomeMatches: codeHome === profileValidation.codeHome });
  const child = spawn(executable, [...prefixArgs, ...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0), closed = false;
  function forward(bytes) {
    if (closed) return;
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { /* Non-JSON is forwarded unchanged. */ }
    if (persistent) {
      try { inspectInput(value); } catch (error) {
        if (value?.method === 'turn/start') {
          record({ event: 'input-cap-refusal', maxInputs }); closed = true; child.kill('SIGTERM'); process.stdin.pause(); return;
        }
        record({ event: 'instrumentation-error' });
      }
    }
    child.stdin.write(bytes);
  }
  process.stdin.on('data', bytes => {
    if (!persistent) {
      if (auxiliary && !auxiliaryInput && bytes.length) { auxiliaryInput = true; record({ event: 'auxiliary-input' }); }
      child.stdin.write(bytes); return;
    }
    buffer = Buffer.concat([buffer, bytes]);
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) { forward(buffer.subarray(0, newline + 1)); buffer = buffer.subarray(newline + 1); }
    if (buffer.length > 8 * 1024 * 1024) { record({ event: 'oversized-input-refusal' }); closed = true; child.kill('SIGTERM'); process.stdin.pause(); }
  });
  process.stdin.on('end', () => { if (buffer.length) forward(buffer); child.stdin.end(); });
  const decoder = new StringDecoder('utf8'); let pending = '', discard = false;
  const observe = line => { let value; try { value = JSON.parse(line); } catch { return; } try { inspectOutput(value); } catch { record({ event: 'instrumentation-error' }); } };
  child.stdout.on('data', bytes => {
    for (const [index, part] of decoder.write(bytes).split('\n').entries()) {
      if (index) { if (!discard) observe(pending); pending = ''; discard = false; }
      if (!discard) { if (pending.length + part.length > 2 * 1024 * 1024) { pending = ''; discard = true; } else pending += part; }
    }
  });
  child.stdout.on('end', () => { if (!discard && pending) observe(pending + decoder.end()); });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.stdin.on('error', () => {});
  child.on('spawn', () => record({ event: persistent ? 'start' : auxiliary ? 'auxiliary-start' : 'probe-start', childPid: child.pid }));
  child.on('error', () => { record({ event: 'launch-error' }); process.exitCode = 1; process.stdin.destroy(); });
  child.on('close', (code, signal) => {
    record({ event: persistent || auxiliary ? 'exit' : 'probe-exit', childPid: child.pid, exitCode: code, signal }); process.stdin.destroy();
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = closed ? 1 : code ?? 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
};
