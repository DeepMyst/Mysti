import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Optional title/classification helpers consume text only. They must not load
 * project instructions, user hooks, plugins, MCP servers, or executable tools.
 * Keep authentication in the normal environment; never replace HOME or the
 * account configuration directory. Managed CLI policy still applies.
 */
export function spawnTextOnlyClaudeWorker(executable: string): ChildProcess {
  // Preserve configured relative executable paths when changing the child cwd.
  const command = !path.isAbsolute(executable) && /[/\\]/.test(executable)
    ? path.resolve(executable) : executable;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-text-worker-'));
  const cleanup = () => {
    try { fs.rmSync(cwd, { recursive: true, force: true }); }
    catch { /* Best effort after the captured worker has closed. */ }
  };
  try {
    const proc = spawn(command, [
      '--print', '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
      '--safe-mode', '--no-chrome', '--no-session-persistence',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    ], {
      cwd, env: { ...process.env, PWD: cwd, CLAUDE_CODE_SAFE_MODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    proc.once('close', cleanup);
    proc.once('error', cleanup);
    return proc;
  } catch (error) {
    cleanup();
    throw error;
  }
}
