/* PC-12 transparent native wrapper. No prompt/output text, credentials, or reasoning is saved. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
exports.run = function run(config, args) {
  const { provider, receiptFile, executable, prefixArgs = [], hooks, token, workspace, window } = config;
  const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const values = name => args.flatMap((value, index) => value === name ? [args[index + 1]] : []);
  const hash = value => typeof value === 'string' && value ? createHash('sha256').update(value).digest('hex') : undefined;
  const safe = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(value) ? value : undefined;
  const markers = prompt => [...new Set((prompt.match(/PC12_REQUEST:[A-Z0-9_]+/g) || []).map(value => value.slice(13)))];
  const origins = prompt => {
    const memory = [...prompt.matchAll(/## Project memory[^\n]*\n[\s\S]*?<<<UNTRUSTED ([a-f0-9]+)\n([\s\S]*?)\n\1 UNTRUSTED>>>/g)];
    let outside = prompt; for (const block of memory) outside = outside.replace(block[0], '');
    return { projectMemoryMarkers: markers(memory.map(block => block[2]).join('\n')), outsideProjectMemoryMarkers: markers(outside), projectMemoryFences: memory.length,
      outsideProjectMemoryContainsHandoffToken: typeof config.handoffToken === 'string' && outside.includes(config.handoffToken) };
  };
  const record = value => fs.appendFileSync(receiptFile, JSON.stringify({ window, provider, at: Date.now(), wrapperPid: process.pid, ...value }) + '\n', { mode: 0o600 });
  const persistent = provider === 'claude-code' ? flag('--input-format') === 'stream-json' && flag('--output-format') === 'stream-json' : provider === 'openai-codex' && args.includes('app-server');
  const argvPrompt = provider === 'github-copilot' ? flag('-p') || flag('--prompt') : undefined;
  const inference = persistent || typeof argvPrompt === 'string' || (provider === 'claude-code' && (args.includes('--print') || args.includes('-p')));
  let forwardedArgs = args.slice();
  if (provider === 'claude-code' && inference) {
    const indices = args.flatMap((value, index) => value === '--settings' || value.startsWith('--settings=') ? [index] : []);
    if (!indices.length) forwardedArgs.push('--settings', hooks);
    else {
      try {
        if (indices.length !== 1 || args[indices[0]] !== '--settings') throw new Error('ambiguous-settings');
        const source = args[indices[0] + 1], parent = path.dirname(source);
        if (!/^mysti-claude-settings-[A-Za-z0-9]+$/.test(path.basename(parent)) || !/^ultracode-(on|off)\.json$/.test(path.basename(source))) throw new Error('unknown-settings');
        if (fs.realpathSync(path.dirname(parent)) !== fs.realpathSync(os.tmpdir()) || fs.lstatSync(source).isSymbolicLink() || fs.lstatSync(parent).isSymbolicLink() || fs.statSync(source).size > 1024) throw new Error('unowned-settings');
        const original = fs.readFileSync(source, 'utf8'), value = JSON.parse(original);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'ultracode' || typeof value.ultracode !== 'boolean') throw new Error('unexpected-settings-fields');
        const destination = path.join(path.dirname(hooks), `claude-merged-settings-${process.pid}.json`), merged = JSON.stringify({...value,disableAllHooks:true});
        fs.writeFileSync(destination, merged, {mode:0o600,flag:'wx'}); forwardedArgs[indices[0]+1] = destination;
        record({event:'claude-settings-merge',originalSha256:hash(original),mergedSha256:hash(merged),ultracode:value.ultracode,disableAllHooks:true,settingsArguments:1});
      } catch {
        record({ event: 'wrapper-rejected-settings' }); process.stderr.write('PC12 refuses unknown Claude settings; only Mysti ultracode JSON can be preserved and merged.\n'); process.exitCode = 1; return;
      }
    }
  }
  const actualArgs = [...prefixArgs, ...forwardedArgs];
  let model = safe(flag('--model')), sessionHash = hash(flag('--resume')), auxiliaryInput = false;
  const policy = { model, effort: safe(flag('--effort') || flag('--reasoning-effort')), outputFormat: safe(flag('--output-format')),
    denyTools: values('--deny-tool').map(safe), allowTools: values('--allow-tool').map(safe), allowAllTools: args.includes('--allow-all-tools'),
    permissionMode: safe(flag('--permission-mode')), nativeResumeSupplied: args.some(value => value === '--resume' || value.startsWith('--resume=')), injectedNoAutoUpdate: prefixArgs.includes('--no-auto-update') };
  function input(prompt, method) {
    const found = markers(prompt);
    record({ event: found.length ? 'request' : 'auxiliary-input', method, markers: found, markerOrigins: origins(prompt),
      containsFixtureToken: prompt.includes(token), containsHandoffToken: typeof config.handoffToken === 'string' && prompt.includes(config.handoffToken), promptSha256: hash(prompt), sessionHash, model, policy });
  }
  const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
  function captureInput(line) {
    if (!persistent) return; let value; try { value = JSON.parse(line); } catch { return; } if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (provider === 'openai-codex' && ['thread/start', 'thread/resume'].includes(value.method)) {
      model = safe(value.params?.model) || model; sessionHash = hash(value.params?.threadId) || sessionHash;
      record({ event: 'thread-config', method: value.method, model, sessionHash, approvalPolicy: safe(value.params?.approvalPolicy), sandbox: safe(value.params?.sandbox) });
    }
    if (provider === 'claude-code' && value.type === 'user' && value.message?.role === 'user') input(text(value.message.content), 'user');
    if (provider === 'openai-codex' && value.method === 'turn/start') { sessionHash = hash(value.params?.threadId) || sessionHash; input(text(value.params?.input), 'turn/start'); }
  }
  function tool(value, event) {
    const supplied = value.arguments?.path || value.arguments?.file_path || value.input?.path || value.input?.file_path;
    const output = value.result?.content ?? value.content;
    record({ event, toolIdHash: hash(value.toolCallId || value.id || value.tool_use_id), name: safe(value.toolName || value.name),
      exactOwnedFile: typeof supplied === 'string' && path.resolve(workspace, supplied) === path.join(workspace, 'src/issues.cjs'),
      inputSha256: hash(JSON.stringify(value.arguments || value.input || {})), success: value.success,
      outputSha256: hash(typeof output === 'string' ? output : JSON.stringify(output)), containsFixtureToken: JSON.stringify(output || '').includes(token) });
  }
  function captureOutput(line) {
    if (!inference) return; let value; try { value = JSON.parse(line); } catch { return; } if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (provider === 'github-copilot') {
      if (value.type === 'session.auto_mode_resolved') record({ event: 'auto-model-resolved', chosenModel: safe(value.data?.chosenModel) });
      if (value.type === 'model.call_start') record({ event: 'model-call', actualModel: safe(value.data?.model) });
      if (value.type === 'tool.execution_start') tool(value.data || {}, 'tool-start');
      if (value.type === 'tool.execution_complete') tool(value.data || {}, 'tool-result');
      if (value.type === 'session.usage_checkpoint') record({ event: 'non-token-usage-receipt' });
    }
    if (provider === 'claude-code') {
      for (const block of Array.isArray(value.message?.content) ? value.message.content : []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') tool(block, 'tool-start');
        if (block.type === 'tool_result') tool(block, 'tool-result');
      }
    }
    const id = provider === 'claude-code' ? value.type === 'system' && value.subtype === 'init' ? value.session_id : undefined : value.result?.thread?.id || (value.method === 'thread/started' ? value.params?.thread?.id : undefined);
    if (typeof id === 'string') { sessionHash = hash(id); record({ event: 'session', sessionHash, model: safe(value.model || value.result?.model) }); }
  }
  function inspect(stream, callback) {
    const decoder = new StringDecoder('utf8'); let pending = '', discard = false;
    const observe = line => { try { callback(line); } catch { record({event:'instrumentation-error'}); } };
    stream.on('data', chunk => {
      const pieces = decoder.write(chunk).split('\n');
      for (let index = 0; index < pieces.length; index++) {
        if (!discard) { if (pending.length + pieces[index].length > 1024 * 1024) { pending = ''; discard = true; } else pending += pieces[index]; }
        if (index < pieces.length - 1) { if (!discard) observe(pending); pending = ''; discard = false; }
      }
    });
    stream.on('end', () => { if (!discard && pending) observe(pending + decoder.end()); });
  }
  const child = spawn(executable, actualArgs, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (typeof argvPrompt === 'string') input(argvPrompt, '-p');
  inspect(process.stdin, captureInput); inspect(child.stdout, captureOutput);
  process.stdin.on('data', chunk => { if (inference && !persistent && argvPrompt === undefined && !auxiliaryInput && chunk.length) { auxiliaryInput = true; record({ event: 'auxiliary-input' }); } });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.stdin.on('error', () => {});
  child.on('spawn', () => record({ event: inference ? persistent || (argvPrompt && markers(argvPrompt).length) ? 'start' : 'auxiliary-start' : 'probe-start', childPid: child.pid, policy }));
  child.on('error', () => { process.stderr.write('PC12 selected CLI launch failed.\n'); process.exitCode = 1; process.stdin.pause(); });
  child.on('close', (code, signal) => {
    record({ event: inference ? 'exit' : 'probe-exit', childPid: child.pid, exitCode: code, signal });
    process.stdin.unpipe(child.stdin); process.stdin.pause();
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
};
