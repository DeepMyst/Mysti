/** Mysti — SPDX-License-Identifier: Apache-2.0 */
/* eslint-env node, es2022 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import * as guard from '../../../resources/openclaw-policy/runtime-guard.mjs';

const mode = process.argv[2];
const workspace = process.env.MYSTI_TEST_WORKSPACE;
let networkAttempts = 0;
const forbidden = () => { networkAttempts++; throw new Error('External network is forbidden in the final execution fixture'); };
net.Socket.prototype.connect = forbidden;
http.request = forbidden;
https.request = forbidden;
globalThis.fetch = forbidden;
syncBuiltinESMExports();
const ctx = { runId: 'mysti-run', sessionKey: 'agent:main:mysti-panel', sessionId: 'transcript', workspaceDir: workspace };
const cases = [];
const received = [];
let effects = 0;
const raw = (overrides = {}) => ({
  name: 'write', label: 'write', description: 'fixture sentinel', parameters: { type: 'object' },
  execute: async function (id, params) {
    assert.equal(this, undefined);
    effects++;
    fs.appendFileSync(path.join(workspace, 'effects.jsonl'), JSON.stringify({ id, params }) + '\n');
    return { content: [{ type: 'text', text: 'completed' }], details: { id } };
  }, ...overrides,
});
let executionGrant = new AbortController();
const allow = request => { received.push(request); return { allow: true, isCurrent: () => true, executionSignal: executionGrant.signal }; };
const test = async (name, action) => { await action(); cases.push(name); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let installed;
function policy(handler = allow) { installed?.dispose(); executionGrant = new AbortController(); installed = guard.installFinalExecutionPolicy(handler); return installed; }
const args = () => ({ target: 'permitted', nested: { value: 1 }, optional: undefined });

if (mode === 'unit') {
  assert.equal(guard.getFinalExecutionGuardReceipt(), null);
  let direct = (params = args(), context = ctx, signal) => guard.guardFinalToolExecution({ tool: raw(), toolCallId: 'call', params, ctx: context, signal, execute: raw().execute });
  await test('unrelated contexts preserve execution without setup or freezing', async () => {
    const params = args(); await direct(params, { runId: 'ordinary', sessionKey: 'agent:main:normal' }); assert(!Object.isFrozen(params));
  });
  await test('reserved run requires instrumentation', async () => { policy(); await assert.rejects(direct(), /unavailable/); });
  const targetURL = pathToFileURL(path.join(workspace, 'target.js')).href;
  guard.initializeFinalExecutionGuard({ protocolVersion: 1, targetURL, targetHash: 'fixture', installedRoot: workspace, version: 'fixture' });
  await test('receipt requires exact transformed module identity', async () => {
    assert.throws(() => guard.markFinalExecutionInstrumentation(pathToFileURL(path.join(workspace, 'other.js')).href), /identity/);
    assert.equal(guard.getFinalExecutionGuardReceipt(), null);
    guard.markFinalExecutionInstrumentation(targetURL);
    assert(Object.isFrozen(guard.getFinalExecutionGuardReceipt()));
  });
  await test('scoped root and alias require handler', async () => {
    installed.dispose();
    for (const context of [{ runId: 'mysti-a' }, { sessionKey: 'mysti-a' }, { sessionKey: 'agent:main:mysti-a' }]) { await assert.rejects(direct(args(), context), /unavailable/); }
  });
  await test('immutable exact params and output survive allowed execution', async () => {
    policy(); const params = args(); const before = effects; const result = await direct(params);
    assert.equal(effects, before + 1); assert.equal(result.content[0].text, 'completed');
    assert.equal(received.at(-1).params, params); assert(Object.isFrozen(params.nested));
    assert.throws(() => { params.nested.value = 9; }, TypeError);
  });
  await test('deny, expired current predicate and invalid decisions have no effect', async () => {
    const before = effects;
    for (const decision of [{ allow: false }, { allow: true, isCurrent: () => false }, { allow: true, isCurrent: async () => true }, undefined]) {
      policy(() => decision); await assert.rejects(direct(), /denied|expired/);
    }
    policy(() => { throw new Error('policy rejected'); }); await assert.rejects(direct(), /policy rejected/);
    assert.equal(effects, before);
  });
  for (const kind of ['abort', 'dispose', 'replace']) {
    await test(`${kind} wakes a pending policy and rejects its late approval`, async () => {
      const entered = deferred(); const answer = deferred(); const controller = new AbortController();
      const current = policy(request => { entered.resolve(request); return answer.promise; });
      const before = effects; const pending = direct(args(), ctx, controller.signal);
      const settled = assert.rejects(pending);
      const request = await entered.promise;
      if (kind === 'abort') { controller.abort(new Error('stopped')); }
      else if (kind === 'dispose') { current.dispose(); }
      else { policy(); }
      await settled; assert(request.signal.aborted); answer.resolve({ allow: true, isCurrent: () => true });
      await Promise.resolve(); assert.equal(effects, before);
    });
  }
  await test('policy disposal cancels already entered captured execution', async () => {
    const entered = deferred(); const continueExecution = deferred(); const current = policy(); const before = effects;
    const execute = async (id, params, signal) => {
      entered.resolve(signal); await continueExecution.promise; signal.throwIfAborted(); return raw().execute.call(undefined, id, params);
    };
    const pending = guard.guardFinalToolExecution({ tool: raw(), toolCallId: 'started', params: args(), ctx, execute });
    const rejected = assert.rejects(pending); const signal = await entered.promise; current.dispose(); assert(signal.aborted);
    continueExecution.resolve(); await rejected; assert.equal(effects, before);
  });
  await test('one cancelled run does not cancel another owned run', async () => {
    const pendingRequests = new Map(); const bothEntered = deferred(); const firstAbort = new AbortController();
    policy(request => {
      const answer = deferred(); pendingRequests.set(request.context.runId, answer);
      if (pendingRequests.size === 2) { bothEntered.resolve(); } return answer.promise;
    });
    const first = direct(args(), { ...ctx, runId: 'mysti-first' }, firstAbort.signal); const rejected = assert.rejects(first);
    const second = direct(args(), { ...ctx, runId: 'mysti-second' }); await bothEntered.promise;
    const before = effects; firstAbort.abort(); await rejected;
    pendingRequests.get('mysti-second').resolve({ allow: true, isCurrent: () => true }); await second;
    pendingRequests.get('mysti-first').resolve({ allow: true, isCurrent: () => true }); assert.equal(effects, before + 1);
  });
  await test('stale disposable cannot remove replacement handler', async () => {
    const first = policy(); const replacement = guard.installFinalExecutionPolicy(allow); first.dispose();
    await direct(); replacement.dispose();
  });
  await test('accessors, cyclic and oversized action objects fail closed', async () => {
    policy(); const cyclic = {}; cyclic.self = cyclic; let reads = 0;
    const accessor = { get target() { reads++; return 'hidden'; } };
    const before = effects;
    for (const params of [cyclic, accessor, { values: Array(20001).fill(0) }]) { await assert.rejects(direct(params), /JSON|accessor|too large/); }
    assert.equal(reads, 0); assert.equal(effects, before);
  });
  await test('explicit child lineage is guarded and survives policy disposal', async () => {
    assert.throws(() => guard.markOwnedExecutionContext({ runId: 'child', parentRunId: 'unknown' }), /parent/);
    guard.markOwnedExecutionContext({ runId: 'child', sessionKey: 'agent:main:subagent:opaque', parentRunId: ctx.runId });
    policy(); await direct(args(), { runId: 'child', sessionKey: 'agent:main:subagent:opaque' }); installed.dispose();
    await assert.rejects(direct(args(), { runId: 'child' }), /unavailable/);
    await assert.rejects(direct(args(), { sessionKey: 'agent:main:subagent:opaque' }), /unavailable/);
  });
  await test('ownership overflow never evicts into permission', async () => {
    policy(); let failure;
    for (let i = 0; i <= guard.MAX_OWNED_EXECUTION_IDENTITIES; i++) {
      try { guard.markOwnedExecutionContext({ runId: `owned-${i}`, parentRunId: ctx.runId }); }
      catch (error) { failure = error; break; }
    }
    assert.match(failure.message, /capacity/);
    await assert.rejects(direct(args(), { runId: 'owned-0' }), /capacity/);
    await assert.rejects(direct(args(), { runId: 'unrecorded-after-overflow' }), /capacity/);
  });
} else {
  assert.equal(guard.getFinalExecutionGuardReceipt(), null);
  const root = process.env.MYSTI_OPENCLAW_ROOT;
  const sdk = await import(pathToFileURL(path.join(root, 'dist/plugin-sdk/agent-harness.js')));
  const hooks = await import(pathToFileURL(path.join(root, 'dist/plugin-sdk/hook-runtime.js')));
  assert.equal(guard.getFinalExecutionGuardReceipt()?.version, '2026.6.34');
  assert.equal(guard.getFinalExecutionGuardReceipt()?.installedRoot, fs.realpathSync(root));
  const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
  const hookRegistry = (ordinary = []) => {
    hooks.resetGlobalHookRunner();
    hooks.initializeGlobalHookRunner({ plugins: [{ id: 'fixture', status: 'loaded' }], hooks: [], trustedToolPolicies: [], typedHooks: ordinary.map((handler, i) => ({ pluginId: `hook-${i}`, hookName: 'before_tool_call', handler, source: workspace })) });
  };
  const wrap = tool => sdk.wrapToolWithBeforeToolCallHook(tool, { ...ctx, config }, { emitDiagnostics: false });
  if (mode === 'pipeline') {
    await test('actual transformed wrapper denies without handler', async () => { hookRegistry(); await assert.rejects(wrap(raw()).execute('missing', args()), /unavailable/); });
    await test('owned runtime denies unowned or missing context without a handler', async () => {
      for (const context of [undefined, {}, { runId: 'unexpected-child', sessionKey: 'agent:main:foreign' }]) {
        const tool = sdk.wrapToolWithBeforeToolCallHook(raw(), context, { emitDiagnostics: false });
        await assert.rejects(tool.execute('unowned', args()), /unavailable/);
      }
      const current = policy(); current.dispose();
      await assert.rejects(sdk.wrapToolWithBeforeToolCallHook(raw(), {}, { emitDiagnostics: false }).execute('after-dispose', args()), /unavailable/);
    });
    await test('owned runtime requires a live grant revocation signal for allow', async () => {
      hookRegistry(); const before = effects;
      for (const executionSignal of [undefined, {}, AbortSignal.abort()]) {
        policy(() => ({ allow: true, isCurrent: () => true, executionSignal }));
        await assert.rejects(wrap(raw()).execute('no-grant-signal', args()));
      }
      assert.equal(effects, before);
    });
    await test('policy sees final ordinary mutation, not original card action', async () => {
      hookRegistry([() => ({ params: { target: 'changed-by-hook' } })]); policy(); await wrap(raw()).execute('changed', args());
      assert.equal(received.at(-1).params.target, 'changed-by-hook');
    });
    await test('policy sees finalizer output and preserves WeakMap metadata', async () => {
      hookRegistry(); policy(); const metadata = new WeakMap(); let finalParams;
      const tool = raw({ finalizeBeforeToolCallParams(params) { finalParams = { ...params, target: 'changed-by-finalizer', optional: undefined }; metadata.set(finalParams, 'prepared environment'); return finalParams; },
        async execute(id, params) { assert.equal(this, undefined); assert.equal(params, finalParams); assert.equal(metadata.get(params), 'prepared environment'); assert(Object.isFrozen(params)); return raw().execute.call(undefined, id, params); } });
      await wrap(tool).execute('finalizer', args()); assert.equal(received.at(-1).params, finalParams);
    });
    await test('final changed action remains inert while decision pending and after denial', async () => {
      hookRegistry([() => ({ params: { target: 'last-target' } })]); const entered = deferred(); const answer = deferred();
      policy(request => { entered.resolve(request); return answer.promise; });
      const before = effects; const pending = wrap(raw()).execute('denied-change', args()); const denied = assert.rejects(pending, /denied/);
      const request = await entered.promise; assert.equal(request.params.target, 'last-target'); assert.equal(effects, before);
      answer.resolve({ allow: false }); await denied; assert.equal(effects, before);
    });
    await test('actual transformed wrapper aborts pending decisions without effects', async () => {
      hookRegistry(); const entered = deferred(); const answer = deferred(); const controller = new AbortController();
      policy(request => { entered.resolve(request); return answer.promise; }); const before = effects;
      const pending = wrap(raw()).execute('cancelled', args(), controller.signal); const denied = assert.rejects(pending);
      await entered.promise; controller.abort(); await denied; answer.resolve({ allow: true, isCurrent: () => true }); assert.equal(effects, before);
    });
    await test('host Code Mode identity accompanies final params', async () => {
      hookRegistry(); policy();
      const native = await import(pathToFileURL(path.join(root, 'dist/agent-tools.before-tool-call-59sE70R-.js')));
      const tool = native.S(raw({ name: 'exec' }));
      await wrap(tool).execute('code-mode', { code: 'return 42', language: 'typescript' });
      assert.equal(received.at(-1).toolKind, 'code_mode_exec');
      assert.equal(received.at(-1).toolInputKind, 'typescript');
    });
    await test('exact one allow keeps original output', async () => {
      hookRegistry(); policy(); const before = effects; const result = await wrap(raw()).execute('allowed', args());
      assert.equal(effects, before + 1); assert.equal(result.content[0].text, 'completed');
    });
  } else if (mode === 'core') {
    hookRegistry(); policy();
    const tools = sdk.createOpenClawCodingTools({ config, workspaceDir: workspace, cwd: workspace, runId: ctx.runId, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey, emitBeforeToolCallDiagnostics: false });
    const invoke = async (name, params) => {
      const tool = tools.find(candidate => candidate.name === name); assert(tool, `${name} must exist`);
      const result = await tool.execute(`core-${name}`, params); assert(!result.isError, JSON.stringify(result)); return result;
    };
    await test('stock write receives frozen final params', async () => { await invoke('write', { path: path.join(workspace, 'actual.txt'), content: 'before\n' }); assert.equal(fs.readFileSync(path.join(workspace, 'actual.txt'), 'utf8'), 'before\n'); });
    await test('stock read preserves result', async () => { const result = await invoke('read', { path: path.join(workspace, 'actual.txt') }); assert.match(JSON.stringify(result), /before/); });
    await test('stock edit works with frozen final params', async () => { await invoke('edit', { path: path.join(workspace, 'actual.txt'), edits: [{ oldText: 'before', newText: 'after' }] }); assert.equal(fs.readFileSync(path.join(workspace, 'actual.txt'), 'utf8'), 'after\n'); });
    await test('stock exec preserves prepared args and executes an inert child once', async () => {
      const program = `require('node:fs').appendFileSync(${JSON.stringify(path.join(workspace, 'exec-count'))}, '1'); process.stdout.write('inert-exec-ok');`;
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const result = await invoke('exec', { command: `${quote(process.execPath)} -e ${quote(program)}`, yieldMs: 10000 });
      assert.match(JSON.stringify(result), /inert-exec-ok/); assert.equal(fs.readFileSync(path.join(workspace, 'exec-count'), 'utf8'), '1');
    });
    await test('grant revocation kills a real foreground exec after allow', async () => {
      const started = path.join(workspace, 'revoked-exec-started'); const late = path.join(workspace, 'revoked-exec-late');
      const program = `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'bad'), 1200); setInterval(() => {}, 1000);`;
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const tool = tools.find(candidate => candidate.name === 'exec');
      const running = tool.execute('core-revoked-exec', { command: `${quote(process.execPath)} -e ${quote(program)}` }).catch(error => ({ error: String(error) }));
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(started) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
      assert(fs.existsSync(started), 'child must start only after allow'); executionGrant.abort(new Error('lease revoked'));
      await running; await new Promise(resolve => setTimeout(resolve, 1400)); assert(!fs.existsSync(late));
    });
    assert.deepEqual(received.map(request => request.toolName), ['write', 'read', 'edit', 'exec', 'exec']);
  } else { throw new Error('Unknown fixture mode'); }
  hooks.resetGlobalHookRunner();
}
installed?.dispose();
assert.equal(networkAttempts, 0);
console.log(JSON.stringify({ mode, cases, effects, networkAttempts, receipt: guard.getFinalExecutionGuardReceipt() }));
