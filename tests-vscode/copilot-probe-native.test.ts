/** Native startup receipt check; synthetic --version only, no model inference. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';

if (process.env.MYSTI_COPILOT_PROBE_NATIVE === '1') {
  describe('Copilot native startup probe receipts', function () {
    this.timeout(40_000);
    it('retains the parent deadline and actual closure when the killed child cannot write its terminal receipt', async () => {
      const directory = process.env.MYSTI_PROBE_ARTIFACTS!;
      assert.ok(path.isAbsolute(directory) && fs.existsSync(path.join(directory, '.owned-native-test')));
      const extension = vscode.extensions.getExtension('DeepMyst.mysti'); assert.ok(extension);
      assert.strictEqual(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH!));
      const receipts = () => {
        const file = path.join(directory, 'probe-receipts.jsonl');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      };
      const diagnostics = () => fs.readFileSync(path.join(directory, 'editor.log'), 'utf8').split('\n').flatMap(line => {
        const marker = '[Mysti CLI probe] ', index = line.indexOf(marker);
        if (index < 0) return [];
        try { return [JSON.parse(line.slice(index + marker.length))]; } catch { return []; }
      });
      const until = async (label: string, check: () => boolean) => {
        const start = Date.now();
        while (!check()) {
          if (Date.now() - start > 25_000) throw new Error(label + ': timed out');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      await extension.activate();
      await until('The selected owned probe must start and recover', () => receipts().filter(row => row.event === 'ready').length >= 2);
      const slow = receipts().find(row => row.event === 'ready' && row.mode === 'deadline');
      const fast = receipts().find(row => row.event === 'ready' && row.mode === 'success');
      assert.ok(slow && fast); assert.notStrictEqual(slow.pid, fast.pid);
      await until('Captured parent close and independent cleanup settlement', () => {
        const all = diagnostics();
        return all.some(row => row.childPid === slow.pid && row.event === 'close')
          && all.some(row => row.childPid === slow.pid && row.event === 'cleanup-helper-settled')
          && all.some(row => row.childPid === fast.pid && row.event === 'settled');
      });
      const all = diagnostics(), groups = [slow, fast].map(receipt => {
        const id = all.find(row => row.childPid === receipt.pid && row.event === 'spawn')?.probeId;
        assert.ok(id); const events = all.filter(row => row.probeId === id);
        assert.strictEqual(events.filter(row => row.event === 'start').length, 1);
        assert.strictEqual(events.filter(row => row.event === 'settled').length, 1);
        assert.strictEqual(events.filter(row => row.event === 'close').length, 1);
        assert.strictEqual(events.find(row => row.event === 'start').kind, 'version');
        assert.strictEqual(events.find(row => row.event === 'start').timeoutMs, 5000);
        assert.strictEqual(events.find(row => row.event === 'spawn').detached, true);
        return { receipt, events };
      });
      const deadline = groups[0].events, success = groups[1].events;
      assert.strictEqual(deadline.find(row => row.event === 'settled').reason, 'deadline');
      assert.strictEqual(deadline.find(row => row.event === 'settled').outputChars, 0);
      assert.ok(deadline.find(row => row.event === 'settled').elapsedMs >= 4900);
      assert.strictEqual(deadline.find(row => row.event === 'cleanup-requested').initialSignal, 'SIGKILL');
      assert.strictEqual(deadline.find(row => row.event === 'exit').signal, 'SIGKILL');
      assert.strictEqual(deadline.find(row => row.event === 'close').signal, 'SIGKILL');
      assert.strictEqual(receipts().some(row => row.pid === slow.pid && row.event === 'terminal'), false);
      assert.strictEqual(success.find(row => row.event === 'settled').reason, 'close-zero');
      assert.strictEqual(success.find(row => row.event === 'close').code, 0);
      assert.strictEqual(receipts().some(row => row.pid === fast.pid && row.event === 'terminal' && row.code === 0), true);
      assert.strictEqual(receipts().some(row => row.event === 'rejected-non-version'), false);
      fs.writeFileSync(path.join(directory, 'observations.json'), JSON.stringify({
        vscode: vscode.version, extension: extension.extensionPath,
        bundleSha256: createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, 'dist/extension.js'))).digest('hex'),
        groups, receipts: receipts(), historicalN08Cause: 'UNKNOWN',
        scope: 'Fresh controlled native deadline and successful next probe. Does not reclassify the historical missing receipt.',
      }, null, 2));
    });
  });
}
