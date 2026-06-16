/**
 * CanvasSessionLinker tests — the per-session Claude Code MCP config (http URL +
 * bearer token), the --mcp-config CLI args, and cleanup. Uses a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanvasSessionLinker, buildClaudeMcpConfig } from '../../src/managers/CanvasSessionLinker';

describe('CanvasSessionLinker', () => {
  it('buildClaudeMcpConfig emits an http server with the bearer header', () => {
    const cfg = buildClaudeMcpConfig('mysti-canvas', { url: 'http://127.0.0.1:51234/mcp', token: 'abc' });
    expect(cfg.mcpServers['mysti-canvas']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:51234/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
  });

  describe('link / args / unlink', () => {
    let dir: string;
    let linker: CanvasSessionLinker;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-linker-'));
      linker = new CanvasSessionLinker({ tmpDir: dir });
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('writes a per-panel config and reports linked + args', () => {
      const file = linker.link('canvas-1', { url: 'http://127.0.0.1:5/mcp', token: 't' });
      expect(fs.existsSync(file)).toBe(true);
      expect(linker.isLinked('canvas-1')).toBe(true);
      expect(linker.cliArgs('canvas-1')).toEqual(['--mcp-config', file]);
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(cfg.mcpServers['mysti-canvas'].url).toBe('http://127.0.0.1:5/mcp');
      expect(cfg.mcpServers['mysti-canvas'].headers.Authorization).toBe('Bearer t');
    });

    it('no args for an unlinked panel', () => {
      expect(linker.cliArgs('nope')).toEqual([]);
      expect(linker.isLinked('nope')).toBe(false);
    });

    it('unlink removes the file + state', () => {
      const file = linker.link('canvas-1', { url: 'http://x/mcp', token: 't' });
      linker.unlink('canvas-1');
      expect(fs.existsSync(file)).toBe(false);
      expect(linker.isLinked('canvas-1')).toBe(false);
      expect(linker.cliArgs('canvas-1')).toEqual([]);
    });

    it('unlinkAll clears everything', () => {
      linker.link('a', { url: 'http://x/mcp', token: 't' });
      linker.link('b', { url: 'http://y/mcp', token: 't' });
      linker.unlinkAll();
      expect(linker.isLinked('a')).toBe(false);
      expect(linker.isLinked('b')).toBe(false);
    });
  });
});
