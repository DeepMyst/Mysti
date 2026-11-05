'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.createPB02AuxiliaryCli = config => {
  assert(path.isAbsolute(config.node) && !/[\s\n]/.test(config.node));
  const receiptFile = path.join(config.directory, 'claude-auxiliary-receipts.jsonl');
  const launcher = path.join(config.directory, 'claude-pb02-auxiliary');
  const runtime = path.join(config.directory, 'pb02-auxiliary-cli-runtime.cjs');
  fs.copyFileSync(path.join(__dirname, 'pb02-auxiliary-cli-runtime.cjs'), runtime, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(receiptFile, '', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(launcher, `#!${config.node}\n'use strict';\nrequire(${JSON.stringify(runtime)}).run(${JSON.stringify({ ...config, receiptFile })});\n`, { mode: 0o700, flag: 'wx' });
  return { launcher, runtime, receipts: receiptFile };
};
