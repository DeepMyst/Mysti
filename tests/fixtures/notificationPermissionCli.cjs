// PC-12: local disposable process. No model, network, user configuration or credentials.
const fs = require('node:fs');
const [canary, receipt, ...args] = process.argv.slice(2);
const readonly = args.includes('plan') || args.includes('--plan') || args.includes('--deny-tool');
// Mirrors a notification stream: it does not wait for a permission response.
fs.writeSync(1, JSON.stringify({ type: 'tool_use', tool_name: 'write_file', tool_id: 'owned-write',
  parameters: { file_path: canary, content: 'fixture write' } }) + '\n');
if (!readonly && args.includes('--yolo')) fs.writeFileSync(canary, 'fixture write');
fs.writeFileSync(receipt, JSON.stringify({ writeCompleted: fs.existsSync(canary) }));
setTimeout(() => process.exit(0), 1000);
