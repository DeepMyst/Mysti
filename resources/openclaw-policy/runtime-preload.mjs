/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { register } from 'node:module';
import { verifyOpenClawInstallation } from './runtime-manifest.mjs';
import { initializeFinalExecutionGuard } from './runtime-guard.mjs';

// Set only on a process owned by Mysti. Merely installing these resources has no
// effect on any OpenClaw installation or unrelated process.
if (process.env.MYSTI_OPENCLAW_OWNED_RUNTIME === '1') {
  const receipt = verifyOpenClawInstallation(process.env.MYSTI_OPENCLAW_ROOT);
  initializeFinalExecutionGuard({ ...receipt, ownedRuntime: true });
  register(new URL('./runtime-loader.mjs', import.meta.url), {
    parentURL: import.meta.url,
    data: { modules: receipt.modules, guardURL: new URL('./runtime-guard.mjs', import.meta.url).href },
  });
}
