/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { fileURLToPath } from 'node:url';
import { instrumentFinalExecutionModule, verifyModuleSource } from './runtime-manifest.mjs';

let verifiedModules;
let guardURL;

export function initialize(data) {
  verifiedModules = new Map(data.modules.map(module => [fileURLToPath(module.url), module]));
  guardURL = data.guardURL;
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const module = url.startsWith('file:') ? verifiedModules?.get(fileURLToPath(url)) : undefined;
  if (!module) { return loaded; }
  if (loaded.format !== 'module' || loaded.source == null) {
    throw new Error('Mysti OpenClaw runtime expected a verified ESM source module');
  }
  // Verify again at actual load, including modules inspected during preflight:
  // an intervening file change or another transforming loader must fail closed.
  const source = verifyModuleSource(loaded.source, module.hash);
  return { ...loaded, source: module.instrument ? instrumentFinalExecutionModule(source, guardURL) : source };
}
