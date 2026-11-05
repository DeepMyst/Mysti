import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import { markOwnedProcessGroup } from '../../../src/utils/processKill';
import type { StreamChunk } from '../../../src/types';

// Accelerate only inactivity. Actual signals, owned process groups and the
// production five-second escalation grace remain unchanged. No native CLI runs.
vi.mock('../../../src/constants', async original => ({
  ...await original<typeof import('../../../src/constants')>(), STREAM_INACTIVITY_TIMEOUT_MS: 1000,
}));
vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(), readOpenClawToken: () => undefined,
}));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned watchdog fixture deadline')), 20000); })]); }
  finally { clearTimeout(timer); }
}

it.each(['silent', 'buffered-json-ignores-term'])('ends an owned %s child and permits a following reply', async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-watchdog-'));
  const provider = new TestableOpenClawProvider(), session: any = createOpenClawSession('owned-timeout');
  const children: Array<{ child: ChildProcess; close?: { code: number | null; signal: NodeJS.Signals | null }; closed: Promise<void> }> = [];
  const streams: AsyncGenerator<StreamChunk>[] = [], pending: Promise<unknown>[] = [];
  const source = `
const mode=process.argv[1];
if(mode==='buffered-json-ignores-term')process.on('SIGTERM',()=>{});
if(mode==='recovery')process.on('message',message=>{if(message==='finish')process.exit(0)});
const ready=()=>process.send('ready');
if(mode==='recovery')process.stdout.write(JSON.stringify({type:'text',content:'Recovered after idle process'})+'\\n',ready);
else if(mode==='buffered-json-ignores-term')process.stdout.write(JSON.stringify({payloads:[{text:'Native reply retained 🙂 جاهز.'}],meta:{agentMeta:{sessionId:'owned-timeout'}}},null,2)+'\\n',ready);
else ready();
if(mode!=='recovery')setInterval(()=>{},1000);
`;
  async function launch(selected: string) {
    const child = spawn(process.execPath, ['-e', source, selected], {
      cwd: root, env: { HOME: root, TMPDIR: root, PATH: path.dirname(process.execPath) },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    if (process.platform !== 'win32') markOwnedProcessGroup(child);
    const row = { child, close: undefined as { code: number | null; signal: NodeJS.Signals | null } | undefined, closed: Promise.resolve() };
    row.closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { row.close = { code, signal }; resolve(); }); });
    children.push(row);
    await bounded(new Promise<void>((resolve, reject) => { child.once('message', message => message === 'ready' ? resolve() : reject(new Error('Unknown readiness message'))); child.once('error', reject); }));
    return row;
  }
  async function consume(child: ChildProcess) {
    session.process = child;
    const stderr = { output: '' }; child.stderr!.on('data', data => { stderr.output += data; });
    const stream: AsyncGenerator<StreamChunk> = (provider as any).processStream(stderr, session); streams.push(stream);
    const chunks: StreamChunk[] = []; const operation = (async () => { for await (const chunk of stream) chunks.push(chunk); return chunks; })();
    pending.push(operation); return bounded(operation);
  }
  try {
    const first = await launch(mode), chunks = await consume(first.child);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([expect.objectContaining({ content: expect.stringMatching(/timed out/i) })]);
    expect(chunks.filter(chunk => chunk.type === 'auth_error')).toHaveLength(0);
    if (mode === 'buffered-json-ignores-term') expect(chunks).toContainEqual({ type: 'text', content: 'Native reply retained 🙂 جاهز.' });
    else expect(chunks.filter(chunk => chunk.type === 'text')).toHaveLength(0);
    await bounded(first.closed);
    if (process.platform !== 'win32') expect(first.close?.signal).toBe(mode === 'silent' ? 'SIGTERM' : 'SIGKILL');
    const second = await launch('recovery'), recovery = consume(second.child);
    second.child.send('finish');
    const recovered = await recovery; await bounded(second.closed);
    expect(recovered).toContainEqual({ type: 'text', content: 'Recovered after idle process' });
    expect(recovered.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toHaveLength(0);
    expect(second.close?.code).toBe(0);
  } finally {
    provider.dispose(); for (const row of children) if (!row.close) row.child.kill('SIGKILL');
    await bounded(Promise.all(children.map(row => row.closed))); await bounded(Promise.allSettled(pending));
    for (const stream of streams) await bounded(stream.return(undefined as never));
    fs.rmSync(root, { recursive: true, force: true });
    if (process.env.PB07_INACTIVITY_REAL_RECEIPT) fs.appendFileSync(process.env.PB07_INACTIVITY_REAL_RECEIPT, JSON.stringify({
      mode, directory: root, allChildrenClosed: children.every(row => !!row.close), children: children.map(row => ({ pid: row.child.pid, close: row.close })),
      nativeCliInvocations: 0, paidRequests: 0,
    }) + '\n');
    vi.restoreAllMocks(); clearMockConfig();
  }
}, 45000);
