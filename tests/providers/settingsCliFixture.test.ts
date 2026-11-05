import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { createSettingsCliFixture } = require('../../scripts/validation/settings-cli-fixture.cjs');
const directories: string[] = [];
const children = new Set<ChildProcess>();
afterEach(() => {
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  children.clear();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('PC-04 settings receipt fixture', () => {
  it('forwards fragmented bytes, argv, environment and stderr unchanged while retaining only request settings', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti settings receipt ')); directories.push(directory);
    const echo = path.join(directory, 'echo-cli');
    fs.writeFileSync(echo, `#!${process.execPath}\nconst fs = require('node:fs');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--profile', 'pc04-profile', 'app-server']) || process.env.PC04_SYNTHETIC_ENV !== 'not-a-real-secret') process.exit(19);
process.stderr.write('unchanged synthetic stderr');
process.stdin.pipe(process.stdout);\n`, { mode: 0o700 });
    const fixture = createSettingsCliFixture(directory, echo, process.execPath);
    const requests = [
      JSON.stringify({ id: 17, method: 'thread/start', params: { model: 'gpt-test', cwd: '/synthetic-private-path',
        config: { model_reasoning_effort: 'low', secret: 'synthetic-secret' }, input: [{ text: 'private prompt 😀' }] } }),
      JSON.stringify({ id: 18, method: 'turn/start', params: { threadId: 'private-thread-id', effort: 'xhigh', input: [{ text: 'never retain' }] } }),
      JSON.stringify({ id: 19, method: 'config/read', params: { secret: 'never retain config' } }),
      // A huge line cannot exhaust recorder memory; following requests recover.
      'x'.repeat(1024 * 1024 + 100),
      JSON.stringify({ method: 'thread/resume', params: { model: 'gpt-test', config: { model_reasoning_effort: 'high' }, threadId: 'private-resume-id' } }),
    ];
    const input = Buffer.from(requests.join('\n') + '\n');
    const child = spawn(fixture.path, ['--profile', 'pc04-profile', 'app-server'], { env: { ...process.env, PC04_SYNTHETIC_ENV: 'not-a-real-secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const output: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    // Split a multi-byte code point as well as JSON object boundaries.
    const split = input.indexOf(Buffer.from('😀')) + 1;
    child.stdin.write(input.subarray(0, split)); child.stdin.write(input.subarray(split, split + 1)); child.stdin.end(input.subarray(split + 1));
    expect(await done).toBe(0);
    expect(Buffer.concat(output)).toEqual(input);
    expect(Buffer.concat(stderr).toString()).toBe('unchanged synthetic stderr');
    const receipts = fs.readFileSync(fixture.receiptsPath, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
    expect(receipts).toEqual([
      { method: 'thread/start', model: 'gpt-test', effort: 'low', profile: 'pc04-profile' },
      { method: 'turn/start', effort: 'xhigh', profile: 'pc04-profile' },
      { method: 'thread/resume', model: 'gpt-test', effort: 'high', profile: 'pc04-profile' },
    ]);
    expect(fs.statSync(fixture.receiptsPath).mode & 0o777).toBe(0o600);
  }, 15_000); // Two real Node processes and a 1MB passthrough, including loaded CI hosts.
});
