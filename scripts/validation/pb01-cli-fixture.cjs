'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.createPB01Cli=config=>{
  assert(path.isAbsolute(config.node)&&!/[\s\n]/.test(config.node),'Pinned shebang Node path must not contain whitespace');
  const receiptFile=path.join(config.directory,'claude-code-receipts.jsonl'),launcher=path.join(config.directory,'claude-code-pb01-fixture');
  const runtime=path.join(config.directory,'pb01-cli-runtime.cjs');
  fs.copyFileSync(path.join(__dirname,'pb01-cli-runtime.cjs'),runtime,fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(launcher,`#!${config.node}\n'use strict';\nrequire(${JSON.stringify(runtime)})(${JSON.stringify({...config,receiptFile})});\n`,{mode:0o700,flag:'wx'});
  return {launcher,receipts:receiptFile,runtime};
};
