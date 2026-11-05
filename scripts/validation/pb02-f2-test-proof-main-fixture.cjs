'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.createPB02F2TestProofMainCli = config => {
  assert.equal(config.maxInputs, 1);
  assert(typeof config.proofJustification === 'string' && config.proofJustification.length > 0 && config.proofJustification.length <= 2000);
  assert(path.isAbsolute(config.node) && !/[\s\n]/.test(config.node));
  const receiptFile = path.join(config.directory, 'openai-codex-receipts.jsonl');
  const launcher = path.join(config.directory, 'codex-pb02-f2-test-proof-main');
  const runtime = path.join(config.directory, 'pb02-f2-test-proof-main-runtime.cjs');
  fs.copyFileSync(path.join(__dirname, 'pb02-f2-test-proof-main-runtime.cjs'), runtime, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(launcher, `#!${config.node}\n'use strict';\nrequire(${JSON.stringify(runtime)})(${JSON.stringify({ ...config, receiptFile })});\n`, { mode: 0o700, flag: 'wx' });
  return { launcher, receipts: receiptFile, runtime };
};
