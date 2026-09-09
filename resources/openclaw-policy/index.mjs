/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFinalExecutionGuardReceipt, installFinalExecutionPolicy } from './runtime-guard.mjs';
import { MystiPolicyClient } from './policy-client.mjs';
import { ownedPolicyRuntime } from './policy-runtime-state.mjs';

export default {
  id: 'mysti-policy', name: 'Mysti native approvals',
  register(api) {
    const owner = ownedPolicyRuntime(api.pluginConfig?.broker, credentials => {
      const state = { credentials, client: undefined, started: undefined, closed: false, services: new Set() };
      state.admitRun = (_event, context) => state.client?.owns(context) ? { outcome: 'pass' }
        : { outcome: 'block', reason: 'Missing Mysti run lease', message: 'The Mysti approval connection is unavailable.' };
      state.registration = installFinalExecutionPolicy(request => state.client
        ? state.client.evaluate(request) : Promise.resolve({ allow: false, isCurrent: () => false }));
      return state;
    });
    const serviceOwner = {};
    api.registerTrustedToolPolicy({
      id: 'mysti-final-policy', description: 'Require live Mysti authority before native tools',
      evaluate(event, context) {
        if (!owner.client?.owns(context) || !owner.client.supports(event)) {
          return { block: true, blockReason: 'This native tool or run has no supported Mysti approval authority.' };
        }
        // Arguments can still change after this hook. Only the final raw-execute
        // guard may request approval; this hook is an early admission barrier.
        return { allow: true };
      },
    });
    api.on('before_agent_run', owner.admitRun);
    api.registerService({
      id: 'mysti-policy-connection',
      async start() {
        if (owner.closed) { throw new Error('Mysti policy service already stopped'); }
        owner.services.add(serviceOwner);
        owner.started ??= startOwner(owner);
        try { await owner.started; }
        catch (error) { stopOwner(owner, serviceOwner); throw error; }
      },
      stop() { stopOwner(owner, serviceOwner); },
    });
  },
};

async function startOwner(owner) {
  try {
    if (process.env.MYSTI_OPENCLAW_OWNED_RUNTIME !== '1') { throw new Error('Mysti policy requires its owned runtime'); }
    const root = process.env.MYSTI_OPENCLAW_ROOT;
    // Loading the public SDK evaluates the hash-verified tool wrapper before
    // we attest readiness. Merely loading the plugin is not an attestation.
    const sdk = await import(pathToFileURL(path.join(root, 'dist/plugin-sdk/agent-harness-runtime.js')).href);
    const hooks = await import(pathToFileURL(path.join(root, 'dist/plugin-sdk/plugin-runtime.js')).href);
    const receipt = getFinalExecutionGuardReceipt();
    const state = sdk.getBeforeToolCallPolicyDiagnosticState();
    const admissionActive = hooks.hasGlobalHooks('before_agent_run') && hooks.getGlobalPluginRegistry()?.typedHooks.some(
      hook => hook.pluginId === 'mysti-policy' && hook.hookName === 'before_agent_run' && hook.handler === owner.admitRun);
    if (!receipt || !admissionActive
      || !state.trustedToolPolicies.some(policy => policy.pluginId === 'mysti-policy' && policy.id === 'mysti-final-policy')) {
      throw new Error('Mysti final native execution policy did not activate');
    }
    if (owner.closed) { throw new Error('Mysti policy stopped during startup'); }
    // Set only after gateway service startup: passing this marker to the CLI
    // entrypoint would also enable its unrelated stale-gateway cleanup. Stock
    // foreground exec checks it dynamically and stays in our owned POSIX group.
    process.env.OPENCLAW_SERVICE_MARKER = 'mysti-owned-policy';
    const require = createRequire(path.join(root, 'package.json'));
    owner.client = new MystiPolicyClient(owner.credentials, require('ws'), receipt);
    await owner.client.start();
    if (owner.closed) { throw new Error('Mysti policy stopped during startup'); }
  } catch (error) {
    owner.closed = true;
    owner.client?.dispose();
    owner.registration.dispose();
    throw error;
  }
}

function stopOwner(owner, serviceOwner) {
  if (!owner.services.delete(serviceOwner) || owner.services.size > 0) { return; }
  owner.closed = true;
  owner.client?.dispose();
  owner.registration.dispose();
}
