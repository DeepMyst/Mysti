/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FINAL_EXECUTION_PROTOCOL = 1;
export const OPENCLAW_VERSION = '2026.6.34';
export const FINAL_EXECUTION_MODULE = 'dist/agent-tools.before-tool-call-59sE70R-.js';
export const VERIFIED_MODULES = Object.freeze({
  [FINAL_EXECUTION_MODULE]: '2f8ba157e5660c32b85826eb3269a59b8add55062e31ed3d6d1528dd1017ad4b',
  'dist/hook-runner-global-D_43rcnU.js': 'd2ade7ea51fff02574643574acfed5a7bbbe6b01fd5df5797c9ebaddd2674bda',
  'dist/agent-tools-Dpv9_S5A.js': '58b5418f35feb5264bb10a8cabba2688123ca80131e106c2d5cd8959857d27be',
  'dist/native-hook-relay-B-nKeNyC.js': '4f5cd59a38ab64bae3e326c2ec0b07264e89ea638b416aeb2924309340334482',
  'dist/supervisor-BsgzaQWk.js': '5f14db94d2e39a9ac2bbc2c1042286b33c4fb28d9d633784dc3fd48629f2ba10',
  'dist/bash-tools.exec-runtime-DhPzqgnv.js': '7817fae733c7bdf1a14806df6741e6d661d4a37a06a846a593e03ec358909a60',
});

export function verifyModuleSource(source, expectedHash) {
  const bytes = typeof source === 'string' ? Buffer.from(source) : Buffer.from(source);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new Error('Mysti OpenClaw runtime source does not match the verified release');
  }
  return bytes.toString('utf8');
}

/** Runs in the preload before the application's entrypoint can execute. */
export function verifyOpenClawInstallation(root) {
  if (!root || !path.isAbsolute(root)) { throw new Error('Mysti OpenClaw runtime requires an absolute installation root'); }
  const installedRoot = realpathSync(root);
  const metadata = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  if (metadata.name !== 'openclaw' || metadata.version !== OPENCLAW_VERSION) {
    throw new Error(`Mysti OpenClaw runtime requires verified OpenClaw ${OPENCLAW_VERSION}`);
  }
  const modules = Object.entries(VERIFIED_MODULES).map(([relativePath, hash]) => {
    const filename = realpathSync(path.join(installedRoot, relativePath));
    if (!filename.startsWith(installedRoot + path.sep)) { throw new Error('Mysti OpenClaw runtime module escapes its installation'); }
    verifyModuleSource(readFileSync(filename), hash);
    return { url: pathToFileURL(filename).href, hash, instrument: relativePath === FINAL_EXECUTION_MODULE };
  });
  return Object.freeze({
    protocolVersion: FINAL_EXECUTION_PROTOCOL,
    installedRoot,
    version: OPENCLAW_VERSION,
    targetHash: VERIFIED_MODULES[FINAL_EXECUTION_MODULE],
    targetURL: modules.find(module => module.instrument).url,
    modules,
  });
}

/** Only the exact inspected source may receive this narrowly scoped transform. */
export function instrumentFinalExecutionModule(source, guardURL) {
  const original = verifyModuleSource(source, VERIFIED_MODULES[FINAL_EXECUTION_MODULE]);
  const needle = '\tconst execute = tool.execute;\n';
  if (original.split(needle).length !== 2) { throw new Error('Mysti OpenClaw runtime patch location is not unique'); }
  const importLine = `import { guardFinalToolExecution as mystiGuardFinalToolExecution, markFinalExecutionInstrumentation as mystiMarkFinalExecutionInstrumentation } from ${JSON.stringify(guardURL)};\n`;
  const replacement = '\tconst sourceExecute = tool.execute;\n'
    + '\tconst execute = sourceExecute && ((toolCallId, finalParams, signal, onUpdate) => mystiGuardFinalToolExecution({ tool, toolCallId, params: finalParams, toolIdentity: getCodeModeExecBeforeHookMetadata({ tool, params: finalParams }), ctx, signal, onUpdate, execute: sourceExecute }));\n';
  return importLine + original.replace(needle, replacement)
    + '\nmystiMarkFinalExecutionInstrumentation(import.meta.url);\n';
}
