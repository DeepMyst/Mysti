'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.createPB02HelperQualityAuxiliaryCli = config => {
  assert(path.isAbsolute(config.node) && !/[\s\n]/.test(config.node));
  const outputDirectory = path.join(config.directory, 'helper-outputs');
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  assert(config.allowlist && config.allowlist.maxOutputBytes === 32768);
  const capture = { ...config.allowlist, directory: outputDirectory };
  const receiptFile = path.join(config.directory, 'claude-auxiliary-receipts.jsonl');
  const launcher = path.join(config.directory, 'claude-pb02-helper-quality-auxiliary');
  const runtime = path.join(config.directory, 'pb02-helper-quality-auxiliary-runtime.cjs');
  fs.copyFileSync(path.join(__dirname, 'pb02-helper-quality-auxiliary-runtime.cjs'), runtime, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(receiptFile, '', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(launcher, `#!${config.node}\n'use strict';\nrequire(${JSON.stringify(runtime)}).run(${JSON.stringify({ ...config, receiptFile, capture })});\n`, { mode: 0o700, flag: 'wx' });
  return { launcher, runtime, receipts: receiptFile, outputDirectory };
};
