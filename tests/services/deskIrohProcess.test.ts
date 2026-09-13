import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeskIrohProcess } from '../../src/services/DeskIrohProcess';
import { supportsDeskIroh } from '../../src/services/DeskIrohNative';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) { await close(); } });

async function fixture(source: string) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mysti-iroh-process-'));
  cleanup.push(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(root, 'dist')); await fs.promises.mkdir(path.join(root, 'resources/desk-native'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'resources/desk-native/manifest.json'), '{}');
  await fs.promises.writeFile(path.join(root, 'dist/deskIrohWorker.js'),
    "require('fs').writeFileSync(require('path').join(__dirname, '../pid'), String(process.pid));\n" + source);
  const controller = new AbortController(); cleanup.push(() => controller.abort());
  const pid = async () => {
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'pid'))).toBe(true));
    return Number(await fs.promises.readFile(path.join(root, 'pid'), 'utf8'));
  };
  const gone = async (id: number) => { await vi.waitFor(() => expect(() => process.kill(id, 0)).toThrow(), { timeout: 3000 }); };
  return { root, process: new DeskIrohProcess(root), controller, pid, gone };
}

describe.skipIf(!supportsDeskIroh(process.versions.node, process.platform, process.arch))('native child lifetime boundary', () => {
  it('kills a child stuck in synchronous initialization on cancellation', async () => {
    const f = await fixture("process.on('message', () => { while (true) {} });");
    const task = f.process.serve('https://localhost/', 'b'.repeat(32), async () => ({}), f.controller.signal);
    const assertion = expect(task).rejects.toThrow('stopped');
    const pid = await f.pid(); f.controller.abort(); await assertion; await f.gone(pid);
  });

  it('includes native startup in the outbound deadline and kills the process', async () => {
    const f = await fixture("process.on('message', () => { while (true) {} });");
    const task = f.process.post('https://localhost/', 'a'.repeat(64), {}, {
      bearer: 'b'.repeat(32), maxBytes: 65536, timeoutMs: 700, signal: f.controller.signal,
    });
    const assertion = expect(task).rejects.toThrow('stopped');
    const pid = await f.pid(); await assertion; await f.gone(pid);
  });

  it('closes a ready server idempotently and inherits no credential/loader environment', async () => {
    const f = await fixture("process.on('message', () => { require('fs').writeFileSync(require('path').join(__dirname, '../env-keys'), JSON.stringify(Object.keys(process.env))); process.send({kind:'ready', endpointId:'a'.repeat(64)}); });");
    const server = await f.process.serve('https://localhost/', 'b'.repeat(32), async () => ({}), f.controller.signal);
    const keys: string[] = JSON.parse(await fs.promises.readFile(path.join(f.root, 'env-keys'), 'utf8'));
    expect(keys.filter(key => /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|NAPI_RS|NODE_OPTIONS|KEY/i.test(key))).toEqual([]);
    const pid = await f.pid(); server.close(); server.close(); await f.gone(pid);
  });

  it('refuses unconfigured relays before launching a process', async () => {
    const f = await fixture("process.on('message', () => {});");
    await expect(f.process.serve('', 'b'.repeat(32), async () => ({}), f.controller.signal)).rejects.toThrow('unavailable');
    expect(fs.existsSync(path.join(f.root, 'pid'))).toBe(false);
  });
});
