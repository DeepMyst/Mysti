import { type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionManager } from '../../src/managers/SuggestionManager';
import { PlanOptionManager } from '../../src/managers/PlanOptionManager';
import { spawnTextOnlyClaudeWorker } from '../../src/utils/textOnlyClaudeWorker';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type { Conversation, Message } from '../../src/types';

const fixture = vi.hoisted(() => ({ directory: '', mode: 'normal',
  attempts: [] as Array<{ command: string; cwd?: string }>,
  workers: [] as Array<{ proc: ChildProcess; args: string[]; cwd?: string; closed: boolean; receipt: string }> }));
vi.mock('child_process', async original => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, spawn: (command: string, args: string[], options: any) => {
    fixture.attempts.push({ command, cwd: options.cwd });
    if (fixture.mode === 'spawn-throw') throw new Error('Controlled synchronous spawn failure');
    const receipt = path.join(fixture.directory, `receipt-${fixture.workers.length}.json`);
    // Replace only the model executable with a disposable Node contract fixture.
    // Every production argv/cwd/env option reaches the child without alteration.
    const executable = fixture.mode === 'spawn-error' ? path.join(fixture.directory, 'missing-executable') : process.execPath;
    const proc = actual.spawn(executable, [path.join(fixture.directory, 'worker.cjs'), receipt,
      path.join(fixture.directory, 'startup-action'), fixture.mode, ...args], options);
    const entry = { proc, args, cwd: options.cwd, closed: false, receipt };
    proc.once('close', () => { entry.closed = true; }); fixture.workers.push(entry); return proc;
  } };
});
const managers: Array<{ dispose(): void }> = [];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() >= end) throw new Error('Owned auxiliary fixture did not settle'); await pause(10); }
}
function suggestions(): SuggestionManager { const value = new SuggestionManager({} as any); managers.push(value); return value; }
function plans(): PlanOptionManager { const value = new PlanOptionManager(); managers.push(value); return value; }
const content = 'Compare bounded retry behavior and explain a safe exponential retry strategy.';
beforeEach(() => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-text-worker-contract-')); fixture.workers = []; fixture.attempts = []; fixture.mode = 'normal';
  clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/no-model-worker');
  fs.writeFileSync(path.join(fixture.directory, 'worker.cjs'), `
const fs = require('node:fs'), path = require('node:path');
const [receipt, canary, mode, ...args] = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let settings, mcp; try { settings=JSON.parse(value('--settings')); mcp=JSON.parse(value('--mcp-config')); } catch {}
const restricted = value('--tools') === '' && args.includes('--strict-mcp-config') && mcp && Object.keys(mcp.mcpServers || {}).length===0
 && value('--setting-sources') === '' && settings?.disableAllHooks === true && args.includes('--safe-mode') && args.includes('--no-chrome')
 && args.includes('--no-session-persistence') && value('--permission-mode')==='dontAsk' && value('--permission-prompts')==='none';
// This is a local contract canary, not an emulator/proof of Claude internals.
if (!restricted) fs.appendFileSync(canary, 'unrestricted startup\\n');
fs.writeFileSync(receipt, JSON.stringify({ restricted, args, cwd:process.cwd(), initialFiles:fs.readdirSync(process.cwd()) }));
if (mode === 'unsupported') { process.stderr.write('Unknown option --safe-mode'); process.exit(2); }
if (mode === 'hold') setInterval(() => {}, 1000);
let prompt='';process.stdin.on('data', chunk=>prompt+=chunk);process.stdin.on('end',()=>{
 if (mode === 'hold') return;
 const result=prompt.startsWith('Generate a short')?'Retry design review':prompt.startsWith('Given this AI response')
 ?JSON.stringify([{title:'Bound retries',prompt:'Add a bounded retry test'}]):JSON.stringify({questions:[],planOptions:[],context:'Safe classification'});
 process.stdout.write(result); });
`);
});
afterEach(async () => {
  managers.splice(0).forEach(value => value.dispose());
  for (const { proc } of fixture.workers) if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
    try { if (process.platform === 'win32') proc.kill('SIGKILL'); else process.kill(-proc.pid, 'SIGKILL'); } catch { /* Owned fixture already exited. */ }
  }
  await until(() => fixture.workers.every(value => value.closed));
  clearMockConfig(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});

describe('PB02-D07 auxiliary text-only worker boundary', () => {
  it('idle managers create no workers and requested workers have a restricted startup boundary', async () => {
    fixture.mode = 'hold';
    const manager = suggestions(); const classifier = plans();
    expect(fixture.workers).toHaveLength(0);
    const title = manager.generateTitle(content); const classification = classifier.classifyResponse(content);
    expect(fixture.workers).toHaveLength(2);
    await until(() => fixture.workers.every(value => fs.existsSync(value.receipt)));
    expect(fs.existsSync(path.join(fixture.directory, 'startup-action'))).toBe(false);
    for (const value of fixture.workers) {
      const receipt = JSON.parse(fs.readFileSync(value.receipt, 'utf8'));
      expect(receipt.restricted).toBe(true); expect(receipt.initialFiles).toEqual([]);
      expect(receipt.cwd).not.toBe(process.cwd()); expect(path.basename(receipt.cwd)).toMatch(/^mysti-text-worker-/);
      if (process.platform !== 'win32') expect(fs.statSync(receipt.cwd).mode & 0o777).toBe(0o700);
    }
    manager.dispose(); classifier.dispose(); await Promise.all([title, classification]);
  });

  it('public title, suggestion and classifier APIs preserve output with local actions disabled', async () => {
    const manager = suggestions(); const classifier = plans();
    const title = await manager.generateTitle(content);
    const suggested = await manager.generateSuggestions({} as Conversation, { content } as Message);
    const classified = await classifier.classifyResponse(content);
    expect(title).toBe('Retry design review'); expect(suggested[0].message).toBe('Add a bounded retry test');
    expect(classified).toMatchObject({ questions: [], planOptions: [], context: 'Safe classification' });
    expect(fs.existsSync(path.join(fixture.directory, 'startup-action'))).toBe(false);
  });

  it('normal completion and disposal remove all private worker working directories', async () => {
    const manager = suggestions(); const classifier = plans();
    await manager.generateTitle(content); await classifier.classifyResponse(content);
    manager.dispose(); classifier.dispose(); await until(() => fixture.workers.every(value => value.closed));
    expect(fixture.workers.every(value => typeof value.cwd === 'string')).toBe(true);
    for (const value of fixture.workers) expect(fs.existsSync(value.cwd!)).toBe(false);
  });

  it('unsupported isolation flags produce optional-feature fallback without retrying weaker authority', async () => {
    fixture.mode='unsupported'; const manager = suggestions();
    expect(await manager.generateTitle(content)).toBe(content.slice(0,50)+'...');
    await until(() => fixture.workers.every(value => value.closed));
    expect(fixture.workers).toHaveLength(1);
    expect(fs.existsSync(path.join(fixture.directory, 'startup-action'))).toBe(false);
    for (const value of fixture.workers) expect(value.args).toEqual(expect.arrayContaining(['--safe-mode','--strict-mcp-config','--no-session-persistence']));
  });

  it('a configured relative executable with spaces resolves before entering the private cwd', async () => {
    setMockConfig('claudeCodePath', './owned test/bin/claude');
    const manager = suggestions(); expect(await manager.generateTitle(content)).toBe('Retry design review');
    for (const value of fixture.attempts) expect(value.command).toBe(path.resolve('./owned test/bin/claude'));
  });

  it('synchronous spawn failure removes the newly created private directory', () => {
    fixture.mode='spawn-throw';
    expect(() => spawnTextOnlyClaudeWorker('claude')).toThrow('Controlled synchronous spawn failure');
    expect(fixture.attempts).toHaveLength(1); expect(fixture.attempts[0].command).toBe('claude');
    expect(fs.existsSync(fixture.attempts[0].cwd!)).toBe(false);
  });

  it('asynchronous executable-not-found failure releases its private directory without retry', async () => {
    fixture.mode='spawn-error';
    spawnTextOnlyClaudeWorker('claude'); await until(() => fixture.workers.every(value => value.closed));
    expect(fixture.workers).toHaveLength(1); expect(fs.existsSync(fixture.attempts[0].cwd!)).toBe(false);
  });
});
