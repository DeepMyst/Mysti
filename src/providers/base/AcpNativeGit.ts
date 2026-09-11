/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function optionalFile(file: string): Promise<string | undefined> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > 256 * 1024) { throw new Error('Native ACP cannot attest this Git configuration file.'); }
    return await fs.readFile(file, 'utf8');
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return; } throw error; }
}

/** Inspect configuration only; never run Git or follow a config include. */
async function inspect(cwd: string): Promise<void> {
  const roots = new Set<string>(); const gitDirs = new Set<string>();
  for (const initial of [path.resolve(cwd), await fs.realpath(cwd)]) {
    for (let root = initial;; root = path.dirname(root)) { roots.add(root); if (path.dirname(root) === root) { break; } }
  }
  for (const root of roots) {
    const gitPath = path.join(root, '.git');
    let info;
    try { info = await fs.lstat(gitPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
    if (info.isSymbolicLink()) { throw new Error('Native ACP cannot attest a symlinked Git directory.'); }
    if (info.isDirectory()) { gitDirs.add(gitPath); continue; }
    const pointer = await optionalFile(gitPath); const match = pointer && /^gitdir:\s*([^\r\n]+)\s*$/u.exec(pointer);
    if (!match) { throw new Error('Native ACP cannot attest this Git worktree pointer.'); }
    gitDirs.add(await fs.realpath(path.resolve(root, match[1])));
  }
  for (const gitDir of [...gitDirs]) {
    const common = await optionalFile(path.join(gitDir, 'commondir'));
    if (common !== undefined) {
      if (!common.trim() || /[\r\n]/u.test(common.trim())) { throw new Error('Native ACP cannot attest this Git common directory.'); }
      gitDirs.add(await fs.realpath(path.resolve(gitDir, common.trim())));
    }
  }
  for (const gitDir of gitDirs) {
    for (const name of ['config', 'config.worktree']) {
      const source = await optionalFile(path.join(gitDir, name));
      if (!source) { continue; }
      let section = '';
      for (const raw of source.split(/\r?\n/u)) {
        let line = raw.trim(); if (!line || /^[#;]/u.test(line)) { continue; }
        const header = /^\[\s*([\w.-]+)/u.exec(line);
        if (header) { section = header[1].toLowerCase().split('.')[0]; const end = line.indexOf(']'); if (end < 0) { throw new Error('Native ACP cannot attest malformed Git configuration.'); } line = line.slice(end + 1).trim(); }
        // Includes, filters, external diff drivers and credential commands can
        // run during native repository discovery before any tool request.
        if (['include', 'includeif', 'filter', 'credential'].includes(section)
          || (section === 'diff' && /^(?:external|command|textconv)\s*=/iu.test(line))
          || (section === 'core' && /^(?:fsmonitor|hookspath|sshcommand|gitproxy|pager|editor)\s*=/iu.test(line))) {
          throw new Error('Native ACP requires Git configuration without executable helpers or included configuration.');
        }
      }
    }
  }
}

export interface AcpGitPolicy {
  applyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  assertUnchanged(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function prepareAcpGit(cwd: string): Promise<AcpGitPolicy> {
  await inspect(cwd);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-acp-git-'));
  const config = path.join(directory, 'config'); const hooks = path.join(directory, 'hooks');
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try { await fs.writeFile(config, '', { mode: 0o600 }); await fs.mkdir(hooks); }
  catch (error) { await cleanup(); throw error; }
  return {
    applyEnv(original) {
      const env = { ...original };
      for (const key of Object.keys(env)) { if (key.startsWith('GIT_')) { delete env[key]; } }
      env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_SYSTEM = config; env.GIT_CONFIG_GLOBAL = config;
      env.GIT_CONFIG_COUNT = '2'; env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'; env.GIT_CONFIG_VALUE_0 = 'false';
      env.GIT_CONFIG_KEY_1 = 'core.hooksPath'; env.GIT_CONFIG_VALUE_1 = hooks;
      env.GIT_TERMINAL_PROMPT = '0'; env.GIT_PAGER = 'cat';
      return env;
    },
    async assertUnchanged() {
      await inspect(cwd);
      if ((await optionalFile(config)) !== '' || (await fs.readdir(hooks)).length !== 0) { throw new Error('The private native ACP Git policy changed.'); }
    }, cleanup,
  };
}
