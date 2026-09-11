import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareAcpGit } from '../../../src/providers/base/AcpNativeGit';
const directories: string[] = [];
async function repository() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-git-fixture-')); directories.push(cwd); await fs.mkdir(path.join(cwd, '.git')); return cwd; }
afterEach(async () => { for (const dir of directories.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); } });
describe('native ACP Git discovery policy', () => {
  it('replaces inherited execution settings using an owned empty profile', async () => {
    const policy = await prepareAcpGit(await repository());
    try { const env = policy.applyEnv({ PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/untrusted', GIT_SSH_COMMAND: '/untrusted' }); expect(env.GIT_SSH_COMMAND).toBeUndefined(); expect(env.GIT_CONFIG_VALUE_0).toBe('false'); expect(env.GIT_CONFIG_NOSYSTEM).toBe('1'); expect(env.HOME).toBeUndefined(); await policy.assertUnchanged(); }
    finally { await policy.cleanup(); }
  });
  it.each(['[include]\npath = /untrusted', '[filter "unsafe"]\nprocess = /untrusted', '[core]\nfsmonitor = /untrusted', '[diff "unsafe"]\ntextconv = /untrusted', '[filter.unsafe]\nprocess = /untrusted', '[diff.unsafe]\ntextconv = /untrusted', '[core] fsmonitor = /untrusted'])('rejects executable repository configuration %s', async config => {
    const cwd = await repository(); await fs.writeFile(path.join(cwd, '.git/config'), config); await expect(prepareAcpGit(cwd)).rejects.toThrow('executable helpers');
  });
  it('rechecks linked common checkout configuration before prompting', async () => {
    const cwd = await repository(); const common = path.join(cwd, '.git'); const linked = path.join(cwd, 'linked'); const gitDir = path.join(common, 'worktrees/linked');
    await fs.mkdir(gitDir, { recursive: true }); await fs.mkdir(linked); await fs.writeFile(path.join(linked, '.git'), `gitdir: ${gitDir}\n`); await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    const policy = await prepareAcpGit(linked);
    try { await fs.writeFile(path.join(common, 'config'), '[includeIf "gitdir:*"]\npath = /untrusted'); await expect(policy.assertUnchanged()).rejects.toThrow('executable helpers'); }
    finally { await policy.cleanup(); }
  });
});
