'use strict';
const fs = require('node:fs'), path = require('node:path');
exports.createCapabilitiesCli = config => {
  const receiptFile = path.join(config.directory, `${config.provider}-receipts.jsonl`);
  const launcher = path.join(config.directory, `${config.provider}-capabilities-fixture`);
  const runtime = path.join(config.directory, 'capabilities-cli-runtime.cjs');
  if (!fs.existsSync(runtime)) fs.copyFileSync(path.join(__dirname, 'capabilities-cli-runtime.cjs'), runtime);
  fs.writeFileSync(launcher, `#!${config.node}\n'use strict';\nrequire(${JSON.stringify(runtime)}).run(${JSON.stringify({ ...config, receiptFile })},process.argv.slice(2));\n`, { mode: 0o700 });
  return { launcher, receipts: receiptFile, runtime };
};
