/** Inert singleton/service contract fixture. Native SDK activation is tested separately. */
/* eslint-env node, es2022 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const mode = process.argv[2];
const resources = new URL('../../../resources/openclaw-policy/', import.meta.url);
const stateURL = new URL('policy-runtime-state.mjs', resources);
const indexURL = new URL('index.mjs', resources);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-policy-owner-'));
process.env.MYSTI_OPENCLAW_OWNED_RUNTIME = '1';
process.env.MYSTI_OPENCLAW_ROOT = root;
const { ownedPolicyRuntime } = await import(stateURL.href);
const cases = [];
const test = async (name, check) => { await check(); cases.push(name); };
const credentials = { url: 'ws://127.0.0.1:12345', runtimeId: 'runtime-1', token: randomBytes(32).toString('hex') };
const cleanup = [];

try {
  if (mode === 'identity') {
    let created = 0;
    const first = ownedPolicyRuntime(credentials, captured => ({ captured, closed: false, number: ++created }));
    await test('cache-busted reevaluation shares one immutable authority owner', async () => {
      const reloaded = await import(`${stateURL.href}?reevaluated=1`);
      assert.notEqual(reloaded.ownedPolicyRuntime, ownedPolicyRuntime);
      const second = reloaded.ownedPolicyRuntime({ ...credentials }, () => { throw new Error('Must not recreate'); });
      assert.equal(first, second);
      assert.equal(created, 1);
      assert(Object.isFrozen(first.captured));
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('mysti.openclaw.policy.runtime.v1'));
      assert.equal(descriptor.writable, false);
      assert.equal(descriptor.configurable, false);
      assert(Object.isFrozen(descriptor.value));
    });
    await test('broker runtime token URL and installation mismatches cannot replace authority', async () => {
      for (const changed of [
        { runtimeId: 'another-runtime' }, { token: 'b'.repeat(64) }, { url: 'ws://127.0.0.1:12346' },
      ]) {
        assert.throws(() => ownedPolicyRuntime({ ...credentials, ...changed }, () => { created++; }), /changed or stopped/);
      }
      process.env.MYSTI_OPENCLAW_ROOT = path.join(root, 'another-installation');
      assert.throws(() => ownedPolicyRuntime(credentials, () => { created++; }), /changed or stopped/);
      process.env.MYSTI_OPENCLAW_ROOT = root;
      process.env.MYSTI_OPENCLAW_OWNED_RUNTIME = '';
      assert.throws(() => ownedPolicyRuntime(credentials, () => { created++; }), /requires an owned runtime/);
      process.env.MYSTI_OPENCLAW_OWNED_RUNTIME = '1';
      assert.equal(ownedPolicyRuntime(credentials, () => { created++; }), first);
      assert.equal(created, 1);
    });
    await test('a closed owner remains a tombstone across cache-busted reevaluation', async () => {
      first.closed = true;
      const reloaded = await import(`${stateURL.href}?reevaluated=2`);
      assert.throws(() => reloaded.ownedPolicyRuntime(credentials, () => { created++; }), /changed or stopped/);
      assert.equal(created, 1);
    });
  } else {
    // These stubs attest only this fixture's registration table, never stock runtime coverage.
    const sdkDir = path.join(root, 'dist/plugin-sdk');
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(sdkDir, 'agent-harness-runtime.js'), `
      if (globalThis.mystiPolicyFixture.delay) { globalThis.mystiPolicyFixture.entered(); await globalThis.mystiPolicyFixture.delay; }
      export const getBeforeToolCallPolicyDiagnosticState = () => ({trustedToolPolicies: globalThis.mystiPolicyFixture.policies});
    `);
    fs.writeFileSync(path.join(sdkDir, 'plugin-runtime.js'), `
      export const hasGlobalHooks = name => globalThis.mystiPolicyFixture.hooks.some(hook => hook.hookName === name);
      export const getGlobalPluginRegistry = () => ({typedHooks: globalThis.mystiPolicyFixture.hooks});
    `);
    globalThis.mystiPolicyFixture = { hooks: [], policies: [] };
    const guard = await import(new URL('runtime-guard.mjs', resources).href);
    guard.initializeFinalExecutionGuard({ protocolVersion: 1, targetURL: indexURL.href, installedRoot: root,
      version: '2026.6.34', targetHash: 'inert-singleton-fixture', ownedRuntime: true });
    guard.markFinalExecutionInstrumentation(indexURL.href);
    const projectRequire = createRequire(new URL('../../../package.json', import.meta.url));
    const { WebSocketServer } = projectRequire('ws');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(path.dirname(projectRequire.resolve('ws/package.json')), path.join(root, 'node_modules/ws'), 'dir');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    credentials.url = `ws://127.0.0.1:${server.address().port}`;
    const sockets = [];
    const requests = [];
    server.on('connection', socket => {
      sockets.push(socket);
      socket.on('error', () => {});
      socket.on('message', data => {
        const value = JSON.parse(data.toString());
        requests.push(value);
        if (value.type === 'hello') {
          assert.equal(value.runtimeId, credentials.runtimeId);
          assert.equal(value.token, credentials.token);
          socket.send(JSON.stringify({ type: 'hello.ready', protocol: 1, runtimeId: credentials.runtimeId }));
        }
      });
    });
    cleanup.push(async () => {
      for (const socket of sockets) { socket.terminate(); }
      await new Promise(resolve => server.close(resolve));
    });
    const makeApi = () => {
      const record = { services: [], hooks: [], policies: [] };
      return {
        record, pluginConfig: { broker: { ...credentials } },
        registerTrustedToolPolicy(policy) {
          record.policies.push(policy);
          globalThis.mystiPolicyFixture.policies.push({ ...policy, pluginId: 'mysti-policy' });
        },
        on(hookName, handler) {
          record.hooks.push({ hookName, handler });
          globalThis.mystiPolicyFixture.hooks.push({ hookName, handler, pluginId: 'mysti-policy' });
        },
        registerService(service) { record.services.push(service); },
      };
    };
    const plugin = (await import(indexURL.href)).default;
    const firstApi = makeApi();
    plugin.register(firstApi);
    const firstService = firstApi.record.services[0];
    const owner = ownedPolicyRuntime(credentials, () => { throw new Error('Owner already registered'); });
    cleanup.push(() => { owner.client?.dispose(); owner.registration.dispose(); });
    const initialRegistration = owner.registration;
    const reloaded = (await import(`${indexURL.href}?reevaluated=1`)).default;
    const secondApi = makeApi();
    reloaded.register(secondApi);
    const secondService = secondApi.record.services[0];
    assert.equal(owner.registration, initialRegistration);
    assert.equal(firstApi.record.hooks[0].handler, secondApi.record.hooks[0].handler);
    assert.equal(firstApi.record.hooks[0].handler({}, {}).outcome, 'block');

    if (mode === 'services') {
      await test('multiple service starts share one native policy connection', async () => {
        await Promise.all([firstService.start(), secondService.start()]);
        assert.equal(owner.services.size, 2);
        assert.equal(sockets.length, 1);
        assert.equal(requests.filter(value => value.type === 'hello').length, 1);
        assert.equal(owner.client.closed, false);
      });
      await test('new registry hooks see the existing granted owner without starting another service', async () => {
        const thirdApi = makeApi();
        reloaded.register(thirdApi);
        const opened = once(sockets[0], 'message');
        const context = { runId: 'mysti-granted', sessionKey: 'agent:main:mysti-session' };
        sockets[0].send(JSON.stringify({ type: 'run.open', ...context, grantId: 'grant', expiresAt: Date.now() + 15000 }));
        assert.equal(JSON.parse((await opened)[0].toString()).type, 'run.ready');
        for (const api of [firstApi, secondApi, thirdApi]) {
          assert.equal(api.record.hooks[0].handler({}, context).outcome, 'pass');
          assert.deepEqual(api.record.policies[0].evaluate({ toolName: 'write' }, context), { allow: true });
        }
        thirdApi.record.services[0].stop();
        assert.equal(owner.services.size, 2);
        assert.equal(owner.closed, false);
        assert.equal(owner.client.closed, false);
      });
      await test('stopping an obsolete or repeated owner cannot stop another active service', async () => {
        firstService.stop(); firstService.stop();
        assert.equal(owner.services.size, 1);
        assert.equal(owner.closed, false);
        assert.equal(owner.client.closed, false);
        assert.equal(owner.registration, initialRegistration);
        await secondService.start();
        assert.equal(owner.services.size, 1);
        assert.equal(sockets.length, 1);
      });
      await test('last service stop aborts grants and cannot be revived by a late start or register', async () => {
        const grant = owner.client.grants.get('mysti-granted');
        secondService.stop();
        assert.equal(grant.controller.signal.aborted, true);
        assert.equal(owner.closed, true);
        assert.equal(owner.client.closed, true);
        assert.equal(owner.services.size, 0);
        await assert.rejects(secondService.start(), /already stopped/);
        assert.throws(() => reloaded.register(makeApi()), /changed or stopped/);
        assert.equal(secondApi.record.hooks[0].handler({}, { runId: 'mysti-granted', sessionKey: 'agent:main:mysti-session' }).outcome, 'block');
        assert.equal(sockets.length, 1);
      });
    } else if (mode === 'stop-startup') {
      let release;
      let entered;
      const entering = new Promise(resolve => { entered = resolve; });
      globalThis.mystiPolicyFixture.entered = entered;
      globalThis.mystiPolicyFixture.delay = new Promise(resolve => { release = resolve; });
      const starting = firstService.start();
      const rejected = assert.rejects(starting, /stopped during startup/);
      await entering;
      firstService.stop();
      release();
      await rejected;
      await test('stopping the last service during SDK loading prevents a later native connection', async () => {
        assert.equal(owner.closed, true);
        assert.equal(owner.services.size, 0);
        assert.equal(owner.client, undefined);
        assert.equal(sockets.length, 0);
        await assert.rejects(secondService.start(), /already stopped/);
      });
    } else if (mode === 'failed-startup') {
      globalThis.mystiPolicyFixture.policies.length = 0;
      await test('failed policy attestation closes the shared owner for every registration', async () => {
        const results = await Promise.allSettled([firstService.start(), secondService.start()]);
        assert(results.every(result => result.status === 'rejected' && /did not activate/.test(String(result.reason))));
        assert.equal(owner.closed, true);
        assert.equal(owner.services.size, 0);
        assert.equal(sockets.length, 0);
        await assert.rejects(firstService.start(), /already stopped/);
        assert.throws(() => reloaded.register(makeApi()), /changed or stopped/);
      });
    } else { throw new Error('Unknown lifecycle fixture mode'); }
  }
  console.log(JSON.stringify({ mode, cases }));
} finally {
  for (const release of cleanup.reverse()) { await release(); }
  fs.rmSync(root, { recursive: true, force: true });
}
