import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import type * as Native from '@number0/iroh/index';
import { bindDeskIroh, supportsDeskIroh } from './DeskIrohNative';
import { DeskIrohServer, DeskIrohTransport } from './DeskIrohTransport';

// This entrypoint is forked only after the editor owner checks user settings,
// trust and (for dialing) the signed pinned descriptor. It never loads a vault.
let initialized = false;
let nextId = 0;
const pending = new Map<number, { resolve(body: unknown): void; timer: ReturnType<typeof setTimeout> }>();
const fail = () => process.exit(1);
process.on('disconnect', fail);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

function binding(): typeof Native {
  if (!supportsDeskIroh(process.versions.node, process.platform, process.arch)) { throw new Error('unsupported'); }
  const root = path.join(__dirname, '../resources/desk-native');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const target = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
  if (manifest.version !== '1.1.0' || manifest.target !== target || !/^[a-f0-9]{64}$/.test(manifest.sha256)) { throw new Error('unsupported'); }
  const binary = path.join(root, 'binding.node');
  const stat = fs.lstatSync(binary);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024
    || createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== manifest.sha256) { throw new Error('invalid'); }
  // Bypass the upstream main path, generated env override and ldd subprocess.
  return createRequire(__filename)(binary) as typeof Native;
}

process.on('message', async (raw: unknown) => {
  try {
    if (!raw || typeof raw !== 'object') { fail(); return; }
    const value = raw as Record<string, unknown>;
    if (value.kind === 'response' && Number.isSafeInteger(value.id)) {
      const request = pending.get(value.id as number);
      if (request) { clearTimeout(request.timer); pending.delete(value.id as number); request.resolve(value.body); }
      return;
    }
    if (initialized || !['serve', 'call'].includes(String(value.mode)) || typeof value.relayUrl !== 'string') { fail(); return; }
    initialized = true;
    const endpoint = await bindDeskIroh(binding(), value.relayUrl);
    if (value.mode === 'serve') {
      const server = new DeskIrohServer(endpoint, String(value.bearer), body => new Promise((resolve, reject) => {
        if (pending.size >= 4) { reject(new Error('busy')); return; }
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('expired')); }, 10_000);
        pending.set(id, { resolve, timer });
        process.send?.({ kind: 'request', id, body });
      }));
      server.start();
      process.send?.({ kind: 'ready', endpointId: endpoint.id().toString() });
    } else {
      const result = await new DeskIrohTransport(endpoint, String(value.endpointId)).post(`iroh://${value.endpointId}/desk`, value.body, {
        bearer: String(value.bearer), maxBytes: Number(value.maxBytes), timeoutMs: Number(value.timeoutMs), signal: new AbortController().signal,
      });
      process.send?.({ kind: 'result', result });
    }
  } catch { fail(); }
});
