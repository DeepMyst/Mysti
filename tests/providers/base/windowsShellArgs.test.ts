/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * D-8 regression: every provider spawn on Windows uses `shell: true`, and the
 * shell-mode argument screen rejected any argument containing a backslash. A
 * canvas-linked Claude Code session appends `--mcp-config <absolute path>`
 * (ClaudeCodeProvider.buildCliArgs / buildPersistentCliArgs), and on Windows
 * that path is backslash-separated — so once the user opened a canvas, every
 * send threw "Invalid argument detected in shell mode".
 *
 * The screen is not relaxed: backslash (and `~`, which only means anything to a
 * POSIX shell) are exempted for arguments whose SHAPE is a win32 filesystem
 * path, and those arguments are then double-quoted for cmd.exe. Node applies no
 * quoting of its own here — `shell: true` on Windows sets
 * `windowsVerbatimArguments`, so "No quoting or escaping of arguments is done"
 * (https://nodejs.org/api/child_process.html).
 *
 * NO REAL-WINDOWS VERIFICATION WAS POSSIBLE in this environment. The screen and
 * the quoter are pure functions of `process.platform` and the argument, so they
 * are driven directly with win32-shaped inputs and a stubbed platform.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  clearMockConfig();
});

// The exact shape CanvasSessionLinker.link() produces, rendered win32-style.
const CANVAS_CONFIG_WIN = path.win32.join(
  'C:\\Users\\dev\\AppData\\Local\\Temp',
  'mysti-canvas-panel_1.json',
);

describe('D-8 — win32 path arguments survive the shell-mode screen', () => {
  it('accepts a canvas --mcp-config path on win32 (and still rejects it on POSIX)', () => {
    const provider = new TestableClaudeProvider();

    setPlatform('win32');
    expect((provider as any)._isUnsafeShellArg(CANVAS_CONFIG_WIN)).toBe(false);
    expect((provider as any)._isUnsafeShellArg('C:\\Users\\John Doe\\AppData\\Local\\Temp\\c.json')).toBe(false);
    expect((provider as any)._isUnsafeShellArg('C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\c.json')).toBe(false);
    expect((provider as any)._isUnsafeShellArg('\\\\fileserver\\share\\c.json')).toBe(false);

    // The exemption is win32-only: a POSIX shell never sees it.
    setPlatform('linux');
    expect((provider as any)._isUnsafeShellArg(CANVAS_CONFIG_WIN)).toBe(true);
  });

  it('every argument the canvas-linked build emits passes the screen on win32', () => {
    setPlatform('win32');
    const provider = new TestableClaudeProvider();
    const session: any = createClaudeSession();
    session.canvasMcpConfigPath = CANVAS_CONFIG_WIN;

    const args = provider.buildCliArgs({ mode: 'default', accessLevel: 'full-access' } as any, session);
    expect(args).toContain('--mcp-config');
    expect(args).toContain(CANVAS_CONFIG_WIN);
    for (const arg of args) {
      expect((provider as any)._isUnsafeShellArg(arg), `arg rejected: ${arg}`).toBe(false);
    }
  });

  it('double-quotes the path for cmd.exe (Node does no quoting of its own)', () => {
    setPlatform('win32');
    const provider = new TestableClaudeProvider();
    const quoted = (provider as any)._quoteShellArgsForBrackets(['--mcp-config', CANVAS_CONFIG_WIN, '--model', 'claude-opus-4-6[1m]']);
    expect(quoted[0]).toBe('--mcp-config');
    expect(quoted[1]).toBe(`"${CANVAS_CONFIG_WIN}"`);
    // Brackets do not glob in cmd.exe, and single-quoting there would break the
    // .cmd shim — so a non-path arg is still passed through untouched.
    expect(quoted[3]).toBe('claude-opus-4-6[1m]');
  });

  it('keeps POSIX bracket single-quoting untouched', () => {
    setPlatform('darwin');
    const provider = new TestableClaudeProvider();
    const quoted = (provider as any)._quoteShellArgsForBrackets(['--model', 'claude-opus-4-6[1m]', '--effort', 'high']);
    expect(quoted[1]).toBe("'claude-opus-4-6[1m]'");
    expect(quoted[3]).toBe('high');
  });

  it('does not become an injection hole: metacharacters are still refused on win32', () => {
    setPlatform('win32');
    const provider = new TestableClaudeProvider();
    for (const arg of [
      'C:\\Temp\\x.json & calc.exe',
      'C:\\Temp\\$(whoami).json',
      'C:\\Temp\\`whoami`.json',
      'C:\\Temp\\%USERPROFILE%.json',   // cmd.exe variable expansion
      'C:\\Temp\\a^b.json',             // cmd.exe escape character
      'C:\\Temp\\a"b.json',
      "C:\\Temp\\a'b.json",
      'C:\\Temp\\a|b.json',
      'C:\\Temp\\a;b.json',
      'C:\\Temp\\a\nb.json',
      'C:\\Temp\\a>b.json',
      'C:\\Temp\\a!b.json',
      'plain\\relative\\path.json',     // no root — outside the exempted shape
    ]) {
      expect((provider as any)._isUnsafeShellArg(arg), `should be refused: ${JSON.stringify(arg)}`).toBe(true);
    }
  });
});
