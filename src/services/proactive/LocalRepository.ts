import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { realpath } from 'fs/promises';
const run = promisify(execFile);

export interface RepositorySnapshot {
  head: string;
  branch: string;
  upstream?: string;
  upstreamHead?: string;
  behind: number;
  ahead: number;
  dirty: string[];
  overlap: string[];
  observedAt: string;
}

/** Read local refs only. Never fetches, invokes a shell, or transmits file contents. */
export async function observeRepository(root: string): Promise<RepositorySnapshot> {
  const git = async (...args: string[]) => (await run('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
    timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })).stdout;
  const top = (await git('rev-parse', '--show-toplevel')).trim();
  if (await realpath(top) !== await realpath(root)) { throw new Error('Select the repository root as a workspace folder.'); }
  const head = (await git('rev-parse', '--verify', 'HEAD')).trim();
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const paths = (await git('status', '--porcelain=v1', '-z', '--untracked-files=normal')).split('\0');
  const dirty: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const entry = paths[i];
    if (!entry) { continue; }
    dirty.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) { dirty.push(paths[++i]); }
  }
  const upstream = (await git('for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`)).trim() || undefined;
  let upstreamHead: string | undefined;
  let ahead = 0, behind = 0, overlap: string[] = [];
  if (upstream) {
    upstreamHead = (await git('rev-parse', '--verify', upstream)).trim();
    const counts = (await git('rev-list', '--left-right', '--count', `${head}...${upstreamHead}`)).trim().split(/\s+/).map(Number);
    [ahead, behind] = counts;
    if (behind) {
      const incoming = new Set((await git('diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', `${head}...${upstreamHead}`, '--')).split('\0').filter(Boolean));
      overlap = dirty.filter(path => incoming.has(path));
    }
  }
  if ((await git('rev-parse', '--verify', 'HEAD')).trim() !== head) { throw new Error('Repository changed during observation; retry.'); }
  return { head, branch, upstream, upstreamHead, ahead, behind, dirty: dirty.filter(Boolean), overlap, observedAt: new Date().toISOString() };
}

export interface LocalInsight {
  id: string; title: string; summary: string; createdAt: string; state: 'unread' | 'read' | 'dismissed';
}

export function repositoryInsights(current: RepositorySnapshot, previous?: RepositorySnapshot): LocalInsight[] {
  const insights: LocalInsight[] = [];
  const add = (id: string, title: string, summary: string) => insights.push({ id: createHash('sha256').update(id).digest('hex'), title, summary, createdAt: current.observedAt, state: 'unread' });
  if (current.behind) {
    add(`behind:${current.head}:${current.upstreamHead}:${current.behind}:${current.overlap.join('|')}`,
      current.overlap.length ? 'Incoming changes overlap your working files' : 'Your branch has incoming changes',
      `${current.behind} incoming commit(s) on the locally fetched upstream; ${current.ahead} ahead. ${current.overlap.length ? `Overlapping files: ${current.overlap.slice(0, 8).join(', ')}. ` : ''}Review before integrating. Mysti has not fetched the remote.`);
  }
  if (previous && current.head !== previous.head) {
    add(`head:${current.head}`, 'Repository changed since the last check',
      `Branch ${current.branch}, commit ${current.head.slice(0, 12)}. Recheck assumptions and test results that depended on ${previous.head.slice(0, 12)}.`);
  }
  return insights;
}

export function mayNotify(enabled: boolean, now: Date, daily: { day: string; count: number }): boolean {
  const hour = now.getHours();
  return enabled && hour >= 8 && hour < 20 && (daily.day !== now.toLocaleDateString('en-CA') || daily.count < 3);
}
